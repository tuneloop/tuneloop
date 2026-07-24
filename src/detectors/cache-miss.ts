import { registerDetector } from '../core/registry'
import { insightId, type Detector, type InsightInput } from '../core/detector'
import { priceFor } from '../pricing/pricing'

/**
 * Flags repos where prompt cache misses are burning money.
 *
 * Misses are OBSERVED, never inferred from timing: a warm turn reads its prior
 * context back as cache_read; a cold turn reads ~nothing and re-pays it — as
 * cache_create (write-priced caching, Anthropic) or full-price input
 * (read-discount caching, OpenAI). Comparing a turn's reads against what the
 * previous turn left cached classifies it directly, across harnesses and providers.
 *
 * The classification itself lives in SQL: the `cache_classified_turn` /
 * `cache_miss_event` views (src/store/db.ts) are scanned GLOBALLY and this detector
 * presents a recent WINDOW over them. The view yields `avoidable_tokens`
 * plus the rate inputs; dollars stay here because `priceFor` is a JS table with no
 * SQL equivalent. The window keys off each turn's OWN timestamp, not its
 * session's start, so a card ages out when the misses stop.
 *
 * The detector makes no causal claim about WHY a miss happened — cache lifetimes are
 * per-request API choices we can't read, and config churn needs env snapshots.
 * It reports the observed miss rate, the premium actually paid, and a
 * descriptive timing split; attribution can layer on later.
 */

const WINDOW_DAYS = 30
const MIN_SESSIONS = 10 // per repo in the window — fewer and the rates are noise
const LONG_BREAK_MS = 5 * 60_000 // descriptive split only — no cache-lifetime claim
const MIN_WASTE_USD = 20 // level-card floor: absolute avoidable premium per repo over the window
// Severity above the floor. medium = the floor, so every surfaced card (>= $20 avoidable
// premium — real money) is at least medium; high flags serious steady leakage.
const SEVERITY_USD = { high: 50, medium: MIN_WASTE_USD }

// One row per repo from cache_classified_turn — the session count the qualifying gate
// needs, plus the denominator for the "share of sessions that saw a miss" figure.
interface ClassifiedAgg {
  repo: string
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
  // Main-thread seq of the block this miss belongs to — the user-turn coordinate the
  // transcript viewer lands evidence on (null when the session hasn't been segmented).
  blockSeq: number | null
}

// Per evidence session: total premium, miss count (shown in the note), and the block
// seq of its worst single miss — so the evidence link opens the exchange that cost the most.
interface SessionWaste {
  waste: number
  misses: number
  topWaste: number
  seq: number | null
}

interface RepoAgg {
  sessions: number // sessions that contributed at least one classified turn
  missSessions: Set<string> // distinct sessions that saw at least one miss
  misses: number
  breakMisses: number // misses that followed a >5-min break (descriptive, not causal)
  wasteUsd: number
  sessionWaste: Map<string, SessionWaste>
  firstMissTs: string | null // earliest/latest miss-turn timestamp — the real occurrence window
  lastMissTs: string | null
}

const pct = (x: number) => `${Math.round(x * 100)}%`

// Premium actually paid for one miss: the view already capped avoidable_tokens at what
// this turn re-bought; rate it at what it was paid at (write-TTL mix, or full input for
// read-discount caching). Unpriced model → $0 (the miss still counts).
function priceMiss(m: Pick<MissRow, 'provider' | 'model' | 'avoidableTokens' | 'creates5m' | 'creates1h' | 'input'>): number {
  if (!m.model || m.avoidableTokens <= 0) return 0
  const price = priceFor(m.provider, m.model)
  if (!price) return 0
  const creates = m.creates5m + m.creates1h
  const paidRate =
    creates > 0 ? (m.creates5m * price.cache_write_5m + m.creates1h * price.cache_write_1h) / creates : price.input
  return (m.avoidableTokens * (paidRate - price.cache_read)) / 1_000_000
}

