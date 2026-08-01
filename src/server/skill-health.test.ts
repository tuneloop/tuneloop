import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { skillHealth, skillInvocations, skillOutcomeStats } from './skill-health'
import { MIN_SESSIONS } from '../detectors/unused-capabilities'

const SOURCE = 'claude-code'
const NOW = Date.parse('2026-07-22T00:00:00.000Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

let db: ReturnType<typeof openDb>

/** Insert a session with a run of skill/tool calls. calls: [{name, action, error?, sidechain?}] in idx order. */
function seedSession(
  id: string,
  repo: string | null,
  startedDaysAgo: number,
  calls: Array<{ name: string; action: string; error?: boolean; sidechain?: boolean }>,
  source = SOURCE,
) {
  db.prepare(
    `INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, id, source, repo, iso(startedDaysAgo), calls.length)
  calls.forEach((c, idx) => {
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, idx, c.name, c.action, c.error ? 0 : 1, c.error ? 1 : 0, c.sidechain ? 1 : 0, iso(startedDaysAgo))
  })
}

/** Record a global-skills snapshot with the given entries (may carry kind:'command').
 *  `daysAgo` sets the capture time — removal advice needs tenure past the 10-day gate. */
function seedInstalledGlobal(
  store: Store,
  skills: Array<{ name: string; description?: string; kind?: string }>,
  source = SOURCE,
  daysAgo = 1,
) {
  store.recordEnvSnapshot(
    { source, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills, count: skills.length } },
    iso(daysAgo),
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
    // No source has skill data → we don't invent a harness name; source is '' and there's
    // nothing to offer in the chooser. The empty state is the honest signal, not a label.
    expect(r.source).toBe('')
    expect(r.availableSources).toEqual([])
  })

  it('marks an installed-but-never-invoked skill unused, with enoughData once sessions suffice', () => {
    // Installed 15 days ago — past the removal-tenure gate, so the absence is trustworthy.
    seedInstalledGlobal(store, [{ name: 'deadskill', description: 'does nothing lately' }], SOURCE, 15)
    // Enough total sessions to trust the absence (all in one repo, no skill calls).
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`s${i}`, 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'deadskill')!
    expect(row.status).toBe('unused')
    expect(row.enoughData).toBe(true) // safe to advise removal
    expect(row.flags).toEqual([])
    expect(row.description).toBe('does nothing lately')
    expect(r.totalUnused).toBe(1)
  })

  it('withholds removal advice for a freshly installed skill (tenure gate)', () => {
    // Snapshot only 1 day old: older in-window sessions predate the install, so "never
    // used" would be a false positive — mirror the detector's MIN_REMOVAL_TENURE_DAYS gate.
    seedInstalledGlobal(store, [{ name: 'newskill' }])
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`s${i}`, 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'newskill')!
    expect(row.status).toBe('unused') // the window-scoped fact is unchanged
    expect(row.enoughData).toBe(false) // but removal advice is withheld
  })

  it('marks an unused skill as unused with enoughData=false when there is too little to judge', () => {
    seedInstalledGlobal(store, [{ name: 'idleskill' }])
    // Below MIN_SESSIONS → still "unused in this window", but not enough to advise removal.
    seedSession('s0', 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'idleskill')!
    expect(row.status).toBe('unused')
    expect(row.enoughData).toBe(false) // widen the window before advising removal
    expect(r.totalUnused).toBe(1)
  })

  it('counts invocations, sessions, and the own-call error rate', () => {
    seedInstalledGlobal(store, [{ name: 'usedskill', description: 'gets used' }])
    // Two sessions invoke it; in one, the skill's own tool call errored.
    seedSession('a', 'repoA', 3, [{ name: 'usedskill', action: 'skill', error: true }])
    seedSession('b', 'repoA', 2, [{ name: 'usedskill', action: 'skill' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'usedskill')!
    expect(row.calls).toBe(2)
    expect(row.sessions).toBe(2)
    expect(row.errorCalls).toBe(1)
    expect(row.status).toBe('used')
    expect(r.totalUsed).toBe(1)
  })

  it('flags an invoked-but-unregistered skill as used + not-in-config', () => {
    seedInstalledGlobal(store, [{ name: 'other' }])
    seedSession('a', 'repoA', 2, [{ name: 'ghostskill', action: 'skill' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'ghostskill')!
    expect(row.status).toBe('used')
    expect(row.flags).toContain('not-in-config')
    expect(row.installed).toBe(false)
    expect(r.totalNotInConfig).toBe(1)
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

  it('keeps a used-but-scopeable global skill as used, with a scope-down flag', () => {
    // Regression: a global skill used in only a few of many repos must still count as
    // USED (not be reclassified away into a 'scope' bucket that starved the used count).
    seedInstalledGlobal(store, [{ name: 'browse' }])
    // Used in one repo; several other repos have sessions but never invoke it → scopeable.
    seedSession('u', 'repoA', 2, [{ name: 'browse', action: 'skill' }])
    for (let i = 0; i < 6; i++) seedSession(`o${i}`, `repo${i}`, 2, [{ name: 'Bash', action: 'shell' }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'browse')!
    expect(row.status).toBe('used')
    expect(row.flags).toContain('scope-down')
    expect(row.scopeToRepos).toEqual(['repoA'])
    expect(r.totalUsed).toBe(1)
    expect(r.totalScopeDown).toBe(1)
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

  it('echoes windowDays=-1 for a custom from/to range (the client renders the dates)', () => {
    // The sentinel the client keys on: -1 means "custom range — show the dates, not N days"
    // (fixing the old "in the last -1 days" copy). Pin the contract the client fix relies on.
    seedInstalledGlobal(store, [{ name: 'usedskill' }])
    const r = skillHealth(store, { from: iso(14), to: iso(0), nowMs: NOW })
    expect(r.windowDays).toBe(-1)
  })

  it('charts a plugin-namespaced skill on its installed-name sparkline', () => {
    // Regression: the spark map is keyed by the RAW invoked name, but the row keys by the
    // INSTALLED name. A namespaced-only skill (frontend-design:frontend-design) must still
    // sum its trend onto its installed `frontend-design` row, not flatline at zero.
    seedInstalledGlobal(store, [{ name: 'frontend-design' }])
    seedSession('a', 'repoA', 3, [{ name: 'frontend-design:frontend-design', action: 'skill' }])
    seedSession('b', 'repoA', 2, [{ name: 'frontend-design:frontend-design', action: 'skill' }])
    const row = skillHealth(store, { nowMs: NOW }).rows.find((x) => x.name === 'frontend-design')!
    expect(row.calls).toBe(2)
    // The sparkline must account for every call — its buckets sum to the call count.
    expect(row.spark.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('never reports usage in more repos than are active (denominator is a superset)', () => {
    // Regression: usage windows by tool-run time while the active-repo denominator windowed
    // by started_at, so a session that STARTED before the window but INVOKED the skill inside
    // it counted in usedRepos yet was absent from totalActiveRepos → "used in 1 of 0 repos".
    seedInstalledGlobal(store, [{ name: 'usedskill' }])
    db.prepare(
      `INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls)
       VALUES ('straddle', 'straddle', ?, 'lonelyrepo', ?, 1, 1)`,
    ).run(SOURCE, iso(40)) // started outside the 30d window
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES ('straddle', 0, 'usedskill', 'skill', 1, 0, 0, ?)`,
    ).run(iso(2)) // but invoked inside it
    const r = skillHealth(store, { days: 30, nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'usedskill')!
    // The repo it was used in is in the active-repo denominator, so N ≤ M holds.
    expect(row.usedRepos).toContain('lonelyrepo')
    expect(r.totalActiveRepos).toBeGreaterThanOrEqual(row.usedRepos.length)
  })

  it('normalizes non-Z (offset) timestamps so windowing matches the capability_usage view', () => {
    // Regression: direct reads compared t.ts lexicographically against Z-normalized bounds.
    // An offset ts sorts wrong as a raw string ('2026-…T05:30:00+05:30' > a Z bound of the
    // SAME instant), so it could be windowed on the wrong side. strftime folds the offset to
    // UTC before comparing. Here the same 2-days-ago instant is written as +05:30 wall time.
    seedInstalledGlobal(store, [{ name: 'offsetskill' }])
    const instantMs = NOW - 2 * 86_400_000
    const local = new Date(instantMs + 5.5 * 3_600_000).toISOString() // shift wall clock +5:30
    const offsetTs = local.replace('Z', '+05:30') // same instant, expressed in +05:30
    db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES ('o', 'o', ?, 'r', ?, 1, 1)`).run(SOURCE, iso(2))
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES ('o', 0, 'offsetskill', 'skill', 1, 0, 0, ?)`,
    ).run(offsetTs)
    const row = skillHealth(store, { days: 30, nowMs: NOW }).rows.find((x) => x.name === 'offsetskill')!
    expect(row.calls).toBe(1) // counted in-window despite the offset format
    // firstUsedAt/lastUsedAt come back Z-normalized (the view's contract), not the raw offset.
    expect(row.lastUsedAt).toMatch(/Z$/)
    expect(row.lastUsedAt).not.toContain('+05:30')
  })

  it('windows usage by tool-run time, not session start (a straddling session counts)', () => {
    seedInstalledGlobal(store, [{ name: 'usedskill' }])
    // A long session that STARTED 40 days ago (outside the 30d window) but invoked the
    // skill 2 days ago (inside it). Dated by tool-run time, that call is in-window; the
    // old started_at scan wrongly dropped it and misread the live skill as unused.
    db.prepare(
      `INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls)
       VALUES ('straddle', 'straddle', ?, 'repoA', ?, 1, 1)`,
    ).run(SOURCE, iso(40))
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES ('straddle', 0, 'usedskill', 'skill', 1, 0, 0, ?)`,
    ).run(iso(2))

    const row = skillHealth(store, { days: 30, nowMs: NOW }).rows.find((x) => x.name === 'usedskill')!
    expect(row.status).toBe('used')
    expect(row.calls).toBe(1) // the straddling call is counted in the 30d window
    // And a 1-day window (after the call ran) excludes it — proving it's the CALL's ts
    // that windows, not the session's start.
    const tight = skillHealth(store, { days: 1, nowMs: NOW }).rows.find((x) => x.name === 'usedskill')
    expect(tight?.calls ?? 0).toBe(0)
  })
})

describe('skillHealth — cross-agent (source-aware)', () => {
  let dir: string
  let dbN = 0
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-src-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `s${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  it('reports one source at a time — a same-named skill under two agents never merges', () => {
    // 'commit' exists in BOTH claude-code and codex. Each report must reflect exactly one
    // source's usage, never a summed cross-agent row.
    seedInstalledGlobal(store, [{ name: 'commit' }], 'claude-code')
    seedInstalledGlobal(store, [{ name: 'commit' }], 'codex')
    seedSession('cc1', 'repoA', 2, [{ name: 'commit', action: 'skill' }], 'claude-code')
    seedSession('cc2', 'repoA', 3, [{ name: 'commit', action: 'skill' }], 'claude-code')
    seedSession('cx1', 'repoA', 2, [{ name: 'commit', action: 'skill' }], 'codex')

    const cc = skillHealth(store, { source: 'claude-code', days: 30, nowMs: NOW })
    const cx = skillHealth(store, { source: 'codex', days: 30, nowMs: NOW })
    expect(cc.source).toBe('claude-code')
    expect(cx.source).toBe('codex')
    // Each report counts only its own source's calls — 2 for claude-code, 1 for codex.
    expect(cc.rows.find((r) => r.name === 'commit')!.calls).toBe(2)
    expect(cx.rows.find((r) => r.name === 'commit')!.calls).toBe(1)
    // Both sources are offered so the client can show a chooser.
    expect(cc.availableSources).toEqual(['claude-code', 'codex'])
  })

  it('defaults to the busiest source and hides the chooser when only one has data', () => {
    // Only claude-code has skill data → single available source, default resolves to it.
    seedInstalledGlobal(store, [{ name: 'solo' }], 'claude-code')
    seedSession('a', 'repoA', 2, [{ name: 'solo', action: 'skill' }], 'claude-code')
    const r = skillHealth(store, { days: 30, nowMs: NOW })
    expect(r.source).toBe('claude-code')
    expect(r.availableSources).toEqual(['claude-code']) // client shows no source chooser
  })

  it('defaults to the source with the most skill invocations across agents', () => {
    seedInstalledGlobal(store, [{ name: 'x' }], 'claude-code')
    seedInstalledGlobal(store, [{ name: 'x' }], 'codex')
    // codex has more invocations → it's the default when none is requested.
    seedSession('cc', 'repoA', 2, [{ name: 'x', action: 'skill' }], 'claude-code')
    seedSession('cx1', 'repoA', 2, [{ name: 'x', action: 'skill' }], 'codex')
    seedSession('cx2', 'repoA', 3, [{ name: 'x', action: 'skill' }], 'codex')
    const r = skillHealth(store, { days: 30, nowMs: NOW })
    expect(r.source).toBe('codex')
  })

  it("never treats an OpenCode kind:'command' entry as a skill", () => {
    // OpenCode folds slash-commands into the skills category tagged kind:'command'. They
    // have no invocation signal, so surfacing one as a skill would be a false dead-skill row.
    seedInstalledGlobal(store, [
      { name: 'realskill' },
      { name: 'deploy', kind: 'command' },
    ], 'opencode')
    // Enough sessions that a real unused skill WOULD be flagged, to prove the command is
    // excluded on its own merits, not for want of data.
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`o${i}`, 'repoA', 2, [{ name: 'Bash', action: 'shell' }], 'opencode')
    const r = skillHealth(store, { source: 'opencode', days: 30, nowMs: NOW })
    expect(r.rows.some((x) => x.name === 'deploy')).toBe(false) // the command is not a skill
    expect(r.rows.some((x) => x.name === 'realskill')).toBe(true) // the real skill still shows
  })

  it('per-source denominators: active-repo count reflects only the report source', () => {
    // claude-code has sessions in 3 repos; codex in 1. The "active repos" denominator for a
    // codex report must be codex's, not the union across agents.
    seedInstalledGlobal(store, [{ name: 'k' }], 'codex')
    for (let i = 0; i < 3; i++) seedSession(`cc${i}`, `ccrepo${i}`, 2, [{ name: 'Bash', action: 'shell' }], 'claude-code')
    seedSession('cx', 'cxrepo', 2, [{ name: 'k', action: 'skill' }], 'codex')
    const r = skillHealth(store, { source: 'codex', days: 30, nowMs: NOW })
    expect(r.totalActiveRepos).toBe(1) // only codex's repo, not the 3 claude-code ones
  })

  it('counts subagent (sidechain) invocations in usage, with a subagentCalls split', () => {
    seedInstalledGlobal(store, [{ name: 'subskill' }])
    seedSession('m1', 'repoA', 2, [
      { name: 'subskill', action: 'skill' },
      { name: 'subskill', action: 'skill', sidechain: true },
    ])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'subskill')!
    expect(row.calls).toBe(2) // overall count includes the subagent firing
    expect(row.subagentCalls).toBe(1)
    expect(row.status).toBe('used')
  })

  it('a skill invoked only by subagents reads as used, not removable', () => {
    seedInstalledGlobal(store, [{ name: 'agent-only' }])
    // Plenty of sessions, so an actually-dead skill WOULD be flagged removable.
    for (let i = 0; i < MIN_SESSIONS; i++) seedSession(`s${i}`, 'repoA', 2, [{ name: 'Bash', action: 'shell' }])
    seedSession('sub', 'repoA', 2, [{ name: 'agent-only', action: 'skill', sidechain: true }])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'agent-only')!
    expect(row.status).toBe('used')
    expect(row.calls).toBe(1)
    expect(row.subagentCalls).toBe(1)
  })

  it('the invocations list includes subagent firings, flagged sidechain', () => {
    seedInstalledGlobal(store, [{ name: 'subskill' }])
    seedSession('m1', 'repoA', 2, [
      { name: 'subskill', action: 'skill' },
      { name: 'subskill', action: 'skill', sidechain: true },
    ])
    const list = skillInvocations(store, 'subskill', { days: 30, nowMs: NOW })
    expect(list.length).toBe(2)
    expect(list.map((i) => i.sidechain).sort()).toEqual([false, true])
  })

  /** Seed a session whose skill firings each carry an outcome verdict annotation. */
  function seedJudgedSession(id: string, skill: string, outcomes: string[]) {
    seedSession(id, 'repoA', 2, outcomes.map(() => ({ name: skill, action: 'skill' })))
    const v = outcomes.map((outcome, idx) => ({ idx, name: skill, outcome, userCorrectionAdjacent: false, evidence: 'e' }))
    db.prepare(`INSERT INTO annotations (session_id, processor, key, value) VALUES (?, 'skill-outcomes', 'skill_outcomes', ?)`).run(id, JSON.stringify(v))
  }

  it('flags often-bypassed once enough judged firings are mostly bypassed', () => {
    seedInstalledGlobal(store, [{ name: 'meh' }])
    // 6 judged, 4 bypassed (ignored/reworked) = 67% — over both the floor and the share.
    seedJudgedSession('j1', 'meh', ['ignored', 'reworked', 'ignored', 'used', 'used', 'ignored'])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'meh')!
    expect(row.flags).toContain('often-bypassed')
    expect(row.judgedCalls).toBe(6)
    expect(row.bypassedCalls).toBe(4)
    expect(r.totalOftenBypassed).toBe(1)
  })

  it('withholds often-bypassed below the judged floor, even at a 100% bypass share', () => {
    seedInstalledGlobal(store, [{ name: 'few' }])
    // 4 judged (< floor), all bypassed — too little evidence to put a verdict in the roster.
    seedJudgedSession('j2', 'few', ['ignored', 'ignored', 'ignored', 'ignored'])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'few')!
    expect(row.flags).not.toContain('often-bypassed')
    expect(row.judgedCalls).toBe(4) // the counts still surface for the detail page
  })

  it('withholds often-bypassed below the bypass-share threshold', () => {
    seedInstalledGlobal(store, [{ name: 'fine' }])
    // 6 judged, 2 bypassed = 33% < 50%.
    seedJudgedSession('j3', 'fine', ['ignored', 'reworked', 'used', 'used', 'used', 'used'])
    const r = skillHealth(store, { nowMs: NOW })
    expect(r.rows.find((x) => x.name === 'fine')!.flags).not.toContain('often-bypassed')
    expect(r.totalOftenBypassed).toBe(0)
  })

  it('insufficient-context firings do not count toward the judged floor', () => {
    seedInstalledGlobal(store, [{ name: 'thin' }])
    // 4 judged + 2 unjudgeable: still under the floor — insufficient-context is not evidence.
    seedJudgedSession('j4', 'thin', ['ignored', 'ignored', 'ignored', 'ignored', 'insufficient-context', 'insufficient-context'])
    const r = skillHealth(store, { nowMs: NOW })
    const row = r.rows.find((x) => x.name === 'thin')!
    expect(row.flags).not.toContain('often-bypassed')
    expect(row.judgedCalls).toBe(4)
  })
})

