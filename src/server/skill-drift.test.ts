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

  it('produces a before/after delta on symmetric edit-bounded windows', () => {
    seedSkillStore(store, { nowMs: NOW })
    const r = skillDrift(store, 'review', { nowMs: NOW })
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
