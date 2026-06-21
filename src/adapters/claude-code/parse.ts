import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { contentHash } from '../../core/hash'
import { addUsage, emptyUsage } from '../../core/model'
import type {
  AssistantMessage,
  ContentBlock,
  Event,
  Session,
  SystemEvent,
  TokenUsage,
  ToolCall,
  UserMessage,
} from '../../core/model'
import { mapAction } from './actions'

export const PARSE_VERSION = 3
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
  const models = new Set<string>()
  let tokens = emptyUsage()
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

    if (r.type === 'assistant' && r.message) {
      const m = r.message
      const model: string | undefined = typeof m.model === 'string' ? m.model : undefined
      if (model) models.add(model)
      const usage = usageOf(m.usage)
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
        subtype: typeof r.subtype === 'string' ? r.subtype : undefined,
        text: typeof r.content === 'string' ? r.content : undefined,
      }
      events.push(ev)
    }
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
    raw: { path, contentHash: contentHash(content) },
  }
}

function usageOf(u: Raw): TokenUsage {
  if (!u || typeof u !== 'object') return emptyUsage()
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function firstString(records: Raw[], key: string): string | undefined {
  for (const r of records) if (typeof r[key] === 'string') return r[key]
  return undefined
}
