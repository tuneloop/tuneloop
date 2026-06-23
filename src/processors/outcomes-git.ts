import { registerProcessor } from '../core/registry'
import type { Processor } from '../core/processor'
import type { ArtifactInput, OutcomeInput, SessionArtifactInput } from '../store/types'

const PR_URL = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/

/**
 * Static + network extractor: detect commits and PRs from the transcript, then
 * query `gh` for live PR status (degrades gracefully when offline / gh missing).
 * A commit with no resolvable SHA yields a session-level `commit_pushed` outcome
 * with no artifact — the nullable-artifact case from the data model.
 */
export const outcomesGit: Processor = {
  name: 'outcomes-git',
  version: 2,
  kind: 'static',
  needs: { network: true },
  async run(ctx) {
    const { session, sh } = ctx
    const cwd = session.project.cwd
    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const outcomes: OutcomeInput[] = []

    let committed = false
    const prUrls = new Set<string>()
    for (const t of session.toolCalls) {
      if (t.action === 'shell' && typeof t.target.command === 'string') {
        const cmd = t.target.command
        if (/\bgit\b[^\n]*\bcommit\b/.test(cmd)) committed = true
        // Only attribute a PR the session actually created/merged via gh — NOT a
        // PR URL that merely appeared in read/fetch/search output (e.g. while
        // researching a public repo). That blanket scan caused false positives.
        if (/\bgh\s+pr\s+(?:create|merge)\b/.test(cmd)) {
          const url = matchPrUrl(t.result.raw) ?? matchPrUrl(cmd)
          if (url) prUrls.add(url)
        }
      } else if (t.action === 'mcp_call' && /pull_request/i.test(t.name) && /(?:create|merge|update)/i.test(t.name)) {
        const url = matchPrUrl(t.result.raw) ?? matchPrUrl(t.input)
        if (url) prUrls.add(url)
      }
    }

    if (committed) outcomes.push({ type: 'commit_pushed', artifactId: null, ts: session.endedAt })

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

    return { artifacts, sessionArtifacts, outcomes }
  },
}

function matchPrUrl(raw: unknown): string | null {
  if (raw == null) return null
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const m = PR_URL.exec(s)
  return m ? m[0] : null
}

registerProcessor(outcomesGit)
