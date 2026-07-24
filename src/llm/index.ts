import type { TuneloopConfig } from '../config'
import { createAnthropicClient } from './anthropic'
import { createBedrockClient } from './bedrock'
import { createOpenAiClient } from './openai'
import { PROVIDERS } from './providers'
import { withTracing } from './tracing'
import type { ClientOpts, LlmClient } from './types'

export type { LlmClient, LlmResult, StructuredRequest, JsonSchema } from './types'
export { PROVIDERS, PROVIDER_NAMES } from './providers'
export type { ProviderPreset } from './providers'
export { startLlmTrace, endLlmTrace } from './tracing'

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
  // withTracing is a no-op unless LANGFUSE_* env keys are set (personal debug aid)
  switch (preset.shape) {
    case 'anthropic':
      return withTracing(createAnthropicClient(llm.apiKey, llm.model, opts))
    case 'bedrock':
      return withTracing(createBedrockClient(llm.apiKey, llm.model, opts))
    case 'openai':
    case 'openai-compatible':
      return withTracing(createOpenAiClient(llm.apiKey, llm.model, opts))
  }
}
