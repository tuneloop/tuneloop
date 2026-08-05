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
  TREND_MIN_CALLS,
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

  it('charges a failure blamed on a navigation builtin to no binary at all', () => {
    // `cd docs` failed, so `npm` never ran. `cd` is not a rostered binary, so the
    // blame matches nothing and the error counts against neither — while the call
    // still counts as one npm was part of.
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'cd docs && npm test', error: true, errorCategory: 'not_found', failedBinary: 'cd' },
    ])
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'npm')).toMatchObject({ calls: 1, errorCalls: 0 })
    expect(row(r.builtin, 'cd')).toBeUndefined() // never a roster row
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

describe('toolHealth — LLM-attributed failures', () => {
  /** What the shell-error-attribution processor writes for one call. */
  const llmBlame = (sessionId: string, idx: number, binary: string | null) =>
    db.prepare(`INSERT INTO annotations (session_id, processor, key, value) VALUES (?, 'shell-error-attribution', ?, ?)`)
      .run(sessionId, 'blame:' + idx, JSON.stringify({ binary, category: null, model: 'test' }))

  it('uses the LLM verdict where the parser could not tell', () => {
    // `&&` chains are the deterministic ceiling: the exit code can't say where the
    // chain stopped, so without this the failure is charged to both binaries.
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls /nope && npx tsc', error: true, errorCategory: 'not_found' },
    ])
    llmBlame('s1', 0, 'ls')
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'ls')).toMatchObject({ calls: 1, errorCalls: 1 })
    expect(row(r.builtin, 'npx')).toMatchObject({ calls: 1, errorCalls: 0 })
  })

  it('never overrules the deterministic verdict', () => {
    // Shell semantics beat a reading of prose. If they disagree, the parser wins.
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls /nope && npx tsc', error: true, errorCategory: 'not_found', failedBinary: 'ls' },
    ])
    llmBlame('s1', 0, 'npx')
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'ls')!.errorCalls).toBe(1)
    expect(row(r.builtin, 'npx')!.errorCalls).toBe(0)
  })

  it('falls back to the multi-label when the model also could not tell', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls /nope && npx tsc', error: true, errorCategory: 'not_found' },
    ])
    llmBlame('s1', 0, null)
    const r = toolHealth(store, { nowMs: NOW })
    expect(row(r.builtin, 'ls')!.errorCalls).toBe(1)
    expect(row(r.builtin, 'npx')!.errorCalls).toBe(1)
  })

  it('keeps the detail page consistent with the roster', () => {
    seedSession('s1', 'repoA', 2, [
      { name: 'Bash', action: 'shell', command: 'ls /nope && npx tsc', error: true, errorCategory: 'not_found' },
    ])
    llmBlame('s1', 0, 'ls')
    const d = toolHealthDetail(store, 'builtin', 'npx', { nowMs: NOW })!
    expect(d.row.errorCalls).toBe(0)
    expect(d.errorCategories).toEqual([]) // not npx's failure, so not in its categories
    expect(d.sessions.reduce((a, g) => a + g.errorCalls, 0)).toBe(0)
    // The call is still listed — npx was in the command — but badged, not counted.
    expect(d.sessions[0]!.items[0]).toMatchObject({ isError: true, blamedElsewhere: true })
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

  /**
   * The chart sits under the MCP/built-in switch, so it has to describe the roster
   * that is showing. Summing both is how you get two MCP servers over a chart
   * counting thousands of shell calls.
   */
  it('trends each roster separately, counting every call exactly once', () => {
    seedSession('s1', 'repoA', 10, [
      { ...mcpCall('sentry', 'a'), daysAgo: 3 },
      { ...mcpCall('sentry', 'b'), daysAgo: 3, error: true },
      { name: 'Read', action: 'other', daysAgo: 2 },
      { name: 'Bash', action: 'shell', command: 'git status && npm test', daysAgo: 1, error: true },
    ])
    const r = toolHealth(store, { nowMs: NOW, days: 7 })

    expect(r.mcp.trend.calls).toBe(2)
    expect(r.mcp.trend.errors).toBe(1)
    // Two binaries, but one call: the trend is a rate, so it must not multi-label.
    expect(r.builtin.trend.calls).toBe(2)
    expect(r.builtin.trend.errors).toBe(1)
    expect(r.mcp.trend.calls + r.builtin.trend.calls).toBe(
      r.overallCallSpark.reduce((a, b) => a + b, 0),
    )
  })

  it('refuses to chart a rate that rests on too few calls', () => {
    seedSession('thin', 'repoA', 10, [
      { ...mcpCall('sentry', 'a'), daysAgo: 3 },
      { ...mcpCall('sentry', 'b'), daysAgo: 3, error: true },
    ])
    const thin = toolHealth(store, { nowMs: NOW, days: 7 })
    expect(thin.mcp.trend.chartable).toBe(false)
    expect(thin.mcp.trend.activeDays).toBe(1)

    const many: Call[] = []
    for (let i = 0; i < TREND_MIN_CALLS + 5; i++) many.push({ ...mcpCall('sentry', 'a'), daysAgo: i % 6 })
    seedSession('fat', 'repoA', 10, many)
    const fat = toolHealth(store, { nowMs: NOW, days: 7 })
    expect(fat.mcp.trend.chartable).toBe(true)
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
      { name: 'listIssues', raw: 'mcp__sentry__listIssues', calls: 2, errorCalls: 1, lastUsedAt: expect.any(String) },
      { name: 'getEvent', raw: 'mcp__sentry__getEvent', calls: 1, errorCalls: 0, lastUsedAt: expect.any(String) },
    ])
    expect(d.details).toMatchObject({ type: 'http', url: 'https://sentry.io/mcp', scope: 'global' })
  })

  it('narrows every number on the page to one tool, together', () => {
    // The whole page moves as a unit — tiles, categories, per-repo, calls — so a
    // filtered view can't show one section's tool beside another section's server.
    seedSession('s1', 'repoA', 2, [
      mcpCall('sentry', 'listIssues'),
      mcpCall('sentry', 'listIssues', { error: true, errorCategory: 'auth' }),
      mcpCall('sentry', 'getEvent', { error: true, errorCategory: 'timeout' }),
    ])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW }, { tool: 'mcp__sentry__listIssues' })!
    expect(d.tool).toBe('mcp__sentry__listIssues')
    expect(d.row).toMatchObject({ calls: 2, errorCalls: 1 })
    expect(d.errorCategories).toEqual([{ category: 'auth', calls: 1 }]) // getEvent's timeout is gone
    expect(d.perRepo[0]).toMatchObject({ calls: 2 })
    expect(d.sessions.reduce((a, g) => a + g.calls, 0)).toBe(2)
  })

  it('keeps the FULL tool list while narrowed — it is the filter\'s own control', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'listIssues'), mcpCall('sentry', 'getEvent')])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW }, { tool: 'mcp__sentry__listIssues' })!
    expect(d.perTool.map((t) => t.name).sort()).toEqual(['getEvent', 'listIssues'])
    expect(d.row.calls).toBe(1) // …while the numbers are narrowed
  })

  it('ignores a tool filter that this server never called', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'listIssues')])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW }, { tool: 'mcp__sentry__nosuch' })!
    expect(d.tool).toBeUndefined()
    expect(d.row.calls).toBe(1)
  })

  it('has no tool filter for built-ins — there is nothing below a tool', () => {
    seedSession('s1', 'repoA', 2, [{ name: 'Read', action: 'file_read' }])
    const d = toolHealthDetail(store, 'builtin', 'Read', { nowMs: NOW }, { tool: 'anything' })!
    expect(d.tool).toBeUndefined()
    expect(d.perTool).toEqual([])
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

  it('groups the calls by session, with that session\'s real totals', () => {
    seedSession('s1', 'repoA', 2, [mcpCall('sentry', 'a'), mcpCall('sentry', 'b', { error: true })])
    seedSession('s2', 'repoB', 1, [mcpCall('sentry', 'c')])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    // Each group carries its own counts and its call rows. s1 leads on the
    // failures-first rule (see the ordering test below), despite being older.
    expect(d.sessions.map((g) => [g.sessionId, g.calls, g.errorCalls])).toEqual([
      ['s1', 2, 1],
      ['s2', 1, 0],
    ])
    expect(d.sessions[0]!.items).toHaveLength(2)
    expect(d.sessions[0]!.items[0]).toMatchObject({ sessionId: 's1', idx: expect.any(Number) })
  })

  it('reconciles with the tiles: groups sum to the row\'s calls and errors', () => {
    // Caught twice while building this — once by a blame filter leaking into
    // membership (591 calls in the tile, 590 in the list), once by a parameter
    // bound in the wrong position (zero groups). Both were silent.
    seedSession('s1', 'repoA', 3, [
      { name: 'Bash', action: 'shell', command: 'git status && npm test', error: true, errorCategory: 'test_failure', failedBinary: 'npm' },
      { name: 'Bash', action: 'shell', command: 'git push' },
    ])
    seedSession('s2', 'repoB', 1, [{ name: 'Bash', action: 'shell', command: 'git log' }])
    const d = toolHealthDetail(store, 'builtin', 'git', { nowMs: NOW })!
    expect(d.sessions).toHaveLength(d.row.sessions)
    expect(d.sessions.reduce((a, g) => a + g.calls, 0)).toBe(d.row.calls)
    expect(d.sessions.reduce((a, g) => a + g.errorCalls, 0)).toBe(d.row.errorCalls)
    // git was in the failing command but npm was blamed: the call is listed (it
    // involved git) yet counts against neither git's errors nor its badge.
    expect(d.row.calls).toBe(3)
    expect(d.row.errorCalls).toBe(0)
    const failed = d.sessions.flatMap((g) => g.items).find((i) => i.isError)!
    expect(failed.blamedElsewhere).toBe(true)
  })

  it('leads with failures at both levels, then falls back to recency', () => {
    seedSession('clean-new', 'repoA', 1, [mcpCall('sentry', 'a')])
    seedSession('failed-old', 'repoA', 9, [
      mcpCall('sentry', 'ok1'),
      mcpCall('sentry', 'boom', { error: true }),
      mcpCall('sentry', 'ok2'),
    ])
    seedSession('clean-older', 'repoA', 20, [mcpCall('sentry', 'a')])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    // The session with a failure leads despite being older; the clean ones follow
    // newest-first.
    expect(d.sessions.map((g) => g.sessionId)).toEqual(['failed-old', 'clean-new', 'clean-older'])
    // And inside it, the failure leads its own session's calls.
    expect(d.sessions[0]!.items[0]).toMatchObject({ isError: true })
  })

  it('gives every session its own item allowance, so a busy one can\'t starve the rest', () => {
    // A global cap spent itself on the first few sessions: 22 of 29 groups for
    // `echo` expanded to nothing, and 8 that reported errors listed none.
    seedSession('busy', 'repoA', 2, Array.from({ length: 60 }, () => mcpCall('sentry', 'a')))
    seedSession('quiet', 'repoB', 3, [mcpCall('sentry', 'b', { error: true })])
    const d = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!
    for (const g of d.sessions) expect(g.items.length).toBeGreaterThan(0)
    expect(d.sessions.find((g) => g.sessionId === 'quiet')!.items).toHaveLength(1)
  })

  it('reports a session\'s TRUE call count even when its listed items are capped', () => {
    // The counts come from an aggregate, not from len(items) — otherwise a capped
    // list would quietly understate how often the tool actually ran.
    seedSession('s1', 'repoA', 2, Array.from({ length: 12 }, () => mcpCall('sentry', 'a')))
    const g = toolHealthDetail(store, 'mcp', 'sentry', { nowMs: NOW })!.sessions[0]!
    expect(g.calls).toBe(12)
    expect(g.items.length).toBeLessThanOrEqual(g.calls)
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
