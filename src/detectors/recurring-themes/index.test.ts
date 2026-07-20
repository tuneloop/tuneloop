import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../../store/db'
import { Store } from '../../store/store'
import { emptyUsage } from '../../core/model'
import { insightId } from '../../core/detector'
import { recurringThemes } from './index'
import type { Event, Session } from '../../core/model'
import type { DetectorContext, InsightInput } from '../../core/detector'
import type { LlmClient, LlmResult, StructuredRequest } from '../../llm/types'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recurring-themes-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A canned extraction: one friction event minting/matching a theme by label.
interface Canned {
  events: Array<{ turn: number; type: string; description: string; new_theme_label?: string; matched_theme_id?: string }>
}

/**
 * Stub LLM: extraction returns the queued canned response per session; merge
 * returns no merges; the fix pass (draft_fix) returns a canned fix-prompt. Each
 * tool call is recorded so tests can assert which passes ran.
 */
function stubLlm(byLabelOrder: Canned[], fix?: { fix_type?: string; content?: string; worth_surfacing?: boolean; reason?: string }): { llm: LlmClient; calls: string[] } {
  const queue = [...byLabelOrder]
  const calls: string[] = []
  const llm: LlmClient = {
    provider: 'anthropic',
    model: 'claude-fable-5',
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      calls.push(req.toolName)
      if (req.toolName === 'reconcile_taxonomy') return { data: { themes: [] }, usage: emptyUsage() }
      if (req.toolName === 'draft_fix') {
        return { data: (fix ?? { fix_type: 'fix-prompt', content: 'Add a CLAUDE.md section documenting the db config path.' }) as unknown as Record<string, unknown>, usage: emptyUsage() }
      }
      const data = queue.shift() ?? { events: [] }
      return { data: data as unknown as Record<string, unknown>, usage: emptyUsage() }
    },
  }
  return { llm, calls }
}

function setup() {
  const db = openDb(join(dir, `t${n++}.db`))
  const store = new Store(db)
  return { db, store }
}

/** Ingest a session (with blob) that has an opener + a follow-up, and a followup_count annotation. */
function seedSession(
  db: ReturnType<typeof openDb>,
  store: Store,
  id: string,
  opts: { repo?: string; followups?: number; opener?: string; followupText?: string } = {},
) {
  const events: Event[] = [
    { kind: 'user', text: opts.opener ?? 'do the thing', blocks: [], isSidechain: false, seq: 0 },
    { kind: 'user', text: opts.followupText ?? 'no, you need to read config.yml for the db path', blocks: [], isSidechain: false, seq: 1 },
  ]
  const session: Session = {
    id, sessionId: id, source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo: opts.repo ?? 'o/r' },
    startedAt: new Date().toISOString(),
    models: ['claude-fable-5'], tokens: emptyUsage(), events, toolCalls: [],
    raw: { path: `/x/${id}`, contentHash: `h-${id}` },
  }
  store.ingestSession(session, 0, [], '2026-07-14.1', 5000)
  const count = opts.followups ?? 1
  db.prepare('INSERT OR REPLACE INTO annotations (session_id, processor, key, value) VALUES (?,?,?,?)')
    .run(id, 'steering', 'followup_count', JSON.stringify(count))
}

/** Ingest a session with many follow-up user turns, to exercise windowed extraction. */
function seedManyFollowups(db: ReturnType<typeof openDb>, store: Store, id: string, followups: number) {
  const events: Event[] = [{ kind: 'user', text: 'opener', blocks: [], isSidechain: false, seq: 0 }]
  for (let i = 1; i <= followups; i++) events.push({ kind: 'user', text: `follow-up ${i}, please fix it`, blocks: [], isSidechain: false, seq: i })
  const session: Session = {
    id, sessionId: id, source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' }, startedAt: new Date().toISOString(),
    models: ['claude-fable-5'], tokens: emptyUsage(), events, toolCalls: [],
    raw: { path: `/x/${id}`, contentHash: `h-${id}` },
  }
  store.ingestSession(session, 0, [], '2026-07-14.1', 5000)
  db.prepare('INSERT OR REPLACE INTO annotations (session_id, processor, key, value) VALUES (?,?,?,?)')
    .run(id, 'steering', 'followup_count', JSON.stringify(followups))
}

