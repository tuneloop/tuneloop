import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { runDetectors } from './detector-runner'
import type { Detector, DetectorContext, InsightInput } from './detector'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'detector-runner-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const db = openDb(join(dir, `t${n++}.db`))
  const store = new Store(db)
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  return { db, store, log }
}

function seedSession(db: ReturnType<typeof openDb>, id: string, hash: string) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, started_at, content_hash) VALUES (?,?,?,?,?,?)').run(
    id, id, 'claude-code', 'anthropic', new Date().toISOString(), hash,
  )
}

const insight = (signalKey: string): InsightInput => ({
  signalKey,
  repo: 'o/r',
  severity: 'low',
  title: 't',
  description: 'd',
  evidence: [],
  count: 1,
  fix: { type: 'behavioral-nudge', label: 'l', content: 'c' },
})

function run(store: Store, log: DetectorContext['log'], d: Detector) {
  return runDetectors({ detectors: [d], store, log, llmEnabled: true, llm: null })
}

describe('runDetectors — result normalization + cost/seen threading', () => {
  it('accepts a bare InsightInput[] (S-tier shape) and persists it', async () => {
    const { db, store, log } = setup()
    const d: Detector = { name: 'bare', version: 1, tier: 'S', run: () => [insight('a')] }
    await run(store, log, d)
    expect(store.insights({ detector: 'bare' })).toHaveLength(1)
    // No cost reported → detector_runs cost + model columns stay null.
    const row = db.prepare('SELECT model, in_tokens, out_tokens, cost_usd FROM detector_runs WHERE detector = ?').get('bare') as {
      model: string | null; in_tokens: number | null; out_tokens: number | null; cost_usd: number | null
    }
    expect(row).toMatchObject({ model: null, in_tokens: null, out_tokens: null, cost_usd: null })
  })

  it('records LLM cost + model from a DetectorResult onto detector_runs', async () => {
    const { db, store, log } = setup()
    const d: Detector = {
      name: 'costly', version: 1, tier: 'X',
      run: () => ({ insights: [insight('a')], cost: { inTokens: 1000, outTokens: 200, usd: 0.42, model: 'claude-x' } }),
    }
    await run(store, log, d)
    const row = db.prepare('SELECT model, in_tokens, out_tokens, cost_usd FROM detector_runs WHERE detector = ?').get('costly') as {
      model: string | null; in_tokens: number; out_tokens: number; cost_usd: number
    }
    expect(row).toMatchObject({ model: 'claude-x', in_tokens: 1000, out_tokens: 200, cost_usd: 0.42 })
  })

  it('marks the reported sessions seen after a successful persist', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    const d: Detector = {
      name: 'seer', version: 1, tier: 'X',
      run: (ctx) => {
        // The detector reads its delta and reports it back as processed.
        const unseen = ctx.unseenSessions()
        return { insights: [insight('a')], seen: unseen }
      },
    }
    // First run: s1 is unseen → gets processed → marked seen.
    await run(store, log, d)
    expect(store.detectorUnseen('seer')).toHaveLength(0)
  })

  it('does NOT mark sessions seen when the persist fails (delta retried next run)', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    // A fix-prompt that omits its insight id makes persistInsights throw.
    const d: Detector = {
      name: 'faulty', version: 1, tier: 'X',
      run: (ctx) => ({
        insights: [{ ...insight('a'), fix: { type: 'fix-prompt', label: 'l', content: 'no id here' } }],
        seen: ctx.unseenSessions(),
      }),
    }
    await run(store, log, d)
    // Persist threw → error row recorded, and s1 stays unseen so it's retried.
    expect(db.prepare("SELECT status FROM detector_runs WHERE detector = 'faulty'").get()).toMatchObject({ status: 'error' })
    expect(store.detectorUnseen('faulty')).toHaveLength(1)
  })

  it('exposes hydrateSession via ctx.loadSession (null for an absent session)', async () => {
    const { store, log } = setup()
    let loaded: unknown = 'unset'
    const d: Detector = {
      name: 'hydrater', version: 1, tier: 'X',
      run: (ctx) => {
        loaded = ctx.loadSession('does-not-exist')
        return []
      },
    }
    await run(store, log, d)
    expect(loaded).toBeNull()
  })
})
