#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import './register'
import { analyze } from './commands/analyze'
import { serve } from './commands/serve'
import { queryCommand } from './commands/query'

// Read once from package.json so the CLI version never drifts from the package.
// Resolves the same in dev (src/), in the bundle (dist/), and when installed
// (npm always ships package.json alongside dist/).
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

const program = new Command()

program
  .name('tuneloop')
  .description('Local analytics for your AI coding sessions. Count outcomes, not tokens.')
  .version(version)

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
  .option('--db <path>', 'path to the tuneloop SQLite store')
  .option('--limit <n>', 'process at most N sessions (handy for a cheap enrichment test)', (v) => parseInt(v, 10))
  .option('--port <n>', 'dashboard port when serving (default 4319)', (v) => parseInt(v, 10))
  .option('--llm-provider <name>', 'enrichment provider preset (anthropic, openai, bedrock, openrouter, groq, deepseek, gemini, ollama, …); overrides env')
  .option('--llm-model <id>', 'enrichment model id; overrides env')
  .option('--llm-base-url <url>', 'OpenAI-compatible endpoint URL (for openai-compatible / custom hosts); overrides env')
  .option('--no-serve', 'analyze only; do not serve the dashboard')
  .option('-v, --verbose', 'verbose logging')
  .action(
    async (
      dirs: string | undefined,
      options: {
        source: string[]
        db?: string
        limit?: number
        port?: number
        serve?: boolean
        verbose?: boolean
        llmProvider?: string
        llmModel?: string
        llmBaseUrl?: string
      },
    ) => {
      const dirList = dirs
        ? dirs.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      await analyze({
        dirs: dirList,
        sources: options.source,
        db: options.db,
        limit: options.limit,
        verbose: options.verbose,
        llm: { provider: options.llmProvider, model: options.llmModel, baseURL: options.llmBaseUrl },
      })
      // Serve the dashboard by default and print its URL (press Enter to open a
      // browser tab); --no-serve opts out.
      if (options.serve !== false) {
        await serve({ db: options.db, port: options.port })
      }
    },
  )

program
  .command('serve')
  .description('Serve the local dashboard over the analyzed store.')
  .option('--db <path>', 'path to the tuneloop SQLite store')
  .option('--port <n>', 'port to listen on (default 4319)', (v) => parseInt(v, 10))
  .option('--no-open', 'serve headless; do not prompt to open the browser')
  .action(async (options: { db?: string; port?: number; open?: boolean }) => {
    await serve({ db: options.db, port: options.port, open: options.open })
  })

program
  .command('query')
  .description('Run a read-only SQL query (SELECT only) over the local store. --schema dumps the DDL + facets/measures for agents.')
  .argument('[sql]', 'SQL SELECT to run; omit when using --schema')
  .option('--db <path>', 'path to the tuneloop SQLite store')
  .option('--schema', 'print the store schema (tables + facets + measures) instead of running a query')
  .option('--json', 'output JSON instead of a text table')
  .option('--limit <n>', 'max rows to return (default 1000)', (v) => parseInt(v, 10))
  .action(async (sql: string | undefined, options: { db?: string; schema?: boolean; json?: boolean; limit?: number }) => {
    await queryCommand(sql, options)
  })

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`)
  process.exitCode = 1
})
