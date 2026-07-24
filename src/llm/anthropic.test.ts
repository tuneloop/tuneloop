import { describe, expect, it, vi } from 'vitest'
import { anthropicShapedClient, type AnthropicMessagesClient } from './anthropic'

/** A fake Messages client that records the params it was called with. */
function fakeClient() {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'record', input: { ok: true } }],
    usage: { input_tokens: 10, output_tokens: 2 },
  })
  const client = { messages: { create } } as unknown as AnthropicMessagesClient
  return { client, create }
}

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
