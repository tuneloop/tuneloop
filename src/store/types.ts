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

// ---- friction mining (docs/plans/friction-mining.md) ------------------------

export type FrictionType = 're-steer' | 'context-supply' | 'tool-gap' | 'rework' | 'preference' | 'other'
export type FrictionTrigger = 'unprompted' | 'after_tool_error' | 'after_review' | 'agent_stated'
export type FrictionRemedy = 'add_doc' | 'add_skill' | 'add_tool' | 'model_or_prompt' | 'none'

/**
 * A new friction topic to mint. Insert-or-ignore semantics: an id that already
 * exists keeps its original row (topic identity is stable, never auto-renamed).
 */
export interface FrictionTopicInput {
  id: string
  label: string
  type: FrictionType
  remedy?: FrictionRemedy
  /** Owning repo; undefined = global (allowed for preference-type topics). */
  repo?: string
  firstSeen?: string
}

/** One friction event on one follow-up user turn. `idx` orders events within the session. */
export interface FrictionEventInput {
  idx: number
  /** seq of the user turn this event points at — the evidence pointer. */
  turnSeq?: number
  blockIdx?: number
  type: FrictionType
  trigger: FrictionTrigger
  remedyHint: FrictionRemedy
  description: string
  /** Existing or just-minted topic id; undefined when no topic fits. */
  topicId?: string
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
