import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSessions, trimInheritedPrefix } from '../../core/merge'
import { computeSessionCost } from '../../pricing/pricing'
import { parseCodex } from './parse'

describe('Codex token usage and cost', () => {
  it('splits cached input and ignores repeated cumulative-total events', async () => {
    const firstUsage = {
      input_tokens: 2_000_000,
      cached_input_tokens: 1_000_000,
      output_tokens: 100_000,
      reasoning_output_tokens: 20_000,
    }
    const records = [
      { type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
      tokenCount(firstUsage, firstUsage),
      // Older Codex versions re-emitted the last usage at turn finalization.
      tokenCount(firstUsage, firstUsage),
      tokenCount(
        {
          input_tokens: 3_000_000,
          cached_input_tokens: 1_500_000,
          output_tokens: 300_000,
          reasoning_output_tokens: 70_000,
        },
        {
          input_tokens: 1_000_000,
          cached_input_tokens: 500_000,
          output_tokens: 200_000,
          reasoning_output_tokens: 50_000,
        },
      ),
    ]
    const dir = await mkdtemp(join(tmpdir(), 'tuneloop-codex-'))
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'))

    const session = await parseCodex(path)
    expect(session?.tokens).toEqual({
      input: 1_500_000,
      output: 300_000,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 1_500_000,
    })

    const cost = computeSessionCost(session!)
    expect(cost.facts).toHaveLength(2)
    // 1.5M input @ $1.75 + 1.5M cached @ $0.175 + 0.3M output @ $14.
    expect(cost.usd).toBeCloseTo(7.0875, 6)
  })

  it('removes a child rollout inherited prefix before merging usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tuneloop-codex-'))
    const parentPath = join(dir, 'parent.jsonl')
    const childPath = join(dir, 'child.jsonl')
    const parentUsage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }
    await writeFile(
      parentPath,
      [
        { type: 'session_meta', payload: { id: 'parent', cwd: '/repo' } },
        { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
        tokenCount(parentUsage, parentUsage),
      ].map((record) => JSON.stringify(record)).join('\n'),
    )
    await writeFile(
      childPath,
      [
        { type: 'session_meta', payload: { id: 'child', cwd: '/repo', thread_source: 'subagent', forked_from_id: 'parent' } },
        { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
        tokenCount(parentUsage, parentUsage),
        tokenCount(
          { input_tokens: 300, cached_input_tokens: 120, output_tokens: 30 },
          { input_tokens: 200, cached_input_tokens: 80, output_tokens: 20 },
        ),
      ].map((record) => JSON.stringify(record)).join('\n'),
    )
    const parent = (await parseCodex(parentPath))!
    const child = (await parseCodex(childPath))!

    trimInheritedPrefix(child, parent)
    const merged = mergeSessions([parent, child])

    expect(child.tokens).toEqual({ input: 120, output: 20, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 80 })
    expect(merged.tokens).toEqual({ input: 180, output: 30, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 120 })
  })
})

function tokenCount(total: Record<string, number>, last: Record<string, number>) {
  return {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  }
}
