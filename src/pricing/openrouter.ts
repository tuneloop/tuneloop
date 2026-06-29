import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelPrice } from './pricing'

/**
 * OpenRouter price backfill: a cache-first loader for OpenRouter's free, no-auth
 * model catalog (~400 models across every vendor), used to price models the
 * static `models.json` doesn't list — both analyzed-session cost and enrichment
 * self-cost. Loaded once per run regardless of provider (see analyze.ts), so
 * pricing is consistent across runs. Best-effort and never blocking: a
 * failed/offline fetch falls back to a stale cache or an empty table → $0.
 *
 * `priceFor` (pricing.ts) consults this AFTER the static table, so the static
 * rates always win and this only fills genuine gaps.
 */
const ENDPOINT = 'https://openrouter.ai/api/v1/models'
const CACHE_FILE = 'openrouter-prices.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // a day; prices drift slowly

interface RawModel {
  id: string
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string }
}
interface Cache {
  fetchedAt: number
  prices: Record<string, ModelPrice>
}

// Loaded once per process; null until loadOpenRouterPrices runs (synchronous
// lookups before then simply miss). Keyed by OpenRouter model id (e.g.
// "deepseek/deepseek-chat"), normalized to our per-million ModelPrice.
let table: Map<string, ModelPrice> | null = null

/** Load the catalog (cache-first). Safe to call once at startup; idempotent. */
export async function loadOpenRouterPrices(dataDir: string, log?: { debug(msg: string): void }): Promise<void> {
  if (table) return
  const path = join(dataDir, CACHE_FILE)
  const cached = await readCache(path)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    table = new Map(Object.entries(cached.prices))
    return
  }
  try {
    const resp = await fetch(ENDPOINT, { signal: AbortSignal.timeout(4000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const json = (await resp.json()) as { data?: RawModel[] }
    const prices = normalize(json.data ?? [])
    table = new Map(Object.entries(prices))
    await writeCache(path, { fetchedAt: Date.now(), prices })
  } catch (err) {
    table = cached ? new Map(Object.entries(cached.prices)) : new Map()
    log?.debug(`openrouter price fetch failed (${(err as Error).message}); using ${cached ? 'stale cache' : 'no'} backfill`)
  }
}

/**
 * Synchronous backfill lookup (post-load). Tries the more-specific
 * `"<provider>/<model>"` first (e.g. deepseek + deepseek-chat), then the bare id
 * (already a full OpenRouter id when provider=openrouter). Miss → undefined → $0.
 */
export function backfillPrice(provider: string, model: string): ModelPrice | undefined {
  if (!table || !model) return undefined
  return table.get(`${provider}/${model}`) ?? table.get(model)
}

function normalize(models: RawModel[]): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {}
  for (const m of models) {
    const p = m.pricing
    if (!m.id || !p) continue
    const perM = (v: string | undefined) => (v ? Number(v) * 1_000_000 : 0)
    const input = perM(p.prompt)
    // OpenRouter has a single cache-write rate; mirror it to both TTL slots.
    const cacheWrite = p.input_cache_write ? perM(p.input_cache_write) : input
    out[m.id] = {
      input,
      output: perM(p.completion),
      cache_write_5m: cacheWrite,
      cache_write_1h: cacheWrite,
      cache_read: perM(p.input_cache_read),
    }
  }
  return out
}

async function readCache(path: string): Promise<Cache | null> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as Cache
    // Validate shape so a truncated/half-written cache is treated as a miss, not
    // a crash (Object.entries(undefined) downstream).
    if (typeof c?.fetchedAt !== 'number' || !c.prices || typeof c.prices !== 'object') return null
    return c
  } catch {
    return null
  }
}

async function writeCache(path: string, cache: Cache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache))
  } catch {
    // A non-writable data dir just means no cache next run; not fatal.
  }
}
