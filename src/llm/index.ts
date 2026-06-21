import type { AivueConfig } from '../config'
import { createAnthropicClient } from './anthropic'
import { createOpenAiClient } from './openai'
import type { LlmClient } from './types'

export type { LlmClient, LlmCompletion } from './types'

/** Build an LLM client from config, or null if enrichment isn't configured. */
export function createLlmClient(llm: AivueConfig['llm']): LlmClient | null {
  if (!llm) return null
  switch (llm.provider) {
    case 'anthropic':
      return createAnthropicClient(llm.apiKey, llm.model)
    case 'openai':
      return createOpenAiClient(llm.apiKey, llm.model)
    default:
      throw new Error(`unknown LLM provider: ${llm.provider} (supported: anthropic, openai)`)
  }
}
