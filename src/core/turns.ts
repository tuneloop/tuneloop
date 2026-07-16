/**
 * Helpers for telling a REAL human turn from the machinery Claude Code injects as
 * "user" messages. Several features need this distinction: the session digest
 * (so autonomy/intent aren't skewed by slash-command echoes) and the
 * Files-changed view (so an edit links to the prompt that actually caused it).
 *
 * Also home to the turn-spine helpers (userTurns / followupTurns / isApproval)
 * shared by the steering processor and the recurring-themes detector — one
 * definition of "substantive follow-up" so the deterministic count and the LLM
 * prompt can never disagree.
 */

import type { Session } from './model'

// Claude-injected "user" turns that aren't the human's intent: slash-command
// echoes and their args/output (`<command-name>`, `<command-args>`,
// `<local-command-stdout>`, `<local-command-caveat>`, …), the local-command
// caveat preamble, skill preambles, interrupts, and tool rejections. The command
// tags are matched generically (`<…command-*>`, opening or closing) so a new tag
// variant doesn't silently leak through as a real prompt.
export const SYNTHETIC_USER_RE =
  /^Caveat: The messages below|^Base directory for this skill:|^\[Request interrupted|<\/?(local-)?command-[a-z]+>|The user doesn't want to proceed with this tool use/i

export function isSyntheticUser(text: string): boolean {
  return SYNTHETIC_USER_RE.test(text)
}

/** Strip injected <system-reminder> blocks (and the trailing space they leave). */
export function stripReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** True when a "user" event is a genuine human prompt (not injected machinery). */
export function isRealUserText(text: string): boolean {
  const t = stripReminders(text)
  return !!t && !isSyntheticUser(t)
}

/**
 * The session's first REAL human turn, in full — the fallback session title
 * when neither the adapter nor LLM enrichment supplied one. Skips sidechain and
 * injected/machinery turns and collapses whitespace to a single line, but does
 * NOT clip: length-trimming + ellipsis are a presentation concern (see the
 * client `clipLine` helper). Null when the session has no genuine human prompt.
 */
export function firstUserPrompt(s: Session): string | null {
  for (const ev of s.events) {
    if (ev.kind !== 'user' || ev.isSidechain) continue
    const t = stripReminders(ev.text)
    if (!t || isSyntheticUser(t)) continue
    const clean = t.replace(/\s+/g, ' ').trim()
    if (clean) return clean
  }
  return null
}

/**
 * All main-thread human turns, in order. Excludes sidechain (subagent) turns,
 * strips injected reminders, and drops Claude-injected pseudo-user turns —
 * slash-command echoes, local-command caveats/stdout, interrupts, tool
 * rejections. Those are machinery, not the human steering the agent; counting
 * them skews the opener (the first REAL prompt) and the steering signal.
 */
export function userTurns(s: Session): string[] {
  return userTurnEvents(s).map((t) => t.text)
}

/** A real human turn plus its main-thread seq — the evidence pointer theme events persist. */
export interface UserTurn {
  text: string
  seq?: number
}

/** Same filter as userTurns, but keeps each turn's seq (see UserTurn). */
export function userTurnEvents(s: Session): UserTurn[] {
  const out: UserTurn[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'user' || ev.isSidechain) continue
    const t = stripReminders(ev.text)
    if (t && !isSyntheticUser(t)) out.push({ text: t, seq: ev.seq })
  }
  return out
}

/**
 * Substantive follow-up turns: the user turns AFTER the opening request, minus
 * bare approvals/continuations ("yes", "continue"). This is a CEILING on
 * steering, not steering itself — a follow-up may be genuine direction
 * ("use Postgres instead") or mere workflow progression ("commit and open a PR",
 * "mark it done"), and only a model can tell those apart from the text. The
 * count feeds the deterministic `followup_count` annotation (steering processor)
 * and the recurring-themes pre-gate. Deliberately conservative: only whole-turn
 * known approvals are dropped, so nothing substantive is hidden.
 */
export function followupTurns(turns: string[]): string[] {
  return turns.slice(1).filter((t) => !isApproval(t))
}

/** A short, content-free affirmation/continuation ("yes", "ok continue") that lets the agent proceed rather than redirecting it. */
export function isApproval(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return true
  if (t.split(' ').length > 6) return false // too long to be a bare approval
  return APPROVAL_RE.test(t)
}

// Whole-turn approval/continuation phrases (matched against punctuation-stripped,
// lowercased text). Kept conservative — when unsure, a turn counts as steering.
const APPROVAL_RE =
  /^(y|yes|yep|yup|yeah|ya|ok|okay|k|kk|sure|fine|cool|great|perfect|nice|good|awesome|excellent|thanks|thank you|thanks a lot|thank you so much|ty|thx|continue|please continue|proceed|go|go ahead|go for it|go on|do it|do that|keep going|carry on|next|lgtm|looks good|looks great|that works|sounds good|ship it|approved|correct|right|exactly|agreed|got it|makes sense|yes please|ok thanks|perfect thanks|great thanks|yes continue|ok continue|ok go ahead|sure go ahead)$/
