/**
 * Content-match PR linkage (the "diff-match" inferred link). Recovers the common
 * workflow where the user asks the agent to implement something, then commits and
 * pushes it themselves — so no `gh pr create` is in the transcript and `outcomes-git`
 * never links the session to the shipped PR.
 *
 * Matches the lines the agent authored (Claude Edit/Write/MultiEdit; Codex & OpenCode
 * apply_patch; OpenCode write/edit) against each candidate PR's net added lines
 * (`gh pr diff`) by LINE-LEVEL CONTAINMENT anchored on the PR: the fraction of the PR's
 * added lines the session authored. That fraction is the PR's AI-attribution, stored as
 * the link `confidence`. Design + the bake-off behind it: docs/plans/pr-linkage.md.
 *
 *  - Author-scoped: only the user's OWN PRs (`gh pr list --author @me`) are candidates —
 *    every eval false positive was a teammate's PR sharing foundational code, so scoping
 *    that class out makes a low threshold safe.
 *  - Attribution is measured for every contributed PR, including ones the session created
 *    itself; for those `outcomes-git` owns the cost/outcome rows, so only the attribution
 *    link is emitted here (see the run loop).
 *  - Link is `source:'derived'` (user-rejectable) with `role:'edited'`; the producer
 *    column marks it content-matched.
 */
import { isAbsolute, resolve } from 'node:path'
import { registerProcessor } from '../core/registry'
import { deterministicBlocks, blockMembership, attributeBlocksToPrs } from '../core/blocks'
import type { Session, ToolCall } from '../core/model'
import type { Processor, ProcessorContext, RefreshContext, RefreshResult, ShResult } from '../core/processor'
import type { ArtifactInput, BlockArtifactInput, OutcomeInput, SessionArtifactInput } from '../store/types'
import { parsePrRefs } from './github-pr'

/** Inferred-link precision gate: the session must author ≥ this fraction of the PR. */
const CONF_THRESHOLD = 0.1
/** Minimum matched lines before we trust the fraction at all — a ratio computed from
 * 1–2 lines is noise ("100%" of a tiny diff can be pure coincidence). This is the
 * evidence floor; CONF_THRESHOLD does the proportional work for larger PRs. */
const MIN_MATCHED = 3

type Sh = ProcessorContext['sh']

interface CandidatePr {
  id: string
  num: string
  url: string
  art: ArtifactInput
  /** Added/removed lines per repo-relative path (normalized + de-trivialized at match time). */
  files: { path: string; added: string[]; removed: string[] }[]
}

// Candidate PRs are the same for every session in a repo, so fetch once per repo per
// process (keyed owner/repo). Mirrors loadOpenRouterPrices' process-level cache.
const prCacheByRepo = new Map<string, Promise<CandidatePr[] | null>>()
/** Test seam: drop the per-repo PR cache. */
export function __resetPrCache(): void {
  prCacheByRepo.clear()
}

