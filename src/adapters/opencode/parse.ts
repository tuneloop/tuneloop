import { contentHash } from '../../core/hash'
import { addUsage, emptyUsage } from '../../core/model'
import type {
  AssistantMessage,
  ContentBlock,
  Event,
  Session,
  SubagentMeta,
  TokenUsage,
  ToolCall,
  UserMessage,
} from '../../core/model'
import { mapAction } from './actions'
import { allSessions, messagesFor, partsFor } from './db'
import type { OcDb, OcMessage, OcPart, OcSession } from './db'

// Bump when ingest-time derivation changes so stored sessions are rebuilt on the
// same DB rows (see analyze.ts's re-ingest gate). 1: initial OpenCode support.
export const PARSE_VERSION = 1
export const SOURCE = 'opencode'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

/**
 * Read every session out of an OpenCode DB and normalize it. Subagent sessions
 * (rows with a `parent_id`) are folded into their parent — their token usage and
 * tool calls roll up as sidechains, mirroring how Claude Code handles its
 * sidechain transcripts — so only top-level sessions are returned.
 */
export function buildSessions(db: OcDb, dbPath: string): Session[] {
  const sessions = allSessions(db)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const childrenByParent = new Map<string, OcSession[]>()
  for (const s of sessions) {
    if (s.parent_id && byId.has(s.parent_id)) {
      const arr = childrenByParent.get(s.parent_id)
      if (arr) arr.push(s)
      else childrenByParent.set(s.parent_id, [s])
    }
  }

  const out: Session[] = []
  for (const s of sessions) {
    // Folded into a parent below; don't emit standalone. Orphans (parent missing)
    // fall through and are emitted as top-level.
    if (s.parent_id && byId.has(s.parent_id)) continue
    out.push(buildTopLevel(db, dbPath, s, childrenByParent.get(s.id) ?? []))
  }
  return out
}

/** A session's events/tool-calls/usage, plus the bits needed to fold children. */
interface Unit {
  events: Event[]
  toolCalls: ToolCall[]
  tokens: TokenUsage
  models: Set<string>
  providers: string[]
  cwd?: string
  /** Spawning `task` calls, for linking child sessions back to their tool call. */
  taskCalls: { description: string; subagentType?: string; callID: string }[]
}

function buildTopLevel(db: OcDb, dbPath: string, s: OcSession, children: OcSession[]): Session {
  const parentMsgs = messagesFor(db, s.id)
  const parentParts = partsFor(db, s.id)
  const unit = buildUnit(parentMsgs, parentParts, false, undefined)

  const events = [...unit.events]
  const toolCalls = [...unit.toolCalls]
  let tokens = unit.tokens
  const models = new Set(unit.models)
  const sModel = modelIdOf(s.model)
  if (sModel) models.add(sModel)
  const subagents: SubagentMeta[] = []

  // Stable hash input across the whole logical session (parent + children rows).
  const hashParts: string[] = [s.id, String(s.time_updated)]
  appendHash(hashParts, parentMsgs, parentParts)

  for (const child of children) {
    const childMsgs = messagesFor(db, child.id)
    const childParts = partsFor(db, child.id)
    const cu = buildUnit(childMsgs, childParts, true, child.id)
    events.push(...cu.events)
    toolCalls.push(...cu.toolCalls)
    tokens = addUsage(tokens, cu.tokens)
    for (const m of cu.models) models.add(m)
    const childModel = modelIdOf(child.model)
    if (childModel) models.add(childModel)
    // Link the child to the parent `task` call that spawned it: OpenCode doesn't
    // store the child's id on the call, but the child's title is the call's
    // description plus a "(@type subagent)" suffix, so prefix-match on that.
    const spawn = unit.taskCalls.find(
      (t) => t.description && child.title.startsWith(t.description) && (!t.subagentType || t.subagentType === child.agent),
    )
    subagents.push({
      agentId: child.id,
      agentType: child.agent ?? undefined,
      description: child.title,
      toolUseId: spawn?.callID,
    })
    appendHash(hashParts, childMsgs, childParts)
  }

  const provider = unit.providers[0] ?? SOURCE
  const cwd = unit.cwd ?? s.directory

  return {
    id: `${SOURCE}:${s.id}`,
    sessionId: s.id,
    source: SOURCE,
    provider,
    title: s.title || undefined,
    project: { cwd, branch: s.branch ?? undefined },
    startedAt: iso(s.time_created),
    endedAt: iso(s.time_updated),
    models: [...models],
    tokens,
    events,
    toolCalls,
    subagents: subagents.length ? subagents : undefined,
    raw: { path: `${dbPath}#${s.id}`, contentHash: contentHash(hashParts.join('\n')) },
  }
}

