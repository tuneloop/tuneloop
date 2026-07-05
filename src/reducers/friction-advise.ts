import { contentHash } from '../core/hash'
import type { LlmClient, JsonSchema } from '../llm/types'
import type { Store } from '../store/store'
import type { Logger } from '../util/log'

/**
 * The topic ADVISE pass: turn each friction topic's remedy CLASS (add_doc /
 * add_skill / …) into a concrete 1–2 sentence recommendation, synthesized from
 * its member event descriptions. Runs after the merge pass (so advice attaches
 * to keepers) and is gated per topic on a hash of its descriptions — a topic
 * re-generates only when its member set changes, and a failed call leaves the
 * stamp untouched so it retries next analyze.
 */
const TOOL_NAME = 'record_topic_advice'
const BATCH = 10
const MAX_DESCRIPTIONS = 6 // distinct member descriptions shown per topic

interface Candidate {
  id: string
  label: string
  type: string
  remedy: string | null
  adviceHash: string | null
  descriptions: string[]
}

export async function runFrictionAdvise(store: Store, llm: LlmClient, log: Logger): Promise<void> {
  const stale = store.frictionAdviceCandidates().filter((c) => hashOf(c) !== c.adviceHash)
  if (stale.length === 0) return

  let written = 0
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH)
    const byId = new Map(batch.map((c) => [c.id, c]))
    try {
      const { data } = await llm.completeStructured({
        system:
          'You turn recurring "friction topics" — patterns of AI-coding-agent shortfalls mined from session ' +
          `transcripts — into concrete, actionable recommendations. Report via the ${TOOL_NAME} tool.`,
        user: [
          'Topics (label, coarse remedy class, then the distinct friction descriptions observed):',
          ...batch.map(topicBlock),
          '',
          'For EACH topic write `advice`: 1–2 imperative sentences naming the SPECIFIC artifact to create or',
          'change — the doc section to write, the skill to add, the tool/MCP server to wire up, or the prompt/',
          'instruction rule to set. Ground it in the descriptions; never restate the problem, never hedge',
          '("consider", "might"), never exceed two sentences.',
        ].join('\n'),
        schema: outputSchema,
        toolName: TOOL_NAME,
        maxTokens: 4096,
      })
      const items = Array.isArray((data as { advice?: unknown }).advice)
        ? ((data as { advice: Array<{ topic_id?: unknown; advice?: unknown }> }).advice)
        : []
      for (const it of items) {
        const c = typeof it.topic_id === 'string' ? byId.get(it.topic_id) : undefined
        const advice = typeof it.advice === 'string' ? it.advice.trim() : ''
        // Length gate: an over-long "recommendation" is the model rambling — skip
        // it unstamped so the topic retries rather than caching junk.
        if (!c || !advice || advice.length > 400) continue
        store.setFrictionAdvice(c.id, advice, hashOf(c))
        written++
      }
    } catch (err) {
      log.warn(`friction advise pass failed for batch ${i / BATCH + 1}: ${(err as Error).message}`)
    }
  }
  if (written > 0) log.info(`friction advise pass: ${written} recommendation(s) written`)
}

function hashOf(c: Candidate): string {
  // JSON array, not join('|'): descriptions are free LLM text, a separator could collide.
  return contentHash(JSON.stringify([...new Set(c.descriptions)].sort()))
}

function topicBlock(c: Candidate): string {
  const seen = [...new Set(c.descriptions)]
  const lines = seen.slice(0, MAX_DESCRIPTIONS).map((d) => `    - ${d}`)
  if (seen.length > MAX_DESCRIPTIONS) lines.push(`    - … +${seen.length - MAX_DESCRIPTIONS} similar`)
  return [`- [${c.id}] ${c.label} (${c.type}, remedy class: ${c.remedy || 'none'})`, ...lines].join('\n')
}

const outputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['advice'],
  properties: {
    advice: {
      type: 'array',
      description: 'One entry per topic listed in the input.',
      items: {
        type: 'object',
        properties: {
          topic_id: { type: 'string', description: 'The [id] of the topic this advice is for.' },
          advice: { type: 'string', description: '1–2 imperative sentences naming the specific fix.' },
        },
      },
    },
  },
}
