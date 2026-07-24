/**
 * Skill drift & version-comparison tests. Exercises the version-timeline
 * reconstruction (append-on-change snapshot diffing) and the symmetric,
 * edit-bounded before/after delta — including the edge cases the synthetic
 * generator plants: a multi-edit skill, a lost intermediate, an A→B→A revert.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { skillDrift } from './skill-health'
import { seedSkillStore } from './skill-seed'

const NOW = Date.parse('2026-07-22T00:00:00.000Z')
const SOURCE = 'claude-code'
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

describe('skillDrift', () => {
  let dir: string
  let dbN = 0
  let db: ReturnType<typeof openDb>
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-drift-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `t${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  it('reports noHistory when no skills snapshot exists', () => {
    const r = skillDrift(store, 'whatever', NOW)
    expect(r.noHistory).toBe(true)
    expect(r.versions).toEqual([])
    expect(r.delta).toBeNull()
  })

  it('reconstructs review three-version timeline with per-version usage', () => {
    const exp = seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', NOW)
    expect(r.noHistory).toBe(false)
    expect(r.singleVersion).toBe(false)
    // Three distinct captured versions, oldest→newest, matching the manifest hashes.
    expect(r.versions.map((v) => v.bodyHash)).toEqual(exp.reviewHashes)
    // Only the last is current; each earlier version has an end boundary.
    expect(r.versions[r.versions.length - 1]!.current).toBe(true)
    expect(r.versions[0]!.endIso).not.toBeNull()
    // Each era was seeded with 6 dense invocations → clears the sample guard.
    for (const v of r.versions) {
      expect(v.usage.calls).toBeGreaterThanOrEqual(3)
      expect(v.enoughData).toBe(true)
    }
  })

  it('produces a before/after delta on symmetric edit-bounded windows', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', NOW)
    expect(r.delta).not.toBeNull()
    const d = r.delta!
    // The edit boundary is the current version's start (most recent edit = 20d ago).
    expect(d.editIso).toBe(r.versions[r.versions.length - 1]!.startIso)
    // Both sides have usage in the seed → the delta is trustworthy.
    expect(d.enoughData).toBe(true)
    expect(d.before.calls).toBeGreaterThan(0)
    expect(d.after.calls).toBeGreaterThan(0)
    // Symmetric half-window is capped at 30d and never negative.
    expect(d.windowDays).toBeGreaterThan(0)
    expect(d.windowDays).toBeLessThanOrEqual(30)
  })

  it('collapses a lost intermediate: drifty shows only two captured versions', () => {
    seedSkillStore(store, { nowMs: NOW })
    // drifty was edited between captures without an analyze in between → the middle
    // body never made it into a snapshot, so only two versions are recoverable.
    const r = skillDrift(store, 'drifty', NOW)
    expect(r.versions.length).toBe(2)
  })

  it('treats an A→B→A revert as three distinct segments', () => {
    seedSkillStore(store, { nowMs: NOW })
    // reverter went A(60d) → B(40d) → A(20d). The final revert to A is byte-identical
    // to v1, but it's a distinct period, so we honestly show three segments.
    const r = skillDrift(store, 'reverter', NOW)
    expect(r.versions.length).toBe(3)
    expect(r.versions[0]!.bodyHash).toBe(r.versions[2]!.bodyHash) // A == A
    expect(r.versions[1]!.bodyHash).not.toBe(r.versions[0]!.bodyHash) // B != A
  })

  it('withholds the delta when a side is too thin', () => {
    // A skill edited once, but with only 1 call after the edit → not enough to judge.
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'thin', body: 'v1', bodyHash: 'h1' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'thin', body: 'v2', bodyHash: 'h2' }], count: 1 } },
      iso(10),
    )
    // 4 calls before the edit, 1 after.
    const mk = (id: string, daysAgo: number) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, 'r', ?, 1, 1)`).run(id, id, SOURCE, iso(daysAgo))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, 0, 'thin', 'skill', 1, 0, 0, ?)`).run(id, iso(daysAgo))
    }
    mk('b0', 18); mk('b1', 16); mk('b2', 14); mk('b3', 12)
    mk('a0', 8)
    const r = skillDrift(store, 'thin', NOW)
    expect(r.delta).not.toBeNull()
    expect(r.delta!.after.calls).toBe(1)
    expect(r.delta!.enoughData).toBe(false) // after side below MIN_DRIFT_CALLS
  })
})
