import { registerDetector } from '../core/registry'
import type { Detector, InsightInput } from '../core/detector'
import { priceFor } from '../pricing/pricing'

/**
 * Flags repos where prompt-cache misses are burning money.
 *
 * Misses are OBSERVED, never inferred from timing: a warm turn reads its prior
 * context back as cache_read; a cold turn reads ~nothing and re-pays it — as
 * cache_create (write-priced caching, Anthropic) or full-price input
 * (read-discount caching, OpenAI). Comparing a turn's reads against what the
 * previous turn left cached classifies it directly, across harnesses and providers.
 *
 * The detector makes no causal claim about WHY a miss happened — cache lifetimes are
 * per-request API choices we can't read, and config churn needs env snapshots.
 * It reports the observed miss rate, the premium actually paid, and a
 * descriptive timing split; attribution can layer on later.
 */

const WINDOW_DAYS = 30
const MIN_SESSIONS = 10 // per repo in the window — fewer and the rates are noise
const LONG_BREAK_MS = 5 * 60_000 // descriptive split only — no cache-lifetime claim
const MIN_CONTEXT_TOKENS = 10_000 // below this the dollars are noise — our floor, not a provider rule
const HIT_READ_SHARE = 0.5 // a hit reads back at least this share of its prior context
// New context under half the previous one is a rewrite (compaction/rewind),
// not a cold cache — neither hit nor miss.
const SHRUNK_CTX_SHARE = 0.5
const MIN_MISS_RATE = 0.25
const MIN_WASTE_USD = 1
const SEVERITY_USD = { high: 10, medium: 3 }

interface FactRow {
  sessionId: string
  repo: string
  provider: string
  model: string | null
  ts: string | null
  input: number
  output: number // not cached (see prevCtx) — used only for the zero-row check
  creates5m: number // cache-write tokens, split by TTL (disjoint)
  creates1h: number
  reads: number
}

interface RepoAgg {
  sessions: number // sessions that contributed at least one classified turn
  classified: number // turns with enough prior context to call hit/miss
  misses: number
  breakMisses: number // misses that followed a >5-min break (descriptive, not causal)
  wasteUsd: number
  sessionWaste: Map<string, number>
  firstMissTs: string | null // earliest/latest miss-turn timestamp — the real occurrence window
  lastMissTs: string | null
}

const pct = (x: number) => `${Math.round(x * 100)}%`

