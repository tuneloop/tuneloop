/**
 * Fix-prompt: a self-contained prompt a user pastes into their coding agent to
 * apply an insight's fix. It opens with a `tuneloop-fix: <insight-id>` marker so
 * the fix session self-identifies in the transcript — the fix-marker processor
 * sights it on the next analyze and the insight flips to `adopted` (exact loop
 * closure instead of inference). The same prompt works unchanged in any harness.
 */

export interface FixPromptInput {
  /** Deterministic insight id (see insightId in core/detector.ts). */
  id: string
  /** What's wrong and how often — "Across 6 recent sessions, the user had to …". */
  diagnosis: string
  /** Distilled evidence lines, already formatted (e.g. `Jun 30: "no — deploy to staging first…"`). */
  excerpts: string[]
  /** The work: what to add/change so the pattern becomes unnecessary. */
  task: string
  /** Acceptance criterion the agent can check. */
  doneWhen: string
}

export function buildFixPrompt(input: FixPromptInput): string {
  const excerpts = input.excerpts.map((e) => `- ${e}`).join('\n')
  return [
    `tuneloop-fix: ${input.id}`,
    '',
    input.diagnosis,
    'Excerpts:',
    '',
    excerpts,
    '',
    `Task: ${input.task}`,
    '',
    `Done when: ${input.doneWhen}`,
    '',
  ].join('\n')
}

/**
 * Extract the insight ids of all fix markers in a piece of user-turn text.
 * Only the paste path is detectable: a marker arriving via tool output (e.g. a
 * future tuneloop skill fetching the fix-prompt) lands outside user turns and is
 * not sighted — that delivery path needs its own signal when it's built.
 */
export function extractFixMarkers(text: string): string[] {
  const re = /tuneloop-fix:\s*([0-9a-f]{16})\b/gi
  const ids: string[] = []
  for (const m of text.matchAll(re)) {
    if (m[1]) ids.push(m[1].toLowerCase())
  }
  return ids
}