export const prContentMatch: Processor = {
  name: 'pr-content-match',
  version: 2,
  kind: 'static',
  needs: { network: true },
  requires: ['segment-blocks'],
  async run(ctx) {
    const { session, sh } = ctx
    const cwd = session.project.cwd
    // Cheap pre-checks: nothing to match without authored edits or a working dir.
    if (!cwd || !session.toolCalls.some((t) => t.action === 'file_write')) return {}

    const repoRoot = await gitToplevel(sh, cwd)
    const ownerRepo = await gitOwnerRepo(sh, cwd)
    if (!repoRoot || !ownerRepo) return {}

    const authored = authoredByFile(session, cwd, repoRoot)
    if (authored.size === 0) return {}

    const candidates = await candidatePrs(sh, ownerRepo)
    // gh INFRA failure (vs a repo with genuinely no candidate PRs): throw so the runner skips persisting
    if (candidates === null) throw new Error(`gh unavailable for ${ownerRepo}; keeping prior content-match results`)
    if (candidates.length === 0) return {}

    // PRs the session explicitly created/merged: outcomes-git owns their cost/outcome
    // rows, so only their attribution link is emitted below. Keys are lowercased because
    // GitHub owner/repo are case-insensitive — parsePrRefs (transcript casing) and our
    // candidate id (git-remote casing) can skew, which must not make a self-created PR
    // look inferred (that would double-emit outcomes-git's rows).
    const mutatingRefs = parsePrRefs(session).filter((r) => r.kind === 'create' || r.kind === 'merge')
    const explicit = new Set(mutatingRefs.map((r) => r.id.toLowerCase()))

    const blocks = deterministicBlocks(session)
    const toolToBlock = blocks.length ? blockMembership(session, blocks).tool : []

    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const outcomes: OutcomeInput[] = []
    // Inferred PRs that passed the gates, with the blocks whose tool calls matched them —
    // inputs to the unified block→PR fill after the loop.
    const inferredMatches: Array<{ id: string; confidence: number; blocks: Set<number> }> = []

    for (const pr of candidates) {
      // A PR that merged before the session started cannot contain the session's code.
      // Only excludes on a valid, strictly-earlier merge time (open/unmerged PRs stay).
      if (shippedBeforeSession(pr, session.startedAt)) continue
      const inferred = !explicit.has(pr.id.toLowerCase())
      let total = 0
      let matched = 0
      const matchedToolIdxs = new Set<number>()
      for (const file of pr.files) {
        const auth = authored.get(file.path)
        // Net-new only: a line the same file's diff both removes and re-adds is moved/
        // re-indented code, not new content — matching it would credit whoever ORIGINALLY
        // authored it (observed: a refactor PR falsely linked to old sessions)
        const removed = new Set(meaningful(file.removed))
        const prUnique = new Set(meaningful(file.added).filter((l) => !removed.has(l)))
        total += prUnique.size
        if (!auth) continue
        for (const line of prUnique) {
          const tls = auth.lines.get(line)
          if (!tls) continue
          matched++
          // Only the tool calls that authored THIS matched line mark their blocks.
          for (const idx of tls) matchedToolIdxs.add(idx)
        }
      }
      // Evidence floor: need at least a few real matched lines before trusting the ratio.
      if (total === 0 || matched < MIN_MATCHED) continue
      const confidence = matched / total
      // Proportional PRECISION gate for INFERRED links (a big PR with few matched lines
      // is weak). For a PR the session explicitly created the contribution is already
      // certain, so we record its attribution even when the fraction is low.
      if (inferred && confidence < CONF_THRESHOLD) continue

      // Recorded for every contributed PR (created or not). `addedLines` makes `matched`
      // recoverable from confidence, for per-PR attribution summed across sessions.
      artifacts.push({ ...pr.art, json: { addedLines: total } })
      sessionArtifacts.push({ artifactId: pr.id, role: 'edited', source: 'derived', confidence })

      // Cost attribution (block grain) + the contributed outcome are outcomes-git's job
      // for created/merged PRs; only emit them for the NEW links we discover.
      if (inferred) {
        outcomes.push({ type: 'pr_contributed', artifactId: pr.id, ts: session.endedAt })
        const matchedBlocks = new Set<number>()
        for (const idx of matchedToolIdxs) {
          const bi = toolToBlock[idx]
          if (bi != null) matchedBlocks.add(bi)
        }
        if (matchedBlocks.size) inferredMatches.push({ id: pr.id, confidence, blocks: matchedBlocks })
      }
    }

    const blockArtifacts = unifiedBlockFill(blocks, toolToBlock, mutatingRefs, inferredMatches)

    return { artifacts, sessionArtifacts, blockArtifacts, outcomes }
  },

  // Keep discovered PRs' merge status current (these PRs may exist ONLY because of a
  // content match, so no other processor refreshes them). Mirrors outcomes-git.refresh.
  async refresh(ctx: RefreshContext): Promise<RefreshResult> {
    const { artifacts: stale, sh, log } = ctx
    const updated: ArtifactInput[] = []
    const outcomes: OutcomeInput[] = []
    for (const art of stale) {
      if (art.kind !== 'pr' || !art.externalId) continue
      const res = await sh('gh', ['pr', 'view', art.externalId, '--json', 'state,mergedAt'], {})
      if (!res || res.code !== 0) continue
      try {
        const j = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null }
        const status = j.state?.toLowerCase()
        if (!status || status === art.status) continue
        log.debug(`refresh: ${art.externalId} ${art.status} → ${status}`)
        updated.push({ ...art, status, completedAt: j.mergedAt ?? art.completedAt })
        if (status === 'merged' && j.mergedAt) outcomes.push({ type: 'pr_merged', artifactId: art.id, ts: j.mergedAt })
      } catch {
        /* skip unparseable */
      }
    }
    return { artifacts: updated, outcomes }
  },
}

// ---- block→PR attribution (unified backward-fill) ---------------------------

