import type { Detector, DetectorContext } from './detector'
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
  const ctx: DetectorContext = { store, log, llmEnabled, llm }

  const applicable = detectors.filter((d) => {
    if (d.needsLlm && !llmEnabled) return false
    if (d.applicable && !d.applicable(ctx)) {
      log.debug(`detector ${d.name} not applicable, skipping`)
      return false
    }
    return true
  })

  // Run all applicable detectors in parallel — S-tier is instant, P-tier benefits
  // from not waiting for each other's LLM calls.
  const results = await Promise.allSettled(applicable.map(async (d) => {
    const insights = await d.run(ctx)
    return { detector: d, insights }
  }))

  // Persist results sequentially (SQLite writes are single-threaded anyway).
  for (const [i, result] of results.entries()) {
    const d = applicable[i]!
    if (result.status === 'fulfilled') {
      try {
        store.persistInsights(d.name, d.version, result.value.insights)
        log.debug(`detector ${d.name}: ${result.value.insights.length} insight(s)`)
      } catch (err) {
        store.persistDetectorError(d.name, d.version)
        log.warn(`detector ${d.name} persist failed: ${(err as Error).message}`)
      }
    } else {
      store.persistDetectorError(d.name, d.version)
      log.warn(`detector ${d.name} failed: ${result.reason?.message ?? result.reason}`)
    }
  }
}
