import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { artifactCounts, buildAggregate, buildRequest, candidates, judge, kitchenSink, positiveEvidence, realUserTurns, sizeCutoff, unseenCandidates, verdictRow } from './kitchen-sink'
import { normalizeDetectorResult } from '../core/detector'
import type { DetectorContext, InsightInput } from '../core/detector'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { Block } from '../core/blocks'
import type { LlmClient, StructuredRequest } from '../llm/types'

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
// A `since` bound older than RECENT, so seeded sessions are in scope.
const SINCE = new Date(Date.now() - 30 * 86_400_000).toISOString()

// A no-millisecond UTC timestamp N days before now. SQLite's
// strftime('%Y-%m-%dT%H:%M:%SZ', …) — which the store uses to normalize first/last
// -seen — drops milliseconds, so seeding with this form lets those
// assertions round-trip exactly. Compute each once and reuse (Date.now() drifts).
const daysAgoZ = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

function addSession(db: DB, id: string, repo = 'o/r', startedAt = RECENT) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at, content_hash) VALUES (?,?,?,?,?,?,?)')
    .run(id, id, 'claude-code', 'anthropic', repo, startedAt, `${id}-hash`)
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

function giveTwoFeatures(db: DB, sid: string) {
  for (const f of ['feat-a', 'feat-b']) {
    db.prepare("INSERT OR IGNORE INTO artifacts (id, kind) VALUES (?, 'feature')").run(f)
    db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
      .run(sid, f, 'x', 'x', 'p')
  }
}

// Seed a repo with enough sessions (>= MIN_SESSIONS) for its percentile to apply:
// 9 small filler sessions (5 turns each) plus two 2-feature sessions long enough
// to clear both the per-repo cutoff and the MIN_TURNS floor. Returns the two ids
// that should qualify.
function seedRepoWithTwoCandidates(db: DB, repo = 'o/r'): string[] {
  for (let i = 0; i < 9; i++) addSessionWithTurns(db, `${repo}-filler-${i}`, 5, repo)
  const winners = [`${repo}-big-1`, `${repo}-big-2`]
  for (const id of winners) {
    addSessionWithTurns(db, id, 50, repo)
    giveTwoFeatures(db, id)
  }
  return winners
}

// A fake LLM returning canned structured data for every completion.
function fakeLlmClient(data: Record<string, unknown>): LlmClient {
  return {
    provider: 'fake',
    model: 'fake',
    async completeStructured() {
      return { data, usage: { ...emptyUsage(), input: 100, output: 20 } }
    },
  }
}

/** Like fakeLlmClient, but the Nth call throws — a transient error mid-loop. */
function flakyLlmClient(data: Record<string, unknown>, failOnCall: number): LlmClient {
  let calls = 0
  return {
    provider: 'fake',
    model: 'fake',
    async completeStructured() {
      if (++calls === failOnCall) throw new Error('429 rate limited')
      return { data, usage: { ...emptyUsage(), input: 100, output: 20 } }
    },
  }
}

function ctxWith(store: Store, llm: LlmClient | null, limit?: number): DetectorContext {
  return { store, log: { debug() {}, info() {}, warn() {} }, llmEnabled: llm != null, llm, limit } as unknown as DetectorContext
}

// A previously-surfaced aggregate, so the empty-path resolve has a card to act on.
const staleAggregate = (): InsightInput => ({
  signalKey: 'kitchen-sink', repo: '*', severity: 'high', title: 'stale', description: 'stale',
  evidence: [], count: 3, fix: { type: 'behavioral-nudge', label: 'x', content: 'y' },
})

