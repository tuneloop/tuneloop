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
  FileIndexInput,
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

/** An existing feature a processor can link a session to (bias toward these). */
export interface FeatureRef {
  id: string
  title: string
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
  /** Run a local binary (git, gh). Resolves null if the binary is missing. */
  sh: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ShResult | null>
}

/** Everything a processor can emit. The runner stamps each row with the processor name. */
export interface ProcessorResult {
  annotations?: AnnotationInput[]
  artifacts?: ArtifactInput[]
  links?: ArtifactLinkInput[]
  sessionArtifacts?: SessionArtifactInput[]
  outcomes?: OutcomeInput[]
  files?: FileIndexInput[]
  /** For enrichment processors: the LLM spend this processor incurred. */
  selfCost?: { tokens: TokenUsage; usd: number }
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
}
