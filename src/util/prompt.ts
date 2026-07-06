/**
 * Minimal interactive-prompt helpers for CLI setup flows. No dependency; built
 * on node:readline/promises plus raw-mode reads for secrets. Streams are
 * injectable for tests; production callers use the process TTY. Callers gate
 * on `process.stdin.isTTY` themselves — these helpers don't check.
 */
import { createInterface } from 'node:readline/promises'

export interface PromptIo {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/** The subset of tty.ReadStream that secret entry needs; lets tests pass a fake. */
interface RawModeStream extends NodeJS.ReadableStream {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode(mode: boolean): unknown
}

/** Ask one question; returns the trimmed answer ('' when the user just hits Enter). */
export async function askLine(question: string, io: PromptIo = {}): Promise<string> {
  const rl = createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/**
 * Like askLine but never echoes what's typed — for API keys and other secrets.
 *
 * On a TTY the input is read keypress-by-keypress in raw mode, so the kernel
 * never echoes anything. (The classic trick of muting readline's
 * `_writeToOutput` no longer works: modern Node routes echo through a private
 * symbol, so overriding the public method intercepts nothing.) Enter submits,
 * backspace edits, Ctrl+C restores the terminal and re-raises SIGINT so the
 * process aborts like any other CLI. On a non-TTY input (tests, pipes) there
 * is no kernel echo to suppress; the line is read via readline with no output
 * stream attached, so nothing is ever written back either way.
 */
export async function askSecret(question: string, io: PromptIo = {}): Promise<string> {
  const input = (io.input ?? process.stdin) as RawModeStream
  const output = io.output ?? process.stdout
  output.write(question)

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    const rl = createInterface({ input })
    try {
      const answer = await rl.question('')
      output.write('\n')
      return answer.trim()
    } finally {
      rl.close()
    }
  }

  return await new Promise<string>((resolve) => {
    const wasRaw = input.isRaw === true
    input.setRawMode(true)
    input.resume()
    let buf = ''
    const finish = (answer: string, interrupted = false) => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      if (interrupted) {
        // Re-raise now that the terminal is sane; default disposition kills the
        // process. If something handles SIGINT instead, fall through to a skip.
        process.kill(process.pid, 'SIGINT')
      }
      resolve(answer.trim())
    }
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buf) // Enter / Ctrl+D
        if (ch === '\u0003') return finish('', true) // Ctrl+C
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        if (ch >= ' ') buf += ch // printable only; swallow stray control chars
      }
    }
    input.on('data', onData)
  })
}
