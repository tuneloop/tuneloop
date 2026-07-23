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
