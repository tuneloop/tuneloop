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
    const r = skillDrift(store, 'whatever', { nowMs: NOW })
    expect(r.noHistory).toBe(true)
    expect(r.versions).toEqual([])
    expect(r.delta).toBeNull()
  })

  it('reconstructs review three-version timeline with per-version usage', () => {
    const exp = seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
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

  it('compares current vs previous version over full lifetimes (no window)', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
    expect(r.delta).not.toBeNull()
    const d = r.delta!
    // The edit boundary is the current version's start (most recent edit = 20d ago).
    expect(d.editIso).toBe(r.versions[r.versions.length - 1]!.startIso)
    // Both versions have usage in the seed → the comparison is trustworthy.
    expect(d.enoughData).toBe(true)
    expect(d.before.calls).toBeGreaterThan(0)
    expect(d.after.calls).toBeGreaterThan(0)
    // before/after mirror the last two versions' FULL-lifetime usage — no window clipping.
    expect(d.before).toMatchObject(r.versions[r.versions.length - 2]!.usage)
    expect(d.after).toMatchObject(r.versions[r.versions.length - 1]!.usage)
    // Each side carries its per-week traction for an exposure-fair comparison.
    expect(d.before.callsPerWeek).toBeGreaterThan(0)
    expect(d.after.callsPerWeek).toBeGreaterThan(0)
  })

  it('diffs the last edit: reports the body diff (rows + exact counts) between previous and current', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
    const d = r.delta!
    // review's body changed v2 → v3, so the diff has real add/remove rows and isn't skipped.
    expect(d.diffSkipped).toBe(false)
    expect(d.diff.length).toBeGreaterThan(0)
    // The server ships EXACT counts; they equal the +/- rows here (nothing collapsed away).
    expect(d.diffAdded).toBeGreaterThan(0)
    expect(d.diffRemoved).toBeGreaterThan(0)
    expect(d.diffAdded).toBe(d.diff.filter((x) => x.t === '+').length)
    expect(d.diffRemoved).toBe(d.diff.filter((x) => x.t === '-').length)
    // The new v3 body line is present as an added row.
    expect(d.diff.some((x) => x.t === '+' && /cite file:line/.test(x.s))).toBe(true)
  })

  it('sends the full diff (no row cap) and keeps counts exact even for a large edit', () => {
    // A big rewrite: 60 lines fully replaced. Every change row must be present (no truncation),
    // and the exact counts must match the change rows — the client relies on this to show +N/−M.
    const before = Array.from({ length: 60 }, (_, k) => `old line ${k}`).join('\n')
    const after = Array.from({ length: 60 }, (_, k) => `new line ${k}`).join('\n')
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'huge', body: before, bodyHash: 'h1' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'huge', body: after, bodyHash: 'h2' }], count: 1 } },
      iso(10),
    )
    const d = skillDrift(store, 'huge', { nowMs: NOW }).delta!
    expect(d.diffSkipped).toBe(false)
    expect(d.diffAdded).toBe(60)
    expect(d.diffRemoved).toBe(60)
    // No cap: all 120 change rows are shipped, and the exact counts match them.
    expect(d.diff.filter((x) => x.t === '+').length).toBe(60)
    expect(d.diff.filter((x) => x.t === '-').length).toBe(60)
  })

  it('collapses long unchanged context into a gap marker so the change is not buried', () => {
    // A big body where only one middle line changes. The diff must NOT dump every context
    // line — it keeps a few lines around the edit and collapses the rest to a '@' gap.
    const lines = (mid: string) => ['# big skill', ...Array.from({ length: 40 }, (_, k) => `line ${k}`), mid, ...Array.from({ length: 40 }, (_, k) => `tail ${k}`)].join('\n')
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'big', body: lines('ORIGINAL'), bodyHash: 'b1' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'big', body: lines('CHANGED'), bodyHash: 'b2' }], count: 1 } },
      iso(10),
    )
    const d = skillDrift(store, 'big', { nowMs: NOW }).delta!
    // The change is present (ORIGINAL removed, CHANGED added), with real context around it.
    expect(d.diff.some((x) => x.t === '-' && x.s === 'ORIGINAL')).toBe(true)
    expect(d.diff.some((x) => x.t === '+' && x.s === 'CHANGED')).toBe(true)
    // A collapsed-context marker replaces the long unchanged runs (not ~80 context rows).
    expect(d.diff.some((x) => x.t === '@')).toBe(true)
    const context = d.diff.filter((x) => x.t === ' ').length
    expect(context).toBeLessThanOrEqual(2 * 3 + 2) // ~DIFF_CONTEXT lines each side of the one change
  })

  it('skips the diff for a pathologically large body (over DIFF_MAX_LINES) and reports counts only', () => {
    // A >1500-line body is too large to LCS cheaply — we set diffSkipped, ship no rows, and
    // report a coarse size delta rather than an exact line-change count.
    const big = (n: number) => Array.from({ length: n }, (_, k) => `line ${k}`).join('\n')
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'mega', body: big(1600), bodyHash: 'm1' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'mega', body: big(1650), bodyHash: 'm2' }], count: 1 } },
      iso(10),
    )
    const d = skillDrift(store, 'mega', { nowMs: NOW }).delta!
    expect(d.diffSkipped).toBe(true)
    expect(d.diff).toEqual([]) // no rows shipped for the too-large case
    expect(d.diffAdded).toBe(50) // coarse size delta (1650 - 1600)
    expect(d.diffRemoved).toBe(0)
  })

  it('annotates each version with what it changed vs. the previous one', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
    // The oldest version has no predecessor → no change record.
    expect(r.versions[0]!.change).toBeNull()
    // Later versions carry a body change (added/removed lines).
    for (let i = 1; i < r.versions.length; i++) {
      const c = r.versions[i]!.change!
      expect(c).not.toBeNull()
      expect(c.added + c.removed).toBeGreaterThan(0)
    }
  })

  it('rolls up LLM-judged outcomes per version lifetime (bypass rate, corrections)', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
    // The seed skews outcomes worse across eras: v1 all "used" (no bypass), the current
    // v3 era has reworked+ignored firings and adjacent corrections.
    const v1 = r.versions[0]!
    const cur = r.versions[r.versions.length - 1]!
    expect(v1.outcomes && v1.outcomes.bypassed).toBe(0) // v1 was followed every time
    expect(cur.outcomes!.classified).toBeGreaterThan(0)
    expect(cur.outcomes!.bypassed).toBeGreaterThan(0) // v3 got bypassed
    expect(cur.outcomes!.userCorrectionAdjacent).toBeGreaterThan(0)
  })

  it('leaves a version’s outcomes null when nothing was judged (no verdict / only insufficient-context)', () => {
    // A skill with two versions and real invocations, but every verdict is insufficient-context
    // → outcomes must be null (the UI shows no bypass rate rather than a fabricated 0%).
    const snap = (hash: string, d: number) =>
      store.recordEnvSnapshot(
        { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'nojudge', body: 'b-' + hash, bodyHash: hash }], count: 1 } },
        iso(d),
      )
    snap('n1', 30)
    snap('n2', 12)
    // A run of invocations, each carrying only an insufficient-context verdict.
    const mk = (id: string, idx: number, d: number) => {
      if (idx === 0) db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, 'r', ?, 1, 1)`).run(id, id, SOURCE, iso(d))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, ?, 'nojudge', 'skill', 1, 0, 0, ?)`).run(id, idx, iso(d))
      return { idx, name: 'nojudge', outcome: 'insufficient-context', userCorrectionAdjacent: false, evidence: 'x' }
    }
    const v = [mk('s', 0, 8), mk('s', 1, 7), mk('s', 2, 6), mk('s', 3, 5)]
    db.prepare(`INSERT INTO annotations (session_id, processor, key, value) VALUES ('s', 'skill-outcomes', 'skill_outcomes', ?)`).run(JSON.stringify(v))
    const r = skillDrift(store, 'nojudge', { nowMs: NOW })
    // The current version was invoked but has no JUDGED outcome → outcomes is null.
    const cur = r.versions[r.versions.length - 1]!
    expect(cur.usage.calls).toBeGreaterThan(0)
    expect(cur.outcomes).toBeNull()
  })

  it('reports exposure-fair per-week traction for each version', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
    for (const v of r.versions) {
      expect(v.callsPerWeek).toBeGreaterThan(0)
      // A version live for D days with C calls → C / (D/7) per week; sanity-bound it.
      expect(Number.isFinite(v.callsPerWeek)).toBe(true)
    }
  })

  it('collapses a lost intermediate: drifty shows only two captured versions', () => {
    seedSkillStore(store, { nowMs: NOW })
    // drifty was edited between captures without an analyze in between → the middle
    // body never made it into a snapshot, so only two versions are recoverable.
    const r = skillDrift(store, 'drifty', { nowMs: NOW })
    expect(r.versions.length).toBe(2)
  })

  it('treats an A→B→A revert as three distinct segments', () => {
    seedSkillStore(store, { nowMs: NOW })
    // reverter went A(60d) → B(40d) → A(20d). The final revert to A is byte-identical
    // to v1, but it's a distinct period, so we honestly show three segments.
    const r = skillDrift(store, 'reverter', { nowMs: NOW })
    expect(r.versions.length).toBe(3)
    expect(r.versions[0]!.bodyHash).toBe(r.versions[2]!.bodyHash) // A == A
    expect(r.versions[1]!.bodyHash).not.toBe(r.versions[0]!.bodyHash) // B != A
  })

  it('scopes drift per (skill, repo): same name edited in one repo only', () => {
    // Same skill name in two repos, edited in one only. Drift must judge each repo's own
    // timeline — the old bug picked an arbitrary repo and missed the real edit.
    const snap = (path: string, hash: string, daysAgo: number) =>
      store.recordEnvSnapshot(
        { source: SOURCE, scope: 'project', scopeKey: path, category: 'skills', payload: { skills: [{ name: 'commit', body: 'b-' + hash, bodyHash: hash }], count: 1 } },
        iso(daysAgo),
      )
    // repo `alpha` edits commit (h1 → h2); repo `beta` never changes it (h9 throughout).
    snap('/work/alpha', 'h1', 30)
    snap('/work/alpha', 'h2', 15)
    snap('/work/beta', 'h9', 30)
    snap('/work/beta', 'h9', 1)
    const mk = (id: string, repo: string, daysAgo: number) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, ?, ?, 1, 1)`).run(id, id, SOURCE, repo, iso(daysAgo))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, 0, 'commit', 'skill', 1, 0, 0, ?)`).run(id, iso(daysAgo))
    }
    // alpha: 3 before the edit, 3 after → a real, ratable delta.
    mk('a0', 'alpha', 22); mk('a1', 'alpha', 20); mk('a2', 'alpha', 18)
    mk('a3', 'alpha', 12); mk('a4', 'alpha', 10); mk('a5', 'alpha', 8)
    // beta: some usage, but the body never changed → single version, no delta.
    mk('b0', 'beta', 20); mk('b1', 'beta', 10)

    // alpha is the busiest repo (6 calls vs 2) → that's the timeline drift reflects.
    const r = skillDrift(store, 'commit', { nowMs: NOW })
    expect(r.repo).toBe('alpha')
    expect(r.singleVersion).toBe(false)
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['h1', 'h2'])
    expect(r.delta).not.toBeNull()
    expect(r.delta!.enoughData).toBe(true)
    // Usage is scoped to alpha too — beta's 2 calls must NOT leak in.
    expect(r.delta!.before.calls).toBe(3)
    expect(r.delta!.after.calls).toBe(3)
  })

  it('offers every install location as a chooser entry (global + per-project), most-used first', () => {
    // 'changelog-generator' installed + edited separately in two repos, plus a global install.
    const psnap = (path: string, hash: string, d: number) =>
      store.recordEnvSnapshot({ source: SOURCE, scope: 'project', scopeKey: path, category: 'skills', payload: { skills: [{ name: 'clog', body: 'b-' + hash, bodyHash: hash }], count: 1 } }, iso(d))
    const gsnap = (hash: string, d: number) =>
      store.recordEnvSnapshot({ source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'clog', body: 'g-' + hash, bodyHash: hash }], count: 1 } }, iso(d))
    psnap('/work/sandbox', 's1', 30); psnap('/work/sandbox', 's2', 12) // sandbox: edited (2 versions)
    psnap('/work/ideas', 'i1', 30); psnap('/work/ideas', 'i2', 15) // ideas: edited (2 versions)
    gsnap('gg', 20) // global: single version
    const mk = (id: string, repo: string | null, d: number) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, ?, ?, 1, 1)`).run(id, id, SOURCE, repo, iso(d))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, 0, 'clog', 'skill', 1, 0, 0, ?)`).run(id, iso(d))
    }
    mk('s0', 'sandbox', 10); mk('s1', 'sandbox', 8); mk('s2', 'sandbox', 6) // sandbox busiest (3)
    mk('i0', 'ideas', 9); mk('i1', 'ideas', 7) // ideas (2)
    mk('o0', 'otherrepo', 5) // a repo with NO project install → attributes to Global (project-first)

    const r = skillDrift(store, 'clog', { nowMs: NOW })
    const byLabel = Object.fromEntries(r.locations.map((l) => [l.label, l]))
    // All three locations offered; global (one shared body) + the two repos.
    expect(r.locations.map((l) => l.label).sort()).toEqual(['Global', 'ideas', 'sandbox'])
    expect(byLabel['sandbox']!.versionCount).toBe(2)
    expect(byLabel['ideas']!.versionCount).toBe(2)
    expect(byLabel['sandbox']!.calls).toBe(3)
    // Project-first attribution: Global owns ONLY the call in the un-installed repo, not the
    // sandbox/ideas calls (those are served by their own project installs — no double-count).
    expect(byLabel['ideas']!.calls).toBe(2)
    expect(byLabel['Global']!.calls).toBe(1)
    // Default resolves to the busiest location WITH history (sandbox).
    expect(r.repo).toBe('sandbox')
    expect(r.scopeKey).toBe('/work/sandbox')
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['s1', 's2'])
  })

  it('reads the chosen location when scopeKey is passed (each repo its own timeline)', () => {
    const psnap = (path: string, hash: string, d: number) =>
      store.recordEnvSnapshot({ source: SOURCE, scope: 'project', scopeKey: path, category: 'skills', payload: { skills: [{ name: 'clog', body: 'b-' + hash, bodyHash: hash }], count: 1 } }, iso(d))
    psnap('/work/sandbox', 's1', 30); psnap('/work/sandbox', 's2', 12)
    psnap('/work/ideas', 'i1', 30); psnap('/work/ideas', 'i2', 15)
    const mk = (id: string, repo: string, d: number) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, ?, ?, 1, 1)`).run(id, id, SOURCE, repo, iso(d))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, 0, 'clog', 'skill', 1, 0, 0, ?)`).run(id, iso(d))
    }
    mk('s0', 'sandbox', 10); mk('s1', 'sandbox', 8); mk('s2', 'sandbox', 6) // sandbox busiest → default
    mk('i0', 'ideas', 9)
    // Explicitly ask for the quieter repo's timeline.
    const r = skillDrift(store, 'clog', { nowMs: NOW, scopeKey: '/work/ideas' })
    expect(r.repo).toBe('ideas')
    expect(r.scopeKey).toBe('/work/ideas')
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['i1', 'i2']) // ideas' own history, not sandbox's
  })

  it('defaults to the location WITH an edit history, not merely the busiest', () => {
    // The busiest repo never edited the skill (1 version); a quieter repo has the real history.
    // The default must surface the edited one, else the drift section would look empty.
    const psnap = (path: string, hash: string, d: number) =>
      store.recordEnvSnapshot({ source: SOURCE, scope: 'project', scopeKey: path, category: 'skills', payload: { skills: [{ name: 'clog', body: 'b-' + hash, bodyHash: hash }], count: 1 } }, iso(d))
    psnap('/work/busy', 'x1', 30); psnap('/work/busy', 'x1', 2) // busy: never edited (1 version)
    psnap('/work/quiet', 'q1', 30); psnap('/work/quiet', 'q2', 12) // quiet: edited (2 versions)
    const mk = (id: string, repo: string, d: number) => {
      db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at, n_turns, n_tool_calls) VALUES (?, ?, ?, ?, ?, 1, 1)`).run(id, id, SOURCE, repo, iso(d))
      db.prepare(`INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?, 0, 'clog', 'skill', 1, 0, 0, ?)`).run(id, iso(d))
    }
    mk('b0', 'busy', 10); mk('b1', 'busy', 8); mk('b2', 'busy', 6); mk('b3', 'busy', 4) // busy: 4 calls
    mk('q0', 'quiet', 9); mk('q1', 'quiet', 7) // quiet: 2 calls
    const r = skillDrift(store, 'clog', { nowMs: NOW })
    expect(r.repo).toBe('quiet') // the edited one, despite busy having more calls
    expect(r.singleVersion).toBe(false)
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['q1', 'q2'])
  })

  it('dates a version boundary to the file mtime (editedAt), not the analyze run', () => {
    // v2 was analyzed at day 10, but the file's own mtime says it was edited at day 20.
    // The boundary must be the real edit time (day 20), clamped to (prev-start, capture].
    const editedV2 = iso(20)
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'mt', body: 'v1', bodyHash: 'h1', editedAt: iso(40) }], count: 1 } },
      iso(40),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'mt', body: 'v2', bodyHash: 'h2', editedAt: editedV2 }], count: 1 } },
      iso(10), // analyzed 10 days AFTER the real edit
    )
    const r = skillDrift(store, 'mt', { nowMs: NOW })
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['h1', 'h2'])
    expect(r.versions[1]!.startIso).toBe(editedV2) // mtime wins over the day-10 capture
    expect(r.delta!.editIso).toBe(editedV2)
  })

  it('falls back to capture time when the mtime is implausible (e.g. clone reset it)', () => {
    // A clone/checkout can set mtime to "now" — an editedAt AFTER the capture. That's
    // implausible as an edit time, so we clamp it away and keep the capture timestamp.
    const capturedV2 = iso(10)
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'cl', body: 'v1', bodyHash: 'h1', editedAt: iso(40) }], count: 1 } },
      iso(40),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'cl', body: 'v2', bodyHash: 'h2', editedAt: iso(2) }], count: 1 } }, // mtime AFTER capture
      capturedV2,
    )
    const r = skillDrift(store, 'cl', { nowMs: NOW })
    expect(r.versions[1]!.startIso).toBe(capturedV2) // implausible mtime rejected
  })

  it('does not append a new version when only the mtime changed (same body)', () => {
    // A touch/clone bumps mtime without changing content. Change-detection hashes only
    // content (editedAt is stripped), so this must NOT create a spurious second version.
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'touch', body: 'same', bodyHash: 'h1', editedAt: iso(30) }], count: 1 } },
      iso(30),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'touch', body: 'same', bodyHash: 'h1', editedAt: iso(5) }], count: 1 } }, // mtime moved, body identical
      iso(1),
    )
    const r = skillDrift(store, 'touch', { nowMs: NOW })
    expect(r.versions.length).toBe(1)
    expect(r.singleVersion).toBe(true)
  })

  it('starts a new version when the description changes even if the body is identical', () => {
    // The frontmatter `description` steers the agent, so a reword is a behavioral edit.
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'desc', body: 'same body', bodyHash: 'h1', description: 'Review a diff' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'desc', body: 'same body', bodyHash: 'h1', description: 'Review a diff AND suggest fixes' }], count: 1 } },
      iso(10),
    )
    const r = skillDrift(store, 'desc', { nowMs: NOW })
    expect(r.versions.length).toBe(2) // description change → new version
    // The displayed bodyHash stays the pure body hash (both versions share it).
    expect(r.versions.map((v) => v.bodyHash)).toEqual(['h1', 'h1'])
    // The delta carries the description before/after so the UI can show the reword even
    // though the body diff is empty (identical bodies).
    const d = r.delta!
    expect(d.descBefore).toBe('Review a diff')
    expect(d.descAfter).toBe('Review a diff AND suggest fixes')
    expect(d.diff.filter((x) => x.t === '+' || x.t === '-').length).toBe(0) // no body add/remove
  })

  it('does NOT start a new version on pure-metadata churn (version/tags), body+desc unchanged', () => {
    // Only a non-behavioral field changed — must stay one version. The payload hash differs
    // (so a snapshot row IS appended), but drift segments on body+description, not metadata.
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'meta', body: 'b', bodyHash: 'h1', description: 'Do a thing', version: '1.0' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: SOURCE, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'meta', body: 'b', bodyHash: 'h1', description: 'Do a thing', version: '1.1' }], count: 1 } },
      iso(10),
    )
    const r = skillDrift(store, 'meta', { nowMs: NOW })
    expect(r.versions.length).toBe(1) // version-string bump is not a behavioral edit
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
    const r = skillDrift(store, 'thin', { nowMs: NOW })
    expect(r.delta).not.toBeNull()
    expect(r.delta!.after.calls).toBe(1)
    expect(r.delta!.enoughData).toBe(false) // after side below MIN_DRIFT_CALLS
  })

  it('keeps a same-named skill drift timeline separate per source (never cross-agent)', () => {
    // 'edit' has a two-version history under claude-code but only a single version under
    // codex. Each source's timeline must be read on its own — never merged into a phantom
    // cross-agent edit history.
    const snap = (source: string, hash: string, daysAgo: number) =>
      store.recordEnvSnapshot(
        { source, scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'edit', body: 'b-' + hash, bodyHash: hash }], count: 1 } },
        iso(daysAgo),
      )
    snap('claude-code', 'cc1', 30)
    snap('claude-code', 'cc2', 15) // claude-code edited it once → two versions
    snap('codex', 'cx1', 30)
    snap('codex', 'cx1', 1) // codex never changed it → one version

    const cc = skillDrift(store, 'edit', { nowMs: NOW, source: 'claude-code' })
    const cx = skillDrift(store, 'edit', { nowMs: NOW, source: 'codex' })
    expect(cc.versions.map((v) => v.bodyHash)).toEqual(['cc1', 'cc2'])
    expect(cx.versions.map((v) => v.bodyHash)).toEqual(['cx1'])
    expect(cx.singleVersion).toBe(true)
  })

  it("ignores an OpenCode kind:'command' entry when building a drift timeline", () => {
    // A command sharing a name with nothing real must never spawn a version history.
    store.recordEnvSnapshot(
      { source: 'opencode', scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'deploy', body: 'v1', bodyHash: 'h1', kind: 'command' }], count: 1 } },
      iso(20),
    )
    store.recordEnvSnapshot(
      { source: 'opencode', scope: 'global', scopeKey: '_global', category: 'skills', payload: { skills: [{ name: 'deploy', body: 'v2', bodyHash: 'h2', kind: 'command' }], count: 1 } },
      iso(10),
    )
    const r = skillDrift(store, 'deploy', { nowMs: NOW, source: 'opencode' })
    expect(r.noHistory).toBe(true) // the command is invisible to drift
    expect(r.versions).toEqual([])
  })
})