/**
 * One backward-fill over both anchor kinds — explicit (the block holding a
 * `gh pr create`/`merge`, as outcomes-git) and synthetic (an inferred PR's last
 * corroborated matched block) — so each block belongs to exactly one PR, and a
 * human-pushed PR reclaims the blocks outcomes-git's explicit-only fill would
 * absorb into the next created PR.
 *
 * Contested block: explicit wins (ground truth); between inferred PRs higher
 * confidence wins, the loser falls back to an earlier matched block. A PR contested
 * out entirely gets no block rows and thus NO cost claim (the store gates the
 * whole-session fallback off for this producer — saNoContentMatchFallback);
 * its attribution % on the session link stands. Under-claim over over-claim.
 *
 * Only inferred-owned segments are emitted; explicit segments stay outcomes-git's.
 * Where the fills disagree, cost reads prefer ours (store.ts blockNotSuperseded).
 * Block confidence is NULL as in outcomes-git: attribution % lives on the session link.
 */
function unifiedBlockFill(
  blocks: ReturnType<typeof deterministicBlocks>,
  toolToBlock: number[],
  mutatingRefs: Array<{ id: string; toolIndex: number }>,
  inferredMatches: Array<{ id: string; confidence: number; blocks: Set<number> }>,
): BlockArtifactInput[] {
  if (!blocks.length || !inferredMatches.length) return []
  const anchors = new Map<number, string>()
  for (const ref of mutatingRefs) {
    const bi = toolToBlock[ref.toolIndex]
    if (bi != null) anchors.set(bi, ref.id)
  }
  // Corroboration distance, scaled to session size: in a 350-block session a lone match
  // 150 blocks past the cluster is noise; in a 5-block session a gap of 2 is normal.
  const gap = Math.max(2, Math.ceil(blocks.length * 0.1))
  // Confidence order (id tiebreak for reproducibility across gh list orderings).
  for (const im of [...inferredMatches].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))) {
    const anchor = corroboratedAnchor([...im.blocks], gap)
    if (anchor < 0) continue
    // Preference: the corroborated anchor, then earlier matched blocks (each strictly
    // more conservative). Matched blocks PAST the anchor are the suspected false
    // positives — never used, not even as contested-block fallbacks.
    const prefs = [anchor, ...[...im.blocks].filter((b) => b < anchor).sort((a, b) => b - a)]
    for (const bi of prefs) {
      if (!anchors.has(bi)) {
        anchors.set(bi, im.id)
        break
      }
    }
  }
  const inferredIds = new Set(inferredMatches.map((im) => im.id))
  const out: BlockArtifactInput[] = []
  for (const { blockIdx, artifactId } of attributeBlocksToPrs(blocks, anchors)) {
    if (inferredIds.has(artifactId)) out.push({ blockIdx, artifactId, role: 'contributed', source: 'derived' })
  }
  return out
}

/**
 * Synthetic anchor: the LAST matched block whose gap to the previous one is ≤ `gap`.
 * An isolated straggler past the cluster (a shared line coinciding with a later PR's
 * segment) is rejected so it can't drag the segment end rightward. A single matched
 * block is accepted; if every pair is isolated, the earliest wins (minimal claim).
 */
function corroboratedAnchor(matched: number[], gap: number): number {
  const desc = [...matched].sort((a, b) => b - a)
  if (desc.length === 0) return -1 // defensive; callers pass non-empty sets
  if (desc.length === 1) return desc[0]!
  for (let i = 0; i < desc.length - 1; i++) {
    if (desc[i]! - desc[i + 1]! <= gap) return desc[i]!
  }
  return desc[desc.length - 1]!
}

/** True only when the PR merged strictly before the session started — the one case where
 * the session provably cannot have authored any of its shipped code. Open/unmerged PRs
 * (no `completedAt`) and unknown/unparseable times are kept, so the guard never over-excludes. */
function shippedBeforeSession(pr: CandidatePr, sessionStart: string | undefined): boolean {
  if (!sessionStart || !pr.art.completedAt) return false
  const merged = Date.parse(pr.art.completedAt)
  const start = Date.parse(sessionStart)
  return Number.isFinite(merged) && Number.isFinite(start) && merged < start
}

// ---- candidate PRs (author-scoped, memoized per repo) ----------------------

