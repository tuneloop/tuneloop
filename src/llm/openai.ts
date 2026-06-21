import OpenAI from 'openai'
import type { LlmClient, LlmCompletion } from './types'

/**
 * OpenAI-backed client. Note: models.json has no OpenAI prices yet, so the
 * "cost of running the analysis itself" reads $0 for OpenAI until rates are added.
 */
export function createOpenAiClient(apiKey: string, model: string): LlmClient {
  const client = new OpenAI({ apiKey })
  return {
    provider: 'openai',
    model,
    async complete({ system, user, maxTokens = 1024 }): Promise<LlmCompletion> {
      const resp = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      })
      const text = resp.choices[0]?.message?.content ?? ''
      const u = resp.usage as {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      } | undefined
      const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
      return {
        text,
        usage: {
          input: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
          output: u?.completion_tokens ?? 0,
          cacheCreate: 0,
          cacheRead: cached,
        },
      }
    },
  }
}
