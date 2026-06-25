#!/usr/bin/env node
import { Command } from 'commander'
import './register'
import { analyze } from './commands/analyze'
import { serve } from './commands/serve'

const program = new Command()

program
  .name('aivue')
  .description('Local analytics for your AI coding sessions. Count outcomes, not tokens.')
  .version('0.0.1')

const appendValue = (val: string, acc: string[]): string[] => (acc.push(val), acc)

program
  .command('analyze')
  .description('Analyze session transcripts, build the local store, then serve the dashboard.')
  .argument('[dirs]', "comma-separated session directories (default: each harness's own location)")
  .option(
    '--source <name>',
    'limit to these harnesses (repeatable). NAME or NAME=DIR to override its roots, e.g. --source codex=/path',
    appendValue,
    [],
  )
  .option('--db <path>', 'path to the aivue SQLite store')
  .option('--limit <n>', 'process at most N sessions (handy for a cheap enrichment test)', (v) => parseInt(v, 10))
  .option('--port <n>', 'dashboard port when serving (default 4319)', (v) => parseInt(v, 10))
  .option('--no-serve', 'analyze only; do not serve the dashboard or open the browser')
  .option('-v, --verbose', 'verbose logging')
  .action(
    async (
      dirs: string | undefined,
      options: { source: string[]; db?: string; limit?: number; port?: number; serve?: boolean; verbose?: boolean },
    ) => {
      const dirList = dirs
        ? dirs.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      await analyze({ dirs: dirList, sources: options.source, db: options.db, limit: options.limit, verbose: options.verbose })
      // Serve + open the browser by default so results are visible immediately; --no-serve opts out.
      if (options.serve !== false) {
        await serve({ db: options.db, port: options.port })
      }
    },
  )

program
  .command('serve')
  .description('Serve the local dashboard over the analyzed store.')
  .option('--db <path>', 'path to the aivue SQLite store')
  .option('--port <n>', 'port to listen on (default 4319)', (v) => parseInt(v, 10))
  .option('--no-open', 'do not open the browser automatically')
  .action(async (options: { db?: string; port?: number; open?: boolean }) => {
    await serve({ db: options.db, port: options.port, open: options.open })
  })

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`)
  process.exitCode = 1
})
