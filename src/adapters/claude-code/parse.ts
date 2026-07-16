import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { contentHash } from '../../core/hash'
import { addUsage, emptyUsage } from '../../core/model'
import type {
  AssistantMessage,
  ContentBlock,
  Event,
  Session,
  SubagentMeta,
  SystemEvent,
  TokenUsage,
  ToolCall,
  UserMessage,
} from '../../core/model'
import { mapAction } from './actions'

// Bump when ingest-time derivation changes so stored sessions are rebuilt on the
// same bytes (see analyze.ts). 4: capture subagent identity (agentId on events +
// session.subagents from the sidechain `.meta.json`) for the tabbed transcript.
// 5: assign main-thread `seq` (assignSeq) so the block partition + blob carry it.
// 6: skip <synthetic> messages — emit api errors as SystemEvent, drop no-ops.
// 7: count usage once per API message id, from the message's final line.
// 8: capture the 1h-TTL share of cache creation (`cacheCreate1h`) so cache
//    writes price at their real rate instead of all-5m.
export const PARSE_VERSION = 8
const SOURCE = 'claude-code'
const PROVIDER = 'anthropic'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

/**
 * Parse a Claude Code `.jsonl` transcript into the normalized model. Handles the
 * line-type zoo (keeps user/assistant/system, ignores mode/snapshot/attachment),
 * joins tool_use blocks to their results (incl. the top-level `toolUseResult`),
 * and rolls up per-message token usage including sidechain (Task) turns.
 */
export async function parseClaudeCode(path: string): Promise<Session | null> {
  const content = await readFile(path, 'utf8')
  const records: Raw[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* skip malformed line */
    }
  }
  const hasMessages = records.some((r) => (r.type === 'assistant' || r.type === 'user') && r.message)
  if (!hasMessages) return null

  const sessionId = firstString(records, 'sessionId') ?? basename(path).replace(/\.jsonl$/, '')

  // tool_use_id -> result, gathered from user-turn tool_result blocks + top-level toolUseResult.
  const resultById = new Map<string, { content: unknown; isError: boolean; toolUseResult?: unknown }>()
  for (const r of records) {
    if (r.type === 'user' && r.message && Array.isArray(r.message.content)) {
      for (const b of r.message.content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          resultById.set(b.tool_use_id, {
            content: b.content,
            isError: !!b.is_error,
            toolUseResult: r.toolUseResult,
          })
        }
      }
    }
  }

  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  // Distinct subagent ids seen in this file. Claude Code writes each subagent to
  // its own transcript file (records tagged with `agentId`), so in practice this
  // is a single id, but we collect the set to stay robust.
  const agentIds = new Set<string>()
  const models = new Set<string>()
  let tokens = emptyUsage()
  const usageCountedIds = new Set<string>()
  const finalUsageById = lastUsageByMessageId(records)
  let title: string | undefined
  let cwd: string | undefined
  let branch: string | undefined
  let firstTs: string | undefined
  let lastTs: string | undefined

  for (const r of records) {
    const ts: string | undefined = typeof r.timestamp === 'string' ? r.timestamp : undefined
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    if (typeof r.cwd === 'string') cwd = r.cwd
    if (typeof r.gitBranch === 'string') branch = r.gitBranch
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') title = r.aiTitle

    const isSidechain = !!r.isSidechain
    const agentId = typeof r.agentId === 'string' ? r.agentId : undefined
    if (agentId) agentIds.add(agentId)

    if (r.type === 'assistant' && r.message) {
      const m = r.message

      // Claude Code injects synthetic assistant messages (model: "<synthetic>")
      // for API errors and no-op turns — these never hit the real model.
      if (m.model === '<synthetic>') {
        // add only only if it's a terminal api error, skip no-op
        if (r.isApiErrorMessage) {
          const text = Array.isArray(m.content)
            ? m.content.filter((b: Raw) => b?.type === 'text').map((b: Raw) => String(b.text ?? '')).join('\n')
            : undefined
          const ev: SystemEvent = {
            kind: 'system',
            uuid: r.uuid,
            parentUuid: r.parentUuid ?? null,
            ts,
            isSidechain,
            agentId,
            subtype: 'api_error',
            text,
          }
          events.push(ev)
        }
        continue // skip adding to token accumulator and models
      }

      const model: string | undefined = typeof m.model === 'string' ? m.model : undefined
      if (model) models.add(model)
      // Claude Code writes one transcript line per content block of the same API
      // message. Count each message's usage once, keyed by message id, taking it
      // from the message's FINAL line: main-thread lines repeat the full usage,
      // but subagent lines stream output_tokens up across blocks — only the last
      // line holds the true figure. Attribute it to the first line; repeats keep
      // their content but carry zero usage, so nothing multiplies per block.
      const msgId = typeof m.id === 'string' ? m.id : undefined
      let usage: TokenUsage
      if (msgId) {
        usage = usageCountedIds.has(msgId) ? emptyUsage() : (finalUsageById.get(msgId) ?? usageOf(m.usage))
        usageCountedIds.add(msgId)
      } else {
        usage = usageOf(m.usage)
      }
      tokens = addUsage(tokens, usage)

      const blocks: ContentBlock[] = []
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text') blocks.push({ type: 'text', text: String(b.text ?? '') })
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: String(b.thinking ?? '') })
          else if (b.type === 'tool_use' && typeof b.id === 'string') {
            const name = String(b.name ?? '')
            blocks.push({ type: 'tool_use', id: b.id, name, input: b.input })
            const res = resultById.get(b.id)
            const mapped = mapAction(name, b.input)
            toolCalls.push({
              id: b.id,
              // Analytics identity: refined for skills (specific skill name),
              // raw tool name otherwise. The transcript block above keeps the literal name.
              name: mapped.name ?? name,
              action: mapped.action,
              input: b.input,
              target: mapped.target,
              result: { ok: !res?.isError, isError: !!res?.isError, raw: res?.toolUseResult ?? res?.content },
              isSidechain,
              ts,
            })
          }
        }
      }
      const ev: AssistantMessage = {
        kind: 'assistant',
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        ts,
        isSidechain,
        agentId,
        model,
        blocks,
        usage,
      }
      events.push(ev)
    } else if (r.type === 'user' && r.message) {
      const content = r.message.content
      const blocks: ContentBlock[] = []
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text') {
            text += (text ? '\n' : '') + String(b.text ?? '')
            blocks.push({ type: 'text', text: String(b.text ?? '') })
          } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            blocks.push({ type: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, content: b.content })
          }
        }
      }
      const ev: UserMessage = {
        kind: 'user',
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        ts,
        isSidechain,
        agentId,
        text,
        blocks,
      }
      events.push(ev)
    } else if (r.type === 'system') {
      const ev: SystemEvent = {
        kind: 'system',
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        ts,
        isSidechain,
        agentId,
        subtype: typeof r.subtype === 'string' ? r.subtype : undefined,
        text: typeof r.content === 'string' ? r.content : undefined,
      }
      events.push(ev)
    }
  }

  // Skip sessions where the model was never reached (e.g. only synthetic messages).
  if (!events.some((e) => e.kind === 'assistant')) return null

  // A sidechain file carries one (occasionally more) subagent. Its sibling
  // `<file>.meta.json` names the subagent type/description and the parent tool
  // call that spawned it, which is what links the call to this transcript.
  let subagents: SubagentMeta[] | undefined
  if (agentIds.size) {
    const meta = await readAgentMeta(path)
    subagents = [...agentIds].map((agentId) => ({ agentId, ...meta }))
  }

  return {
    id: `${SOURCE}:${sessionId}`,
    sessionId,
    source: SOURCE,
    provider: PROVIDER,
    title,
    project: { cwd, branch },
    startedAt: firstTs,
    endedAt: lastTs,
    models: [...models],
    tokens,
    events,
    toolCalls,
    subagents,
    raw: { path, contentHash: contentHash(content) },
  }
}

