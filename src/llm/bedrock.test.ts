import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBedrockClient } from './bedrock'

// Stub the SDK client so completeStructured never hits the network; the tests
// assert what request the bedrock wrapper builds, not what AWS returns.
const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrock: class {
    messages = { create }
  },
}))

const req = { system: 's', user: 'u', schema: { type: 'object' }, toolName: 'record' }

beforeEach(() => {
  create.mockReset()
  create.mockResolvedValue({
    content: [{ type: 'tool_use', name: 'record', input: { ok: true } }],
    usage: { input_tokens: 1, output_tokens: 2 },
  })
})

// Bedrock rejects forced tool_choice while thinking could run; Sonnet 5 thinks
// by default, so the wrapper must opt out for it — and ONLY for it (an explicit
// disable 400s on always-on-thinking models).
describe('bedrock thinking gate', () => {
  it('sends an explicit thinking opt-out for Sonnet 5 ids', async () => {
    const client = createBedrockClient('', 'us.anthropic.claude-sonnet-5-20260203-v1:0')
    await client.completeStructured(req)
    const params = create.mock.calls[0]![0]
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'record' })
  })

  it('omits thinking entirely for other models', async () => {
    const client = createBedrockClient('', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
    await client.completeStructured(req)
    expect(create.mock.calls[0]![0]).not.toHaveProperty('thinking')
  })
})