function ctx(store: Store, llm: LlmClient): DetectorContext {
  return {
    store,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    llmEnabled: true,
    llm,
    unseenSessions: () => store.detectorUnseen('recurring-themes'),
    loadSession: (id) => store.hydrateSession(id),
  }
}

/**
 * Run the detector AND mark its processed sessions seen — what the real runner
 * (detector-runner.ts) does after a successful persist. Tests that re-run across
 * an unchanged delta need this, else every session looks unseen and re-extracts.
 */
async function runAndMark(c: DetectorContext): Promise<InsightInput[]> {
  const res = await recurringThemes.run(c)
  const norm = Array.isArray(res) ? { insights: res, seen: [] as Array<{ sessionId: string; contentHash: string }> } : res
  if (norm.seen?.length) c.store.markDetectorSessionSeen('recurring-themes', norm.seen)
  return norm.insights
}

describe('recurring-themes detector', () => {
  it('surfaces a theme only once it recurs across the threshold (3 events, >=2 sessions)', async () => {
    const { db, store } = setup()
    // 2 sessions, same minted theme label → 2 events across 2 sessions: below MIN_EVENTS(3).
    for (const id of ['s1', 's2']) seedSession(db, store, id)
    const canned: Canned[] = [
      { events: [{ turn: 1, type: 'context-supply', description: 'user had to point the agent at the db config file', new_theme_label: 'Db Config Location Not Found' }] },
      { events: [{ turn: 1, type: 'context-supply', description: 'user had to point the agent at the db config file', new_theme_label: 'Db Config Location Not Found' }] },
    ]
    const { llm } = stubLlm(canned)
    const res = await recurringThemes.run(ctx(store, llm))
    const insights = Array.isArray(res) ? res : res.insights
    expect(insights).toHaveLength(0) // 2 events < 3
    // The theme + its events still persisted (accumulating silently).
    const themes = store.themesWithEvents()
    expect(themes).toHaveLength(1)
    expect(themes[0]!.eventCount).toBe(2)
    expect(themes[0]!.sessionCount).toBe(2)
  })

  it('windows a large session into multiple extraction calls and unions their events', async () => {
    const { db, store } = setup()
    seedManyFollowups(db, store, 'big', 65) // 65 follow-ups, WINDOW=30 → 3 windows (30+30+5)
    let extractCalls = 0
    const llm: LlmClient = {
      provider: 'anthropic', model: 'claude-fable-5',
      async completeStructured(req: StructuredRequest): Promise<LlmResult> {
        if (req.toolName === 'reconcile_taxonomy') return { data: { themes: [] }, usage: emptyUsage() }
        if (req.toolName === 'draft_fix') return { data: { worth_surfacing: true, fix_type: 'fix-prompt', content: 'x' }, usage: emptyUsage() }
        // Each extraction window emits one event (turn 1 is valid within every window slice).
        extractCalls++
        return { data: { events: [{ turn: 1, type: 'other', description: `friction in window ${extractCalls}`, new_theme_label: `Window Theme ${extractCalls}` }] }, usage: emptyUsage() }
      },
    }
    await recurringThemes.run(ctx(store, llm))
    expect(extractCalls).toBe(3) // 30 + 30 + 5
    // One event per window, unioned into the session with a session-wide idx sequence.
    const rows = store.queryAll('SELECT idx FROM theme_events WHERE session_id = ? ORDER BY idx', 'big') as Array<{ idx: number }>
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2])
  })

  it('does not persist a partial session when one window fails (nothing saved, session unprocessed)', async () => {
    const { db, store } = setup()
    seedManyFollowups(db, store, 'big', 65) // WINDOW=30 → 3 windows
    let n = 0
    const llm: LlmClient = {
      provider: 'anthropic', model: 'claude-fable-5',
      async completeStructured(req: StructuredRequest): Promise<LlmResult> {
        if (req.toolName !== 'record_friction') return { data: { themes: [] }, usage: emptyUsage() }
        n++
        if (n === 2) throw new Error('window 2 boom') // second window fails
        return { data: { events: [{ turn: 1, type: 'other', description: 'x', new_theme_label: 'T' }] }, usage: emptyUsage() }
      },
    }
    await recurringThemes.run(ctx(store, llm))
    // A failed window → the session is NOT persisted (no partial events) and stays
    // unprocessed so the next analyze retries it.
    expect(store.queryAll('SELECT 1 FROM theme_events WHERE session_id = ?', 'big')).toHaveLength(0)
    expect(store.detectorUnseen('recurring-themes').some((s) => s.sessionId === 'big')).toBe(true)
  })

  it('surfaces an insight with a fix-prompt embedding its own id once past threshold', async () => {
    const { db, store } = setup()
    for (const id of ['a1', 'a2', 'a3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'context-supply', description: 'user had to supply the db config path', new_theme_label: 'Db Config Location Not Found' }] }
    const { llm } = stubLlm([one, one, one])
    const res = await recurringThemes.run(ctx(store, llm))
    const insights = (Array.isArray(res) ? res : res.insights) as InsightInput[]
    expect(insights).toHaveLength(1)
    const ins = insights[0]!
    expect(ins.fix.type).toBe('fix-prompt')
    // Default scope is global (no project_specific flag), so repo = '*'.
    expect(ins.repo).toBe('*')
    // Non-nudge fixes get the tuneloop-fix marker prepended for loop closure.
    const expectedId = insightId('recurring-themes', ins.repo, ins.signalKey)
    expect(ins.fix.content).toContain(`tuneloop-fix: ${expectedId}`)
    expect(ins.count).toBe(3)
    expect(ins.severity).toBe('low') // 3 events < medium(4)
  })

  it('the fix pass can VETO a theme that crossed the threshold (worth_surfacing=false → no insight)', async () => {
    const { db, store } = setup()
    for (const id of ['v1', 'v2', 'v3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'other', description: 'a clustered one-off, not a real pattern', new_theme_label: 'Not Worth Surfacing' }] }
    const { llm } = stubLlm([one, one, one], { worth_surfacing: false, reason: 'clustered one-off' })
    const res = await recurringThemes.run(ctx(store, llm))
    const insights = (Array.isArray(res) ? res : res.insights) as InsightInput[]
    // Threshold met (3 events / 3 sessions) but the fix pass vetoed → nothing surfaces.
    expect(insights).toHaveLength(0)
    // The theme + its events still persist (a later, stronger recurrence could re-run the veto).
    expect(store.themesWithEvents()[0]!.eventCount).toBe(3)
  })

  it('caches a veto: a quiet re-analyze does not re-ask the fix pass', async () => {
    const { db, store } = setup()
    for (const id of ['w1', 'w2', 'w3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'other', description: 'clustered one-off', new_theme_label: 'Vetoed Theme' }] }
    await runAndMark(ctx(store, stubLlm([one, one, one], { worth_surfacing: false, reason: 'one-off' }).llm))
    // Second run: delta empty, occurrence set unchanged → the cached veto is reused,
    // so draft_fix is NOT called again.
    const second = stubLlm([], undefined)
    await recurringThemes.run(ctx(store, second.llm))
    expect(second.calls).not.toContain('draft_fix')
  })

  it('retires an already-surfaced insight when a later verdict flips to vetoed', async () => {
    const { db, store } = setup()
    for (const id of ['f1', 'f2', 'f3']) seedSession(db, store, id, { followupText: 'friction flip' })
    const one: Canned = { events: [{ turn: 1, type: 'preference', description: 'user restated flip', new_theme_label: 'Flip Theme' }] }
    // A stub whose draft_fix verdict we toggle between runs.
    let surfacing = true
    const llm: LlmClient = {
      provider: 'anthropic', model: 'claude-fable-5',
      async completeStructured(req: StructuredRequest): Promise<LlmResult> {
        if (req.toolName === 'reconcile_taxonomy') return { data: { themes: [] }, usage: emptyUsage() }
        if (req.toolName === 'draft_fix') {
          return surfacing
            ? { data: { worth_surfacing: true, fix_type: 'fix-prompt', content: 'do the thing' }, usage: emptyUsage() }
            : { data: { worth_surfacing: false, reason: 'now judged a one-off' }, usage: emptyUsage() }
        }
        return { data: { events: [{ turn: 1, type: 'preference', description: 'user restated flip', new_theme_label: 'Flip Theme' }] }, usage: emptyUsage() }
      },
    }
    // Run 1: surfaces and persists the insight.
    const first = await runAndMark(ctx(store, llm))
    store.persistInsights('recurring-themes', 1, first)
    const id = insightId('recurring-themes', first[0]!.repo, first[0]!.signalKey)
    expect(store.insights({ detector: 'recurring-themes' }).find((i) => i.id === id)?.state).toBe('surfaced')
    // A new occurrence (changes the hash → fix re-evaluated), and the verdict flips.
    seedSession(db, store, 'f4', { followupText: 'friction flip again' })
    surfacing = false
    const again = await runAndMark(ctx(store, llm))
    store.persistInsights('recurring-themes', 1, again)
    // The stale insight is retired (resolved), not left showing.
    expect(store.insights({ detector: 'recurring-themes' }).find((i) => i.id === id)?.state).toBe('resolved')
  })

  it('skips unsteered sessions (pre-gate) — no LLM call, no theme', async () => {
    const { db, store } = setup()
    seedSession(db, store, 'quiet', { followups: 0 }) // followup_count = 0 → not steered
    const { llm, calls } = stubLlm([{ events: [{ turn: 1, type: 're-steer', description: 'x', new_theme_label: 'Y' }] }])
    const res = await recurringThemes.run(ctx(store, llm))
    expect(Array.isArray(res) ? res : res.insights).toHaveLength(0)
    expect(calls).toEqual([]) // extraction never called
  })

  it('drops a hallucinated matched_theme_id but keeps the event topicless', async () => {
    const { db, store } = setup()
    seedSession(db, store, 'h1')
    const { llm } = stubLlm([
      { events: [{ turn: 1, type: 're-steer', description: 'user corrected the approach', matched_theme_id: 'recurring-themes:o-r:nonexistent' }] },
    ])
    await recurringThemes.run(ctx(store, llm))
    // No theme minted (only a bogus match), but the event persisted topicless.
    expect(store.allThemes()).toHaveLength(0)
    const rows = store.queryAll("SELECT theme_id FROM theme_events") as Array<{ theme_id: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.theme_id).toBeNull()
  })

  it('keeps a verbose label (clustered, trimmed to 80 chars) rather than dropping the event topicless', async () => {
    const { db, store } = setup()
    seedSession(db, store, 'j1')
    const longLabel = 'this label is a whole run-on sentence, with commas, far too long to be a clean name'
    const { llm } = stubLlm([
      { events: [{ turn: 1, type: 'other', description: 'friction', new_theme_label: longLabel }] },
    ])
    await recurringThemes.run(ctx(store, llm))
    // A verbose label is no longer rejected: minting it keeps the event clustered
    // (droppping the label would leave the event topicless and unable to recur).
    const themes = store.allThemes()
    expect(themes).toHaveLength(1)
    expect(themes[0]!.label.length).toBeLessThanOrEqual(80)
    const ev = store.queryAll('SELECT theme_id FROM theme_events') as Array<{ theme_id: string | null }>
    expect(ev).toHaveLength(1)
    expect(ev[0]!.theme_id).toBe(themes[0]!.id)
  })

  // Helper: seed 3 sessions of one theme, surface + persist the insight, resolve it.
  // Returns the theme label + insight id so tests can drive re-analyze scenarios.
  async function surfaceAndResolve(db: ReturnType<typeof openDb>, store: Store, label: string, ids: string[]) {
    for (const id of ids) seedSession(db, store, id, { followupText: `friction about ${label}` })
    const one: Canned = { events: [{ turn: 1, type: 'preference', description: `user restated ${label}`, new_theme_label: label }] }
    const insights = await runAndMark(ctx(store, stubLlm(ids.map(() => one)).llm))
    store.persistInsights('recurring-themes', 1, insights)
    const id = insightId('recurring-themes', insights[0]!.repo, insights[0]!.signalKey)
    store.transitionInsight(id, 'resolved')
    return { signalKey: insights[0]!.signalKey, id }
  }

  it('a resolved insight does NOT reopen on re-analyze when there are no new occurrences', async () => {
    const { db, store } = setup()
    const { id } = await surfaceAndResolve(db, store, 'Changelog Format Convention', ['r1', 'r2', 'r3'])
    // Re-analyze with the delta empty (nothing new): the theme still has its 3
    // historical events, but the resolved insight must stay resolved.
    const again = await runAndMark(ctx(store, stubLlm([]).llm))
    expect(again.find((i) => i.signalKey && insightId('recurring-themes', i.repo, i.signalKey) === id)).toBeUndefined()
    store.persistInsights('recurring-themes', 1, again)
    expect(store.insights({ detector: 'recurring-themes' }).find((i) => i.id === id)?.state).toBe('resolved')
  })

  it('a resolved insight reopens on a GENUINE recurrence (a new occurrence in a new session)', async () => {
    const { db, store } = setup()
    const { signalKey, id } = await surfaceAndResolve(db, store, 'Changelog Format Convention', ['r1', 'r2', 'r3'])
    // A 4th session hits the same theme (matched by id) — a real recurrence.
    seedSession(db, store, 'r4', { followupText: 'friction about changelog again' })
    const match: Canned = { events: [{ turn: 1, type: 'preference', description: 'user restated it again', matched_theme_id: signalKey }] }
    const again = await runAndMark(ctx(store, stubLlm([match]).llm))
    // Now above its prior count → re-emitted, and persist reopens the resolved insight.
    expect(again.some((i) => i.signalKey === signalKey)).toBe(true)
    store.persistInsights('recurring-themes', 1, again)
    expect(store.insights({ detector: 'recurring-themes' }).find((i) => i.id === id)?.state).toBe('surfaced')
  })

  it('a dismissed insight never re-surfaces, even with the theme still present', async () => {
    const { db, store } = setup()
    for (const id of ['d1', 'd2', 'd3']) seedSession(db, store, id, { followupText: 'friction x' })
    const one: Canned = { events: [{ turn: 1, type: 'preference', description: 'user restated x', new_theme_label: 'Dismissed Theme' }] }
    const insights = await runAndMark(ctx(store, stubLlm([one, one, one]).llm))
    store.persistInsights('recurring-themes', 1, insights)
    const id = insightId('recurring-themes', insights[0]!.repo, insights[0]!.signalKey)
    store.dismissInsight(id)
    // Re-analyze: the theme is unchanged; the dismissed insight must not come back.
    const again = await runAndMark(ctx(store, stubLlm([]).llm))
    expect(again.some((i) => i.signalKey === insights[0]!.signalKey)).toBe(false)
  })

  it('a behavioral-nudge fix carries NO tuneloop-fix marker (nothing to adopt)', async () => {
    const { db, store } = setup()
    for (const id of ['n1', 'n2', 'n3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 're-steer', description: 'user had to narrow an over-scoped change', new_theme_label: 'Agent Over-Scopes Requests' }] }
    const { llm } = stubLlm([one, one, one], { fix_type: 'behavioral-nudge', content: 'Specify the scope of the change explicitly up front.' })
    const res = await recurringThemes.run(ctx(store, llm))
    const ins = ((Array.isArray(res) ? res : res.insights) as InsightInput[])[0]!
    expect(ins.fix.type).toBe('behavioral-nudge')
    expect(ins.fix.content).not.toContain('tuneloop-fix:')
  })

  it('reuses the cached fix when occurrences are unchanged: no draft_fix call, no hydration', async () => {
    const { db, store } = setup()
    for (const id of ['g1', 'g2', 'g3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'context-supply', description: 'user had to supply the db path', new_theme_label: 'Db Path Not Found' }] }
    await runAndMark(ctx(store, stubLlm([one, one, one]).llm))
    // Second run: delta empty → extraction skipped, occurrence set unchanged → the
    // fix is reused from the theme cache with NO draft_fix call AND no blob hydration
    // (the snippet build is behind the hash gate).
    const second = stubLlm([], undefined)
    let hydrations = 0
    const c = ctx(store, second.llm)
    const base = c.loadSession
    c.loadSession = (id) => { hydrations++; return base(id) }
    await recurringThemes.run(c)
    expect(second.calls).not.toContain('draft_fix')
    expect(hydrations).toBe(0)
  })
})
