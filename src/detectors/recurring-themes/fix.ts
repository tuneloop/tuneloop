import { contentHash } from '../../core/hash'
import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'
import type { LlmClient, JsonSchema } from '../../llm/types'
import type { Logger } from '../../util/log'
import type { Store } from '../../store/store'
import { buildEnvInventory, hasInventory, type EnvInventory } from './env-inventory'

const TOOL_NAME = 'draft_fix'
// Cached in fix_type when the fix pass vetoed a theme, so a quiet re-analyze skips the
// LLM call; re-evaluated on the next occurrence-hash change.
const VETOED = '__vetoed__'
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

/**
 * The fix pass's verdict on one theme. `worthSurfacing` is an LLM veto ON TOP of the
 * mechanical recurrence threshold: the fix pass reads every occurrence, so it can
 * judge "this crossed the count but isn't a generalizable gap worth a fix" (a
 * clustered one-off, taste iteration, etc.) and suppress the insight — with a reason.
 */
export interface FixVerdict {
  worthSurfacing: boolean
  reason: string
  fix: ThemeFix | null
}

/** One occurrence handed to the fix pass: the abstract description + the user's actual words. */
export interface FixOccurrence {
  description: string
  snippet?: string
}

/**
 * Generate an ACTUAL, tailored fix for one theme by reading all its occurrences and
 * the user's installed harness inventory (T3). The LLM chooses the remedy shape — use/
 * tighten an EXISTING skill/agent/MCP, install a new one, a config edit, a CLAUDE.md
 * (or equivalent agent-instructions) edit, or a behavioral nudge — grounded in what
 * the user actually has, so it references real tools instead of guessing. It also
 * decides whether the theme is even worth surfacing (a veto on the count threshold).
 * The most reasoning-heavy call in the detector — a candidate for a stronger model.
 */
export async function generateFix(
  llm: LlmClient,
  theme: { label: string; description: string | null; type: string; repo: string | null },
  occurrences: FixOccurrence[],
  inventory: EnvInventory,
): Promise<{ verdict: FixVerdict; usage: TokenUsage }> {
  let usage = emptyUsage()
  const scope = theme.repo ? `the ${theme.repo} project` : 'the user (across projects)'
  const shown = occurrences.slice(0, MAX_FIX_OCCURRENCES)
  const occLines = shown
    .map((o, i) => `${i + 1}. ${o.description}${o.snippet ? `\n   user said: "${clip(o.snippet, 400)}"` : ''}`)
    .join('\n')
  const moreNote = occurrences.length > shown.length ? ` (showing ${shown.length} of ${occurrences.length})` : ''

  const system =
    'You write a single, concrete FIX for a recurring friction pattern between a developer and their AI coding ' +
    'agent. You are given the pattern, every observed occurrence (with the user\'s actual words), and an inventory ' +
    'of what the user ALREADY HAS installed in their agent (skills, sub-agents, MCP servers, plugins). Produce the ' +
    `most effective remedy and its exact content via the ${TOOL_NAME} tool. Be specific and actionable — the user ` +
    'should be able to apply it directly, not read generic advice. You also judge whether the pattern is even worth ' +
    'surfacing as an insight.'

  const user = [
    `Friction theme: ${theme.label}`,
    theme.description ? `Definition: ${theme.description}` : '',
    `Type: ${theme.type} · Scope: ${scope}`,
    '',
    `Observed ${occurrences.length} time(s)${moreNote}:`,
    occLines,
    '',
    inventorySection(inventory),
    '',
    'FIRST decide worth_surfacing. It is TRUE only if this is a genuine, GENERALIZABLE recurring gap worth acting',
    'on. Set it FALSE for: a one-off (or two) that happened to cluster, taste/preference iteration, a pattern too',
    'vague to act on, or anything a fix would not actually prevent. When FALSE, give a one-line reason and skip the',
    'fix. Better to surface nothing than a weak insight.',
    '',
    'If worth surfacing, choose the fix_type that will actually stop this recurring — PREFER what the user already',
    'has over adding something new:',
    '- fix-prompt: a self-contained prompt the user pastes into their agent to make a durable change. This is where',
    '  you USE the inventory: "invoke your existing <skill>", "tighten the description of your <agent>", "wire your',
    '  <mcp> server into this flow", or — only when nothing installed fits — add a section to the agent-instructions',
    '  file (CLAUDE.md / AGENTS.md / equivalent). Write the full prompt body: diagnosis + task + a "Done when:" line.',
    '- config-snippet: a ready-to-paste settings.json / .mcp.json block, when the fix is pure configuration.',
    '- install-command: a one-liner (npx …, /model …) — use ONLY when the capability is genuinely missing from the',
    '  inventory; if the user already has a skill/tool for it, reference that instead of installing a duplicate.',
    '- behavioral-nudge: prose describing the habit to change, when there is NO artifact that helps — the fix is the',
    '  user working differently (e.g. specifying scope upfront, verifying before accepting). Global behavior gaps',
    '  are often nudges.',
    'Rules: address the SPECIFIC gap shown in the occurrences, not the theme title in the abstract. Reference the',
    'concrete things the user kept supplying/correcting, and the concrete inventory items by name. Do NOT invent',
    'file paths, tool, or skill names you were not shown — if unsure of an exact name, describe what to add. Keep it',
    'tight. For fix-prompt: write the prompt body only (no marker line — that is added automatically).',
  ].filter(Boolean).join('\n')

  const { data, usage: u } = await llm.completeStructured({ system, user, schema: fixSchema, toolName: TOOL_NAME, maxTokens: 2048 })
  usage = addUsage(usage, u)
  const worthSurfacing = data.worth_surfacing !== false // default true (only an explicit false vetoes)
  const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
  if (!worthSurfacing) return { verdict: { worthSurfacing: false, reason, fix: null }, usage }
  const fixType = oneOf(data.fix_type, FIX_TYPES, 'behavioral-nudge')
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  return { verdict: { worthSurfacing: true, reason, fix: content ? { fixType, content } : null }, usage }
}

