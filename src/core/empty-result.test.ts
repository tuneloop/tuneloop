import { describe, expect, it } from 'vitest'
import { emptyResultFlag, isRetrievalCall } from './empty-result'

/** The MCP call shape the flag is asked about, spelled out for readability. */
const mcp = (tool: string) => `mcp__atlassian__${tool}`

describe('isRetrievalCall — whole-action retrieval', () => {
  it('covers the actions whose payload IS a retrieval result', () => {
    expect(isRetrievalCall('search', 'Grep')).toBe(true)
    expect(isRetrievalCall('web', 'WebSearch')).toBe(true)
  })

  it('excludes actions where an empty result means success', () => {
    for (const a of ['file_read', 'file_write', 'task_spawn', 'todo', 'skill', 'other'])
      expect(isRetrievalCall(a as never, 'x')).toBe(false)
  })
})

/**
 * A server is a mix: searchJiraIssuesUsingJql retrieves, createJiraIssue does not,
 * and an empty ack from the latter means it worked. Judging at the server level
 * puts writes in the denominator and calls their success an empty result.
 */
describe('isRetrievalCall — MCP is decided per tool, not per server', () => {
  it('counts the read verbs', () => {
    for (const t of ['getJiraIssue', 'searchJiraIssuesUsingJql', 'listPages', 'findUser', 'readPage', 'fetchThing', 'queryRows', 'lookupJiraAccountId'])
      expect(isRetrievalCall('mcp_call', mcp(t))).toBe(true)
  })

  it('excludes the write verbs on the same server', () => {
    for (const t of ['createJiraIssue', 'editJiraIssue', 'addCommentToJiraIssue', 'transitionJiraIssue', 'deleteThing', 'updateConfluencePage'])
      expect(isRetrievalCall('mcp_call', mcp(t))).toBe(false)
  })

  it('excludes verbs it does not recognise, rather than guessing', () => {
    expect(isRetrievalCall('mcp_call', mcp('frobnicate'))).toBe(false)
    expect(isRetrievalCall('mcp_call', 'malformed-name')).toBe(false)
  })

  it('reads the verb through snake_case too', () => {
    expect(isRetrievalCall('mcp_call', mcp('search_issues'))).toBe(true)
    expect(isRetrievalCall('mcp_call', mcp('create_issue'))).toBe(false)
  })
})

/**
 * A grep that matches nothing is the exact silent-failure-then-retry this stat
 * exists for. It was excluded only because the rule keyed on action, and every
 * shell call shared one bucket with `git push`, where silence means success.
 */
describe('isRetrievalCall — shell, by the binary it ran', () => {
  it('counts a call that ran exactly one search-or-list binary', () => {
    for (const b of ['grep', 'rg', 'find', 'ls', 'fd', 'ag'])
      expect(isRetrievalCall('shell', 'Bash', [b])).toBe(true)
  })

  it('excludes binaries where empty output is success', () => {
    for (const b of ['git', 'npm', 'mkdir', 'echo', 'tsc'])
      expect(isRetrievalCall('shell', 'Bash', [b])).toBe(false)
  })

  /**
   * A chain emits one blended payload, so silence can't be pinned on the search:
   * `grep foo | head` printing nothing might be grep finding none, and
   * `grep foo && ./deploy` printing nothing says nothing about grep at all.
   */
  it('excludes compound calls, where the output belongs to the whole chain', () => {
    expect(isRetrievalCall('shell', 'Bash', ['grep', 'head'])).toBe(false)
    expect(isRetrievalCall('shell', 'Bash', ['grep', 'deploy.sh'])).toBe(false)
    expect(isRetrievalCall('shell', 'Bash', [])).toBe(false)
  })
})

describe('emptyResultFlag — applicability', () => {
  it('is null where emptiness carries no meaning', () => {
    expect(emptyResultFlag('shell', 'Bash', true, '', ['git'])).toBeNull()
    expect(emptyResultFlag('file_write', 'Edit', true, '')).toBeNull()
    expect(emptyResultFlag('file_read', 'Read', true, '')).toBeNull()
    expect(emptyResultFlag('mcp_call', mcp('createJiraIssue'), true, '')).toBeNull()
  })

  it('is null for a failed call — a loud failure is already counted as an error', () => {
    expect(emptyResultFlag('search', 'Grep', false, '')).toBeNull()
    expect(emptyResultFlag('mcp_call', mcp('getJiraIssue'), false, 'MCP error: transport closed')).toBeNull()
  })

  it('measures a lone grep, and ignores the same grep inside a chain', () => {
    expect(emptyResultFlag('shell', 'Bash', true, '', ['grep'])).toBe(1)
    expect(emptyResultFlag('shell', 'Bash', true, 'src/a.ts:12: x', ['grep'])).toBe(0)
    expect(emptyResultFlag('shell', 'Bash', true, '', ['grep', 'head'])).toBeNull()
  })
})

describe('emptyResultFlag — the heuristic', () => {
  it('flags a literally empty payload', () => {
    expect(emptyResultFlag('search', 'Grep', true, '')).toBe(1)
    expect(emptyResultFlag('search', 'Grep', true, '   \n ')).toBe(1)
  })

  it('flags empty JSON containers', () => {
    expect(emptyResultFlag('mcp_call', mcp('getJiraIssue'), true, '[]')).toBe(1)
    expect(emptyResultFlag('mcp_call', mcp('getJiraIssue'), true, '{ }')).toBe(1)
    expect(emptyResultFlag('mcp_call', mcp('getJiraIssue'), true, 'null')).toBe(1)
  })

  it('flags the common "nothing matched" phrasings', () => {
    expect(emptyResultFlag('search', 'Grep', true, 'No matches found')).toBe(1)
    expect(emptyResultFlag('search', 'Grep', true, 'No files found')).toBe(1)
    expect(emptyResultFlag('web', 'WebSearch', true, 'No results found for "tuneloop xyzzy"')).toBe(1)
    expect(emptyResultFlag('mcp_call', mcp('searchJiraIssuesUsingJql'), true, 'Found 0 issues')).toBe(1)
  })

  it('does not flag a payload that actually carried something', () => {
    expect(emptyResultFlag('search', 'Grep', true, 'src/a.ts:12: const x = 1')).toBe(0)
    expect(emptyResultFlag('mcp_call', mcp('getJiraIssue'), true, '[{"id":1}]')).toBe(0)
    expect(emptyResultFlag('web', 'WebSearch', true, 'No results found for the first query, but here are 12 others...')).toBe(0)
  })

  it('is conservative: a long payload mentioning "no results" is not empty', () => {
    const long = `Found 12 matching files\n${'x'.repeat(400)}\nno results for the second pattern`
    expect(emptyResultFlag('search', 'Grep', true, long)).toBe(0)
  })
})
