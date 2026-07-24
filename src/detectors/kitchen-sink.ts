import { registerDetector } from '../core/registry'
import type { Detector, DetectorResult, EvidenceRef, InsightInput } from '../core/detector'
import type { Store } from '../store/store'
import type { KitchenSinkVerdictInput } from '../store/types'
import type { LlmClient, StructuredRequest } from '../llm/types'
import { addUsage, emptyUsage, type TokenUsage } from '../core/model'
import type { Block } from '../core/blocks'
import { costOfUsage } from '../pricing/pricing'

const NAME = 'kitchen-sink'
/**
 * v3: verdicts moved out of insight_evidence into their own `kitchen_sink_verdict`
 * table, candidate selection went global, and the card is windowed at read time.
 * The bump re-judges the whole corpus once to backfill the verdict table (a P-tier
 * one-time cost — cap it with `--limit`; see run()).
 */
const VERSION = 3
/** The card's presentation window: count/evidence/severity cover this trailing span. */
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
// The single aggregate insight's identity. repo '*' because the pattern spans repos.
const AGG_REPO = '*'
const AGG_SIGNAL = 'kitchen-sink'
/** At/above this many flagged sessions the aggregate is high severity; below it, medium. */
const SEVERITY_HIGH_SESSIONS = 3

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
  /** When the session ran — the insight's real first/last-seen (else the run time). */
  startedAt: string | null
  endedAt: string | null
}

/**
 * The size/artifact `since` bound. `''` sorts below every ISO timestamp, so the
 * pre-gate scans ALL history (decision 1): every historical candidate is judged
 * once and its verdict cached, and the 30-day window is applied at READ time when
 * the card is built (see run()), not here. Sessions with a NULL started_at are
 * excluded either way (`NULL >= ''` is NULL) — they can't be windowed on the card.
 */
const ALL_TIME = ''

/**
 * The cheap pre-gate: sessions (of any age) that are BOTH large (at/above their
 * repo's SIZE_PERCENTILE of user-turn count) AND advanced 2+ distinct features or
 * 2+ distinct PRs. The size cutoff is computed per repo, so a repo of naturally
 * long sessions doesn't crowd out a repo of short ones. A session with no blocks
 * (no turn count) can't clear the size gate and is skipped. Selection is GLOBAL:
 * the window that shapes the card is a read-time predicate, not a scan boundary.
 */
