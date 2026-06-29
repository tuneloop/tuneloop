/**
 * Cross-harness fingerprinting of failed tool calls into a small, fixed taxonomy.
 *
 * One shared, deterministic classifier runs over the NORMALIZED error text (the
 * same `result.raw` the transcript viewer reads) so Codex / Claude / OpenCode
 * errors land in the SAME categories — the whole point is harness-agnostic error
 * analytics. The error STRINGS are vendor-specific (e.g. "File has not been read
 * yet" is Claude's phrasing); the classifier folds each vendor's phrasings into a
 * shared category. As new harnesses appear, add their phrasings to existing
 * buckets, not new categories.
 *
 * Deterministic (regex), not LLM: these strings are highly patterned, a regex
 * pass classifies ~96% of real errors, the result must be stable across
 * re-ingest (it drives a filter/breakdown facet), and it is computed at ingest
 * for EVERY session — with no LLM key required. Re-ingest is gated by
 * NORMALIZE_VERSION (core/blocks.ts): bump it to re-fingerprint all harnesses.
 *
 * `other` is the deliberate catch-all (errored but unrecognized).
 */
import type { CanonicalAction } from './model'

export interface ErrorCategorySpec {
  key: string
  label: string
  /** One-line tooltip shown next to the category in the UI. */
  description: string
}

/**
 * The frozen taxonomy: each category's label + tooltip description. This array's
 * order is DISPLAY order (it drives the /api/error-categories response), NOT match
 * precedence — precedence is the order the regexes are tested in classifyError
 * below. Keep `other` last as the catch-all.
 */
export const ERROR_CATEGORIES: ErrorCategorySpec[] = [
  {
    key: 'precondition',
    label: 'Precondition',
    description: "The tool's preconditions weren't met - e.g. editing a file before reading it, or the file changed since it was read.",
  },
  {
    key: 'not_found',
    label: 'Not found',
    description: "A referenced file, path, or resource didn't exist (ENOENT, 404, 'not found').",
  },
  {
    key: 'permission',
    label: 'Permission',
    description: 'The filesystem or OS denied access (EACCES, permission denied).',
  },
  {
    key: 'policy_blocked',
    label: 'Policy blocked',
    description: 'The host harness blocked the action - approval required, sandbox policy, or a denied/blocked command.',
  },
  {
    key: 'user_rejected',
    label: 'User declined',
    description: 'The user declined an approval prompt - the tool never ran (e.g. "User rejected tool use").',
  },
  {
    key: 'auth',
    label: 'Auth',
    description: 'Authentication or credentials failed - invalid/expired token, 401, bad credentials.',
  },
  {
    key: 'conflict',
    label: 'VCS conflict',
    description: 'A version-control conflict - merge conflict, non-fast-forward, rejected push.',
  },
  {
    key: 'test_failure',
    label: 'Test failure',
    description: 'A test run reported failures or assertion errors.',
  },
  {
    key: 'compile_error',
    label: 'Compile error',
    description: 'Code failed to compile or type-check - syntax errors, missing modules, type errors.',
  },
  {
    key: 'invalid_call',
    label: 'Invalid call',
    description: 'The tool was called incorrectly - unknown tool/skill, bad arguments, or invalid options.',
  },
  {
    key: 'schema_validation',
    label: 'Schema validation',
    description: "A tool's structured output failed schema validation - a required field was missing or mistyped.",
  },
  {
    key: 'network',
    label: 'Network',
    description: 'A network problem - connection refused, DNS failure, fetch failed.',
  },
  {
    key: 'timeout',
    label: 'Timeout',
    description: 'The operation exceeded its time limit.',
  },
  {
    key: 'rate_limit',
    label: 'Rate limit',
    description: 'A provider rate limit or quota was hit (429, too many requests).',
  },
  {
    key: 'too_large',
    label: 'Too large',
    description: "Input or output exceeded the tool's size limit.",
  },
  {
    key: 'interrupted',
    label: 'Interrupted',
    description: 'The call was cancelled, aborted, or killed before finishing.',
  },
  {
    key: 'integration_error',
    label: 'Integration error',
    description: 'An external tool or MCP server failed to respond or errored at the transport level.',
  },
  {
    key: 'command_failed',
    label: 'Command failed',
    description: 'A shell command exited non-zero with no more specific cause detected.',
  },
  {
    key: 'other',
    label: 'Other',
    description: "Errored, but didn't match a known category.",
  },
]

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]['key']

/**
 * Map a failed tool call's normalized error text to one category. The regexes are
 * tested top-to-bottom and the FIRST match wins, so their order here IS the match
 * precedence: specific / agent-behaviour categories first, the broad
 * `command_failed` shell fallback last. Returns `other` when nothing matches
 * (incl. empty text).
 */
