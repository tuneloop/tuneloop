/**
 * Helpers for telling a REAL human turn from the machinery Claude Code injects as
 * "user" messages. Several features need this distinction: the session digest
 * (so autonomy/intent aren't skewed by slash-command echoes) and the
 * Files-changed view (so an edit links to the prompt that actually caused it).
 */

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