// Accumulate a session's premium and remember the block seq of its WORST single miss
// — that seq becomes the evidence pointer, so the link opens the priciest exchange.
// Only a miss that HAS a block can seed it; otherwise seq stays null and the link
// degrades to session-level (the transcript top), no worse than before.
function pickWorst(cur: SessionWaste | undefined, w: number, blockSeq: number | null): SessionWaste {
  const s = cur ?? { waste: 0, misses: 0, topWaste: 0, seq: null }
  s.waste += w
  s.misses++
  if (blockSeq != null && w >= s.topWaste) {
    s.topWaste = w
    s.seq = blockSeq
  }
  return s
}

export const cacheMiss: Detector = {
  name: 'cache-miss',
  version: 5,
  tier: 'S',
  run(ctx) {
    const nowMs = Date.now()
    const results: InsightInput[] = []
    const since = new Date(nowMs - WINDOW_DAYS * 86_400_000).toISOString()

    // ---- LEVEL card: steady avoidable dollars over the recent window ----------------
    // Denominator + session count, per repo, over the recent window. The views scan
    // globally; `ts >= since` is the read-time window on the turn's own timestamp.
    const classifiedRows = ctx.store.queryAll(
      `SELECT repo, COUNT(DISTINCT session_id) AS sessions
       FROM cache_classified_turn
       WHERE ts >= ?
       GROUP BY repo`,
      since,
    ) as ClassifiedAgg[]

    // Numerator: the miss turns, with the rate inputs to price each in JS and the block
    // seq to point evidence at the actual miss exchange (not the session's first message).
    const missRows = ctx.store.queryAll(
      `SELECT m.session_id AS sessionId, m.repo, m.provider, m.model, m.ts,
              m.avoidable_tokens AS avoidableTokens,
              m.creates_5m AS creates5m, m.creates_1h AS creates1h, m.input,
              m.gap_ms AS gapMs, b.start_seq AS blockSeq
       FROM cache_miss_event m
       LEFT JOIN block_usage bu ON bu.session_id = m.session_id AND bu.usage_idx = m.idx
       LEFT JOIN blocks b ON b.session_id = bu.session_id AND b.idx = bu.block_idx
       WHERE m.ts >= ?`,
      since,
    ) as MissRow[]

    const repos = new Map<string, RepoAgg>()
    for (const c of classifiedRows) {
      repos.set(c.repo, {
        sessions: c.sessions,
        missSessions: new Set(),
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
      agg.missSessions.add(m.sessionId)
      if (m.gapMs !== null && m.gapMs > LONG_BREAK_MS) agg.breakMisses++
      const w = priceMiss(m)
      if (w > 0) {
        agg.wasteUsd += w
        agg.sessionWaste.set(m.sessionId, pickWorst(agg.sessionWaste.get(m.sessionId), w, m.blockSeq))
      }
      // Real occurrence window for the card's first/last-seen.
      if (m.ts) {
        if (agg.firstMissTs === null || m.ts < agg.firstMissTs) agg.firstMissTs = m.ts
        if (agg.lastMissTs === null || m.ts > agg.lastMissTs) agg.lastMissTs = m.ts
      }
    }

    // Qualifying repos, folded into ONE cross-repo insight (per-repo figures survive as
    // each evidence session's note). Gated on volume + DOLLARS, not miss RATE: at a heavy
    // user's denominator a 1% cold-start rate never clears an absolute rate floor, yet
    // the absolute premium is real money — the dollar figure is the honest trigger.
    const qualifying = [...repos.entries()].filter(
      ([, a]) => a.sessions >= MIN_SESSIONS && a.wasteUsd >= MIN_WASTE_USD,
    )
    if (qualifying.length === 0) {
      // Nothing qualifies. Resolve a prior card only when EVERY repo that contributed to
      // it now has enough data (>= MIN_SESSIONS) to call clean. A corpus-wide total would
      // resolve on data no single contributing repo has (two 5-session repos clearing a
      // 10-session bar), and a different repo's data would tell a user their still-quiet
      // repo was fixed. No prior card / no evidence → resolveInsight is a no-op.
      const priorRepos = ctx.store.insightEvidenceRepos(insightId('cache-miss', '*', 'cache-misses'))
      const enough = priorRepos.length > 0 && priorRepos.every((r) => (repos.get(r)?.sessions ?? 0) >= MIN_SESSIONS)
      if (enough) ctx.store.resolveInsight('cache-miss', '*', 'cache-misses')
    } else {
      results.push(buildLevelInsight(qualifying))
    }

    return results
  },
}

function buildLevelInsight(qualifying: Array<[string, RepoAgg]>): InsightInput {
    let sessions = 0
    let sessionsWithMiss = 0
    let misses = 0
    let breakMisses = 0
    let wasteUsd = 0
    let firstMissTs: string | null = null
    let lastMissTs: string | null = null
    const sessionWaste: Array<{ sessionId: string; repo: string; waste: number; misses: number; seq: number | null }> = []
    for (const [repo, a] of qualifying) {
      sessions += a.sessions
      sessionsWithMiss += a.missSessions.size
      misses += a.misses
      breakMisses += a.breakMisses
      wasteUsd += a.wasteUsd
      if (a.firstMissTs && (firstMissTs === null || a.firstMissTs < firstMissTs)) firstMissTs = a.firstMissTs
      if (a.lastMissTs && (lastMissTs === null || a.lastMissTs > lastMissTs)) lastMissTs = a.lastMissTs
      for (const [sessionId, v] of a.sessionWaste) sessionWaste.push({ sessionId, repo, waste: v.waste, misses: v.misses, seq: v.seq })
    }
    // Worst-wasting sessions first. Each evidence row links to the session's priciest
    // miss exchange (turnIdx) and notes its repo, premium, and miss count — the per-repo
    // detail the single aggregate row would otherwise lose.
    const evidence = sessionWaste
      .sort((x, y) => y.waste - x.waste)
      .map((s) => ({
        sessionId: s.sessionId,
        turnIdx: s.seq ?? undefined,
        note: `${s.repo} · $${s.waste.toFixed(2)} premium · ${s.misses} cache miss${s.misses === 1 ? '' : 'es'}`,
      }))

    const waste = wasteUsd.toFixed(2)
    const sessionMissRate = sessionsWithMiss / sessions
    const repoLabel = qualifying.length === 1 ? qualifying[0]![0] : `${qualifying.length} repos`
    return {
      signalKey: 'cache-misses',
      repo: '*',
      severity: wasteUsd >= SEVERITY_USD.high ? 'high' : wasteUsd >= SEVERITY_USD.medium ? 'medium' : 'low',
      title: 'Frequent prompt cache misses',
      description:
        `Across ${sessions} sessions in ${repoLabel} in the last ${WINDOW_DAYS} days, ${pct(sessionMissRate)} of ` +
        `sessions saw a cache-miss event — an estimated $${waste} premium over warm-cache rates. ${breakMisses} ` +
        `of the ${misses} misses came from messages sent more than 5 minutes after the previous one.`,
      evidence,
      count: misses,
      firstSeenAt: firstMissTs ?? undefined,
      lastSeenAt: lastMissTs ?? undefined,
      fix: {
        type: 'behavioral-nudge',
        label: 'Reduce cache misses',
        content:
          `The usual culprits: idle breaks that outlive the provider's cache lifetime, and ` +
          `mid-stream changes to config or model — editing CLAUDE.md, toggling MCP servers, or switching ` +
          `models rewrites the cached prefix. Batch quick follow-ups while the cache is warm, and settle ` +
          `config and model choices before long working sessions.`,
      },
    }
}

registerDetector(cacheMiss)
