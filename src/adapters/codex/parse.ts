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
import { mapAction, shellPatchBody } from './actions'
import { extractExecEnvelope } from './exec-envelope'

// Bump when ingest-time derivation changes so stored sessions are rebuilt on the
// same bytes (composed with NORMALIZE_VERSION in analyze.ts). 1: initial Codex adapter.
// 3: expand unified `exec` JavaScript envelopes into canonical child tool calls.
// 4: reclassify shell `apply_patch <<'PATCH'` commands as file_write with the patch body.
// 5: split exec-envelope outputs by block count (any JS shape) + strip runtime preamble.
// 6: extract the patch body for a shell `apply_patch` inside an exec envelope too.
export const PARSE_VERSION = 6
const SOURCE = 'codex'
const PROVIDER = 'openai'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

/**
 * Parse a Codex rollout `.jsonl` (the `rollout-*.jsonl` files under `~/.codex/sessions`)
 * into the normalized model. Lines are `{type, payload}`: `session_meta` (identity/cwd/git),
 * `turn_context` (the model), `response_item` (the API conversation), `event_msg`
 * (UI events incl. `token_count`). Usage lives only on `token_count` events, so one
 * assistant message is emitted per token_count, folding the response items since the
 * previous one. Sub-agent files (`thread_source: subagent`) are tagged as
 * sidechains for the parent merge
 */
