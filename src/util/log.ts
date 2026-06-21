/* Minimal leveled logger. Quiet by default; -v / AIVUE_DEBUG raises verbosity. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = ORDER[level]
  const emit = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] < min) return
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout
    stream.write(`${msg}\n`)
  }
  return {
    debug: (m) => emit('debug', `  ${m}`),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', `warning: ${m}`),
    error: (m) => emit('error', `error: ${m}`),
  }
}
