import { registerProcessor } from '../core/registry'
import { followupTurns, userTurns } from '../core/turns'
import type { Processor } from '../core/processor'
import type { AnnotationInput } from '../store/types'

/**
 * Deterministic steering intensity: how many substantive follow-up turns the
 * user sent after the opening request (bare approvals excluded — see core/turns.ts)
 *
 * Deliberately named "steering", NOT "friction": a follow-up may be genuine
 * re-direction ("use the default sqlite db") or mere workflow progression
 * ("commit and open a PR"), and only LLM extraction can tell them apart. 
 * This count is a CEILING on friction — the per-session denominator the LLM layer 
 * is validated against — and the only steering signal available when no LLM provider 
 * is configured.
 */
export const steering: Processor = {
  name: 'steering',
  version: 1,
  kind: 'static',
  facets: [
    // Session-grain filter/split: did the user intervene after the opener at all?
    { key: 'steering', label: 'Steering', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
  ],
  measures: [
    {
      // Mean substantive follow-ups per session. Annotation-sourced (session
      // grain): the expr reads the scalar back from the annotations table; AVG
      // skips sessions that predate this processor (NULL subquery)
      key: 'steering_intensity',
      label: 'Steering intensity',
      source: 'annotation',
      expr: "(SELECT json_extract(a.value,'$') FROM annotations a WHERE a.session_id = s.id AND a.key = 'followup_count')",
      agg: 'avg',
    },
  ],
  run(ctx) {
    const count = followupTurns(userTurns(ctx.session)).length
    const annotations: AnnotationInput[] = [
      { key: 'followup_count', value: count },
      { key: 'steering', value: count > 0 ? 'yes' : 'no' },
    ]
    return { annotations }
  },
}

registerProcessor(steering)