// Ingest a real multi-block session (blob + matching blocks + 2 features) large
// enough to clear MIN_TURNS. Each user turn opens a block (seqs 2k / 2k+1), so
// `turns` user turns produce `turns` blocks; the seeded blocks table matches what
// blockDigest recomputes from the blob. Block 1 opens at seq 2.
function ingestCandidate(store: Store, id: string, repo = 'o/r', turns = 12, startedAt = RECENT) {
  const prompts = ['fix the auth token refresh', 'now add a CSV export button to the report page']
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  for (let k = 0; k < turns; k++) {
    events.push({ kind: 'user', text: prompts[k] ?? `step ${k}`, blocks: [], isSidechain: false, seq: 2 * k })
    events.push({ kind: 'assistant', blocks: [{ type: 'tool_use', id: `t${k}`, name: 'Write', input: {} }], usage: emptyUsage(), isSidechain: false, seq: 2 * k + 1 })
    toolCalls.push({ id: `t${k}`, name: 'Write', action: 'file_write' as CanonicalAction, input: {}, target: { paths: [`f${k}.ts`] }, result: { ok: true, isError: false }, isSidechain: false })
  }
  const session: Session = {
    id, sessionId: id, source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo }, models: ['claude-haiku-4-5'], tokens: emptyUsage(),
    events, toolCalls, raw: { path: '', contentHash: `${id}-hash` },
    startedAt,
  }
  store.ingestSession(session, 0, [], 'test', 1)
  // ingestSession writes the blob but not the blocks table (segment-blocks does);
  // seed blocks matching deterministicBlocks: block k covers seqs 2k..2k+1.
  const db = store['db'] as DB
  const ins = db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
  for (let k = 0; k < turns; k++) {
    ins.run(id, k, 2 * k, 2 * k + 1, k === turns - 1 ? 'session_end' : 'user_turn', 'segment-blocks')
  }
  giveTwoFeatures(db, id)
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
    // verdicts live in their own table and the card is windowed at read time.
    expect(kitchenSink.version).toBe(4)
  })

  it('returns no insights on an empty store', async () => {
    const { ctx } = setup()
    expect(await kitchenSink.run(ctx)).toEqual({ insights: [] })
  })
})

