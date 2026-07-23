import type { LlmClient, LlmResult, StructuredRequest } from './types'
import { costOfUsage } from '../pricing/pricing'

// When Langfuse env keys are present, every LLM call is mirrored to a self-hosted Langfuse 
// as a "generation" nested under one trace per analyze run — so prompt (system+user), 
// output, model, tokens, and cost are all inspectable. Entirely opt-in: no keys → this module 
// is a no-op and the SDK (a devDependency) is never even imported, so it can't affect a user's build or run.

const ENABLED = !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY

// A minimal shape of the bits of the Langfuse SDK we touch, so this file type-checks
// without the (dev-only) package as a hard dependency.
interface Trace {
  generation(body: Record<string, unknown>): { end(body: Record<string, unknown>): void; update(body: Record<string, unknown>): void }
}
interface LangfuseClient {
  trace(body: Record<string, unknown>): Trace
  flushAsync(): Promise<unknown>
}

let client: LangfuseClient | null | undefined // undefined = not yet initialized
let currentTrace: Trace | null = null

/** Lazily construct the Langfuse client (dynamic import → never bundled unless used). */
async function getClient(): Promise<LangfuseClient | null> {
  if (client !== undefined) return client
  try {
    const mod = await import('langfuse')
    const Langfuse = (mod as { Langfuse: new (opts: Record<string, unknown>) => LangfuseClient }).Langfuse
    client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
    })
  } catch {
    client = null // SDK absent (e.g. prod build) — silently disable
  }
  return client
}

/**
 * Open a run-level trace that every subsequent LLM call nests under. No-op unless
 * the Langfuse env keys are set. `name` labels the run in the Langfuse UI.
 */
export async function startLlmTrace(name: string, metadata?: Record<string, unknown>): Promise<void> {
  if (!ENABLED) return
  const c = await getClient()
  if (!c) return
  currentTrace = c.trace({ name, metadata })
}

/** Flush buffered events and close the trace. MUST be called before a short-lived CLI
 *  exits, or events are lost. No-op when tracing is off. */
export async function endLlmTrace(): Promise<void> {
  if (!ENABLED || client == null) return
  currentTrace = null
  try {
    await client.flushAsync()
  } catch {
    /* best-effort: tracing must never break a run */
  }
}

/**
 * Wrap an LlmClient so each `completeStructured` is mirrored to Langfuse as a
 * generation under the current run trace. Returns the client unchanged when tracing
 * is off, so there is zero overhead on a normal run.
 */
export function withTracing(inner: LlmClient): LlmClient {
  if (!ENABLED) return inner
  return {
    provider: inner.provider,
    model: inner.model,
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      const gen = currentTrace?.generation({
        name: req.toolName, // the call type: record_friction | reconcile_taxonomy | draft_fix | summarize_activity
        model: inner.model,
        input: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        metadata: { provider: inner.provider, toolName: req.toolName, maxTokens: req.maxTokens },
      })
      try {
        const res = await inner.completeStructured(req)
        gen?.end({
          output: res.data,
          usageDetails: {
            input: res.usage.input,
            output: res.usage.output,
            cache_read: res.usage.cacheRead,
            cache_creation: res.usage.cacheCreate5m + res.usage.cacheCreate1h,
          },
          costDetails: { total: costOfUsage(inner.provider, inner.model, res.usage) },
        })
        return res
      } catch (err) {
        gen?.end({ level: 'ERROR', statusMessage: (err as Error).message })
        throw err
      }
    },
  }
}
