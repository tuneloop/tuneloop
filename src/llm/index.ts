import type { AivueConfig } from '../config'
import { createAnthropicClient } from './anthropic'
import { createOpenAiClient } from './openai'
import { PROVIDERS } from './providers'
import type { ClientOpts, LlmClient } from './types'

export type { LlmClient, LlmResult, StructuredRequest, JsonSchema } from './types'
export { PROVIDERS, PROVIDER_NAMES } from './providers'

/** Build an LLM client from config, or null if enrichment isn't configured. */
export function createLlmClient(llm: AivueConfig['llm']): LlmClient | null {
  if (!llm) return null
  const preset = PROVIDERS[llm.provider]
  if (!preset) throw new Error(`unknown LLM provider: ${llm.provider} (supported: ${Object.keys(PROVIDERS).join(', ')})`)
  const opts: ClientOpts = { provider: llm.provider, baseURL: llm.baseURL }
  switch (preset.shape) {
    case 'anthropic':
      return createAnthropicClient(llm.apiKey, llm.model, opts)
    case 'openai':
    case 'openai-compatible':
      return createOpenAiClient(llm.apiKey, llm.model, opts)
  }
}
