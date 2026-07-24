import { registerDetector } from '../core/registry'
import type { Detector, InsightInput } from '../core/detector'

/**
 * Flags repos where sessions run into the context window and get compacted.
 *
 * Compactions are OBSERVED, never inferred: on every assistant turn the provider
 * reports how full the context window was — input + cache_read + cache_create
 * (output is the reply, not part of the prompt, so it's excluded). That occupancy
 * only grows as a conversation appends turns; it can collapse sharply for exactly
 * one reason — the harness discarded context (auto-compaction, or a manual reset).
 * A large drop from a high prior turn is that event, made visible.
 *
 * The classification itself lives in SQL: the `compaction_event` view
 * (src/store/db.ts) is scanned GLOBALLY and this detector presents a recent WINDOW
 * over it (decision 1). The window keys off each compaction turn's OWN timestamp,
 * not its session's start (decision 7), so a card ages out when the compactions
 * stop — even for a long session that began before the window but is still active.
 *
 * The detector makes no causal claim about outcomes. Whether a compacted session
 * "went worse" needs a bigger corpus than a single developer has; here we surface
 * the pattern with receipts (peak occupancy, how many times it compacted) and a
 * behavioral nudge. The loop metric — compaction frequency — is observational:
 * re-running analyze recomputes it, so adoption shows up as a downward trend.
 */

const WINDOW_DAYS = 30
const MIN_SESSIONS = 10 // per repo in the window — fewer and the pattern is anecdote, not signal
const MIN_COMPACTED_SESSIONS = 1 // surface a repo once any session compacted (gated by MIN_SESSIONS corpus)
// Severity by how entrenched the pattern is (share of the repo's sessions that compacted).
const SEVERITY_SHARE = { high: 0.3, medium: 0.1 }

// One row per repo from usage_turns — the active-session denominator behind `share`.
interface ActiveAgg {
  repo: string
  sessions: number
}

// One row per compaction event from compaction_event, carrying its session's peak
// occupancy (an aggregate over usage_turns — decision: peak is a session property,
// not part of the event view).
interface CompactionRow {
  sessionId: string
  repo: string
  ts: string | null
  peak: number
}

interface SessionResult {
  sessionId: string
  repo: string
  compactions: number
  peak: number
}

interface RepoAgg {
  sessions: number // main-thread sessions active in the window (the share denominator)
  compactedSessions: Map<string, SessionResult>
  totalCompactions: number
  firstCompactionTs: string | null // earliest/latest compaction time — the real occurrence window
  lastCompactionTs: string | null
}

