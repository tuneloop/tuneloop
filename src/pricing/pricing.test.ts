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
    const dir = await mkdtemp(join(tmpdir(), 'tuneloop-or-'))
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

describe('GPT-5.6 pricing', () => {
  it.each([
    ['gpt-5.6-sol', 5, 30, 6.25, 0.5],
    ['gpt-5.6-terra', 2.5, 15, 3.125, 0.25],
    ['gpt-5.6-luna', 1, 6, 1.25, 0.1],
  ])('prices %s at its standard API rate', (model, input, output, cacheWrite, cacheRead) => {
    expect(priceFor('openai', model)).toEqual({
      input,
      output,
      cache_write_5m: cacheWrite,
      cache_write_1h: cacheWrite,
      cache_read: cacheRead,
    })
  })

  it('prices the gpt-5.6 alias as Sol', () => {
    expect(priceFor('openai', 'gpt-5.6')).toEqual(priceFor('openai', 'gpt-5.6-sol'))
  })

  it('prices dated tier snapshots at the matching tier rate', () => {
    expect(priceFor('openai', 'gpt-5.6-terra-20260709')).toEqual(priceFor('openai', 'gpt-5.6-terra'))
  })
})

describe('bedrock model-id unwrapping', () => {
  it('prices a full inference-profile id at the vendor rate', () => {
    // geo prefix + vendor + date snapshot + version suffix → anthropic/claude-haiku-4-5
    const p = priceFor('bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(p).toEqual(priceFor('anthropic', 'claude-haiku-4-5'))
    expect(p?.input).toBeGreaterThan(0)
  })

  it('prices a bare vendor-prefixed id (no geo, no version)', () => {
    expect(priceFor('bedrock', 'anthropic.claude-haiku-4-5')).toEqual(priceFor('anthropic', 'claude-haiku-4-5'))
  })

  it('handles geo prefixes it has never seen (vendor.model are always the last two segments)', () => {
    expect(priceFor('bedrock', 'us-gov.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual(priceFor('anthropic', 'claude-haiku-4-5'))
    expect(priceFor('bedrock', 'jp.anthropic.claude-sonnet-5-20260203-v1:0')).toEqual(priceFor('anthropic', 'claude-sonnet-5'))
  })

  it('returns undefined for a vendor the table does not list', () => {
    expect(priceFor('bedrock', 'us.meta.llama3-1-405b-instruct-v1:0')).toBeUndefined()
  })
})
