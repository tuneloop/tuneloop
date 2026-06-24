/**
 * The measure registry: the "how much" axis, parallel to the facet registry.
 * A measure is an aggregation (`agg`) of an expression (`expr`) over the
 * population at its grain. Crossed with a facet (the "which" axis) by
 * Store.breakdown, it produces every "<measure> by <facet>" view.
 *
 * Like facets: intrinsic measures live here; processors add more via
 * Processor.measures; both persist to the `measures` table at analyze time so
 * the serve process discovers them without importing processors.
 *
 * `source` (reused from facets) says WHERE the value lives and implies the grain
 * (grainOf). `expr` is SQL over that source's anchor alias — s (sessions),
 * u (usage_facts), t (tool_calls). For `rate`, expr is a 0/1 (boolean) predicate.
 */
import type { FacetSource } from './facets'
import type { Grain } from './facets'

export type MeasureAgg = 'sum' | 'count' | 'count_distinct' | 'avg' | 'rate'

export interface MeasureSpec {
  key: string
  label?: string
  source: FacetSource
  /** SQL over the anchor alias (s/u/t). For `rate`, a 0/1 boolean expression. */
  expr: string
  agg: MeasureAgg
  /** Optional base predicate restricting the population. */
  base?: string
  format?: 'usd' | 'int' | 'pct'
}

/** Anchor alias for a grain, used to qualify measure/facet expressions. */
export function aliasFor(grain: Grain): string {
  return grain === 'usage' ? 'u' : grain === 'tool_call' ? 't' : grain === 'block' ? 'b' : 's'
}

export const INTRINSIC_MEASURES: MeasureSpec[] = [
  // Cost/tokens live at usage grain so they split by model and join up to session facets.
  { key: 'cost', label: 'Cost', source: 'usage', expr: 'u.cost_usd', agg: 'sum', format: 'usd' },
  {
    key: 'tokens',
    label: 'Tokens',
    source: 'usage',
    expr: 'u.tok_input + u.tok_output + u.tok_cache_create + u.tok_cache_read',
    agg: 'sum',
    format: 'int',
  },
  { key: 'sessions', label: 'Sessions', source: 'session', expr: 's.id', agg: 'count_distinct', format: 'int' },
  {
    // Headline: fraction of all sessions with a session_success outcome (full denominator).
    key: 'success_rate',
    label: 'Success rate',
    source: 'session',
    expr: "EXISTS (SELECT 1 FROM outcomes o WHERE o.session_id = s.id AND o.type = 'session_success')",
    agg: 'rate',
    format: 'pct',
  },
  { key: 'tool_calls', label: 'Tool calls', source: 'tool-call', expr: '1', agg: 'count', format: 'int' },
  { key: 'error_count', label: 'Errors', source: 'tool-call', expr: 't.is_error', agg: 'sum', format: 'int' },
  { key: 'error_rate', label: 'Error rate', source: 'tool-call', expr: 't.is_error', agg: 'rate', format: 'pct' },
]
