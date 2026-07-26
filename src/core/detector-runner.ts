import { normalizeDetectorResult } from './detector'
import type { Detector, DetectorContext, DetectorProgress, DetectorResult } from './detector'
import type { LlmClient } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'
import type { Progress } from '../util/progress'

export interface DetectorRunOptions {
  detectors: Detector[]
  store: Store
  log: Logger
  llmEnabled: boolean
  llm: LlmClient | null
  /** Optional step-2 progress bar; all detectors share one aggregator backing it. */
  progress?: Progress
  /**
   * The run's `--limit`, when set. Bounds detector work the same way it bounds
   * session processing: P-tier detectors judge at most this many candidates (via
   * `ctx.limit`), and X-tier (cross-session) detectors are skipped entirely — their
   * accumulation over the whole corpus can't be partially bounded.
   */
  limit?: number
}

export async function runDetectors(opts: DetectorRunOptions): Promise<void> {
  const { detectors, store, log, llmEnabled, llm, progress, limit } = opts

  // One shared reporter backing the step-2 bar: every detector's addUnits/unitDone/
  // addCost aggregates into the same Progress, even though detectors run in parallel
  // (single-threaded JS → no locking). ETA extrapolates from wall-clock since the
  // phase started, so parallel unit completions still yield a (rough) estimate.
  const phaseStart = Date.now()
  const reporter: DetectorProgress | undefined = progress && {
    addUnits: (n) => progress.addUnits(n),
    unitDone: (costUsd) => progress.unitDone(Date.now() - phaseStart, costUsd),
    addCost: (costUsd) => progress.addCost(costUsd),
  }

  // Per-detector context: unseenSessions/loadSession close over the detector name
  // (each detector's delta is tracked independently in detector_session_runs).
  const contextFor = (d: Detector): DetectorContext => ({
    store,
    log,
    llmEnabled,
    llm,
    unseenSessions: () => store.detectorUnseen(d.name),
    loadSession: (id) => store.hydrateSession(id),
    progress: reporter,
    limit,
  })

  const applicable = detectors.filter((d) => {
    if (d.needsLlm && !llmEnabled) return false
    // A bounded run (--limit) skips X-tier detectors: their cross-session
    // accumulation (extract-per-session, then reconcile + surface over the WHOLE
    // corpus) can't be partially bounded without leaving the written rows in an
    // inconsistent state. Logged, not silent — the user asked for a full pass to
    // get them. P-tier detectors instead cap their candidate count via ctx.limit.
    if (limit != null && d.tier === 'X') {
      log.info(`detector ${d.name} (tier X, cross-session) skipped under --limit; run without --limit for a full pass`)
      return false
    }
    if (d.applicable && !d.applicable(contextFor(d))) {
      log.debug(`detector ${d.name} not applicable, skipping`)
      return false
    }
    return true
  })

  // A version bump means a new prompt/schema — the whole corpus must be re-analyzed,
  // not just the content-hash delta. Forget prior per-session tracking so
  // unseenSessions() returns everything. (S-tier ignores this — it has no tracking.)
  //
  // A model swap invalidates the delta for the same reason: extractions made by the
  // old model aren't comparable to what the new one would produce, and without this
  // switching TUNELOOP_LLM_MODEL_HEAVY would leave every session "seen" and quietly
  // produce nothing. Mirrors the processor cache, which keys on model directly.
  //
  // The comparison is against the last SUCCESSFUL run's model, not the latest run's:
  // an error run records no model, and reading that null as "no model to compare"
  // would silently skip this check for every swap following a failure. S-tier never
  // records a model at all, so it never resets here.
  for (const d of applicable) {
    const prior = store.detectorRun(d.name)
    if (!prior) continue
    if (prior.version !== d.version) {
      store.resetDetectorSessionRuns(d.name)
      log.debug(`detector ${d.name} version ${prior.version}→${d.version}: re-analyzing full corpus`)
      continue
    }
    if (!d.needsLlm || !llm) continue
    const priorModel = store.detectorLastSuccessfulModel(d.name)
    if (priorModel && priorModel !== llm.model) {
      store.resetDetectorSessionRuns(d.name)
      log.debug(`detector ${d.name} model ${priorModel}→${llm.model}: re-analyzing full corpus`)
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
