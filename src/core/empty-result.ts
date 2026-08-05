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

/** Actions whose payload is ALWAYS a retrieval result, whatever the tool is called. */
const RETRIEVAL_ACTIONS = new Set<CanonicalAction>(['search', 'web'])

/**
 * Shell binaries whose entire job is to find or list, so printing nothing means
 * "no matches" rather than "it worked".
 *
 * Shell used to be excluded wholesale, because for most of it silence IS success —
 * `git push` says nothing when it works. But a `grep` that matches nothing is the
 * exact silent-failure-then-retry this stat exists to catch, and since each call's
 * binaries are now parsed at ingest, the question can be asked per binary.
 */
const RETRIEVAL_BINARIES = new Set([
  'ack', 'ag', 'egrep', 'fd', 'fgrep', 'find', 'fgrep', 'grep', 'locate', 'ls', 'rg',
])

/**
 * MCP tool-name verbs that read rather than write.
 *
 * A server is a mix — `searchJiraIssuesUsingJql` retrieves, `createJiraIssue` does
 * not — so this cannot be decided at the server level. Judging there puts writes in
 * the denominator and reads their empty acknowledgement as a failed retrieval.
 *
 * An allowlist, not a blocklist: an unrecognised verb is left out. Consistent with
 * the rest of this module, a miss is cheaper than accusing a working tool.
 */
const MCP_READ_VERBS = new Set([
  'browse', 'describe', 'fetch', 'find', 'get', 'list', 'lookup', 'query', 'read', 'search', 'show', 'view',
])

/** The leading verb of `getJiraIssue` / `search_issues` — camelCase and snake_case alike. */
function leadingVerb(tool: string): string {
  return /^[a-z]+/.exec(tool)?.[0] ?? ''
}

/** The tool half of `mcp__<server>__<tool>`, or '' when the name isn't that shape. */
function mcpToolName(name: string): string {
  if (!name.startsWith('mcp__')) return ''
  const sep = name.indexOf('__', 5)
  return sep > 5 ? name.slice(sep + 2) : ''
}

/**
 * Is "nothing came back" meaningful for this call?
 *
 * `binaries` is the parsed binary list for a shell call, ignored otherwise. A call
 * that ran more than one is excluded: the payload is the whole chain's, so silence
 * can't be pinned on the search. `grep foo | head` printing nothing might be either
 * of them, and `grep foo && ./deploy` says nothing about grep at all.
 */
export function isRetrievalCall(action: CanonicalAction, name: string, binaries: readonly string[] = []): boolean {
  if (RETRIEVAL_ACTIONS.has(action)) return true
  if (action === 'mcp_call') return MCP_READ_VERBS.has(leadingVerb(mcpToolName(name)))
  if (action === 'shell') return binaries.length === 1 && RETRIEVAL_BINARIES.has(binaries[0] as string)
  return false
}

/**
 * Past this, a payload plainly carried content — a check that keeps the phrase
 * patterns below from ever firing on a real result that discusses its own misses.
 */
const MAX_EMPTY_LEN = 200

/** A payload that is nothing at all: an empty container, or a literal null. */
const EMPTY_CONTAINER = /^(?:\[\s*\]|\{\s*\}|null|none|n\/a)$/i

// Claude Code's "(Bash completed with no output)" is NOT decoded here. It only ever
// rides alongside a toolUseResult envelope, and the adapter prefers that envelope, so
// the string never reaches this module — `resultText` reads the envelope's empty
// stdout as empty output instead. A harness that genuinely sent such a note as its
// whole payload would be normalizing its own convention, which belongs in its adapter,
// not in shared core.

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
export function emptyResultFlag(
  action: CanonicalAction,
  name: string,
  ok: boolean,
  text: string,
  binaries: readonly string[] = [],
): 0 | 1 | null {
  if (!ok || !isRetrievalCall(action, name, binaries)) return null
  const t = text.trim()
  if (!t) return 1
  if (t.length > MAX_EMPTY_LEN) return 0
  return EMPTY_CONTAINER.test(t) || NOTHING_FOUND.test(t) ? 1 : 0
}
