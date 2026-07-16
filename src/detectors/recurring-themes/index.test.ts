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
function stubLlm(byLabelOrder: Canned[], fix?: { fix_type: string; content: string }): { llm: LlmClient; calls: string[] } {
  const queue = [...byLabelOrder]
  const calls: string[] = []
  const llm: LlmClient = {
    provider: 'anthropic',
    model: 'claude-fable-5',
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      calls.push(req.toolName)
      if (req.toolName === 'propose_theme_merges') return { data: { merges: [] }, usage: emptyUsage() }
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

  it('rejects a junk (run-on) label: theme dropped, event survives', async () => {
    const { db, store } = setup()
    seedSession(db, store, 'j1')
    const { llm } = stubLlm([
      { events: [{ turn: 1, type: 'other', description: 'friction', new_theme_label: 'this label is a whole run-on sentence, with commas, far too long to be a name' }] },
    ])
    await recurringThemes.run(ctx(store, llm))
    expect(store.allThemes()).toHaveLength(0)
    expect(store.queryAll('SELECT 1 FROM theme_events')).toHaveLength(1)
  })

  it('reopens a resolved theme when it recurs (theme stayed in the extraction feed)', async () => {
    const { db, store } = setup()
    for (const id of ['r1', 'r2', 'r3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'preference', description: 'user restated the changelog format', new_theme_label: 'Changelog Format Convention' }] }
    const { llm } = stubLlm([one, one, one])
    const res = await recurringThemes.run(ctx(store, llm))
    const insights = (Array.isArray(res) ? res : res.insights) as InsightInput[]
    expect(insights).toHaveLength(1)
    // Persist it, mark resolved (simulating the loop-closure engine), and confirm it stays listable.
    store.persistInsights('recurring-themes', 1, insights)
    const id = insightId('recurring-themes', insights[0]!.repo, insights[0]!.signalKey)
    store.transitionInsight(id, 'resolved')
    store.setThemeResolved(insights[0]!.signalKey, true)
    // A resolved theme is still visible to extraction (global preference theme).
    expect(store.listThemes(null).some((t) => t.id === insights[0]!.signalKey)).toBe(true)
    // Re-detecting it re-surfaces the insight and persistInsights reopens it.
    const res2 = await recurringThemes.run(ctx(store, stubLlm([one, one, one]).llm))
    const again = (Array.isArray(res2) ? res2 : res2.insights) as InsightInput[]
    store.persistInsights('recurring-themes', 1, again)
    expect(store.insights({ detector: 'recurring-themes' }).find((i) => i.id === id)?.state).toBe('surfaced')
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

  it('reuses the cached fix when occurrences are unchanged (hash-gated, no draft_fix call)', async () => {
    const { db, store } = setup()
    for (const id of ['g1', 'g2', 'g3']) seedSession(db, store, id)
    const one: Canned = { events: [{ turn: 1, type: 'context-supply', description: 'user had to supply the db path', new_theme_label: 'Db Path Not Found' }] }
    await recurringThemes.run(ctx(store, stubLlm([one, one, one]).llm))
    // Second run: same corpus, delta empty → extraction skipped, occurrence set
    // unchanged → the fix is reused from the theme cache, no draft_fix call.
    const second = stubLlm([], undefined)
    await recurringThemes.run(ctx(store, second.llm))
    expect(second.calls).not.toContain('draft_fix')
  })
})