export const contextExhaustion: Detector = {
  name: 'context-exhaustion',
  version: 1,
  tier: 'S',
  run(ctx) {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

    // Denominator: distinct main-thread sessions active in the window, per repo. The
    // views scan globally; `ts >= since` is the read-time window on each turn's own
    // timestamp (decisions 1 + 7). A subagent (sidechain) has its own context window
    // and its own compaction story, so it's excluded here and in the event view.
    const activeRows = ctx.store.queryAll(
      `SELECT repo, COUNT(DISTINCT session_id) AS sessions
       FROM usage_turns
       WHERE is_sidechain = 0 AND ts >= ?
       GROUP BY repo`,
      since,
    ) as ActiveAgg[]

    // Numerator: the compaction events in the window, each carrying its session's peak
    // occupancy — MAX(occupancy) over the session's main-thread turns, a session
    // property the event view doesn't hold (used only in the evidence note).
    const compactionRows = ctx.store.queryAll(
      `SELECT ce.session_id AS sessionId, ce.repo, ce.ts, pk.peak
       FROM compaction_event ce
       JOIN (SELECT session_id, MAX(occupancy) AS peak
             FROM usage_turns WHERE is_sidechain = 0 GROUP BY session_id) pk
         ON pk.session_id = ce.session_id
       WHERE ce.ts >= ?`,
      since,
    ) as CompactionRow[]

    const repos = new Map<string, RepoAgg>()
    for (const a of activeRows) {
      repos.set(a.repo, { sessions: a.sessions, compactedSessions: new Map(), totalCompactions: 0, firstCompactionTs: null, lastCompactionTs: null })
    }

    for (const c of compactionRows) {
      // Every compaction turn is also an active turn, so its repo is always present.
      const agg = repos.get(c.repo)
      if (!agg) continue
      agg.totalCompactions++
      const s = agg.compactedSessions.get(c.sessionId) ?? { sessionId: c.sessionId, repo: c.repo, compactions: 0, peak: c.peak }
      s.compactions++
      agg.compactedSessions.set(c.sessionId, s)
      // Widen the repo's compaction window with this event's real time (skip null ts).
      if (c.ts) {
        if (agg.firstCompactionTs === null || c.ts < agg.firstCompactionTs) agg.firstCompactionTs = c.ts
        if (agg.lastCompactionTs === null || c.ts > agg.lastCompactionTs) agg.lastCompactionTs = c.ts
      }
    }

    // Qualifying repos (each gated on its own corpus + a compacted session), then fold
    // into ONE cross-repo insight. Per-repo detail survives as each evidence session's note.
    const qualifying = [...repos.entries()].filter(
      ([, a]) => a.sessions >= MIN_SESSIONS && a.compactedSessions.size >= MIN_COMPACTED_SESSIONS,
    )
    if (qualifying.length === 0) {
      // No qualifying compaction this window — resolve any prior card so a stale claim
      // doesn't freeze on the dashboard (the N4 fix, applied at the empty path).
      ctx.store.resolveInsight('context-exhaustion', '*', 'context-exhaustion')
      return []
    }

    let sessions = 0
    let compactedCount = 0
    let totalCompactions = 0
    let firstCompactionTs: string | null = null
    let lastCompactionTs: string | null = null
    const compacted: SessionResult[] = []
    for (const [, a] of qualifying) {
      sessions += a.sessions
      compactedCount += a.compactedSessions.size
      totalCompactions += a.totalCompactions
      if (a.firstCompactionTs && (firstCompactionTs === null || a.firstCompactionTs < firstCompactionTs)) firstCompactionTs = a.firstCompactionTs
      if (a.lastCompactionTs && (lastCompactionTs === null || a.lastCompactionTs > lastCompactionTs)) lastCompactionTs = a.lastCompactionTs
      compacted.push(...a.compactedSessions.values())
    }

    const share = compactedCount / sessions
    // Worst offenders first — most compactions, then highest peak — for evidence + the receipt.
    const worst = compacted.sort((x, y) => y.compactions - x.compactions || y.peak - x.peak)
    const top = worst[0]!
    const repoLabel = qualifying.length === 1 ? qualifying[0]![0] : `${qualifying.length} repos`

    return [{
      signalKey: 'context-exhaustion',
      repo: '*',
      severity: share >= SEVERITY_SHARE.high ? 'high' : share >= SEVERITY_SHARE.medium ? 'medium' : 'low',
      title: `${compactedCount} session${compactedCount === 1 ? '' : 's'} grew large enough to trigger compaction`,
      description:
        `In the last ${WINDOW_DAYS} days, ${compactedCount} of ${sessions} sessions in ${repoLabel} grew ` +
        `large enough to trigger context compaction (${totalCompactions} event` +
        `${totalCompactions === 1 ? '' : 's'} total). Compaction summarizes and discards earlier ` +
        `context — the agent loses the thread of earlier work, which tends to show up ` +
        `as repeated exploration or dropped requirements. The worst session compacted ${top.compactions} ` +
        `time${top.compactions === 1 ? '' : 's'}, peaking near ${Math.round(top.peak / 1000)}K tokens.`,
      // Each row notes its repo + compaction count — the per-repo detail the single row would lose.
      evidence: worst.map((s) => ({
        sessionId: s.sessionId,
        note: `${s.repo} · ${s.compactions} compaction${s.compactions === 1 ? '' : 's'}, peak ${Math.round(s.peak / 1000)}K`,
      })),
      count: compactedCount,
      firstSeenAt: firstCompactionTs ?? undefined,
      lastSeenAt: lastCompactionTs ?? undefined,
      fix: {
        type: 'behavioral-nudge',
        label: 'Avoid context exhaustion',
        content:
          `A session that fills the context window gets compacted: the harness summarizes the ` +
          `conversation to fit, and detail from earlier turns is lost. To keep sessions under the limit:\n` +
          `• Split large tasks into scoped sessions — finish and start fresh at natural breakpoints ` +
          `instead of carrying one session across many unrelated steps.\n` +
          `• Push investigation into subagents (the Task tool): exploring a codebase, reading many ` +
          `files, or running searches in a subagent keeps that bulk out of the main thread's context.\n` +
          `• Watch for the tell — a session that compacts more than once is doing too much in one place.`,
      },
    }]
  },
}

registerDetector(contextExhaustion)
