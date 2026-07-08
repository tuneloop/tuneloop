/**
 * Shared GitHub-PR helpers used by both `outcomes-git` (PRs a session created or
 * merged) and `enrich-session` (PRs a session reviewed). Keeping the detection
 * and `gh`-enrichment in one place means both processors agree on a PR's identity
 * (`pr:owner/repo:num`) and never drift on parsing rules.
 */
import type { Session } from '../core/model'
import type { ShResult } from '../core/processor'
import type { ArtifactInput } from '../store/types'

// Host is intentionally not pinned to github.com so a pasted GitHub Enterprise Server PR
// URL parses too. Non-capturing host keeps owner/repo/num at m[1..3]; a matched URL's real
// host is preserved via m[0] (see pushRef)
const PR_URL = /https:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/

/**
 * create/merge = the session changed the PR; read = it only inspected the PR;
 * review = it EXPLICITLY posted a review (`gh pr review`, an MCP review tool) — a
 * deterministic, non-LLM "this session reviewed PR X" signal (Layer 1).
 */
export type PrRefKind = 'create' | 'merge' | 'read' | 'review'

/** The verdict carried by an explicit review, when the command/input reveals it. */
export type PrVerdict = 'approved' | 'changes_requested' | 'commented'

export interface PrRef {
  /** Natural key `pr:owner/repo:num`. */
  id: string
  owner: string
  repo: string
  num: string
  /** Canonical PR URL, safe to pass to `gh pr view`. */
  url: string
  kind: PrRefKind
  /** Index into `session.toolCalls` this ref came from; -1 for a human prompt. */
  toolIndex: number
  /** For a human-pasted link (toolIndex -1): the main-thread seq of the user event it
   *  appeared in, so a caller can map it to the block that turn opened. Unset for tool refs. */
  atSeq?: number
  /** Only set for kind 'review': approve / request-changes / comment. */
  verdict?: PrVerdict
}

// gh verbs that MUTATE a PR (the only thing outcomes-git attributes as created).
const CREATE_VERB = /\bgh\s+pr\s+create\b/
const MERGE_VERB = /\bgh\s+pr\s+merge\b/
// `gh pr review` = an explicit posted review (Layer 1) — handled before READ_VERB.
const REVIEW_VERB = /\bgh\s+pr\s+review\b/
// gh verbs that READ/inspect a PR — an intentful "this session looked at PR X".
const READ_VERB = /\bgh\s+pr\s+(?:view|diff|checkout|comment|edit|ready|close|reopen|status)\b/
// Pull the PR number out of a gh command: `gh pr diff 21 ...` / `gh pr review #21`.
const PR_NUM = /\bgh\s+pr\s+(?:view|diff|checkout|comment|review|edit|ready|close|reopen|status)\s+#?(\d+)\b/
const REPO_FLAG = /--repo[=\s]+([^\s/]+)\/([^\s]+)/

/** Read the review verdict off a `gh pr review` command's flags. */
function reviewVerdict(exec: string): PrVerdict {
  if (/--approve\b/.test(exec)) return 'approved'
  if (/--request-changes\b/.test(exec)) return 'changes_requested'
  return 'commented'
}

/** Read the review verdict off a GitHub MCP review input ({ event: 'APPROVE' | ... }). */
function mcpVerdict(input: unknown): PrVerdict {
  const ev = input && typeof input === 'object' ? (input as Record<string, unknown>).event : undefined
  if (typeof ev === 'string') {
    if (/approve/i.test(ev)) return 'approved'
    if (/request[_-]?changes/i.test(ev)) return 'changes_requested'
  }
  return 'commented'
}

/**
 * Find every PR this session intentfully created, merged, or read. "Intentful"
 * means the PR is the TARGET of an action — a `gh pr <verb>`, a web fetch of the
 * PR URL, an MCP pull-request tool, or a PR link in a human prompt — NOT a PR URL
 * that merely floated through some unrelated tool's output (that scan caused past
 * false positives; see outcomes-git history). Only refs that resolve to a full
 * `owner/repo/num` are returned; a bare `gh pr diff 21` with no `--repo` is skipped.
 */
