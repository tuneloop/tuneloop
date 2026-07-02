import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type DB } from '../store/db'
import { Store } from '../store/store'
import {
  assertReadOnlyShape,
  canonicalSchema,
  describeSchema,
  QueryError,
  runQuery,
} from './run'

let dir: string
let dbPath: string
let seed: DB // kept open for the suite so the read-only connection can read the WAL

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tuneloop-query-'))
  dbPath = join(dir, 'store.sqlite')
  seed = openDb(dbPath)
  const s = (id: string, cost: number, startedAt: string) =>
    seed
      .prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at, cost_usd) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, id, 'claude-code', 'anthropic', 'o/r', '/tmp/o/r', startedAt, cost)
  s('s1', 1.5, '2026-01-01T00:00:00Z')
  s('s2', 2.5, '2026-02-01T00:00:00Z')
  seed.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_analyze_at', ?)").run('2026-02-02T00:00:00Z')
  new Store(seed).recordAnalyzedRoots([{ source: 'claude-code', path: '/home/u/.claude/projects' }], '2026-02-02T00:00:00Z')
  seed.prepare('INSERT INTO usage_facts (session_id, idx, model, is_sidechain, cost_usd) VALUES (?,?,?,?,?)').run('s1', 0, 'claude-opus-4-8', 0, 1.5)
  // A real secret-bearing blob row — the exclusion test must refuse to reach it.
  seed.prepare('INSERT INTO session_blobs (id, gz) VALUES (?, ?)').run('s1', Buffer.from('sk-super-secret'))
})

afterAll(() => {
  seed.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runQuery — happy path', () => {
  it('returns columns and rows for a SELECT', () => {
    const res = runQuery(dbPath, 'SELECT id, cost_usd FROM sessions ORDER BY id')
    expect(res.columns).toEqual(['id', 'cost_usd'])
    expect(res.rows).toEqual([
      { id: 's1', cost_usd: 1.5 },
      { id: 's2', cost_usd: 2.5 },
    ])
    expect(res.truncated).toBeNull()
  })

  it('supports WITH … SELECT (CTEs)', () => {
    const res = runQuery(dbPath, 'WITH t AS (SELECT cost_usd FROM sessions) SELECT SUM(cost_usd) AS total FROM t')
    expect(res.rows[0]?.total).toBe(4)
  })

  it('binds positional parameters', () => {
    const res = runQuery(dbPath, 'SELECT id FROM sessions WHERE cost_usd > ?', { params: [2] })
    expect(res.rows).toEqual([{ id: 's2' }])
  })

  it('reports columns even for an empty result', () => {
    const res = runQuery(dbPath, 'SELECT id FROM sessions WHERE 1 = 0')
    expect(res.columns).toEqual(['id'])
    expect(res.rows).toEqual([])
  })
})

describe('runQuery — read-only guards', () => {
  const rejects = (sql: string) => expect(() => runQuery(dbPath, sql)).toThrow(QueryError)

  it('rejects INSERT / UPDATE / DELETE', () => {
    rejects("INSERT INTO sessions (id) VALUES ('x')")
    rejects("UPDATE sessions SET cost_usd = 0")
    rejects('DELETE FROM sessions')
  })

  it('rejects PRAGMA and ATTACH even though a PRAGMA is technically a reader', () => {
    rejects('PRAGMA table_info(sessions)')
    rejects("ATTACH DATABASE '/tmp/evil.db' AS evil")
  })

  it('rejects stacked statements', () => {
    rejects('SELECT 1; SELECT 2')
    rejects("SELECT 1; DROP TABLE sessions")
  })

  it('allows a leading comment before SELECT', () => {
    const res = runQuery(dbPath, '-- a note\n/* block */ SELECT COUNT(*) AS n FROM sessions')
    expect(res.rows[0]?.n).toBe(2)
  })

  it('excludes session_blobs (raw transcripts)', () => {
    expect(() => runQuery(dbPath, 'SELECT * FROM session_blobs')).toThrow(/session_blobs is excluded/)
    // Even reached via a CTE / alias mention, the token guard refuses.
    expect(() => runQuery(dbPath, 'WITH b AS (SELECT gz FROM session_blobs) SELECT 1 FROM b')).toThrow(/session_blobs is excluded/)
  })
})

describe('runQuery — caps', () => {
  it('truncates at the row cap', () => {
    const res = runQuery(dbPath, 'SELECT id FROM sessions', { maxRows: 1 })
    expect(res.rowCount).toBe(1)
    expect(res.truncated).toBe('rows')
  })

  it('truncates at the byte cap', () => {
    const res = runQuery(dbPath, 'SELECT id FROM sessions', { maxBytes: 1 })
    expect(res.truncated).toBe('bytes')
  })
})

describe('assertReadOnlyShape', () => {
  it('accepts SELECT and WITH, rejects everything else', () => {
    expect(() => assertReadOnlyShape('SELECT 1')).not.toThrow()
    expect(() => assertReadOnlyShape('  with x as (select 1) select * from x')).not.toThrow()
    expect(() => assertReadOnlyShape('')).toThrow(QueryError)
    expect(() => assertReadOnlyShape('DROP TABLE sessions')).toThrow(QueryError)
  })
})

describe('schema dumps', () => {
  it('describeSchema lists fact tables, omits session_blobs, and carries registries', () => {
    const dump = describeSchema(dbPath)
    const names = dump.tables.map((t) => t.name)
    expect(names).toContain('sessions')
    expect(names).toContain('usage_facts')
    expect(names).not.toContain('session_blobs')
    expect(dump.facets.some((f) => f.key === 'model')).toBe(true)
    expect(dump.measures.some((m) => m.key === 'cost')).toBe(true)
    expect(dump.schemaVersion).toBeTypeOf('number')
  })

  it('canonicalSchema reflects the same tables with no live store', () => {
    const dump = canonicalSchema()
    expect(dump.tables.map((t) => t.name)).toContain('tool_calls')
    expect(dump.tables.map((t) => t.name)).not.toContain('session_blobs')
    expect(dump.coverage).toBeNull() // canonical shape carries no extent
  })

  it('describeSchema reports store coverage (extent) from sessions + meta', () => {
    const { coverage } = describeSchema(dbPath)
    expect(coverage).not.toBeNull()
    expect(coverage?.sessions).toBe(2)
    expect(coverage?.firstAt).toBe('2026-01-01T00:00:00Z')
    expect(coverage?.lastAt).toBe('2026-02-01T00:00:00Z')
    expect(coverage?.sources).toEqual([{ source: 'claude-code', count: 2 }])
    expect(coverage?.repos).toBe(1)
    expect(coverage?.cwds).toBe(1)
    expect(coverage?.lastAnalyzedAt).toBe('2026-02-02T00:00:00Z')
    expect(coverage?.roots).toEqual([
      { source: 'claude-code', path: '/home/u/.claude/projects', lastAnalyzedAt: '2026-02-02T00:00:00Z' },
    ])
  })

  it('coverage.roots is [] on a pre-v9 store without the provenance table', () => {
    const p = join(dir, 'pre-v9.sqlite')
    const old = openDb(p)
    old.exec('DROP TABLE analyzed_roots')
    old.close()
    expect(describeSchema(p).coverage?.roots).toEqual([])
  })
})
