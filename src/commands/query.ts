import { existsSync } from 'node:fs'
import { loadConfig } from '../config'
import { describeSchema, QueryError, runQuery, type SchemaDump } from '../query/run'

export interface QueryCliOptions {
  db?: string
  schema?: boolean
  json?: boolean
  limit?: number
}

/**
 * `tuneloop query "<SQL>"` — read-only SQL over the local store, for the analyses
 * the dashboard doesn't cover. `--schema` dumps the DDL + facet/measure registries
 * so an agent can learn the shape before querying. Zero new deps; works without the
 * server, which makes it the natural fit for Claude Code's bash tool.
 */
export async function queryCommand(sql: string | undefined, opts: QueryCliOptions): Promise<void> {
  const { dbPath } = loadConfig({ db: opts.db })
  if (!existsSync(dbPath)) {
    process.stderr.write(`error: no store at ${dbPath} — run \`tuneloop analyze\` first\n`)
    process.exitCode = 1
    return
  }

  if (opts.schema) {
    const dump = describeSchema(dbPath)
    process.stdout.write(opts.json ? `${JSON.stringify(dump, null, 2)}\n` : formatSchema(dump))
    return
  }

  if (!sql || !sql.trim()) {
    process.stderr.write('error: provide a SQL query, or --schema to see the store shape\n')
    process.exitCode = 1
    return
  }

  try {
    const res = runQuery(dbPath, sql, { maxRows: opts.limit })
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(res.rows, null, 2)}\n`)
    } else {
      process.stdout.write(formatTable(res.columns, res.rows))
    }
    if (res.truncated) {
      const why =
        res.truncated === 'rows'
          ? `row cap reached — pass --limit <n> for more`
          : res.truncated === 'bytes'
            ? `response size cap reached`
            : `time cap reached`
      process.stderr.write(`\n(truncated: ${why}; ${res.rowCount} rows shown)\n`)
    }
  } catch (err) {
    if (err instanceof QueryError) {
      process.stderr.write(`error: ${err.message}\n`)
      process.exitCode = 1
      return
    }
    // SQLite's own errors (syntax, unknown column) — surface the message, not a stack.
    process.stderr.write(`error: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
}

const MAX_CELL = 60

/** One value → a single-line cell, truncated so a wide column can't blow up the table. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (Buffer.isBuffer(value)) return `<blob ${value.length}b>`
  const s = String(value).replace(/\s+/g, ' ')
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s
}

/** Minimal column-aligned table. Empty result still prints the header row. */
function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0) return '(no columns)\n'
  const cells = rows.map((r) => columns.map((c) => cell(r[c])))
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => (row[i] ?? '').length), 0))
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  const out: string[] = [line(columns), widths.map((w) => '─'.repeat(w)).join('  ')]
  for (const row of cells) out.push(line(row))
  if (rows.length === 0) out.push('(0 rows)')
  return `${out.join('\n')}\n`
}

/** Human-readable schema dump: coverage, then DDL, then facet and measure registries. */
function formatSchema(dump: SchemaDump): string {
  const out: string[] = []
  out.push(`# tuneloop store (schema v${dump.schemaVersion ?? '?'})`, '')
  const c = dump.coverage
  if (c) {
    const span = c.firstAt && c.lastAt ? `${c.firstAt.slice(0, 10)} → ${c.lastAt.slice(0, 10)}` : 'no dated sessions'
    const sources = c.sources.map((s) => `${s.source ?? '(none)'} ${s.count}`).join(', ') || '(none)'
    out.push('## Coverage', '')
    out.push(`- ${c.sessions} sessions, ${span}`)
    out.push(`- sources: ${sources}`)
    out.push(`- ${c.repos} repos, ${c.cwds} working dirs`)
    out.push(`- last analyzed: ${c.lastAnalyzedAt ?? 'unknown'}`)
    if (c.roots.length) {
      out.push('- analyzed directories:')
      for (const r of c.roots) {
        out.push(`    ${r.path} (${r.source ?? '?'}) — ${r.lastAnalyzedAt?.slice(0, 10) ?? 'unknown'}`)
      }
    }
    out.push('')
  }
  out.push('## Tables', '')
  for (const t of dump.tables) out.push(`${t.sql.trim()};`, '')
  out.push('## Facets (chartable/filterable dimensions)', '')
  for (const f of dump.facets) {
    out.push(`- ${f.key} (${f.type}, ${f.source}${f.column && f.column !== f.key ? ` → ${f.column}` : ''}${f.base ? `, base: ${f.base}` : ''})`)
  }
  out.push('', '## Measures (aggregations)', '')
  for (const m of dump.measures) {
    out.push(`- ${m.key} = ${m.agg}(${m.expr}) [${m.source}]`)
  }
  out.push('')
  return `${out.join('\n')}\n`
}
