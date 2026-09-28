/**
 * Parse `TUNELOOP_LLM_HEADERS` — a JSON object of extra HTTP headers attached to
 * every enrichment request, whatever the provider shape (OpenAI-compatible,
 * Anthropic, Bedrock). It's the auth channel for an
 * intranet gateway that identifies callers by `x-*` headers instead of an API key
 * (see the `openai-compatible-nokey` preset). Anything that isn't a flat object of
 * string values throws with a message naming the env var; createLlmClient's caller
 * (analyze) catches it and degrades to static-only, surfacing the warning — better
 * than silently dropping the headers and letting the gateway 401 with no clue why.
 */
export function parseLlmHeaders(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`TUNELOOP_LLM_HEADERS is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TUNELOOP_LLM_HEADERS must be a JSON object of "header-name": "value" string pairs')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`TUNELOOP_LLM_HEADERS["${name}"] must be a string, got ${value === null ? 'null' : typeof value}`)
    }
    headers[name] = value
  }
  return headers
}