export function candidates(store: Store): Candidate[] {
  // content_hash NOT NULL: a null hash can't be tracked in detector_session_runs
  // (its `!=` comparison never re-surfaces a null), so such a session would freeze
  // as permanently seen once judged. Skip it until it has a real hash. started_at
  // NOT NULL so it can be placed in the read-time window.
  const repos = store.queryAll(
    `SELECT id AS sessionId,
            COALESCE(NULLIF(repo, ''), NULLIF(cwd, ''), '_unknown') AS repo,
            content_hash AS contentHash,
            started_at AS startedAt,
            ended_at AS endedAt
     FROM sessions
     WHERE content_hash IS NOT NULL AND started_at IS NOT NULL`,
  ) as Array<{ sessionId: string; repo: string; contentHash: string; startedAt: string | null; endedAt: string | null }>

  const turns = realUserTurns(store, ALL_TIME)
  const arts = artifactCounts(store, ALL_TIME)

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
  for (const { sessionId, repo, contentHash, startedAt, endedAt } of repos) {
    const t = turns.get(sessionId)
    if (t == null) continue
    if (t < MIN_TURNS) continue // absolute floor: too small for splitting to matter
    const repoCutoff = cutoffByRepo.get(repo)
    if (repoCutoff != null && t < repoCutoff) continue // large for its repo, when measurable
    const a = arts.get(sessionId) ?? { features: 0, prs: 0 }
    if (a.features < MIN_FEATURES && a.prs < MIN_PRS) continue
    out.push({ sessionId, repo, turns: t, features: a.features, prs: a.prs, contentHash, startedAt, endedAt })
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
    `When true, set splitBlockIdx to the block index (1..${Math.max(1, nBlocks - 1)}) where the`,
    'FIRST unrelated objective begins — the block that should have opened a new session.',
    'It is never 0 (block 0 opens the first objective). Otherwise set it to -1.',
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
        splitBlockIdx: { type: 'integer', description: 'Block index (>= 1) where the first unrelated objective begins; -1 if not a kitchen sink.' },
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
 * points nowhere. A valid split point is 1..blocks.length-1 (block 0 opens the
 * first objective, so it can never be where the second one begins), checked
 * against the same partition the digest was rendered from. Returns { verdict, usage }.
 */
export async function judge(llm: LlmClient, digest: string, blocks: Block[]): Promise<{ verdict: Verdict; usage: TokenUsage }> {
  const n = blocks.length
  const { data, usage } = await llm.completeStructured(buildRequest(digest, n))

  const isKitchenSink = data.isKitchenSink === true
  const rawIdx = typeof data.splitBlockIdx === 'number' ? Math.trunc(data.splitBlockIdx) : -1
  // The split point is where the SECOND (first unrelated) objective begins, so it
  // is always >= 1: block 0 opens the first objective and has nothing before it to
  // split off. Reject 0 (and negatives) as no valid split point.
  const inRange = rawIdx >= 1 && rawIdx < n
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

/** The per-occurrence note shown for a flagged session: which block broke off, and why. */
function noteFor(splitBlockIdx: number, reason: string): string {
  const r = reason.trim()
  return `Block ${splitBlockIdx} began a separate objective${r ? ` — ${r}` : ''}`
}

/**
 * Turn one judged session into the row persisted in `kitchen_sink_verdict` — the
 * verdict's permanent home (positive OR negative), resolving the split block to its
 * opening main-thread seq now (at judge time, while we hold `blocks`) so the read
 * path can rebuild evidence without re-hydrating. `model`/`detectorVersion` are
 * stamped by the caller. A negative verdict carries no split point or seq.
 */
export function verdictRow(c: Candidate, verdict: Verdict, blocks: Block[]): Omit<KitchenSinkVerdictInput, 'model' | 'detectorVersion'> {
  const reason = verdict.reason.trim() || null
  if (!verdict.isKitchenSink) {
    return { sessionId: c.sessionId, isKitchenSink: false, splitBlockIdx: null, splitSeq: null, reason }
  }
  return {
    sessionId: c.sessionId,
    isKitchenSink: true,
    splitBlockIdx: verdict.splitBlockIdx,
    splitSeq: blocks[verdict.splitBlockIdx]?.startSeq ?? null,
    reason,
  }
}

/**
 * Rebuild one card occurrence from a stored positive verdict row. `turnIdx` is the
 * split block's opening seq (so the drawer opens where the session should have
 * split); the note is derived from the block index + reason, same wording as when
 * it was judged.
 */
export function positiveEvidence(row: { sessionId: string; splitBlockIdx: number | null; splitSeq: number | null; reason: string | null }): EvidenceRef {
  const note = noteFor(row.splitBlockIdx ?? 0, row.reason ?? '')
  return { sessionId: row.sessionId, ...(row.splitSeq != null ? { turnIdx: row.splitSeq } : {}), note }
}

/**
 * Build the single cross-repo insight from every flagged session's evidence. Count and
 * severity track the flagged-session tally (a recurring habit, not one session's
 * breadth); first/last-seen are sourced by the caller. Null when nothing is flagged.
 */
export function buildAggregate(evidence: EvidenceRef[], firstSeenAt?: string, lastSeenAt?: string): InsightInput | null {
  const n = evidence.length
  if (n === 0) return null
  return {
    signalKey: AGG_SIGNAL,
    repo: AGG_REPO,
    severity: n >= SEVERITY_HIGH_SESSIONS ? 'high' : 'medium',
    title: `${n} session${n === 1 ? '' : 's'} mixed unrelated work`,
    description:
      `${n} session${n === 1 ? '' : 's'} took on unrelated tasks in one sitting. ` +
      `Carrying an earlier task's files and decisions into an unrelated one gives the agent a ` +
      `cluttered context, which invites off-target edits and vaguer answers. One session per task ` +
      `keeps the agent focused and makes each piece of work easy to find and pick back up later. ` +
      `Open an occurrence below to see where each session should have split.`,
    evidence,
    count: n,
    firstSeenAt,
    lastSeenAt,
    fix: {
      type: 'behavioral-nudge',
      label: 'Split unrelated work',
      content:
        `When you switch to an unrelated task, start a new session instead of continuing the current ` +
        `one, so the agent works from a clean context instead of dragging in the previous task. ` +
        `Each occurrence below points at the block where that session began a separate objective — ` +
        `a natural place to have opened a fresh session.`,
    },
  }
}

/**
 * Flags sessions that pursued several unrelated objectives instead of being split.
 * A cheap SQL pre-gate picks candidates (large sessions spanning 2+ features/PRs)
 * globally, an LLM confirms they're genuinely unrelated, and each verdict is cached
 * in `kitchen_sink_verdict`. Surfaces ONE cross-repo insight built each run as a
 * windowed projection of that table (the last WINDOW_DAYS of positives): count,
 * evidence and severity track only the window, so a flagged session ages off the
 * card on its own, and the insight resolves when the window empties (the N4/N6 fix).
 * Judging is incremental — only the unseen delta is judged — and, being a property
 * of immutable session content, a verdict never goes stale.
 */
export const kitchenSink: Detector = {
  name: NAME,
  version: VERSION,
  tier: 'P',
  needsLlm: true,
  async run(ctx): Promise<DetectorResult> {
    if (!ctx.llm) return { insights: [] }
    let found = unseenCandidates(ctx.store)
    // W6: --limit caps how many candidates this run judges. The first global run
    // backfills every historical candidate with an LLM, which can be large; the cap
    // lets a user throttle (or dry-run) it. Safe because each verdict is cached and
    // the card is rebuilt from the table, so the rest are picked up on later analyzes.
    if (ctx.limit != null && found.length > ctx.limit) found = found.slice(0, ctx.limit)
    ctx.log.info(`kitchen-sink: ${found.length} unseen candidate session(s) after pre-gate`)
    ctx.progress?.addUnits(found.length) // declare this detector's step-2 delta

    // This run's verdicts (positive AND negative), persisted below before the card
    // is rebuilt. Sessions actually judged are reported as `seen` so the runner marks
    // them ONLY after a successful persist; a candidate we couldn't load/judge stays
    // unseen to retry.
    const verdicts: KitchenSinkVerdictInput[] = []
    const seen: Array<{ sessionId: string; contentHash: string }> = []
    let usage = emptyUsage()
    for (const c of found) {
      const digest = ctx.store.blockDigest(c.sessionId)
      if (!digest) {
        ctx.progress?.unitDone(0) // unit consumed (no digest → skipped), keep the bar's total honest
        continue
      }
      let judged
      try {
        judged = await judge(ctx.llm, digest.digest, digest.blocks)
      } catch (err) {
        // One candidate failing must not discard the verdicts this run already paid
        // for: throwing here loses every judgment, every `seen` mark, and the whole
        // run's accumulated usage — so the next analyze re-judges and re-pays for all
        // of them. Skip it instead; unseen means it's retried next run anyway. Same
        // per-unit convention as recurring-themes' extraction loop.
        ctx.log.warn(`kitchen-sink: judge failed for ${c.sessionId}: ${(err as Error).message}`)
        ctx.progress?.unitDone(0) // unit consumed (judged nothing), keep the bar's total honest
        continue
      }
      usage = addUsage(usage, judged.usage)
      seen.push({ sessionId: c.sessionId, contentHash: c.contentHash })
      verdicts.push({ ...verdictRow(c, judged.verdict, digest.blocks), model: ctx.llm.model, detectorVersion: VERSION })
      // Tick the step-2 bar with this candidate's incremental judge spend.
      ctx.progress?.unitDone(costOfUsage(ctx.llm.provider, ctx.llm.model, judged.usage))
    }

    // Persist this run's verdicts BEFORE rebuilding the card, so the read below sees
    // them. A positive re-judged negative flips its row and drops out of the window.
    ctx.store.recordKitchenSinkVerdicts(verdicts)

    // Rebuild the aggregate from the verdict table, windowed to the last WINDOW_DAYS
    // of sessions.started_at. This runs EVERY analyze regardless of what was judged,
    // so a positive that ages out of the window drops off the card without being
    // re-judged, and the insight resolves the moment the window empties.
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
    const card = ctx.store.kitchenSinkPositives(windowStart)
    const evidence = card.positives.map(positiveEvidence)
    const insight = buildAggregate(evidence, card.firstSeenAt ?? undefined, card.lastSeenAt ?? undefined)
    // Empty window → resolve, but distinguish "clean now" from "not enough data" (W7):
    // only resolve when the user was actually active in the window. A window empty
    // because they were away (no sessions) is thin data, not a fixed habit — leave the
    // card rather than tell a returning user they cleaned it up.
    if (!insight) {
      const active = (ctx.store.queryOne('SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?', windowStart) as { n: number }).n > 0
      if (active) ctx.store.resolveInsight(NAME, AGG_REPO, AGG_SIGNAL)
    }

    ctx.log.info(`kitchen-sink: ${evidence.length} flagged session(s) in the last ${WINDOW_DAYS} days`)
    const result: DetectorResult = { insights: insight ? [insight] : [], seen }
    // Only record cost when the LLM actually ran, so a no-op analyze (nothing
    // unseen) doesn't write a $0 detector_runs row or price an empty usage.
    if (seen.length > 0) {
      result.cost = {
        inTokens: usage.input,
        outTokens: usage.output,
        usd: costOfUsage(ctx.llm.provider, ctx.llm.model, usage),
        model: ctx.llm.model,
      }
    }
    return result
  },
}

registerDetector(kitchenSink)
