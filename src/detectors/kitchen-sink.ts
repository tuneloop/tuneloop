import { registerDetector } from '../core/registry'
import type { Detector, DetectorResult, InsightInput } from '../core/detector'
import type { Store } from '../store/store'
import type { LlmClient, StructuredRequest } from '../llm/types'
import { addUsage, emptyUsage, type TokenUsage } from '../core/model'
import type { Block } from '../core/blocks'
import { costOfUsage } from '../pricing/pricing'

const NAME = 'kitchen-sink'
const WINDOW_DAYS = 30
/** Only sessions at or above this percentile of user-turn count are large enough to check. */
const SIZE_PERCENTILE = 0.75
/**
 * Absolute floor on session size, independent of the per-repo percentile. Below
 * this a session fits an LLM context easily and is trivial to find, so splitting
 * it buys nothing worth nudging about — and it guards the degenerate small-repo
 * case where the percentile cutoff collapses onto a session's own turn count.
 */
const MIN_TURNS = 10
/** A repo needs at least this many in-window sessions before its percentile is meaningful. */
const MIN_SESSIONS = 10
const MIN_FEATURES = 2
const MIN_PRS = 2

/**
 * Real user-turn count per session: the number of times a human typed a new
 * instruction. A block opens on each real user turn, so this counts the opening
 * block (the +1) plus every block whose boundary_kind is 'user_turn' (each marks
 * the next block starting on a fresh human turn). Blocks that close on a commit
 * or PR are not human turns and are excluded, so this is smaller than the raw
 * block count. Scoped to sessions started on/after `since`. Sessions with no
 * blocks are absent from the map.
 *
 * The +1 assumes the opening block starts with a human message, which holds for
 * every session that opens on a user prompt; a session that opens on synthetic
 * text (a resumed-session preamble, a system message) over-counts by one, which
 * is acceptable for a size gate.
 */
