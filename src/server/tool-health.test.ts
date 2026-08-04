import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { MIN_SESSIONS } from '../detectors/unused-capabilities'
import { shellBinaries } from '../core/shell-binaries'
import {
  HIGH_ERROR_MIN_CALLS,
  HIGH_ERROR_SHARE,
  mcpServerFromToolName,
  toolErrorOccurrences,
  toolHealth,
  toolHealthDetail,
} from './tool-health'

const SOURCE = 'claude-code'
const NOW = Date.parse('2026-07-22T00:00:00.000Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

let db: ReturnType<typeof openDb>

interface Call {
  name: string
  action: string
  /** Which binary the error output named, as ingest would have parsed it. */
  failedBinary?: string
  /** Shell command — also parsed into tool_call_commands, as ingest does. */
  command?: string
  error?: boolean
  errorCategory?: string
  sidechain?: boolean
  resultEmpty?: 0 | 1
  /** Overrides the session's day for this call (tool-run clock ≠ session clock). */
  daysAgo?: number
}

function seedSession(id: string, repo: string | null, startedDaysAgo: number, calls: Call[], source = SOURCE) {
  db.prepare(
    `INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?,?,?,?,?,1,?)`,
  ).run(id, id, source, repo, iso(startedDaysAgo), calls.length)
  calls.forEach((c, idx) => {
    const ts = iso(c.daysAgo ?? startedDaysAgo)
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, error_category, error_message, result_empty, failed_binary, command, is_sidechain, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      idx,
      c.name,
      c.action,
      c.error ? 0 : 1,
      c.error ? 1 : 0,
      c.error ? (c.errorCategory ?? 'other') : null,
      c.error ? 'boom' : null,
      c.resultEmpty ?? null,
      c.failedBinary ?? null,
      c.command ?? null,
      c.sidechain ? 1 : 0,
      ts,
    )
    if (c.action !== 'shell' || !c.command) return
    shellBinaries(c.command).forEach((binary, seq) => {
      db.prepare('INSERT INTO tool_call_commands (session_id, idx, seq, binary) VALUES (?,?,?,?)').run(id, idx, seq, binary)
    })
  })
}

function seedMcpConfig(store: Store, servers: Record<string, { type?: string; url?: string }>, source = SOURCE, daysAgo = 20) {
  store.recordEnvSnapshot(
    { source, scope: 'global', scopeKey: '_global', category: 'mcp', payload: { '.mcp.json': { servers } } },
    iso(daysAgo),
  )
}

const mcpCall = (server: string, tool: string, extra: Partial<Call> = {}): Call => ({
  name: `mcp__${server}__${tool}`,
  action: 'mcp_call',
  ...extra,
})

let dir: string
let dbN = 0
let store: Store
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tool-health-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  db = openDb(join(dir, `t${dbN++}.db`))
  store = new Store(db)
})
afterEach(() => store.close())

const row = <T extends { name: string }>(r: { rows: T[] }, name: string): T | undefined => r.rows.find((x) => x.name === name)

