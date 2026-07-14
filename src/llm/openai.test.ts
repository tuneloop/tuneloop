import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiClient } from './openai'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mocks.create } }
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
