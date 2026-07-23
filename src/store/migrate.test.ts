import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { Store } from './store'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tuneloop-migrate-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a store, then replace detector_runs with its pre-log shape (keyed on
 * `detector`, no `id`) — the state a store created before schema 18 is in.
 * Reopening it runs the rebuild migration.
 */
function seedPreLogStore(rows: Array<[string, number, string | null, string | null, number | null]>): string {
  const path = join(dir, `m${n++}.db`)
  const db = openDb(path)
  db.exec(`
    DROP TABLE detector_runs;
    CREATE TABLE detector_runs (
      detector    TEXT PRIMARY KEY,
      version     INTEGER NOT NULL,
      status      TEXT,
      model       TEXT,
      in_tokens   INTEGER,
      out_tokens  INTEGER,
      cost_usd    REAL,
      ran_at      TEXT NOT NULL
    );
  `)
  const stmt = db.prepare(
    'INSERT INTO detector_runs (detector, version, status, model, in_tokens, out_tokens, cost_usd, ran_at) VALUES (?,?,?,?,NULL,NULL,?,?)',
  )
  for (const [detector, version, status, model, cost] of rows) {
    stmt.run(detector, version, status, model, cost, '2026-07-01T00:00:00Z')
  }
  db.close()
  return path
}

describe('detector_runs → append-only log migration', () => {
  it('carries each detector\'s surviving row over as its first log entry', () => {
    const path = seedPreLogStore([
      ['themes', 2, 'ok', 'claude-haiku-4-5', 0.42],
      ['cache-miss', 1, 'ok', null, null], // S-tier: no model, no spend
    ])
    const db = openDb(path)
    const rows = db.prepare('SELECT id, detector, version, status, model, cost_usd FROM detector_runs ORDER BY detector').all()
    expect(rows).toEqual([
      { id: expect.any(Number), detector: 'cache-miss', version: 1, status: 'ok', model: null, cost_usd: null },
      { id: expect.any(Number), detector: 'themes', version: 2, status: 'ok', model: 'claude-haiku-4-5', cost_usd: 0.42 },
    ])
    db.close()
  })

  it('coalesces a NULL status — the old column was nullable, the new one is NOT NULL', () => {
    // A NULL would fail the insert and leave the store unopenable, so this is the
    // difference between a migration and a brick.
    const path = seedPreLogStore([['legacy', 1, null, null, null]])
    const db = openDb(path)
    expect(db.prepare('SELECT status FROM detector_runs WHERE detector = ?').get('legacy')).toMatchObject({ status: 'ok' })
    db.close()
  })

  it('appends after migrating instead of overwriting the carried-over row', () => {
    const path = seedPreLogStore([['themes', 2, 'ok', 'claude-haiku-4-5', 0.42]])
    const db = openDb(path)
    const store = new Store(db)
    store.persistDetectorError('themes', 2)
    const rows = db.prepare('SELECT status, model, cost_usd FROM detector_runs WHERE detector = ? ORDER BY id').all('themes')
    expect(rows).toEqual([
      { status: 'ok', model: 'claude-haiku-4-5', cost_usd: 0.42 },
      { status: 'error', model: null, cost_usd: null },
    ])
    // Pre-migration spend and model both survive the error run.
    expect(store.detectorLastSuccessfulModel('themes')).toBe('claude-haiku-4-5')
    expect(store.summary().analysisCostUsd).toBeCloseTo(0.42, 5)
    db.close()
  })

  it('is idempotent — reopening an already-migrated store changes nothing', () => {
    const path = seedPreLogStore([['themes', 2, 'ok', 'claude-haiku-4-5', 0.42]])
    openDb(path).close()
    const db = openDb(path) // migrate() runs on every openDb, gated on the `id` column
    expect(db.prepare('SELECT COUNT(*) AS c FROM detector_runs').get()).toMatchObject({ c: 1 })
    db.close()
  })
})
