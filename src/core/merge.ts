import { contentHash } from './hash'
import { addUsage, emptyUsage } from './model'
import type { Event, Session, ToolCall } from './model'

/**
 * Merge files that share a session id into one session. Claude Code can split a
 * single logical session across files (resume, sidechain/subagent transcripts
 * tagged with the parent id); processing them separately would re-run processors
 * on the same id and clobber per-session rows. Merging rolls everything —
 * including sidechain tokens and tool calls — into one session, processed once.
 */
export function mergeSessions(group: Session[]): Session {
  if (group.length === 1) return group[0]!
  const sorted = [...group].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
  const first = sorted[0]!

  const models = new Set<string>()
  let tokens = emptyUsage()
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  let title: string | undefined
  let cwd: string | undefined
  let branch: string | undefined
  let repo: string | undefined
  let startedAt: string | undefined
  let endedAt: string | undefined

  for (const s of sorted) {
    for (const m of s.models) models.add(m)
    tokens = addUsage(tokens, s.tokens)
    events.push(...s.events)
    toolCalls.push(...s.toolCalls)
    title ??= s.title
    cwd ??= s.project.cwd
    branch ??= s.project.branch
    repo ??= s.project.repo
    if (s.startedAt && (!startedAt || s.startedAt < startedAt)) startedAt = s.startedAt
    if (s.endedAt && (!endedAt || s.endedAt > endedAt)) endedAt = s.endedAt
  }

  return {
    ...first,
    title,
    project: { cwd, branch, repo },
    startedAt,
    endedAt,
    models: [...models],
    tokens,
    events,
    toolCalls,
    // Hash over all member files so the cache invalidates when any of them change.
    raw: { path: first.raw.path, contentHash: contentHash(sorted.map((s) => s.raw.contentHash).join(':')) },
  }
}
