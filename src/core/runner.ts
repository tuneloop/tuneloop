import type { Session } from './model'
import type { FeatureRef, Processor, ProcessorContext } from './processor'
import type { LlmClient } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'

/** Topologically order processors so a processor runs after everything in `requires`. */
export function orderProcessors(procs: Processor[]): Processor[] {
  const byName = new Map(procs.map((p) => [p.name, p]))
  const out: Processor[] = []
  const done = new Set<string>()
  const onStack = new Set<string>()

  const visit = (p: Processor) => {
    if (done.has(p.name)) return
    if (onStack.has(p.name)) return // dependency cycle — break it
    onStack.add(p.name)
    for (const dep of p.requires ?? []) {
      const d = byName.get(dep)
      if (d) visit(d)
    }
    onStack.delete(p.name)
    done.add(p.name)
    out.push(p)
  }
  for (const p of procs) visit(p)
  return out
}

export interface RunOptions {
  session: Session
  processors: Processor[]
  store: Store
  log: Logger
  llmEnabled: boolean
  llmModel: string | null
  llm: LlmClient | null
  sh: ProcessorContext['sh']
}

export interface RunResult {
  costUsd: number
}

/** Run every applicable processor for one session, honoring deps + the cache. */
export async function runProcessors(opts: RunOptions): Promise<RunResult> {
  const { session, store, log, llmEnabled, llmModel, llm, sh } = opts
  // Read the feature hierarchy fresh for every session, not once per run, so a
  // session sees features that earlier sessions in this run created, renamed, or
  // reparented — letting the extractor grow one coherent tree instead of dupes.
  // The whole (cross-repo) hierarchy is sent; repo isolation is enforced on
  // linkage inside the processor, not by hiding other repos' features.
  const existingFeatures: FeatureRef[] = store.listFeatures()
  const rejectedFeatureTitles = store.rejectedFeatureTitles(session.id)
  const allUserLinked = store.userLinkedArtifactsAll(session.id)
  const userLinkedArtifacts = allUserLinked
    .filter((a) => a.kind === 'feature' || !a.hasNonEnrichBlocks)
    .map(({ hasNonEnrichBlocks: _, ...rest }) => rest)
  const prBlockAttributions = store.prBlockAttributions(session.id)
  const ctx: ProcessorContext = { session, log, llmEnabled, llm, existingFeatures, rejectedFeatureTitles, userLinkedArtifacts, prBlockAttributions, sh }
  // The hash incorporates the stable set of ALL user-linked artifact IDs.
  // This only changes when the user adds or removes a link — never oscillates
  // due to block attribution state.
  let inputHash = session.raw.contentHash
  if (allUserLinked.length > 0) {
    const suffix = allUserLinked.map((a) => a.artifactId).sort().join(',')
    inputHash = `${inputHash}+${suffix}`
  }
  let costUsd = 0

  for (const p of orderProcessors(opts.processors)) {
    if (p.needs?.llm && !llmEnabled) continue
    const model = p.needs?.llm ? llmModel : null

    // Re-read block attributions fresh so enrich-session sees blocks that
    // outcomes-git persisted earlier in this same loop. Without this, the
    // first analysis of a session sees an empty FIXED set and the LLM can
    // double-attribute a block to both a deterministic PR and a linked PR.
    ctx.prBlockAttributions = store.prBlockAttributions(session.id)

    const prior = store.processorRun(session.id, p.name)
    if (prior && prior.version === p.version && prior.inputHash === inputHash && prior.model === model) {
      log.debug(`cached ${p.name} for ${session.id}`)
      continue
    }

    try {
      const result = await p.run(ctx)
      store.persistResult(session.id, p.name, p.version, inputHash, model, result)
      costUsd += result.selfCost?.usd ?? 0
    } catch (err) {
      log.warn(`processor ${p.name} failed on ${session.id}: ${(err as Error).message}`)
    }
  }
  return { costUsd }
}
