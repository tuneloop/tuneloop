/**
 * Helpers for telling a REAL human turn from the machinery Claude Code injects as
 * "user" messages. Several features need this distinction: the session digest
 * (so autonomy/intent aren't skewed by slash-command echoes) and the
 * Files-changed view (so an edit links to the prompt that actually caused it).
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
