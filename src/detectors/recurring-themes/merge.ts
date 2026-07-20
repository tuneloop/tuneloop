import { contentHash } from '../../core/hash'
import type { LlmClient, JsonSchema } from '../../llm/types'
import type { Logger } from '../../util/log'
import type { Store } from '../../store/store'
import type { ThemeRef } from '../../store/types'
import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'
import { DETECTOR, clampLabel, themeId as makeThemeId } from './ids'
import { TYPES } from './prompt'

const HASH_KEY = 'recurring_themes_merge_hash'
const TOOL_NAME = 'reconcile_taxonomy'
// Runaway guard on orphan events per call (each is ~one sentence, so this is a
// small prompt). On overflow the NEWEST go first and the rest are logged, not
// dropped — later runs drain them as clustered orphans leave the pool.
const MAX_ORPHANS = 1000

/**
 * The taxonomy-reconcile pass: the only step that sees ALL themes and all
 * still-unclustered ("orphan") friction events at once. One LLM call decides, per
 * canonical gap: which existing themes are duplicates to fuse, the surviving label/
 * description, and which orphan events belong to it (matching an existing theme or
 * minting a new one). Merging + orphan-assignment are the same judgment — an orphan
 * can be the evidence that two themes are one — so they share a call.
 *
 * Gated on a hash of the theme-id set AND the orphan set: a re-run that changed
 * neither is a no-op. Legality: a merge is same-repo, or a GLOBAL keeper absorbing
 * a repo-scoped duplicate — never the reverse, never across repos. A failed call
 * leaves the gate unstamped so the pass retries next analyze.
 *
 * Returns the token usage it spent and the number of themes absorbed + orphans
 * assigned (the "applied" count, for logging).
 */
export async function runThemeMerge(
  store: Store,
  llm: LlmClient,
  log: Logger,
): Promise<{ usage: TokenUsage; applied: number }> {
  let usage = emptyUsage()
  const themes = store.allThemes()
  const allOrphans = store.orphanThemeEvents()
  if (themes.length < 2 && allOrphans.length === 0) return { usage, applied: 0 }

  const sigOf = (ts: ThemeRef[], os: Array<{ sessionId: string; idx: number }>) =>
    contentHash(ts.map((t) => t.id).sort().join('|') + '#' + os.map((o) => `${o.sessionId}:${o.idx}`).sort().join('|'))
  if (store.getMeta(HASH_KEY) === sigOf(themes, allOrphans)) return { usage, applied: 0 } // unchanged since last pass

  // Cap orphans per call (runaway guard); the rest drain on later runs.
  const orphans = allOrphans.slice(0, MAX_ORPHANS)
  if (allOrphans.length > orphans.length) {
    log.warn(`recurring-themes: ${allOrphans.length} orphan events; reconciling ${orphans.length} this run, rest deferred`)
  }

  const byId = new Map(themes.map((t) => [t.id, t]))
  const byRef = new Map(orphans.map((o) => [`${o.sessionId}#${o.idx}`, o]))

  let clusters: Array<Cluster> = []
  try {
    const { data, usage: u } = await llm.completeStructured({
      system:
        'You curate a taxonomy of "friction themes" — RECURRING patterns where an AI coding agent fell short and ' +
        'the user had to compensate. A theme is a pattern seen ACROSS sessions, never a single incident. You are ' +
        'given the current themes and friction events not yet attached to any theme, and you tidy the taxonomy via ' +
        `the ${TOOL_NAME} tool: fuse themes that describe the SAME underlying gap — rolling several specific ` +
        'instances up into the one general pattern behind them — and attach an unassigned event when it is a real ' +
        'recurrence of a known gap. Merge by shared gap, not shared topic; when a merge is genuinely doubtful leave ' +
        'it, but do NOT leave an obvious recurring pattern scattered across near-identical themes.',
      user: buildUser(themes, orphans),
      schema: reconcileSchema,
      toolName: TOOL_NAME,
      maxTokens: 4096,
    })
    usage = addUsage(usage, u)
    clusters = Array.isArray((data as { themes?: unknown }).themes) ? (data as { themes: Array<Cluster> }).themes : []
  } catch (err) {
    log.warn(`theme reconcile pass failed: ${(err as Error).message}`)
    return { usage, applied: 0 } // gate unstamped → retried next analyze
  }

  let applied = 0
  for (const c of clusters) {
    applied += applyCluster(store, c, byId, byRef)
  }

  // Stamp the POST-pass signature so the next no-op analyze skips. (Reached only on
  // a successful call — a throw returns above, leaving the gate unstamped.)
  store.setMeta(HASH_KEY, sigOf(store.allThemes(), store.orphanThemeEvents()))
  if (applied > 0) log.info(`theme reconcile pass: ${applied} change(s) (merges + orphan assignments)`)
  return { usage, applied }
}

