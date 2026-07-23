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
 * The classification itself lives in SQL: the `cache_classified_turn` /
 * `cache_miss_event` views (src/store/db.ts) are scanned GLOBALLY and this detector
 * presents a recent WINDOW over them (decision 1). The view yields `avoidable_tokens`
 * plus the rate inputs; dollars stay here because `priceFor` is a JS table with no
 * SQL equivalent (decision 2). The window keys off each turn's OWN timestamp, not its
 * session's start (decision 7), so a card ages out when the misses stop.
 *
 * The detector makes no causal claim about WHY a miss happened — cache lifetimes are
 * per-request API choices we can't read, and config churn needs env snapshots.
 * It reports the observed miss rate, the premium actually paid, and a
 * descriptive timing split; attribution can layer on later.
 */

const WINDOW_DAYS = 30
const MIN_SESSIONS = 10 // per repo in the window — fewer and the rates are noise
const LONG_BREAK_MS = 5 * 60_000 // descriptive split only — no cache-lifetime claim
const MIN_MISS_RATE = 0.25
const MIN_WASTE_USD = 1
const SEVERITY_USD = { high: 10, medium: 3 }

// One row per repo from cache_classified_turn — the denominator (miss rate) and the
// session count the qualifying gate needs.
interface ClassifiedAgg {
  repo: string
  classified: number
  sessions: number // distinct sessions with at least one classified turn
}

// One row per miss from cache_miss_event, carrying the rate inputs the view can't
// price (priceFor is a JS table). `gapMs` is the view's turn-to-turn gap.
interface MissRow {
  sessionId: string
  repo: string
  provider: string
  model: string | null
  ts: string | null
  avoidableTokens: number
  creates5m: number
  creates1h: number
  input: number
  gapMs: number | null
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

    // Denominator + session count, per repo, over the recent window. The views scan
    // globally; `ts >= since` is the read-time window on the turn's own timestamp.
    const classifiedRows = ctx.store.queryAll(
      `SELECT repo, COUNT(*) AS classified, COUNT(DISTINCT session_id) AS sessions
       FROM cache_classified_turn
       WHERE ts >= ?
       GROUP BY repo`,
      since,
    ) as ClassifiedAgg[]
    if (classifiedRows.length === 0) return []

    // Numerator: the miss turns, with the rate inputs to price each in JS.
    const missRows = ctx.store.queryAll(
      `SELECT session_id AS sessionId, repo, provider, model, ts,
              avoidable_tokens AS avoidableTokens,
              creates_5m AS creates5m, creates_1h AS creates1h, input,
              gap_ms AS gapMs
       FROM cache_miss_event
       WHERE ts >= ?`,
      since,
    ) as MissRow[]

    const repos = new Map<string, RepoAgg>()
    for (const c of classifiedRows) {
      repos.set(c.repo, {
        sessions: c.sessions,
        classified: c.classified,
        misses: 0,
        breakMisses: 0,
        wasteUsd: 0,
        sessionWaste: new Map(),
        firstMissTs: null,
        lastMissTs: null,
      })
    }

    for (const m of missRows) {
      const agg = repos.get(m.repo)
      if (!agg) continue // every miss is a classified turn, so its repo is always present
      agg.misses++
      if (m.gapMs !== null && m.gapMs > LONG_BREAK_MS) agg.breakMisses++
      // Premium actually paid: the view already capped avoidable_tokens at what this
      // turn re-bought; rate it at what it was paid at. Unpriced model → miss counts, $0.
      const creates = m.creates5m + m.creates1h
      const price = m.model ? priceFor(m.provider, m.model) : undefined
      if (price && m.avoidableTokens > 0) {
        const paidRate =
          creates > 0
            ? (m.creates5m * price.cache_write_5m + m.creates1h * price.cache_write_1h) / creates
            : price.input
        const w = (m.avoidableTokens * (paidRate - price.cache_read)) / 1_000_000
        agg.wasteUsd += w
        if (w > 0) agg.sessionWaste.set(m.sessionId, (agg.sessionWaste.get(m.sessionId) ?? 0) + w)
      }
      // Real occurrence window for the card's first/last-seen.
      if (m.ts) {
        if (agg.firstMissTs === null || m.ts < agg.firstMissTs) agg.firstMissTs = m.ts
        if (agg.lastMissTs === null || m.ts > agg.lastMissTs) agg.lastMissTs = m.ts
      }
    }

    // Qualifying repos (each gated on its own MIN_SESSIONS/miss-rate/waste, so a thin
    // or clean repo never enters the aggregate), then fold them into ONE cross-repo
    // insight. Per-repo figures survive as each evidence session's note.
    const qualifying = [...repos.entries()].filter(
      ([, a]) => a.sessions >= MIN_SESSIONS && a.misses / a.classified >= MIN_MISS_RATE && a.wasteUsd >= MIN_WASTE_USD,
    )
    if (qualifying.length === 0) return []

    let sessions = 0
    let classified = 0
    let misses = 0
    let breakMisses = 0
    let wasteUsd = 0
    let firstMissTs: string | null = null
    let lastMissTs: string | null = null
    const sessionWaste: Array<{ sessionId: string; repo: string; waste: number }> = []
    for (const [repo, a] of qualifying) {
      sessions += a.sessions
      classified += a.classified
      misses += a.misses
      breakMisses += a.breakMisses
      wasteUsd += a.wasteUsd
      if (a.firstMissTs && (firstMissTs === null || a.firstMissTs < firstMissTs)) firstMissTs = a.firstMissTs
      if (a.lastMissTs && (lastMissTs === null || a.lastMissTs > lastMissTs)) lastMissTs = a.lastMissTs
      for (const [sessionId, w] of a.sessionWaste) sessionWaste.push({ sessionId, repo, waste: w })
    }
    // Worst-wasting sessions first. Each evidence row notes its repo + premium — the
    // per-repo detail the single aggregate row would otherwise lose.
    const evidence = sessionWaste
      .sort((x, y) => y.waste - x.waste)
      .map((s) => ({ sessionId: s.sessionId, note: `${s.repo} · $${s.waste.toFixed(2)} premium` }))

    const waste = wasteUsd.toFixed(2)
    const missRate = misses / classified
    const repoLabel = qualifying.length === 1 ? qualifying[0]![0] : `${qualifying.length} repos`
    return [{
      signalKey: 'cache-misses',
      repo: '*',
      severity: wasteUsd >= SEVERITY_USD.high ? 'high' : wasteUsd >= SEVERITY_USD.medium ? 'medium' : 'low',
      title: 'Frequent prompt-cache misses',
      description:
        `Across ${sessions} sessions in ${repoLabel} in the last ${WINDOW_DAYS} days, ${pct(missRate)} of turns ` +
        `with substantial prior context found the prompt cache cold and re-bought context that was already ` +
        `paid for — an estimated $${waste} premium over warm-cache rates. ${breakMisses} of the ` +
        `${misses} misses came more than 5 minutes after the previous message.`,
      evidence,
      count: misses,
      firstSeenAt: firstMissTs ?? undefined,
      lastSeenAt: lastMissTs ?? undefined,
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
    }]
  },
}

registerDetector(cacheMiss)
