import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { toolErrorSamples } from '../server/tool-health'
import { collectErrorTexts, draftToolFix, evidenceHash, toolErrorAdvice } from './tool-error-advice'
import type { LlmClient } from '../llm/types'
import type { ToolErrorSample } from '../server/tool-health'
import { emptyUsage } from '../core/model'

const NOW = Date.parse('2026-08-01T00:00:00.000Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()

let db: ReturnType<typeof openDb>
let store: Store
let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tool-advice-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  db = openDb(join(dir, `t${n++}.db`))
  store = new Store(db)
})
afterEach(() => store.close())

const sample = (o: Partial<ToolErrorSample> = {}): ToolErrorSample =>
  ({ sessionId: 's1', idx: 0, name: 'Bash', command: 'gh pr create', category: 'auth', message: 'boom', ts: iso(1), ...o })

/** A sample plus the full text the pass would have read from the blob. */
const withText = (text: string, o: Partial<ToolErrorSample> = {}) => ({ ...sample(o), text })

describe('evidenceHash', () => {
  it('is stable regardless of the order the failures come back in', () => {
    const a = [sample({ idx: 0 }), sample({ idx: 1 })]
    expect(evidenceHash(a)).toBe(evidenceHash([...a].reverse()))
  })

  it('changes when a new failure appears — the gate that forces a redraft', () => {
    const before = [sample({ idx: 0 })]
    expect(evidenceHash([...before, sample({ idx: 1 })])).not.toBe(evidenceHash(before))
  })

  it('changes when the same call fails differently', () => {
    expect(evidenceHash([sample({ message: 'permission denied' })])).not.toBe(evidenceHash([sample({ message: 'not found' })]))
  })
})

describe('collectErrorTexts', () => {
  it('reads the FULL error out of the session blob, not the clipped stored message', () => {
    // The whole point of the pass: `error_message` is truncated at 200 chars, so a
    // stack trace or usage dump is unreadable without going back to the blob.
    const long = 'E'.repeat(900)
    const texts = collectErrorTexts([sample({ message: long.slice(0, 200) })], () => ({
      toolCalls: [{ result: { raw: long } }],
    }))
    expect(texts[0]!.text).toHaveLength(900)
  })

  it('falls back to the clipped message when the blob is gone', () => {
    const texts = collectErrorTexts([sample({ message: 'the short one' })], () => null)
    expect(texts[0]!.text).toBe('the short one')
  })

  it('loads each session once however many of its calls failed', () => {
    let loads = 0
    collectErrorTexts([sample({ idx: 0 }), sample({ idx: 1 }), sample({ sessionId: 's2', idx: 0 })], (id) => {
      loads++
      return { toolCalls: [{ result: { raw: 'e:' + id } }, { result: { raw: 'e2' } }] }
    })
    expect(loads).toBe(2)
  })
})

describe('draftToolFix', () => {
  const llmStub = (data: Record<string, unknown>, captured?: { system?: string; user?: string }): LlmClient =>
    ({
      model: 'test-model',
      provider: 'anthropic',
      completeStructured: async (req: { system: string; user: string }) => {
        if (captured) { captured.system = req.system; captured.user = req.user }
        return { data, usage: emptyUsage() }
      },
    }) as unknown as LlmClient

  it('returns the diagnosis and snippet', async () => {
    const { draft } = await draftToolFix(
      llmStub({ diagnosis: 'gh is called before auth', snippet: '## gh\nRun `gh auth status` first.' }),
      { kind: 'builtin', name: 'gh', calls: 20, errorCalls: 8 },
      [withText('gh: not authenticated')],
    )
    expect(draft.diagnosis).toBe('gh is called before auth')
    expect(draft.snippet).toContain('gh auth status')
  })

  it('accepts a diagnosis with no snippet — some failures no instruction can fix', async () => {
    const { draft } = await draftToolFix(
      llmStub({ diagnosis: 'The API was returning 503 all afternoon.' }),
      { kind: 'mcp', name: 'sentry', calls: 30, errorCalls: 12 },
      [withText('503 Service Unavailable')],
    )
    expect(draft.snippet).toBe('')
  })

  it('puts the real error text in front of the model', async () => {
    const captured: { user?: string } = {}
    await draftToolFix(llmStub({ diagnosis: 'x' }, captured), { kind: 'builtin', name: 'gh', calls: 20, errorCalls: 8 }, [
      withText('HTTP 401: Bad credentials'),
    ])
    expect(captured.user).toContain('HTTP 401: Bad credentials')
    expect(captured.user).toContain('gh pr create')
  })
})

describe('advice storage', () => {
  it('round-trips a card and overwrites it on redraft', () => {
    store.setToolErrorAdvice('claude-code', 'builtin', 'gh', { diagnosis: 'v1', snippet: 's1', evidenceHash: 'h1', model: 'm' })
    expect(store.toolErrorAdvice('claude-code', 'builtin', 'gh')).toMatchObject({ diagnosis: 'v1', evidenceHash: 'h1' })
    store.setToolErrorAdvice('claude-code', 'builtin', 'gh', { diagnosis: 'v2', snippet: 's2', evidenceHash: 'h2', model: 'm' })
    expect(store.toolErrorAdvice('claude-code', 'builtin', 'gh')).toMatchObject({ diagnosis: 'v2', evidenceHash: 'h2' })
  })

  it('keeps each harness\'s card separate', () => {
    store.setToolErrorAdvice('claude-code', 'builtin', 'gh', { diagnosis: 'cc', snippet: '', evidenceHash: 'h' })
    store.setToolErrorAdvice('codex', 'builtin', 'gh', { diagnosis: 'cx', snippet: '', evidenceHash: 'h' })
    expect(store.toolErrorAdvice('codex', 'builtin', 'gh')?.diagnosis).toBe('cx')
  })

  it('has no card for an entity that was never drafted', () => {
    expect(store.toolErrorAdvice('claude-code', 'mcp', 'nothing')).toBeNull()
  })
})

describe('toolErrorSamples', () => {
  it('returns the failed calls of one entity, with the coordinates to reach the blob', () => {
    db.prepare(`INSERT INTO sessions (id, session_id, source, repo, started_at) VALUES ('s1','s1','claude-code','o/r',?)`).run(iso(2))
    const calls: Array<[number, string, string, number, string | null, string | null]> = [
      [0, 'Bash', 'shell', 1, 'auth', 'gh auth failed'],
      [1, 'Bash', 'shell', 0, null, null],
      [2, 'Read', 'file_read', 1, 'not_found', 'nope'],
    ]
    for (const [idx, name, action, isErr, cat, msg] of calls) {
      db.prepare(
        `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, error_category, error_message, command, is_sidechain, ts)
         VALUES ('s1',?,?,?,?,?,?,?,?,0,?)`,
      ).run(idx, name, action, isErr ? 0 : 1, isErr, cat, msg, action === 'shell' ? 'gh pr create' : null, iso(2))
      if (action === 'shell') db.prepare('INSERT INTO tool_call_commands VALUES (?,?,0,?)').run('s1', idx, 'gh')
    }
    const got = toolErrorSamples(store, 'builtin', 'gh', { nowMs: NOW })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ sessionId: 's1', idx: 0, category: 'auth', command: 'gh pr create' })
  })
})

describe('detector registration', () => {
  it('is an LLM-gated cross-session pass that emits no insights', () => {
    // The deliverable is the card on the entity's page. A per-tool row in the
    // Recommendations ledger would drown the signals that need a decision.
    expect(toolErrorAdvice).toMatchObject({ name: 'tool-error-advice', tier: 'X', needsLlm: true, model: 'heavy' })
  })
})