describe('toolHealth — MCP roster', () => {
  it('groups calls by server, parsed out of mcp__<server>__<tool>', () => {
    seedSession('s1', 'repoA', 2, [
      mcpCall('atlassian', 'getJiraIssue'),
      mcpCall('atlassian', 'searchJira'),
      mcpCall('sentry', 'listIssues'),
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(r.mcp.rows.map((x) => x.name).sort()).toEqual(['atlassian', 'sentry'])
    expect(row(r.mcp, 'atlassian')!.calls).toBe(2)
    expect(row(r.mcp, 'atlassian')!.sessions).toBe(1)
  })

  it('counts subagent calls in the total, with the sidechain share broken out', () => {
    // The capability_usage view is main-thread-only; reading it here would undercount
    // subagent MCP usage, which is the whole reason this queries tool_calls directly.
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'a'), mcpCall('sentry', 'b', { sidechain: true })])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.mcp, 'sentry')).toMatchObject({ calls: 2, sidechainCalls: 1 })
  })

  it('drops a malformed mcp name rather than emitting a phantom server', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'mcp__broken', action: 'mcp_call' }, mcpCall('ok', 'x')])
    expect(toolHealth(store, { nowMs: NOW }).mcp.rows.map((x) => x.name)).toEqual(['ok'])
  })

  it('windows on tool-run time, not session start', () => {
    // A session that STARTED outside the window but whose call ran inside it counts.
    seedSession('s1', 'repoA', 60, [mcpCall('sentry', 'a', { daysAgo: 3 })])
    expect(row(toolHealth(store, { nowMs: NOW, days: 30 }).mcp, 'sentry')!.calls).toBe(1)
    expect(toolHealth(store, { nowMs: NOW, days: 1 }).mcp.rows).toEqual([])
  })

  it('lists an installed-but-unused server, and marks a used one', () => {
    seedMcpConfig(store, { ghost: { type: 'stdio' }, sentry: { type: 'http', url: 'https://sentry.io/mcp' } })
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`s${i}`, 'repoA', 2, [mcpCall('sentry', 'a')])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.mcp, 'ghost')).toMatchObject({ status: 'unused', installed: true, enoughData: true })
    expect(row(r.mcp, 'ghost')!.flags).toContain('unused')
    expect(row(r.mcp, 'sentry')).toMatchObject({ status: 'used', installed: true })
    expect(r.mcp.totalUsed).toBe(1)
    expect(r.mcp.totalUnused).toBe(1)
  })

  it('flags a server that ran but is in no config as not-in-config', () => {
    seedMcpConfig(store, { sentry: {} })
    seedSession('s1', 'repoA', 2, [mcpCall('gone', 'a')])
    expect(row(toolHealth(store, { nowMs: NOW }).mcp, 'gone')!.flags).toContain('not-in-config')
  })

  it('suppresses config-dependent chips when the harness has no MCP inventory', () => {
    // Pi is permanently here: no MCP config exists for it, so no reader will be written.
    // Observed stats are still real; a "not-in-config" chip would be a lie about absence.
    seedSession('p1', 'repoA', 2, [mcpCall('sentry', 'a')], 'pi')
    const r = toolHealth(store, { nowMs: NOW, source: 'pi' })
    expect(r.mcp.observedOnly).toBe(true)
    expect(row(r.mcp, 'sentry')).toMatchObject({ calls: 1, status: 'used' })
    expect(row(r.mcp, 'sentry')!.flags).toEqual([])
  })

  it('reconciles OpenCode bare <server>_<tool> calls against the installed servers', () => {
    // OpenCode writes no mcp__ marker, so these land as action='other'.
    seedMcpConfig(store, { linear: {} }, 'opencode')
    seedSession(
      'o1',
      'repoA',
      2,
      [
        { name: 'linear_create_issue', action: 'other' },
        { name: 'linear_list_issues', action: 'other', error: true },
        { name: 'apply_patch', action: 'other' }, // a built-in, not a server call
      ],
      'opencode',
    )
    const r = toolHealth(store, { nowMs: NOW, source: 'opencode' })
    expect(row(r.mcp, 'linear')).toMatchObject({ calls: 2, errorCalls: 1, status: 'used' })
  })
})

