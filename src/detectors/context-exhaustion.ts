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
 * The detector makes no causal claim about outcomes. Whether a compacted session
 * "went worse" needs a bigger corpus than a single developer has; here we surface
 * the pattern with receipts (peak occupancy, how many times it compacted) and a
 * behavioral nudge. The loop metric — compaction frequency — is observational:
 * re-running analyze recomputes it, so adoption shows up as a downward trend.
 */

const WINDOW_DAYS = 30
const MIN_SESSIONS = 10 // per repo in the window — fewer and the pattern is anecdote, not signal
// A compaction is a turn where occupancy drops >60% (occ <= 0.4 × prev) from a
// prior turn of at least PEAK_FLOOR tokens. Occupancy is the whole prompt and a
// conversation is append-only, so it only grows turn to turn; a drop this large
// means content left the prompt — a removal event (auto-compaction, or a manual
// /compact//clear, which is counted the same). The floor is a small-session noise
// gate; both thresholds are absolute, applied uniformly across models and harnesses.
const DROP_SHARE = 0.4 // occupancy must fall to at most 40% of the previous turn's (a >60% drop)
const PEAK_FLOOR = 100_000 // ...from a turn at least this large
const MIN_COMPACTED_SESSIONS = 1 // surface a repo once any session compacted (gated by MIN_SESSIONS corpus)
// Severity by how entrenched the pattern is (share of the repo's sessions that compacted).
const SEVERITY_SHARE = { high: 0.3, medium: 0.1 }

interface FactRow {
  sessionId: string
  repo: string
  input: number
  output: number
  creates: number
  reads: number
}

interface SessionResult {
  sessionId: string
  repo: string
  compactions: number
  peak: number
}

interface RepoAgg {
  sessions: number // sessions in the window that ran (contributed turns)
  compactedSessions: SessionResult[]
  totalCompactions: number
}

export const contextExhaustion: Detector = {
  name: 'context-exhaustion',
  version: 1,
  tier: 'S',
  run(ctx) {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
    // Main thread only — a subagent (sidechain) has its own context window and its
    // own compaction story; folding it into the parent's occupancy is meaningless.
    const rows = ctx.store.queryAll(
      `SELECT u.session_id AS sessionId,
              COALESCE(NULLIF(s.repo, ''), NULLIF(s.cwd, ''), '_unknown') AS repo,
              COALESCE(u.tok_input, 0) AS input,
              COALESCE(u.tok_output, 0) AS output,
              -- Cache-write total = both TTL buckets (disjoint; see the 5m/1h split).
              -- We only care about occupancy, so the TTL distinction is irrelevant —
              -- summing reconstructs the whole write.
              COALESCE(u.tok_cache_create_5m, 0) + COALESCE(u.tok_cache_create_1h, 0) AS creates,
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
      const repo = facts[0]!.repo
      let agg = repos.get(repo)
      if (!agg) {
        agg = { sessions: 0, compactedSessions: [], totalCompactions: 0 }
        repos.set(repo, agg)
      }

      let compactions = 0
      let peak = 0
      let prevOcc = 0
      let contributed = false
      for (const f of facts) {
        // Skip all-zero rows (content flushes, ingest-deduped repeat lines) — they'd
        // read as occupancy 0 and fake a massive drop.
        if (f.input + f.output + f.creates + f.reads === 0) continue
        contributed = true
        const occ = f.input + f.reads + f.creates
        if (prevOcc >= PEAK_FLOOR && occ <= prevOcc * DROP_SHARE) compactions++
        if (occ > peak) peak = occ
        prevOcc = occ
      }

      if (!contributed) continue
      agg.sessions++
      if (compactions > 0) {
        agg.compactedSessions.push({ sessionId: facts[0]!.sessionId, repo, compactions, peak })
        agg.totalCompactions += compactions
      }
    }

    const insights: InsightInput[] = []
    for (const [repo, a] of repos) {
      if (a.sessions < MIN_SESSIONS) continue
      if (a.compactedSessions.length < MIN_COMPACTED_SESSIONS) continue

      const share = a.compactedSessions.length / a.sessions
      // Worst offenders first — most compactions, then highest peak — for evidence + the receipt.
      const worst = [...a.compactedSessions].sort(
        (x, y) => y.compactions - x.compactions || y.peak - x.peak,
      )
      const top = worst[0]!
      const nSessions = a.compactedSessions.length

      insights.push({
        signalKey: 'context-exhaustion',
        repo,
        severity: share >= SEVERITY_SHARE.high ? 'high' : share >= SEVERITY_SHARE.medium ? 'medium' : 'low',
        title: `${nSessions} session${nSessions === 1 ? '' : 's'} hit the context limit and compacted`,
        description:
          `In the last ${WINDOW_DAYS} days, ${nSessions} of ${a.sessions} sessions in this repo ran the ` +
          `context window up to the limit and were auto-compacted (${a.totalCompactions} compaction` +
          `${a.totalCompactions === 1 ? '' : 's'} total). Compaction summarizes and discards earlier ` +
          `context — the agent loses the thread of work it did before the reset, which tends to show up ` +
          `as repeated exploration or dropped requirements. The worst session compacted ${top.compactions} ` +
          `time${top.compactions === 1 ? '' : 's'}, peaking near ${Math.round(top.peak / 1000)}K tokens of context.`,
        evidence: worst.slice(0, 10).map((s) => ({ sessionId: s.sessionId })),
        count: nSessions,
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
      })
    }
    return insights
  },
}

registerDetector(contextExhaustion)