/**
 * Read a subagent transcript's sibling `<file>.meta.json`, returning the fields
 * the viewer links/labels by. Missing or malformed → empty (the subagent still
 * gets a tab keyed by its `agentId`, just without a type/description/link).
 */
async function readAgentMeta(jsonlPath: string): Promise<Omit<SubagentMeta, 'agentId'>> {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  if (metaPath === jsonlPath) return {}
  try {
    const m = JSON.parse(await readFile(metaPath, 'utf8')) as Raw
    return {
      agentType: typeof m.agentType === 'string' ? m.agentType : undefined,
      description: typeof m.description === 'string' ? m.description : undefined,
      toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * The final usage snapshot per API `message.id`. Claude Code appends one
 * transcript line per content block, each carrying that message's usage; later
 * lines overwrite earlier here, so the map keeps the LAST (complete) figure.
 * Main-thread lines repeat the full usage, but subagent lines report a growing
 * output_tokens as blocks stream — only the last line is authoritative.
 */
function lastUsageByMessageId(records: Raw[]): Map<string, TokenUsage> {
  const out = new Map<string, TokenUsage>()
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message) continue
    const m = r.message
    if (m.model === '<synthetic>' || typeof m.id !== 'string') continue
    out.set(m.id, usageOf(m.usage))
  }
  return out
}

function usageOf(u: Raw): TokenUsage {
  if (!u || typeof u !== 'object') return emptyUsage()
  const base = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) }
  // `cache_creation` breaks the write total down by TTL, and the two bill at
  // different rates — Claude Code puts most of its cache on the 1h TTL, so the
  // split is the difference between a right and a ~7%-low cost.
  const cc = u.cache_creation
  if (!cc || typeof cc !== 'object') {
    // Claude Code predating the breakdown: only the write total, all of it 5m.
    // Must stay explicit — reading the ephemeral_* fields off a missing object
    // would zero BOTH and drop the whole cache-write from tokens and cost.
    return { ...base, cacheCreate5m: num(u.cache_creation_input_tokens), cacheCreate1h: 0 }
  }
  return {
    ...base,
    cacheCreate5m: num(cc.ephemeral_5m_input_tokens),
    cacheCreate1h: num(cc.ephemeral_1h_input_tokens),
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function firstString(records: Raw[], key: string): string | undefined {
  for (const r of records) if (typeof r[key] === 'string') return r[key]
  return undefined
}
