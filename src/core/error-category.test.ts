import { describe, expect, it } from 'vitest'
import { classifyError, ERROR_CATEGORIES } from './error-category'

// Representative real error strings (drawn from actual Codex + Claude transcripts)
// pinned to their category, so a regex change that misroutes a known shape fails.
const CASES: Array<[string, string]> = [
  ['Error: File has not been read yet. Read it first before writing to it.', 'precondition'],
  ['Error: File has been modified since read, either by the user or by a linter.', 'precondition'],
  ['Error: ENOENT: no such file or directory, open \'/tmp/x\'', 'not_found'],
  ['fatal: pathspec did not match any files; resource not found (404)', 'not_found'],
  ['EACCES: permission denied, open \'/etc/hosts\'', 'permission'],
  ['Error: Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.', 'policy_blocked'],
  ['Error: Blocked: sleep 45 followed by tail -40. To wait for a condition, use Monitor.', 'policy_blocked'],
  ['HTTP 401 Unauthorized: bad credentials, your token may be expired', 'auth'],
  ['error: failed to push some refs; merge conflict in src/app.ts (non-fast-forward)', 'conflict'],
  ['Test Suites: 1 failed, 2 passed; 3 failing tests; AssertionError: expected true', 'test_failure'],
  ['src/x.ts(12,3): error TS2345: Argument of type string is not assignable', 'compile_error'],
  // Precedence locks: `cannot find module/name` must beat not_found's broad `cannot find`.
  ["Error: Cannot find module 'react'", 'compile_error'],
  ["error TS2304: Cannot find name 'foo'", 'compile_error'],
  // `argument list too long` is a size error; bare `too long` must NOT hijack timeouts.
  ['/bin/sh: argument list too long', 'too_large'],
  ['the request took too long to complete', 'other'],
  ['Error: Unknown skill: frontend-design', 'invalid_call'],
  ['Error: No such tool available: invoke', 'invalid_call'],
  ['fetch failed: getaddrinfo ENOTFOUND api.example.com (ECONNREFUSED)', 'network'],
  ['Error: operation timed out after 60s (ETIMEDOUT)', 'timeout'],
  ['HTTP 429: rate limit exceeded, too many requests', 'rate_limit'],
  ['Error: File content (37650 tokens) exceeds maximum allowed tokens (25000).', 'too_large'],
  ['The request was aborted: the user interrupted the call (SIGINT)', 'interrupted'],
  ['tool call error: tool call failed for `github/merge_pull_request` — Transport send error', 'integration_error'],
  ['Process exited with code 1', 'command_failed'],
  ['something weird that no rule recognizes', 'other'],
  ['', 'other'],
]

describe('classifyError', () => {
  it.each(CASES)('classifies %j as %s', (text, expected) => {
    expect(classifyError('shell', text)).toBe(expected)
  })

  it('only ever returns keys from the taxonomy', () => {
    const keys = new Set(ERROR_CATEGORIES.map((c) => c.key))
    for (const [text] of CASES) expect(keys.has(classifyError('shell', text))).toBe(true)
  })

  it('every category has a non-empty tooltip description', () => {
    for (const c of ERROR_CATEGORIES) expect(c.description.trim().length).toBeGreaterThan(0)
  })
})
