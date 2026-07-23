import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { skillHealth } from './skill-health'
import { MIN_SESSIONS } from '../detectors/unused-capabilities'

const SOURCE = 'claude-code'
const NOW = Date.parse('2026-07-22T00:00:00.000Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

let db: ReturnType<typeof openDb>

/** Insert a session with a run of skill/tool calls. calls: [{name, action, error?}] in idx order. */
function seedSession(
  id: string,
  repo: string | null,
  startedDaysAgo: number,
  calls: Array<{ name: string; action: string; error?: boolean }>,
) {
  db.prepare(
    `INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, id, SOURCE, repo, iso(startedDaysAgo), calls.length)
  calls.forEach((c, idx) => {
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, idx, c.name, c.action, c.error ? 0 : 1, c.error ? 1 : 0, iso(startedDaysAgo))
  })
}

/** Record a current global-skills snapshot with the given {name, description?} entries. */
function seedInstalledGlobal(store: Store, skills: Array<{ name: string; description?: string }>) {
  store.recordEnvSnapshot(
    { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills, count: skills.length } },
    iso(1),
  )
}

describe('skillHealth', () => {
  // queryAll() reopens the db file read-only, so tests need a real file, not :memory:.
  let dir: string
  let dbN = 0
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-health-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `t${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  it('returns noConfig when no skills snapshot exists', () => {
    const r = skillHealth(store, { nowMs: NOW })
    expect(r.noConfig).toBe(true)
    expect(r.rows).toEqual([])
  })

  it('marks an installed-but-never-invoked skill dead once enough sessions are observed', () => {
    seedInstalledGlobal(store, [{ name: 'deadskill', description: 'does nothing lately' }])
    // Enough total sessions to trust the absence (all in one repo, no skill calls).
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`s${i}`, 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'deadskill')!
    expect(row.verdict).toBe('dead')
    expect(row.description).toBe('does nothing lately')
    expect(r.totalDead).toBe(1)
  })

  it('marks an installed-but-unused skill idle when there is too little data to judge', () => {
    seedInstalledGlobal(store, [{ name: 'idleskill' }])
    // Below MIN_SESSIONS → absence is thin data, not disuse.
    seedSession('s0', 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    expect(r.rows.find((x) => x.name === 'idleskill')!.verdict).toBe('idle')
    expect(r.totalIdle).toBe(1)
  })

  it('counts invocations, sessions, and the friction-adjacency proxy', () => {
    seedInstalledGlobal(store, [{ name: 'usedskill', description: 'gets used' }])
    // Two sessions invoke it; in one, an errored tool call follows within the lookahead.
    seedSession('a', 'repoA', 3, [
      { name: 'usedskill', action: 'skill' },
      { name: 'Bash', action: 'shell', error: true },
    ])
    seedSession('b', 'repoA', 2, [{ name: 'usedskill', action: 'skill' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'usedskill')!
    expect(row.calls).toBe(2)
    expect(row.sessions).toBe(2)
    expect(row.frictionAdjacent).toBe(1)
    expect(row.verdict).not.toBe('dead')
  })

  it('surfaces an invoked-but-unregistered skill (not in any snapshot)', () => {
    seedInstalledGlobal(store, [{ name: 'other' }])
    seedSession('a', 'repoA', 2, [{ name: 'ghostskill', action: 'skill' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'ghostskill')!
    expect(row.verdict).toBe('unregistered')
    expect(row.installed).toBe(false)
  })

  it('reconciles a plugin-namespaced invocation to its installed entry', () => {
    seedInstalledGlobal(store, [{ name: 'frontend-design', description: 'design' }])
    seedSession('a', 'repoA', 2, [{ name: 'frontend-design:frontend-design', action: 'skill' }])
    const r = skillHealth(store, { nowMs: NOW })
    // Folded onto the installed name, not surfaced as a separate unregistered row.
    expect(r.rows.filter((x) => x.name.includes('frontend-design')).length).toBe(1)
    const row = r.rows.find((x) => x.name === 'frontend-design')!
    expect(row.calls).toBe(1)
    expect(row.installed).toBe(true)
  })

  it('windows the usage side: a short window excludes older invocations', () => {
    seedInstalledGlobal(store, [{ name: 'usedskill' }])
    seedSession('recent', 'repoA', 2, [{ name: 'usedskill', action: 'skill' }]) // 2 days ago
    seedSession('old', 'repoA', 40, [{ name: 'usedskill', action: 'skill' }]) // 40 days ago
    // 30-day window (default) sees only the recent call.
    expect(skillHealth(store, { nowMs: NOW }).rows.find((x) => x.name === 'usedskill')!.calls).toBe(1)
    // 7-day window still sees only the recent call; a 90-day window sees both.
    expect(skillHealth(store, { days: 7, nowMs: NOW }).rows.find((x) => x.name === 'usedskill')!.calls).toBe(1)
    expect(skillHealth(store, { days: 90, nowMs: NOW }).rows.find((x) => x.name === 'usedskill')!.calls).toBe(2)
  })

  it('echoes the window length back (null for all-time) and counts all-time usage', () => {
    seedInstalledGlobal(store, [{ name: 'usedskill' }])
    seedSession('old', 'repoA', 400, [{ name: 'usedskill', action: 'skill' }]) // beyond any preset
    expect(skillHealth(store, { days: 30, nowMs: NOW }).windowDays).toBe(30)
    const all = skillHealth(store, { days: null, nowMs: NOW })
    expect(all.windowDays).toBeNull()
    expect(all.rows.find((x) => x.name === 'usedskill')!.calls).toBe(1)
  })
})
