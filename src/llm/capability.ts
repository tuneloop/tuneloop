/**
 * Coarse model-capability classification, used to gate reasoning-heavy detectors
 * that produce misleading output on weak models (see the recurring-themes gate).
 *
 * There is NO capability metadata in the provider/pricing tables, and model
 * strings are messy — Bedrock inference-profile ARNs
 * (`us.anthropic.claude-sonnet-5-…`), OpenRouter prefixes (`openai/gpt-5-mini`),
 * and free-form openai-compatible/ollama names all flow through here. So we match
 * on FAMILY MARKERS in the string rather than an exact id, and err conservative:
 * anything we don't recognise is `unknown`, which ranks BELOW the `strong` floor
 * (fail-closed). Update the markers as new model families ship.
 */
export type ModelTier = 'strong' | 'weak' | 'unknown'

// Ordinal so tiers compare. `strong` == Sonnet-class-or-above — the floor the
// heavy detector pass needs. `unknown` sits below `weak` so an unrecognised model
// is gated out unless explicitly forced.
const RANK: Record<ModelTier, number> = { strong: 2, weak: 1, unknown: 0 }

/** Classify a model id into a coarse capability tier by its family markers. */
export function modelTier(model: string): ModelTier {
  const m = model.toLowerCase()
  const has = (...tokens: string[]) => tokens.some((t) => m.includes(t))
  // "cheap tier" markers that demote an otherwise-capable family below the floor.
  const cheap = /\b(mini|nano|flash|flash-lite|lite|small|tiny)\b/.test(m) || has('-mini', '-nano', '-flash', '-lite')

  // Anthropic (direct ids + Bedrock ARNs + OpenRouter `anthropic/…`)
  if (has('opus', 'fable', 'sonnet')) return 'strong'
  if (has('haiku')) return 'weak'

  // OpenAI GPT-5 family (full = strong; mini/nano = weak). Older GPT-4/3 = weak.
  if (/\bgpt-?5\b/.test(m) || m.includes('gpt-5')) return cheap ? 'weak' : 'strong'
  if (has('gpt-4', 'gpt-3', 'gpt4', 'gpt3')) return 'weak'

  // Gemini (pro = strong; flash/lite = weak; bare gemini = unknown)
  if (has('gemini')) return has('pro') ? 'strong' : cheap ? 'weak' : 'unknown'

  // xAI Grok (grok-4+ = strong; older = weak)
  if (/\bgrok-?([4-9]|\d{2,})\b/.test(m)) return 'strong'
  if (has('grok')) return 'weak'

  return 'unknown'
}

/** True when `model`'s tier is at least `min` (e.g. Sonnet-class-or-stronger = `strong`). */
export function meetsMinTier(model: string, min: ModelTier): boolean {
  return RANK[modelTier(model)] >= RANK[min]
}
