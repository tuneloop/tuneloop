import Anthropic from '@anthropic-ai/sdk'
import { parseJsonObject } from './json'
import type { ClientOpts, LlmClient, LlmResult, StructuredRequest } from './types'

/** The one slice of the Anthropic SDK surface the enrichment path uses — also satisfied by the Bedrock client. */
export interface AnthropicMessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> }
}

/** Anthropic-backed client. Data goes only to Anthropic, with the user's own key. */
export function createAnthropicClient(apiKey: string, model: string, opts?: ClientOpts): LlmClient {
  return anthropicShapedClient(new Anthropic({ apiKey }), opts?.provider ?? 'anthropic', model)
}

/**
 * Forced-tool structured completion over any client speaking the Anthropic
 * Messages API (Anthropic itself, AWS Bedrock). `extraParams` lets a backend
 * add request fields its endpoint requires (e.g. Bedrock's thinking opt-out).
 */
export function anthropicShapedClient(
  client: AnthropicMessagesClient,
  provider: string,
  model: string,
  extraParams?: Partial<Anthropic.MessageCreateParamsNonStreaming>,
): LlmClient {
  return {
    provider,
    model,
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      const { system, user, schema, toolName, maxTokens = 1024 } = req
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: toolName, description: 'Record the structured analysis.', input_schema: schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: toolName },
        ...extraParams,
      })
      // The forced tool's input IS the structured result; salvage any text if absent.
      for (const b of resp.content) {
        if (b.type === 'tool_use' && b.name === toolName) return { data: b.input as Record<string, unknown>, usage: usageOf(resp.usage) }
      }
      return { data: parseJsonObject(textOf(resp.content)) ?? {}, usage: usageOf(resp.usage) }
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
