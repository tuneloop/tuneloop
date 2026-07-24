import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { contextExhaustion } from './context-exhaustion'
import type { DetectorContext, InsightInput } from '../core/detector'

const DAY_MS = 86_400_000
const MODEL = 'claude-opus-4-6' // 200K window (the DEFAULT_WINDOW)

// queryAll() reopens the db file read-only, so tests need a real file, not :memory:.
let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-exhaustion-'))
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

// One usage_facts row. Occupancy = input + reads + creates (output excluded).
interface UsageSpec {
  input?: number
  output?: number
  creates?: number
  reads?: number
  sidechain?: boolean
  ts?: string // per-row timestamp override (defaults to the session start)
}

function seedSession(
  db: ReturnType<typeof openDb>,
  id: string,
  usage: UsageSpec[],
  over: { repo?: string; model?: string; success?: string } = {},
) {
  const startMs = Date.now() - DAY_MS // comfortably inside the 30-day window
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)').run(
    id, id, 'claude-code', 'anthropic', over.repo ?? 'o/r', '/repo', new Date(startMs).toISOString(),
  )
  // creates → the 5m bucket (1h left 0); the detector sums both, so the total is what matters.
  const ins = db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,0,?,0)',
  )
  usage.forEach((u, idx) => {
    ins.run(id, idx, over.model ?? MODEL, u.sidechain ? 1 : 0, u.ts ?? new Date(startMs).toISOString(), u.input ?? 0, u.output ?? 0, u.creates ?? 0, u.reads ?? 0)
  })
  if (over.success) {
    db.prepare("INSERT INTO annotations (session_id, processor, key, value) VALUES (?, 'enrich-session', 'success', ?)").run(id, over.success)
  }
}

// Like seedSession, but decouples the session's started_at from its turn
// timestamps — to exercise the event-ts window (decision 7), where a card is
// dated by when a compaction happened, not by when its session began. Turns are
// stamped a minute apart from tsBaseMs, in idx order.
function seedDecoupled(
  db: ReturnType<typeof openDb>,
  id: string,
  usage: UsageSpec[],
  startedAtIso: string,
  tsBaseMs: number,
  over: { repo?: string; model?: string } = {},
) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)').run(
    id, id, 'claude-code', 'anthropic', over.repo ?? 'o/r', '/repo', startedAtIso,
  )
  const ins = db.prepare(
    'INSERT INTO usage_facts (session_id, idx, model, is_sidechain, ts, tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd) VALUES (?,?,?,?,?,?,?,?,0,?,0)',
  )
  usage.forEach((u, idx) => {
    ins.run(id, idx, over.model ?? MODEL, u.sidechain ? 1 : 0, new Date(tsBaseMs + idx * 60_000).toISOString(), u.input ?? 0, u.output ?? 0, u.creates ?? 0, u.reads ?? 0)
  })
}

// A session that climbs to the limit and compacts once: occupancy ~166K, then
// collapses to ~40K (a >40K drop from >100K), then climbs again. One compaction.
const compactedOnce: UsageSpec[] = [
  { reads: 20_000, creates: 20_000 }, // 40K
  { reads: 100_000, creates: 5_000 }, // 105K
  { reads: 160_000, creates: 6_000 }, // 166K — peak
  { reads: 0, creates: 40_000 }, // 40K — COMPACTION (drop 126K from 166K)
  { reads: 60_000, creates: 3_000 }, // 63K, climbing again
]

// Never approaches the limit — steady small session, no drop.
const smallSession: UsageSpec[] = [
  { reads: 5_000, creates: 5_000 },
  { reads: 12_000, creates: 3_000 },
  { reads: 18_000, creates: 2_000 },
]

