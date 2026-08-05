import { describe, expect, it } from 'vitest'
import { emptyUsage, type Session, type ToolCall } from '../core/model'
import { openDb, type DB } from './db'
import { Store } from './store'

function session(toolCalls: ToolCall[], contentHash = 'h'): Session {
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' },
    models: ['claude-haiku-4-5'],
    tokens: emptyUsage(),
    events: [],
    toolCalls,
    raw: { path: '', contentHash },
  }
}

function shell(id: string, command: string): ToolCall {
  return {
    id,
    name: 'Bash',
    action: 'shell',
    input: { command },
    target: { command },
    result: { ok: true, isError: false, raw: '' },
    isSidechain: false,
  }
}

const commands = (db: DB) =>
  db.prepare('SELECT idx, seq, binary FROM tool_call_commands ORDER BY idx, seq').all() as Array<{
    idx: number
    seq: number
    binary: string
  }>

describe('ingest: tool_call_commands (AL-139)', () => {
  it('writes one ordered row per meaningful binary in a shell call', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(session([shell('t0', 'cd /repo && npm run build | tee build.log')]), 0, [], 'test', 1)

    expect(commands(db)).toEqual([
      { idx: 0, seq: 0, binary: 'npm' },
      { idx: 0, seq: 1, binary: 'tee' },
    ])
  })

  it('indexes rows by the tool call they came from, skipping non-shell calls', () => {
    const db = openDb(':memory:')
    const read: ToolCall = {
      id: 't0',
      name: 'Read',
      action: 'file_read',
      input: {},
      target: { paths: ['a.ts'] },
      result: { ok: true, isError: false },
      isSidechain: false,
    }
    new Store(db).ingestSession(session([read, shell('t1', 'git status')]), 0, [], 'test', 1)

    // idx 1, not 0: the FK is (session_id, idx) → tool_calls, so the index must be
    // the tool call's own, not a running count of shell calls.
    expect(commands(db)).toEqual([{ idx: 1, seq: 0, binary: 'git' }])
  })

  it('writes nothing for a shell call with no meaningful binary', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(session([shell('t0', 'cd /repo')]), 0, [], 'test', 1)
    expect(commands(db)).toEqual([])
  })

  it('rewrites a session\'s rows on re-ingest instead of appending', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.ingestSession(session([shell('t0', 'git status')]), 0, [], 'test', 1)
    store.ingestSession(session([shell('t0', 'pytest -q')], 'h2'), 0, [], 'test', 1)

    expect(commands(db)).toEqual([{ idx: 0, seq: 0, binary: 'pytest' }])
  })

  it('cascades away with its session', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(session([shell('t0', 'git status')]), 0, [], 'test', 1)
    db.prepare('DELETE FROM sessions WHERE id = ?').run('claude-code:s')
    expect(commands(db)).toEqual([])
  })
})

describe('ingest: tool_calls.result_empty (AL-140)', () => {
  // `name` and `command` both feed the retrieval decision now — an MCP call is judged
  // by its tool verb, a shell call by the binaries its command parses to.
  const call = (
    id: string,
    action: ToolCall['action'],
    raw: unknown,
    ok = true,
    extra: { name?: string; command?: string } = {},
  ): ToolCall => ({
    id,
    name: extra.name ?? 'X',
    action,
    input: {},
    target: extra.command ? { command: extra.command } : {},
    result: { ok, isError: !ok, raw },
    isSidechain: false,
  })
  const flags = (db: DB) =>
    (db.prepare('SELECT result_empty AS e FROM tool_calls ORDER BY idx').all() as Array<{ e: number | null }>).map((r) => r.e)

  it('flags retrieval-shaped calls and leaves everything else NULL', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(
      session([
        call('t0', 'search', 'No matches found'),
        call('t1', 'search', 'src/a.ts:1: hit'),
        call('t2', 'mcp_call', [], true, { name: 'mcp__jira__getIssue' }),
        call('t3', 'web', 'a real page of results'),
        call('t4', 'shell', '', true, { command: 'git push' }), // silence here IS success
        call('t5', 'file_read', ''),
      ]),
      0,
      [],
      'test',
      1,
    )

    expect(flags(db)).toEqual([1, 0, 1, 0, null, null])
  })

  /**
   * The two calls that made the old action-level rule wrong: a write whose empty
   * acknowledgement means it worked, and a search whose empty output means it found
   * nothing. Both are `mcp_call`/`shell`, so only the name and the binary separate them.
   */
  it('judges MCP by the tool verb and shell by the binary, not by the action', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(
      session([
        call('t0', 'mcp_call', [], true, { name: 'mcp__jira__createIssue' }),
        call('t1', 'mcp_call', [], true, { name: 'mcp__jira__searchIssues' }),
        call('t2', 'shell', '', true, { command: 'grep -r needle src' }),
        call('t3', 'shell', 'src/a.ts:1: needle', true, { command: 'grep -r needle src' }),
        // One payload for the whole chain, so an empty one blames neither binary.
        call('t4', 'shell', '', true, { command: 'grep -r needle src | head -5' }),
      ]),
      0,
      [],
      'test',
      1,
    )

    expect(flags(db)).toEqual([null, 1, 1, 0, null])
  })

  it('leaves a failed retrieval call NULL — it is already counted as an error', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(session([call('t0', 'mcp_call', 'MCP error: transport closed', false)]), 0, [], 'test', 1)

    const row = db.prepare('SELECT result_empty AS e, error_category AS c FROM tool_calls').get() as { e: number | null; c: string }
    expect(row.e).toBeNull()
    expect(row.c).toBe('integration_error')
  })

  it('reads an MCP content-block payload, not its JSON envelope', () => {
    const db = openDb(':memory:')
    new Store(db).ingestSession(
      session([
        call('t0', 'mcp_call', [{ type: 'text', text: 'No results found' }], true, { name: 'mcp__jira__searchIssues' }),
        call('t1', 'mcp_call', [{ type: 'text', text: 'row 1\nrow 2' }], true, { name: 'mcp__jira__searchIssues' }),
      ]),
      0,
      [],
      'test',
      1,
    )

    expect(flags(db)).toEqual([1, 0])
  })
})