async function candidatePrs(sh: Sh, ownerRepo: string): Promise<CandidatePr[] | null> {
  const cached = prCacheByRepo.get(ownerRepo)
  if (cached) return cached
  // null = gh infra failure (never cached; run() throws), [] = genuinely no PRs (cached).
  const p = fetchMyPrs(sh, ownerRepo).then((res) => {
    if (res === null) prCacheByRepo.delete(ownerRepo)
    return res
  })
  prCacheByRepo.set(ownerRepo, p)
  return p
}

interface PrMeta {
  number: number
  title?: string
  author?: { login?: string }
  state?: string
  createdAt?: string
  mergedAt?: string | null
  additions?: number
  deletions?: number
}

async function fetchMyPrs(sh: Sh, ownerRepo: string): Promise<CandidatePr[] | null> {
  const list = await sh('gh', [
    'pr', 'list', '--repo', ownerRepo, '--author', '@me', '--state', 'all', '--limit', '200',
    '--json', 'number,title,author,state,createdAt,mergedAt,additions,deletions',
  ])
  if (!list || list.code !== 0) return null // infra failure — don't cache
  let metas: PrMeta[]
  try {
    metas = JSON.parse(list.stdout)
  } catch {
    return null // unparseable gh output — treat as failure, not "no PRs"
  }
  const out: CandidatePr[] = []
  for (const m of metas) {
    const diff = await sh('gh', ['pr', 'diff', String(m.number), '--repo', ownerRepo])
    if (!diff || diff.code !== 0) continue
    const files = parseDiff(diff.stdout)
    if (files.length === 0) continue
    out.push(toCandidate(ownerRepo, m, files))
  }
  return out
}

function toCandidate(ownerRepo: string, m: PrMeta, files: CandidatePr['files']): CandidatePr {
  const num = String(m.number)
  const id = `pr:${ownerRepo}:${num}`
  const url = `https://github.com/${ownerRepo}/pull/${num}`
  const churn = (m.additions ?? 0) + (m.deletions ?? 0)
  const art: ArtifactInput = {
    id,
    kind: 'pr',
    repo: ownerRepo,
    ident: num,
    externalId: url,
    source: 'github',
    title: m.title,
    owner: m.author?.login,
    status: m.state?.toLowerCase(),
    createdAt: m.createdAt,
    completedAt: m.mergedAt ?? undefined,
    ...(churn > 0 ? { complexity: churn, complexityBasis: 'diff_size' } : {}),
  }
  return { id, num, url, art, files }
}

/** Parse a unified diff into per-file added (`+`) and removed (`-`) lines. */
export function parseDiff(diff: string): { path: string; added: string[]; removed: string[] }[] {
  const byFile = new Map<string, { added: string[]; removed: string[] }>()
  let cur: { added: string[]; removed: string[] } | null = null
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/)
    if (m) {
      cur = null
      if (m[1] !== '/dev/null') {
        cur = byFile.get(m[1]!) ?? { added: [], removed: [] }
        byFile.set(m[1]!, cur)
      }
      continue
    }
    if (line.startsWith('diff --git')) {
      cur = null // so a deleted file's (`+++ /dev/null`) lines never leak into the previous file
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('@@')) continue
    if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1))
    else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1))
  }
  return [...byFile].map(([path, f]) => ({ path, ...f }))
}

// ---- session authored lines ------------------------------------------------

interface Authored {
  /** Normalized authored line → tool-call indices that authored it. Per-LINE so only
   * tool calls whose own lines match a PR mark their blocks — an unrelated later edit
   * to the same file can't manufacture a straggler "matched block". */
  lines: Map<string, number[]>
}

function authoredByFile(session: Session, cwd: string, repoRoot: string): Map<string, Authored> {
  const out = new Map<string, Authored>()
  session.toolCalls.forEach((t, i) => {
    if (t.action !== 'file_write') return
    const extracted =
      session.source === 'codex' ? codexAuthored(t) : session.source === 'opencode' ? opencodeAuthored(t) : claudeAuthored(t)
    for (const { path, lines } of extracted) {
      const rel = repoRel(path, cwd, repoRoot)
      if (!rel) continue
      let entry = out.get(rel)
      if (!entry) {
        entry = { lines: new Map() }
        out.set(rel, entry)
      }
      for (const l of meaningful(lines)) {
        let tls = entry.lines.get(l)
        if (!tls) {
          tls = []
          entry.lines.set(l, tls)
        }
        tls.push(i)
      }
    }
  })
  return out
}