describe('realUserTurns', () => {
  it('counts the opening block plus every user_turn boundary', () => {
    const { db, store } = setup()
    // 4 blocks: block0 ends on a commit, block1 & block2 on user turns, block3 on session end.
    // Human typed 3 times → 1 (opening) + 2 user_turn boundaries = 3.
    addBlocks(db, 's1', ['commit', 'user_turn', 'user_turn', 'session_end'])
    expect(realUserTurns(store, SINCE).get('s1')).toBe(3)
  })

  it('excludes commit and PR boundaries from the count', () => {
    const { db, store } = setup()
    // Every boundary is a commit/PR — no human turns after the opener → count is 1.
    addBlocks(db, 's1', ['commit', 'pr_create', 'pr_merge', 'session_end'])
    expect(realUserTurns(store, SINCE).get('s1')).toBe(1)
  })

  it('counts each session independently', () => {
    const { db, store } = setup()
    addBlocks(db, 'long', ['user_turn', 'user_turn', 'user_turn', 'session_end']) // 1 + 3 = 4
    addBlocks(db, 'short', ['session_end']) // 1 + 0 = 1
    const turns = realUserTurns(store, SINCE)
    expect(turns.get('long')).toBe(4)
    expect(turns.get('short')).toBe(1)
  })

  it('omits sessions with no blocks', () => {
    const { db, store } = setup()
    addSession(db, 'no-blocks')
    expect(realUserTurns(store, SINCE).has('no-blocks')).toBe(false)
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
    expect(artifactCounts(store, SINCE).get('s1')).toEqual({ features: 2, prs: 1 })
  })

  it('ignores non-feature, non-PR artifacts', () => {
    const { db, store } = setup()
    addSession(db, 's1')
    addArtifact(db, 'commit-1', 'commit')
    addArtifact(db, 'file-1', 'file')
    linkArtifact(db, 's1', 'commit-1')
    linkArtifact(db, 's1', 'file-1')
    expect(artifactCounts(store, SINCE).has('s1')).toBe(false)
  })

  it('does not double-count a feature linked under two roles', () => {
    const { db, store } = setup()
    addSession(db, 's1')
    addArtifact(db, 'pr-1', 'pr')
    linkArtifact(db, 's1', 'pr-1', 'contributed')
    linkArtifact(db, 's1', 'pr-1', 'reviewed')
    expect(artifactCounts(store, SINCE).get('s1')).toEqual({ features: 0, prs: 1 })
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
    const counts = artifactCounts(store, SINCE)
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
  it('keeps large, multi-feature sessions in a repo with enough samples', () => {
    const { db, store } = setup()
    const winners = seedRepoWithTwoCandidates(db)
    expect(candidates(store).map((c) => c.sessionId).sort()).toEqual(winners.sort())
  })

  it('drops sessions below the MIN_TURNS floor even with 2+ features', () => {
    const { db, store } = setup()
    for (let i = 0; i < 12; i++) addSessionWithTurns(db, `filler-${i}`, 5)
    // A 9-turn session (below MIN_TURNS=10) with 2 features is still too small to flag.
    addSessionWithTurns(db, 'short', 9)
    giveTwoFeatures(db, 'short')
    expect(candidates(store).map((c) => c.sessionId)).not.toContain('short')
  })

  it('drops large sessions that did not advance 2+ features or PRs', () => {
    const { db, store } = setup()
    for (let i = 0; i < 12; i++) addSessionWithTurns(db, `filler-${i}`, 5)
    addSessionWithTurns(db, 'solo', 50) // large but only ONE feature
    db.prepare("INSERT INTO artifacts (id, kind) VALUES ('feat-a', 'feature')").run()
    db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
      .run('solo', 'feat-a', 'x', 'x', 'p')
    expect(candidates(store).map((c) => c.sessionId)).not.toContain('solo')
  })

  it('qualifies on 2+ PRs alone', () => {
    const { db, store } = setup()
    for (let i = 0; i < 12; i++) addSessionWithTurns(db, `filler-${i}`, 5)
    addSessionWithTurns(db, 'prs', 50)
    for (const p of ['pr-1', 'pr-2']) {
      db.prepare("INSERT INTO artifacts (id, kind) VALUES (?, 'pr')").run(p)
      db.prepare('INSERT INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?,?,?,?)')
        .run('prs', p, 'x', 'x', 'p')
    }
    expect(candidates(store).map((c) => c.sessionId)).toContain('prs')
  })

  it('skips a repo with fewer than MIN_SESSIONS and relies on the absolute floor', () => {
    const { db, store } = setup()
    // Only 3 sessions in the repo → percentile is not applied. A 50-turn 2-feature
    // session still qualifies via MIN_TURNS; a 5-turn one does not.
    addSessionWithTurns(db, 'big', 50)
    giveTwoFeatures(db, 'big')
    addSessionWithTurns(db, 'mid', 20)
    giveTwoFeatures(db, 'mid')
    addSessionWithTurns(db, 'tiny', 5)
    giveTwoFeatures(db, 'tiny')
    const ids = candidates(store).map((c) => c.sessionId).sort()
    expect(ids).toEqual(['big', 'mid'])
  })

  it('applies the per-repo cutoff once a repo has enough samples', () => {
    const { db, store } = setup()
    // 12 sessions: eleven at 12 turns, one at 100. p75 cutoff sits at 12, so the
    // 100-turn session clears it; a 12-turn one only qualifies if it also has 2 features.
    for (let i = 0; i < 11; i++) addSessionWithTurns(db, `f-${i}`, 12)
    addSessionWithTurns(db, 'huge', 100)
    giveTwoFeatures(db, 'huge')
    expect(candidates(store).map((c) => c.sessionId)).toEqual(['huge'])
  })

  it('scans globally — a session older than the card window is still a candidate', () => {
    const { db, store } = setup()
    // 60 days old, so it would fall outside the 30-day card window — but candidate
    // SELECTION is global now; the window is applied only when the card is built.
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    addSessionWithTurns(db, 'old', 50, 'o/r')
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(old, 'old')
    giveTwoFeatures(db, 'old')
    expect(candidates(store).map((c) => c.sessionId)).toContain('old')
  })

  it('excludes a session with a NULL started_at (it can never be windowed on the card)', () => {
    const { db, store } = setup()
    for (let i = 0; i < 12; i++) addSessionWithTurns(db, `filler-${i}`, 5)
    db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at, content_hash) VALUES (?,?,?,?,?,NULL,?)')
      .run('nostart', 'nostart', 'claude-code', 'anthropic', 'o/r', 'nostart-hash')
    const ins = db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
    Array.from({ length: 49 }, () => 'user_turn').concat('session_end').forEach((bk, idx) => ins.run('nostart', idx, idx, idx, bk, 'segment-blocks'))
    giveTwoFeatures(db, 'nostart')
    expect(candidates(store).map((c) => c.sessionId)).not.toContain('nostart')
  })

  it('skips a session with a NULL content_hash', () => {
    const { db, store } = setup()
    // A large, multi-feature session that would qualify, but its content_hash is NULL.
    db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at, content_hash) VALUES (?,?,?,?,?,?,NULL)')
      .run('nohash', 'nohash', 'claude-code', 'anthropic', 'o/r', RECENT)
    const boundaries = Array.from({ length: 49 }, () => 'user_turn')
    boundaries.push('session_end')
    const ins = db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
    boundaries.forEach((bk, idx) => ins.run('nohash', idx, idx, idx, bk, 'segment-blocks'))
    giveTwoFeatures(db, 'nohash')
    expect(candidates(store).map((c) => c.sessionId)).not.toContain('nohash')
  })
})

