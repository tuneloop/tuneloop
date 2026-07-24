/**
 * Contract test for the synthetic skill-data generator (scripts/seed-skills.ts).
 * Locks the generator's EXPECTATIONS manifest against the current read model, so the
 * edge-case corpus every Skills feature builds on stays trustworthy. If the generator
 * drifts from what the read model reports, this fails before any feature test does.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { skillHealth } from './skill-health'
import { seedSkillStore } from '../../scripts/seed-skills'

const NOW = Date.parse('2026-07-22T00:00:00.000Z')

describe('synthetic skill seed', () => {
  let dir: string
  let dbN = 0
  let db: ReturnType<typeof openDb>
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-synth-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `t${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  it('produces the used/unused/flag facts the manifest promises (30d window)', () => {
    const exp = seedSkillStore(store, { nowMs: NOW })
    const r = skillHealth(store, { days: 30, nowMs: NOW })
    const byName = new Map(r.rows.map((x) => [x.name, x]))

    // config was captured
    expect(r.noConfig).toBe(false)

    // used vs unused
    for (const n of exp.used) expect(byName.get(n)?.status, `${n} used`).toBe('used')
    for (const n of exp.unused) expect(byName.get(n)?.status, `${n} unused`).toBe('unused')

    // unused-but-plenty-of-sessions → enoughData true (safe to advise removal)
    expect(byName.get('deadskill')?.enoughData).toBe(true)

    // scope-down candidates carry the flag + the exact repos as evidence
    for (const { name, repos } of exp.scopeDown) {
      const row = byName.get(name)!
      expect(row.flags, `${name} scope-down`).toContain('scope-down')
      expect(row.scopeToRepos).toEqual(repos)
    }
    // the broadly-used skill must NOT be scope-down
    const broad = byName.get(exp.notScopeDown.name)!
    expect(broad.flags).not.toContain('scope-down')
    expect(broad.usedRepos).toEqual(exp.notScopeDown.repos)

    // not-in-config: invoked but absent from every snapshot
    for (const n of exp.notInConfig) {
      const row = byName.get(n)!
      expect(row.flags, `${n} not-in-config`).toContain('not-in-config')
      expect(row.installed).toBe(false)
    }

    // plugin-namespaced invocation reconciled to its installed name (single row)
    expect(r.rows.filter((x) => x.name.includes('frontend-design')).length).toBe(1)
  })

  it('captures review version history with a lost intermediate for drifty', () => {
    const exp = seedSkillStore(store, { nowMs: NOW })
    // The skills-category snapshots are the version history source. Read them back.
    const rows = store.queryAll(
      `SELECT snapshot_json, captured_at FROM environment_snapshots
       WHERE source='claude-code' AND scope='global' AND scope_key='_global' AND category='skills'
       ORDER BY captured_at ASC`,
    ) as Array<{ snapshot_json: string; captured_at: string }>

    const hashOf = (json: string, skill: string): string | undefined => {
      const payload = JSON.parse(json) as { skills?: Array<{ name: string; bodyHash?: string }> }
      return payload.skills?.find((s) => s.name === skill)?.bodyHash
    }

    // review: three DISTINCT captured bodyHashes across the timeline (v1→v2→v3),
    // matching the manifest. The final "no change" capture doesn't add a 4th row.
    const reviewHashSeq = rows.map((r) => hashOf(r.snapshot_json, 'review')!)
    const distinctReview = [...new Set(reviewHashSeq)]
    expect(distinctReview).toEqual(exp.reviewHashes)

    // drifty: only TWO distinct captured hashes even though there was an intermediate
    // edit — because no snapshot was recorded between v1 and v2 (lost-intermediate).
    const driftHashes = [...new Set(rows.map((r) => hashOf(r.snapshot_json, 'drifty')!))]
    expect(driftHashes.length).toBe(2)
  })
})