/** Claude Edit/Write/MultiEdit → (path, authored lines). */
function claudeAuthored(t: ToolCall): { path: string; lines: string[] }[] {
  const input = t.input as Record<string, unknown> | null
  if (!input || typeof input !== 'object') return []
  const path = typeof input.file_path === 'string' ? input.file_path : null
  if (!path) return []
  if (typeof input.content === 'string') return [{ path, lines: input.content.split('\n') }]
  if (typeof input.new_string === 'string') return [{ path, lines: input.new_string.split('\n') }]
  if (Array.isArray(input.edits)) {
    const lines: string[] = []
    for (const e of input.edits) {
      const ns = (e as Record<string, unknown>)?.new_string
      if (typeof ns === 'string') lines.push(...ns.split('\n'))
    }
    return lines.length ? [{ path, lines }] : []
  }
  return []
}

/** OpenCode file writes → (path, authored lines). OpenCode uses camelCase fields:
 *  - `write`       → { filePath, content }
 *  - `edit`        → { filePath, oldString, newString }
 *  - `apply_patch` → { patchText } in the Codex `*** Begin Patch` format (gpt-5 models only)
 */
function opencodeAuthored(t: ToolCall): { path: string; lines: string[] }[] {
  const input = t.input as Record<string, unknown> | null
  if (!input || typeof input !== 'object') return []
  // apply_patch carries a whole multi-file patch string, not a single filePath.
  if (typeof input.patchText === 'string') return parseCodexPatch(input.patchText)
  const path =
    typeof input.filePath === 'string' ? input.filePath : typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null
  if (!path) return []
  if (typeof input.content === 'string') return [{ path, lines: input.content.split('\n') }] // write
  if (typeof input.newString === 'string') return [{ path, lines: input.newString.split('\n') }] // edit
  return []
}

/** Codex apply_patch (raw patch string) → per-file added (`+`) lines. */
function codexAuthored(t: ToolCall): { path: string; lines: string[] }[] {
  return typeof t.input === 'string' ? parseCodexPatch(t.input) : []
}

/** Parse a Codex/OpenCode `*** Begin Patch` string → per-file added (`+`) lines.
 * Shared by Codex `apply_patch` (raw string input) and OpenCode `apply_patch`
 * (`{ patchText }`); both use identical `*** Add/Update/Delete File:` + `*** Move to:`
 * headers. */
export function parseCodexPatch(patch: string): { path: string; lines: string[] }[] {
  if (!patch) return []
  const byFile = new Map<string, string[]>()
  let cur: string | null = null
  for (const line of patch.split('\n')) {
    const h = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (h) {
      cur = h[1]!.trim()
      if (!byFile.has(cur)) byFile.set(cur, [])
      continue
    }
    const mv = line.match(/^\*\*\* Move to: (.+)$/)
    if (mv) {
      cur = mv[1]!.trim()
      if (!byFile.has(cur)) byFile.set(cur, [])
      continue
    }
    if (cur && line.startsWith('+') && !line.startsWith('+++')) byFile.get(cur)!.push(line.slice(1))
  }
  return [...byFile].map(([path, lines]) => ({ path, lines }))
}

/** Absolute/relative authored path → repo-relative, or null if it escapes the repo. */
function repoRel(rawPath: string, cwd: string, repoRoot: string): string | null {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  if (abs !== repoRoot && !abs.startsWith(repoRoot + '/')) return null
  return abs.slice(repoRoot.length).replace(/^\/+/, '')
}

// ---- normalization (line-level; see docs/plans/pr-linkage.md) --------------

/** Normalize → drop blank/whitespace-only/pure-bracket lines, preserving order. */
function meaningful(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    const n = l.replace(/\s+/g, ' ').trim()
    if (n === '' || /^[{}()[\];,<>]+$/.test(n) || n === '=>' || n === '});') continue
    out.push(n)
  }
  return out
}

// ---- git helpers -----------------------------------------------------------

async function gitToplevel(sh: Sh, cwd: string): Promise<string | null> {
  const res = await sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  return ok(res) ? res!.stdout.trim() : null
}

async function gitOwnerRepo(sh: Sh, cwd: string): Promise<string | null> {
  const res = await sh('git', ['-C', cwd, 'remote', 'get-url', 'origin'])
  if (!ok(res)) return null
  const m = res!.stdout.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

function ok(res: ShResult | null): boolean {
  return !!res && res.code === 0 && res.stdout.trim().length > 0
}

registerProcessor(prContentMatch)