function buildUnit(messages: OcMessage[], parts: OcPart[], isSidechain: boolean, agentId: string | undefined): Unit {
  const partsByMsg = new Map<string, OcPart[]>()
  for (const p of parts) {
    const arr = partsByMsg.get(p.message_id)
    if (arr) arr.push(p)
    else partsByMsg.set(p.message_id, [p])
  }

  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  const models = new Set<string>()
  const providers: string[] = []
  const taskCalls: Unit['taskCalls'] = []
  let tokens = emptyUsage()
  let cwd: string | undefined

  for (const msg of messages) {
    const d = parseJson(msg.data)
    if (!d) continue
    const role = d.role
    const ts = iso(d?.time?.created ?? msg.time_created)
    const cwdHere = d?.path?.cwd
    if (typeof cwdHere === 'string') cwd = cwdHere
    const msgParts = partsByMsg.get(msg.id) ?? []

    if (role === 'assistant') {
      const model: string | undefined = typeof d.modelID === 'string' ? d.modelID : undefined
      if (model) models.add(model)
      const provider: string | undefined = typeof d.providerID === 'string' ? d.providerID : undefined
      if (provider && !providers.includes(provider)) providers.push(provider)
      const usage = usageOf(d.tokens)
      tokens = addUsage(tokens, usage)

      const blocks = blocksFrom(msgParts, toolCalls, taskCalls, isSidechain, ts)
      const ev: AssistantMessage = {
        kind: 'assistant',
        ts,
        isSidechain,
        agentId,
        model,
        blocks,
        usage,
        costUsd: typeof d.cost === 'number' ? d.cost : undefined,
      }
      events.push(ev)
    } else if (role === 'user') {
      const blocks = blocksFrom(msgParts, toolCalls, taskCalls, isSidechain, ts)
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      const ev: UserMessage = { kind: 'user', ts, isSidechain, agentId, text, blocks }
      events.push(ev)
    }
  }

  return { events, toolCalls, tokens, models, providers, cwd, taskCalls }
}

/** Turn a message's parts into content blocks, accumulating tool calls as a side effect. */
function blocksFrom(
  parts: OcPart[],
  toolCalls: ToolCall[],
  taskCalls: Unit['taskCalls'],
  isSidechain: boolean,
  ts: string | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const p of parts) {
    const d = parseJson(p.data)
    if (!d) continue
    if (d.type === 'text') {
      blocks.push({ type: 'text', text: String(d.text ?? '') })
    } else if (d.type === 'reasoning') {
      blocks.push({ type: 'thinking', text: String(d.text ?? '') })
    } else if (d.type === 'tool' && typeof d.callID === 'string') {
      const tool = String(d.tool ?? '')
      const state = (d.state && typeof d.state === 'object' ? d.state : {}) as Raw
      const input = state.input
      const mapped = mapAction(tool, input)
      blocks.push({ type: 'tool_use', id: d.callID, name: tool, input })
      const isError = state.status === 'error'
      toolCalls.push({
        id: d.callID,
        name: mapped.name ?? tool,
        action: mapped.action,
        input,
        target: mapped.target,
        result: { ok: !isError, isError, raw: state.output ?? state.error ?? state.metadata },
        isSidechain,
        ts,
        durationMs: durationOf(state),
      })
      if (tool === 'task' && input && typeof input === 'object') {
        const i = input as Raw
        taskCalls.push({
          description: typeof i.description === 'string' ? i.description : '',
          subagentType: typeof i.subagent_type === 'string' ? i.subagent_type : undefined,
          callID: d.callID,
        })
      }
    }
    // step-start / step-finish carry no transcript content; ignore.
  }
  return blocks
}

function appendHash(into: string[], messages: OcMessage[], parts: OcPart[]): void {
  for (const m of messages) into.push(m.id, m.data)
  for (const p of parts) into.push(p.id, p.data)
}

/**
 * OpenCode tokens: { input, output, reasoning, cache: { read, write } }, where
 * reasoning is counted separately from output. tuneloop has no reasoning field, so
 * fold it into output to keep the rolled-up total whole.
 */
function usageOf(t: Raw): TokenUsage {
  if (!t || typeof t !== 'object') return emptyUsage()
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {}
  return {
    input: num(t.input),
    output: num(t.output) + num(t.reasoning),
    // OpenCode reports no cache TTL (and bills its own cost anyway) — treat as 5m
    cacheCreate5m: num(cache.write),
    cacheCreate1h: 0,
    cacheRead: num(cache.read),
  }
}

function durationOf(state: Raw): number | undefined {
  const start = state?.time?.start
  const end = state?.time?.end
  if (typeof start === 'number' && typeof end === 'number' && end >= start) return end - start
  return undefined
}

/**
 * Extract a plain model id from the `session.model` column, which OpenCode stores
 * as a JSON object (`{"id","providerID","variant"}`) — message-level `modelID` is
 * already a plain string, so this only normalizes the session-row form.
 */
function modelIdOf(raw: string | null): string | undefined {
  if (!raw) return undefined
  const t = raw.trim()
  if (t.startsWith('{')) {
    const o = parseJson(t)
    return o && typeof o.id === 'string' ? o.id : undefined
  }
  return t || undefined
}

function parseJson(s: string): Raw | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function iso(ms: unknown): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
