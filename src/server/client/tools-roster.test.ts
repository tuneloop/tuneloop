import { describe, expect, it } from 'vitest'
import { filterRows, rollupTail, SHELL_TOP_N } from './tools-roster'
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
