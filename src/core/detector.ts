import type { LlmClient } from '../llm/types'
import type { Logger } from '../util/log'
import type { Store } from '../store/store'

export type DetectorTier = 'S' | 'P'

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
  /** The LLM client (null when no provider is configured). P-tier detectors use this. */
  llm: LlmClient | null
}

export interface EvidenceRef {
  sessionId: string
  turnIdx?: number
}

export interface InsightInput {
  /** Stable dedup key within this detector — same key on re-run updates the row, not duplicates it. */
  signalKey: string
  severity: 'high' | 'medium' | 'low'
  /** One-line card heading describing the problem. */
  title: string
  /** Longer explanation with evidence context — the "why should you care." */
  description: string
  /** Session (and optionally turn) pointers for drill-in links. Capped at 10 in the store. */
  evidence: EvidenceRef[]
  /** Total occurrences — the real scale, independent of the evidence cap. */
  count: number
  /** Optional numeric signal specific to this detector (e.g. wasted dollars, success-rate delta). */
  metric?: number
  fix: {
    /** Controls rendering: snippet gets a copy button, nudge gets plain prose, command gets a run prompt. */
    type: 'config-snippet' | 'behavioral-nudge' | 'install-command'
    /** Button/action text (short imperative, e.g. "Copy allowlist entry"). */
    label: string
    /** The deliverable: JSON config to paste, prose suggestion, or shell command. */
    content: string
  }
}

export interface Detector {
  /** Unique identifier — used as the dedup namespace in the insights table. */
  name: string
  /** Bump to force re-run; per-detector, so bumping one doesn't invalidate others. */
  version: number
  /** S = SQL-only (free, always re-run). P = per-session LLM (costs tokens, cached). */
  tier: DetectorTier
  /** When true, the runner skips this detector if no LLM provider is configured. */
  needsLlm?: boolean
  /** Static pre-gate: return false to skip entirely. Avoids wasted work (especially LLM spend for P-tier). */
  applicable?(ctx: DetectorContext): boolean
  /** Find the pattern, return zero or more insights. Can be sync (S-tier SQL) or async (P-tier LLM). */
  run(ctx: DetectorContext): Promise<InsightInput[]> | InsightInput[]
}
