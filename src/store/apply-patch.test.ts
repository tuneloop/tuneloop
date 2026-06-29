import { describe, expect, it } from 'vitest'
import { parseApplyPatch } from './apply-patch'

describe('parseApplyPatch', () => {
  it('expands a multi-file patch into one edit per file', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const a = 1',
      '+export const b = 2',
      '*** Update File: src/existing.ts',
      '@@',
      ' const keep = 1',
      '-const old = 2',
      '+const fresh = 3',
      '*** Delete File: src/gone.ts',
      '*** End Patch',
    ].join('\n')

    const edits = parseApplyPatch(patch)
    expect(edits.map((e) => e.path)).toEqual(['src/new.ts', 'src/existing.ts', 'src/gone.ts'])

    const [add, update, del] = edits
    expect(add!.op).toBe('write')
    expect(add!.hunks[0]!.ins).toBe('export const a = 1\nexport const b = 2')

    expect(update!.op).toBe('edit')
    // context line is carried on both sides so the client diff re-derives the +/−
    expect(update!.hunks[0]).toEqual({ del: 'const keep = 1\nconst old = 2', ins: 'const keep = 1\nconst fresh = 3' })

    expect(del!.op).toBe('edit')
    expect(del!.hunks).toEqual([{ del: '', ins: '' }])
  })

  it('splits a multi-hunk update into a multiedit', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@ first',
      '-x',
      '+y',
      '@@ second',
      '-p',
      '+q',
      '*** End Patch',
    ].join('\n')

    const [edit] = parseApplyPatch(patch)
    expect(edit!.op).toBe('multiedit')
    expect(edit!.hunks).toEqual([
      { del: 'x', ins: 'y' },
      { del: 'p', ins: 'q' },
    ])
  })

  it('follows a Move to: rename to the new path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: old/name.ts',
      '*** Move to: new/name.ts',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n')

    const [edit] = parseApplyPatch(patch)
    expect(edit!.path).toBe('new/name.ts')
    expect(edit!.hunks[0]).toEqual({ del: 'a', ins: 'b' })
  })
})