describe('skillOutcomeStats', () => {
  let dir: string
  let dbN = 0
  let store: Store
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-oc-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    db = openDb(join(dir, `oc${dbN++}.db`))
    store = new Store(db)
  })
  afterEach(() => store.close())

  /** Seed one skill firing (tool_call) + its outcome verdict. */
  const seedFiring = (sid: string, idx: number, outcome: string, correction = false, evidence = 'e') => {
    if (idx === 0) {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, 'r', ?, 1, 1)`).run(sid, sid, SOURCE, iso(2))
    }
    db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, ?, 'commit', 'skill', 1, 0, 0, ?)`).run(sid, idx, iso(2))
    return { idx, name: 'commit', outcome, userCorrectionAdjacent: correction, evidence: outcome + ': ' + evidence }
  }

  it('excludes insufficient-context from the distribution and derives bypassed', () => {
    const v = [
      seedFiring('s', 0, 'used'),
      seedFiring('s', 1, 'reworked', true),
      seedFiring('s', 2, 'ignored'),
      seedFiring('s', 3, 'insufficient-context'),
      seedFiring('s', 4, 'insufficient-context'),
    ]
    db.prepare(`INSERT INTO annotations (session_id, processor, key, value) VALUES ('s', 'skill-outcomes', 'skill_outcomes', ?)`).run(JSON.stringify(v))

    const o = skillOutcomeStats(store, 'commit', { from: iso(30), to: iso(0) })!
    expect(o.classified).toBe(3) // the 2 insufficient-context firings are NOT judged
    expect(o.used).toBe(1)
    expect(o.reworked).toBe(1)
    expect(o.ignored).toBe(1)
    expect(o.bypassed).toBe(2) // reworked + ignored
    expect(o.insufficientContext).toBe(2) // counted separately for the footnote
    expect(o.userCorrectionAdjacent).toBe(1)
    // Bypass examples (reworked/ignored) are ordered ahead of the followed one.
    expect(['reworked', 'ignored']).toContain(o.examples[0]!.outcome)
    // Each example locates its firing so the UI can open the transcript there.
    expect(o.examples[0]!.sessionId).toBe('s')
    expect([1, 2]).toContain(o.examples[0]!.idx) // the reworked/ignored firings
  })

  it('returns null when a skill has only insufficient-context firings', () => {
    const v = [seedFiring('s2', 0, 'insufficient-context')]
    db.prepare(`INSERT INTO annotations (session_id, processor, key, value) VALUES ('s2', 'skill-outcomes', 'skill_outcomes', ?)`).run(JSON.stringify(v))
    // No judged verdict → nothing to show (the panel stays hidden).
    expect(skillOutcomeStats(store, 'commit', { from: iso(30), to: iso(0) })).toBeNull()
  })
})
