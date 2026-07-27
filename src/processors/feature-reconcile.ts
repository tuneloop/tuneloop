import { contentHash } from '../core/hash'
import { addUsage, emptyUsage, type TokenUsage } from '../core/model'
import { arrayField } from '../llm/json'
import { costOfUsage } from '../pricing/pricing'
import type { JsonSchema, LlmClient } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'

const HASH_KEY = 'feature_reconcile_hash'
const TOOL_NAME = 'reconcile_features'

type Feature = { id: string; title: string; repo: string | null; parentId: string | null; createdAt: string | null; sessions: number; glosses: string[] }

/**
 * The feature taxonomy-reconcile pass — the only step that sees ALL derived features
 * at once. Since enrich-session now proposes a feature per session with no cross-session
 * context, the same capability arrives under slightly different titles (distinct ids).
 * One LLM call groups those synonyms and lays out the parent/child hierarchy; we then
 * fold each group into a single canonical feature and set parents.
 *
 * The canonical of a group is the EARLIEST-minted member (by the feature's session-
 * derived created_at), so the survivor is the original and merges are time-stable.
 * Gated on a hash of the feature set (ids + titles + parents): a run that changed none
 * is a no-op. A failed call leaves the gate unstamped, so the pass retries next analyze.
 * Every mutation is guarded — an illegal or stale merge is skipped, never fatal.
 */
export async function reconcileFeatures(store: Store, llm: LlmClient, log: Logger): Promise<{ usage: TokenUsage; applied: number }> {
  let usage = emptyUsage()
  const features = store.derivedFeaturesForReconcile()
  if (features.length < 2) return { usage, applied: 0 }

  const sig = signatureOf(features)
  if (store.getMeta(HASH_KEY) === sig) return { usage, applied: 0 } // unchanged since last pass

  // Reference features by list number ([1], [2], …), not opaque ids — a number can't be
  // transcribed into a valid-but-wrong id (the same guard the theme reconcile uses).
  const numToId = new Map(features.map((f, i) => [i + 1, f.id]))
  const byId = new Map(features.map((f) => [f.id, f]))

  let groups: unknown[] = []
  let hierarchy: unknown[] = []
  try {
    const { data, usage: u } = await llm.completeStructured({
      system:
        'You curate a product-feature map. Each feature is one coherent capability. Features were proposed one session ' +
        'at a time with no shared context, so the SAME capability routinely appears several times under slightly ' +
        'different titles — catching those duplicates is your main job. Each feature lists a few example session intents ' +
        '("e.g. …"): judge sameness by what those sessions actually did, not by title wording alone. Via the ' +
        `${TOOL_NAME} tool: (1) GROUP every set of features that name the same capability so they fuse into one, and ` +
        '(2) lay out the hierarchy — which feature is a sub-capability of a broader one. Group by shared CAPABILITY ' +
        '(what the user accomplishes), not merely shared area: two genuinely different capabilities in the same domain ' +
        'stay separate, but do not leave obvious restatements of one capability unmerged. Every feature is tagged with ' +
        'its repo (or "global"): do NOT group features from two different repos — only a global feature may absorb a ' +
        'repo-scoped one.',
      user: buildUser(features),
      schema: reconcileSchema,
      toolName: TOOL_NAME,
      maxTokens: 4096,
    })
    usage = addUsage(usage, u)
    groups = arrayField(data, 'groups')
    hierarchy = arrayField(data, 'hierarchy')
  } catch (err) {
    log.warn(`feature reconcile pass failed: ${(err as Error).message}`)
    return { usage, applied: 0 } // gate unstamped → retried next analyze
  }

  let applied = 0
  const canonicalOf = new Map<string, string>() // absorbed id → surviving canonical id

  // 1. Fuse synonym groups. Canonical = earliest-minted member; a merge is legal only
  // within one repo, or a global feature absorbing a repo-scoped one.
  for (const g of groups) {
    const ids = toIds((g as { members?: unknown })?.members, numToId).filter((id) => byId.has(id))
    if (ids.length < 2) continue
    const canonical = pickCanonical(ids, byId)
    const keep = byId.get(canonical)!
    for (const id of ids) {
      if (id === canonical) continue
      const member = byId.get(id)!
      if (keep.repo !== member.repo && keep.repo != null) continue // cross-repo, non-global keeper → skip
      if (store.mergeFeature(id, canonical)) {
        canonicalOf.set(id, canonical)
        byId.delete(id)
        applied++
      }
    }
  }

  // Follow a merge chain to the surviving id (defensive; single-level in practice).
  const resolve = (id: string | undefined): string | undefined => {
    if (!id) return undefined
    let cur = id
    const seen = new Set<string>()
    while (canonicalOf.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = canonicalOf.get(cur)!
    }
    return byId.has(cur) ? cur : undefined
  }

  // 2. Assign hierarchy among the survivors (setFeatureParent guards self/user/cycles).
  for (const h of hierarchy) {
    const feat = resolve(numToId.get(num((h as { feature?: unknown })?.feature)))
    const parent = resolve(numToId.get(num((h as { parent?: unknown })?.parent)))
    if (!feat || !parent || feat === parent) continue
    if (store.setFeatureParent(feat, parent)) applied++
  }

  // Stamp the POST-pass signature so the next unchanged analyze skips (reached only on success).
  store.setMeta(HASH_KEY, signatureOf(store.derivedFeaturesForReconcile()))
  if (applied > 0) log.debug(`feature reconcile: ${applied} change(s) ($${costOfUsage(llm.provider, llm.model, usage).toFixed(2)})`)
  return { usage, applied }
}

