import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { artifactCounts, buildRequest, candidates, judge, kitchenSink, realUserTurns, sizeCutoff, toInsight, unseenCandidates } from './kitchen-sink'
import { normalizeDetectorResult } from '../core/detector'
import type { DetectorContext } from '../core/detector'
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

function ctxWith(store: Store, llm: LlmClient | null): DetectorContext {
  return { store, log: { debug() {}, info() {}, warn() {} }, llmEnabled: llm != null, llm } as unknown as DetectorContext
}

// Ingest a real multi-block session (blob + matching blocks + 2 features) large
// enough to clear MIN_TURNS. Each user turn opens a block (seqs 2k / 2k+1), so
// `turns` user turns produce `turns` blocks; the seeded blocks table matches what
// blockDigest recomputes from the blob. Block 1 opens at seq 2.
function ingestCandidate(store: Store, id: string, repo = 'o/r', turns = 12) {
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
    startedAt: RECENT,
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

  it('ignores sessions outside the 30-day window', () => {
    const { db, store } = setup()
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    addSession(db, 'old', 'o/r', old)
    db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
      .run('old', 0, 0, 0, 'session_end', 'segment-blocks')
    giveTwoFeatures(db, 'old')
    expect(candidates(store)).toEqual([])
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

  it('treats a malformed response as not a kitchen sink', async () => {
    const { llm } = fakeLlm({ garbage: true })
    const { verdict } = await judge(llm, digest, blocks2)
    expect(verdict.isKitchenSink).toBe(false)
    expect(verdict.reason).toBe('')
  })
})

describe('toInsight', () => {
  const candidate = { sessionId: 's1', repo: 'o/r', turns: 10, features: 2, prs: 0, contentHash: 'h' }
  const blocks3: Block[] = [
    { idx: 0, startSeq: 0, endSeq: 3, boundaryKind: 'user_turn' },
    { idx: 1, startSeq: 4, endSeq: 7, boundaryKind: 'user_turn' },
    { idx: 2, startSeq: 8, endSeq: 9, boundaryKind: 'session_end' },
  ]

  it('points evidence at the split block’s start_seq', () => {
    const insight = toInsight(candidate, { isKitchenSink: true, splitBlockIdx: 1, reason: 'auth then export.' }, blocks3)
    expect(insight.signalKey).toBe('kitchen-sink:s1')
    expect(insight.repo).toBe('o/r')
    // block 1 opens at seq 4 in blocks3.
    expect(insight.evidence).toEqual([{ sessionId: 's1', turnIdx: 4 }])
    expect(insight.fix.type).toBe('behavioral-nudge')
    expect(insight.description).toContain('auth then export.')
  })

  it('raises severity to high when 3+ distinct jobs', () => {
    const wide = { ...candidate, features: 3 }
    expect(toInsight(wide, { isKitchenSink: true, splitBlockIdx: 0, reason: 'x' }, blocks3).severity).toBe('high')
    expect(toInsight(candidate, { isKitchenSink: true, splitBlockIdx: 0, reason: 'x' }, blocks3).severity).toBe('medium')
  })

  it('omits turnIdx when the split index is out of the partition', () => {
    const insight = toInsight(candidate, { isKitchenSink: true, splitBlockIdx: 9, reason: 'x' }, blocks3)
    expect(insight.evidence).toEqual([{ sessionId: 's1' }])
  })

  it('does not leave a double space when the reason is empty', () => {
    const insight = toInsight(candidate, { isKitchenSink: true, splitBlockIdx: 0, reason: '' }, blocks3)
    expect(insight.description).not.toContain('  ')
    expect(insight.description).toContain('one sitting. Carrying')
  })
})

describe('kitchenSink.run (end to end)', () => {
  it('returns no insights when no LLM is configured', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    expect(await kitchenSink.run(ctxWith(store, null))).toEqual({ insights: [] })
  })

  it('flags a confirmed candidate and persists a retrievable insight', async () => {
    const { store } = setup()
    ingestCandidate(store, 'kc:1')
    const llm = fakeLlmClient({ isKitchenSink: true, splitBlockIdx: 1, reason: 'auth fix then unrelated CSV export.' })

    const result = normalizeDetectorResult(await kitchenSink.run(ctxWith(store, llm)))
    expect(result.insights).toHaveLength(1)
    expect(result.insights[0]!.signalKey).toBe('kitchen-sink:kc:1')
    // Reports the judged session as seen and its LLM spend, but does not mark seen itself.
    expect(result.seen).toEqual([{ sessionId: 'kc:1', contentHash: 'kc:1-hash' }])
    expect(result.cost?.inTokens).toBe(100)

    // Persist through the real store path and read it back.
    store.persistInsights('kitchen-sink', 1, result.insights)
    const rows = store.insights()
    expect(rows.map((r) => r.signalKey)).toContain('kitchen-sink:kc:1')
    expect(rows.find((r) => r.signalKey === 'kitchen-sink:kc:1')?.evidence[0]?.turnIdx).toBe(2)
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
})
