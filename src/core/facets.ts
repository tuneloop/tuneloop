/**
 * The facet registry: the single source of truth for the categorical dimensions
 * the dashboard charts, filters, and (later) compares by.
 *
 * A facet's `source` names WHERE its value lives — which also implies its grain.
 * `multi` is cardinality (array vs scalar). `type` is the element type. The query
 * builder (Store.facetDistribution / facetPredicate) derives the exact read shape
 * — raw column / json_extract / json_each / EXISTS — from `(source, multi)`, so
 * nothing above the store hardcodes which dimensions exist.
 *
 * Two sources of facets, both persisted to the `facets` table at analyze time so
 * the separate serve process can read them without importing processors:
 *   - intrinsic facets (below): structural, present without any processor
 *   - processor-declared facets: a processor's `facets` field (e.g. enrichment)
 */

/** Where a facet's value lives — implies its grain. */
export type FacetSource = 'session' | 'annotation' | 'tool-call' | 'usage'
export type FacetType = 'string' | 'number' | 'boolean' | 'enum'

/** The entity a row lives at. session is the coarsest; usage/tool_call are its children. */
export type Grain = 'session' | 'usage' | 'tool_call'

/** A source's grain. session-column and annotation are both per-session. */
export function grainOf(source: FacetSource): Grain {
  return source === 'usage' ? 'usage' : source === 'tool-call' ? 'tool_call' : 'session'
}
/** Where a facet may surface in the UI. */
export type FacetRole = 'chart' | 'filter' | 'detail'

export interface FacetSpec {
  key: string
  label?: string
  /** Element type (drives rendering); never 'array' — array-ness is `multi`. */
  type: FacetType
  source: FacetSource
  /**
   * Physical column for session / tool-call / usage facets; defaults to `key`.
   * Unused for `annotation` (there `key` IS the annotation key).
   */
  column?: string
  /** Base predicate scoping rows for tool-call / usage facets, e.g. action='skill'. */
  base?: string
  /**
   * Array-valued (json_each) vs scalar. Only meaningful for session/annotation
   * storage; for tool-call/usage the to-many-ness is intrinsic to the grain.
   */
  multi?: boolean
  roles?: FacetRole[]
}

/** Structural facets that exist without any processor having run. */
export const INTRINSIC_FACETS: FacetSpec[] = [
  { key: 'repo', label: 'Repo', type: 'string', source: 'session', column: 'repo', roles: ['chart', 'filter', 'detail'] },
  {
    // Usage-grain (usage_facts.model), NOT the sessions.models array — so a usage
    // MEASURE (cost/tokens) groups by model with a correct per-model split, while
    // distribution/filter still read "sessions that used model X" via the child table.
    key: 'model',
    label: 'Model',
    type: 'enum',
    source: 'usage',
    column: 'model',
    roles: ['chart', 'filter', 'detail'],
  },
  {
    key: 'skill',
    label: 'Skill',
    type: 'string',
    source: 'tool-call',
    column: 'name',
    base: "action = 'skill'",
    multi: true,
    roles: ['chart', 'filter', 'detail'],
  },
]
