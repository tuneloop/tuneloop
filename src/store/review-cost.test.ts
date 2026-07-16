import { describe, expect, it, beforeEach } from 'vitest'
import { openDb } from './db'
import { Store } from './store'

// These tests seed the fact tables directly (no processors) to pin down exactly
// how reviewed links affect cost. Scenario:
//   PR #41  — you BUILT it.                block0 of A costs $4 (contributed)
//   PR #30  — a teammate's, you REVIEWED. block0 of B costs $1 (reviewed),
//             block1 of B costs $2 (unrelated other work, no artifact)
//   PR #50  — you BUILT and someone REVIEWED it. C block0 $3 (contributed),
//             D block0 $1 (reviewed)
// All three are merged (completed_at set).
type DB = ReturnType<typeof openDb>

function addSession(db: DB, id: string) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, started_at, ended_at, cost_usd) VALUES (?,?,?,?,?,?,?)')
    .run(id, id, 'claude-code', 'anthropic', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 0)
}
function addUsageBlock(db: DB, sid: string, blockIdx: number, usageIdx: number, cost: number) {
  db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create_5m, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)',
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
function reviewedOutcome(db: DB, sid: string, artId: string, ts: string) {
  db.prepare("INSERT INTO outcomes (session_id, type, artifact_id, ts, producer) VALUES (?, 'pr_reviewed', ?, ?, 'p')").run(sid, artId, ts)
}

let db: DB
let store: Store

beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)

  // PR #41 — built by A
  addSession(db, 'A'); addPr(db, 'pr:o/r:41')
  addUsageBlock(db, 'A', 0, 0, 4)
  blockLink(db, 'A', 0, 'pr:o/r:41', 'contributed'); sessLink(db, 'A', 'pr:o/r:41', 'created')

  // PR #30 — reviewed-only by B (block0 = review $1, block1 = other work $2)
  addSession(db, 'B'); addPr(db, 'pr:o/r:30')
  addUsageBlock(db, 'B', 0, 0, 1); addUsageBlock(db, 'B', 1, 1, 2)
  blockLink(db, 'B', 0, 'pr:o/r:30', 'reviewed'); sessLink(db, 'B', 'pr:o/r:30', 'reviewed')
  reviewedOutcome(db, 'B', 'pr:o/r:30', '2026-06-01T10:00:00Z')

  // PR #50 — built by C ($3), reviewed by D ($1)
  addSession(db, 'C'); addPr(db, 'pr:o/r:50')
  addUsageBlock(db, 'C', 0, 0, 3)
  blockLink(db, 'C', 0, 'pr:o/r:50', 'contributed'); sessLink(db, 'C', 'pr:o/r:50', 'created')
  addSession(db, 'D')
  addUsageBlock(db, 'D', 0, 0, 1)
  blockLink(db, 'D', 0, 'pr:o/r:50', 'reviewed'); sessLink(db, 'D', 'pr:o/r:50', 'reviewed')
  reviewedOutcome(db, 'D', 'pr:o/r:50', '2026-06-01T11:00:00Z')
})

describe('cost-per-shipped-artifact counts every PR you contributed to', () => {
  it('counts all merged PRs you authored OR reviewed, at full cost', () => {
    const { count, costPerUnit } = store.costPerArtifact('pr')
    expect(count).toBe(3) // #41, #50, AND the review-only #30 — all merged, all contributed to
    // numerator = full cost incl. review: #41 ($4) + #30 review ($1) + #50 ($3 prod + $1 review) = $9
    expect(costPerUnit).toBeCloseTo(3, 5) // 9 / 3
  })

  it('costPeriod throughput matches the KPI denominator (all contributed)', () => {
    expect(store.costPeriod('pr').throughput).toBe(3)
  })
})

describe('per-PR total cost = production + review (block-attributed)', () => {
  it('charges a reviewed PR only its review block, not the whole session', () => {
    const list = store.artifactList('pr')
    const pr30 = list.find((r) => r.id === 'pr:o/r:30')!
    expect(pr30.costUsd).toBe(1) // block0 ($1), NOT the whole B session ($1 + $2)
  })

  it('sums production + review for a PR that was both built and reviewed', () => {
    const list = store.artifactList('pr')
    const pr50 = list.find((r) => r.id === 'pr:o/r:50')!
    expect(pr50.costUsd).toBe(4) // production $3 + review $1
    const pr41 = list.find((r) => r.id === 'pr:o/r:41')!
    expect(pr41.costUsd).toBe(4) // production only
  })
})

describe('PRs reviewed series', () => {
  it('counts distinct PRs reviewed, dated at review time', () => {
    const { reviewed } = store.costCurves('pr', 'day')
    const total = reviewed.reduce((s, r) => s + r.count, 0)
    expect(total).toBe(2) // #30 and #50
  })

  it('is empty for features (no review signal)', () => {
    expect(store.costCurves('feature', 'day').reviewed).toEqual([])
  })
})

describe('cost treemap reconciles with the KPI (all contributed shipped artifacts)', () => {
  it('treemap total = cost-per-unit × count, review cost included', () => {
    const shipped = store.artifactList('pr', undefined, undefined, undefined, true)
    // Every merged PR you contributed to — including the review-only #30.
    expect(shipped.map((r) => r.id).sort()).toEqual(['pr:o/r:30', 'pr:o/r:41', 'pr:o/r:50'])
    const kpi = store.costPerArtifact('pr')
    expect(shipped.length).toBe(kpi.count) // same set / denominator (3)
    const total = shipped.reduce((s, r) => s + (r.costUsd || 0), 0)
    expect(total).toBe(9) // $4 + $1 + $4, review cost included
    expect(total).toBeCloseTo((kpi.costPerUnit || 0) * kpi.count, 5) // C = A × B
  })
})
