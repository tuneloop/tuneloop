import type { TuneloopConfig } from '../config'
import { createAnthropicClient } from './anthropic'
import { createBedrockClient } from './bedrock'
import { createOpenAiClient } from './openai'
import { PROVIDERS } from './providers'
import type { ClientOpts, LlmClient } from './types'

export type { LlmClient, LlmResult, StructuredRequest, JsonSchema } from './types'
export { PROVIDERS, PROVIDER_NAMES } from './providers'
export type { ProviderPreset } from './providers'

/** Build an LLM client from config, or null if enrichment isn't configured. */
export function createLlmClient(llm: TuneloopConfig['llm']): LlmClient | null {
  if (!llm) return null
  // Sole validator for recoverable enrichment misconfig: these throws land in
  // analyze's try/catch and degrade to static-only, instead of aborting the command.
  const preset = PROVIDERS[llm.provider]
  if (!preset) throw new Error(`unknown LLM provider: ${llm.provider} (supported: ${Object.keys(PROVIDERS).join(', ')})`)
  if (!llm.model) throw new Error(`provider "${llm.provider}" needs a model — set TUNELOOP_LLM_MODEL or --llm-model`)
  if (preset.shape === 'openai-compatible' && !llm.baseURL) {
    throw new Error(`provider "${llm.provider}" needs a base URL — set TUNELOOP_LLM_BASE_URL or --llm-base-url`)
  }
  const opts: ClientOpts = { provider: llm.provider, baseURL: llm.baseURL }
  switch (preset.shape) {
    case 'anthropic':
      return createAnthropicClient(llm.apiKey, llm.model, opts)
    case 'bedrock':
      return createBedrockClient(llm.apiKey, llm.model, opts)
    case 'openai':
    case 'openai-compatible':
      return createOpenAiClient(llm.apiKey, llm.model, opts)
  }
}
