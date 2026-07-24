import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { cacheMiss } from './cache-miss'
import type { DetectorContext, InsightInput } from '../core/detector'

// claude-fable-5 rates: cache_write_5m $12.5/Mtok, cache_read $1.0/Mtok → premium $11.5/Mtok re-bought.
const MODEL = 'claude-fable-5'
const DAY_MS = 86_400_000
const MIN = 60_000

// queryAll() reopens the db file read-only, so tests need a real file, not :memory:.
let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-miss-'))
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

// A previously-surfaced card, seeded so the empty-path resolve has something to act on.
const staleCard = (signalKey: string): InsightInput => ({
  signalKey, repo: '*', severity: 'high', title: 'stale', description: 'stale',
  evidence: [], count: 5, fix: { type: 'behavioral-nudge', label: 'x', content: 'y' },
})

interface UsageSpec {
  atMs: number // offset from session start
  input?: number
  output?: number
  creates?: number
  creates1h?: number
  reads?: number
  sidechain?: boolean
}

function seedSession(
  db: ReturnType<typeof openDb>,
  id: string,
  usage: UsageSpec[],
  over: { repo?: string; provider?: string; model?: string } = {},
) {
  const startMs = Date.now() - DAY_MS // comfortably inside the window
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)').run(
    id, id, 'claude-code', over.provider ?? 'anthropic', over.repo ?? 'o/r', '/repo', new Date(startMs).toISOString(),
  )
  const ins = db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,0)',
  )
  usage.forEach((u, idx) => {
    ins.run(id, idx, over.model ?? MODEL, u.sidechain ? 1 : 0, new Date(startMs + u.atMs).toISOString(), u.input ?? 0, u.output ?? 0, u.creates ?? 0, u.creates1h ?? 0, u.reads ?? 0)
  })
}

// Like seedSession, but decouples the session's started_at from its turn
// timestamps — to exercise the event-ts window (decision 7), where a card is
// dated by when a turn happened, not by when its session began.
function seedDecoupled(
  db: ReturnType<typeof openDb>,
  id: string,
  usage: UsageSpec[],
  startedAtIso: string,
  tsBaseMs: number,
  over: { repo?: string; provider?: string; model?: string } = {},
) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)').run(
    id, id, 'claude-code', over.provider ?? 'anthropic', over.repo ?? 'o/r', '/repo', startedAtIso,
  )
  const ins = db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,0)',
  )
  usage.forEach((u, idx) => {
    ins.run(id, idx, over.model ?? MODEL, u.sidechain ? 1 : 0, new Date(tsBaseMs + u.atMs).toISOString(), u.input ?? 0, u.output ?? 0, u.creates ?? 0, u.creates1h ?? 0, u.reads ?? 0)
  })
}

// Point a block at a session's miss turn (usage idx `usageIdx`) opening at `seq` —
// the coordinate the transcript viewer lands evidence on.
function seedBlock(db: ReturnType<typeof openDb>, sessionId: string, usageIdx: number, seq: number) {
  db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)').run(
    sessionId, 0, seq, seq + 5, 'user_turn', 'test',
  )
  db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx, producer) VALUES (?,?,?,?)').run(sessionId, usageIdx, 0, 'test')
}

// Cold session: after a 10-min break the next turn reads nothing back and
// re-writes the whole 200k context → miss, premium 200k × $11.5/Mtok = $2.30.
// The turn after reads it all back → hit. Per session: 2 classified turns,
// 1 miss (rate 0.5), 1 break-associated.
const coldSession: UsageSpec[] = [
  { atMs: 0, creates: 200_000 },
  { atMs: 10 * MIN, creates: 220_000 },
  { atMs: 11 * MIN, reads: 220_000, creates: 5_000 },
]

// Warm session: quick turns, every turn reads its prior context back — all hits.
const warmSession: UsageSpec[] = [
  { atMs: 0, creates: 50_000 },
  { atMs: 1 * MIN, reads: 50_000, creates: 5_000 },
  { atMs: 2 * MIN, reads: 55_000, creates: 5_000 },
]

