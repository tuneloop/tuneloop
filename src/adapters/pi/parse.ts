import { readFile } from 'node:fs/promises'
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
import { findCanonicalLeaf, walkToLeaf } from './tree'
import type { TreeEntry } from './tree'

export const PARSE_VERSION = 1
const SOURCE = 'pi'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

export async function parsePi(path: string): Promise<Session | null> {
  const content = await readFile(path, 'utf8')
  const lines = content.split('\n')
  const records: Raw[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* skip malformed */
    }
  }
  if (!records.length) return null

  // Validate header
  const header = records[0]
  if (header.type !== 'session') return null

  const sessionId: string = header.id ?? ''
  const entries = records.slice(1) as TreeEntry[]
  if (!entries.length) return null

  // Check that at least one assistant message exists anywhere in the tree
  const hasAssistant = entries.some(
    (e) => e.type === 'message' && (e as Raw).message?.role === 'assistant' && (e as Raw).message?.usage,
  )
  if (!hasAssistant) return null

  // Compute total tokens from ALL assistant messages across the entire tree
  let tokens = emptyUsage()
  for (const e of entries) {
    if (e.type === 'message') {
      const m = (e as Raw).message
      if (m?.role === 'assistant' && m.usage) {
        tokens = addUsage(tokens, usageOf(m.usage))
      }
    }
  }

  // Resolve canonical path (handles both linear and branched sessions)
  const canonicalLeaf = findCanonicalLeaf(entries)
  const linearPath = walkToLeaf(entries, canonicalLeaf)

  // Walk the canonical path, building events and tool calls
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  const models = new Set<string>()
  let provider: string | undefined
  let title: string | undefined

  // Pending tool calls from the most recent assistant message, keyed by id
  const pendingTools = new Map<string, { name: string; args: unknown; ts?: string }>()

  for (const entry of linearPath) {
    const ts: string | undefined = typeof entry.timestamp === 'string' ? entry.timestamp : undefined

    if (entry.type === 'model_change') {
      if (!provider && typeof (entry as Raw).provider === 'string') {
        provider = (entry as Raw).provider
      }
      continue
    }

    if (entry.type === 'thinking_level_change' || entry.type === 'compaction' ||
        entry.type === 'branch_summary' || entry.type === 'custom' ||
        entry.type === 'custom_message' || entry.type === 'label') {
      continue
    }

    if (entry.type === 'session_info') {
      const name = (entry as Raw).name
      if (typeof name === 'string') title = name
      continue
    }

    if (entry.type !== 'message') continue

    const m = (entry as Raw).message
    if (!m) continue

    if (m.role === 'assistant') {
      const model: string | undefined = typeof m.model === 'string' ? m.model : undefined
      if (model) models.add(model)
      if (!provider && typeof m.provider === 'string') provider = m.provider

      const usage = usageOf(m.usage)
      const costUsd = typeof m.usage?.cost?.total === 'number' ? m.usage.cost.total : undefined

      const blocks: ContentBlock[] = []
      pendingTools.clear()

      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text') {
            blocks.push({ type: 'text', text: String(b.text ?? '') })
          } else if (b.type === 'thinking') {
            blocks.push({ type: 'thinking', text: String(b.thinking ?? '') })
          } else if (b.type === 'toolCall' && typeof b.id === 'string') {
            const name = String(b.name ?? '')
            blocks.push({ type: 'tool_use', id: b.id, name, input: b.arguments })
            pendingTools.set(b.id, { name, args: b.arguments, ts })
          }
        }
      }

      const ev: AssistantMessage = {
        kind: 'assistant',
        ts,
        isSidechain: false,
        model,
        blocks,
        usage,
        costUsd,
      }
      events.push(ev)
    } else if (m.role === 'user') {
      const content = m.content
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
          }
        }
      }
      const ev: UserMessage = {
        kind: 'user',
        ts,
        isSidechain: false,
        text,
        blocks,
      }
      events.push(ev)
    } else if (m.role === 'toolResult') {
      const toolCallId = m.toolCallId as string | undefined
      if (toolCallId && pendingTools.has(toolCallId)) {
        const pending = pendingTools.get(toolCallId)!
        const mapped = mapAction(pending.name, pending.args)
        toolCalls.push({
          id: toolCallId,
          name: mapped.name ?? pending.name,
          action: mapped.action,
          input: pending.args,
          target: mapped.target,
          result: { ok: !m.isError, isError: !!m.isError, raw: m.content },
          isSidechain: false,
          ts: pending.ts,
        })
        pendingTools.delete(toolCallId)
      }
    } else if (m.role === 'bashExecution') {
      const ev: SystemEvent = {
        kind: 'system',
        ts,
        isSidechain: false,
        subtype: 'bash_execution',
        text: typeof m.command === 'string' ? m.command : undefined,
      }
      events.push(ev)
    }
  }

  // Flush any tool calls that never got a result (interrupted session)
  for (const [id, pending] of pendingTools) {
    const mapped = mapAction(pending.name, pending.args)
    toolCalls.push({
      id,
      name: mapped.name ?? pending.name,
      action: mapped.action,
      input: pending.args,
      target: mapped.target,
      result: { ok: false, isError: true },
      isSidechain: false,
      ts: pending.ts,
    })
  }

  // Scan all entries for session title (session_info may be on any branch)
  if (!title) {
    for (const e of entries) {
      if (e.type === 'session_info' && typeof (e as Raw).name === 'string') {
        title = (e as Raw).name
      }
    }
  }

  // Resolve fork linkage if this session was forked from another
  const forkedFromId = await resolveParentSession(header.parentSession)

  return {
    id: `${SOURCE}:${sessionId}`,
    sessionId,
    source: SOURCE,
    provider: provider ?? 'unknown',
    title,
    forkedFromId,
    project: { cwd: header.cwd },
    startedAt: header.timestamp,
    endedAt: linearPath[linearPath.length - 1]?.timestamp ?? header.timestamp,
    models: [...models],
    tokens,
    events,
    toolCalls,
    raw: { path, contentHash: contentHash(content) },
  }
}

async function resolveParentSession(parentPath: unknown): Promise<string | undefined> {
  if (typeof parentPath !== 'string') return undefined
  try {
    const parentContent = await readFile(parentPath, 'utf8')
    const firstLine = parentContent.split('\n')[0]
    if (!firstLine) return undefined
    const parentHeader = JSON.parse(firstLine)
    if (parentHeader.type === 'session' && typeof parentHeader.id === 'string') {
      return `${SOURCE}:${parentHeader.id}`
    }
  } catch {
    /* parent file missing or unreadable — not an error */
  }
  return undefined
}

function usageOf(u: Raw): TokenUsage {
  if (!u || typeof u !== 'object') return emptyUsage()
  return {
    input: num(u.input),
    output: num(u.output),
    cacheCreate: num(u.cacheWrite),
    cacheRead: num(u.cacheRead),
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
