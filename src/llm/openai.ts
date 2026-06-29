import OpenAI from 'openai'
import { parseJsonObject } from './json'
import type { ClientOpts, LlmClient, LlmResult, StructuredRequest } from './types'

/**
 * OpenAI / OpenAI-compatible client over the Chat Completions API — the universal
 * endpoint every compatible provider implements (OpenRouter, Groq, DeepSeek,
 * Together, Fireworks, xAI, Gemini-compat, Ollama). `baseURL` selects the
 * endpoint; `provider` is the name self-cost pricing keys on.
 *
 * Structured output is one forced function call whose arguments ARE the result,
 * so the model must support tool calling. `strict` is NOT set: many compatible
 * providers do function calling but not strict json-schema, and enrich-session
 * normalizes defensively anyway. Token cap uses `max_completion_tokens` (native
 * gpt-5/o-series require it; compatible endpoints accept it — verified on
 * Ollama/Groq/Gemini).
 */
export function createOpenAiClient(apiKey: string, model: string, opts?: ClientOpts): LlmClient {
  const client = new OpenAI({ apiKey, baseURL: opts?.baseURL })
  return {
    provider: opts?.provider ?? 'openai',
    model,
    async completeStructured<T>(req: StructuredRequest): Promise<LlmResult<T>> {
      const { system, user, schema, toolName, maxTokens = 1024 } = req
      const resp = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [{ type: 'function', function: { name: toolName, description: 'Record the structured analysis.', parameters: schema } }],
        tool_choice: { type: 'function', function: { name: toolName } },
      })
      const msg = resp.choices[0]?.message
      const call = msg?.tool_calls?.find((c) => c.type === 'function' && c.function.name === toolName)
      if (call?.type === 'function') return { data: (parseJsonObject(call.function.arguments) ?? {}) as T, usage: usageOf(resp.usage) }
      // No tool call came back; salvage any plain-text JSON.
      return { data: (parseJsonObject(msg?.content ?? '') ?? {}) as T, usage: usageOf(resp.usage) }
    },
  }
}

function usageOf(u: OpenAI.Completions.CompletionUsage | undefined) {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output: u?.completion_tokens ?? 0,
    cacheCreate: 0,
    cacheRead: cached,
  }
}