describe('cache-miss detector', () => {
  it('fires on a repo with observed misses, with quantified factual copy', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, coldSession)
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    const ins = insights[0]!
    expect(ins).toMatchObject({
      signalKey: 'cache-misses',
      repo: '*', // one cross-repo aggregate insight
      severity: 'medium', // 10 × $2.30 = $23.00: clears the $20 floor, below the $50 high bar
      count: 10, // one miss per session
      fix: { type: 'behavioral-nudge' },
    })
    expect(ins.evidence).toHaveLength(10)
    // Single qualifying repo → named directly; each evidence row notes its repo, premium, misses.
    expect(ins.evidence[0]!.note).toContain('o/r · $')
    expect(ins.evidence[0]!.note).toContain('1 cache miss') // one miss this session
    expect(ins.description).toContain('$23.00')
    expect(ins.description).toContain('10 sessions in o/r')
    expect(ins.description).toContain('100% of sessions saw a cache-miss event') // 10 of 10 sessions
    expect(ins.description).toContain('10 of the 10 misses came from messages sent more than 5 minutes after')
  })

  it('sources first/last-seen from the miss turns, not the analyze run', () => {
    const { db, ctx } = setup()
    // Two misses per session: idx 1 (10 min) and idx 3 (30 min). idx 2/4 read back → hits.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates: 200_000 },
        { atMs: 10 * MIN, creates: 220_000 }, // miss
        { atMs: 11 * MIN, reads: 220_000, creates: 5_000 }, // hit
        { atMs: 30 * MIN, creates: 220_000 }, // miss
        { atMs: 31 * MIN, reads: 220_000, creates: 5_000 }, // hit
      ])
    const ins = (cacheMiss.run(ctx) as InsightInput[])[0]!
    // First/last miss = the earliest/latest miss turn's ts, so they're a full session
    // in the past and exactly 20 min apart (the idx1→idx3 gap) — never the analyze run.
    const first = Date.parse(ins.firstSeenAt!)
    const last = Date.parse(ins.lastSeenAt!)
    // ~20 min apart (idx1→idx3 gap); a few ms slack since each session's start is
    // stamped at its own Date.now(). The point: both are real miss-turn times, not now.
    expect(last - first).toBeGreaterThanOrEqual(20 * MIN)
    expect(last - first).toBeLessThan(20 * MIN + 1000)
    expect(Date.now() - last).toBeGreaterThan(DAY_MS / 2) // clearly a past occurrence, not now
    expect(ins.evidence[0]!.note).toContain('2 cache misses') // two misses this session, pluralized
  })

  it('reports mid-flow misses honestly in the timing split (no cause claimed)', () => {
    const { db, ctx } = setup()
    // Cold every turn despite quick succession — churn-shaped, not idle-shaped.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates: 200_000 },
        { atMs: 1 * MIN, creates: 210_000 },
        { atMs: 2 * MIN, creates: 220_000 },
      ])
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(20)
    expect(insights[0]!.description).toContain('0 of the 20 misses came from messages sent more than 5 minutes after')
  })

  it('stays silent below the minimum session count', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 9; i++) seedSession(db, `s${i}`, coldSession)
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('stays silent when turns hit the cache', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, warmSession)
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('resolves a prior card when the window has enough sessions but no misses (clean now)', () => {
    const { db, store, ctx } = setup()
    store.persistInsights('cache-miss', 5, [staleCard('cache-misses')])
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, warmSession) // ≥ MIN_SESSIONS, all warm
    expect(cacheMiss.run(ctx)).toEqual([])
    expect(store.insightStatus('cache-miss', '*', 'cache-misses')!.state).toBe('resolved')
  })

  it('does NOT resolve when too few sessions saw activity — not enough data (W7)', () => {
    const { db, store, ctx } = setup()
    store.persistInsights('cache-miss', 5, [staleCard('cache-misses')])
    for (let i = 0; i < 3; i++) seedSession(db, `s${i}`, warmSession) // < MIN_SESSIONS
    expect(cacheMiss.run(ctx)).toEqual([])
    // A user back from a month off shouldn't be told they fixed it.
    expect(store.insightStatus('cache-miss', '*', 'cache-misses')!.state).toBe('surfaced')
  })

  it('does not call a big-paste turn a miss: reads decide, not creates or timing', () => {
    const { db, ctx } = setup()
    // Every turn reads its context back — the big post-break write is new content, not a re-warm.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates: 50_000 },
        { atMs: 20 * MIN, reads: 50_000, creates: 80_000 }, // pasted doc after a break, still a hit
        { atMs: 21 * MIN, reads: 130_000, creates: 5_000 },
      ])
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('all-zero rows are not API calls: neither classified nor allowed to reset the context', () => {
    const { db, ctx } = setup()
    // Codex content flushes and ingest-deduped claude-code repeat lines both land as all-zero rows.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates: 200_000 },
        { atMs: 1 * MIN }, // zero row between real turns
        { atMs: 10 * MIN, creates: 220_000 },
        { atMs: 10 * MIN + 1 }, // zero row right after a miss
        { atMs: 11 * MIN, reads: 220_000, creates: 5_000 },
      ])
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10) // the real miss survives; the zero row adds nothing
    expect(insights[0]!.description).toContain('$23.00')
  })

  it('context shrink (compaction/rewind) is neither hit nor miss: nothing was re-bought', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates: 200_000 },
        { atMs: 1 * MIN, creates: 30_000 }, // compacted: reads nothing, writes a small summary
        { atMs: 2 * MIN, reads: 30_000, creates: 2_000 },
      ])
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('output tokens do not inflate the expectation: a warm turn after a huge generation is a hit', () => {
    const { db, ctx } = setup()
    // 10 cold sessions + 10 whose first turn generated more than its whole context.
    // The follow-up reads back everything cacheable — output isn't cached yet, so it's a hit.
    for (let i = 0; i < 10; i++) seedSession(db, `cold${i}`, coldSession)
    for (let i = 0; i < 10; i++)
      seedSession(db, `gen${i}`, [
        { atMs: 0, creates: 30_000, output: 80_000 },
        { atMs: 1 * MIN, reads: 30_000, creates: 82_000 }, // prior output re-written, as it always is
        { atMs: 2 * MIN, reads: 112_000, creates: 2_000 },
      ])
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10) // only the cold sessions' misses
    expect(insights[0]!.description).toContain('$23.00') // no phantom waste from the gen sessions
  })

  it('ignores sidechain rows: subagent cold starts are not main-thread misses', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        ...warmSession,
        { atMs: 20 * MIN, creates: 900_000, sidechain: true },
        { atMs: 30 * MIN, creates: 900_000, sidechain: true },
      ])
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('excludes sessions with no cache tokens at all (provider does not report caching)', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, input: 200_000 },
        { atMs: 10 * MIN, input: 210_000 },
        { atMs: 20 * MIN, input: 220_000 },
      ])
    expect(cacheMiss.run(ctx)).toEqual([])
  })

  it('prices read-discount caching (OpenAI-style): misses re-pay as input, not creates', () => {
    const { db, ctx } = setup()
    // gpt-5.2: input $2.5/Mtok, cache_read $0.25/Mtok → premium $2.25/Mtok un-read.
    // Sized so 10 sessions clear the $20 floor (each re-buys 1M tokens at $2.25/Mtok = $2.25).
    for (let i = 0; i < 10; i++)
      seedSession(
        db, `s${i}`,
        [
          { atMs: 0, input: 1_000_000 },
          { atMs: 1 * MIN, reads: 995_000, input: 5_000 },
          { atMs: 40 * MIN, input: 1_200_000 },
        ],
        { provider: 'openai', model: 'gpt-5.2' },
      )
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    // premium = min(prevCtx 1.0M, input 1.2M) = 1.0M × $2.25/Mtok = $2.25 × 10 sessions = $22.50
    expect(insights[0]!).toMatchObject({ severity: 'medium', count: 10 })
    expect(insights[0]!.description).toContain('$22.50')
  })

  it('prices the re-buy at the write TTL mix: a 1h-heavy miss costs more than a 5m one', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { atMs: 0, creates1h: 200_000 },
        { atMs: 10 * MIN, creates1h: 220_000 },
        { atMs: 11 * MIN, reads: 220_000, creates1h: 5_000 },
      ])
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10)
    expect(insights[0]!.description).toContain('$38.00') // 10 × $3.80, priced at the 1h rate
  })

  it('aggregates qualifying repos into one insight, excluding a warm repo', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `a${i}`, coldSession, { repo: 'o/a' })
    for (let i = 0; i < 10; i++) seedSession(db, `b${i}`, coldSession, { repo: 'o/b' })
    for (let i = 0; i < 10; i++) seedSession(db, `w${i}`, warmSession, { repo: 'o/warm' })
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.repo).toBe('*')
    // Both cold repos fold in (20 misses); the warm repo contributes nothing.
    expect(insights[0]!.count).toBe(20)
    expect(insights[0]!.description).toContain('2 repos')
    const notedRepos = new Set(insights[0]!.evidence.map((e) => e.note!.split(' · ')[0]))
    expect([...notedRepos].sort()).toEqual(['o/a', 'o/b'])
  })

  it('points evidence at the miss turn\'s block start, not the session top', () => {
    const { db, ctx } = setup()
    // coldSession's miss is usage idx 1; its block opens at user-turn seq 4.
    for (let i = 0; i < 10; i++) {
      seedSession(db, `s${i}`, coldSession)
      seedBlock(db, `s${i}`, 1, 4)
    }
    const ins = (cacheMiss.run(ctx) as InsightInput[]).find((i) => i.signalKey === 'cache-misses')!
    expect(ins.evidence[0]!.turnIdx).toBe(4) // the exchange where the miss happened, not message 1
  })

  it('leaves turnIdx unset when the miss turn has no block (degrades to session-level)', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, coldSession) // no blocks seeded
    const ins = (cacheMiss.run(ctx) as InsightInput[]).find((i) => i.signalKey === 'cache-misses')!
    expect(ins.evidence[0]!.turnIdx).toBeUndefined()
  })

  it('ranks evidence by wasted dollars', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 9; i++) seedSession(db, `s${i}`, coldSession)
    seedSession(db, 'whale', [
      { atMs: 0, creates: 800_000 },
      { atMs: 10 * MIN, creates: 850_000 }, // 4× the usual re-buy
      { atMs: 11 * MIN, reads: 850_000, creates: 5_000 },
    ])
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights[0]!.evidence[0]!.sessionId).toBe('whale')
  })

  it('windows by the turn\'s own timestamp, so a session that began long ago but is active now still counts (decision 7)', () => {
    const { db, ctx } = setup()
    const beganOutsideWindow = new Date(Date.now() - 40 * DAY_MS).toISOString()
    const missedYesterday = Date.now() - DAY_MS
    // The old started_at scan dropped every one of these sessions; the event-ts
    // window keeps them because the misses themselves are recent.
    for (let i = 0; i < 10; i++) seedDecoupled(db, `s${i}`, coldSession, beganOutsideWindow, missedYesterday)
    const insights = cacheMiss.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10)
  })

  it('excludes turns older than the window even when the session started recently (decision 7)', () => {
    const { db, ctx } = setup()
    const startedYesterday = new Date(Date.now() - DAY_MS).toISOString()
    const missedLongAgo = Date.now() - 40 * DAY_MS
    // The old started_at scan would have counted these (recent session start); the
    // event-ts window drops them because the misses are ancient.
    for (let i = 0; i < 10; i++) seedDecoupled(db, `s${i}`, coldSession, startedYesterday, missedLongAgo)
    expect(cacheMiss.run(ctx)).toEqual([])
  })
})
