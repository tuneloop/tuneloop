/**
 * Parse a JSON object out of a model's text response — tolerant of the markdown
 * fences and stray prose weaker models wrap around their JSON. Used to salvage
 * output when a model returns its result as text instead of a tool call. Returns
 * null if nothing object-shaped can be recovered.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text.trim())
  if (direct) return direct
  const match = text.match(/\{[\s\S]*\}/)
  return match ? tryParse(match[0]) : null
}

/**
 * Strip tool-call serialization that a model (notably Sonnet-5) sometimes bleeds
 * into a long string PARAMETER of a forced-tool call: the value captures its own
 * closing `</field>` tag and the following `<parameter name="…">…` block(s) for
 * sibling parameters, e.g. a fix's `content` ending in
 * `…done.</content>\n<parameter name="reason">…`. A no-op on clean strings.
 *
 * `key` is the parameter's own name, so the orphan closing tag it left behind
 * (`</content>`) is removed too. Anchored on the function-call XML tokens
 * (`<parameter>`, `<invoke>`, `<function_calls>`), which do not occur in the
 * model's legitimate prose here.
 */
export function stripToolCallLeak(value: string, key?: string): string {
  // 1) Cut from the first function-call control token onward (opening OR closing
  //    <parameter>/<invoke>/<function_calls>). `\b` keeps <parameters> etc. safe.
  const cut = value.replace(/<\/?(?:parameter|invoke|function_calls)\b[^>]*>[\s\S]*$/i, '')
  let s = cut
  let changed = cut !== value
  // 2) Drop a trailing orphan closing tag for this very field (</content>) — left
  //    by (1), or emitted alone when the sibling parameter parsed natively.
  if (key) {
    const safe = key.replace(/[^\w-]/g, '')
    if (safe) {
      const stripped = s.replace(new RegExp(`\\s*</${safe}>\\s*$`, 'i'), '')
      if (stripped !== s) {
        s = stripped
        changed = true
      }
    }
  }
  // Trim the residual whitespace the cut/strip left behind — but only then, so a
  // clean value is returned byte-identical (no incidental trimming).
  return changed ? s.replace(/\s+$/, '') : value
}

/**
 * Defensive pass over a forced-tool result: strip tool-call XML that bled into any
 * top-level string parameter (see {@link stripToolCallLeak}). Non-string values
 * pass through untouched. Keyed per-field so each value's own closing tag is
 * recognised. A no-op when nothing leaked.
 */
export function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? stripToolCallLeak(v, k) : v
  return out
}

/**
 * Read an array-valued field out of a forced-tool result. Sonnet-5 sometimes emits a
 * large array as a JSON STRING (bare array, or the enclosing {key:[…]}) instead of
 * native JSON — so parse a string back. Returns [] when absent/unparseable.
 */
export function arrayField(data: Record<string, unknown>, key: string): unknown[] {
  const v = data[key]
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  try {
    const parsed = JSON.parse(v)
    if (Array.isArray(parsed)) return parsed
    const nested = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : undefined
    return Array.isArray(nested) ? nested : []
  } catch {
    return []
  }
}