export function parsePrRefs(session: Session): PrRef[] {
  const refs: PrRef[] = []
  // `url` = the real matched URL when the ref came from a link (host is ground truth, incl.
  // GHES); omitted for a host-less ref (`--repo` command / MCP input) → github.com fallback.
  const pushRef = (owner: string, repo: string, num: string, kind: PrRefKind, toolIndex: number, url?: string, verdict?: PrVerdict) => {
    refs.push({ id: prId(owner, repo, num), owner, repo, num, url: url ?? canonicalUrl(owner, repo, num), kind, toolIndex, ...(verdict ? { verdict } : {}) })
  }
  // Resolve a PR identity from the FIRST source that yields one (preferring tool
  // output, then the command) — mirrors the original `raw ?? exec` semantics.
  const addUrl = (kind: PrRefKind, toolIndex: number, ...sources: unknown[]): boolean => {
    for (const src of sources) {
      const url = matchPrUrl(src)
      if (!url) continue
      const m = PR_URL.exec(url)
      if (!m || !m[1] || !m[2] || !m[3]) continue
      pushRef(m[1], m[2], m[3], kind, toolIndex, url)
      return true
    }
    return false
  }
  // Identity from a `gh pr <verb> <num> ... --repo o/r` command (URL or num+repo).
  const fromShell = (exec: string, kind: PrRefKind, toolIndex: number, verdict?: PrVerdict): boolean => {
    const url = matchPrUrl(exec)
    if (url) {
      const m = PR_URL.exec(url)
      if (m && m[1] && m[2] && m[3]) { pushRef(m[1], m[2], m[3], kind, toolIndex, url, verdict); return true }
    }
    const numM = PR_NUM.exec(exec)
    const repoM = REPO_FLAG.exec(exec)
    if (numM && repoM && repoM[1] && repoM[2]) { pushRef(repoM[1], repoM[2], numM[1]!, kind, toolIndex, undefined, verdict); return true }
    return false
  }

  session.toolCalls.forEach((t, i) => {
    if (t.action === 'shell' && typeof t.target.command === 'string') {
      // Match against the executable skeleton so a PR command quoted inside a
      // heredoc/string literal (fixtures, doc text) isn't counted.
      const exec = stripInertRegions(t.target.command)
      if (CREATE_VERB.test(exec) || MERGE_VERB.test(exec)) {
        const kind: PrRefKind = MERGE_VERB.test(exec) ? 'merge' : 'create'
        // gh prints the new PR's URL to stdout on create; merge is often given it.
        addUrl(kind, i, t.result.raw, exec)
      } else if (REVIEW_VERB.test(exec)) {
        // Explicit posted review (Layer 1) — identity + verdict from the command.
        fromShell(exec, 'review', i, reviewVerdict(exec))
      } else if (READ_VERB.test(exec)) {
        // Identity must come from the command itself (URL, or num + --repo) — we do
        // NOT scan result output for a read, to avoid incidental-URL false positives.
        fromShell(exec, 'read', i)
      }
    } else if (t.action === 'mcp_call' && /pull_request/i.test(t.name)) {
      if (/review/i.test(t.name)) {
        // create/submit/add ...review = POSTING a review; get/list ...review = reading.
        if (/(?:create|submit|add)/i.test(t.name)) {
          const ref = resolveMcpInput(t.input)
          if (ref) refs.push({ ...ref, kind: 'review', toolIndex: i, verdict: mcpVerdict(t.input) })
        } else {
          const ref = resolveMcpInput(t.input)
          if (ref) refs.push({ ...ref, kind: 'read', toolIndex: i })
          else addUrl('read', i, t.input)
        }
      } else if (/(?:create|merge|update)/i.test(t.name)) {
        const kind: PrRefKind = /merge/i.test(t.name) ? 'merge' : 'create'
        addUrl(kind, i, t.result.raw, t.input)
      } else {
        // get / read / diff / files / comments — the PR is named in the tool input.
        const ref = resolveMcpInput(t.input)
        if (ref) refs.push({ ...ref, kind: 'read', toolIndex: i })
        else addUrl('read', i, t.input)
      }
    } else if (t.action === 'web') {
      // A web fetch's target IS its input — a PR URL there is an intentful read.
      addUrl('read', i, t.input, t.target.command)
    }
  })

  // A PR link a human pasted into a real prompt is an intentful read. Stamp the user
  // event's seq (atSeq) so a caller can map the ref to the block that turn opened.
  for (const ev of session.events) {
    if (ev.kind !== 'user' || ev.isSidechain) continue
    if (addUrl('read', -1, ev.text)) refs[refs.length - 1]!.atSeq = ev.seq
  }

  return refs
}

/** The starting artifact row for a PR, before `gh` enrichment fills in details. */
export function prArtifactBase(ref: PrRef): ArtifactInput {
  return {
    id: ref.id,
    kind: 'pr',
    repo: `${ref.owner}/${ref.repo}`,
    ident: ref.num,
    externalId: ref.url,
    source: 'github',
    status: 'open',
  }
}

