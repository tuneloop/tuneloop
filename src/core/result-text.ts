/**
 * The human-readable text of a tool call's result, whatever shape the harness
 * stored it in — a string, an array of content blocks, or an object with
 * stdout/stderr/error/message/content.
 *
 * One definition because two readers must agree on it: ingest classifies the
 * error from this text (error-category, empty-result), and the tool-error-advice
 * pass re-reads the SAME text at full length from the session blob, since the
 * stored `error_message` is clipped to 200 characters.
 */
export function resultText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['stdout', 'stderr', 'error', 'message', 'content']) {
      const v = o[k]
      if (typeof v === 'string' && v) return v
      if (Array.isArray(v)) return resultText(v)
    }
    try {
      return JSON.stringify(o)
    } catch {
      return ''
    }
  }
  return String(raw)
}
