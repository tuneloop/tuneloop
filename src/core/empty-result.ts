/**
 * Did a retrieval call come back with nothing?
 *
 * Error rate measures LOUD failure. The silent mass is a call that succeeded and
 * returned nothing — a bad query, a wrong path, a filter that matched no rows —
 * after which the agent quietly retries. Those calls carry `is_error = 0` and are
 * invisible in every existing stat, so this is a second, separate signal: it is
 * never folded into error rate (see docs/plans/mcp-agent-tools-tab.md).
 *
 * Applies ONLY to retrieval-shaped actions. For a write or a shell command,
 * silence IS success (`git push` printing nothing means it worked), so flagging
 * those would turn healthy calls into a fake problem — hence `null`, not `0`:
 * "not applicable", so the rate's denominator is only calls where emptiness means
 * something.
 *
 * Deliberately conservative. A false "empty" is worse than a miss here: it would
 * accuse a working tool. So only a payload that is ENTIRELY a nothing-shape
 * counts — never a long result that merely mentions "no results" somewhere.
 *
 * Computed at ingest, so it is gated by NORMALIZE_VERSION (core/blocks.ts) —
 * bump it to re-derive across every harness.
 */
import type { CanonicalAction } from './model'

/** Actions whose result is a retrieval payload, where "nothing came back" is a signal. */
const RETRIEVAL_ACTIONS = new Set<CanonicalAction>(['search', 'web', 'mcp_call'])

export function isRetrievalAction(action: CanonicalAction): boolean {
  return RETRIEVAL_ACTIONS.has(action)
}

/**
 * Past this, a payload plainly carried content — a check that keeps the phrase
 * patterns below from ever firing on a real result that discusses its own misses.
 */
const MAX_EMPTY_LEN = 200

/** A payload that is nothing at all: an empty container, or a literal null. */
const EMPTY_CONTAINER = /^(?:\[\s*\]|\{\s*\}|null|none|n\/a)$/i

/**
 * The whole payload is one clause reporting that nothing matched. Anchored at
 * both ends and comma-free on purpose: "No results found for the first query,
 * but here are 12 others" is a RESULT, and must not match.
 */
const NOTHING_FOUND =
  /^(?:no|found\s+0|0)\b[^,\n]*\b(?:match|matches|result|results|file|files|item|items|entr(?:y|ies)|record|records|row|rows|hit|hits|issue|issues|document|documents|page|pages)\b[^,\n]*$/i

/**
 * `1` empty / `0` non-empty / `null` not applicable — a non-retrieval action, or
 * a failed call (already counted as an error; counting it twice would make the
 * two stats overlap).
 */
export function emptyResultFlag(action: CanonicalAction, ok: boolean, text: string): 0 | 1 | null {
  if (!ok || !isRetrievalAction(action)) return null
  const t = text.trim()
  if (!t) return 1
  if (t.length > MAX_EMPTY_LEN) return 0
  return EMPTY_CONTAINER.test(t) || NOTHING_FOUND.test(t) ? 1 : 0
}
