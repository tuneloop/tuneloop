/**
 * Persistence-facing record shapes. Kept separate from both the normalized
 * model (core/model.ts) and the Store implementation so processors can import
 * these without pulling in better-sqlite3.
 */
import type { TokenUsage } from '../core/model'

export type ArtifactKind = 'file' | 'commit' | 'pr' | 'ticket' | 'feature'
export type LinkSource = 'explicit' | 'transitive' | 'derived' | 'user'
export type ArtifactRelation = 'part_of' | 'resolves' | 'child_of' | 'caused_by'
export type SessionArtifactRole = 'created' | 'edited' | 'contributed' | 'reviewed'

export interface ArtifactInput {
  id: string
  kind: ArtifactKind
  repo?: string
  ident?: string
  externalId?: string
  /** github | jira | linear | asana | user | codebase-inferred | transcript | ... */
  source?: string
  title?: string
  /** PR author / ticket assignee / feature owner — the "team" artifact filter. */
  owner?: string
  complexity?: number
  /** story_points | diff_size | equal_split */
  complexityBasis?: string
  status?: string
  createdAt?: string
  /** Merge / resolve / ship date. NULL until the artifact completes. */
  completedAt?: string
  parentArtifactId?: string
  json?: unknown
}

export interface ArtifactLinkInput {
  fromId: string
  toId: string
  relation: ArtifactRelation
  source: LinkSource
  confidence?: number
}

export interface SessionArtifactInput {
  artifactId: string
  role: SessionArtifactRole
  source: LinkSource
  confidence?: number
}

/**
 * A reparent of an existing feature, for an enrichment processor that maintains
 * the feature hierarchy as it sees more sessions. Applied only to machine-derived
 * features — `user`-authored features are never touched. Auto-rename is
 * deliberately NOT supported: a bad rename retroactively mislabels every session
 * under the feature, so titles are fixed at creation (the dashboard can rename).
 */
export interface FeatureRevisionInput {
  id: string
  /** New parent id; `null` = make top-level; omit (`undefined`) = keep. */
  parentId?: string | null
}

export interface OutcomeInput {
  type: string
  /** NULL for session-level outcomes (session_success, plan_drafted, ...). */
  artifactId?: string | null
  ts?: string
}

export interface FileIndexInput {
  repo?: string
  path: string
}

export interface AnnotationInput {
  key: string
  value: unknown
}

// ---- block-level attribution (handling_long_sessions) ----------------------

/** A contiguous deterministic slice of a session's main thread. */
export interface BlockInput {
  idx: number
  startSeq: number
  endSeq: number
  boundaryKind: string
  tsStart?: string
  tsEnd?: string
}

/** usage_facts.idx -> block idx (a total partition; non-overlap is PK-enforced). */
export interface BlockUsageInput {
  usageIdx: number
  blockIdx: number
}

/** tool_calls.idx -> block idx. */
export interface BlockToolInput {
  toolIdx: number
  blockIdx: number
}

/** A label on one block (e.g. use_case), parallel to AnnotationInput. */
export interface BlockAnnotationInput {
  blockIdx: number
  key: string
  value: unknown
}

/** A block -> artifact link (block→PR/commit deterministic; block→feature derived). */
export interface BlockArtifactInput {
  blockIdx: number
  artifactId: string
  role: SessionArtifactRole
  source?: LinkSource
  confidence?: number
}

/** One assistant message's usage + cost — a row in the `usage_facts` table. */
export interface UsageFactInput {
  idx: number
  model: string
  isSidechain: boolean
  ts?: string
  tokens: TokenUsage
  usd: number
}

export interface SessionRow {
  id: string
  sessionId: string
  source: string
  provider: string
  title?: string
  repo?: string
  branch?: string
  cwd?: string
  startedAt?: string
  endedAt?: string
  nTurns: number
  nToolCalls: number
  models: string[]
  tokens: TokenUsage
  costUsd: number
  priceTableVersion: string
  contentHash: string
  parseVersion: number
}

export interface ProcessorRunRow {
  version: number
  inputHash: string
  model: string | null
  invalidated: boolean
}

// ---- insight ledger types ---------------------------------------------------

export type InsightState = 'surfaced' | 'fix_issued' | 'adopted' | 'resolved' | 'dismissed'

export interface InsightRow {
  id: string
  detector: string
  signalKey: string
  repo: string
  severity: 'high' | 'medium' | 'low'
  state: InsightState
  title: string
  description: string
  count: number
  fix: {
    type: string
    label: string
    content: string
  }
  firstSeenAt: string
  lastSeenAt: string
  stateChangedAt: string | null
  detectorVersion: number
  evidence: Array<{ sessionId: string; turnIdx: number | null }>
  /** Event time the fix was first applied in the current cycle (transcript timestamp), null if not adopted. */
  adoptedAt: string | null
  /** Sessions that ran this insight's fix-prompt, current cycle only (older cycles are history). */
  fixSessions: Array<{ sessionId: string; seq: number; turnAt: string }>
}

export interface DetectorRunRow {
  version: number
  status: string | null
  ranAt: string
}

/** One fix-marker sighting: a real user turn in this session carried `tuneloop-fix: <insightId>`. */
export interface FixMarkerSightingInput {
  insightId: string
  /** Main-thread event seq of the sighted user turn. */
  seq: number
  /** Transcript timestamp of that turn — event time, the "fix applied" date. */
  turnAt: string
}
