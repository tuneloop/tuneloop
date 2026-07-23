import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DROP_SHARE,
  HIT_READ_SHARE,
  MIN_CONTEXT_TOKENS,
  PEAK_FLOOR,
  SHRUNK_CTX_SHARE,
} from '../core/thresholds'
import { openDb, type DB } from './db'

/**
 * W1 acceptance gate (see docs/plans/detector-global-storage.md → "Verification
 * harness"): the new SQL views must classify the SAME events as the detector loops
 * they replace — same session, same turn idx, same counts. A silent divergence here
 * would be very hard to spot after W2/W3 delete the loops, so we freeze the loops as
 * instrumented reference ports and diff them against the views over a shared corpus.
 *
 * The reference ports below are line-for-line copies of the classification in
 * `context-exhaustion.run()` and `cache-miss.run()`, instrumented to emit the event
 * IDENTITY (session#idx) the detectors only ever counted. They scan GLOBALLY (no
 * 30-day window) because the window is a scan boundary the detectors happen to apply,
 * not part of the per-turn classification — dropping it from BOTH sides diffs the
 * classification over every session, the stronger invariant.
 */

interface Row {
  s: string
  idx: number
  input: number
  output: number
  creates5m: number
  creates1h: number
  reads: number
}

function scanRows(db: DB): Map<string, Row[]> {
  const rows = db
    .prepare(
      `SELECT u.session_id AS s, u.idx AS idx,
              COALESCE(u.tok_input,0) AS input, COALESCE(u.tok_output,0) AS output,
              COALESCE(u.tok_cache_create_5m,0) AS creates5m,
              COALESCE(u.tok_cache_create_1h,0) AS creates1h,
              COALESCE(u.tok_cache_read,0) AS reads
       FROM usage_facts u JOIN sessions se ON se.id = u.session_id
       WHERE u.is_sidechain = 0
       ORDER BY u.session_id, u.idx`,
    )
    .all() as Row[]
  const bySession = new Map<string, Row[]>()
  for (const r of rows) {
    const list = bySession.get(r.s) ?? []
    list.push(r)
    bySession.set(r.s, list)
  }
  return bySession
}

// Port of context-exhaustion.run() classification → { "session#idx": droppedTokens }.
export function refCompactionEvents(db: DB): Map<string, number> {
  const out = new Map<string, number>()
  for (const facts of scanRows(db).values()) {
    let prevOcc = 0
    for (const f of facts) {
      const creates = f.creates5m + f.creates1h
      if (f.input + f.output + creates + f.reads === 0) continue // skip all-zero rows
      const occ = f.input + f.reads + creates
      if (prevOcc >= PEAK_FLOOR && occ <= prevOcc * DROP_SHARE) out.set(`${f.s}#${f.idx}`, prevOcc - occ)
      prevOcc = occ
    }
  }
  return out
}

// Port of cache-miss.run() classification → { "session#idx": {isMiss, avoidable} }.
// avoidable is only meaningful for a miss (JS computes it inside the miss branch), so
// it is null on hits — matching how the diff below reads the view.
export function refCacheEvents(db: DB): Map<string, { isMiss: number; avoidable: number | null }> {
  const out = new Map<string, { isMiss: number; avoidable: number | null }>()
  for (const facts of scanRows(db).values()) {
    // Session-level gate: provider reports caching at all somewhere in the session.
    if (!facts.some((f) => f.creates5m > 0 || f.creates1h > 0 || f.reads > 0)) continue
    let prevCtx = 0
    for (const f of facts) {
      const creates = f.creates5m + f.creates1h
      if (f.input + f.output + creates + f.reads === 0) continue
      const newCtx = f.reads + (creates > 0 ? creates : f.input)
      if (prevCtx >= MIN_CONTEXT_TOKENS && newCtx >= prevCtx * SHRUNK_CTX_SHARE) {
        const isMiss = f.reads < prevCtx * HIT_READ_SHARE ? 1 : 0
        const avoidable = isMiss ? Math.min(prevCtx - f.reads, creates > 0 ? creates : f.input) : null
        out.set(`${f.s}#${f.idx}`, { isMiss, avoidable })
      }
      prevCtx = newCtx
    }
  }
  return out
}

export function sqlCompactionEvents(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT session_id, idx, dropped_tokens FROM compaction_event').all() as Array<{
    session_id: string
    idx: number
    dropped_tokens: number
  }>
  return new Map(rows.map((r) => [`${r.session_id}#${r.idx}`, r.dropped_tokens]))
}

export function sqlCacheEvents(db: DB): Map<string, { isMiss: number; avoidable: number | null }> {
  const rows = db
    .prepare('SELECT session_id, idx, is_miss, avoidable_tokens FROM cache_classified_turn')
    .all() as Array<{ session_id: string; idx: number; is_miss: number; avoidable_tokens: number }>
  // Null out avoidable on hits so it lines up with the reference (which only records
  // it for misses); the miss-side value is diffed exactly.
  return new Map(
    rows.map((r) => [`${r.session_id}#${r.idx}`, { isMiss: r.is_miss, avoidable: r.is_miss ? r.avoidable_tokens : null }]),
  )
}

/** Sorted [key, value] pairs — Maps don't deep-equal by insertion order otherwise. */
function sorted<V>(m: Map<string, V>): Array<[string, V]> {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

// ---------------------------------------------------------------------------
// (a) Synthetic corpus — deterministic, exercises every landmine, runs in CI.
// ---------------------------------------------------------------------------

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tuneloop-diff-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seedSession(db: DB, id: string): void {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at) VALUES (?,?,?,?,?,?)').run(
    id,
    id,
    'claude-code',
    'anthropic',
    'o/r',
    '2026-07-01T00:00:00Z',
  )
}