export const cacheMiss: Detector = {
  name: 'cache-miss',
  version: 1,
  tier: 'S',
  run(ctx) {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
    // Main thread only — sidechains are separate conversations with their own cache prefixes.
    const rows = ctx.store.queryAll(
      `SELECT u.session_id AS sessionId,
              COALESCE(NULLIF(s.repo, ''), NULLIF(s.cwd, ''), '_unknown') AS repo,
              s.provider, u.model, u.ts,
              COALESCE(u.tok_input, 0) AS input,
              COALESCE(u.tok_output, 0) AS output,
              COALESCE(u.tok_cache_create_5m, 0) AS creates5m,
              COALESCE(u.tok_cache_create_1h, 0) AS creates1h,
              COALESCE(u.tok_cache_read, 0) AS reads
       FROM usage_facts u JOIN sessions s ON s.id = u.session_id
       WHERE u.is_sidechain = 0 AND s.started_at >= ?
       ORDER BY u.session_id, u.idx`,
      since,
    ) as FactRow[]

    const bySession = new Map<string, FactRow[]>()
    for (const r of rows) {
      const list = bySession.get(r.sessionId) ?? []
      list.push(r)
      bySession.set(r.sessionId, list)
    }

    const repos = new Map<string, RepoAgg>()
    for (const facts of bySession.values()) {
      // No cache tokens anywhere → provider doesn't report caching, indistinguishable from cold.
      if (!facts.some((f) => f.creates5m > 0 || f.creates1h > 0 || f.reads > 0)) continue

      let classified = 0
      let misses = 0
      let breakMisses = 0
      let wasteUsd = 0
      let firstMissTs: string | null = null
      let lastMissTs: string | null = null
      let prevCtx = 0 // what a warm turn would read back
      let prevTs: number | null = null
      for (const f of facts) {
        // Whole cache write, both TTLs — a turn's context is cached across both.
        const creates = f.creates5m + f.creates1h
        // All-zero rows aren't API calls (content flushes, ingest-deduped repeat lines).
        if (f.input + f.output + creates + f.reads === 0) continue

        const ts = f.ts ? Date.parse(f.ts) : NaN
        // What the next warm turn would read back: reads plus what this turn
        // cached (creates, or billed input under read-discount caching). Output
        // and any uncached input tail aren't cached yet — paid next turn either
        // way, so they belong in neither the expectation nor the waste.
        const newCtx = f.reads + (creates > 0 ? creates : f.input)
        if (prevCtx >= MIN_CONTEXT_TOKENS && newCtx >= prevCtx * SHRUNK_CTX_SHARE) {
          classified++
          if (f.reads < prevCtx * HIT_READ_SHARE) {
            misses++
            // Real occurrence time for this miss (rows arrive in idx order, so the
            // first/last we see are the earliest/latest miss). Skip rows with no ts.
            if (f.ts) {
              if (firstMissTs === null) firstMissTs = f.ts
              lastMissTs = f.ts
            }
            if (prevTs !== null && !Number.isNaN(ts) && ts - prevTs > LONG_BREAK_MS) breakMisses++
            // Premium actually paid: un-read prior context re-bought at uncached
            // rates, capped at what this turn really paid. Unpriced model → miss counts, $0.
            const rePaid = creates > 0 ? creates : f.input
            const avoidable = Math.min(prevCtx - f.reads, rePaid)
            const price = f.model ? priceFor(f.provider, f.model) : undefined
            if (price && avoidable > 0) {
              // Rate the re-buy at what it was actually paid at
              const paidRate =
                creates > 0
                  ? (f.creates5m * price.cache_write_5m + f.creates1h * price.cache_write_1h) / creates
                  : price.input
              wasteUsd += (avoidable * (paidRate - price.cache_read)) / 1_000_000
            }
          }
        }
        prevCtx = newCtx
        if (!Number.isNaN(ts)) prevTs = ts
      }
      if (classified === 0) continue

      const repo = facts[0]!.repo
      let agg = repos.get(repo)
      if (!agg) {
        agg = { sessions: 0, classified: 0, misses: 0, breakMisses: 0, wasteUsd: 0, sessionWaste: new Map(), firstMissTs: null, lastMissTs: null }
        repos.set(repo, agg)
      }
      agg.sessions++
      agg.classified += classified
      agg.misses += misses
      agg.breakMisses += breakMisses
      agg.wasteUsd += wasteUsd
      if (wasteUsd > 0) agg.sessionWaste.set(facts[0]!.sessionId, wasteUsd)
      // Widen the repo's miss window (sessions arrive in id order, not time order,
      // so compare rather than assign).
      if (firstMissTs && (agg.firstMissTs === null || firstMissTs < agg.firstMissTs)) agg.firstMissTs = firstMissTs
      if (lastMissTs && (agg.lastMissTs === null || lastMissTs > agg.lastMissTs)) agg.lastMissTs = lastMissTs
    }

    const insights: InsightInput[] = []
    for (const [repo, a] of repos) {
      if (a.sessions < MIN_SESSIONS) continue
      const missRate = a.misses / a.classified
      if (missRate < MIN_MISS_RATE || a.wasteUsd < MIN_WASTE_USD) continue

      const waste = a.wasteUsd.toFixed(2)
      const evidence = [...a.sessionWaste.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([sessionId]) => ({ sessionId }))
      insights.push({
        signalKey: 'cache-misses',
        repo,
        severity: a.wasteUsd >= SEVERITY_USD.high ? 'high' : a.wasteUsd >= SEVERITY_USD.medium ? 'medium' : 'low',
        title: 'Frequent prompt-cache misses',
        description:
          `Across ${a.sessions} sessions in the last ${WINDOW_DAYS} days, ${pct(missRate)} of turns with ` +
          `substantial prior context found the prompt cache cold and re-bought context that was already ` +
          `paid for — an estimated $${waste} premium over warm-cache rates. ${a.breakMisses} of the ` +
          `${a.misses} misses came more than 5 minutes after the previous message.`,
        evidence,
        count: a.misses,
        firstSeenAt: a.firstMissTs ?? undefined,
        lastSeenAt: a.lastMissTs ?? undefined,
        fix: {
          type: 'behavioral-nudge',
          label: 'Reduce cache misses',
          content:
            `A cache miss re-buys previously cached context instead of reading it back at the cheap cached ` +
            `rate (an estimated $${waste} across these sessions). The usual culprits: idle breaks that ` +
            `outlive the provider's cache lifetime, and ` +
            `mid-stream changes to config or model — editing CLAUDE.md, toggling MCP servers, or switching ` +
            `models rewrites the cached prefix. Batch quick follow-ups while the cache is warm, and settle ` +
            `config and model choices before long working sessions.`,
        },
      })
    }
    return insights
  },
}

registerDetector(cacheMiss)
