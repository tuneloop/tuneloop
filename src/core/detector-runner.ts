import { normalizeDetectorResult } from './detector'
import type { Detector, DetectorContext, DetectorResult } from './detector'
import type { LlmClient } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'

export interface DetectorRunOptions {
  detectors: Detector[]
  store: Store
  log: Logger
  llmEnabled: boolean
  llm: LlmClient | null
}

export async function runDetectors(opts: DetectorRunOptions): Promise<void> {
  const { detectors, store, log, llmEnabled, llm } = opts

  // Per-detector context: unseenSessions/loadSession close over the detector name
  // (each detector's delta is tracked independently in detector_session_runs).
  const contextFor = (d: Detector): DetectorContext => ({
    store,
    log,
    llmEnabled,
    llm,
    unseenSessions: () => store.detectorUnseen(d.name),
    loadSession: (id) => store.hydrateSession(id),
  })

  const applicable = detectors.filter((d) => {
    if (d.needsLlm && !llmEnabled) return false
    if (d.applicable && !d.applicable(contextFor(d))) {
      log.debug(`detector ${d.name} not applicable, skipping`)
      return false
    }
    return true
  })

  // A version bump means a new prompt/schema — the whole corpus must be re-analyzed,
  // not just the content-hash delta. Forget prior per-session tracking so
  // unseenSessions() returns everything. (S-tier ignores this — it has no tracking.)
  for (const d of applicable) {
    const prior = store.detectorRun(d.name)
    if (prior && prior.version !== d.version) {
      store.resetDetectorSessionRuns(d.name)
      log.debug(`detector ${d.name} version ${prior.version}→${d.version}: re-analyzing full corpus`)
    }
  }

  // Run all applicable detectors in parallel — S-tier is instant, P/X-tier benefits
  // from not waiting for each other's LLM calls.
  const results = await Promise.allSettled(applicable.map(async (d) => {
    const result = normalizeDetectorResult(await d.run(contextFor(d)))
    return { detector: d, result }
  }))

  // Persist results sequentially (SQLite writes are single-threaded anyway).
  for (const [i, settled] of results.entries()) {
    const d = applicable[i]!
    if (settled.status === 'fulfilled') {
      const { result } = settled.value
      try {
        store.persistInsights(d.name, d.version, result.insights, result.cost)
        // Mark the delta seen ONLY after a successful persist, so a failed run
        // re-processes the same sessions next analyze rather than skipping them.
        if (result.seen?.length) store.markDetectorSessionSeen(d.name, result.seen)
        const spend = result.cost ? ` ($${result.cost.usd.toFixed(2)})` : ''
        log.debug(`detector ${d.name}: ${result.insights.length} insight(s)${spend}`)
      } catch (err) {
        store.persistDetectorError(d.name, d.version)
        log.warn(`detector ${d.name} persist failed: ${(err as Error).message}`)
      }
    } else {
      store.persistDetectorError(d.name, d.version)
      log.warn(`detector ${d.name} failed: ${settled.reason?.message ?? settled.reason}`)
    }
  }
}

export type { DetectorResult }
