import type { InsightInput } from './detector'

export type FixType = InsightInput['fix']['type']

/**
 * How adoption of each fix type is observed — the one home for that mapping,
 * so measurement and the dashboard don't re-decide it per call site.
 *
 *  marker      — the fix-prompt embeds `tuneloop-fix: <id>`; the fix session
 *                self-identifies in the transcript (fix-marker processor).
 *  config-diff — applied config shows up as a diff between environment
 *                snapshots (not wired yet).
 *  none        — behavioral nudges leave no artifact. The insight skips
 *                `adopted` and resolves directly when its metric goes quiet.
 */
export type AdoptionSignal = 'marker' | 'config-diff' | 'none'

export const ADOPTION_SIGNAL: Record<FixType, AdoptionSignal> = {
  'fix-prompt': 'marker',
  'config-snippet': 'config-diff',
  'install-command': 'config-diff',
  'behavioral-nudge': 'none',
}
