import { describe, expect, it } from 'vitest'
import { detailStillCurrent, filterRows, isToolSelected, rollupTail, SHELL_TOP_N } from './tools-roster'
import type { RosterRow } from './tools-roster'

const row = (name: string, o: Partial<RosterRow> = {}): RosterRow => ({ name, flags: [], ...o })
const shell = (name: string, o: Partial<RosterRow> = {}) => row(name, { shell: true, ...o })
const names = (rs: RosterRow[]) => rs.map((r) => r.name)

describe('filterRows', () => {
  const rows = [
    row('sentry', { status: 'used', flags: ['high-error'] }),
    row('ghost', { status: 'unused', flags: ['unused'] }),
    row('linear', { status: 'used' }),
  ]

  it('defaults the MCP roster to used servers', () => {
    expect(names(filterRows(rows, 'mcp', '', ''))).toEqual(['sentry', 'linear'])
  })

  it('defaults the built-in roster to everything — there is no unused state to hide', () => {
    const builtins = [shell('git'), row('Read')]
    expect(names(filterRows(builtins, 'builtin', '', ''))).toEqual(['git', 'Read'])
  })

  it('filters by status and by flag', () => {
    expect(names(filterRows(rows, 'mcp', 'unused', ''))).toEqual(['ghost'])
    expect(names(filterRows(rows, 'mcp', 'high-error', ''))).toEqual(['sentry'])
    expect(names(filterRows(rows, 'mcp', 'all', ''))).toEqual(['sentry', 'ghost', 'linear'])
  })

  it('searches case-insensitively, within the current status view', () => {
    expect(names(filterRows(rows, 'mcp', 'all', 'GHO'))).toEqual(['ghost'])
    expect(names(filterRows(rows, 'mcp', '', 'ghost'))).toEqual([]) // still hidden by the used default
  })
})

describe('rollupTail', () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => shell('bin' + (from + i)))

  it('rolls up nothing until there are more shell rows than the cap', () => {
    expect(rollupTail(many(SHELL_TOP_N))).toEqual([])
  })

  it('rolls up the shell rows past the cap', () => {
    expect(names(rollupTail(many(SHELL_TOP_N + 3)))).toEqual(['bin' + SHELL_TOP_N, 'bin' + (SHELL_TOP_N + 1), 'bin' + (SHELL_TOP_N + 2)])
  })

  it('never rolls up a row wearing an error pill, however low its rank', () => {
    // The case from real data: `curl` sat at rank 22 with `degrading` and `mkdir` at
    // rank 29 with `high-error`. Ranking by volume alone would have hidden both.
    const rows = [...many(SHELL_TOP_N), shell('curl', { flags: ['degrading'] }), shell('noise'), shell('mkdir', { flags: ['high-error'] })]
    expect(names(rollupTail(rows))).toEqual(['noise'])
  })

  it('leaves non-shell built-ins alone — only the shell tail folds', () => {
    const rows = [...many(SHELL_TOP_N + 2), row('Read'), row('Edit')]
    expect(names(rollupTail(rows))).toEqual(['bin' + SHELL_TOP_N, 'bin' + (SHELL_TOP_N + 1)])
  })
})

describe('isToolSelected', () => {
  it('marks the row whose raw name is the active filter', () => {
    expect(isToolSelected('mcp__atlassian__getJiraIssue', 'mcp__atlassian__getJiraIssue')).toBe(true)
    expect(isToolSelected('mcp__atlassian__editJiraIssue', 'mcp__atlassian__getJiraIssue')).toBe(false)
  })

  it('selects nothing while the page is unfiltered', () => {
    expect(isToolSelected('mcp__atlassian__getJiraIssue', undefined)).toBe(false)
    expect(isToolSelected('mcp__atlassian__getJiraIssue', '')).toBe(false)
    expect(isToolSelected('mcp__atlassian__getJiraIssue', null)).toBe(false)
  })

  /**
   * The regression this exists for: a `serve` older than the payload's `raw` field
   * sends rows without one, and the browser still loads the current app.js off
   * disk. Bare `raw === active` then made every row `undefined === undefined` —
   * the whole table lit up as selected, and every click filtered on "undefined".
   */
  it('never selects a row that has no raw name, even unfiltered', () => {
    expect(isToolSelected(undefined, undefined)).toBe(false)
    expect(isToolSelected(undefined, '')).toBe(false)
    expect(isToolSelected('', '')).toBe(false)
  })
})

describe('detailStillCurrent', () => {
  const req = { kind: 'builtin', name: 'grep', filter: '', win: '90d' }

  it('accepts a response for the page still on screen', () => {
    expect(detailStillCurrent(req, { ...req })).toBe(true)
  })

  it('drops a response for an entity navigated away from', () => {
    expect(detailStillCurrent(req, { ...req, name: 'rg' })).toBe(false)
    expect(detailStillCurrent(req, { ...req, kind: 'mcp' })).toBe(false)
  })

  /**
   * The two the old name-only guard let through. Both refetch WITHOUT changing the
   * entity, so a late reply passed the check and was then cached under the new
   * key — 90-day numbers filed as 30-day, served from cache and never correcting
   * itself; or chip A's reply landing after chip B and reverting the filter.
   */
  it('drops a response whose window or filter the page has moved past', () => {
    expect(detailStillCurrent(req, { ...req, win: '30d' })).toBe(false)
    expect(detailStillCurrent(req, { ...req, filter: 'mcp__atlassian__getJiraIssue' })).toBe(false)
  })

  it('treats a missing filter and an empty one as the same page', () => {
    expect(detailStillCurrent({ ...req, filter: undefined }, { ...req, filter: '' })).toBe(true)
  })
})
