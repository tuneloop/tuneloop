import { describe, expect, it } from 'vitest'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import { openDb } from './db'
import { Store } from './store'

// A session split into two blocks: block 0 opens on the first user turn and ends
// on a git commit; block 1 opens on the second user turn and runs to session end.
function twoBlockSession(): Session {
  const events: Event[] = [
    { kind: 'user', text: 'fix the login bug', blocks: [], isSidechain: false, seq: 0 },
    {
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'git commit -m x' } }],
      usage: emptyUsage(),
      isSidechain: false,
      seq: 1,
    },
    { kind: 'user', text: 'add a CSV export button', blocks: [], isSidechain: false, seq: 2 },
    {
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'export.ts' } }],
      usage: emptyUsage(),
      isSidechain: false,
      seq: 3,
    },
  ]
  const toolCalls: ToolCall[] = [
    { id: 't0', name: 'Bash', action: 'shell' as CanonicalAction, input: {}, target: { command: 'git commit -m x' }, result: { ok: true, isError: false }, isSidechain: false },
    { id: 't1', name: 'Write', action: 'file_write' as CanonicalAction, input: {}, target: { paths: ['export.ts'] }, result: { ok: true, isError: false }, isSidechain: false },
  ]
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' },
    models: ['claude-haiku-4-5'],
    tokens: emptyUsage(),
    events,
    toolCalls,
    raw: { path: '', contentHash: 'h' },
  }
}

describe('Store.blockDigest', () => {
  it('returns a numbered digest with each block opener and boundary tag', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const session = twoBlockSession()
    store.ingestSession(session, 0, [], 'test', 1)

    const result = store.blockDigest(session.id)
    expect(result).not.toBeNull()
    const lines = result!.digest.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[0]')
    expect(lines[0]).toContain('fix the login bug')
    expect(lines[0]).toContain('git commit')
    expect(lines[1]).toContain('[1]')
    expect(lines[1]).toContain('add a CSV export button')
    expect(lines[1]).toContain('file write')
    // The partition rides along: 2 blocks, block 1 opens at seq 2.
    expect(result!.blocks).toHaveLength(2)
    expect(result!.blocks[1]!.startSeq).toBe(2)
  })

  it('returns null when the session blob is missing', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    expect(store.blockDigest('nope')).toBeNull()
  })
})
