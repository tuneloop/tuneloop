import { classifyError } from '../../core/error-category'
import { isApproval, stripReminders, userTurnEvents } from '../../core/turns'
import type { Session } from '../../core/model'

/**
 * A substantive follow-up turn plus the agent activity that preceded it — the
 * context needed to read the user's REACTION rather than guess at it. The user's
 * words go in full; tool RESULTS are dropped (bulk, rarely change the read) and
 * assistant messages 2+ steps from the turn are head+tail clipped (see renderActivity).
 */
export interface Followup {
  /** The user's turn text, in full. */
  text: string
  seq?: number
  /** Timestamp of the user message (the real friction moment); drives theme first/last-seen. */
  ts?: string
  /** error_category keys of failed main-thread tool calls preceding this turn. */
  errors: string[]
  /**
   * What the agent did/said in the window before this turn — full assistant
   * message text interleaved with tool-call lines (one line per call; failures
   * carry a trimmed error, successes just a header). Undefined if the window is
   * empty.
   */
  activity?: string
  /** Set when the user pressed Esc in this window: what the agent was doing ('' if unrecoverable). */
  interrupted?: string
  /** Skills/subagents the agent invoked in this window — lets the model name a "skill X produced bad output" theme. */
  skills?: string[]
}

/** One main-thread agent action, in seq order — assistant prose or a tool call. */
interface Activity {
  seq: number
  kind: 'text' | 'tool'
  text?: string
  // tool fields
  action?: string
  header?: string // e.g. "Read src/foo.ts" or "Bash: npm test"
  ok?: boolean
  error?: string // trimmed error text when the call failed
  skill?: string
}

/** Text of a tool result (result.raw may be a string or structured), for error detail. */
function resultText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/**
 * The follow-up spine with per-turn agent-activity context. For each substantive
 * follow-up (opener + bare approvals excluded), gather the failed-tool categories
 * before it, an interrupt marker, the full agent activity in that window, and any
 * skill/subagent invocations. The positional alignment lets the model tell "user
 * re-prompted AFTER a test failure" from an unprompted nudge — never proof of
 * friction on its own.
 */
export function collectFollowups(session: Session): Followup[] {
  const turns = userTurnEvents(session)
  if (turns.length <= 1) return []

  // tool_use id → main-thread seq of the assistant message that issued it.
  const uidSeq = new Map<string, number>()
  for (const ev of session.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain || ev.seq == null) continue
    for (const b of ev.blocks) if (b.type === 'tool_use') uidSeq.set(b.id, ev.seq)
  }

  // One flat, seq-ordered activity stream: assistant prose (full) + tool calls.
  const activity: Activity[] = []
  for (const ev of session.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain || ev.seq == null) continue
    for (const b of ev.blocks) if (b.type === 'text' && b.text.trim()) activity.push({ seq: ev.seq, kind: 'text', text: b.text })
  }
  const errors: Array<{ seq: number; cat: string }> = []
  for (const t of session.toolCalls) {
    if (t.isSidechain) continue
    const seq = uidSeq.get(t.id)
    if (seq == null) continue
    const err = !t.result.ok ? resultText(t.result.raw) : ''
    if (!t.result.ok) errors.push({ seq, cat: classifyError(t.action, err.slice(0, 8000)) })
    activity.push({
      seq,
      kind: 'tool',
      action: t.action,
      header: toolHeader(t.action, t.target),
      ok: t.result.ok,
      error: err ? err.replace(/\s+/g, ' ').trim().slice(0, 500) : undefined,
      skill: skillName(t.action, t.target),
    })
  }
  activity.sort((a, b) => a.seq - b.seq)

  // Esc-interrupt markers: synthetic "user" events dropped from the real spine
  // (core/turns.ts) but still in the event stream — each is the user cutting the
  // agent off mid-action.
  const interrupts: number[] = []
  for (const ev of session.events) {
    if (ev.kind !== 'user' || ev.isSidechain || ev.seq == null) continue
    if (/^\[Request interrupted/i.test(stripReminders(ev.text))) interrupts.push(ev.seq)
  }

  const out: Followup[] = []
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i]!
    if (isApproval(t.text)) continue
    const prevSeq = turns[i - 1]!.seq ?? -1
    const seq = t.seq ?? Number.MAX_SAFE_INTEGER
    const win = activity.filter((a) => a.seq > prevSeq && a.seq < seq)
    const cats = errors.filter((e) => e.seq > prevSeq && e.seq < seq).map((e) => e.cat)
    const mark = interrupts.find((m) => m > prevSeq && m < seq)
    const skills = [...new Set(win.filter((a) => a.skill).map((a) => a.skill!))]
    out.push({
      text: t.text,
      seq: t.seq,
      ts: t.ts,
      errors: cats,
      activity: renderActivity(win),
      interrupted: mark != null ? directionAt(win, mark) : undefined,
      skills: skills.length ? skills : undefined,
    })
  }
  return out
}

