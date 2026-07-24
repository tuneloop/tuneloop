/**
 * Skill co-occurrence tests — which other skills fire in the same sessions, and the
 * light "tends to precede" ordering signal. Uses the synthetic corpus, where `review`
 * co-occurs with grill-with-docs + lint-fix in a known number of sessions.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { skillCoOccurrence } from './skill-health'
import { seedSkillStore } from './skill-seed'

const NOW = Date.parse('2026-07-22T00:00:00.000Z')
const SOURCE = 'claude-code'
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

describe('skillCoOccurrence', () => {
  let dir: string
  let dbN = 0
  let db: ReturnType<typeof openDb>
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-cooc-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `t${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  it('returns empty when the skill was never invoked in the window', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillCoOccurrence(store, 'deadskill', { days: 30, nowMs: NOW })
    expect(r.totalSessions).toBe(0)
    expect(r.items).toEqual([])
  })

  it('lists the skills review co-occurs with, from the synthetic corpus', () => {
    const exp = seedSkillStore(store, { nowMs: NOW })
    const r = skillCoOccurrence(store, 'review', { days: 30, nowMs: NOW })
    const byName = new Map(r.items.map((i) => [i.name, i]))
    // review never appears as its own co-occurrence.
    expect(byName.has('review')).toBe(false)
    // The manifest promises review co-occurs with grill-with-docs + lint-fix (4 each).
    for (const { b, sessions } of exp.coOccur) {
      const it = byName.get(b)!
      expect(it, `${b} present`).toBeDefined()
      expect(it.sessions).toBe(sessions)
      // share is co-sessions / review's total sessions, in (0, 1].
      expect(it.share).toBeGreaterThan(0)
      expect(it.share).toBeLessThanOrEqual(1)
    }
  })

  it('counts a co-occurring skill once even when plugin-namespaced', () => {
    // Two sessions: one invokes review + a bare 'helper', one invokes review + 'plug:helper'.
    // Both should fold into a single 'helper' co-occurrence with 2 sessions.
    const mk = (id: string, daysAgo: number, calls: string[]) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, 'r', ?, 1, ?)`).run(id, id, SOURCE, iso(daysAgo), calls.length)
      calls.forEach((n, idx) =>
        db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, ?, ?, 'skill', 1, 0, 0, ?)`).run(id, idx, n, iso(daysAgo)),
      )
    }
    mk('s1', 3, ['review', 'helper'])
    mk('s2', 2, ['review', 'plug:helper'])
    const r = skillCoOccurrence(store, 'review', { days: 30, nowMs: NOW })
    const helper = r.items.find((i) => i.name === 'helper')!
    expect(helper).toBeDefined()
    expect(helper.sessions).toBe(2)
    expect(r.items.some((i) => i.name === 'plug:helper')).toBe(false)
  })

  it('reports the ordering signal when another skill fires first', () => {
    const mk = (id: string, daysAgo: number, calls: string[]) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, 'r', ?, 1, ?)`).run(id, id, SOURCE, iso(daysAgo), calls.length)
      calls.forEach((n, idx) =>
        db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, ?, ?, 'skill', 1, 0, 0, ?)`).run(id, idx, n, iso(daysAgo)),
      )
    }
    // 'setup' fires before 'review' in both sessions → precededSessions = 2.
    mk('o1', 3, ['setup', 'review'])
    mk('o2', 2, ['setup', 'review'])
    const r = skillCoOccurrence(store, 'review', { days: 30, nowMs: NOW })
    const setup = r.items.find((i) => i.name === 'setup')!
    expect(setup.sessions).toBe(2)
    expect(setup.precededSessions).toBe(2)
  })
})