describe('toolHealth — built-in roster', () => {
  it('rows non-shell built-ins at tool grain', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Read', action: 'file_read' },
      { name: 'Read', action: 'file_read' },
      { name: 'Grep', action: 'search' },
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'Read')!.calls).toBe(2)
    expect(row(r.builtin, 'Grep')!.calls).toBe(1)
  })

  it('promotes shell binaries to rows and counts a compound call under each', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'Bash', action: 'shell', command: 'cd repo && npm run build | tee log' }])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'npm')).toMatchObject({ calls: 1, shell: true })
    expect(row(r.builtin, 'tee')).toMatchObject({ calls: 1, shell: true })
    // Bash itself is not a row: it is exploded into what it ran.
    expect(row(r.builtin, 'Bash')).toBeUndefined()
  })

  it('marks a repo-local script so the UI can chip it', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'Bash', action: 'shell', command: './deploy.sh --prod' }])
    expect(row(toolHealth(store, { nowMs: NOW }).builtin, './deploy.sh')).toMatchObject({ shell: true, repoLocal: true })
  })

  it('reports shell calls that named no binary rather than dropping them silently', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'cd /repo' },
      { name: 'Bash', action: 'shell', command: 'git status' },
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(r.builtin.unlabeledShellCalls).toBe(1)
    expect(row(r.builtin, 'git')!.calls).toBe(1)
  })

  it('carries no used/unused status — there is nothing to install or remove', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'Read', action: 'file_read' }])
    expect(row(toolHealth(store, { nowMs: NOW }).builtin, 'Read')!.status).toBeUndefined()
  })

  it('keeps skill calls out of the built-in roster — they have their own tab', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'tdd', action: 'skill' }, { name: 'Read', action: 'file_read' }])
    expect(toolHealth(store, { nowMs: NOW }).builtin.rows.map((x) => x.name)).toEqual(['Read'])
  })
})

describe('toolHealth — error pills', () => {
  const failing = (n: number, errors: number, action = 'mcp_call'): Call[] =>
    Array.from({ length: n }, (_, i) => ({
      name: action === 'mcp_call' ? 'mcp__flaky__do' : 'Read',
      action,
      error: i < errors,
      errorCategory: 'integration_error',
    }))

  it('flags high-error past the share and call-count gates', () => {
    const n = HIGH_ERROR_MIN_CALLS
    seedSession('s1', 'repoA', 2, failing(n, Math.ceil(n * HIGH_ERROR_SHARE)))
    const r = row(toolHealth(store, { nowMs: NOW }).mcp, 'flaky')!
    expect(r.flags).toContain('high-error')
    expect(r.dominantErrorCategory).toBe('integration_error')
  })

  it('withholds high-error below the call-count gate, however bad the rate', () => {
    seedSession('s1', 'repoA', 2, failing(HIGH_ERROR_MIN_CALLS - 1, HIGH_ERROR_MIN_CALLS - 1))
    // 100% errors, but too few calls to call it a pattern rather than a bad afternoon.
    expect(row(toolHealth(store, { nowMs: NOW }).mcp, 'flaky')!.flags).not.toContain('high-error')
  })

  it('flags degrading when the recent half is materially worse than the older half', () => {
    const half = (daysAgo: number, errors: number): Call[] =>
      Array.from({ length: 10 }, (_, i) => ({ ...mcpCall('slipping', 'do'), daysAgo, error: i < errors }))
    seedSession('s1', 'repoA', 40, [...half(25, 0), ...half(5, 6)])
    expect(row(toolHealth(store, { nowMs: NOW, days: 30 }).mcp, 'slipping')!.flags).toContain('degrading')
  })

  it('does not flag degrading on a thin recent half', () => {
    const older: Call[] = Array.from({ length: 20 }, (_, i) => ({ ...mcpCall('quiet', 'do'), daysAgo: 25, error: i < 1 }))
    const recent: Call[] = [{ ...mcpCall('quiet', 'do'), daysAgo: 5, error: true }]
    seedSession('s1', 'repoA', 40, [...older, ...recent])
    expect(row(toolHealth(store, { nowMs: NOW, days: 30 }).mcp, 'quiet')!.flags).not.toContain('degrading')
  })

  it('applies the error pills to shell binaries too', () => {
    const calls: Call[] = Array.from({ length: HIGH_ERROR_MIN_CALLS }, (_, i) => ({
      name: 'Bash',
      action: 'shell',
      command: 'gh pr create --fill',
      error: i < HIGH_ERROR_MIN_CALLS,
      errorCategory: 'auth',
    }))
    seedSession('s1', 'repoA', 2, calls)
    expect(row(toolHealth(store, { nowMs: NOW }).builtin, 'gh')!.flags).toContain('high-error')
  })
})

