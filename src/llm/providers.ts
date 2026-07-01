/**
 * Provider presets — the single source of truth for which LLM endpoints tuneloop
 * can drive. Almost every provider speaks the OpenAI Chat Completions wire
 * format, so they all share ONE `openai-compatible` shape that differs only by
 * `baseURL`; a preset is sugar that bakes in the URL, the default key env, and a
 * sensible default model. Anthropic is the lone native exception.
 *
 * To add a provider, add a row here — nothing else changes.
 */
export type ProviderShape = 'anthropic' | 'openai' | 'openai-compatible'

export interface ProviderPreset {
  shape: ProviderShape
  /** Required for openai-compatible; omitted for the native SDK defaults. */
  baseURL?: string
  /** Default env var the API key is read from when TUNELOOP_LLM_API_KEY is unset. */
  keyEnv: string
  defaultModel: string
  /** false for local endpoints that need no key (Ollama). */
  requiresKey?: boolean
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  anthropic: { shape: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-haiku-4-5' },
  openai: { shape: 'openai', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-5.4-mini' },

  openrouter: { shape: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-5-mini' },
  groq: { shape: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
  deepseek: { shape: 'openai-compatible', baseURL: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  gemini: { shape: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash' },
  together: { shape: 'openai-compatible', baseURL: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', defaultModel: 'deepseek-ai/DeepSeek-V3' },
  fireworks: { shape: 'openai-compatible', baseURL: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY', defaultModel: 'accounts/fireworks/models/deepseek-v3' },
  xai: { shape: 'openai-compatible', baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', defaultModel: 'grok-4' },
  // Local: no key. Enrichment uses forced tool calls, so pick a tool-capable
  ollama: { shape: 'openai-compatible', baseURL: 'http://localhost:11434/v1', keyEnv: 'OLLAMA_API_KEY', defaultModel: 'qwen2.5', requiresKey: false },

  // Escape hatch for anything unlisted; requires TUNELOOP_LLM_BASE_URL.
  'openai-compatible': { shape: 'openai-compatible', keyEnv: 'TUNELOOP_LLM_API_KEY', defaultModel: '' },
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS)
