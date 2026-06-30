import type { Session, TokenUsage } from '../core/model'
import models from './models.json'
import { backfillPrice } from './openrouter'

export interface ModelPrice {
  input: number
  output: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
}

/** Bump when models.json rates change so stored costs can be recomputed. */
export const PRICE_TABLE_VERSION = '2026-06-30'

type Table = Record<string, Record<string, ModelPrice>>
const TABLE = models as unknown as Table

/**
 * Look up a price, tolerant of model-id drift: exact match, then strip a
 * trailing date snapshot (`-20251001` or `@20251001`), then prefix match.
 */
export function priceFor(provider: string, model: string, opts?: { backfill?: boolean }): ModelPrice | undefined {
  const byProvider = TABLE[provider]
  if (byProvider) {
    if (byProvider[model]) return byProvider[model]
    const stripped = model.replace(/[-@]\d{8}$/, '')
    if (byProvider[stripped]) return byProvider[stripped]
    // Longest key first so a specific variant wins over a shorter prefix of it
    // (e.g. `gpt-5.2-codex-*` matches `gpt-5.2-codex`, not the pricier `gpt-5.2`).
    for (const key of Object.keys(byProvider).sort((a, b) => b.length - a.length)) {
      if (model.startsWith(key)) return byProvider[key]
    }
  }
  // Backfill is opt-in (enrichment self-cost only, never session analytics)
  return opts?.backfill ? backfillPrice(provider, model) : undefined
}

/** Cost of a single usage record at a given model's rates (0 if unpriced). */
export function costOfUsage(provider: string, model: string, u: TokenUsage): number {
  // Enrichment self-cost: opt into the backfill to price non-table providers
  const p = priceFor(provider, model, { backfill: true })
  if (!p) return 0
  return (
    (u.input * p.input + u.output * p.output + u.cacheCreate * p.cache_write_5m + u.cacheRead * p.cache_read) /
    1_000_000
  )
}

/**
 * Usage + cost for one assistant message — the atomic grain of token economics.
 * Persisted to `usage_facts` so model / main-vs-sidechain / time breakdowns are
 * all read-time GROUP BYs (cost can't be summed by model off the session row).
 */
export interface UsageFact {
  idx: number
  model: string
  isSidechain: boolean
  ts?: string
  tokens: TokenUsage
  usd: number
}

export interface CostResult {
  usd: number
  /** Models we had no price for — their tokens count, but contribute $0. */
  unpriced: string[]
  /** One entry per assistant message, in order. Sums to `usd` / session tokens. */
  facts: UsageFact[]
}

/**
 * Cost of a session, priced per assistant message at that message's model, with
 * the per-message breakdown retained. Cache-creation tokens are priced at the
 * 5-minute rate (Claude Code's default).
 */
export function computeSessionCost(session: Session): CostResult {
  let usd = 0
  const unpriced = new Set<string>()
  const facts: UsageFact[] = []
  let idx = 0
  for (const ev of session.events) {
    if (ev.kind !== 'assistant') continue
    const model = ev.model ?? session.models[0] ?? '<unknown>'
    const u = ev.usage
    let cost = 0
    if (ev.costUsd != null) {
      // The source billed its own cost (e.g. OpenCode) — the actual spend, which is
      // authoritative over our rate-table reconstruction even if the table has the model.
      cost = ev.costUsd
    } else {
      // Token-priced sources (Claude Code, Codex); static table only, no backfill.
      const price = priceFor(session.provider, model)
      if (price) {
        cost =
          (u.input * price.input +
            u.output * price.output +
            u.cacheCreate * price.cache_write_5m +
            u.cacheRead * price.cache_read) /
          1_000_000
      } else {
        unpriced.add(model)
      }
    }
    usd += cost
    facts.push({ idx, model, isSidechain: ev.isSidechain, ts: ev.ts, tokens: u, usd: cost })
    idx++
  }
  return { usd, unpriced: [...unpriced], facts }
}
