import { describe, expect, it } from 'vitest'
import { emptyResultFlag, isRetrievalAction } from './empty-result'

describe('isRetrievalAction', () => {
  it('covers exactly the retrieval-shaped actions', () => {
    expect(['search', 'web', 'mcp_call'].map((a) => isRetrievalAction(a as never))).toEqual([true, true, true])
    expect(['shell', 'file_read', 'file_write', 'task_spawn', 'todo', 'skill', 'other'].map((a) => isRetrievalAction(a as never))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('emptyResultFlag — applicability', () => {
  it('is null for non-retrieval actions: empty shell/write output IS success', () => {
    expect(emptyResultFlag('shell', true, '')).toBeNull()
    expect(emptyResultFlag('file_write', true, '')).toBeNull()
    expect(emptyResultFlag('file_read', true, '')).toBeNull()
  })

  it('is null for a failed call — a loud failure is already counted as an error', () => {
    expect(emptyResultFlag('search', false, '')).toBeNull()
    expect(emptyResultFlag('mcp_call', false, 'MCP error: transport closed')).toBeNull()
  })
})

describe('emptyResultFlag — the heuristic', () => {
  it('flags a literally empty payload', () => {
    expect(emptyResultFlag('search', true, '')).toBe(1)
    expect(emptyResultFlag('search', true, '   \n ')).toBe(1)
  })

  it('flags empty JSON containers', () => {
    expect(emptyResultFlag('mcp_call', true, '[]')).toBe(1)
    expect(emptyResultFlag('mcp_call', true, '{ }')).toBe(1)
    expect(emptyResultFlag('mcp_call', true, 'null')).toBe(1)
  })

  it('flags the common "nothing matched" phrasings', () => {
    expect(emptyResultFlag('search', true, 'No matches found')).toBe(1)
    expect(emptyResultFlag('search', true, 'No files found')).toBe(1)
    expect(emptyResultFlag('web', true, 'No results found for "tuneloop xyzzy"')).toBe(1)
    expect(emptyResultFlag('mcp_call', true, 'Found 0 issues')).toBe(1)
  })

  it('does not flag a payload that actually carried something', () => {
    expect(emptyResultFlag('search', true, 'src/a.ts:12: const x = 1')).toBe(0)
    expect(emptyResultFlag('mcp_call', true, '[{"id":1}]')).toBe(0)
    expect(emptyResultFlag('web', true, 'No results found for the first query, but here are 12 others...')).toBe(0)
  })

  it('is conservative: a long payload mentioning "no results" is not empty', () => {
    const long = `Found 12 matching files\n${'x'.repeat(400)}\nno results for the second pattern`
    expect(emptyResultFlag('search', true, long)).toBe(0)
  })
})
