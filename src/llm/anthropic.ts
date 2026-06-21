import Anthropic from '@anthropic-ai/sdk'
import type { LlmClient, LlmCompletion } from './types'

/** Anthropic-backed client. Data goes only to Anthropic, with the user's own key. */
export function createAnthropicClient(apiKey: string, model: string): LlmClient {
  const client = new Anthropic({ apiKey })
  return {
    provider: 'anthropic',
    model,
    async complete({ system, user, maxTokens = 1024 }): Promise<LlmCompletion> {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      })
      let text = ''
      for (const block of resp.content) {
        if (block.type === 'text') text += block.text
      }
      const u = resp.usage as {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number | null
        cache_read_input_tokens?: number | null
      }
      return {
        text,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheCreate: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
        },
      }
    },
  }
}
