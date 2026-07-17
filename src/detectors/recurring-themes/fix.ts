import { contentHash } from '../../core/hash'
import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'
import type { LlmClient, JsonSchema } from '../../llm/types'
import type { Logger } from '../../util/log'
import type { Store } from '../../store/store'

const TOOL_NAME = 'draft_fix'
// Cap occurrences fed to the fix LLM — a heavily-recurring theme (100s of events)
// doesn't need every one to draft a good fix; the most recent are representative.
const MAX_FIX_OCCURRENCES = 40

// The fix payload shapes the detector may emit (mirrors InsightInput.fix.type).
const FIX_TYPES = ['behavioral-nudge', 'config-snippet', 'install-command', 'fix-prompt'] as const
type FixType = (typeof FIX_TYPES)[number]

export interface ThemeFix {
  fixType: FixType
  /** The deliverable, WITHOUT the tuneloop-fix marker — the caller prepends it for non-nudge types. */
  content: string
}

/** One occurrence handed to the fix pass: the abstract description + the user's actual words. */
export interface FixOccurrence {
  description: string
  snippet?: string
}

/**
 * Generate an ACTUAL, tailored fix for one theme by reading all its occurrences.
 * The LLM chooses the remedy shape itself — a CLAUDE.md edit / skill / config /
 * install command (any of which carry a tuneloop-fix marker for loop closure) or
 * a behavioral nudge (no marker; there's no artifact to adopt). The most
 * reasoning-heavy call in the detector — a candidate for a stronger model (Opus).
 *
 * NOTE (T3): once the environment reader lands, wire the user's installed
 * skills / MCP servers / plugins into this prompt so the fix can reference what
 * they already have (tighten an existing skill vs. install a new one). For now
 * the fix is drafted without that inventory.
 */
export async function generateFix(
  llm: LlmClient,
  theme: { label: string; description: string | null; type: string; repo: string | null },
  occurrences: FixOccurrence[],
): Promise<{ fix: ThemeFix | null; usage: TokenUsage }> {
  let usage = emptyUsage()
  const scope = theme.repo ? `the ${theme.repo} project` : 'the user (across projects)'
  const shown = occurrences.slice(0, MAX_FIX_OCCURRENCES)
  const occLines = shown
    .map((o, i) => `${i + 1}. ${o.description}${o.snippet ? `\n   user said: "${clip(o.snippet, 400)}"` : ''}`)
    .join('\n')
  const moreNote = occurrences.length > shown.length ? ` (showing ${shown.length} of ${occurrences.length})` : ''

  const system =
    'You write a single, concrete FIX for a recurring friction pattern between a developer and their AI coding ' +
    'agent. You are given the pattern and every observed occurrence (with the user\'s actual words). Produce the ' +
    `most effective remedy and its exact content via the ${TOOL_NAME} tool. Be specific and actionable — the user ` +
    'should be able to apply it directly, not read generic advice.'

  const user = [
    `Friction theme: ${theme.label}`,
    theme.description ? `Definition: ${theme.description}` : '',
    `Type: ${theme.type} · Scope: ${scope}`,
    '',
    `Observed ${occurrences.length} time(s)${moreNote}:`,
    occLines,
    '',
    'Choose the fix_type that will actually stop this recurring:',
    '- fix-prompt: a self-contained prompt the user pastes into their agent to make a durable change — ADD a',
    '  CLAUDE.md section, CREATE or TIGHTEN a skill, wire a tool/MCP, etc. Use this when the remedy is a concrete',
    '  repo/config artifact the agent should create. Write the full prompt: what to change, and a "Done when:" line.',
    '- config-snippet: a ready-to-paste settings.json / .mcp.json block, when the fix is pure configuration.',
    '- install-command: a one-liner (npx …, /model …) when the fix is installing/enabling something.',
    '- behavioral-nudge: prose describing the habit to change, when there is NO artifact to add — the fix is the',
    '  user working differently (e.g. specifying scope upfront, verifying before accepting). Global behavior gaps',
    '  are usually nudges.',
    'Rules: address the SPECIFIC gap shown in the occurrences, not the theme title in the abstract. Reference the',
    'concrete things the user kept supplying/correcting. Do NOT invent file paths, tool names, or commands you',
    "were not shown — if you don't know an exact name, describe what to add. Keep it tight.",
    'For fix-prompt: write the prompt body only (diagnosis + task + "Done when:"); do NOT add any marker line —',
    'that is added automatically.',
  ].filter(Boolean).join('\n')

  const { data, usage: u } = await llm.completeStructured({ system, user, schema: fixSchema, toolName: TOOL_NAME, maxTokens: 2048 })
  usage = addUsage(usage, u)
  const fixType = oneOf(data.fix_type, FIX_TYPES, 'behavioral-nudge')
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  return { fix: content ? { fixType, content } : null, usage }
}

/** Stable hash of a theme's occurrence set (description-only) — the regenerate gate. */
export function occurrenceHash(descriptions: string[]): string {
  return contentHash([...descriptions].sort().join('|'))
}

/**
 * Hash-gated fix retrieval. The gate is computed from the occurrence DESCRIPTIONS
 * alone; only on a miss do we build the full occurrences (which hydrates session
 * blobs for the user-quote snippets) — so a quiet re-analyze reuses the cached fix
 * with zero hydration and zero LLM cost. Returns the fix (or null on failure/empty)
 * plus tokens spent.
 */
export async function ensureThemeFix(
  store: Store,
  llm: LlmClient,
  log: Logger,
  theme: {
    id: string; label: string; description: string | null; type: string; repo: string | null
    fixType: string | null; fixContent: string | null; fixHash: string | null
  },
  descriptions: string[],
  buildOccurrences: () => FixOccurrence[],
): Promise<{ fix: ThemeFix | null; usage: TokenUsage }> {
  const hash = occurrenceHash(descriptions)
  if (theme.fixHash === hash && theme.fixType && theme.fixContent) {
    // Unchanged since last generation — reuse the cached fix, no hydration, no LLM call.
    return { fix: { fixType: theme.fixType as FixType, content: theme.fixContent }, usage: emptyUsage() }
  }
  const { fix, usage } = await generateFix(llm, theme, buildOccurrences())
  if (fix) {
    store.setThemeFix(theme.id, fix.fixType, fix.content, hash)
    log.debug(`recurring-themes: generated ${fix.fixType} fix for "${theme.label}"`)
  }
  return { fix, usage }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = (typeof v === 'string' ? v.trim().toLowerCase() : '') as T
  return allowed.includes(s) ? s : fallback
}

const fixSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fix_type', 'content'],
  properties: {
    fix_type: { type: 'string', enum: FIX_TYPES as unknown as string[] },
    content: { type: 'string', description: 'The fix deliverable. For fix-prompt: the prompt body (no marker). For config/command: the exact block/command. For a nudge: the prose.' },
  },
}
