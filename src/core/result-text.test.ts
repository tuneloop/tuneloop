import { describe, expect, it } from 'vitest'
import { resultText } from './result-text'

describe('resultText', () => {
  it('passes a plain string through', () => {
    expect(resultText('src/a.ts:1: hit')).toBe('src/a.ts:1: hit')
  })

  it('joins content blocks', () => {
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })

  it('prefers the first populated text field', () => {
    expect(resultText({ stdout: 'out', stderr: 'err' })).toBe('out')
    expect(resultText({ stdout: '', stderr: 'boom' })).toBe('boom')
  })

  /**
   * The regression this file exists for.
   *
   * Claude Code reports a command that printed nothing as
   * {stdout:'', stderr:'', interrupted:false, isImage:false} — the emptiness is
   * IN the envelope. Testing each field with `&& v` read an empty stdout as an
   * absent one, fell through every branch, and returned JSON.stringify of the
   * whole object: 89 characters of "content" where the harness had said there
   * was none. Every downstream reader — empty-result, error classification,
   * the advice pass — then saw a populated result.
   */
  it('reports empty when the harness said the output was empty', () => {
    expect(resultText({ stdout: '', stderr: '', interrupted: false, isImage: false })).toBe('')
    expect(resultText({ stdout: '' })).toBe('')
    expect(resultText({ message: '' })).toBe('')
  })

  it('still stringifies a shape it has no text field for', () => {
    expect(resultText({ code: 2, path: '/tmp/x' })).toBe('{"code":2,"path":"/tmp/x"}')
  })

  it('is empty for nothing at all', () => {
    expect(resultText(null)).toBe('')
    expect(resultText(undefined)).toBe('')
    expect(resultText([])).toBe('')
  })
})