export async function parseCodex(path: string): Promise<Session | null> {
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

  const meta = records.find((r) => r.type === 'session_meta')?.payload as Raw
  if (!meta || typeof meta.id !== 'string') return null // not a Codex rollout

  const sessionId: string = meta.id
  const isSubagent = meta.thread_source === 'subagent'
  const forkedFromId: string | undefined =
    typeof meta.forked_from_id === 'string'
      ? meta.forked_from_id
      : typeof meta?.source?.subagent?.thread_spawn?.parent_thread_id === 'string'
        ? meta.source.subagent.thread_spawn.parent_thread_id
        : undefined

  // Two things gathered up front (some trail what they describe in file order):
  //  - tool call_id -> output string, so a call joins its result regardless of order.
  //  - the set of GENUINE human prompts. Codex echoes every real prompt as an
  //    `event_msg.user_message`, but NOT its injected `role:user` machinery
  //    (<environment_context>, <turn_aborted>, <subagent_notification>, …). So this
  //    set is the oracle for telling a real user turn from machinery (ADR-0001 Q1),
  //    which keeps core/turns.ts Claude-only and the block partition honest.
  const resultById = new Map<string, string>()
  const humanPrompts = new Set<string>()
  for (const r of records) {
    const p = r.payload as Raw
    if (!p) continue
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'tool_search_output') {
      if (typeof p.call_id === 'string') resultById.set(p.call_id, outputString(p.output ?? p.tools))
    } else if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      humanPrompts.add(p.message.trim())
    }
  }

  // Unified exec may yield before its nested command finishes. The follow-up is
  // a separate `wait(cell_id=...)` call, but analytically it is the originating
  // operation's result (not another tool invocation). Join those bytes up front;
  // keep the raw wait block in the event stream below for transcript fidelity.
  const deferredByCell = new Map<string, string>()
  const consumedWaits = new Set<string>()
  for (const r of records) {
    const p = r.payload as Raw
    if (r.type !== 'response_item' || p?.type !== 'custom_tool_call' || p.name !== 'exec' || typeof p.call_id !== 'string') continue
    const out = resultById.get(p.call_id)
    const cell = out && /Script running with cell ID\s+([^\s]+)/.exec(out)?.[1]
    if (cell) deferredByCell.set(cell, p.call_id)
  }
  for (const r of records) {
    const p = r.payload as Raw
    if (r.type !== 'response_item' || p?.type !== 'function_call' || p.name !== 'wait' || typeof p.call_id !== 'string') continue
    const args = parseArgs(p.arguments) as Record<string, unknown>
    const cell = typeof args?.cell_id === 'string' || typeof args?.cell_id === 'number' ? String(args.cell_id) : null
    const origin = cell ? deferredByCell.get(cell) : undefined
    const waited = resultById.get(p.call_id)
    if (!origin || waited == null) continue
    resultById.set(origin, `${resultById.get(origin) ?? ''}\n${waited}`)
    consumedWaits.add(p.call_id)
  }

  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  const models = new Set<string>()
  let tokens = emptyUsage()
  let currentModel: string | undefined
  let firstTs: string | undefined
  let lastTs: string | undefined

  // Strategy 1 (ADR-0001): accumulate assistant-side blocks; each token_count flushes
  // them into one AssistantMessage carrying that inference call's usage.
  let pending: ContentBlock[] = []
  // Cumulative-total signature of the last counted token_count. Older-format rollouts
  // re-emit a token_count with an unchanged `total_token_usage` (a turn-finalize echo);
  // skipping those avoids double-counting (ADR-0005). Equal cumulative total ⟺ a re-emit,
  // since a real inference call always advances the total — so usage-only records survive.
  let prevTotalSig: string | null = null
  const flush = (usage: TokenUsage, ts: string | undefined): void => {
    if (!pending.length && usage === ZERO) return
    const ev: AssistantMessage = {
      kind: 'assistant',
      ts,
      isSidechain: isSubagent,
      agentId: isSubagent ? sessionId : undefined,
      model: currentModel,
      blocks: pending,
      usage,
    }
    events.push(ev)
    tokens = addUsage(tokens, usage)
    pending = []
  }

  for (const r of records) {
    const ts: string | undefined = typeof r.timestamp === 'string' ? r.timestamp : undefined
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    const p = r.payload as Raw
    if (!p) continue

    if (r.type === 'turn_context' && typeof p.model === 'string') {
      currentModel = p.model
      models.add(p.model)
      continue
    }

    if (r.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info
      if (info && info.last_token_usage) {
        const total = info.total_token_usage
        const sig =
          total && (total.input_tokens != null || total.output_tokens != null)
            ? `${num(total.input_tokens)}/${num(total.output_tokens)}`
            : null
        // Skip a re-emit (same cumulative total as the previous count); a null sig
        // (no total) can't be deduped, so always count it.
        if (sig === null || sig !== prevTotalSig) {
          prevTotalSig = sig
          flush(mapUsage(info.last_token_usage), ts)
        }
      }
      continue
    }

    if (r.type !== 'response_item') continue

    if (p.type === 'message') {
      const text = textOf(p.content)
      if (p.role === 'assistant') {
        if (text) pending.push({ type: 'text', text })
      } else {
        // user / developer: a UserMessage only for a genuine human prompt (one Codex
        // echoed to event_msg.user_message). Everything else — developer role and
        // injected user-role machinery — becomes a SystemEvent.
        if (pending.length) flush(ZERO, ts) // flush any unaccounted assistant content first
        if (p.role === 'user' && humanPrompts.has(text.trim())) {
          const ev: UserMessage = {
            kind: 'user',
            ts,
            isSidechain: isSubagent,
            agentId: isSubagent ? sessionId : undefined,
            text,
            blocks: text ? [{ type: 'text', text }] : [],
          }
          events.push(ev)
        } else {
          const ev: SystemEvent = {
            kind: 'system',
            ts,
            isSidechain: isSubagent,
            agentId: isSubagent ? sessionId : undefined,
            subtype: p.role === 'developer' ? 'developer' : 'context',
            text,
          }
          events.push(ev)
        }
      }
    } else if (p.type === 'reasoning') {
      const summary = summaryText(p.summary)
      if (summary) pending.push({ type: 'thinking', text: summary })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'tool_search_call') {
      const name = String(p.name ?? (p.type === 'tool_search_call' ? 'tool_search' : ''))
      const callId = typeof p.call_id === 'string' ? p.call_id : `${name}-${toolCalls.length}`
      // function_call: `arguments` is a JSON STRING. custom_tool_call (apply_patch): `input`
      // is the raw patch text. tool_search_call: `arguments` is an object.
      const input = p.type === 'function_call' ? parseArgs(p.arguments) : (p.input ?? p.arguments)
      // A consumed wait remains visible as raw transport in the transcript but is
      // not a second analytics operation; its output was joined to the exec above.
      if (consumedWaits.has(callId)) {
        pending.push({ type: 'tool_use', id: callId, name, input })
        continue
      }
      if (p.type === 'custom_tool_call' && name === 'exec' && typeof input === 'string') {
        const { operations } = extractExecEnvelope(input)
        if (operations.length) {
          const out = resultById.get(callId)
          const childOutputs = execChildOutputs(out, operations.length)
          pending.push({ type: 'tool_use', id: callId, name, input })
          operations.forEach((operation, ordinal) => {
            const mapped = operation.resolved
              ? mapAction(operation.name, operation.input)
              : { action: 'other' as const, target: {} }
            const childOut = childOutputs[ordinal]
            const statusOut = childOut ?? out
            const code = exitCodeOf(statusOut)
            const isError = code != null ? code !== 0 : toolCallFailed(statusOut)
            toolCalls.push({
              id: `${callId}:${ordinal}`,
              parentId: callId,
              name: mapped.name ?? operation.name,
              action: mapped.action,
              input: patchInput(mapped.action, operation.input),
              target: mapped.target,
              result: { ok: !isError, isError, raw: childOut },
              isSidechain: isSubagent,
              ts,
            })
          })
          continue
        }
      }
      // `namespace` (function_call only) tags MCP tools as `mcp__<server>`.
      const namespace = typeof p.namespace === 'string' ? p.namespace : undefined
      const mapped = mapAction(name, input, namespace)
      const out = resultById.get(callId)
      // Derive failure from the tool's exit code across Codex's output shapes (shell
      // wrappers, apply_patch, and the structured `{metadata:{exit_code}}` form). MCP
      // calls carry no exit code, so fall back to Codex's `tool call error:` marker.
      // No signal at all → assume ok.
      const code = exitCodeOf(out)
      const isError = code != null ? code !== 0 : toolCallFailed(out)
      pending.push({ type: 'tool_use', id: callId, name, input }) // transcript block keeps the literal tool name + raw command
      toolCalls.push({
        id: callId,
        // Analytics identity: refined for skills (the specific skill name), raw tool name otherwise.
        name: mapped.name ?? name,
        action: mapped.action,
        input: patchInput(mapped.action, input),
        target: mapped.target,
        result: { ok: !isError, isError, raw: out },
        isSidechain: isSubagent,
        ts,
      })
    }
  }

  // Trailing assistant content with no closing token_count → a zero-usage record.
  if (pending.length) flush(ZERO, lastTs)

  // A sub-agent file is one sidechain; its `agent_nickname` labels it. `toolUseId`
  // (the parent's spawn_agent call) is resolved during the parent merge (Phase 2).
  const subagents: SubagentMeta[] | undefined = isSubagent
    ? [{ agentId: sessionId, agentType: typeof meta.agent_nickname === 'string' ? meta.agent_nickname : undefined }]
    : undefined

  return {
    id: `${SOURCE}:${sessionId}`,
    sessionId,
    source: SOURCE,
    provider: PROVIDER,
    // TODO: Codex has no native session title — enrich from the transcript via LLM later (docs/TODO.md).
    title: undefined,
    project: { cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined, branch: meta?.git?.branch },
    forkedFromId,
    isSubagent: isSubagent || undefined,
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
 * Exit code for a tool call across Codex's output shapes, or null when none is present
 * (→ treated as success). Handles the structured `{output, metadata:{exit_code}}` form
 * and the line-anchored shell wrappers (`Process exited with code N` / `Exit code: N`),
 * matched before stdout so an echoed phrase can't masquerade as the status line.
 */
function exitCodeOf(out: string | undefined): number | null {
  if (out == null) return null
  try {
    const o = JSON.parse(out)
    if (o && typeof o === 'object' && o.metadata && typeof o.metadata.exit_code === 'number') {
      return o.metadata.exit_code
    }
  } catch {
    /* not JSON — fall through to the text wrappers */
  }
  const m = /^(?:Process exited with code|Exit code:)\s*(\d+)/m.exec(out)
  return m ? parseInt(m[1]!, 10) : null
}

/**
 * A failed tool call with no exit code — three Codex framings, none carrying one:
 *  - MCP/tool transport failures get a literal `tool call error:` prefix.
 *  - A command that never ran (binary missing, or a sandbox/spawn error) is framed
 *    `exec_command failed for ...` — exec-tool-specific, line-anchored so echoed
 *    stdout can't masquerade as the status line.
 *  - A user-DENIED approval. Codex attaches the decision reason `rejected by user`
 *    regardless of which tool was gated, so we match THAT rather than any one
 *    tool's wrapper — an exec rejection arrives as `exec_command failed for ...:
 *    CreateProcess { message: "Rejected("rejected by user")" }`, but a denied
 *    apply_patch / MCP call won't carry the exec prefix. Without this a rejected
 *    call reads as a success (no exit code, no `tool call error:`) and vanishes.
 *    Keep in sync with error-category's `user_rejected` rule (same text).
 */
function toolCallFailed(out: string | undefined): boolean {
  if (out == null) return false
  return out.includes('tool call error:') || /^exec_command failed for /m.test(out) || out.includes('rejected by user')
}

/** Shared zero-usage sentinel — its identity flags a content-only (no token_count) flush. */
const ZERO: TokenUsage = emptyUsage()

function mapUsage(last: Raw): TokenUsage {
  const cached = num(last.cached_input_tokens)
  return {
    input: Math.max(0, num(last.input_tokens) - cached), // input_tokens INCLUDES cached
    output: num(last.output_tokens), // INCLUDES reasoning_output_tokens
    cacheCreate5m: 0, // Codex transcripts do not expose cache-write tokens
    cacheCreate1h: 0,
    cacheRead: cached,
  }
}

/** Join a Codex message's content array into plain text (`input_text` / `output_text`). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && typeof (b as Raw).text === 'string') parts.push((b as Raw).text)
  }
  return parts.join('\n')
}

/** Codex reasoning summary: array of `{ type: 'summary_text', text }`. */
function summaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => (s && typeof s === 'object' && typeof (s as Raw).text === 'string' ? (s as Raw).text : ''))
    .filter(Boolean)
    .join('\n')
}

