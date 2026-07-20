import { registerDetector } from '../core/registry'
import type { Detector } from '../core/detector'
import type { Store } from '../store/store'

const WINDOW_DAYS = 30
/** Only sessions at or above this percentile of user-turn count are large enough to check. */
const SIZE_PERCENTILE = 0.75
const MIN_FEATURES = 2
const MIN_PRS = 2

/**
 * Real user-turn count per session: the number of times a human typed a new
 * instruction. A block opens on each real user turn, so this counts the opening
 * block (the +1) plus every block whose boundary_kind is 'user_turn' (each marks
 * the next block starting on a fresh human turn). Blocks that close on a commit
 * or PR are not human turns and are excluded, so this is smaller than the raw
 * block count. Sessions with no blocks are absent from the map.
 *
 * The +1 assumes the opening block starts with a human message, which holds for
 * every session that opens on a user prompt;
 */
export function realUserTurns(store: Store): Map<string, number> {
  const rows = store.queryAll(
    `SELECT session_id AS sessionId,
            1 + SUM(CASE WHEN boundary_kind = 'user_turn' THEN 1 ELSE 0 END) AS turns
     FROM blocks
     GROUP BY session_id`,
  ) as Array<{ sessionId: string; turns: number }>
  return new Map(rows.map((r) => [r.sessionId, r.turns]))
}

/** Distinct linked features and PRs per session — the "did several things" signal. */
export interface ArtifactCounts {
  features: number
  prs: number
}

/**
 * Count the distinct features and PRs each session is linked to. Reads
 * session_artifacts joined to artifacts by kind; rejected links are already
 * absent (processors honor user_link_overrides before inserting). Sessions with
 * no feature/PR links are absent from the map.
 */
export function artifactCounts(store: Store): Map<string, ArtifactCounts> {
  const rows = store.queryAll(
    `SELECT sa.session_id AS sessionId,
            COUNT(DISTINCT CASE WHEN a.kind = 'feature' THEN a.id END) AS features,
            COUNT(DISTINCT CASE WHEN a.kind = 'pr' THEN a.id END) AS prs
     FROM session_artifacts sa
     JOIN artifacts a ON a.id = sa.artifact_id
     WHERE a.kind IN ('feature', 'pr')
     GROUP BY sa.session_id`,
  ) as Array<{ sessionId: string; features: number; prs: number }>
  return new Map(rows.map((r) => [r.sessionId, { features: r.features, prs: r.prs }]))
}

/**
 * The size cutoff: the value at SIZE_PERCENTILE of the given turn counts, using
 * nearest-rank on the sorted values. A session at or above the cutoff is large
 * enough to check. Returns Infinity for empty input, so nothing qualifies when
 * there is no data to measure against.
 */
export function sizeCutoff(turnCounts: number[], percentile = SIZE_PERCENTILE): number {
  if (turnCounts.length === 0) return Infinity
  const sorted = [...turnCounts].sort((a, b) => a - b)
  // Nearest-rank: the smallest value whose position covers the percentile.
  const rank = Math.ceil(percentile * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]!
}

/** A session that cleared the pre-gate and is worth an LLM check. */
export interface Candidate {
  sessionId: string
  repo: string
  turns: number
  features: number
  prs: number
}

/**
 * The cheap pre-gate: sessions in the last WINDOW_DAYS that are BOTH large
 * (at/above their repo's SIZE_PERCENTILE of user-turn count) AND advanced 2+
 * distinct features or 2+ distinct PRs. The size cutoff is computed per repo, so
 * a repo of naturally long sessions doesn't crowd out a repo of short ones. A
 * session with no blocks (no turn count) can't clear the size gate and is skipped.
 */
export function candidates(store: Store): Candidate[] {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const repos = store.queryAll(
    `SELECT id AS sessionId,
            COALESCE(NULLIF(repo, ''), NULLIF(cwd, ''), '_unknown') AS repo
     FROM sessions
     WHERE started_at >= ?`,
    since,
  ) as Array<{ sessionId: string; repo: string }>

  const turns = realUserTurns(store)
  const arts = artifactCounts(store)

  // Per-repo cutoff: gather every in-window session's turn count by repo.
  const turnsByRepo = new Map<string, number[]>()
  for (const { sessionId, repo } of repos) {
    const t = turns.get(sessionId)
    if (t == null) continue
    const list = turnsByRepo.get(repo) ?? []
    list.push(t)
    turnsByRepo.set(repo, list)
  }
  const cutoffByRepo = new Map<string, number>()
  for (const [repo, list] of turnsByRepo) cutoffByRepo.set(repo, sizeCutoff(list))

  const out: Candidate[] = []
  for (const { sessionId, repo } of repos) {
    const t = turns.get(sessionId)
    if (t == null) continue
    if (t < (cutoffByRepo.get(repo) ?? Infinity)) continue
    const a = arts.get(sessionId) ?? { features: 0, prs: 0 }
    if (a.features < MIN_FEATURES && a.prs < MIN_PRS) continue
    out.push({ sessionId, repo, turns: t, features: a.features, prs: a.prs })
  }
  return out
}

/**
 * Flags kitchen-sink sessions: a single session that pursued several unrelated
 * objectives instead of being split into separate sessions.
 *
 * A cheap SQL pre-gate picks candidates — larger sessions (by real user-turn
 * count) that advanced two or more distinct features or PRs — and an LLM pass
 * confirms the objectives are genuinely unrelated and points at the block where
 * the session should have split. The nudge resolves as the flagged-session rate
 * falls.
 *
 * Skeleton only: run() returns no insights yet. The pre-gate and LLM pass land
 * in later steps.
 */
export const kitchenSink: Detector = {
  name: 'kitchen-sink',
  version: 1,
  tier: 'P',
  needsLlm: true,
  run(ctx) {
    const found = candidates(ctx.store)
    ctx.log.info(`kitchen-sink: ${found.length} candidate session(s) after pre-gate`)
    // LLM confirmation + insight emission land in later steps.
    return []
  },
}

registerDetector(kitchenSink)
