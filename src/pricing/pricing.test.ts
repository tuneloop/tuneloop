import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { computeSessionCost, priceFor } from './pricing'
import { loadOpenRouterPrices } from './openrouter'
import { emptyUsage } from '../core/model'
import type { Session, TokenUsage } from '../core/model'

// computeSessionCost only reads provider, models, and assistant events.
function session(provider: string, model: string, usage: TokenUsage, costUsd?: number): Session {
  return {
    id: 's', sessionId: 's', source: 'opencode', provider,
    project: { cwd: '/r' }, models: [model], tokens: usage,
    events: [{ kind: 'assistant', model, usage, isSidechain: false, blocks: [], costUsd } as any],
    toolCalls: [], raw: { path: '', contentHash: 'h' },
  } as Session
}

describe('computeSessionCost precedence', () => {
  it('uses the source-reported cost over the static table when both exist', () => {
    // claude-haiku-4-5 IS in models.json, but the source billed its own number —
    // that real spend is authoritative for session analytics (review comment 1).
    const u = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 } // table would be $1 + $5 = $6
    const cost = computeSessionCost(session('anthropic', 'claude-haiku-4-5', u, 0.42))
    expect(cost.usd).toBeCloseTo(0.42, 6)
    expect(cost.unpriced).toHaveLength(0)
  })

  it('prices from the static table when the source reports no cost', () => {
    const u = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    const cost = computeSessionCost(session('anthropic', 'claude-haiku-4-5', u))
    expect(cost.usd).toBeCloseTo(6, 6) // 1M input × $1 + 1M output × $5
  })
})

describe('priceFor backfill gating', () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aivue-or-'))
    await writeFile(
      join(dir, 'openrouter-prices.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        prices: { 'openrouter/some-model': { input: 2, output: 4, cache_write_5m: 2, cache_write_1h: 2, cache_read: 0.2 } },
      }),
    )
    await loadOpenRouterPrices(dir)
  })

  it('reaches the backfill for a provider the static table does not list (review comment 2)', () => {
    // Pre-fix, priceFor returned undefined before ever consulting the backfill for
    // any non-anthropic/openai provider.
    expect(priceFor('openrouter', 'some-model', { backfill: true })?.input).toBe(2)
  })

  it('does NOT consult the backfill unless explicitly opted in', () => {
    expect(priceFor('openrouter', 'some-model')).toBeUndefined()
  })
})
