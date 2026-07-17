import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'
import type { LlmClient, JsonSchema } from '../../llm/types'
import type { Logger } from '../../util/log'
import type { Followup } from './followups'

const TOOL_NAME = 'summarize_activity'

// Overflow budget. We never clip a user message; the only thing large enough to
// overflow is the agent-activity blocks (tool results are already excluded), so
// this rarely triggers. Over budget → summarize the middle windows (see below).
const BUDGET_TOKENS = 120_000
const HEAD_WINDOWS = 3
const TAIL_WINDOWS = 5

// Max activity text (chars) per summarization call. The middle can exceed any
// model's context, so we summarize it in chunks under this ceiling. ~4 chars/token
// → 400k ≈ 100k input tokens, inside a 200k model. Provider-agnostic (no per-model lookup).
const CHUNK_CHARS = 400_000

// Rough token estimate (~4 chars/token) — good enough to decide whether to summarize.
function estimateTokens(followups: Followup[]): number {
  let chars = 0
  for (const f of followups) chars += f.text.length + (f.activity?.length ?? 0)
  return Math.ceil(chars / 4)
}

/**
 * If the follow-up set is small enough, return it untouched (the common case). If
 * it would overflow the model, keep the first HEAD + last TAIL windows' activity
 * in full and replace the MIDDLE windows' activity with an LLM-written summary —
 * user turn text is NEVER touched, and the follow-up indices (which extracted
 * events reference as [n]) are preserved. The middle is summarized in chunks so
 * even a middle larger than the model's context fits (one call per chunk).
 */
export async function maybeSummarizeFollowups(
  followups: Followup[],
  llm: LlmClient,
  log: Logger,
): Promise<{ followups: Followup[]; usage: TokenUsage }> {
  let usage = emptyUsage()
  if (estimateTokens(followups) <= BUDGET_TOKENS) return { followups, usage }
  // Need a real middle to summarize (head + at least 1 + tail).
  if (followups.length <= HEAD_WINDOWS + TAIL_WINDOWS + 1) return { followups, usage }

  const middleStart = HEAD_WINDOWS
  const middleEnd = followups.length - TAIL_WINDOWS // exclusive
  const middle = followups.slice(middleStart, middleEnd)
  const blocks = middle
    .map((f, i) => (f.activity ? `--- window before follow-up [${middleStart + i + 1}] ---\n${f.activity}` : ''))
    .filter(Boolean)
  if (blocks.length === 0) return { followups, usage }

  log.debug(`recurring-themes: session over ${BUDGET_TOKENS} tok — summarizing ${middle.length} middle activity window(s)`)

  // Chunk the middle so each call's input fits the model, then summarize each chunk.
  const chunks = chunkBlocks(blocks, CHUNK_CHARS)
  const parts: string[] = []
  for (const chunk of chunks) {
    const { summary, usage: u } = await summarizeChunk(chunk, llm, log)
    usage = addUsage(usage, u)
    if (summary) parts.push(summary)
  }
  const summary = parts.length
    ? parts.join('\n\n')
    : '(agent activity in the middle of this session omitted for length)'

  // Rebuild: head windows full, one summary attached to the first middle window,
  // the rest of the middle with activity dropped, tail windows full.
  const out = followups.map((f, i) => {
    if (i < middleStart || i >= middleEnd) return f
    if (i === middleStart) return { ...f, activity: `[summary of agent activity from here through follow-up [${middleEnd}]]\n${summary}` }
    return { ...f, activity: undefined }
  })
  return { followups: out, usage }
}

/** Greedily pack activity blocks into chunks no larger than `maxChars`. A single
 *  block that alone exceeds the ceiling is hard-truncated (a lone tool dump that big
 *  is noise, not signal — and it must still fit one call). */
function chunkBlocks(blocks: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const b of blocks) {
    const block = b.length > maxChars ? b.slice(0, maxChars) + '\n… (truncated)' : b
    if (cur && cur.length + block.length + 2 > maxChars) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n\n${block}` : block
  }
  if (cur) chunks.push(cur)
  return chunks
}

async function summarizeChunk(
  activity: string,
  llm: LlmClient,
  log: Logger,
): Promise<{ summary: string; usage: TokenUsage }> {
  try {
    const { data, usage } = await llm.completeStructured({
      system:
        'You compress the AGENT-SIDE activity from the middle of a long AI coding session into a brief factual ' +
        `recap, so a friction analysis can still see what the agent was doing. Report via the ${TOOL_NAME} tool.`,
      user: [
        'Summarize what the agent DID and SAID across these windows in 4-8 sentences — the tasks it worked on,',
        'approaches it took, tools it ran, and anything it struggled with or got wrong. Keep it factual; do not',
        'invent detail. This replaces the raw activity, so preserve what a reviewer would need to judge whether',
        'the user had to compensate for the agent.',
        '',
        activity,
      ].join('\n'),
      schema: summarySchema,
      toolName: TOOL_NAME,
      maxTokens: 1024,
    })
    const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : ''
    return { summary, usage }
  } catch (err) {
    log.warn(`recurring-themes: activity summarization failed: ${(err as Error).message}`)
    return { summary: '', usage: emptyUsage() }
  }
}

const summarySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: 'A 4-8 sentence factual recap of the agent-side activity across the given windows.' },
  },
}