function signatureOf(features: Feature[]): string {
  return contentHash(features.map((f) => `${f.id}:${f.title}:${f.parentId ?? ''}`).sort().join('|'))
}

/** Earliest-minted member wins (nulls last), tiebroken by more sessions, then id. */
function pickCanonical(ids: string[], byId: Map<string, Feature>): string {
  return [...ids].sort((a, b) => {
    const fa = byId.get(a)!
    const fb = byId.get(b)!
    const ca = fa.createdAt ?? '~' // '~' sorts after any ISO timestamp → nulls last
    const cb = fb.createdAt ?? '~'
    if (ca !== cb) return ca < cb ? -1 : 1
    if (fa.sessions !== fb.sessions) return fb.sessions - fa.sessions
    return a < b ? -1 : 1
  })[0]!
}

function toIds(v: unknown, numToId: Map<number, string>): string[] {
  return (Array.isArray(v) ? v : []).map((n) => numToId.get(num(n))).filter((x): x is string => !!x)
}

/** Coerce a feature reference to a positive integer list index, else 0 (never a valid [n]). */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : 0
}

function buildUser(features: Feature[]): string {
  const clampGloss = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s)
  return [
    'Features (reference each by its number [1], [2], …, oldest first). The "e.g." clause samples what',
    'the sessions under that feature actually did — use it to tell same-capability duplicates apart:',
    features
      .map((f, i) => {
        const scope = f.repo ? `repo ${f.repo}` : 'global'
        const gloss = f.glosses.length ? ` — e.g. ${f.glosses.map(clampGloss).join('; ')}` : ''
        return `[${i + 1}] ${f.title} (${scope})${gloss}`
      })
      .join('\n'),
    '',
    'Return, via the tool:',
    '- groups: each entry a set of two or more feature [numbers] that name the SAME capability (to be fused into one).',
    '  Judge sameness by the capability the sessions exercise — lean on the "e.g." example intents, not just title wording.',
    '  Scan the whole list for families of near-duplicate features and group each family. Omit a feature that has no match.',
    '  Do NOT group across different repos (only a "global" feature may join a repo-scoped one).',
    '- hierarchy: each entry { feature, parent } as two feature [numbers], when the first is a sub-capability of the',
    '  second. Reference any feature by its number even if you also grouped it; assign a parent only when the child is',
    '  genuinely a narrower part of the parent, not merely related.',
    'Leave groups/hierarchy empty when nothing needs consolidating.',
  ].join('\n')
}

const reconcileSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groups', 'hierarchy'],
  properties: {
    groups: {
      type: 'array',
      description: 'Synonym clusters; each is 2+ feature [numbers] that name the same capability. [] when none.',
      items: {
        type: 'object',
        properties: {
          members: { type: 'array', items: { type: 'integer' }, description: 'Feature [numbers] to fuse (same capability); 2 or more.' },
        },
      },
    },
    hierarchy: {
      type: 'array',
      description: 'Parent/child links between features; [] when none.',
      items: {
        type: 'object',
        properties: {
          feature: { type: 'integer', description: 'The child feature [number].' },
          parent: { type: 'integer', description: 'The broader feature [number] it nests under.' },
        },
      },
    },
  },
}
