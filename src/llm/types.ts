import type { TokenUsage } from '../core/model'

/** A JSON Schema object describing the structured output a completion must return. */
export type JsonSchema = Record<string, unknown>

export interface StructuredRequest {
  system: string
  user: string
  /** JSON Schema for the result — the forced tool's input schema. */
  schema: JsonSchema
  /** Name of the single forced tool. */
  toolName: string
  maxTokens?: number
  /**
   * Mark the (stable) system block as a prompt-cache breakpoint, for when the same
   * system prompt repeats across many calls in a run. Anthropic: adds cache_control;
   * OpenAI: no-op (auto-caches long prefixes).
   */
  cacheSystem?: boolean
}

export interface LlmResult {
  /** The model's structured output (the forced tool's input), normalized by the caller. */
  data: Record<string, unknown>
  usage: TokenUsage
}

/** Shared construction options for the OpenAI/Anthropic clients. */
export interface ClientOpts {
  /** User-facing provider name (self-cost pricing keys on it). */
  provider?: string
  /** OpenAI-compatible endpoint override (OpenRouter, Groq, Ollama, …). */
  baseURL?: string
}

/**
 * Thin provider-neutral client. Enrichment uses a single structured completion
 * per session: the output schema is exposed as one forced tool call (the tool
 * input IS the result), which works identically across Anthropic and every
 * OpenAI-compatible endpoint — unlike provider-specific structured-output modes.
 * This requires a tool-call-capable model; non-tool models are unsupported.
 */
export interface LlmClient {
  provider: string
  model: string
  completeStructured(req: StructuredRequest): Promise<LlmResult>
}
