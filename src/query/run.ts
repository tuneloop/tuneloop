/**
 * The read-only SQL escape hatch: run arbitrary SELECTs over the local store for
 * the ~10 analyses the curated dashboard doesn't cover (sidechain cost split,
 * tool latency via duration_ms, token-type economics, PR cycle time, provider /
 * branch slicing, generic tool `action` breakdowns, …).
 *
 * Safety is layered — every query must clear all of these before a row is read:
 *   1. a SEPARATE connection opened `readonly` + `query_only` (never the Store's
 *      writable handle), so a write can't reach the on-disk DB even in principle;
 *   2. single-statement compilation — better-sqlite3's `prepare` throws on stacked
 *      SQL, killing `SELECT …; DROP …;` style injection;
 *   3. a leading-keyword allowlist (SELECT / WITH) — a readonly PRAGMA is still a
 *      "reader", so the reader gate alone would let `PRAGMA`/`ATTACH` through;
 *   4. the `stmt.reader === true` gate — a clear error instead of a cryptic one
 *      for anything non-row-returning that slips past (3);
 *   5. `session_blobs` is hard-excluded — it holds gzipped raw transcripts that
 *      can contain proprietary code and secrets; the fact tables are the surface;
 *   6. row / byte / wall-clock caps enforced while iterating, so a runaway query
 *      is bounded. (better-sqlite3 has no statement interrupt, so the time cap can
 *      only fire BETWEEN produced rows — a query slow to yield its first row still
 *      blocks. Acceptable for a local single-dev tool.)
 */
import Database from 'better-sqlite3'
import { INTRINSIC_FACETS, type FacetSpec } from '../core/facets'
import { INTRINSIC_MEASURES, type MeasureSpec } from '../core/measures'
import { openDb, type DB } from '../store/db'

export const DEFAULT_MAX_ROWS = 1000
export const DEFAULT_MAX_BYTES = 5_000_000
export const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Tables never reachable via ad-hoc query. `session_blobs` is the gzipped raw
 * transcript store — excluding it is the whole point of "query the facts, not the
 * transcripts". Kept as a list so a future curated-VIEW policy can extend it.
 */
export const FORBIDDEN_TABLES = ['session_blobs']

export interface QueryOptions {
  /** Stop after this many rows (default 1000). */
  maxRows?: number
  /** Stop once accumulated JSON size exceeds this (default 5MB). */
  maxBytes?: number
  /** Stop if row production exceeds this wall-clock budget (default 5s). */
  timeoutMs?: number
  /** Positional (?) or named (:name) bind parameters. */
  params?: unknown[] | Record<string, unknown>
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  /** Which cap ended the read early, or null if the full result fit. */
  truncated: 'rows' | 'bytes' | 'time' | null
  elapsedMs: number
}

/** Rejected before touching the DB: shape violations the SQL engine wouldn't flag. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryError'
  }
}

/** Strip leading line/block comments so the first real keyword can be checked. */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.trimStart()
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n')
      s = nl === -1 ? '' : t.slice(nl + 1)
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/')
      s = end === -1 ? '' : t.slice(end + 2)
    } else {
      return t
    }
  }
}

/** Enforce the static (pre-execution) guards: SELECT/WITH only, no forbidden tables. */
export function assertReadOnlyShape(sql: string): void {
  const head = stripLeadingComments(sql)
  if (!/^(select|with)\b/i.test(head)) {
    throw new QueryError('only read-only SELECT (or WITH … SELECT) queries are allowed')
  }
  for (const table of FORBIDDEN_TABLES) {
    if (new RegExp(`\\b${table}\\b`, 'i').test(sql)) {
      throw new QueryError(
        `${table} is excluded from tuneloop query — it holds raw session transcripts (code + secrets). Query the fact tables instead.`,
      )
    }
  }
}

