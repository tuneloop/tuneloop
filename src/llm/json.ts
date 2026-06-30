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