export function classifyError(_action: CanonicalAction, text: string): ErrorCategory {
  const t = (text || '').toLowerCase()
  if (!t.trim()) return 'other'

  // User declined an approval prompt — a deliberate user choice, not a tool
  // failure, and the single most common "error" shape in real transcripts. Must
  // come FIRST: the harness phrasings contain the bare word "rejected", which
  // would otherwise be swept into the VCS `conflict` bucket below. Claude:
  // "User rejected tool use" / "doesn't want to proceed". Codex frames a denied
  // approval as `CreateProcess { message: "Rejected("rejected by user")" }`.
  if (/user rejected|doesn'?t want to proceed|tool use was rejected|rejected by user|rejected\("/.test(t)) return 'user_rejected'
  // Agent-workflow precondition (read-before-write, stale file) — the biggest real
  // bucket, so it goes first.
  if (/has not been read yet|modified since read|read it again|read it first|must read|before (?:editing|writing|attempting)|oldstring|must match exactly/.test(t)) return 'precondition'
  // Host policy / approval gating (distinct from a filesystem permission error).
  if (/permission to use .* has been denied|don'?t ask mode|\bblocked:|requires approval|approval (?:required|denied)|not allowed by|operation not permitted by/.test(t)) return 'policy_blocked'
  // Input/output exceeded a tool size limit. (Bare "too long" is omitted — it
  // collides with "took too long" timeouts; "argument list too long" is kept.)
  if (/exceeds (?:the )?maximum|maximum allowed tokens|too large|output too large|argument list too long/.test(t)) return 'too_large'
  // Structured output that failed its schema (ajv-style "must have required
  // property" / "does not match required schema"). Distinct from invalid_call: the
  // OUTPUT is malformed, not the call. Before invalid_call so it wins outright.
  if (/does not match (?:the )?required schema|must have required property|failed schema validation/.test(t)) return 'schema_validation'
  // Bad invocation: unknown tool/skill, invalid arguments/options. Also the
  // schema-checked INPUT failures (zod-style InputValidationError, unparseable
  // JSON args) and EISDIR — a directory handed to a file tool — which are all
  // "the tool was called wrong."
  if (/unknown skill|no such tool|tool not found|no such tool available|unknown command|unrecognized|no such option|invalid (?:argument|option|flag)|missing required|bad pattern|invalid regular expression|usage:|inputvalidationerror|json parse failed|invalid_type|\beisdir\b|illegal operation on a directory/.test(t)) return 'invalid_call'
  // External tool / MCP transport failure.
  if (/tool call (?:error|failed)|transport (?:send )?error|mcp error|server error/.test(t)) return 'integration_error'
  // `cannot find` excludes module/name — those are compile/dependency errors
  // (handled by compile_error below), not a missing file/path.
  if (/enoent|no such file|does not exist|cannot find (?!module|name)|file not found|\bnot found\b|404/.test(t)) return 'not_found'
  if (/eacces|permission denied|operation not permitted|\bforbidden\b|403/.test(t)) return 'permission'
  if (/401|unauthorized|bad credentials|authentication|token (?:expired|invalid)|not logged in|requires authentication/.test(t)) return 'auth'
  if (/429|rate limit|quota|too many requests/.test(t)) return 'rate_limit'
  if (/timed out|timeout|etimedout|deadline exceeded|context deadline/.test(t)) return 'timeout'
  if (/econnrefused|connection refused|enotfound|getaddrinfo|fetch failed|\bdns\b|socket hang up|econnreset|\bnetwork\b/.test(t)) return 'network'
  // VCS conflict — anchored to real git output. Bare `conflict`/`rejected` are
  // deliberately avoided: they hijacked unrelated text (e.g. "User rejected tool
  // use"). Git's push rejection prints `! [rejected]` / "Updates were rejected".
  if (/merge conflict|non-fast-forward|failed to push|diverged|\[rejected\]|updates were rejected/.test(t)) return 'conflict'
  if (/\d+ (?:failed|failing)|test(?:s)? failed|assertionerror|expect\(|✕/.test(t)) return 'test_failure'
  if (/syntaxerror|cannot find (?:module|name)|ts\d{3,4}\b|error ts|type error|is not assignable|compilation|unexpected token|parse error/.test(t)) return 'compile_error'
  if (/sigint|\bcancel|aborted|interrupted|\bkilled\b/.test(t)) return 'interrupted'
  // Generic shell non-zero exit with no recognized cause — the honest fallback.
  if (/exit code|exited with code|process exited|exit status|non-zero/.test(t)) return 'command_failed'
  return 'other'
}