describe('unseenCandidates', () => {
  it('returns all candidates when none have been seen', () => {
    const { db, store } = setup()
    const winners = seedRepoWithTwoCandidates(db)
    expect(unseenCandidates(store).map((c) => c.sessionId).sort()).toEqual(winners.sort())
  })

  it('skips a candidate already seen at its current content hash', () => {
    const { db, store } = setup()
    const [a, b] = seedRepoWithTwoCandidates(db)
    store.markDetectorSessionSeen('kitchen-sink', [{ sessionId: a!, contentHash: `${a}-hash` }])
    expect(unseenCandidates(store).map((c) => c.sessionId)).toEqual([b])
  })

  it('re-surfaces a candidate whose content hash changed', () => {
    const { db, store } = setup()
    const winners = seedRepoWithTwoCandidates(db)
    store.markDetectorSessionSeen('kitchen-sink', [{ sessionId: winners[0]!, contentHash: 'stale-hash' }])
    expect(unseenCandidates(store).map((c) => c.sessionId).sort()).toEqual(winners.sort())
  })
})

describe('buildRequest', () => {
  const digest = '[0] user: "fix login" · git commit\n[1] user: "add export" · 2 file writes'

  it('embeds the digest and block count in the user content', () => {
    const req = buildRequest(digest, 2)
    expect(req.user).toContain(digest)
    expect(req.user).toContain('2 contiguous slice(s)')
  })

  it('forces the record_kitchen_sink tool with the verdict schema', () => {
    const req = buildRequest(digest, 2)
    expect(req.toolName).toBe('record_kitchen_sink')
    const props = (req.schema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['isKitchenSink', 'reason', 'splitBlockIdx'])
    expect((req.schema as { required: string[] }).required.sort()).toEqual(['isKitchenSink', 'reason', 'splitBlockIdx'])
  })

  it('instructs the model to answer false when unsure', () => {
    expect(buildRequest(digest, 2).user.toLowerCase()).toContain('unsure')
  })
})

