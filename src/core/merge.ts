import { contentHash } from './hash'
import { addUsage, emptyUsage } from './model'
import type { AssistantMessage, Event, Session, SubagentMeta, TokenUsage, ToolCall } from './model'

/**
 * Trim the parent transcript prefix that a Codex child (`/fork` or sub-agent) replays
 * into its own file — including the parent's `token_count` usage. Without
 * this the inherited prefix is counted twice: a fork sums into the parent, and a
 * sub-agent folds its full token total in. The boundary is the leading run of assistant
 * messages whose per-call usage matches the parent's (the inherited stamps are verbatim
 * copies); everything from divergence on is the child's own work. Tool calls are trimmed
 * by the matching leading run of call ids (forks replay them; sub-agents don't). Mutates
 * `child` in place; no-op when nothing is shared (e.g. parent file absent).
 */
export function trimInheritedPrefix(child: Session, parent: Session): void {
  // Match on the real token_count stamps (non-zero usage) only. Content-only ZERO
  // flushes (message boundaries) interleave differently between a sub-agent and its
  // parent, so aligning every assistant message misaligns; the usage stamps don't.
  const stamps = (s: Session): AssistantMessage[] =>
    s.events.filter((e): e is AssistantMessage => e.kind === 'assistant' && !isZeroUsage(e.usage))
  const childS = stamps(child)
  const parentS = stamps(parent)
  let k = 0
  while (k < childS.length && k < parentS.length && usageEq(childS[k]!.usage, parentS[k]!.usage)) k++
  if (k === 0) return // nothing inherited

  // Drop every event up to and including the last inherited usage stamp.
  const boundary = child.events.indexOf(childS[k - 1]!)
  child.events = child.events.slice(boundary + 1)

  // Drop the leading tool calls the child shares with the parent (by call id).
  let kc = 0
  while (
    kc < child.toolCalls.length &&
    kc < parent.toolCalls.length &&
    child.toolCalls[kc]!.id === parent.toolCalls[kc]!.id
  ) {
    kc++
  }
  child.toolCalls = child.toolCalls.slice(kc)

  // Re-roll the token total from the kept assistant messages.
  let tokens = emptyUsage()
  for (const e of child.events) if (e.kind === 'assistant') tokens = addUsage(tokens, e.usage)
  child.tokens = tokens
}

function usageEq(a: TokenUsage, b: TokenUsage): boolean {
  return a.input === b.input && a.output === b.output && a.cacheCreate === b.cacheCreate && a.cacheRead === b.cacheRead
}

function isZeroUsage(u: TokenUsage): boolean {
  return u.input === 0 && u.output === 0 && u.cacheCreate === 0 && u.cacheRead === 0
}

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
  // so the guard skips already-linked sub-agents
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
