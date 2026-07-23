import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DROP_SHARE, HIT_READ_SHARE, MIN_CONTEXT_TOKENS, PEAK_FLOOR, SHRUNK_CTX_SHARE } from '../core/thresholds'
import { openDb, type DB } from './db'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tuneloop-views-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seedSession(db: DB, id: string, opts: { repo?: string; provider?: string; startedAt?: string } = {}): void {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at) VALUES (?,?,?,?,?,?)').run(
    id,
    id,
    'claude-code',
    opts.provider ?? 'anthropic',
    opts.repo ?? 'o/r',
    opts.startedAt ?? '2026-07-01T00:00:00Z',
  )
}

interface TurnCols {
  input?: number
  output?: number
  creates5m?: number
  creates1h?: number
  reads?: number
  sidechain?: 0 | 1
  ts?: string
  model?: string
}

function seedTurn(db: DB, sessionId: string, idx: number, c: TurnCols = {}): void {
  db.prepare(
    `INSERT INTO usage_facts
       (session_id, idx, model, is_sidechain, ts, tok_input, tok_output,
        tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(
    sessionId,
    idx,
    c.model ?? 'claude-opus-4-8',
    c.sidechain ?? 0,
    c.ts ?? `2026-07-01T00:0${idx}:00Z`,
    c.input ?? 0,
    c.output ?? 0,
    c.creates5m ?? 0,
    c.creates1h ?? 0,
    c.reads ?? 0,
  )
}

function cnt(db: DB, view: string, sessionId?: string): number {
  const row = sessionId
    ? db.prepare(`SELECT COUNT(*) AS c FROM ${view} WHERE session_id = ?`).get(sessionId)
    : db.prepare(`SELECT COUNT(*) AS c FROM ${view}`).get()
  return (row as { c: number }).c
}

const viewSql = (db: DB, name: string): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(name) as { sql: string }).sql

describe('usage view infrastructure (W0)', () => {
  it('creates all four usage views on openDb', () => {
    const db = openDb(':memory:')
    const views = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(views).toEqual(
      expect.arrayContaining(['cache_classified_turn', 'cache_miss_event', 'compaction_event', 'usage_turns']),
    )
    db.close()
  })

  it('interpolates the shared thresholds from thresholds.ts into the view SQL', () => {
    const db = openDb(':memory:')
    const compaction = viewSql(db, 'compaction_event')
    expect(compaction).toContain(String(PEAK_FLOOR))
    expect(compaction).toContain(String(DROP_SHARE))
    const classified = viewSql(db, 'cache_classified_turn')
    expect(classified).toContain(String(MIN_CONTEXT_TOKENS))
    expect(classified).toContain(String(HIT_READ_SHARE))
    expect(classified).toContain(String(SHRUNK_CTX_SHARE))
    db.close()
  })
})

describe('usage_turns view', () => {
  it('filters all-zero rows before the LAG, so prev = previous REAL turn (landmine 1)', () => {
    const db = openDb(':memory:')
    seedSession(db, 's4')
    seedTurn(db, 's4', 0, { input: 100_000 })
    seedTurn(db, 's4', 1, {}) // all-zero: a content flush / ingest-deduped repeat, not an API call
    seedTurn(db, 's4', 2, { input: 30_000 })
    const rows = db
      .prepare('SELECT idx, occupancy, prev_occupancy FROM usage_turns WHERE session_id = ? ORDER BY idx')
      .all('s4')
    // The zero row is gone; idx 2's "previous" is idx 0 (100k), not the dropped 0-row.
    expect(rows).toEqual([
      { idx: 0, occupancy: 100_000, prev_occupancy: null },
      { idx: 2, occupancy: 30_000, prev_occupancy: 100_000 },
    ])
    db.close()
  })
})

describe('compaction_event view', () => {
  // s1: a peak→drop compaction (idx1), plus a boundary row (idx3) that only fires
  // under a looser DROP_SHARE — used by the reopen test below.
  function seedCompactionCorpus(db: DB): void {
    seedSession(db, 's1')
    seedTurn(db, 's1', 0, { input: 120_000 })
    seedTurn(db, 's1', 1, { input: 40_000 }) // 40k <= 120k*0.4 (=48k) → compaction
    seedTurn(db, 's1', 2, { input: 130_000 })
    seedTurn(db, 's1', 3, { input: 60_000 }) // 60k <= 130k*0.4 (=52k)? no. <= *0.5 (=65k)? yes
  }

  it('flags a >60% drop from a peak and respects the DROP_SHARE boundary', () => {
    const db = openDb(':memory:')
    seedCompactionCorpus(db)
    const rows = db.prepare('SELECT idx, dropped_tokens FROM compaction_event WHERE session_id = ? ORDER BY idx').all('s1')
    expect(rows).toEqual([{ idx: 1, dropped_tokens: 80_000 }])
    db.close()
  })

  it('does not let a sidechain turn become a main turn\'s "previous" (landmine 2)', () => {
    const db = openDb(':memory:')
    seedSession(db, 's3')
    seedTurn(db, 's3', 0, { input: 150_000, sidechain: 1 }) // subagent peak
    seedTurn(db, 's3', 1, { input: 40_000, sidechain: 0 }) // first MAIN turn — no real predecessor
    // Partition on (session_id, is_sidechain) → the main turn has no prior main
    // turn, so prev_occupancy is NULL and nothing is flagged. A session_id-only
    // partition would treat the 150k subagent turn as its predecessor and invent one.
    expect(cnt(db, 'compaction_event', 's3')).toBe(0)
    db.close()
  })

  it('recreates views unconditionally on reopen, overriding a stale definition (landmine 5 / acceptance)', () => {
    const path = join(dir, `reopen${n++}.db`)
    const db = openDb(path)
    seedCompactionCorpus(db)
    expect(cnt(db, 'compaction_event', 's1')).toBe(1) // code's DROP_SHARE = 0.4

    // Simulate an old store carrying a looser threshold's view definition. A CREATE
    // VIEW IF NOT EXISTS would leave this in place forever; the unconditional
    // DROP+CREATE on openDb must replace it.
    db.exec(`
      DROP VIEW compaction_event;
      CREATE VIEW compaction_event AS
      SELECT session_id, idx, ts, repo, model, prev_occupancy, occupancy,
             prev_occupancy - occupancy AS dropped_tokens
      FROM usage_turns
      WHERE is_sidechain = 0 AND prev_occupancy >= 100000 AND occupancy <= prev_occupancy * 0.5;
    `)
    expect(cnt(db, 'compaction_event', 's1')).toBe(2) // idx1 + idx3 under the looser 0.5
    db.close()

    const reopened = openDb(path) // must re-apply the code's definition
    expect(cnt(reopened, 'compaction_event', 's1')).toBe(1) // back to 0.4 — proves a constant change flows through
    reopened.close()
  })
})

describe('cache_classified_turn / cache_miss_event views', () => {
  it('classifies a cold read as a miss and a warm read as a hit', () => {
    const db = openDb(':memory:')
    seedSession(db, 's2')
    seedTurn(db, 's2', 0, { creates5m: 20_000 }) // caches 20k → new_ctx 20k
    seedTurn(db, 's2', 1, { input: 25_000 }) // reads 0 of a 20k prior ctx → MISS
    seedTurn(db, 's2', 2, { reads: 30_000 }) // reads back 30k of a 25k prior ctx → HIT
    const classified = db
      .prepare('SELECT idx, is_miss FROM cache_classified_turn WHERE session_id = ? ORDER BY idx')
      .all('s2')
    expect(classified).toEqual([
      { idx: 1, is_miss: 1 },
      { idx: 2, is_miss: 0 },
    ])
    const misses = db.prepare('SELECT idx, avoidable_tokens FROM cache_miss_event WHERE session_id = ?').all('s2')
    expect(misses).toEqual([{ idx: 1, avoidable_tokens: 20_000 }])
    db.close()
  })
})
