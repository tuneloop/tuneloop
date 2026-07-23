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
const MIN_WASTE_USD = 1 // level-card floor: absolute avoidable premium per repo over the window
const SEVERITY_USD = { high: 10, medium: 3 }

// Trend card — a repo's weekly miss cost ELEVATED over its own recent baseline. This
// is the "getting worse" signal the absolute level card can't give: a heavy repo can
// leak steadily below any rate floor, and a normally-clean repo can spike without ever
// approaching one. Both are surfaced, by different cards, off the same weekly view.
const WEEK_MS = 7 * 86_400_000
const TREND_BASELINE_WEEKS = 5 // trailing weeks that define "normal" for a repo
const TREND_LOOKBACK_MS = (TREND_BASELINE_WEEKS + 1) * WEEK_MS // current week + baseline
const TREND_MIN_ACTIVE_BASELINE_WEEKS = 2 // repo must have RUN in >= this many baseline weeks —
// otherwise there is no baseline to deviate from and a first week of misses is a cold
// start, not a spike (this is also what keeps a brand-new repo from self-triggering).
const TREND_SPIKE_K = 3 // current week >= K × the baseline median …
const TREND_SPIKE_FLOOR_USD = 15 // … and >= this absolute, so a jump from pennies to a few dollars stays quiet

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

// Every classified turn in the trend lookback, carrying the rate inputs to price the
// misses. `isMiss` lets the current/baseline weeks be built from one scan.
interface TrendRow {
  repo: string
  sessionId: string
  ts: string | null
  isMiss: number
  provider: string
  model: string | null
  avoidableTokens: number
  creates5m: number
  creates1h: number
  input: number
}

interface Spike {
  repo: string
  currentUsd: number
  baselineUsd: number
  misses: number
  sessions: string[]
  firstTs: string | null
  lastTs: string | null
}

const pct = (x: number) => `${Math.round(x * 100)}%`

