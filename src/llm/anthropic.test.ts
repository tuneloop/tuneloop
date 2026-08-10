import { beforeEach, describe, expect, it, vi } from 'vitest'
import { anthropicShapedClient, createAnthropicClient, type AnthropicMessagesClient } from './anthropic'

const mocks = vi.hoisted(() => ({ ctor: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: vi.fn() }
    constructor(opts: unknown) {
      mocks.ctor(opts)
    }
  },
}))

/** A fake Messages client that records the params it was called with. */
function fakeClient() {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'record', input: { ok: true } }],
    usage: { input_tokens: 10, output_tokens: 2 },
  })
  const client = { messages: { create } } as unknown as AnthropicMessagesClient
  return { client, create }
}

// A gateway deployment (corporate Claude proxy) needs the base URL and header
// overrides to reach the SDK — same contract the OpenAI-shaped client honors.
describe('Anthropic client construction', () => {
  beforeEach(() => mocks.ctor.mockReset())

  it('forwards baseURL and custom default headers to the SDK', () => {
    createAnthropicClient('k', 'claude-x', { baseURL: 'http://gw', headers: { 'x-user-id': 'u-123' } })
    expect(mocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k', baseURL: 'http://gw', defaultHeaders: { 'x-user-id': 'u-123' } }),
    )
  })

  it('leaves baseURL and defaultHeaders unset when none are configured', () => {
    createAnthropicClient('k', 'claude-x')
    expect(mocks.ctor).toHaveBeenCalledWith({ apiKey: 'k', baseURL: undefined, defaultHeaders: undefined })
  })
})

describe('Anthropic system prompt caching', () => {
  it('marks the system block cacheable when cacheSystem is set', async () => {
    const { client, create } = fakeClient()
    const llm = anthropicShapedClient(client, 'anthropic', 'claude-x')
    await llm.completeStructured({ system: 'RULES', user: 'data', schema: {}, toolName: 'record', cacheSystem: true })
    const params = create.mock.calls[0]![0]
    expect(params.system).toEqual([{ type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } }])
  })

  it('passes system as a plain string when cacheSystem is not set (back-compat)', async () => {
    const { client, create } = fakeClient()
    const llm = anthropicShapedClient(client, 'anthropic', 'claude-x')
    await llm.completeStructured({ system: 'RULES', user: 'data', schema: {}, toolName: 'record' })
    expect(create.mock.calls[0]![0].system).toBe('RULES')
  })
})

describe('Anthropic tool-call XML leak sanitization', () => {
  it('strips tool-call XML that bled into a string param of the forced tool', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'draft_fix',
          input: {
            worth_surfacing: true,
            fix_type: 'fix-prompt',
            content: 'Verify state before acting.</content>\n<parameter name="reason">Recurring gap.</parameter>',
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    const client = { messages: { create } } as unknown as AnthropicMessagesClient
    const llm = anthropicShapedClient(client, 'anthropic', 'claude-x')
    const { data } = await llm.completeStructured({ system: 's', user: 'u', schema: {}, toolName: 'draft_fix' })
    expect(data.content).toBe('Verify state before acting.')
    expect(data.fix_type).toBe('fix-prompt')
    expect(data.worth_surfacing).toBe(true)
  })
})
