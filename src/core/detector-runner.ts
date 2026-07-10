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
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { detector: d, insights } = result.value
      store.persistInsights(d.name, d.version, insights)
      log.debug(`detector ${d.name}: ${insights.length} insight(s)`)
    } else {
      log.warn(`detector failed: ${result.reason?.message ?? result.reason}`)
    }
  }
}
