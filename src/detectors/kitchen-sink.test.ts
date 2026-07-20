import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { artifactCounts, candidates, kitchenSink, realUserTurns, sizeCutoff } from './kitchen-sink'
import type { DetectorContext } from '../core/detector'

// queryAll() reopens the db file read-only, so tests need a real file, not :memory:.
let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kitchen-sink-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const db = openDb(join(dir, `t${n++}.db`))
  const store = new Store(db)
  const ctx = { store, log: { debug() {}, info() {}, warn() {} }, llmEnabled: false, llm: null } as unknown as DetectorContext
  return { db, store, ctx }
}

type DB = ReturnType<typeof openDb>

// Recent so sessions fall inside the candidates() 30-day window.
const RECENT = new Date(Date.now() - 86_400_000).toISOString()

function addSession(db: DB, id: string, repo = 'o/r', startedAt = RECENT) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at) VALUES (?,?,?,?,?,?)')
    .run(id, id, 'claude-code', 'anthropic', repo, startedAt)
}

// Seed a session's blocks from an ordered list of boundary_kinds (one per block).
function addBlocks(db: DB, sid: string, boundaries: string[], repo = 'o/r') {
  addSession(db, sid, repo)
  const ins = db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
  boundaries.forEach((bk, idx) => ins.run(sid, idx, idx, idx, bk, 'segment-blocks'))
}

// Seed a session with a given real-user-turn count (N user_turn blocks + session_end → N+1 turns).
function addSessionWithTurns(db: DB, id: string, turns: number, repo = 'o/r') {
  const boundaries = Array.from({ length: Math.max(0, turns - 1) }, () => 'user_turn')
  boundaries.push('session_end')
  addBlocks(db, id, boundaries, repo)
}

function addArtifact(db: DB, id: string, kind: string) {
  db.prepare('INSERT INTO artifacts (id, kind) VALUES (?, ?)').run(id, kind)
}
function linkArtifact(db: DB, sid: string, artId: string, role = 'x') {
  db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
    .run(sid, artId, role, 'x', 'p')
}

describe('kitchen-sink detector', () => {
  it('is a P-tier detector that needs an LLM', () => {
    expect(kitchenSink.name).toBe('kitchen-sink')
    expect(kitchenSink.tier).toBe('P')
    expect(kitchenSink.needsLlm).toBe(true)
  })

  it('returns no insights on an empty store', async () => {
    const { ctx } = setup()
    expect(await kitchenSink.run(ctx)).toEqual([])
  })
})

describe('realUserTurns', () => {
  it('counts the opening block plus every user_turn boundary', () => {
    const { db, store } = setup()
    // 4 blocks: block0 ends on a commit, block1 & block2 on user turns, block3 on session end.
    // Human typed 3 times → 1 (opening) + 2 user_turn boundaries = 3.
    addBlocks(db, 's1', ['commit', 'user_turn', 'user_turn', 'session_end'])
    expect(realUserTurns(store).get('s1')).toBe(3)
  })

  it('excludes commit and PR boundaries from the count', () => {
    const { db, store } = setup()
    // Every boundary is a commit/PR — no human turns after the opener → count is 1.
    addBlocks(db, 's1', ['commit', 'pr_create', 'pr_merge', 'session_end'])
    expect(realUserTurns(store).get('s1')).toBe(1)
  })

  it('counts each session independently', () => {
    const { db, store } = setup()
    addBlocks(db, 'long', ['user_turn', 'user_turn', 'user_turn', 'session_end']) // 1 + 3 = 4
    addBlocks(db, 'short', ['session_end']) // 1 + 0 = 1
    const turns = realUserTurns(store)
    expect(turns.get('long')).toBe(4)
    expect(turns.get('short')).toBe(1)
  })

  it('omits sessions with no blocks', () => {
    const { db, store } = setup()
    addSession(db, 'no-blocks')
    expect(realUserTurns(store).has('no-blocks')).toBe(false)
  })
})

describe('artifactCounts', () => {
  it('counts distinct features and PRs per session', () => {
    const { db, store } = setup()
    addSession(db, 's1')
    addArtifact(db, 'feat-a', 'feature')
    addArtifact(db, 'feat-b', 'feature')
    addArtifact(db, 'pr-1', 'pr')
    linkArtifact(db, 's1', 'feat-a')
    linkArtifact(db, 's1', 'feat-b')
    linkArtifact(db, 's1', 'pr-1')
    expect(artifactCounts(store).get('s1')).toEqual({ features: 2, prs: 1 })
  })

  it('ignores non-feature, non-PR artifacts', () => {
    const { db, store } = setup()
    addSession(db, 's1')
    addArtifact(db, 'commit-1', 'commit')
    addArtifact(db, 'file-1', 'file')
    linkArtifact(db, 's1', 'commit-1')
    linkArtifact(db, 's1', 'file-1')
    expect(artifactCounts(store).has('s1')).toBe(false)
  })

  it('does not double-count a feature linked under two roles', () => {
    const { db, store } = setup()
    addSession(db, 's1')
    addArtifact(db, 'pr-1', 'pr')
    linkArtifact(db, 's1', 'pr-1', 'contributed')
    linkArtifact(db, 's1', 'pr-1', 'reviewed')
    expect(artifactCounts(store).get('s1')).toEqual({ features: 0, prs: 1 })
  })

  it('counts each session independently', () => {
    const { db, store } = setup()
    addSession(db, 'multi')
    addSession(db, 'single')
    addArtifact(db, 'pr-1', 'pr')
    addArtifact(db, 'pr-2', 'pr')
    addArtifact(db, 'feat-a', 'feature')
    linkArtifact(db, 'multi', 'pr-1')
    linkArtifact(db, 'multi', 'pr-2')
    linkArtifact(db, 'single', 'feat-a')
    const counts = artifactCounts(store)
    expect(counts.get('multi')).toEqual({ features: 0, prs: 2 })
    expect(counts.get('single')).toEqual({ features: 1, prs: 0 })
  })
})

