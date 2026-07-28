import { Agent, setGlobalDispatcher } from 'undici'

let configured = false

/**
 * Make the per-session enrichment pass' concurrency actually parallel.
 *
 * Node's built-in fetch speaks HTTP/2 to api.anthropic.com (and OpenAI) and multiplexes
 * every request over ONE connection, which those APIs' edges serialize — so N concurrent
 * calls queue behind each other and each call's latency inflates ~N×. Measured on a fresh
 * 118-session Anthropic run: branch serial 11m44s vs branch concurrency-4 10m07s — only 14%
 * for 4× the concurrency, because all four streams funnel through one serialized connection.
 *
 * Forcing HTTP/1.1 (`allowH2: false`) makes undici open a POOL of separate connections and
 * spread the concurrent requests across them, so they run truly in parallel (each stays ~5s
 * instead of ballooning). `connections` caps the pool per origin, well above our concurrency
 * ceiling. Idempotent — installed when the first LLM client is built, before any request
 * goes out. HTTP/1.1 keep-alive is harmless for every other host the CLI hits.
 */
export function tuneHttpForConcurrentLlm(): void {
  if (configured) return
  configured = true
  setGlobalDispatcher(new Agent({ connections: 64, allowH2: false, pipelining: 1 }))
}
