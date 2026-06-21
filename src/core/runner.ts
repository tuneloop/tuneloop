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
  existingFeatures: FeatureRef[]
  sh: ProcessorContext['sh']
}

/** Run every applicable processor for one session, honoring deps + the cache. */
export async function runProcessors(opts: RunOptions): Promise<void> {
  const { session, store, log, llmEnabled, llmModel, llm, existingFeatures, sh } = opts
  const ctx: ProcessorContext = { session, log, llmEnabled, llm, existingFeatures, sh }
  const inputHash = session.raw.contentHash

  for (const p of orderProcessors(opts.processors)) {
    if (p.needs?.llm && !llmEnabled) continue
    const model = p.needs?.llm ? llmModel : null

    const prior = store.processorRun(session.id, p.name)
    if (prior && prior.version === p.version && prior.inputHash === inputHash && prior.model === model) {
      log.debug(`cached ${p.name} for ${session.id}`)
      continue
    }

    try {
      const result = await p.run(ctx)
      store.persistResult(session.id, p.name, p.version, inputHash, model, result)
    } catch (err) {
      log.warn(`processor ${p.name} failed on ${session.id}: ${(err as Error).message}`)
    }
  }
}