describe('toolHealth — blame for compound shell failures', () => {
  it('charges a blamed failure to that binary alone, not the whole chain', () => {
    // `ls missing && tsc` fails at ls, so tsc never ran; before blame it carried the
    // error and showed a 100% failure rate for a command it never executed.
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls missing && npx tsc', error: true, errorCategory: 'not_found', failedBinary: 'ls' },
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'ls')).toMatchObject({ calls: 1, errorCalls: 1 })
    // npx still shows the call it was part of — "calls involving" is unchanged —
    // but no longer wears a failure that wasn't its.
    expect(row(r.builtin, 'npx')).toMatchObject({ calls: 1, errorCalls: 0 })
  })

  it('keeps the multi-label when the output named nobody', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls missing && npx tsc', error: true, errorCategory: 'command_failed' },
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'ls')!.errorCalls).toBe(1)
    expect(row(r.builtin, 'npx')!.errorCalls).toBe(1)
  })

  it('keeps the blamed failure out of the other binary\'s categories and occurrences', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls missing && npx tsc', error: true, errorCategory: 'not_found', failedBinary: 'ls' },
    ])
    expect(toolHealthDetail(store, 'builtin', 'npx', { nowMs: NOW })!.errorCategories).toEqual([])
    expect(toolErrorOccurrences(store, 'builtin', 'npx', 'not_found', { nowMs: NOW })).toEqual([])
    expect(toolErrorOccurrences(store, 'builtin', 'ls', 'not_found', { nowMs: NOW })).toHaveLength(1)
  })
})

describe('toolHealth — empty results and trends', () => {
  it('reports the empty-result rate as its own stat, off error rate', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Grep', action: 'search', resultEmpty: 1 },
      { name: 'Grep', action: 'search', resultEmpty: 0 },
      { name: 'Grep', action: 'search', error: true }, // failed: NULL, so outside the denominator
    ])
    expect(row(toolHealth(store, { nowMs: NOW }).builtin, 'Grep')).toMatchObject({
      calls: 3,
      errorCalls: 1,
      emptyCalls: 1,
      emptyEligibleCalls: 2,
    })
  })

  it('aligns each row spark to the shared bucket axis, and totals the overall trend', () => {
    seedSession('s1', 'repoA', 10, [
      { ...mcpCall('sentry', 'a'), daysAgo: 3 },
      { ...mcpCall('sentry', 'b'), daysAgo: 3, error: true },
      { ...mcpCall('sentry', 'c'), daysAgo: 1 },
    ])
    const r = toolHealth(store, { nowMs: NOW, days: 7 })
    const sentry = row(r.mcp, 'sentry')!
    expect(sentry.spark).toHaveLength(r.sparkBuckets.length)
    expect(sentry.spark.reduce((a, b) => a + b, 0)).toBe(3)
    expect(sentry.errorSpark.reduce((a, b) => a + b, 0)).toBe(1)
    expect(r.overallCallSpark.reduce((a, b) => a + b, 0)).toBe(3)
    expect(r.overallErrorSpark.reduce((a, b) => a + b, 0)).toBe(1)
  })
})

describe('toolHealth — sources', () => {
  it('reports one source at a time and offers the rest as a chooser', () => {
    seedSession('c1', 'repoA', 2, [mcpCall('sentry', 'a'), mcpCall('sentry', 'b')])
    seedSession('x1', 'repoA', 2, [mcpCall('linear', 'a')], 'codex')
    const r = toolHealth(store, { nowMs: NOW })
    expect(r.availableSources).toEqual(['claude-code', 'codex'])
    expect(r.source).toBe('claude-code') // busiest by tool calls
    expect(r.mcp.rows.map((x) => x.name)).toEqual(['sentry'])
    expect(toolHealth(store, { nowMs: NOW, source: 'codex' }).mcp.rows.map((x) => x.name)).toEqual(['linear'])
  })

  it('returns an empty report for a store with no tool calls', () => {
    const r = toolHealth(store, { nowMs: NOW })
    expect(r.source).toBe('')
    expect(r.mcp.rows).toEqual([])
    expect(r.builtin.rows).toEqual([])
  })
})

