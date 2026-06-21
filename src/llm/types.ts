import type { TokenUsage } from '../core/model'

export interface LlmCompletion {
  text: string
  usage: TokenUsage
}

/** Thin provider-neutral client. Enrichment uses a single completion per session. */
export interface LlmClient {
  provider: string
  model: string
  complete(opts: { system: string; user: string; maxTokens?: number }): Promise<LlmCompletion>
}
