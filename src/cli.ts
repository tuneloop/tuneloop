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

program
  .command('analyze')
  .description('Analyze session transcripts and build the local store.')
  .argument('[dirs]', 'comma-separated session directories (default: ~/.claude/projects)')
  .option('--db <path>', 'path to the aivue SQLite store')
  .option('--limit <n>', 'process at most N sessions (handy for a cheap enrichment test)', (v) => parseInt(v, 10))
  .option('-v, --verbose', 'verbose logging')
  .action(async (dirs: string | undefined, options: { db?: string; limit?: number; verbose?: boolean }) => {
    const dirList = dirs
      ? dirs.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    await analyze({ dirs: dirList, db: options.db, limit: options.limit, verbose: options.verbose })
  })

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
