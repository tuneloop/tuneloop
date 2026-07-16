import { describe, expect, it } from 'vitest'
import { extractExecOperations } from './exec-envelope'

describe('Codex exec envelope static extraction', () => {
  it('resolves const values, object spreads, computed names, and source order', () => {
    const operations = extractExecOperations([
      'const base = {workdir: "/repo", yield_time_ms: 10000};',
      'const patch = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n*** End Patch";',
      'tools["exec_command"]({...base, cmd: "git status"});',
      'tools.apply_patch(patch);',
    ].join('\n'))

    expect(operations).toMatchObject([
      { name: 'exec_command', resolved: true, input: { workdir: '/repo', yield_time_ms: 10_000, cmd: 'git status' } },
      { name: 'apply_patch', resolved: true, input: expect.stringContaining('Update File: /repo/a.ts') },
    ])
  })

  it('never executes transcript JavaScript', () => {
    const marker = '__tuneloop_exec_parser_must_not_run__'
    delete (globalThis as Record<string, unknown>)[marker]
    const operations = extractExecOperations([
      `globalThis.${marker} = true;`,
      'throw new Error("must not execute");',
      'tools.exec_command({cmd:"git status"});',
    ].join('\n'))

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
    expect(operations).toMatchObject([{ name: 'exec_command', resolved: true }])
  })

  it('keeps dynamic arguments opaque and rejects malformed programs', () => {
    expect(extractExecOperations('const cmd = getCommand(); tools.exec_command({cmd});')).toMatchObject([
      { name: 'exec_command', resolved: false, input: { _raw: '{cmd}' } },
    ])
    expect(extractExecOperations('tools.exec_command({cmd:')).toEqual([])
  })
})