describe('toolHealthDetail', () => {
  it('breaks an MCP server down by repo and by observed tool', () => {
    seedMcpConfig(store, { sentry: { type: 'http', url: 'https://sentry.io/mcp' } })
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'listIssues'), mcpCall('sentry', 'listIssues', { error: true })])
    seedSession('s2', 'repoB', 2, [mcpCall('sentry', 'getEvent')])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    expect(d.perRepo.map((p) => p.repo)).toEqual(['repoA', 'repoB'])
    expect(d.perTool).toEqual([
      { name: 'listIssues', calls: 2, errorCalls: 1, lastUsedAt: expect.any(String) },
      { name: 'getEvent', calls: 1, errorCalls: 0, lastUsedAt: expect.any(String) },
    ])
    expect(d.details).toMatchObject({ type: 'http', url: 'https://sentry.io/mcp', scope: 'global' })
  })

  it('lists errors by category for that entity only', () => {
    seedSession('s1', 'repoA', 2, [
      mcpCall('sentry', 'a', { error: true, errorCategory: 'auth' }),
      mcpCall('sentry', 'b', { error: true, errorCategory: 'auth' }),
      mcpCall('sentry', 'c', { error: true, errorCategory: 'timeout' }),
      mcpCall('other', 'z', { error: true, errorCategory: 'network' }),
    ])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    expect(d.errorCategories).toEqual([
      { category: 'auth', calls: 2 },
      { category: 'timeout', calls: 1 },
    ])
  })

  it('scopes a shell binary detail to the calls that involved it', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'git status && npm test' },
      { name: 'Bash', action: 'shell', command: 'npm ci', error: true, errorCategory: 'command_failed' },
    ])
    const d = toolHealthDetail(store, 'builtin', 'git', { nowMs: NOW })!
    expect(d.row.calls).toBe(1)
    expect(d.errorCategories).toEqual([])
    expect(toolHealthDetail(store, 'builtin', 'npm', { nowMs: NOW })!.row.calls).toBe(2)
  })

  it('carries an invocations list with transcript anchors', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'a'), mcpCall('sentry', 'b', { error: true })])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    expect(d.invocations).toHaveLength(2)
    expect(d.invocations[0]).toMatchObject({ sessionId: 's1', idx: expect.any(Number) })
  })

  it('always states an advice line, naming the dominant error category when there is one', () => {
    const calls = Array.from({ length: HIGH_ERROR_MIN_CALLS }, () => mcpCall('flaky', 'do', { error: true, errorCategory: 'auth' }))
    seedSession('s1', 'repoA', 2, calls)
    expect(toolHealthDetail(store, 'mcp', 'flaky', { nowMs: NOW })!.advice).toMatch(/mostly auth/i)
  })

  it('says "most often", not "mostly", when the top category is only a plurality', () => {
    // Real data hit this: 3 failures split across 3 categories read as "mostly
    // command failed", which would send the user after the wrong cause.
    const calls: Call[] = [
      ...Array.from({ length: 10 }, () => mcpCall('mixed', 'do')),
      mcpCall('mixed', 'do', { error: true, errorCategory: 'command_failed' }),
      mcpCall('mixed', 'do', { error: true, errorCategory: 'not_found' }),
      mcpCall('mixed', 'do', { error: true, errorCategory: 'user_rejected' }),
    ]
    seedSession('s1', 'repoA', 2, calls)
    const advice = toolHealthDetail(store, 'mcp', 'mixed', { nowMs: NOW })!.advice
    expect(advice).toContain('most often')
    expect(advice).not.toContain('mostly')
  })

  it('states a plain fact when nothing is wrong', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('calm', 'do'), mcpCall('calm', 'do')])
    expect(toolHealthDetail(store, 'mcp', 'calm', { nowMs: NOW })!.advice).toBe('2 calls in this window, none failed.')
  })

  it('returns null for an entity with nothing in the window', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'a')])
    expect(toolHealthDetail(store, 'mcp', 'nosuch', { nowMs: NOW })).toBeNull()
  })
})

