import Anthropic from '@anthropic-ai/sdk'
import { parseJsonObject } from './json'
import type { ClientOpts, LlmClient, LlmResult, StructuredRequest } from './types'

/** Anthropic-backed client. Data goes only to Anthropic, with the user's own key. */
export function createAnthropicClient(apiKey: string, model: string, opts?: ClientOpts): LlmClient {
  const client = new Anthropic({ apiKey })
  return {
    provider: opts?.provider ?? 'anthropic',
    model,
    async completeStructured<T>(req: StructuredRequest): Promise<LlmResult<T>> {
      const { system, user, schema, toolName, maxTokens = 1024 } = req
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: toolName, description: 'Record the structured analysis.', input_schema: schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: toolName },
      })
      // The forced tool's input IS the structured result; salvage any text if absent.
      for (const b of resp.content) {
        if (b.type === 'tool_use' && b.name === toolName) return { data: b.input as T, usage: usageOf(resp.usage) }
      }
      return { data: (parseJsonObject(textOf(resp.content)) ?? {}) as T, usage: usageOf(resp.usage) }
    },
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

function usageOf(u: Anthropic.Usage) {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  }
}
