import { registerProcessor } from '../core/registry'
import { attributeBlocksToPrs, blockMembership, deterministicBlocks } from '../core/blocks'
import type { Processor, RefreshContext, RefreshResult } from '../core/processor'
import type { ArtifactInput, BlockArtifactInput, OutcomeInput, SessionArtifactInput } from '../store/types'

const PR_URL = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/

/**
 * Static + network extractor: detect commits and PRs from the transcript, then
 * query `gh` for live PR status (degrades gracefully when offline / gh missing).
 * A commit with no resolvable SHA yields a session-level `commit_pushed` outcome
 * with no artifact — the nullable-artifact case from the data model.
 */
export const outcomesGit: Processor = {
  name: 'outcomes-git',
  version: 3,
  kind: 'static',
  needs: { network: true },
  requires: ['segment-blocks'],
  async run(ctx) {
    const { session, sh } = ctx
    const cwd = session.project.cwd
    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const outcomes: OutcomeInput[] = []

    let committed = false
    // Track each PR's create/merge tool-call index so it maps to its block below.
    const prHits: Array<{ url: string; toolIndex: number }> = []
    session.toolCalls.forEach((t, i) => {
      if (t.action === 'shell' && typeof t.target.command === 'string') {
        // Detect against the executable skeleton (see stripInertRegions) so
        // fixture/doc text that merely contains these commands isn't counted.
        const exec = stripInertRegions(t.target.command)
        if (/\bgit\b[^\n]*\bcommit\b/.test(exec)) committed = true
        if (/\bgh\s+pr\s+(?:create|merge)\b/.test(exec)) {
        // Only attribute a PR the session actually created/merged via gh — NOT a
        // PR URL that merely appeared in read/fetch/search output (e.g. while
        // researching a public repo). That blanket scan caused false positives.
          const url = matchPrUrl(t.result.raw) ?? matchPrUrl(exec)
          if (url) prHits.push({ url, toolIndex: i })
        }
      } else if (t.action === 'mcp_call' && /pull_request/i.test(t.name) && /(?:create|merge|update)/i.test(t.name)) {
        const url = matchPrUrl(t.result.raw) ?? matchPrUrl(t.input)
        if (url) prHits.push({ url, toolIndex: i })
      }
    })

    if (committed) outcomes.push({ type: 'commit_pushed', artifactId: null, ts: session.endedAt })

    const prUrls = new Set(prHits.map((h) => h.url))

    for (const url of prUrls) {
      const m = PR_URL.exec(url)
      if (!m) continue
      const owner = m[1]
      const repo = m[2]
      const num = m[3]
      if (!owner || !repo || !num) continue

      const id = `pr:${owner}/${repo}:${num}`
      const art: ArtifactInput = {
        id,
        kind: 'pr',
        repo: `${owner}/${repo}`,
        ident: num,
        externalId: url,
        source: 'github',
        status: 'open',
      }

      const res = await sh('gh', ['pr', 'view', url, '--json', 'title,state,mergedAt,additions,deletions,author'], { cwd })
      if (res && res.code === 0) {
        try {
          const j = JSON.parse(res.stdout) as {
            title?: string
            state?: string
            mergedAt?: string | null
            additions?: number
            deletions?: number
            author?: { login?: string }
          }
          if (typeof j.title === 'string') art.title = j.title
          if (typeof j.state === 'string') art.status = j.state.toLowerCase()
          if (j.mergedAt) art.completedAt = j.mergedAt
          const churn = (j.additions ?? 0) + (j.deletions ?? 0)
          if (churn > 0) {
            art.complexity = churn
            art.complexityBasis = 'diff_size'
          }
          if (j.author?.login) art.owner = j.author.login
        } catch {
          /* leave defaults */
        }
      }

      artifacts.push(art)
      sessionArtifacts.push({ artifactId: id, role: 'created', source: 'explicit' })
      outcomes.push({ type: 'pr_created', artifactId: id, ts: session.endedAt })
      if (art.status === 'merged' || art.completedAt) {
        outcomes.push({ type: 'pr_merged', artifactId: id, ts: art.completedAt })
      }
    }

    // Block→PR: map each PR's create/merge call to its (closing) block, then
    // attribute every block to the next PR it fed into — the full cost of
    // producing the PR, including the commit-bounded blocks leading up to it.
    const blocks = deterministicBlocks(session)
    const blockArtifacts: BlockArtifactInput[] = []
    if (blocks.length && prHits.length) {
      const tool = blockMembership(session, blocks).tool
      const closingBlockToArtifact = new Map<number, string>()
      for (const hit of prHits) {
        const m = PR_URL.exec(hit.url)
        if (!m) continue
        const blockIdx = tool[hit.toolIndex]
        if (blockIdx != null) closingBlockToArtifact.set(blockIdx, `pr:${m[1]}/${m[2]}:${m[3]}`)
      }
      for (const { blockIdx, artifactId } of attributeBlocksToPrs(blocks, closingBlockToArtifact)) {
        blockArtifacts.push({ blockIdx, artifactId, role: 'contributed', source: 'explicit' })
      }
    }

    return { artifacts, sessionArtifacts, outcomes, blockArtifacts }
  },

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
        if (status === 'merged' && j.mergedAt) {
          outcomes.push({ type: 'pr_merged', artifactId: art.id, ts: j.mergedAt })
        }
      } catch { /* skip unparseable */ }
    }

    return { artifacts: updated, outcomes }
  },
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

function matchPrUrl(raw: unknown): string | null {
  if (raw == null) return null
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const m = PR_URL.exec(s)
  return m ? m[0] : null
}

registerProcessor(outcomesGit)