describe('mcp name grammar', () => {
  it('agrees with the SQL that the used/unused verdict flows through', () => {
    // Two copies of this grammar exist: the JS one here (stats) and the SQL in
    // capability_invocation (verdicts). If they ever disagree, a server's stats and
    // its used/unused dot come apart — so diff them over the awkward names.
    const names = [
      'mcp__sentry__listIssues',
      'mcp__a__b__c', // tool name containing '__'
      'mcp__srv_with_underscores__do',
      'mcp__broken', // no second '__' → no server
      'mcp____x', // empty server name → dropped
      'Bash',
    ]
    seedSession('s1', 'repoA', 2, names.map((name) => ({ name, action: 'mcp_call' })))
    const fromSql = (
      db.prepare(`SELECT name FROM capability_invocation WHERE kind = 'mcp' ORDER BY idx`).all() as Array<{ name: string }>
    ).map((r) => r.name)
    const fromJs = names.map(mcpServerFromToolName).filter((n): n is string => !!n)
    expect(fromJs).toEqual(fromSql)
  })
})

describe('toolErrorOccurrences', () => {
  it('scopes occurrences to one entity and category', () => {
    seedSession('s1', 'repoA', 2, [
      mcpCall('sentry', 'a', { error: true, errorCategory: 'auth' }),
      mcpCall('sentry', 'b', { error: true, errorCategory: 'timeout' }),
      mcpCall('other', 'z', { error: true, errorCategory: 'auth' }),
    ])
    const occ = toolErrorOccurrences(store, 'mcp', 'sentry', 'auth', { nowMs: NOW }) as Array<{ name: string }>
    expect(occ.map((o) => o.name)).toEqual(['mcp__sentry__a'])
  })

  it('stays inside the reported harness, so the list matches the category bar', () => {
    // Found on real data: `git` failures from a Pi session were listed under the
    // Claude Code roster, whose bar counted 3 while the list returned 4.
    const err: Call = { name: 'Bash', action: 'shell', command: 'git push', error: true, errorCategory: 'conflict' }
    seedSession('c1', 'repoA', 2, [err])
    seedSession('p1', 'repoA', 2, [err], 'pi')
    const d = toolHealthDetail(store, 'builtin', 'git', { nowMs: NOW })!
    const occ = toolErrorOccurrences(store, 'builtin', 'git', 'conflict', { nowMs: NOW })
    expect(occ).toHaveLength(d.errorCategories.find((c) => c.category === 'conflict')!.calls)
  })

  it('finds a shell binary error through the compound command it was part of', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'npm ci && npm test', error: true, errorCategory: 'test_failure' },
    ])
    const occ = toolErrorOccurrences(store, 'builtin', 'npm', 'test_failure', { nowMs: NOW })
    expect(occ).toHaveLength(1)
    expect(occ[0]!.command).toBe('npm ci && npm test')
  })

  it('reports how many binaries a failing command involved, so the UI can badge it', () => {
    // The same failure is listed under BOTH binaries and we can't say which segment
    // broke; the count is what lets the row say so instead of implying `git` failed.
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'git pull && npm test', error: true, errorCategory: 'test_failure' },
      { name: 'Bash', action: 'shell', command: 'npm run lint', error: true, errorCategory: 'test_failure' },
    ])
    const npm = toolErrorOccurrences(store, 'builtin', 'npm', 'test_failure', { nowMs: NOW })
    expect(npm.map((o) => o.binaryCount)).toEqual([2, 1])
    expect(toolErrorOccurrences(store, 'builtin', 'git', 'test_failure', { nowMs: NOW }).map((o) => o.binaryCount)).toEqual([2])
  })
})
