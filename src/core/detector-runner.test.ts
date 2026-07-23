import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyUsage } from './model'
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

/** A stand-in LLM client that only needs to carry a model id for cache-key checks. */
function fakeLlm(model: string) {
  return { provider: 'anthropic', model, completeStructured: async () => ({ data: {}, usage: emptyUsage() }) }
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

describe('runDetectors — delta cache invalidation', () => {
  // A detector that reports whatever delta it was handed, so the test can read
  // how many sessions the runner considered unseen on each run.
  function deltaDetector(name: string, version: number, model: string) {
    let sawUnseen = -1
    const d: Detector = {
      name, version, tier: 'X', needsLlm: true,
      run: (ctx) => {
        const unseen = ctx.unseenSessions()
        sawUnseen = unseen.length
        return { insights: [insight('a')], seen: unseen, cost: { inTokens: 1, outTokens: 1, usd: 0.01, model } }
      },
    }
    return { d, unseen: () => sawUnseen }
  }

  it('re-analyzes the full corpus when the detector version changed', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    const first = deltaDetector('versioned', 1, 'small')
    await runDetectors({ detectors: [first.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(first.unseen()).toBe(1)

    const second = deltaDetector('versioned', 2, 'small')
    await runDetectors({ detectors: [second.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(second.unseen()).toBe(1) // version bump → whole corpus unseen again
  })

  it('re-analyzes the full corpus when the LLM model changed', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    const first = deltaDetector('remodeled', 1, 'small')
    await runDetectors({ detectors: [first.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(first.unseen()).toBe(1)

    // Same version, same corpus, different model → the prior extraction is not
    // comparable, so the delta must reset (mirrors the processor cache key).
    const second = deltaDetector('remodeled', 1, 'big')
    await runDetectors({ detectors: [second.d], store, log, llmEnabled: true, llm: fakeLlm('big') })
    expect(second.unseen()).toBe(1)
  })

  it('keeps the delta cached when neither version nor model changed', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    const first = deltaDetector('stable', 1, 'small')
    await runDetectors({ detectors: [first.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(first.unseen()).toBe(1)

    const second = deltaDetector('stable', 1, 'small')
    await runDetectors({ detectors: [second.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(second.unseen()).toBe(0)
  })

  it('still resets after a model swap even when the run in between errored', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    const first = deltaDetector('resilient', 1, 'small')
    await runDetectors({ detectors: [first.d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(first.unseen()).toBe(1)

    // A run that throws records an error with no model. That must not erase the
    // model the corpus was actually extracted with — otherwise the swap below is
    // invisible and model B silently re-extracts nothing.
    const boom: Detector = {
      name: 'resilient', version: 1, tier: 'X', needsLlm: true,
      run: () => { throw new Error('transient') },
    }
    await runDetectors({ detectors: [boom], store, log, llmEnabled: true, llm: fakeLlm('small') })

    const second = deltaDetector('resilient', 1, 'big')
    await runDetectors({ detectors: [second.d], store, log, llmEnabled: true, llm: fakeLlm('big') })
    expect(second.unseen()).toBe(1)
  })

  it('leaves S-tier (model-less) detectors alone — a null stored model is not a change', async () => {
    const { db, store, log } = setup()
    seedSession(db, 's1', 'h1')
    // S-tier reports no cost, so detector_runs.model stays null; it must not be
    // read as "the model changed" on every subsequent run.
    const d: Detector = {
      name: 'sqlonly', version: 1, tier: 'S',
      run: (ctx) => ({ insights: [insight('a')], seen: ctx.unseenSessions() }),
    }
    await runDetectors({ detectors: [d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(store.detectorUnseen('sqlonly')).toHaveLength(0)
    await runDetectors({ detectors: [d], store, log, llmEnabled: true, llm: fakeLlm('small') })
    expect(store.detectorUnseen('sqlonly')).toHaveLength(0)
  })
})

describe('runDetectors — shared step-2 progress aggregator', () => {
  // A minimal Progress stand-in recording the aggregated calls.
  function fakeProgress() {
    const calls: string[] = []
    let units = 0
    let cost = 0
    const progress = {
      addUnits(n: number) { units += n; calls.push(`addUnits:${n}`) },
      unitDone(_elapsedMs: number, c: number) { cost += c; calls.push(`unitDone:${c}`) },
      addCost(c: number) { cost += c; calls.push(`addCost:${c}`) },
    } as unknown as import('../util/progress').Progress
    return { progress, calls, units: () => units, cost: () => cost }
  }

  it('aggregates addUnits/unitDone/addCost across multiple detectors into one bar', async () => {
    const { store, log } = setup()
    const a: Detector = {
      name: 'da', version: 1, tier: 'X',
      run: (ctx) => { ctx.progress?.addUnits(2); ctx.progress?.unitDone(0.10); ctx.progress?.unitDone(0.20); ctx.progress?.addCost(0.05); return [] },
    }
    const b: Detector = {
      name: 'db', version: 1, tier: 'P',
      run: (ctx) => { ctx.progress?.addUnits(1); ctx.progress?.unitDone(0.30); return [] },
    }
    const fp = fakeProgress()
    await runDetectors({ detectors: [a, b], store, log, llmEnabled: true, llm: null, progress: fp.progress })
    expect(fp.units()).toBe(3) // 2 + 1
    expect(fp.cost()).toBeCloseTo(0.65, 5) // 0.10 + 0.20 + 0.05 + 0.30
  })

  it('stamps elapsed time on the bar (detector reports cost only)', async () => {
    const { store, log } = setup()
    let observedArgc = -1
    const stamping = {
      addUnits() {},
      unitDone(...args: unknown[]) { observedArgc = args.length },
      addCost() {},
    } as unknown as import('../util/progress').Progress
    const d: Detector = {
      name: 'stamp', version: 1, tier: 'X',
      // Detector calls unitDone with ONE arg (cost); runner must forward TWO (elapsed, cost).
      run: (ctx) => { ctx.progress?.unitDone(0.5); return [] },
    }
    await runDetectors({ detectors: [d], store, log, llmEnabled: true, llm: null, progress: stamping })
    expect(observedArgc).toBe(2)
  })

  it('runs fine with no progress bar (S-tier / no CLI attached)', async () => {
    const { store, log } = setup()
    let sawProgress: unknown = 'unset'
    const d: Detector = {
      name: 'noprog', version: 1, tier: 'S',
      run: (ctx) => { sawProgress = ctx.progress; return [insight('a')] },
    }
    await runDetectors({ detectors: [d], store, log, llmEnabled: true, llm: null })
    expect(sawProgress).toBeUndefined()
    expect(store.insights({ detector: 'noprog' })).toHaveLength(1)
  })
})