// Premium actually paid for one miss: the view already capped avoidable_tokens at what
// this turn re-bought; rate it at what it was paid at (write-TTL mix, or full input for
// read-discount caching). Unpriced model → $0 (the miss still counts).
function priceMiss(m: Pick<TrendRow, 'provider' | 'model' | 'avoidableTokens' | 'creates5m' | 'creates1h' | 'input'>): number {
  if (!m.model || m.avoidableTokens <= 0) return 0
  const price = priceFor(m.provider, m.model)
  if (!price) return 0
  const creates = m.creates5m + m.creates1h
  const paidRate =
    creates > 0 ? (m.creates5m * price.cache_write_5m + m.creates1h * price.cache_write_1h) / creates : price.input
  return (m.avoidableTokens * (paidRate - price.cache_read)) / 1_000_000
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// A repo spikes when its CURRENT 7-day miss cost is both above an absolute floor and a
// multiple of its own trailing-week baseline — and only if it was actually active
// across enough baseline weeks to HAVE a baseline (else it is a cold start, not a
// spike). Buckets by the turn's own timestamp; bucket 0 is the last 7 days.
function detectSpikes(rows: TrendRow[], nowMs: number): Spike[] {
  const byRepo = new Map<string, TrendRow[]>()
  for (const r of rows) {
    const list = byRepo.get(r.repo) ?? []
    list.push(r)
    byRepo.set(r.repo, list)
  }
  const spikes: Spike[] = []
  for (const [repo, rs] of byRepo) {
    const weekUsd = new Array<number>(TREND_BASELINE_WEEKS + 1).fill(0) // [0] = current 7 days
    const weekActive = new Array<number>(TREND_BASELINE_WEEKS + 1).fill(0) // classified turns / week
    let curMisses = 0
    const curSessions = new Set<string>()
    let firstTs: string | null = null
    let lastTs: string | null = null
    for (const r of rs) {
      if (!r.ts) continue
      const bucket = Math.floor((nowMs - Date.parse(r.ts)) / WEEK_MS)
      if (bucket < 0 || bucket > TREND_BASELINE_WEEKS) continue
      weekActive[bucket]!++
      if (r.isMiss) {
        weekUsd[bucket]! += priceMiss(r)
        if (bucket === 0) {
          curMisses++
          curSessions.add(r.sessionId)
          if (firstTs === null || r.ts < firstTs) firstTs = r.ts
          if (lastTs === null || r.ts > lastTs) lastTs = r.ts
        }
      }
    }
    const activeBaselineWeeks = weekActive.slice(1).filter((c) => c > 0).length
    if (activeBaselineWeeks < TREND_MIN_ACTIVE_BASELINE_WEEKS) continue
    const baselineUsd = median(weekUsd.slice(1))
    const currentUsd = weekUsd[0]!
    if (currentUsd >= TREND_SPIKE_FLOOR_USD && currentUsd >= TREND_SPIKE_K * baselineUsd) {
      spikes.push({ repo, currentUsd, baselineUsd, misses: curMisses, sessions: [...curSessions], firstTs, lastTs })
    }
  }
  return spikes.sort((a, b) => b.currentUsd - a.currentUsd)
}

function buildTrendInsight(spikes: Spike[]): InsightInput {
  const top = spikes[0]!
  const repoLabel = spikes.length === 1 ? top.repo : `${spikes.length} repos`
  const ratio = top.baselineUsd > 0 ? `${(top.currentUsd / top.baselineUsd).toFixed(1)}×` : 'well above'
  const totalMisses = spikes.reduce((n, s) => n + s.misses, 0)
  const evidence = spikes.flatMap((s) =>
    s.sessions.map((sessionId) => ({ sessionId, note: `${s.repo} · spike week · $${s.currentUsd.toFixed(2)}` })),
  )
  return {
    signalKey: 'cache-miss-trend',
    repo: '*',
    severity: top.currentUsd >= SEVERITY_USD.high ? 'high' : top.currentUsd >= SEVERITY_USD.medium ? 'medium' : 'low',
    title: `Cache-miss premium spiking in ${repoLabel}`,
    description:
      `In the last 7 days, prompt-cache misses in ${top.repo} cost an estimated $${top.currentUsd.toFixed(2)} in ` +
      `re-bought context — ${ratio} its trailing ~$${top.baselineUsd.toFixed(2)}/week baseline. A jump like this ` +
      `usually means something changed the cached prefix mid-stream (a config or model switch, a toggled MCP ` +
      `server) or a run of long-idle sessions. It reflects a recent change in behavior, not a standing cost — ` +
      `if it was a one-off it will settle on its own.`,
    evidence,
    count: totalMisses,
    firstSeenAt: top.firstTs ?? undefined,
    lastSeenAt: top.lastTs ?? undefined,
    fix: {
      type: 'behavioral-nudge',
      label: 'Check what changed',
      content:
        `Cache-miss cost in ${top.repo} rose sharply this week. Look for a recent change that rewrites the ` +
        `cached prefix — edits to CLAUDE.md or project config, a toggled MCP server, or a model switch — and ` +
        `for sessions resumed after long idle breaks that outlive the provider's cache lifetime.`,
    },
  }
}

export const cacheMiss: Detector = {
  name: 'cache-miss',
  version: 2,
  tier: 'S',
  run(ctx) {
    const nowMs = Date.now()
    const results: InsightInput[] = []
    const since = new Date(nowMs - WINDOW_DAYS * 86_400_000).toISOString()

    // ---- LEVEL card: steady avoidable dollars over the recent window ----------------
    // Denominator + session count, per repo, over the recent window. The views scan
    // globally; `ts >= since` is the read-time window on the turn's own timestamp.
    const classifiedRows = ctx.store.queryAll(
      `SELECT repo, COUNT(*) AS classified, COUNT(DISTINCT session_id) AS sessions
       FROM cache_classified_turn
       WHERE ts >= ?
       GROUP BY repo`,
      since,
    ) as ClassifiedAgg[]

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
      const w = priceMiss(m)
      if (w > 0) {
        agg.wasteUsd += w
        agg.sessionWaste.set(m.sessionId, (agg.sessionWaste.get(m.sessionId) ?? 0) + w)
      }
      // Real occurrence window for the card's first/last-seen.
      if (m.ts) {
        if (agg.firstMissTs === null || m.ts < agg.firstMissTs) agg.firstMissTs = m.ts
        if (agg.lastMissTs === null || m.ts > agg.lastMissTs) agg.lastMissTs = m.ts
      }
    }

    // Qualifying repos, folded into ONE cross-repo LEVEL insight (per-repo figures
    // survive as each evidence session's note). Gated on volume + DOLLARS, not miss
    // RATE: at a heavy user's denominator a 1% cold-start rate never clears an
    // absolute rate floor, yet the absolute premium is real money — the dollar figure
    // is the honest trigger for a level card (the "getting worse" story is the
    // separate trend insight below). MIN_MISS_RATE is retired from the level gate.
    const qualifying = [...repos.entries()].filter(
      ([, a]) => a.sessions >= MIN_SESSIONS && a.wasteUsd >= MIN_WASTE_USD,
    )
    if (qualifying.length === 0) {
      // No steady leakage this window — resolve any prior level card so a stale claim
      // doesn't freeze on the dashboard (the N4 fix, applied at the empty path).
      ctx.store.resolveInsight('cache-miss', '*', 'cache-misses')
    } else {
      results.push(buildLevelInsight(qualifying))
    }

    // ---- TREND card: a repo's weekly miss cost elevated over its own baseline --------
    const trendRows = ctx.store.queryAll(
      `SELECT repo, session_id AS sessionId, ts, is_miss AS isMiss, provider, model,
              avoidable_tokens AS avoidableTokens,
              creates_5m AS creates5m, creates_1h AS creates1h, input
       FROM cache_classified_turn
       WHERE ts >= ?`,
      new Date(nowMs - TREND_LOOKBACK_MS).toISOString(),
    ) as TrendRow[]
    const spikes = detectSpikes(trendRows, nowMs)
    if (spikes.length === 0) ctx.store.resolveInsight('cache-miss', '*', 'cache-miss-trend')
    else results.push(buildTrendInsight(spikes))

    return results
  },
}

function buildLevelInsight(qualifying: Array<[string, RepoAgg]>): InsightInput {
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
    return {
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
    }
}

registerDetector(cacheMiss)