export function realUserTurns(store: Store, since: string): Map<string, number> {
  const rows = store.queryAll(
    `SELECT b.session_id AS sessionId,
            1 + SUM(CASE WHEN b.boundary_kind = 'user_turn' THEN 1 ELSE 0 END) AS turns
     FROM blocks b JOIN sessions s ON s.id = b.session_id
     WHERE s.started_at >= ?
     GROUP BY b.session_id`,
    since,
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
 * absent (processors honor user_link_overrides before inserting). Scoped to
 * sessions started on/after `since`. Sessions with no feature/PR links are
 * absent from the map.
 */
export function artifactCounts(store: Store, since: string): Map<string, ArtifactCounts> {
  const rows = store.queryAll(
    `SELECT sa.session_id AS sessionId,
            COUNT(DISTINCT CASE WHEN a.kind = 'feature' THEN a.id END) AS features,
            COUNT(DISTINCT CASE WHEN a.kind = 'pr' THEN a.id END) AS prs
     FROM session_artifacts sa
     JOIN artifacts a ON a.id = sa.artifact_id
     JOIN sessions s ON s.id = sa.session_id
     WHERE a.kind IN ('feature', 'pr') AND s.started_at >= ?
     GROUP BY sa.session_id`,
    since,
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
  /** Session content hash at pre-gate time — recorded once the LLM has judged it. */
  contentHash: string
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
  // content_hash NOT NULL: a null hash can't be tracked in detector_session_runs
  // (its `!=` comparison never re-surfaces a null), so such a session would freeze
  // as permanently seen once judged. Skip it until it has a real hash.
  const repos = store.queryAll(
    `SELECT id AS sessionId,
            COALESCE(NULLIF(repo, ''), NULLIF(cwd, ''), '_unknown') AS repo,
            content_hash AS contentHash
     FROM sessions
     WHERE started_at >= ? AND content_hash IS NOT NULL`,
    since,
  ) as Array<{ sessionId: string; repo: string; contentHash: string }>

  const turns = realUserTurns(store, since)
  const arts = artifactCounts(store, since)

  // Per-repo cutoff: gather every in-window session's turn count by repo.
  const turnsByRepo = new Map<string, number[]>()
  for (const { sessionId, repo } of repos) {
    const t = turns.get(sessionId)
    if (t == null) continue
    const list = turnsByRepo.get(repo) ?? []
    list.push(t)
    turnsByRepo.set(repo, list)
  }
  // A repo's percentile is only meaningful with enough samples; below MIN_SESSIONS
  // it collapses onto individual turn counts, so skip it and lean on MIN_TURNS.
  const cutoffByRepo = new Map<string, number>()
  for (const [repo, list] of turnsByRepo) {
    if (list.length >= MIN_SESSIONS) cutoffByRepo.set(repo, sizeCutoff(list))
  }

  const out: Candidate[] = []
  for (const { sessionId, repo, contentHash } of repos) {
    const t = turns.get(sessionId)
    if (t == null) continue
    if (t < MIN_TURNS) continue // absolute floor: too small for splitting to matter
    const repoCutoff = cutoffByRepo.get(repo)
    if (repoCutoff != null && t < repoCutoff) continue // large for its repo, when measurable
    const a = arts.get(sessionId) ?? { features: 0, prs: 0 }
    if (a.features < MIN_FEATURES && a.prs < MIN_PRS) continue
    out.push({ sessionId, repo, turns: t, features: a.features, prs: a.prs, contentHash })
  }
  return out
}

/**
 * Candidates the LLM hasn't judged at their current content: the pre-gate set
 * minus sessions already recorded in detector_session_runs at the same content
 * hash (detectorUnseen returns new or content-changed sessions). Restricting to
 * this set keeps the P-tier LLM spend to new work on each analyze.
 */
export function unseenCandidates(store: Store): Candidate[] {
  const unseen = new Set(store.detectorUnseen(NAME).map((s) => s.sessionId))
  return candidates(store).filter((c) => unseen.has(c.sessionId))
}

const TOOL_NAME = 'record_kitchen_sink'

/** The forced-tool output the LLM returns for one session. */
export interface Verdict {
  /** True only when two or more blocks pursue genuinely unrelated objectives. */
  isKitchenSink: boolean
  /** Block index where the first unrelated objective begins; -1 when not a kitchen sink. */
  splitBlockIdx: number
  /** One sentence explaining the call. */
  reason: string
}

/**
 * The structured request judging one session: the block digest is the evidence,
 * and the forced tool's schema fixes the answer shape. The prompt tells the model
 * to answer no when unsure, since a wrong flag on coherent work trains users to
 * ignore the tab, so recall is traded for precision. It deliberately says nothing
 * about how the session was selected, so the model judges the digest on its own
 * merits rather than being anchored toward a positive verdict.
 */
export function buildRequest(digest: string, nBlocks: number): StructuredRequest {
  const system =
    'You judge whether a single AI coding session pursued several UNRELATED objectives ' +
    'that should have been split into separate sessions (a "kitchen-sink" session). ' +
    `Report your judgment by calling the ${TOOL_NAME} tool.`

  const user = [
    `Blocks: the session split into ${nBlocks} contiguous slice(s), one line each: block index,`,
    'opening user turn, a compact action summary, and how the block ended.',
    digest,
    '',
    'Set isKitchenSink=true ONLY when two or more blocks pursue goals that do not share',
    'a task, feature, or bug. Examples of UNRELATED objectives in one session:',
    '  - fixing a flaky auth test, then adding a CSV export button to an unrelated report',
    '  - upgrading a CI workflow, then refactoring the pricing calculator',
    '  - writing docs for the API, then debugging a memory leak in the video encoder',
    '',
    'Work that forms ONE coherent thread is NOT a kitchen sink, even when it touches many',
    'files or opens several PRs. Examples of coherent work to leave alone:',
    '  - building a feature and writing its tests, then fixing the bugs those tests found',
    '  - a rename or refactor that ripples across many files and modules',
    '  - splitting one large change into several stacked PRs',
    '  - follow-up requests that refine, debug, or extend the same task already underway',
    '',
    'When unsure, answer false: a wrong flag on coherent work is worse than a miss.',
    `When true, set splitBlockIdx to the block index (0..${Math.max(0, nBlocks - 1)}) where the`,
    'FIRST unrelated objective begins; otherwise set it to -1.',
  ].join('\n')

  return {
    system,
    user,
    toolName: TOOL_NAME,
    maxTokens: 512,
    schema: {
      type: 'object',
      required: ['isKitchenSink', 'splitBlockIdx', 'reason'],
      properties: {
        isKitchenSink: { type: 'boolean', description: 'True only when 2+ blocks pursue unrelated objectives.' },
        splitBlockIdx: { type: 'integer', description: 'Block index where the first unrelated objective begins; -1 if not a kitchen sink.' },
        reason: { type: 'string', description: 'One sentence explaining the judgment.' },
      },
    },
  }
}

/**
 * Ask the LLM to judge one session from its block digest and partition. Reads the
 * forced-tool output defensively: a non-boolean or missing isKitchenSink is
 * treated as not a kitchen sink, and a positive verdict with an out-of-range or
 * missing splitBlockIdx is demoted to false rather than emitting an insight that
 * points nowhere. The range is checked against `blocks.length` — the same
 * partition the digest was rendered from. Returns { verdict, usage }.
 */
export async function judge(llm: LlmClient, digest: string, blocks: Block[]): Promise<{ verdict: Verdict; usage: TokenUsage }> {
  const n = blocks.length
  const { data, usage } = await llm.completeStructured(buildRequest(digest, n))

  const isKitchenSink = data.isKitchenSink === true
  const rawIdx = typeof data.splitBlockIdx === 'number' ? Math.trunc(data.splitBlockIdx) : -1
  const inRange = rawIdx >= 0 && rawIdx < n
  const reason = typeof data.reason === 'string' ? data.reason : ''

  // A positive verdict with no valid split point can't produce an actionable
  // nudge, so demote it to not-a-kitchen-sink.
  const confirmed = isKitchenSink && inRange
  return {
    verdict: {
      isKitchenSink: confirmed,
      splitBlockIdx: confirmed ? rawIdx : -1,
      reason,
    },
    usage,
  }
}

/**
 * Turn a confirmed verdict into one insight. The evidence points at the split
 * block's opening seq (read from the same partition the LLM judged, so the index
 * always resolves) so the viewer opens where the session should have been split.
 * Severity rises with the breadth of the pre-gate signal: a session that spanned
 * more distinct features/PRs is a clearer kitchen sink. The description and fix
 * are framed around what the developer gains — a sharper agent and work that is
 * easy to find again — not internal cost attribution.
 */
export function toInsight(c: Candidate, verdict: Verdict, blocks: Block[]): InsightInput {
  const startSeq = blocks[verdict.splitBlockIdx]?.startSeq
  const jobs = Math.max(c.features, c.prs)
  const reason = verdict.reason.trim()
  return {
    signalKey: `kitchen-sink:${c.sessionId}`,
    repo: c.repo,
    severity: jobs >= 3 ? 'high' : 'medium',
    title: 'Session mixed unrelated work',
    description:
      `This session took on unrelated tasks in one sitting.${reason ? ` ${reason}` : ''} ` +
      `Carrying the earlier task's files and decisions into an unrelated one gives the agent a ` +
      `cluttered context, which invites off-target edits and vaguer answers. One session per task ` +
      `keeps the agent focused and makes each piece of work easy to find and pick back up later.`,
    evidence: [{ sessionId: c.sessionId, ...(startSeq != null ? { turnIdx: startSeq } : {}) }],
    count: jobs,
    fix: {
      type: 'behavioral-nudge',
      label: 'Split unrelated work',
      content:
        `When you switch to an unrelated task, start a new session instead of continuing this one, ` +
        `so the agent works from a clean context instead of dragging in the previous task. ` +
        `Here, block ${verdict.splitBlockIdx} began a separate objective, a natural point to have ` +
        `opened a fresh session.`,
    },
  }
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
 */
export const kitchenSink: Detector = {
  name: NAME,
  version: 1,
  tier: 'P',
  needsLlm: true,
  async run(ctx): Promise<DetectorResult> {
    if (!ctx.llm) return { insights: [] }
    const found = unseenCandidates(ctx.store)
    ctx.log.info(`kitchen-sink: ${found.length} unseen candidate session(s) after pre-gate`)

    const insights: InsightInput[] = []
    // Sessions actually judged, reported as `seen` so the runner marks them ONLY
    // after a successful persist; a candidate we couldn't load stays unseen to retry.
    const seen: Array<{ sessionId: string; contentHash: string }> = []
    let usage = emptyUsage()
    for (const c of found) {
      const digest = ctx.store.blockDigest(c.sessionId)
      if (!digest) continue
      const judged = await judge(ctx.llm, digest.digest, digest.blocks)
      usage = addUsage(usage, judged.usage)
      seen.push({ sessionId: c.sessionId, contentHash: c.contentHash })
      if (judged.verdict.isKitchenSink) insights.push(toInsight(c, judged.verdict, digest.blocks))
    }

    ctx.log.info(`kitchen-sink: flagged ${insights.length}/${found.length} candidate(s)`)
    const result: DetectorResult = { insights, seen }
    // Only record cost when the LLM actually ran, so a no-op analyze (nothing
    // unseen) doesn't write a $0 detector_runs row or price an empty usage.
    if (seen.length > 0) {
      result.cost = {
        inTokens: usage.input,
        outTokens: usage.output,
        usd: costOfUsage(ctx.llm.provider, ctx.llm.model, usage),
        // model is dropped by this branch's detector_runs write; it persists once
        // the recurring-themes PR (#84) adds the detector_runs.model column.
        model: ctx.llm.model,
      }
    }
    return result
  },
}

registerDetector(kitchenSink)