/**
 * Apply one canonical-gap cluster: pick/mint the keeper, fold duplicate themes into
 * it, rewrite its wording, and attach the orphan events. Returns how many discrete
 * changes it made (merges + assignments), for the run's "applied" tally. Every
 * mutation is guarded — an illegal merge or a stale id is skipped, never fatal.
 */
function applyCluster(
  store: Store,
  c: Cluster,
  byId: Map<string, ThemeRef>,
  byRef: Map<string, { sessionId: string; idx: number; repo: string | null; type: string }>,
): number {
  let applied = 0
  const label = str(c.label)
  const description = str(c.description)
  const mergeIds = (Array.isArray(c.merge_ids) ? c.merge_ids : []).filter((x): x is string => typeof x === 'string' && byId.has(x))
  const orphanRefs = (Array.isArray(c.orphan_refs) ? c.orphan_refs : []).filter((x): x is string => typeof x === 'string' && byRef.has(x))

  // Resolve the keeper: an explicit valid keep_id, else the first merge id the LLM
  // listed (the prompt asks it to name the better/older survivor first), else mint a
  // new theme. Minting requires 2+ orphans: a theme is a recurrence, so one lone
  // incident must NOT coin one (it stays unassigned and can join a theme if it
  // recurs). Nothing to key on → skip the cluster.
  let keeper: ThemeRef | undefined
  const keepId = str(c.keep_id)
  if (keepId && byId.has(keepId)) keeper = byId.get(keepId)
  else if (mergeIds.length) keeper = byId.get(mergeIds[0]!)
  else if (label && orphanRefs.length >= 2) {
    keeper = mintTheme(store, byId, label, description, c.project_specific === true, orphanRefs, byRef)
  }
  if (!keeper) return 0

  // Fold every other referenced theme into the keeper (legality-guarded per drop).
  for (const dropId of mergeIds) {
    if (dropId === keeper.id) continue
    const drop = byId.get(dropId)
    if (!drop) continue
    const legal = keeper.repo === drop.repo || keeper.repo == null // same repo, or global keeper absorbs repo-scoped
    if (!legal) continue
    if (store.applyThemeMerge(keeper.id, dropId)) {
      byId.delete(dropId)
      applied++
      // The dropped id is gone; retire its insight so it doesn't linger as a frozen duplicate.
      store.retireInsightForTheme(DETECTOR, dropId)
    }
  }

  // Reword an EXISTING keeper if the pass proposed clearer text; a freshly-minted
  // theme already carries this label/description.
  const minted = !keepId && !mergeIds.length
  if (!minted && (label || description)) {
    store.retitleTheme(keeper.id, label ? clampLabel(label) : undefined, description || undefined)
  }

  // Attach the orphan events to the keeper.
  for (const ref of orphanRefs) {
    const o = byRef.get(ref)!
    store.assignThemeEvent(o.sessionId, o.idx, keeper.id)
    byRef.delete(ref)
    applied++
  }

  return applied
}

/** Mint a new derived theme for an orphan cluster and register it in `byId`. */
function mintTheme(
  store: Store,
  byId: Map<string, ThemeRef>,
  label: string,
  description: string,
  projectSpecific: boolean,
  orphanRefs: string[],
  byRef: Map<string, { sessionId: string; idx: number; repo: string | null; type: string }>,
): ThemeRef {
  // Repo scope for a project-specific theme: the orphans' shared repo (only when
  // they all agree — a cross-repo cluster is inherently global). Else global.
  const repos = new Set(orphanRefs.map((r) => byRef.get(r)?.repo).filter((x): x is string => x != null))
  const repo = projectSpecific && repos.size === 1 ? [...repos][0]! : null
  const clean = clampLabel(label)
  const id = makeThemeId(clean, repo, repo != null)
  if (!byId.has(id)) {
    // Type/remedy: inherit the first orphan's type; remedy left unset (fix pass infers).
    const firstType = orphanRefs.map((r) => byRef.get(r)?.type).find(Boolean)
    store.ensureTheme({
      id,
      label: clean,
      description: description || undefined,
      type: oneOf(firstType, TYPES, 'other'),
      repo: repo ?? undefined,
    })
    byId.set(id, { id, label: clean, description: description || null, type: oneOf(firstType, TYPES, 'other'), repo })
  }
  return byId.get(id)!
}

