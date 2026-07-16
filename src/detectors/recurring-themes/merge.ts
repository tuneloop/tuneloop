import { contentHash } from '../../core/hash'
import type { LlmClient, JsonSchema } from '../../llm/types'
import type { Logger } from '../../util/log'
import type { Store } from '../../store/store'
import type { ThemeRef } from '../../store/types'
import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'

const MERGE_HASH_KEY = 'recurring_themes_merge_hash'
const TOOL_NAME = 'propose_theme_merges'

/**
 * The cross-session MERGE pass: the only step that looks at all themes at once.
 * Per repo-group (repo themes + visible globals, plus a globals-only group), ask
 * the LLM to propose merges of DUPLICATE themes only, re-point the absorbed
 * theme's events, and delete it. Gated on a hash of the theme-id set so a re-run
 * with no new themes is a no-op. Legality: same repo, or a global keeper
 * absorbing a repo-scoped duplicate — never the reverse, never across repos. A
 * failed call leaves the gate unstamped so the pass retries next analyze.
 *
 * Returns the token usage it spent and the number of themes absorbed.
 */
export async function runThemeMerge(
  store: Store,
  llm: LlmClient,
  log: Logger,
): Promise<{ usage: TokenUsage; applied: number }> {
  let usage = emptyUsage()
  const themes = store.allThemes()
  if (themes.length < 2) return { usage, applied: 0 }

  const hashOf = (ts: ThemeRef[]) => contentHash(ts.map((t) => t.id).sort().join('|'))
  if (store.getMeta(MERGE_HASH_KEY) === hashOf(themes)) return { usage, applied: 0 } // unchanged since last pass

  // Repo groups (repo themes + visible globals) plus a globals-only group.
  const groups = new Map<string, ThemeRef[]>()
  const globals = themes.filter((t) => t.repo == null)
  if (globals.length > 1) groups.set('(global)', globals)
  for (const t of themes) {
    if (t.repo == null) continue
    if (!groups.has(t.repo)) groups.set(t.repo, [...globals])
    groups.get(t.repo)!.push(t)
  }

  let applied = 0
  let anyFailed = false
  for (const [groupName, group] of groups) {
    if (group.length < 2) continue
    const byId = new Map(group.map((t) => [t.id, t]))
    let proposals: Array<{ keep_id?: unknown; drop_id?: unknown }> = []
    try {
      const { data, usage: u } = await llm.completeStructured({
        system:
          'You maintain a taxonomy of "friction themes" — recurring patterns of AI-agent friction mined from ' +
          `coding sessions. Propose merges of DUPLICATE themes via the ${TOOL_NAME} tool.`,
        user: [
          `Friction themes for ${groupName}:`,
          ...group.map((t) => `- [${t.id}] ${t.label}${t.description ? ` — ${t.description}` : ''} (${t.type})`),
          '',
          'Propose a merge ONLY for themes that name the SAME specific gap in different words — duplicates or',
          'near-duplicates. Do NOT merge themes that are merely related, in the same area, or one broader than',
          'the other. When in doubt, do not merge. An empty list is the common, correct answer.',
          'keep_id should be the better-named (more concrete, actionable) theme of the pair; when both names',
          'are adequate, keep the OLDER theme (themes are listed oldest first) — a stable id keeps past',
          'sessions grouped the way they were originally reported.',
        ].join('\n'),
        schema: mergeSchema,
        toolName: TOOL_NAME,
        maxTokens: 1024,
      })
      usage = addUsage(usage, u)
      proposals = Array.isArray((data as { merges?: unknown }).merges)
        ? (data as { merges: Array<{ keep_id?: unknown; drop_id?: unknown }> }).merges
        : []
    } catch (err) {
      log.warn(`theme merge pass failed for ${groupName}: ${(err as Error).message}`)
      anyFailed = true
      continue
    }

    for (const m of proposals) {
      const keep = typeof m.keep_id === 'string' ? byId.get(m.keep_id) : undefined
      const drop = typeof m.drop_id === 'string' ? byId.get(m.drop_id) : undefined
      if (!keep || !drop || keep.id === drop.id) continue
      // Same-repo merges only, except a GLOBAL keeper absorbing a repo duplicate.
      const legal = keep.repo === drop.repo || keep.repo == null
      if (!legal) continue
      if (store.applyThemeMerge(keep.id, drop.id)) {
        byId.delete(drop.id)
        applied++
      }
    }
  }

  // Stamp the POST-merge theme set so the next no-op analyze skips. Never stamp
  // after a failure — the unchanged set would suppress retries forever.
  if (!anyFailed) store.setMeta(MERGE_HASH_KEY, hashOf(store.allThemes()))
  if (applied > 0) log.info(`theme merge pass: ${applied} theme(s) absorbed`)
  return { usage, applied }
}

const mergeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merges'],
  properties: {
    merges: {
      type: 'array',
      description: 'Duplicate-theme merges; [] when no themes are duplicates (the common case).',
      items: {
        type: 'object',
        properties: {
          keep_id: { type: 'string', description: 'Id of the theme to keep (the better-named one).' },
          drop_id: { type: 'string', description: 'Id of the duplicate theme to absorb into keep_id.' },
        },
      },
    },
  },
}
