import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiClient } from './openai'

const mocks = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }))

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mocks.create } }
    constructor(opts: unknown) {
      mocks.ctor(opts)
    }
  },
}))

describe('OpenAI cache-write usage', () => {
  beforeEach(() => mocks.create.mockReset())

  it('separates GPT-5.6 cache writes from uncached input', async () => {
    mocks.create.mockResolvedValue({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'record', arguments: '{}' } }] } }],
      usage: {
        prompt_tokens: 2_000,
        completion_tokens: 100,
        total_tokens: 2_100,
        prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 1_000 },
      },
    })
    const client = createOpenAiClient('test-key', 'gpt-5.6')

    const result = await client.completeStructured({ system: 'system', user: 'user', schema: {}, toolName: 'record' })

    expect(result.usage).toEqual({
      input: 500,
      output: 100,
      cacheCreate5m: 1_000,
      cacheCreate1h: 0,
      cacheRead: 500,
    })
  })
})

describe('OpenAI client construction', () => {
  beforeEach(() => mocks.ctor.mockReset())

  it('forwards baseURL and custom default headers to the SDK', () => {
    createOpenAiClient('unused', 'm', { baseURL: 'http://gw/v1', headers: { 'x-user-id': 'u-123' } })
    expect(mocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'unused', baseURL: 'http://gw/v1', defaultHeaders: { 'x-user-id': 'u-123' } }),
    )
  })

  it('sends no defaultHeaders when none are configured', () => {
    createOpenAiClient('k', 'm', { baseURL: 'http://gw/v1' })
    expect(mocks.ctor.mock.calls[0]?.[0]).not.toHaveProperty('defaultHeaders', expect.anything())
  })
})
