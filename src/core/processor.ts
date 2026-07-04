/**
 * The processor contract — the main extension point.
 *
 * Everything derived from a session is a registered processor with this uniform
 * interface: token/cost, files touched, git/PR outcomes, and (later) LLM
 * enrichment. To add a new fact, implement Processor and register it — no
 * changes to the runner, the store schema, or the dashboard.
 */
import type { Session, TokenUsage } from './model'
import type { FacetSpec } from './facets'
import type { MeasureSpec } from './measures'
import type {
  AnnotationInput,
  ArtifactInput,
  ArtifactLinkInput,
  BlockAnnotationInput,
  BlockArtifactInput,
  BlockInput,
  BlockToolInput,
  BlockUsageInput,
  FeatureRevisionInput,
  FileIndexInput,
  FrictionEventInput,
  FrictionTopicInput,
  FrictionType,
  OutcomeInput,
  SessionArtifactInput,
} from '../store/types'
import type { LlmClient } from '../llm/types'
import type { Logger } from '../util/log'

export type ProcessorKind = 'static' | 'enrichment'

export interface ShResult {
  stdout: string
  code: number
}

/**
 * An existing feature a processor can link a session to. Carries enough of the
 * hierarchy for an enrichment processor to attach a session to the most specific
 * feature, place a new feature under the right parent, and refine the tree.
 */
export interface FeatureRef {
  id: string
  title: string
  /** Parent feature id (null = top-level) — the shape of the hierarchy. */
  parentId?: string | null
  /** Provenance; `user`-authored features are locked from auto-rename/reparent. */
  source?: string | null
  /**
   * Repos associated anywhere in this feature's subtree (itself + descendants),
   * from linked sessions and any explicit repo. Empty = unscoped/global (e.g. a
   * cross-repo epic or a fresh user feature). Auto-derived linkage is allowed
   * only to a feature that is global or already includes the session's repo.
   */
  repos?: string[]
}

/** An existing friction topic a processor can assign events to (see FrictionTopicInput). */
export interface FrictionTopicRef {
  id: string
  label: string
  type: FrictionType
  /** Owning repo; null/undefined = global. */
  repo?: string | null
}

/** A user-linked artifact that needs block-level attribution. */
export interface UserLinkedArtifact {
  artifactId: string
  kind: 'pr' | 'feature'
  title: string | null
  ident: string | null
}

/** Block indices already attributed to a PR by deterministic processors. */
export interface PrBlockAttribution {
  blockIdx: number
  artifactId: string
  title: string | null
}

export interface ProcessorContext {
  session: Session
  log: Logger
  /** Whether an LLM provider + key is configured this run. */
  llmEnabled: boolean
  /** LLM client for enrichment processors; null when not configured. */
  llm: LlmClient | null
  /** Existing features in the store, to bias derived feature linkage toward. */
  existingFeatures: FeatureRef[]
  /**
   * Existing friction topics visible to this session (its repo + globals), read
   * fresh per session like existingFeatures so assignments compound across a run.
   */
  existingTopics: FrictionTopicRef[]
  /** Titles of features the user has rejected for this session (tombstoned). */
  rejectedFeatureTitles: string[]
  /** User-linked PRs/features for this session that have no block-level attribution yet. */
  userLinkedArtifacts: UserLinkedArtifact[]
  /** Blocks already attributed to PRs by deterministic processors (outcomes-git). */
  prBlockAttributions: PrBlockAttribution[]
  /** Run a local binary (git, gh). Resolves null if the binary is missing. */
  sh: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ShResult | null>
}

/** Everything a processor can emit. The runner stamps each row with the processor name. */
export interface ProcessorResult {
  annotations?: AnnotationInput[]
  artifacts?: ArtifactInput[]
  links?: ArtifactLinkInput[]
  sessionArtifacts?: SessionArtifactInput[]
  /** In-place edits to existing (non-user) features — rename / reparent. */
  featureRevisions?: FeatureRevisionInput[]
  outcomes?: OutcomeInput[]
  files?: FileIndexInput[]
  /** Block partition + membership (owned by segment-blocks). */
  blocks?: BlockInput[]
  blockUsage?: BlockUsageInput[]
  blockTool?: BlockToolInput[]
  /** Per-block labels / links (use_case from enrich-session, PR/commit from outcomes-git, feature from enrich-session). */
  blockAnnotations?: BlockAnnotationInput[]
  blockArtifacts?: BlockArtifactInput[]
  /** Friction facts (enrich-friction): topics first (events reference them by id). */
  frictionTopics?: FrictionTopicInput[]
  frictionEvents?: FrictionEventInput[]
  /** For enrichment processors: the LLM spend this processor incurred. */
  selfCost?: { tokens: TokenUsage; usd: number }
}

export interface RefreshContext {
  artifacts: ArtifactInput[]
  log: Logger
  sh: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ShResult | null>
}

export interface RefreshResult {
  artifacts?: ArtifactInput[]
  outcomes?: OutcomeInput[]
}

export interface Processor {
  name: string
  /** Bump to invalidate cached results and force reprocessing. */
  version: number
  kind: ProcessorKind
  /** Gates execution: `llm` skips when no provider is configured. */
  needs?: { llm?: boolean; network?: boolean }
  /** Names of processors that must run first (topo-sorted). */
  requires?: string[]
  /** Facets this processor contributes to the dashboard registry. */
  facets?: FacetSpec[]
  /** Measures this processor contributes (over numeric facts it emits). */
  measures?: MeasureSpec[]
  run(ctx: ProcessorContext): Promise<ProcessorResult> | ProcessorResult
  /** Re-check artifacts this processor owns that may have gone stale. */
  refresh?(ctx: RefreshContext): Promise<RefreshResult>
}