describe('sizeCutoff', () => {
  it('returns the value at the requested percentile (nearest-rank)', () => {
    // 10 values 1..10; 75th percentile → rank ceil(0.75*10)=8 → 8th value = 8.
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(sizeCutoff(counts, 0.75)).toBe(8)
  })

  it('is order-independent', () => {
    expect(sizeCutoff([10, 3, 7, 1, 5], 0.6)).toBe(sizeCutoff([1, 3, 5, 7, 10], 0.6))
  })

  it('returns Infinity for empty input so nothing qualifies', () => {
    expect(sizeCutoff([])).toBe(Infinity)
  })

  it('returns the single value for a one-element input', () => {
    expect(sizeCutoff([4])).toBe(4)
  })

  it('defaults to the 75th percentile', () => {
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(sizeCutoff(counts)).toBe(sizeCutoff(counts, 0.75))
  })
})

describe('candidates', () => {
  // Link 2 distinct features to a session so it clears the substance gate.
  function giveTwoFeatures(db: DB, sid: string) {
    for (const f of ['feat-a', 'feat-b']) {
      db.prepare("INSERT OR IGNORE INTO artifacts (id, kind) VALUES (?, 'feature')").run(f)
      db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
        .run(sid, f, 'x', 'x', 'p')
    }
  }

  it('keeps only sessions at/above the size cutoff (with the substance gate satisfied)', () => {
    const { db, store } = setup()
    // Turn counts 1..4 in one repo → 75th-percentile cutoff = 3. All have 2 features.
    for (const turns of [1, 2, 3, 4]) {
      const id = `s${turns}`
      addSessionWithTurns(db, id, turns)
      giveTwoFeatures(db, id)
    }
    const ids = candidates(store).map((c) => c.sessionId).sort()
    expect(ids).toEqual(['s3', 's4'])
  })

  it('drops large sessions that did not advance 2+ features or PRs', () => {
    const { db, store } = setup()
    for (const turns of [1, 2, 3, 4]) addSessionWithTurns(db, `s${turns}`, turns)
    // s4 is large but has only ONE feature → not a candidate.
    db.prepare("INSERT INTO artifacts (id, kind) VALUES ('feat-a', 'feature')").run()
    db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
      .run('s4', 'feat-a', 'x', 'x', 'p')
    expect(candidates(store)).toEqual([])
  })

  it('qualifies on 2+ PRs alone', () => {
    const { db, store } = setup()
    for (const turns of [1, 2, 3, 4]) addSessionWithTurns(db, `s${turns}`, turns)
    for (const p of ['pr-1', 'pr-2']) {
      db.prepare("INSERT INTO artifacts (id, kind) VALUES (?, 'pr')").run(p)
      db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
        .run('s4', p, 'x', 'x', 'p')
    }
    expect(candidates(store).map((c) => c.sessionId)).toEqual(['s4'])
  })

  it('computes the size cutoff per repo', () => {
    const { db, store } = setup()
    // 'small' repo: turns 1..4 → cutoff 3.  'big' repo: turns 10,20,30,40 → cutoff 30.
    for (const turns of [1, 2, 3, 4]) {
      const id = `small-${turns}`
      addSessionWithTurns(db, id, turns, 'small')
      giveTwoFeatures(db, id)
    }
    for (const turns of [10, 20, 30, 40]) {
      const id = `big-${turns}`
      addSessionWithTurns(db, id, turns, 'big')
      giveTwoFeatures(db, id)
    }
    const ids = candidates(store).map((c) => c.sessionId).sort()
    // A 4-turn 'small' session qualifies (clears its own repo's cutoff of 3),
    // even though 4 is far below 'big's cutoff of 30.
    expect(ids).toEqual(['big-30', 'big-40', 'small-3', 'small-4'])
  })

  it('ignores sessions outside the 30-day window', () => {
    const { db, store } = setup()
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    addSession(db, 'old', 'o/r', old)
    db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
      .run('old', 0, 0, 0, 'session_end', 'segment-blocks')
    giveTwoFeatures(db, 'old')
    expect(candidates(store)).toEqual([])
  })
})
