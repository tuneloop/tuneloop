import { describe, expect, it, beforeEach } from 'vitest'
import { openDb } from './db'
import { Store } from './store'

// Reviewed session<->artifact links must never be counted as PRODUCTION work in
// the Highlights digest (mirrors the cost-per-artifact guards in review-cost.test).
// Scenario, all merged (completed_at set), all-time window:
//   PR #100 — you BUILT it.  session P $10 (contributed)
//   PR #200 — a teammate's, you REVIEWED. session R $50 (reviewed) — costly review
//   PR #300 — you BUILT ($20) and someone REVIEWED ($8) it.
// Without the guards: #200 ($50) would be the costliest "shipped" PR, #300 would
// cost $28, and shipped spend would swallow the whole $88. With them: #200 is not
// yours to spotlight, #300 costs only its $20 production, shipped spend is $30.
type DB = ReturnType<typeof openDb>

function addSession(db: DB, id: string, cost: number) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, started_at, ended_at, cost_usd) VALUES (?,?,?,?,?,?,?)')
    .run(id, id, 'claude-code', 'anthropic', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', cost)
}
function addUsageBlock(db: DB, sid: string, blockIdx: number, usageIdx: number, cost: number) {
  db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(sid, usageIdx, 'm', 0, '2026-06-01T00:00:00Z', 0, 0, 0, 0, cost)
  db.prepare('INSERT OR IGNORE INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
    .run(sid, blockIdx, blockIdx, blockIdx, 'x', 'segment-blocks')
  db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx, producer) VALUES (?,?,?,?)')
    .run(sid, usageIdx, blockIdx, 'segment-blocks')
}
function addPr(db: DB, id: string) {
  db.prepare("INSERT INTO artifacts (id, kind, ident, completed_at) VALUES (?, 'pr', ?, ?)").run(id, id.split(':').pop(), '2026-06-01T00:00:00Z')
}
function sessLink(db: DB, sid: string, artId: string, role: string) {
  db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)').run(sid, artId, role, 'x', 'p')
}
function blockLink(db: DB, sid: string, blockIdx: number, artId: string, role: string) {
  db.prepare('INSERT INTO block_artifacts (session_id, block_idx, artifact_id, role, source, producer) VALUES (?,?,?,?,?,?)').run(sid, blockIdx, artId, role, 'x', 'p')
}

let db: DB
let store: Store

beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)

  // PR #100 — built by P ($10)
  addSession(db, 'P', 10); addPr(db, 'pr:o/r:100')
  addUsageBlock(db, 'P', 0, 0, 10)
  blockLink(db, 'P', 0, 'pr:o/r:100', 'contributed'); sessLink(db, 'P', 'pr:o/r:100', 'created')

  // PR #200 — reviewed-only by R ($50, a teammate's PR)
  addSession(db, 'R', 50); addPr(db, 'pr:o/r:200')
  addUsageBlock(db, 'R', 0, 0, 50)
  blockLink(db, 'R', 0, 'pr:o/r:200', 'reviewed'); sessLink(db, 'R', 'pr:o/r:200', 'reviewed')

  // PR #300 — built by Q ($20), reviewed by S ($8)
  addSession(db, 'Q', 20); addPr(db, 'pr:o/r:300')
  addUsageBlock(db, 'Q', 0, 0, 20)
  blockLink(db, 'Q', 0, 'pr:o/r:300', 'contributed'); sessLink(db, 'Q', 'pr:o/r:300', 'created')
  addSession(db, 'S', 8)
  addUsageBlock(db, 'S', 0, 0, 8)
  blockLink(db, 'S', 0, 'pr:o/r:300', 'reviewed'); sessLink(db, 'S', 'pr:o/r:300', 'reviewed')
})

describe('Highlights exclude reviewed links from production math', () => {
  it('spotlights the costliest PRODUCED PR, not the costlier reviewed-only one', () => {
    const hs = store.highlights()
    const big = hs.find((h) => h.kind === 'biggest_shipped')!
    expect(big).toBeTruthy()
    expect(big.artifactKind).toBe('pr')
    expect(big.ident).toBe('300') // #300 ($20 production), NOT the reviewed-only #200 ($50)
    expect(big.cost).toBe(20) // production block only — the reviewed $8 on #300 is excluded
  })

  it('never surfaces a PR you only reviewed', () => {
    const hs = store.highlights()
    expect(hs.some((h) => h.ident === '200')).toBe(false)
  })

  it('counts only production spend as "shipped" in converted_spend', () => {
    const conv = store.highlights().find((h) => h.kind === 'converted_spend')!
    expect(conv).toBeTruthy()
    expect(conv.total).toBe(88) // all spend: $10 + $50 + $20 + $8
    expect(conv.shipped).toBe(30) // produced sessions only: P $10 + Q $20 (reviewers R, S excluded)
    expect(conv.pct).toBe(34) // round(100 * 30 / 88)
  })
})