/**
 * Fill in a PR artifact's live details via `gh pr view` (title/state/dates/churn/
 * author). Degrades gracefully: if `gh` is missing or offline the base row is
 * returned unchanged, and the store's COALESCE upsert keeps any richer row a prior
 * run already wrote — so an offline run never blanks out good data.
 */
export async function enrichPrArtifact(
  sh: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ShResult | null>,
  base: ArtifactInput,
  cwd?: string,
): Promise<ArtifactInput> {
  const art: ArtifactInput = { ...base }
  if (!art.externalId) return art
  // Address gh by the full externalId URL — for a link-sourced ref its host (github.com or a
  // GHES instance) is read straight from the URL. A host-less ref carries only a github.com
  // best-guess, so an enterprise repo referenced without a host won't enrich
  const res = await sh('gh', ['pr', 'view', art.externalId, '--json', 'title,state,createdAt,mergedAt,additions,deletions,author'], { cwd })
  if (res && res.code === 0) {
    try {
      const j = JSON.parse(res.stdout) as {
        title?: string
        state?: string
        createdAt?: string | null
        mergedAt?: string | null
        additions?: number
        deletions?: number
        author?: { login?: string }
      }
      if (typeof j.title === 'string') art.title = j.title
      if (typeof j.state === 'string') art.status = j.state.toLowerCase()
      if (j.createdAt) art.createdAt = j.createdAt
      if (j.mergedAt) art.completedAt = j.mergedAt
      const churn = (j.additions ?? 0) + (j.deletions ?? 0)
      if (churn > 0) {
        art.complexity = churn
        art.complexityBasis = 'diff_size'
      }
      if (j.author?.login) art.owner = j.author.login
    } catch {
      /* leave base defaults */
    }
  }
  return art
}

function prId(owner: string, repo: string, num: string): string {
  return `pr:${owner}/${repo}:${num}`
}

// Best-guess URL for a ref that arrived without a host (an MCP input, or a
// `gh pr <verb> N --repo owner/repo` command): assume github.com. A ref from a real link
// keeps that link's host instead (see pushRef)
function canonicalUrl(owner: string, repo: string, num: string): string {
  return `https://github.com/${owner}/${repo}/pull/${num}`
}

function matchPrUrl(raw: unknown): string | null {
  if (raw == null) return null
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const m = PR_URL.exec(s)
  return m ? m[0] : null
}

/** Resolve a structured MCP pull-request input ({owner, repo, pull_number}) to a ref identity. */
function resolveMcpInput(input: unknown): Omit<PrRef, 'kind' | 'toolIndex'> | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const owner = typeof o.owner === 'string' ? o.owner : null
  const repo = typeof o.repo === 'string' ? o.repo : null
  const numRaw = o.pull_number ?? o.pullNumber ?? o.number ?? o.pr
  const num = typeof numRaw === 'number' ? String(numRaw) : typeof numRaw === 'string' && /^\d+$/.test(numRaw) ? numRaw : null
  if (!owner || !repo || !num) return null
  return { id: prId(owner, repo, num), owner, repo, num, url: canonicalUrl(owner, repo, num) }
}

// Sinks that execute their heredoc body; for any other sink (cat, tee, a file
// redirect) the body is inert data and gets stripped.
const HEREDOC_INTERPRETER = /\b(?:bash|sh|zsh|ksh|dash|python3?|node|ruby|perl|php|fish|eval|source)\b/
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

/**
 * Strip the parts of a shell command the shell would never run as a command —
 * non-executing heredoc bodies and quoted string literals — leaving an
 * "executable skeleton" to match against. Best-effort heuristic, not a parser.
 */
export function stripInertRegions(cmd: string): string {
  const lines = cmd.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = HEREDOC_START.exec(line)
    if (!m || m.index === undefined) {
      out.push(line)
      continue
    }
    const delim = m[2]
    const dashed = line.slice(m.index, m.index + 3).includes('<<-')
    const executes = HEREDOC_INTERPRETER.test(line.slice(0, m.index))
    out.push(line) // introducing line is itself a real command
    let j = i + 1
    for (; j < lines.length; j++) {
      const body = lines[j] ?? ''
      if ((dashed ? body.replace(/^\t+/, '') : body) === delim) break
      if (executes) out.push(body)
    }
    if (j < lines.length) out.push(lines[j] ?? '') // closing delimiter
    i = j
  }
  // Blank quoted literals (keeping token boundaries); after heredocs so quoted
  // delimiters above still match.
  return out
    .join('\n')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}
