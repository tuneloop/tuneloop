import { contentHash } from '../core/hash'
import type { LlmClient, JsonSchema } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'

/**
 * The topic MERGE pass — the only cross-session step in the pipeline. Once per
 * repo-group (repo topics + visible globals, plus a globals-only group), ask the
 * LLM to propose merges of DUPLICATE topics only, then re-point the absorbed
 * topic's events and delete it (Store.applyFrictionMerge). Gated on a hash of the
 * topic-id set, so a re-run with no new topics is a no-op by construction.
 * Legality: same repo, or a global keeper absorbing a repo-scoped duplicate —
 * never the reverse, never across repos. A failed call degrades to no merges and
 * skips the hash stamp so the pass retries next analyze.
 */
const MERGE_HASH_KEY = 'friction_merge_input_hash'
const TOOL_NAME = 'propose_topic_merges'

interface TopicRef {
  id: string
  label: string
  type: string
  repo: string | null
  source: string | null
}

export async function runFrictionMerge(store: Store, llm: LlmClient, log: Logger): Promise<void> {
  const topics = store.allFrictionTopics()
  if (topics.length < 2) return

  const hashOf = (ts: TopicRef[]) => contentHash(ts.map((t) => t.id).sort().join('|'))
  if (store.getMeta(MERGE_HASH_KEY) === hashOf(topics)) return // topic set unchanged since last pass

  // Repo groups (repo topics + visible globals) plus a globals-only group.
  const groups = new Map<string, TopicRef[]>()
  const globals = topics.filter((t) => t.repo == null)
  if (globals.length > 1) groups.set('(global)', globals)
  for (const t of topics) {
    if (t.repo == null) continue
    const g = groups.get(t.repo) ?? [...globals]
    if (!groups.has(t.repo)) groups.set(t.repo, g)
    g.push(t)
  }

  let applied = 0
  let anyFailed = false
  for (const [groupName, group] of groups) {
    if (group.length < 2) continue
    const byId = new Map(group.map((t) => [t.id, t]))
    let proposals: Array<{ keep_id?: unknown; drop_id?: unknown }> = []
    try {
      const { data } = await llm.completeStructured({
        system:
          'You maintain a taxonomy of "friction topics" — recurring patterns of AI-agent friction mined from ' +
          `coding sessions. Propose merges of DUPLICATE topics via the ${TOOL_NAME} tool.`,
        user: [
          `Friction topics for ${groupName}:`,
          ...group.map((t) => `- [${t.id}] ${t.label} (${t.type})`),
          '',
          'Propose a merge ONLY for topics that name the SAME specific gap in different words — duplicates or',
          'near-duplicates. Do NOT merge topics that are merely related, in the same area, or one broader than',
          'the other. When in doubt, do not merge. An empty list is the common, correct answer.',
          'keep_id should be the better-named (more concrete, actionable) topic of the pair; when both names',
          'are adequate, keep the OLDER topic (topics are listed oldest first) — a stable id keeps past',
          'sessions grouped the way they were originally reported.',
        ].join('\n'),
        schema: outputSchema,
        toolName: TOOL_NAME,
        maxTokens: 1024,
      })
      proposals = Array.isArray((data as { merges?: unknown }).merges)
        ? ((data as { merges: Array<{ keep_id?: unknown; drop_id?: unknown }> }).merges)
        : []
    } catch (err) {
      log.warn(`friction merge pass failed for ${groupName}: ${(err as Error).message}`)
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
      if (store.applyFrictionMerge(keep.id, drop.id)) {
        byId.delete(drop.id)
        applied++
        log.info(`friction: merged "${drop.label}" into "${keep.label}"`)
      }
    }
  }

  // Stamp the POST-merge topic set so the next analyze with no new topics no-ops.
  // Never stamp after a failed call — the unchanged set would suppress retries forever.
  if (!anyFailed) store.setMeta(MERGE_HASH_KEY, hashOf(store.allFrictionTopics()))
  if (applied > 0) log.info(`friction merge pass: ${applied} topic(s) absorbed`)
}

const outputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merges'],
  properties: {
    merges: {
      type: 'array',
      description: 'Duplicate-topic merges; [] when no topics are duplicates (the common case).',
      items: {
        type: 'object',
        properties: {
          keep_id: { type: 'string', description: 'Id of the topic to keep (the better-named one).' },
          drop_id: { type: 'string', description: 'Id of the duplicate topic to absorb into keep_id.' },
        },
      },
    },
  },
}
