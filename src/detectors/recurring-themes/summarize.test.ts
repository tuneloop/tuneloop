import { describe, expect, it } from 'vitest'
import { emptyUsage } from '../../core/model'
import { maybeSummarizeFollowups } from './summarize'
import type { Followup } from './followups'
import type { LlmClient, LlmResult, StructuredRequest } from '../../llm/types'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function fu(seq: number, text: string, activity?: string): Followup {
  return { seq, text, activity, errors: [], interrupted: null, skills: [] } as unknown as Followup
}

/** Records each call's input size; returns a canned summary. */
function summarizerLlm(): { llm: LlmClient; inputSizes: number[] } {
  const inputSizes: number[] = []
  const llm: LlmClient = {
    provider: 'anthropic',
    model: 'claude-fable-5',
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      inputSizes.push(req.user.length)
      return { data: { summary: 'recap of agent activity' }, usage: emptyUsage() }
    },
  }
  return { llm, inputSizes }
}

describe('maybeSummarizeFollowups', () => {
  it('leaves a small follow-up set untouched (no LLM call)', async () => {
    const followups = [fu(0, 'hi'), fu(1, 'do the thing', 'agent did a small thing')]
    const { llm, inputSizes } = summarizerLlm()
    const out = await maybeSummarizeFollowups(followups, llm, noopLog)
    expect(out.followups).toEqual(followups)
    expect(inputSizes).toHaveLength(0)
  })

  it('never touches user turn text, only middle activity', async () => {
    // 12 windows, each with a big activity block → over budget; head(3)+tail(5) kept.
    const big = 'x'.repeat(60_000)
    const followups = Array.from({ length: 12 }, (_, i) => fu(i, `user turn ${i}`, big))
    const { llm } = summarizerLlm()
    const out = await maybeSummarizeFollowups(followups, llm, noopLog)
    // Every user turn text is preserved verbatim, and indices stay aligned.
    out.followups.forEach((f, i) => expect(f.text).toBe(`user turn ${i}`))
    // Head windows keep full activity; the first middle window carries the summary.
    expect(out.followups[0]!.activity).toBe(big)
    expect(out.followups[3]!.activity).toContain('recap of agent activity')
    // Later middle windows have their activity dropped.
    expect(out.followups[4]!.activity).toBeUndefined()
  })

  it('chunks a middle larger than one call so no single call overflows', async () => {
    // A middle far bigger than CHUNK_CHARS (400k): 8 middle windows × 200k = 1.6M chars.
    const chunk = 'y'.repeat(200_000)
    const followups = Array.from({ length: 16 }, (_, i) => fu(i, `t${i}`, chunk))
    const { llm, inputSizes } = summarizerLlm()
    const out = await maybeSummarizeFollowups(followups, llm, noopLog)
    // More than one summarization call (the middle didn't fit in one)…
    expect(inputSizes.length).toBeGreaterThan(1)
    // …and no single call's input exceeded a safe ceiling (400k chars + small wrapper).
    for (const size of inputSizes) expect(size).toBeLessThan(420_000)
    // The summary landed on the first middle window.
    expect(out.followups[3]!.activity).toContain('recap of agent activity')
  })
})
