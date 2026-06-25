/**
 * The normalized session model — the contract every processor reads and every
 * adapter produces. Adapters translate a vendor's transcript into this shape;
 * processors and the store never need to know which harness a session came from.
 *
 * `raw` is always preserved as an escape hatch for processors that need
 * vendor-specific detail the canonical view doesn't capture.
 */

/** Vendor-neutral classification of a tool call. The per-vendor mapping lives in the adapter. */
export type CanonicalAction =
  | 'file_write'
  | 'file_read'
  | 'shell'
  | 'search'
  | 'task_spawn'
  | 'mcp_call'
  | 'web'
  | 'todo'
  | 'skill'
  | 'other'

export interface TokenUsage {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: unknown }

interface BaseEvent {
  uuid?: string
  parentUuid?: string | null
  ts?: string
  isSidechain: boolean
  /**
   * Dense ordinal over MAIN-THREAD events (sidechain events have none), assigned
   * post-merge by assignSeq() (core/blocks.ts). The coordinate the block partition
   * is defined in; persisted in the session blob.
   */
  seq?: number
  /**
   * For sidechain (subagent) events, the stable id of the subagent that emitted
   * them — Claude Code's per-subagent transcript id. Lets the viewer group a
   * subagent's turns into their own thread instead of interleaving them with the
   * main conversation. Undefined for main-thread events.
   */
  agentId?: string
}

export interface UserMessage extends BaseEvent {
  kind: 'user'
  text: string
  blocks: ContentBlock[]
}

export interface AssistantMessage extends BaseEvent {
  kind: 'assistant'
  model?: string
  blocks: ContentBlock[]
  usage: TokenUsage
}

export interface SystemEvent extends BaseEvent {
  kind: 'system'
  subtype?: string
  text?: string
}

export type Event = UserMessage | AssistantMessage | SystemEvent

/** A tool_use joined to its tool_result, classified into a canonical action. */
export interface ToolCall {
  id: string
  name: string
  action: CanonicalAction
  input: unknown
  /** Normalized fields per action (paths for file ops, command for shell, etc.). */
  target: { paths?: string[]; command?: string }
  result: { ok: boolean; isError: boolean; raw?: unknown }
  isSidechain: boolean
  ts?: string
  durationMs?: number
}

/**
 * A subagent (sidechain) spawned within a session. Claude Code writes each
 * subagent's transcript to its own file with a sibling `.meta.json`; this is the
 * normalized view of that metadata. `toolUseId` is the id of the spawning tool
 * call (the `Task`/`Agent` tool_use) in the parent thread, which lets the viewer
 * link that call to the subagent's transcript. Workflow subagents have no
 * spawning tool call, so `toolUseId` is absent for them.
 */
export interface SubagentMeta {
  agentId: string
  agentType?: string
  description?: string
  toolUseId?: string
}

export interface Session {
  /** Namespaced id, e.g. `claude-code:<uuid>` — unique across vendors. */
  id: string
  /** Raw vendor session id. */
  sessionId: string
  /** Adapter / harness id, e.g. `claude-code`. */
  source: string
  /** LLM vendor family for slicing, e.g. `anthropic`. */
  provider: string
  title?: string
  /**
   * For a sub-agent transcript that lives in its own file (Codex), the parent
   * session's raw id — the grouping key that folds it into the parent as a
   * sidechain (see analyze.ts / merge.ts). Undefined for top-level sessions.
   */
  forkedFromId?: string
  project: { cwd?: string; repo?: string; branch?: string }
  startedAt?: string
  endedAt?: string
  /** Distinct models seen across assistant messages (model is per-message). */
  models: string[]
  /** Rolled-up token usage across all assistant messages (incl. sidechains). */
  tokens: TokenUsage
  events: Event[]
  /** Flattened convenience view of every tool call, incl. sidechains. */
  toolCalls: ToolCall[]
  /** Subagents spawned in this session (one per sidechain transcript). */
  subagents?: SubagentMeta[]
  raw: { path: string; contentHash: string }
}