/** Rough byte size of a row for the response cap; exact enough to bound memory. */
function approxBytes(row: unknown): number {
  try {
    return JSON.stringify(row)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Run a single read-only SELECT against the store at `dbPath`. Opens and closes
 * its own connection every call — cheap, and keeps this fully independent of any
 * live Store/serve handle. Throws {@link QueryError} for guard violations and
 * SQLite's own errors (syntax, unknown column) for genuine SQL mistakes.
 */
export function runQuery(dbPath: string, sql: string, opts: QueryOptions = {}): QueryResult {
  assertReadOnlyShape(sql)
  const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const params = opts.params ?? []

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = true')

    let stmt: Database.Statement
    try {
      stmt = db.prepare(sql) // throws on stacked statements — single-statement only
    } catch (err) {
      throw new QueryError((err as Error).message)
    }
    if (!stmt.reader) {
      throw new QueryError('only read-only SELECT queries are allowed')
    }

    const columns = stmt.columns().map((c) => c.name)
    const rows: Record<string, unknown>[] = []
    let bytes = 0
    let truncated: QueryResult['truncated'] = null
    const started = Date.now()

    const iter = stmt.iterate(...(Array.isArray(params) ? params : [params]))
    for (const row of iter as IterableIterator<Record<string, unknown>>) {
      if (rows.length >= maxRows) {
        truncated = 'rows'
        break
      }
      if (Date.now() - started > timeoutMs) {
        truncated = 'time'
        break
      }
      bytes += approxBytes(row)
      if (bytes > maxBytes) {
        truncated = 'bytes'
        break
      }
      rows.push(row)
    }
    // Breaking a for-of calls iter.return(), which better-sqlite3 uses to reset the
    // statement, so the connection is clean to close below.

    return { columns, rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - started }
  } finally {
    db.close()
  }
}

export interface SchemaTable {
  name: string
  /** The CREATE statement as SQLite normalized it — guaranteed in sync with the store. */
  sql: string
}

/** What's actually in the store — the extent, not the shape. Derived from `sessions`. */
export interface Coverage {
  sessions: number
  firstAt: string | null
  lastAt: string | null
  lastAnalyzedAt: string | null
  sources: { source: string | null; count: number }[]
  repos: number
  cwds: number
  /** Source directories scanned, with each one's last-analyzed time (empty on pre-v9 stores). */
  roots: { source: string | null; path: string; lastAnalyzedAt: string | null }[]
}

export interface SchemaDump {
  schemaVersion: number | null
  /** Store extent; null when reflecting the canonical (empty) schema. */
  coverage: Coverage | null
  tables: SchemaTable[]
  facets: FacetSpec[]
  measures: MeasureSpec[]
}

/** Aggregate the store's extent from `sessions` + the `last_analyze_at` meta row. */
export function coverageFromDb(db: DB): Coverage {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS sessions, MIN(started_at) AS firstAt, MAX(started_at) AS lastAt,
              COUNT(DISTINCT repo) AS repos, COUNT(DISTINCT cwd) AS cwds
         FROM sessions`,
    )
    .get() as { sessions: number; firstAt: string | null; lastAt: string | null; repos: number; cwds: number }
  const sources = db
    .prepare(`SELECT source, COUNT(*) AS count FROM sessions GROUP BY source ORDER BY count DESC`)
    .all() as { source: string | null; count: number }[]
  const lastAnalyzedAt =
    (db.prepare(`SELECT value FROM meta WHERE key = 'last_analyze_at'`).get() as { value?: string } | undefined)?.value ?? null
  return { ...agg, sources, lastAnalyzedAt, roots: analyzedRoots(db) }
}

/** Read the ingest-provenance table; [] on pre-v9 stores that predate it. */
function analyzedRoots(db: DB): Coverage['roots'] {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'analyzed_roots'`)
    .get()
  if (!exists) return []
  return db
    .prepare(`SELECT path, source, last_analyzed_at AS lastAnalyzedAt FROM analyzed_roots ORDER BY source, path`)
    .all() as Coverage['roots']
}

/**
 * Reflect the store's schema straight from `sqlite_master` (plus the intrinsic
 * facet/measure registries). Reading the live DDL means this can't drift from the
 * SCHEMA that actually built the store. `session_blobs` is omitted to match the
 * query surface. Shared by the CLI `--schema` dump and the skill generator (which
 * passes an in-memory store, so the checked-in skill doc stays in sync too).
 */
export function schemaFromDb(db: DB): SchemaDump {
  const tables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as SchemaTable[]
  const versionRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value?: string }
    | undefined
  return {
    schemaVersion: versionRow?.value ? Number(versionRow.value) : null,
    coverage: null, // shape only; describeSchema() fills coverage for a live store
    tables: tables.filter((t) => !FORBIDDEN_TABLES.includes(t.name)),
    facets: INTRINSIC_FACETS,
    measures: INTRINSIC_MEASURES,
  }
}

/** Open the store read-only and dump its schema (see {@link schemaFromDb}). */
export function describeSchema(dbPath: string): SchemaDump {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = true')
    const handle = db as unknown as DB
    return { ...schemaFromDb(handle), coverage: coverageFromDb(handle) }
  } finally {
    db.close()
  }
}

/** Build a fresh in-memory store purely to reflect the canonical schema (no data). */
export function canonicalSchema(): SchemaDump {
  const db = openDb(':memory:')
  try {
    return schemaFromDb(db)
  } finally {
    db.close()
  }
}