function buildUser(themes: ThemeRef[], orphans: Array<{ sessionId: string; idx: number; type: string; description: string }>): string {
  return [
    'Existing friction themes (oldest first):',
    themes.length ? themes.map((t) => `- [${t.id}] ${t.label}${t.description ? ` — ${t.description}` : ''} (${t.type}${t.repo ? `, repo ${t.repo}` : ', global'})`).join('\n') : '(none yet)',
    '',
    'Unassigned friction events (event_ref is opaque — echo it back exactly):',
    orphans.length ? orphans.map((o) => `- event_ref=${o.sessionId}#${o.idx} (${o.type}): ${o.description}`).join('\n') : '(none)',
    '',
    'Return one entry per action. Prefer the least invasive action, in this order — most entries will be the',
    'first two, many runs return an empty list:',
    '1. MERGE themes for one gap: set merge_ids to two or more existing theme ids that name the SAME underlying gap,',
    '   INCLUDING several specific instances of one general pattern — fold them up into that pattern. E.g. three',
    '   themes each naming a different fact the agent asserted without checking are one gap (the agent states',
    '   unverified claims as fact) — merge them. But merge by shared GAP (what the agent keeps doing), not merely',
    '   shared topic: two different mistakes in the same area are two gaps, not one. Set keep_id to the survivor, or',
    '   set label+description to name the general pattern the merged specifics share; omit keep_id to keep the oldest.',
    '2. ATTACH an orphan to an EXISTING theme: set keep_id to that theme and list the event_ref(s) in orphan_refs.',
    '   Do this when the event is another occurrence of that theme\'s gap (its general pattern, not only its exact wording).',
    '3. MINT a new theme from orphans — ONLY when TWO OR MORE orphans independently describe the SAME recurring',
    '   gap that no existing theme covers. Set label + description and list all their orphan_refs. Never mint from',
    '   a single orphan: one incident is not a recurrence, and it can join a theme later if it happens again.',
    'label/description may also REWORD a kept/merged theme so it best captures its members (omit to keep as-is).',
    'project_specific: TRUE only if the gap is inherent to ONE project; FALSE (default) for general gaps.',
    'Leave an event unassigned whenever it does not clearly fit — a wrong match or a one-off theme is worse than',
    'an unassigned event. Most orphans stay unassigned; that is correct.',
  ].join('\n')
}

interface Cluster {
  merge_ids?: unknown
  keep_id?: unknown
  label?: unknown
  description?: unknown
  project_specific?: unknown
  orphan_refs?: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = (typeof v === 'string' ? v.trim().toLowerCase() : '') as T
  return allowed.includes(s) ? s : fallback
}

const reconcileSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      description: 'One entry per canonical gap to act on; [] when nothing needs consolidating.',
      items: {
        type: 'object',
        properties: {
          merge_ids: { type: 'array', items: { type: 'string' }, description: 'Existing theme ids to fuse (duplicates of one gap); 0, or 2+.' },
          keep_id: { type: 'string', description: 'Which existing id survives a merge; omit to keep the oldest.' },
          label: { type: 'string', description: 'Title-Case label — required to mint a NEW theme (needs 2+ orphan_refs), optional reword for a merged one.' },
          description: { type: 'string', description: 'One-sentence definition of the gap (for a new or reworded theme).' },
          project_specific: { type: 'boolean', description: 'TRUE only if the gap is inherent to one project; FALSE (default) for general gaps.' },
          orphan_refs: { type: 'array', items: { type: 'string' }, description: 'Unassigned event_refs that belong to this gap (echoed exactly); 2+ required when minting a new theme.' },
        },
      },
    },
  },
}