/** The "what you already have" block; explicit when empty so the model doesn't invent tools. */
function inventorySection(inv: EnvInventory): string {
  if (!hasInventory(inv)) {
    return 'Installed agent inventory: (none captured — do NOT reference specific skills/tools by name; ' +
      'prefer an agent-instructions edit or a behavioral nudge, or describe the tool to add generically).'
  }
  const lines = [`Installed agent inventory (from ${inv.scopes.join(', ')}) — prefer these over adding new things:`]
  if (inv.skills.length) lines.push(`- Skills: ${inv.skills.join('; ')}`)
  if (inv.agents.length) lines.push(`- Sub-agents: ${inv.agents.join('; ')}`)
  if (inv.mcpServers.length) lines.push(`- MCP servers: ${inv.mcpServers.join(', ')}`)
  if (inv.plugins.length) lines.push(`- Plugins: ${inv.plugins.join(', ')}`)
  return lines.join('\n')
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
): Promise<{ verdict: FixVerdict; usage: TokenUsage }> {
  const hash = occurrenceHash(descriptions)
  if (theme.fixHash === hash && theme.fixType) {
    // Unchanged since last generation — reuse the cached verdict, no hydration, no LLM.
    if (theme.fixType === VETOED) return { verdict: { worthSurfacing: false, reason: '', fix: null }, usage: emptyUsage() }
    if (theme.fixContent) return { verdict: { worthSurfacing: true, reason: '', fix: { fixType: theme.fixType as FixType, content: theme.fixContent } }, usage: emptyUsage() }
  }
  const inventory = buildEnvInventory(store, theme.repo)
  const { verdict, usage } = await generateFix(llm, theme, buildOccurrences(), inventory)
  if (verdict.fix) {
    store.setThemeFix(theme.id, verdict.fix.fixType, verdict.fix.content, hash)
    log.debug(`recurring-themes: generated ${verdict.fix.fixType} fix for "${theme.label}"`)
  } else if (!verdict.worthSurfacing) {
    // Cache the veto so a quiet re-analyze doesn't re-ask; re-evaluated on a hash miss.
    store.setThemeFix(theme.id, VETOED, verdict.reason || 'not worth surfacing', hash)
    log.debug(`recurring-themes: fix pass vetoed "${theme.label}" — ${verdict.reason || 'not worth surfacing'}`)
  }
  return { verdict, usage }
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
  required: ['worth_surfacing'],
  properties: {
    worth_surfacing: { type: 'boolean', description: 'TRUE only if this is a genuine, generalizable recurring gap worth acting on; FALSE for one-offs, taste iteration, or patterns too vague to fix.' },
    reason: { type: 'string', description: 'One line: why it is (or is not) worth surfacing.' },
    fix_type: { type: 'string', enum: FIX_TYPES as unknown as string[], description: 'Omit when worth_surfacing is false.' },
    content: { type: 'string', description: 'The fix deliverable (omit when worth_surfacing is false). For fix-prompt: the prompt body (no marker). For config/command: the exact block/command. For a nudge: the prose.' },
  },
}