describe('context-exhaustion detector', () => {
  it('fires on a repo with observed compactions, with factual copy', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, compactedOnce)
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    const ins = insights[0]!
    expect(ins).toMatchObject({
      signalKey: 'context-exhaustion',
      repo: '*', // one cross-repo aggregate insight
      severity: 'high', // 10/10 sessions compacted → share 1.0 ≥ 0.3
      count: 10,
      fix: { type: 'behavioral-nudge' },
    })
    expect(ins.evidence).toHaveLength(10)
    // Single qualifying repo → named directly; each evidence row notes its repo + compactions.
    expect(ins.evidence[0]!.note).toContain('o/r · ')
    expect(ins.description).toContain('10 of 10 sessions in o/r')
    expect(ins.description).toContain('166K') // worst-session peak
  })

  it('sources first/last-seen from the compaction turns, not the analyze run', () => {
    const { db, ctx } = setup()
    // Stamp the compaction turn (idx 3) at a fixed past time; earlier/later turns
    // carry other times so we prove first/last-seen tracks the compaction, not the
    // higher-occupancy peak turn (idx 2) or the later climbing turn (idx 4). All
    // timestamps are relative to now and inside the 30-day event-ts window.
    const compactionTs = new Date(Date.now() - 5 * DAY_MS).toISOString()
    const stamped: UsageSpec[] = [
      { reads: 20_000, creates: 20_000, ts: new Date(Date.now() - 6 * DAY_MS).toISOString() },
      { reads: 100_000, creates: 5_000, ts: new Date(Date.now() - 6 * DAY_MS + 3_600_000).toISOString() },
      { reads: 160_000, creates: 6_000, ts: new Date(Date.now() - 6 * DAY_MS + 7_200_000).toISOString() },
      { reads: 0, creates: 40_000, ts: compactionTs }, // the compaction
      { reads: 60_000, creates: 3_000, ts: new Date(Date.now() - 4 * DAY_MS).toISOString() }, // later, but not a compaction
    ]
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, stamped)
    const ins = (contextExhaustion.run(ctx) as InsightInput[])[0]!
    expect(ins.firstSeenAt).toBe(compactionTs)
    expect(ins.lastSeenAt).toBe(compactionTs)
  })

  it('counts multiple compactions within one session', () => {
    const { db, ctx } = setup()
    const sawtooth: UsageSpec[] = [
      { reads: 160_000, creates: 6_000 }, // 166K peak
      { reads: 0, creates: 40_000 }, // compaction 1
      { reads: 155_000, creates: 5_000 }, // 160K
      { reads: 0, creates: 45_000 }, // compaction 2
      { reads: 150_000, creates: 5_000 }, // 155K
      { reads: 0, creates: 42_000 }, // compaction 3
    ]
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, sawtooth)
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    // 3 compactions × 10 sessions = 30 total; copy reflects the total and the worst session.
    expect(insights[0]!.description).toContain('30 events total')
    expect(insights[0]!.description).toContain('3 times')
  })

  it('stays silent below the minimum session count', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 9; i++) seedSession(db, `s${i}`, compactedOnce)
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('stays silent when no session approaches the limit', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, smallSession)
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('does not flag a big drop from below the peak floor (small session)', () => {
    const { db, ctx } = setup()
    // Occupancy drops >60% (70K → 20K) but from 70K, below the 100K floor. A small
    // session's swings aren't compaction — the floor gates them out.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { reads: 30_000, creates: 5_000 }, // 35K
        { reads: 65_000, creates: 5_000 }, // 70K — under the 100K floor
        { reads: 15_000, creates: 5_000 }, // 20K — >60% drop, but from 70K < floor
        { reads: 40_000, creates: 5_000 }, // 45K
      ])
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('does not flag a shallow drop from a high peak (dropped <60%)', () => {
    const { db, ctx } = setup()
    // From 166K down to 120K: above the floor, but only a 28% drop — a real compaction
    // sheds far more (occupancy is append-only, so a modest fall isn't a removal event).
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { reads: 160_000, creates: 6_000 }, // 166K
        { reads: 118_000, creates: 2_000 }, // 120K — 120K > 166K×0.4 (66K), so not a compaction
        { reads: 150_000, creates: 5_000 }, // 155K
      ])
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('all-zero rows do not fake a compaction', () => {
    const { db, ctx } = setup()
    // A zero row between real turns would read as occupancy 0 and fake a huge drop
    // if not skipped; a genuine session that never compacts must stay silent.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { reads: 160_000, creates: 6_000 }, // 166K
        {}, // all-zero row — must be skipped, not treated as a drop to 0
        { reads: 166_000, creates: 3_000 }, // 169K, still climbing
      ])
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('ignores sidechain rows: a subagent has its own context window', () => {
    const { db, ctx } = setup()
    // Main thread stays small; only sidechain rows show the sawtooth. No main-thread compaction.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        ...smallSession,
        { reads: 160_000, creates: 6_000, sidechain: true },
        { reads: 0, creates: 40_000, sidechain: true },
      ])
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('detection is model-independent: a compaction fires regardless of the model string', () => {
    const { db, ctx } = setup()
    // 166K → 40K is a >60%-from->=100K removal event on ANY window; the model name
    // (incl. a [1m] variant) does not change detection — no per-model window scaling.
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, compactedOnce, { model: 'claude-fable-5[1m]' })
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10)
  })

  it('detects a large-scale compaction (1M-window magnitudes)', () => {
    const { db, ctx } = setup()
    // Occupancy is append-only, so a ~78% fall from 920K is a removal event just like
    // a 166K→40K one — the flat floor and relative drop catch it without window logic.
    for (let i = 0; i < 10; i++)
      seedSession(db, `s${i}`, [
        { reads: 500_000, creates: 20_000 }, // 520K
        { reads: 900_000, creates: 20_000 }, // 920K — peak
        { reads: 0, creates: 200_000 }, // 200K — >60% drop from 920K → compaction
        { reads: 300_000, creates: 10_000 }, // 310K, climbing again
      ])
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10)
  })

  it('aggregates qualifying repos into one insight, excluding a calm repo', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 10; i++) seedSession(db, `a${i}`, compactedOnce, { repo: 'o/a' })
    for (let i = 0; i < 10; i++) seedSession(db, `b${i}`, compactedOnce, { repo: 'o/b' })
    for (let i = 0; i < 10; i++) seedSession(db, `c${i}`, smallSession, { repo: 'o/calm' })
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.repo).toBe('*')
    expect(insights[0]!.count).toBe(20) // both exhausted repos fold in; the calm one does not
    expect(insights[0]!.description).toContain('2 repos')
    const notedRepos = new Set(insights[0]!.evidence.map((e) => e.note!.split(' · ')[0]))
    expect([...notedRepos].sort()).toEqual(['o/a', 'o/b'])
  })

  it('ranks evidence by compaction count then peak', () => {
    const { db, ctx } = setup()
    for (let i = 0; i < 9; i++) seedSession(db, `s${i}`, compactedOnce)
    seedSession(db, 'worst', [
      { reads: 160_000, creates: 6_000 },
      { reads: 0, creates: 40_000 }, // compaction 1
      { reads: 155_000, creates: 5_000 },
      { reads: 0, creates: 45_000 }, // compaction 2 — more than the others' single compaction
      { reads: 150_000, creates: 5_000 },
    ])
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights[0]!.evidence[0]!.sessionId).toBe('worst')
  })

  it('severity steps down with a smaller share of compacted sessions', () => {
    const { db, ctx } = setup()
    // 20 sessions, only 2 compact → share 0.1 → medium (≥0.1, <0.3).
    for (let i = 0; i < 2; i++) seedSession(db, `hit${i}`, compactedOnce)
    for (let i = 0; i < 18; i++) seedSession(db, `ok${i}`, smallSession)
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!).toMatchObject({ severity: 'medium', count: 2 })
  })

  it('windows by the compaction turn\'s own timestamp, so a session begun long ago but active now still counts (decision 7)', () => {
    const { db, ctx } = setup()
    const beganOutsideWindow = new Date(Date.now() - 40 * DAY_MS).toISOString()
    const compactedYesterday = Date.now() - DAY_MS
    // The old started_at scan dropped every one of these sessions; the event-ts
    // window keeps them because the compactions themselves are recent.
    for (let i = 0; i < 10; i++) seedDecoupled(db, `s${i}`, compactedOnce, beganOutsideWindow, compactedYesterday)
    const insights = contextExhaustion.run(ctx) as InsightInput[]
    expect(insights).toHaveLength(1)
    expect(insights[0]!.count).toBe(10)
  })

  it('excludes compactions older than the window even when the session started recently (decision 7)', () => {
    const { db, ctx } = setup()
    const startedYesterday = new Date(Date.now() - DAY_MS).toISOString()
    const compactedLongAgo = Date.now() - 40 * DAY_MS
    // The old started_at scan would have counted these (recent session start); the
    // event-ts window drops them because the compactions are ancient.
    for (let i = 0; i < 10; i++) seedDecoupled(db, `s${i}`, compactedOnce, startedYesterday, compactedLongAgo)
    expect(contextExhaustion.run(ctx)).toEqual([])
  })

  it('resolves a prior card when no repo qualifies this window (N4)', () => {
    const { db, store, ctx } = setup()
    // A previously surfaced card is on the dashboard.
    store.persistInsights('context-exhaustion', 1, [{
      signalKey: 'context-exhaustion',
      repo: '*',
      severity: 'high',
      title: 'stale',
      description: 'stale',
      evidence: [],
      count: 5,
      fix: { type: 'behavioral-nudge', label: 'x', content: 'y' },
    }])
    expect(store.insightStatus('context-exhaustion', '*', 'context-exhaustion')!.state).toBe('surfaced')
    // This window has activity but no compactions → nothing qualifies → the empty path
    // must resolve the stale card instead of leaving it frozen.
    for (let i = 0; i < 10; i++) seedSession(db, `s${i}`, smallSession)
    expect(contextExhaustion.run(ctx)).toEqual([])
    expect(store.insightStatus('context-exhaustion', '*', 'context-exhaustion')!.state).toBe('resolved')
  })
})
