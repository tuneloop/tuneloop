import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadConfig } from '../config'
import { createDashboardServer } from '../server/http'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { createLogger } from '../util/log'

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
    log.error(`no store at ${config.dbPath} — run \`aivue analyze\` first`)
    process.exitCode = 1
    return
  }

  const db = openDb(config.dbPath)
  const store = new Store(db)
  const port = opts.port ?? 4319
  const server = createDashboardServer(store, config.dbPath)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') log.error(`port ${port} is in use — try --port <n>`)
    else log.error(err.message)
    process.exitCode = 1
  })

  // Bind to loopback only. The dashboard serves session transcripts (which can
  // contain proprietary code and secrets) over an unauthenticated API; without an
  // explicit host Node binds 0.0.0.0, exposing it to the whole LAN. aivue is a
  // local single-developer tool, so 127.0.0.1 is the correct surface.
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`
    process.stdout.write(`\n  aivue dashboard  ${url}\n  store: ${config.dbPath}\n  Ctrl+C to stop\n\n`)
    if (opts.open !== false) tryOpen(url)
  })

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
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
