import { createHash } from 'node:crypto'
import type { LlmClient } from '../llm/types'
import type { Logger } from '../util/log'
import type { Session } from './model'
import type { Store } from '../store/store'

/**
 * Deterministic insight id: 16-hex sha256 of the (detector, repo, signalKey)
 * identity triple — the same triple the insights table enforces UNIQUE on.
 * Deterministic so that fix-prompt markers embedded in transcripts still point
 * at the right insight after a store rebuild (ids re-mint identically).
 * JSON-encoded to avoid concatenation-boundary collisions.
 */
export function insightId(detector: string, repo: string, signalKey: string): string {
  return createHash('sha256').update(JSON.stringify([detector, repo, signalKey])).digest('hex').slice(0, 16)
}

/**
 * Detector compute tiers:
 *  S — Static analysis. Data already in the store (or readable from local config).
 *      Free to run, always re-runs on every analyze. Examples: permission friction,
 *      cache misses, model-complexity mismatch.
 *  P — Per-session LLM. Fits the existing one-call-per-session enrichment pattern.
 *      Costs tokens, cached by (version + new sessions). Examples: verification gap,
 *      kitchen-sink sessions, underspecified prompts.
 *  X — Cross-session LLM. Rolling-window analysis over many sessions, new analysis
 *      spend. Examples: repeated nudges / recurring pasted context clustering.
 */
export type DetectorTier = 'S' | 'P' | 'X'

/** Everything a detector receives when it runs — the "bag of tools" passed into run(). */
export interface DetectorContext {
  /**
   * The store instance. Detectors use store.queryAll() / store.queryOne() for
   * read-only SQL access — they can ask any question across all sessions but
   * cannot mutate data. All writes go through the runner via persistInsights().
   */
  store: Store
  /** Logger for debug/info/warn messages during detection. */
  log: Logger
  /** Whether an LLM provider is configured this run. */
  llmEnabled: boolean
  /** The LLM client (null when no provider is configured). P/X-tier detectors use this. */
  llm: LlmClient | null
  /**
   * Sessions this detector hasn't seen, or whose content changed since it last
   * ran (the incremental delta). P/X-tier detectors extract only these, then
   * report them back as `DetectorResult.seen`. Keyed by the detector's own name.
   */
  unseenSessions(): Array<{ sessionId: string; contentHash: string }>
  /**
   * Hydrate a full `Session` (events, tool calls, subagents) from its stored
   * blob — the content SQL-only detectors can't reach. Null if the blob is
   * missing/corrupt. Read-only; detectors never mutate the returned object.
   */
  loadSession(id: string): Session | null
}

export interface EvidenceRef {
  sessionId: string
  /**
   * Position within the session: the main-thread event `seq` assigned by
   * assignSeq() (core/blocks.ts) — the same coordinate blocks and the transcript
   * viewer use. Omit for session-level evidence
   */
  turnIdx?: number
  /**
   * Optional one-line, human-readable note for this occurrence (e.g. what
   * happened at this turn). Shown in the insight detail so each evidence row
   * reads as a specific occurrence, not just a session link.
   */
  note?: string
}

export interface InsightInput {
  /**
   * Stable dedup key within this detector — same key on re-run updates the row,
   * not duplicates it. The key FORMAT is part of the detector's public contract:
   * the insight id is derived from it (see insightId), so changing the format
   * orphans past fix-prompt markers users already ran. Change it only with a
   * reason worth that cost.
   */
  signalKey: string
  /**
   * Scoping for this insight:
   *  - repo name (e.g. 'tuneloop') — insight specific to that repo
   *  - '*' — cross-repo insight (pattern spans multiple repos)
   *  - cwd path — for sessions not in a git repo, use the working directory
   *  - '_unknown' — fallback when neither repo nor cwd is available
   */
  repo: string
  severity: 'high' | 'medium' | 'low'
  /** One-line card heading describing the problem. */
  title: string
  /** Longer explanation with evidence context — the "why should you care." */
  description: string
  /** Session (and optionally turn) pointers for drill-in links. Capped at 10 in the store. */
  evidence: EvidenceRef[]
  /** Total occurrences — the real scale, independent of the evidence cap. */
  count: number
  fix: {
    /** Controls rendering: snippet gets a copy button, nudge gets plain prose, command gets a run prompt, fix-prompt gets a paste-into-agent-config prompt. */
    type: 'config-snippet' | 'behavioral-nudge' | 'install-command' | 'fix-prompt'
    /** Button/action text (short imperative, e.g. "Copy allowlist entry"). */
    label: string
    /** The deliverable: JSON config to paste, prose suggestion, or shell command. */
    content: string
  }
}

/**
 * What a P/X-tier detector reports back beyond its insights. S-tier detectors
 * return a bare `InsightInput[]` (no LLM cost, no per-session tracking); the
 * runner normalizes either shape via `normalizeDetectorResult`.
 */
export interface DetectorResult {
  insights: InsightInput[]
  /** LLM spend + model this run incurred — recorded on `detector_runs` for per-detector cost accounting. */
  cost?: { inTokens: number; outTokens: number; usd: number; model?: string }
  /**
   * Sessions this run actually processed, at the content hash it saw them at.
   * The runner marks them seen (detector_session_runs) ONLY if the persist
   * succeeds, so a failed run re-processes the same delta next analyze.
   */
  seen?: Array<{ sessionId: string; contentHash: string }>
}

export interface Detector {
  /** Unique identifier — used as the dedup namespace in the insights table. */
  name: string
  /** Bump to force re-run; per-detector, so bumping one doesn't invalidate others. */
  version: number
  /** S = SQL-only (free, always re-run). P/X = LLM (costs tokens, delta-cached). */
  tier: DetectorTier
  /** When true, the runner skips this detector if no LLM provider is configured. */
  needsLlm?: boolean
  /** Static pre-gate: return false to skip entirely. Avoids wasted work (especially LLM spend for P/X-tier). */
  applicable?(ctx: DetectorContext): boolean
  /**
   * Find the pattern. S-tier returns a bare `InsightInput[]` (sync SQL); P/X-tier
   * returns a `DetectorResult` (async) so it can also report LLM cost + the
   * sessions it processed. The runner accepts either.
   */
  run(ctx: DetectorContext): Promise<InsightInput[] | DetectorResult> | InsightInput[] | DetectorResult
}

/** Normalize either `run()` return shape into a `DetectorResult`. */
export function normalizeDetectorResult(r: InsightInput[] | DetectorResult): DetectorResult {
  return Array.isArray(r) ? { insights: r } : r
}
