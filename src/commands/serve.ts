import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { loadConfig } from '../config'
import { createDashboardServer, type ShFn } from '../server/http'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { createLogger } from '../util/log'

function makeSh(): ShFn {
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve(null)
        else resolve({ code: err ? (err as any).status ?? 1 : 0, stdout: (stdout || stderr) ?? '' })
      })
    })
}

export interface ServeOptions {
  db?: string
  port?: number
  open?: boolean
}

/** Serve the dashboard over an already-analyzed store. Reads only; Ctrl+C stops. */
export async function serve(opts: ServeOptions): Promise<void> {
  const log = createLogger('info')
  const config = loadConfig({ db: opts.db })
  if (!existsSync(config.dbPath)) {
    log.error(`no store at ${config.dbPath} — run \`tuneloop analyze\` first`)
    process.exitCode = 1
    return
  }

  const db = openDb(config.dbPath)
  const store = new Store(db)
  const port = opts.port ?? 4319
  const url = `http://localhost:${port}`
  const server = createDashboardServer(store, config.dbPath, makeSh())

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') log.error(`port ${port} is in use — try --port <n>`)
    else log.error(err.message)
    process.exitCode = 1
  })

  // Wait for the user to hit Enter before opening a browser tab rather than
  // launching one unprompted — an auto-opened tab is disruptive when the developer
  // is mid-task in their browser. Needs an interactive TTY to read the keypress;
  // --no-open (or a non-TTY stdin) serves headless with no prompt.
  const interactive = opts.open !== false && Boolean(process.stdin.isTTY)

  // Bind to loopback only. The dashboard serves session transcripts (which can
  // contain proprietary code and secrets) over an unauthenticated API; without an
  // explicit host Node binds 0.0.0.0, exposing it to the whole LAN. tuneloop is a
  // local single-developer tool, so 127.0.0.1 is the correct surface.
  server.listen(port, '127.0.0.1', () => {
    const hint = interactive ? 'Enter to open in your browser · Ctrl+C to stop' : 'Ctrl+C to stop'
    process.stdout.write(`\n  tuneloop dashboard  ${url}\n  store: ${config.dbPath}\n  ${hint}\n\n`)
  })

  await new Promise<void>((resolve) => {
    // terminal:false so readline doesn't intercept Ctrl+C; the shell's cooked-mode
    // stdin still delivers SIGINT to the process and a newline as a 'line' event.
    const rl = interactive ? createInterface({ input: process.stdin, terminal: false }) : undefined
    rl?.on('line', () => tryOpen(url))
    process.on('SIGINT', () => {
      rl?.close()
      server.close()
      store.close()
      process.stdout.write('\nstopped.\n')
      resolve()
    })
  })
}

function tryOpen(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  execFile(cmd, args, () => {
    /* best effort — fine if no browser opener exists */
  })
}