function outputString(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? '')
}

/**
 * For a shell `apply_patch <<'PATCH'` reclassified to file_write, carry the patch body as
 * `input` (not the {cmd} object) so file-diff rendering and PR content-match — which key on
 * a string patch input — treat it like the native tool. Applies on both the direct
 * function_call path and the exec-envelope child path. Any other input passes through.
 */
function patchInput(action: string, input: unknown): unknown {
  const cmd = input && typeof input === 'object' ? (input as Record<string, unknown>).cmd : undefined
  return action === 'file_write' && typeof cmd === 'string' ? shellPatchBody(cmd) ?? input : input
}

// The code-mode runtime frames every exec output as `Script completed|running\nWall
// time …\nOutput:\n` in the first text block; the real per-command output follows in
// later blocks. This framing is runtime noise (a native exec_command carries none),
// so it is stripped uniformly below.
const EXEC_PREAMBLE = /^Script (?:completed|running)\b/

/**
 * Split an exec envelope's emitted output across its semantic children. The runtime
 * emits one preamble block plus one text block per `text(...)` call, in source order —
 * true regardless of how the JS emitted them (sequential `await`s, `Promise.all` + loop,
 * etc.), so we key on that block structure, NOT the JS shape.
 *
 *   - payload-block count === child count  → map 1:1 in source order.
 *   - single child                         → join all payload blocks into it.
 *   - any other mismatch (truncation, a command that printed nothing, multiple emits
 *     from one command) → no per-child output, so one command's URL/error never leaks
 *     into another's analytics. Correctness over coverage.
 */
function execChildOutputs(out: string | undefined, count: number): Array<string | undefined> {
  if (out == null) return new Array(count).fill(undefined)
  let payloads: string[]
  try {
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed)) return count === 1 ? [out] : new Array(count).fill(undefined)
    const texts = parsed
      .map((b) => (b && typeof b === 'object' && typeof (b as Raw).text === 'string' ? (b as Raw).text as string : null))
      .filter((s): s is string => s != null)
    payloads = texts.length && EXEC_PREAMBLE.test(texts[0]!) ? texts.slice(1) : texts
  } catch {
    return count === 1 ? [out] : new Array(count).fill(undefined)
  }
  if (count === 1) return [payloads.join('\n')]
  return payloads.length === count ? payloads : new Array(count).fill(undefined)
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {}
  try {
    return JSON.parse(args)
  } catch {
    return { _raw: args }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
