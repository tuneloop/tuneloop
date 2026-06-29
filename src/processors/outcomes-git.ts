import { registerProcessor } from '../core/registry'
import { attributeBlocksToPrs, blockMembership, deterministicBlocks } from '../core/blocks'
import type { Processor, RefreshContext, RefreshResult } from '../core/processor'
import type { ArtifactInput, OutcomeInput, SessionArtifactInput, BlockArtifactInput } from '../store/types'
import { enrichPrArtifact, parsePrRefs, prArtifactBase, stripInertRegions } from './github-pr'
import type { PrVerdict } from './github-pr'

// Re-exported so existing tests (and any importer) keep their import path stable.
export { stripInertRegions } from './github-pr'

/**
 * Static + network extractor: detect commits and PRs from the transcript, then
 * query `gh` for live PR status (degrades gracefully when offline / gh missing).
 * A commit with no resolvable SHA yields a session-level `commit_pushed` outcome
 * with no artifact — the nullable-artifact case from the data model.
 *
 * Also detects EXPLICIT reviews (Layer 1): a `gh pr review` / GitHub MCP review
 * tool is a deterministic "this session reviewed PR X" — linked here as
 * `reviewed` (source='explicit', confidence 1.0) with a verdict outcome. (The
 * softer, LLM-derived Layer 2 lives in `enrich-session`; it defers to this one.)
 * PRs a session only READ — without an explicit review — are still left to Layer 2.
 */
export const outcomesGit: Processor = {
  name: 'outcomes-git',
  version: 4,
  kind: 'static',
  needs: { network: true },
  requires: ['segment-blocks'],
  async run(ctx) {
    const { session, sh } = ctx
    const cwd = session.project.cwd
    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const outcomes: OutcomeInput[] = []

    // A commit with no resolvable SHA: a session-level outcome with no artifact.
    let committed = false
    for (const t of session.toolCalls) {
      if (t.action === 'shell' && typeof t.target.command === 'string') {
        // Match the executable skeleton so fixture/doc text isn't counted.
        if (/\bgit\b[^\n]*\bcommit\b/.test(stripInertRegions(t.target.command))) {
          committed = true
          break
        }
      }
    }
    if (committed) outcomes.push({ type: 'commit_pushed', artifactId: null, ts: session.endedAt })

    // Only attribute PRs this session actually created/merged — NOT ones it merely
    // read (those are handled, gated on the review use-case, by enrich-session).
    const refs = parsePrRefs(session)
    const mutating = refs.filter((r) => r.kind === 'create' || r.kind === 'merge')
    const byId = new Map<string, (typeof mutating)[number]>()
    for (const r of mutating) if (!byId.has(r.id)) byId.set(r.id, r)

    for (const ref of byId.values()) {
      const art = await enrichPrArtifact(sh, prArtifactBase(ref), cwd)
      artifacts.push(art)
      sessionArtifacts.push({ artifactId: ref.id, role: 'created', source: 'explicit' })
      outcomes.push({ type: 'pr_created', artifactId: ref.id, ts: session.endedAt })
      if (art.status === 'merged' || art.completedAt) {
        outcomes.push({ type: 'pr_merged', artifactId: ref.id, ts: art.completedAt })
      }
    }

    // Block→PR: map each PR's create/merge call to its (closing) block, then
    // attribute every block to the next PR it fed into — the full cost of
    // producing the PR, including the commit-bounded blocks leading up to it.
    const blocks = deterministicBlocks(session)
    const tool = blocks.length ? blockMembership(session, blocks).tool : []
    const blockArtifacts: BlockArtifactInput[] = []
    if (blocks.length && mutating.length) {
      const closingBlockToArtifact = new Map<number, string>()
      for (const ref of mutating) {
        const blockIdx = tool[ref.toolIndex]
        if (blockIdx != null) closingBlockToArtifact.set(blockIdx, ref.id)
      }
      for (const { blockIdx, artifactId } of attributeBlocksToPrs(blocks, closingBlockToArtifact)) {
        blockArtifacts.push({ blockIdx, artifactId, role: 'contributed', source: 'explicit' })
      }
    }

    // Layer 1 — EXPLICIT reviews (`gh pr review` / MCP review tool). Deterministic,
    // so the link is source='explicit', confidence 1.0. Self-created PRs are excluded
    // (you don't "review" your own PR here). Cost attributes at block grain to the
    // blocks where this PR was reviewed or read — "cost to review PR X", not the
    // whole session. enrich-session's derived Layer 2 skips any PR linked here.
    const mutatingIds = new Set(mutating.map((r) => r.id))
    const reviewed = new Map<string, { ref: (typeof refs)[number]; verdict?: PrVerdict }>()
    for (const r of refs) {
      if (r.kind !== 'review' || mutatingIds.has(r.id)) continue
      const prev = reviewed.get(r.id)
      // Keep a decisive verdict (approved / changes_requested) over a bare comment.
      if (!prev || (rankVerdict(r.verdict) > rankVerdict(prev.verdict))) reviewed.set(r.id, { ref: r, verdict: r.verdict })
    }
    for (const [id, { ref, verdict }] of reviewed) {
      const art = await enrichPrArtifact(sh, prArtifactBase(ref), cwd)
      artifacts.push(art)
      sessionArtifacts.push({ artifactId: id, role: 'reviewed', source: 'explicit', confidence: 1 })
      outcomes.push({ type: 'pr_reviewed', artifactId: id, ts: session.endedAt })
      if (verdict === 'approved') outcomes.push({ type: 'pr_approved', artifactId: id, ts: session.endedAt })
      else if (verdict === 'changes_requested') outcomes.push({ type: 'pr_changes_requested', artifactId: id, ts: session.endedAt })
      if (blocks.length) {
        const blockIdxs = new Set<number>()
        for (const r of refs) {
          if (r.id !== id || (r.kind !== 'review' && r.kind !== 'read') || r.toolIndex < 0) continue
          const bi = tool[r.toolIndex]
          if (bi != null) blockIdxs.add(bi)
        }
        for (const bi of blockIdxs) blockArtifacts.push({ blockIdx: bi, artifactId: id, role: 'reviewed', source: 'explicit', confidence: 1 })
      }
    }

    return { artifacts, sessionArtifacts, outcomes, blockArtifacts }
  },

  async refresh(ctx: RefreshContext): Promise<RefreshResult> {
    const { artifacts: stale, sh, log } = ctx
    const updated: ArtifactInput[] = []
    const outcomes: OutcomeInput[] = []

    for (const art of stale) {
      if (art.kind !== 'pr' || !art.externalId) continue
      const res = await sh('gh', ['pr', 'view', art.externalId, '--json', 'state,mergedAt'], {})
      if (!res || res.code !== 0) continue
      try {
        const j = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null }
        const status = j.state?.toLowerCase()
        if (!status || status === art.status) continue
        log.debug(`refresh: ${art.externalId} ${art.status} → ${status}`)
        updated.push({ ...art, status, completedAt: j.mergedAt ?? art.completedAt })
        if (status === 'merged' && j.mergedAt) {
          outcomes.push({ type: 'pr_merged', artifactId: art.id, ts: j.mergedAt })
        }
      } catch { /* skip unparseable */ }
    }

    return { artifacts: updated, outcomes }
  },
}

/** A decisive verdict (approved / changes_requested) outranks a bare comment. */
function rankVerdict(v?: PrVerdict): number {
  return v && v !== 'commented' ? 1 : 0
}

registerProcessor(outcomesGit)