/** A one-line header for a tool call: action + its primary target (path or command). */
function toolHeader(action: string, target: { paths?: string[]; command?: string }): string {
  const label: Record<string, string> = {
    file_write: 'Edit', file_read: 'Read', search: 'Search', shell: 'Bash',
    task_spawn: 'Subagent', mcp_call: 'MCP', skill: 'Skill', web: 'Web',
  }
  const name = label[action] ?? action
  // Keep a short command prefix (which command was run) but drop the long tail
  if (target.command) {
    const cmd = target.command.replace(/\s+/g, ' ').trim()
    return `${name}: ${cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd}`
  }
  if (target.paths?.length) return `${name} ${shortPath(target.paths[0]!)}${target.paths.length > 1 ? ` +${target.paths.length - 1}` : ''}`
  return name
}

// Head/tail budget for clipping far (non-final) assistant messages.
const FAR_MSG_HEAD = 500
const FAR_MSG_TAIL = 300

/**
 * Render one window's agent activity as assistant prose interleaved with tool-call
 * lines, in order. Tool results are omitted (a failure shows its trimmed error, a
 * success just its header). The LAST assistant message stays full (the user reacts to
 * it); earlier ones are clipped — only backdrop for the reaction.
 */
function renderActivity(win: Activity[]): string | undefined {
  if (!win.length) return undefined
  let lastTextIdx = -1
  for (let i = win.length - 1; i >= 0; i--) if (win[i]!.kind === 'text') { lastTextIdx = i; break }
  const lines = win.map((a, i) => {
    if (a.kind === 'text') return i === lastTextIdx ? a.text!.trim() : clipFar(a.text!.trim())
    if (a.ok === false) return `[tool] ${a.header}${a.error ? ` — FAILED: ${a.error}` : ' — FAILED'}`
    return `[tool] ${a.header}`
  })
  return lines.join('\n')
}

/** Head+tail clip for a far (non-final) assistant message: keep the framing, drop the middle. */
function clipFar(text: string): string {
  if (text.length <= FAR_MSG_HEAD + FAR_MSG_TAIL) return text
  return `${text.slice(0, FAR_MSG_HEAD)}\n… [${text.length - FAR_MSG_HEAD - FAR_MSG_TAIL} chars clipped] …\n${text.slice(-FAR_MSG_TAIL)}`
}

/** Name of the skill/subagent a tool call invoked, if any — the "bad skill" signal's raw material. */
function skillName(action: string, target: { paths?: string[]; command?: string }): string | undefined {
  if (action === 'skill') return target.command || target.paths?.[0]
  if (action === 'task_spawn') return target.command || 'subagent'
  return undefined
}

/** What the agent was doing right before an interrupt: its last action or statement in the window. */
function directionAt(win: Activity[], mark: number): string {
  const before = win.filter((a) => a.seq < mark)
  const last = before.at(-1)
  if (!last) return ''
  if (last.kind === 'tool') return `running ${last.header}`
  const s = last.text!.replace(/\s+/g, ' ').trim()
  return `saying: "${s.length > 200 ? '… ' + s.slice(-200) : s}"`
}

function shortPath(p: string): string {
  return p.split('/').slice(-2).join('/')
}

// Assistant "I can't do X" statements — the agent-limitation signal.
const LIMIT_RE =
  /\b(i can(?:no|')t\b|i cannot\b|i don'?t have (?:access|permission)|unable to (?:access|reach|run|connect)|not able to (?:access|reach|run)|you(?:'ll| will) need to (?:run|provide|paste))/i

export function limitationSnippets(s: Session, max = 5): string[] {
  const out: string[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain) continue
    for (const b of ev.blocks) {
      if (b.type !== 'text') continue
      const m = LIMIT_RE.exec(b.text)
      if (!m) continue
      const at = Math.max(0, m.index - 40)
      out.push(b.text.slice(at, m.index + 160).replace(/\s+/g, ' ').trim())
      if (out.length >= max) return out
    }
  }
  return out
}