describe('judge', () => {
  const digest = '[0] user: "fix auth" · git commit\n[1] user: "add export" · 2 file writes'
  // A 2-block partition matching the digest; block 1 opens at seq 2.
  const blocks2: Block[] = [
    { idx: 0, startSeq: 0, endSeq: 1, boundaryKind: 'commit' },
    { idx: 1, startSeq: 2, endSeq: 3, boundaryKind: 'session_end' },
  ]

  // A fake LLM that returns canned structured data and captures the request.
  function fakeLlm(data: Record<string, unknown>): { llm: LlmClient; seen: StructuredRequest[] } {
    const seen: StructuredRequest[] = []
    const llm: LlmClient = {
      provider: 'fake',
      model: 'fake',
      async completeStructured(req) {
        seen.push(req)
        return { data, usage: { ...emptyUsage(), input: 100, output: 20 } }
      },
    }
    return { llm, seen }
  }

  it('passes the block count derived from the digest to the request', async () => {
    const { llm, seen } = fakeLlm({ isKitchenSink: false, splitBlockIdx: -1, reason: 'one thread' })
    await judge(llm, digest, blocks2)
    expect(seen[0]!.user).toContain('2 contiguous slice(s)')
  })

  it('accepts a positive verdict with an in-range split index', async () => {
    const { llm } = fakeLlm({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth then unrelated export' })
    const { verdict, usage } = await judge(llm, digest, blocks2)
    expect(verdict).toEqual({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth then unrelated export' })
    expect(usage.input).toBe(100)
  })

  it('treats a negative verdict as not a kitchen sink', async () => {
    const { llm } = fakeLlm({ isKitchenSink: false, splitBlockIdx: -1, reason: 'coherent' })
    expect((await judge(llm, digest, blocks2)).verdict.isKitchenSink).toBe(false)
  })

  it('demotes a positive verdict whose split index is out of range', async () => {
    const { llm } = fakeLlm({ isKitchenSink: true, splitBlockIdx: 5, reason: 'bad index' })
    const { verdict } = await judge(llm, digest, blocks2)
    expect(verdict.isKitchenSink).toBe(false)
    expect(verdict.splitBlockIdx).toBe(-1)
  })

  it('demotes a positive verdict split at block 0 (nothing precedes it to split off)', async () => {
    const { llm } = fakeLlm({ isKitchenSink: true, splitBlockIdx: 0, reason: 'split at start' })
    const { verdict } = await judge(llm, digest, blocks2)
    expect(verdict.isKitchenSink).toBe(false)
    expect(verdict.splitBlockIdx).toBe(-1)
  })

  it('treats a malformed response as not a kitchen sink', async () => {
    const { llm } = fakeLlm({ garbage: true })
    const { verdict } = await judge(llm, digest, blocks2)
    expect(verdict.isKitchenSink).toBe(false)
    expect(verdict.reason).toBe('')
  })
})

describe('verdictRow', () => {
  const candidate = { sessionId: 's1', repo: 'o/r', turns: 10, features: 2, prs: 0, contentHash: 'h', startedAt: '2026-06-25T00:00:00Z', endedAt: '2026-07-06T00:00:00Z' }
  const blocks3: Block[] = [
    { idx: 0, startSeq: 0, endSeq: 3, boundaryKind: 'user_turn' },
    { idx: 1, startSeq: 4, endSeq: 7, boundaryKind: 'user_turn' },
    { idx: 2, startSeq: 8, endSeq: 9, boundaryKind: 'session_end' },
  ]

  it('resolves a positive verdict to its split block idx and opening seq', () => {
    const row = verdictRow(candidate, { isKitchenSink: true, splitBlockIdx: 1, reason: ' auth then export. ' }, blocks3)
    // block 1 opens at seq 4 in blocks3; the reason is trimmed.
    expect(row).toEqual({ sessionId: 's1', isKitchenSink: true, splitBlockIdx: 1, splitSeq: 4, reason: 'auth then export.' })
  })

  it('records a negative verdict with no split point or seq', () => {
    const row = verdictRow(candidate, { isKitchenSink: false, splitBlockIdx: -1, reason: 'coherent' }, blocks3)
    expect(row).toEqual({ sessionId: 's1', isKitchenSink: false, splitBlockIdx: null, splitSeq: null, reason: 'coherent' })
  })

  it('leaves splitSeq null when the split index is out of the partition', () => {
    const row = verdictRow(candidate, { isKitchenSink: true, splitBlockIdx: 9, reason: 'x' }, blocks3)
    expect(row.splitSeq).toBeNull()
    expect(row.splitBlockIdx).toBe(9)
  })

  it('normalizes an empty reason to null', () => {
    expect(verdictRow(candidate, { isKitchenSink: true, splitBlockIdx: 1, reason: '  ' }, blocks3).reason).toBeNull()
  })
})

describe('positiveEvidence', () => {
  it('uses the plain-language reason as the note, verbatim (no preamble, no block jargon)', () => {
    const ev = positiveEvidence({ sessionId: 's1', splitBlockIdx: 1, splitSeq: 4, reason: 'auth fix then unrelated marketing copy.' })
    expect(ev).toEqual({ sessionId: 's1', turnIdx: 4, note: 'auth fix then unrelated marketing copy.' })
  })

  it('omits turnIdx when the stored split seq is null', () => {
    const ev = positiveEvidence({ sessionId: 's1', splitBlockIdx: 1, splitSeq: null, reason: 'x' })
    expect(ev.turnIdx).toBeUndefined()
    expect(ev.sessionId).toBe('s1')
  })

  it('omits the note entirely when the reason is null', () => {
    expect(positiveEvidence({ sessionId: 's1', splitBlockIdx: 1, splitSeq: 4, reason: null }).note).toBeUndefined()
  })
})

describe('buildAggregate', () => {
  const ev = (id: string): { sessionId: string; turnIdx?: number; note?: string } => ({ sessionId: id, turnIdx: 4, note: 'x' })

  it('returns null when nothing is flagged', () => {
    expect(buildAggregate([])).toBeNull()
  })

  it('builds one cross-repo insight whose count is the flagged-session tally', () => {
    const insight = buildAggregate([ev('a'), ev('b')], '2026-06-25T00:00:00Z', '2026-07-06T00:00:00Z')!
    expect(insight.signalKey).toBe('kitchen-sink')
    expect(insight.repo).toBe('*')
    expect(insight.count).toBe(2)
    expect(insight.title).toBe('2 sessions mixed unrelated work')
    expect(insight.evidence).toHaveLength(2)
    expect(insight.firstSeenAt).toBe('2026-06-25T00:00:00Z')
    expect(insight.lastSeenAt).toBe('2026-07-06T00:00:00Z')
    expect(insight.fix.type).toBe('behavioral-nudge')
  })

  it('uses the singular title for a single flagged session', () => {
    expect(buildAggregate([ev('a')])!.title).toBe('1 session mixed unrelated work')
  })

  it('raises severity to high at 3+ flagged sessions', () => {
    expect(buildAggregate([ev('a'), ev('b')])!.severity).toBe('medium')
    expect(buildAggregate([ev('a'), ev('b'), ev('c')])!.severity).toBe('high')
  })
})

describe('store: kitchen_sink_verdict round-trip', () => {
  // Windowed (in-window) and out-of-window timestamps, computed once so insert and
  // assert reference the same string.
  const WIN_START = daysAgoZ(30)
  const t5 = daysAgoZ(5)
  const t2 = daysAgoZ(2)
  const t60 = daysAgoZ(60)

  const positive = (sessionId: string) => ({ sessionId, isKitchenSink: true, splitBlockIdx: 1, splitSeq: 4, reason: 'mixed', model: 'm', detectorVersion: 3 })
  const negative = (sessionId: string) => ({ sessionId, isKitchenSink: false, splitBlockIdx: null, splitSeq: null, reason: 'coherent', model: 'm', detectorVersion: 3 })

  it('returns only in-window positives, most-recent first, with first-seen over ALL positives', () => {
    const { db, store } = setup()
    addSession(db, 'recent-a', 'o/r', t5)
    addSession(db, 'recent-b', 'o/r', t2)
    addSession(db, 'old', 'o/r', t60)
    addSession(db, 'coherent', 'o/r', t5)
    store.recordKitchenSinkVerdicts([positive('recent-a'), positive('recent-b'), positive('old'), negative('coherent')])

    const card = store.kitchenSinkPositives(WIN_START)
    // 'old' is out of window; 'coherent' is negative → neither appears.
    expect(card.positives.map((p) => p.sessionId)).toEqual(['recent-b', 'recent-a'])
    // count/evidence are windowed, but first-seen reaches back to the oldest positive.
    expect(card.firstSeenAt).toBe(t60)
    expect(card.lastSeenAt).toBe(t2)
  })

  it('a positive re-judged negative drops out of the window (plain upsert)', () => {
    const { db, store } = setup()
    addSession(db, 's1', 'o/r', t5)
    store.recordKitchenSinkVerdicts([positive('s1')])
    expect(store.kitchenSinkPositives(WIN_START).positives).toHaveLength(1)
    store.recordKitchenSinkVerdicts([negative('s1')])
    expect(store.kitchenSinkPositives(WIN_START).positives).toEqual([])
  })

  it('returns nulls when there are no positives at all', () => {
    const { db, store } = setup()
    addSession(db, 's1', 'o/r', t5)
    store.recordKitchenSinkVerdicts([negative('s1')])
    expect(store.kitchenSinkPositives(WIN_START)).toEqual({ positives: [], firstSeenAt: null, lastSeenAt: null })
  })
})

describe('kitchenSink.run (end to end)', () => {
  it('returns no insights when no LLM is configured', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    expect(await kitchenSink.run(ctxWith(store, null))).toEqual({ insights: [] })
  })

  it('flags a confirmed candidate as one aggregate insight and persists it retrievably', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth fix then unrelated CSV export.' })

    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(result.insights).toHaveLength(1)
    expect(result.insights[0]!.signalKey).toBe('kitchen-sink')
    expect(result.insights[0]!.repo).toBe('*')
    expect(result.insights[0]!.count).toBe(1)
    // Reports the judged session as seen and its LLM spend, but does not mark seen itself.
    expect(result.seen).toEqual([{ sessionId: 'kc:1', contentHash: 'kc:1-hash' }])
    expect(result.cost?.inTokens).toBe(100)

    // Persist through the real store path and read it back.
    store.persistInsights('kitchen-sink', kitchenSink.version, result.insights)
    const row = store.insights().find((r) => r.signalKey === 'kitchen-sink')
    expect(row).toBeDefined()
    // Block 1 opens at seq 2 in the ingested session — the evidence points there.
    expect(row!.evidence[0]?.turnIdx).toBe(2)
  })

  it('accumulates flagged sessions across runs by merging into stored evidence', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth then export.' })

    // Run 1: judge kc:1, persist the aggregate, mark it seen (as the runner would).
    const r1 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    store.persistInsights('kitchen-sink', kitchenSink.version, r1.insights)
    store.markDetectorSessionSeen('kitchen-sink', r1.seen ?? [])

    // Run 2: kc:2 is new; kc:1 is already seen, so only kc:2 is judged — yet the
    // aggregate must still carry BOTH (read-back merge), not shrink to just kc:2.
    ingestCandidate(store, 'kc:2')
    const r2 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(r2.seen).toEqual([{ sessionId: 'kc:2', contentHash: 'kc:2-hash' }])
    expect(r2.insights[0]!.count).toBe(2)
    expect(r2.insights[0]!.evidence.map((e) => e.sessionId).sort()).toEqual(['kc:1', 'kc:2'])
  })

  it('resolves the aggregate when a re-judged session clears the last flag', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    // Run 1: flag it.
    const pos = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' })
    const r1 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, pos)))
    store.persistInsights('kitchen-sink', kitchenSink.version, r1.insights)
    // kc:1's content changes → unseen again; re-judged negative this time.
    store['db'].prepare('UPDATE sessions SET content_hash = ? WHERE id = ?').run('kc:1-hash-v2', 'kc:1')
    const neg = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'coherent.' })
    const r2 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, neg)))
    store.persistInsights('kitchen-sink', kitchenSink.version, r2.insights)
    expect(r2.insights).toEqual([]) // nothing flagged → no aggregate emitted
    // The prior aggregate is retired, not left surfaced.
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')?.state).toBe('resolved')
  })

  it('reports a judged session as seen even on a negative verdict', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    const llm = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'one coherent thread.' })

    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(result.insights).toEqual([])
    expect(result.seen).toEqual([{ sessionId: 'kc:1', contentHash: 'kc:1-hash' }])

    // The runner marks the reported delta seen; a second run then has nothing to re-judge.
    store.markDetectorSessionSeen('kitchen-sink', result.seen ?? [])
    expect(unseenCandidates(store)).toEqual([])
  })

  it('omits cost when nothing was judged (no unseen candidates)', async () => {
    const { store } = setup() // empty store → no candidates
    const llm = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'x' })
    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(result.insights).toEqual([])
    expect(result.cost).toBeUndefined()
  })

  it('a mid-loop judge failure keeps the judgments already paid for', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    ingestCandidate(store, 'kc:2')
    // Second judge call throws (a 429 lands here). Whichever candidate that is,
    // the run must keep the verdict it already paid for rather than discarding it.
    const llm = flakyLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' }, 2)
    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(result.seen).toHaveLength(1) // only the successfully judged session
    expect(result.insights).toHaveLength(1) // the aggregate still persists
    expect(result.cost?.inTokens).toBe(100) // the call that ran is still accounted for
  })

  it('leaves the failed candidate unseen so the next run retries and merges it', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    ingestCandidate(store, 'kc:2')
    const flaky = flakyLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' }, 2)
    const r1 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, flaky)))
    store.persistInsights('kitchen-sink', kitchenSink.version, r1.insights)
    store.markDetectorSessionSeen('kitchen-sink', r1.seen ?? [])

    // The candidate that failed is still unseen, so a healthy run picks it up and
    // the aggregate reaches both — no session is silently dropped by the failure.
    const healthy = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' })
    const r2 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, healthy)))
    expect(r2.seen).toHaveLength(1)
    expect(r2.insights[0]!.count).toBe(2)
  })

  it('reports step-2 progress: declares its delta and ticks once per candidate', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    ingestCandidate(store, 'kc:2')
    const llm = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'x' })
    const prog = { units: 0, ticks: 0,
      addUnits(n: number) { this.units += n },
      unitDone() { this.ticks++ },
      addCost() {},
    }
    const ctx = { store, log: { debug() {}, info() {}, warn() {} }, llmEnabled: true, llm, progress: prog } as unknown as DetectorContext
    await kitchenSink.run(ctx)
    expect(prog.units).toBe(2) // declared both candidates up front
    expect(prog.ticks).toBe(2) // one tick per candidate, whatever the verdict (bar total stays honest)
  })

  it('ages a flagged session off the card once it falls outside the 30-day window', async () => {
    const { store } = setup()
    // Judged positive, but the session ran 60 days ago — outside the card window.
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    ingestCandidate(store, 'kc:old', 'o/r', 12, old)
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth then export.' })

    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    // It WAS judged (global scan) and its verdict cached, but the card is empty…
    expect(result.seen).toEqual([{ sessionId: 'kc:old', contentHash: 'kc:old-hash' }])
    expect(result.insights).toEqual([])
    // …and no stale claim is frozen — the aggregate is never surfaced.
    store.persistInsights('kitchen-sink', kitchenSink.version, result.insights)
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')).toBeNull()
  })

  it('windows the count but keeps first-seen at the earliest flagged session', async () => {
    const { store } = setup()
    const old = daysAgoZ(50) // out of window
    const recent = daysAgoZ(3) // in window
    ingestCandidate(store, 'kc:old', 'o/r', 12, old)
    ingestCandidate(store, 'kc:recent', 'o/r', 12, recent)
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' })

    const r = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    // Only the recent session is inside the window → count 1…
    expect(r.insights[0]!.count).toBe(1)
    expect(r.insights[0]!.evidence.map((e) => e.sessionId)).toEqual(['kc:recent'])
    // …but first-seen reaches back to the older (out-of-window) positive.
    expect(r.insights[0]!.firstSeenAt).toBe(old)
  })

  it('resolves a prior card when the window has sessions but none are kitchen-sinks (clean now)', async () => {
    const { store } = setup()
    store.persistInsights('kitchen-sink', kitchenSink.version, [staleAggregate()])
    ingestCandidate(store, 'kc:1') // a recent candidate — real activity in the window
    const neg = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'coherent.' })
    const r = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, neg)))
    expect(r.insights).toEqual([])
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')!.state).toBe('resolved')
  })

  it('does NOT resolve when the window has no sessions — not enough data', async () => {
    const { store } = setup()
    store.persistInsights('kitchen-sink', kitchenSink.version, [staleAggregate()])
    // Empty store: no sessions in the window at all (a user back from a month off).
    const llm = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'x' })
    const r = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(r.insights).toEqual([])
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')!.state).toBe('surfaced')
  })

  it('does NOT resolve while --limit leaves in-window candidates unjudged', async () => {
    const { store } = setup()
    store.persistInsights('kitchen-sink', kitchenSink.version, [staleAggregate()])
    ingestCandidate(store, 'kc:1')
    ingestCandidate(store, 'kc:2')
    // limit=1 → one candidate judged (negative); the other stays an unseen in-window
    // candidate that could yet be positive, so the backfill isn't done — don't resolve.
    const neg = fakeLlmClient({ isKitchenSink: false, splitBlockIdx: -1, reason: 'coherent.' })
    const r = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, neg, 1)))
    expect(r.seen).toHaveLength(1)
    expect(r.insights).toEqual([])
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')!.state).toBe('surfaced')

    // Runner marks the first seen; a follow-up run judges the rest → backfill complete
    // and, still clean, the card resolves.
    store.markDetectorSessionSeen('kitchen-sink', r.seen ?? [])
    normalizeDetectorResult(await kitchenSink.run(ctxWith(store, neg, 1)))
    expect(store.insightStatus('kitchen-sink', '*', 'kitchen-sink')!.state).toBe('resolved')
  })

  it('judges at most --limit candidates per run, leaving the rest unseen', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    ingestCandidate(store, 'kc:2')
    ingestCandidate(store, 'kc:3')
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'x' })

    // limit=2 → only two candidates judged this run (the backfill throttle).
    const r1 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm, 2)))
    expect(r1.seen).toHaveLength(2)
    expect(r1.cost?.inTokens).toBe(200) // two judge calls
    store.markDetectorSessionSeen('kitchen-sink', r1.seen ?? [])

    // The third is still unseen; a follow-up run picks it up.
    const r2 = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm, 2)))
    expect(r2.seen).toHaveLength(1)
  })
})
