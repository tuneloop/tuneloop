import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { askLine, askSecret } from './prompt'

function io() {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (c) => (written += String(c)))
  return { input, output, written: () => written }
}

/** PassThrough dressed up as a TTY so askSecret takes its raw-mode branch. */
function ttyIo() {
  const t = io()
  const input = t.input as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(m: boolean): void }
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (m: boolean) => (input.isRaw = m)
  return { ...t, input }
}

describe('askLine', () => {
  it('returns the trimmed answer', async () => {
    const t = io()
    const p = askLine('Provider: ', t)
    t.input.write('  openrouter  \n')
    await expect(p).resolves.toBe('openrouter')
    expect(t.written()).toContain('Provider: ')
  })

  it('returns "" on a bare Enter (the skip gesture)', async () => {
    const t = io()
    const p = askLine('Provider: ', t)
    t.input.write('\n')
    await expect(p).resolves.toBe('')
  })
})

describe('askSecret (non-TTY input)', () => {
  it('returns the secret without ever echoing it', async () => {
    const t = io()
    const p = askSecret('Key: ', t)
    t.input.write('sk-super-secret\n')
    await expect(p).resolves.toBe('sk-super-secret')
    expect(t.written()).toContain('Key: ')
    expect(t.written()).not.toContain('sk-super-secret')
  })

  it('returns "" on a bare Enter', async () => {
    const t = io()
    const p = askSecret('Key: ', t)
    t.input.write('\n')
    await expect(p).resolves.toBe('')
  })
})

describe('askSecret (TTY raw mode)', () => {
  it('reads keypresses without echoing, honors backspace, restores raw mode', async () => {
    const t = ttyIo()
    const p = askSecret('Key: ', t)
    t.input.write('sk-abcX')
    expect(t.input.isRaw).toBe(true) // raw while reading — kernel echo is off
    t.input.write('\u007f') // backspace the stray X
    t.input.write('\r')
    await expect(p).resolves.toBe('sk-abc')
    expect(t.written()).not.toContain('sk-abc')
    expect(t.input.isRaw).toBe(false) // restored on finish
  })

  it('submits on Ctrl+D and swallows stray control characters', async () => {
    const t = ttyIo()
    const p = askSecret('Key: ', t)
    t.input.write('sk\u001b-key\u0004') // ESC ignored, Ctrl+D submits
    await expect(p).resolves.toBe('sk-key')
  })
})
