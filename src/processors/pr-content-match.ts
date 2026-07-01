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
import { deterministicBlocks, blockMembership } from '../core/blocks'
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
  /** Net added lines per repo-relative path (normalized + de-trivialized at match time). */
  files: { path: string; added: string[] }[]
}

// Candidate PRs are the same for every session in a repo, so fetch once per repo per
// process (keyed owner/repo). Mirrors loadOpenRouterPrices' process-level cache.
const prCacheByRepo = new Map<string, Promise<CandidatePr[]>>()
/** Test seam: drop the per-repo PR cache. */
export function __resetPrCache(): void {
  prCacheByRepo.clear()
}

export const prContentMatch: Processor = {
  name: 'pr-content-match',
  version: 1,
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
    if (candidates.length === 0) return {}

    // PRs the session explicitly created/merged: outcomes-git owns their cost/outcome
    // rows, so only their attribution link is emitted below. Keys are lowercased because
    // GitHub owner/repo are case-insensitive — parsePrRefs (transcript casing) and our
    // candidate id (git-remote casing) can skew, which must not make a self-created PR
    // look inferred (that would double-emit outcomes-git's rows).
    const explicit = new Set(parsePrRefs(session).filter((r) => r.kind === 'create' || r.kind === 'merge').map((r) => r.id.toLowerCase()))

    const blocks = deterministicBlocks(session)
    const toolToBlock = blocks.length ? blockMembership(session, blocks).tool : []

    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const blockArtifacts: BlockArtifactInput[] = []
    const outcomes: OutcomeInput[] = []

    for (const pr of candidates) {
      const inferred = !explicit.has(pr.id.toLowerCase())
      let total = 0
      let matched = 0
      const matchedToolIdxs = new Set<number>()
      for (const file of pr.files) {
        const auth = authored.get(file.path)
        const prUnique = new Set(meaningful(file.added))
        total += prUnique.size
        if (!auth) continue
        let hit = 0
        for (const line of prUnique) if (auth.lines.has(line)) hit++
        if (hit > 0) {
          matched += hit
          for (const idx of auth.toolIdxs) matchedToolIdxs.add(idx)
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
        // Attribute the authoring blocks so cost-per-PR scopes to them. Confidence is left
        // NULL like outcomes-git's block links — per-block fraction isn't quantified; the
        // session→PR attribution % lives on the session link.
        const seen = new Set<number>()
        for (const idx of matchedToolIdxs) {
          const bi = toolToBlock[idx]
          if (bi == null || seen.has(bi)) continue
          seen.add(bi)
          blockArtifacts.push({ blockIdx: bi, artifactId: pr.id, role: 'edited', source: 'derived' })
        }
      }
    }

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

// ---- candidate PRs (author-scoped, memoized per repo) ----------------------

async function candidatePrs(sh: Sh, ownerRepo: string): Promise<CandidatePr[]> {
  const cached = prCacheByRepo.get(ownerRepo)
  if (cached) return cached
  // fetchPrs returns null on an INFRASTRUCTURE failure (gh missing/errored/unparseable)
  // vs [] for a repo that genuinely has no candidate PRs. Only cache the latter — a
  // transient gh failure must not poison every later session in the same repo/process.
  const p = fetchPrs(sh, ownerRepo).then((res) => {
    if (res === null) prCacheByRepo.delete(ownerRepo)
    return res ?? []
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

async function fetchPrs(sh: Sh, ownerRepo: string): Promise<CandidatePr[] | null> {
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

function toCandidate(ownerRepo: string, m: PrMeta, files: { path: string; added: string[] }[]): CandidatePr {
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

/** Parse a unified diff into per-file net added (`+`) lines. */
export function parseDiff(diff: string): { path: string; added: string[] }[] {
  const byFile = new Map<string, string[]>()
  let cur: string | null = null
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/)
    if (m) {
      cur = m[1] === '/dev/null' ? null : m[1]!
      if (cur && !byFile.has(cur)) byFile.set(cur, [])
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@')) continue
    if (cur && line.startsWith('+') && !line.startsWith('+++')) byFile.get(cur)!.push(line.slice(1))
  }
  return [...byFile].map(([path, added]) => ({ path, added }))
}

// ---- session authored lines ------------------------------------------------

interface Authored {
  /** Normalized, de-trivialized authored lines for this file (union of all edits). */
  lines: Set<string>
  /** tool_calls indices that wrote this file — for block attribution. */
  toolIdxs: number[]
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
        entry = { lines: new Set(), toolIdxs: [] }
        out.set(rel, entry)
      }
      for (const l of meaningful(lines)) entry.lines.add(l)
      entry.toolIdxs.push(i)
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
