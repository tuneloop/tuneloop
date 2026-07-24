import Anthropic from '@anthropic-ai/sdk'
import { parseJsonObject, sanitizeToolInput } from './json'
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
      const { system, user, schema, toolName, maxTokens = 1024, cacheSystem } = req
      // cacheSystem → send system as a cacheable block (repeat calls read it at ~10% cost).
      const systemParam = cacheSystem
        ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
        : system
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemParam,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: toolName, description: 'Record the structured analysis.', input_schema: schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: toolName },
        ...extraParams,
      })
      // The forced tool's input IS the structured result; salvage any text if absent.
      // sanitizeToolInput strips tool-call XML a model (notably Sonnet-5) can bleed
      // into a long string param — e.g. a fix's `content` capturing the sibling
      // `<parameter name="reason">…` block.
      for (const b of resp.content) {
        if (b.type === 'tool_use' && b.name === toolName) return { data: sanitizeToolInput(b.input as Record<string, unknown>), usage: usageOf(resp.usage) }
      }
      return { data: parseJsonObject(textOf(resp.content)) ?? {}, usage: usageOf(resp.usage) }
    },
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

function usageOf(u: Anthropic.Usage) {
  const base = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 }
  // Same shape as the claude-code adapter: take the per-TTL breakdown when the
  // API returns one, else the write total is all 5m. Falling back per-field
  // instead would double-count the 1h share against the total.
  const cc = u.cache_creation
  if (!cc) return { ...base, cacheCreate5m: u.cache_creation_input_tokens ?? 0, cacheCreate1h: 0 }
  return {
    ...base,
    cacheCreate5m: cc.ephemeral_5m_input_tokens ?? 0,
    cacheCreate1h: cc.ephemeral_1h_input_tokens ?? 0,
  }
}
