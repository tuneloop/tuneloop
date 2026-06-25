import { contentHash } from './hash'
import { addUsage, emptyUsage } from './model'
import type { Event, Session, SubagentMeta, ToolCall } from './model'

/**
 * Merge files that make up one logical session into a single session. A session
 * splits across files when Claude Code resumes or writes sidechain/subagent
 * transcripts tagged with the parent id, or when Codex writes each sub-agent to
 * its own rollout file (`forkedFromId` → parent). Processing them separately would
 * re-run processors on the same id and clobber per-session rows. Merging rolls
 * everything — including sidechain tokens and tool calls — into one session,
 * processed once. The base is the top-level member (no `forkedFromId`); sub-agent
 * members contribute their already-sidechain events, token rollup, and SubagentMeta.
 */
export function mergeSessions(group: Session[]): Session {
  // A merged session is always the ROOT of its group, so it never carries a
  // forkedFromId. Clearing it on a lone member matters for an orphan sub-agent
  // (parent file missing): it becomes a clean standalone session rather than a
  // child of an absent parent. (It keeps 0 blocks — its events stay sidechain —
  // but cost still counts at session grain.)
  if (group.length === 1) {
    const s = group[0]!
    return s.forkedFromId ? { ...s, forkedFromId: undefined } : s
  }
  const sorted = [...group].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
  // The parent (top-level, no forkedFromId) supplies identity/project; fall back to
  // earliest if the group is all sidechains (parent file missing).
  const first = sorted.find((s) => !s.forkedFromId) ?? sorted[0]!

  const models = new Set<string>()
  let tokens = emptyUsage()
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  // Subagents come from the per-sidechain files; merging gathers them all onto
  // the one logical session (deduped by agentId).
  const subagents = new Map<string, SubagentMeta>()
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
    for (const sa of s.subagents ?? []) if (!subagents.has(sa.agentId)) subagents.set(sa.agentId, sa)
    title ??= s.title
    cwd ??= s.project.cwd
    branch ??= s.project.branch
    repo ??= s.project.repo
    if (s.startedAt && (!startedAt || s.startedAt < startedAt)) startedAt = s.startedAt
    if (s.endedAt && (!endedAt || s.endedAt > endedAt)) endedAt = s.endedAt
  }

  // Link each sub-agent to the tool call that spawned it: the task_spawn call whose
  // result references the sub-agent's id (Codex's spawn_agent returns `{agent_id}`).
  // This is what the block-attribution rollup keys on. Claude sets toolUseId at parse,
  // so the guard skips already-linked sub-agents (ADR-0003).
  for (const sa of subagents.values()) {
    if (sa.toolUseId) continue
    const spawn = toolCalls.find(
      (t) => t.action === 'task_spawn' && typeof t.result.raw === 'string' && t.result.raw.includes(sa.agentId),
    )
    if (spawn) sa.toolUseId = spawn.id
  }

  return {
    ...first,
    forkedFromId: undefined, // the merged session is the root of its group
    title,
    project: { cwd, branch, repo },
    startedAt,
    endedAt,
    models: [...models],
    tokens,
    events,
    toolCalls,
    subagents: subagents.size ? [...subagents.values()] : undefined,
    // Hash over all member files so the cache invalidates when any of them change.
    raw: { path: first.raw.path, contentHash: contentHash(sorted.map((s) => s.raw.contentHash).join(':')) },
  }
}