interface Cols {
  input?: number
  creates5m?: number
  creates1h?: number
  reads?: number
  sidechain?: 0 | 1
}
function seedTurn(db: DB, s: string, idx: number, c: Cols = {}): void {
  db.prepare(
    `INSERT INTO usage_facts
       (session_id, idx, model, is_sidechain, ts, tok_input, tok_output,
        tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd)
     VALUES (?,?,?,?,?,?,0,?,?,?,0)`,
  ).run(s, idx, 'claude-opus-4-8', c.sidechain ?? 0, `2026-07-01T00:0${idx}:00Z`, c.input ?? 0, c.creates5m ?? 0, c.creates1h ?? 0, c.reads ?? 0)
}

function buildSyntheticCorpus(db: DB): void {
  // compaction boundary + a row that only fires under a looser DROP_SHARE
  seedSession(db, 'comp')
  seedTurn(db, 'comp', 0, { input: 120_000 })
  seedTurn(db, 'comp', 1, { input: 40_000 }) // 40k <= 48k → compaction
  seedTurn(db, 'comp', 2, { input: 130_000 })
  seedTurn(db, 'comp', 3, { input: 60_000 }) // 60k > 52k → NOT a compaction

  // landmine 1: a zero row between two real turns must not fake a drop
  seedSession(db, 'zero')
  seedTurn(db, 'zero', 0, { input: 100_000 })
  seedTurn(db, 'zero', 1, {}) // all-zero
  seedTurn(db, 'zero', 2, { input: 50_000 }) // 50k > 40k → not a compaction; the 0-row must be invisible

  // landmine 2: an interleaved sidechain turn must not become a main turn's "previous"
  seedSession(db, 'side')
  seedTurn(db, 'side', 0, { input: 150_000, sidechain: 1 }) // subagent peak
  seedTurn(db, 'side', 1, { input: 40_000, sidechain: 0 }) // first MAIN turn — no real predecessor

  // cache: a cold read (miss) then a warm read (hit)
  seedSession(db, 'cache')
  seedTurn(db, 'cache', 0, { creates5m: 20_000 })
  seedTurn(db, 'cache', 1, { input: 25_000 }) // reads 0 of 20k prior → MISS
  seedTurn(db, 'cache', 2, { reads: 30_000 }) // reads 30k of 25k prior → HIT

  // landmine 3: an early classified turn with no cache of its own is still gated by
  // the WHOLE-session max, not a running max — a running max would drop it.
  seedSession(db, 'runmax')
  seedTurn(db, 'runmax', 0, { input: 20_000 }) // new_ctx 20k, no cache
  seedTurn(db, 'runmax', 1, { input: 25_000 }) // classified miss — gate must see the later cache row
  seedTurn(db, 'runmax', 2, { reads: 30_000 }) // the only cache in the session

  // a shrunk-context rewrite: new_ctx < half of prev_ctx → neither hit nor miss
  seedSession(db, 'rewrite')
  seedTurn(db, 'rewrite', 0, { input: 40_000 })
  seedTurn(db, 'rewrite', 1, { reads: 5_000 }) // new_ctx 5k < 20k → excluded from classification
}

describe('view↔detector diff (W1 acceptance) — synthetic corpus', () => {
  it('compaction_event matches the context-exhaustion loop event-for-event', () => {
    const db = openDb(join(dir, 'synthetic.db'))
    buildSyntheticCorpus(db)
    expect(sorted(sqlCompactionEvents(db))).toEqual(sorted(refCompactionEvents(db)))
    // Guard against a trivially-empty diff: the corpus really does contain the one event.
    expect(sqlCompactionEvents(db).size).toBe(1)
    expect([...sqlCompactionEvents(db).keys()]).toEqual(['comp#1'])
    db.close()
  })

  it('cache_classified_turn / cache_miss_event match the cache-miss loop event-for-event', () => {
    const db = openDb(join(dir, 'synthetic2.db'))
    buildSyntheticCorpus(db)
    expect(sorted(sqlCacheEvents(db))).toEqual(sorted(refCacheEvents(db)))
    // The corpus has exactly two misses (cache#1, runmax#1) and one hit (cache#2).
    const miss = [...sqlCacheEvents(db).entries()].filter(([, v]) => v.isMiss === 1).map(([k]) => k).sort()
    expect(miss).toEqual(['cache#1', 'runmax#1'])
    db.close()
  })
})

// ---------------------------------------------------------------------------
// (b) Real store — opt-in. Point TUNELOOP_DIFF_STORE at a COPY of a store
//     (openDb mutates: it creates views + bumps schema_version). Never the live one.
// ---------------------------------------------------------------------------

const realStore = process.env.TUNELOOP_DIFF_STORE
describe('view↔detector diff (W1 acceptance) — real store', () => {
  it.runIf(!!realStore)('classification matches the JS loops over the real corpus', () => {
    const db = openDb(realStore as string)
    const comp = { sql: sqlCompactionEvents(db), ref: refCompactionEvents(db) }
    const cache = { sql: sqlCacheEvents(db), ref: refCacheEvents(db) }
    console.log(
      `[real-store diff] compactions: sql=${comp.sql.size} ref=${comp.ref.size}; ` +
        `classified: sql=${cache.sql.size} ref=${cache.ref.size}; ` +
        `misses: sql=${[...cache.sql.values()].filter((v) => v.isMiss).length}`,
    )
    expect(sorted(comp.sql)).toEqual(sorted(comp.ref))
    expect(sorted(cache.sql)).toEqual(sorted(cache.ref))
    db.close()
  })
})
