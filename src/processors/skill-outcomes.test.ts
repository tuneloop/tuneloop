/**
 * skill-outcomes processor tests. Uses a stub LLM (no network) to exercise the
 * firing collection, the one-call-per-session batch, the keyed-verdict mapping, and
 * the defensive normalization (bad idx, missing verdicts, invalid outcome).
 */

import { describe, expect, it } from 'vitest'
import { skillOutcomes } from './skill-outcomes'
import type { SkillOutcomeVerdict } from './skill-outcomes'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { ProcessorContext } from '../core/processor'
import type { LlmClient, StructuredRequest } from '../llm/types'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** Build a session interleaving user turns, assistant text, and skill/other tool calls. */
function buildSession(steps: Array<{ user?: string; assistant?: string; skill?: string; tool?: string }>): Session {
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  let seq = 0
  for (const step of steps) {
    if (step.user != null) {
      events.push({ kind: 'user', text: step.user, blocks: [], isSidechain: false, seq: seq++ })
    } else {
      const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = []
      if (step.assistant) blocks.push({ type: 'text', text: step.assistant })
      const name = step.skill ?? step.tool
      let id = ''
      if (name) {
        id = `t${toolCalls.length}`
        blocks.push({ type: 'tool_use', id, name, input: {} })
      }
      events.push({ kind: 'assistant', blocks, usage: emptyUsage(), isSidechain: false, seq: seq++ })
      if (name) {
        toolCalls.push({
          id,
          name,
          action: (step.skill ? 'skill' : 'shell') as CanonicalAction,
          input: {},
          target: {},
          result: { ok: true, isError: false },
          isSidechain: false,
        })
      }
    }
  }
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' },
    models: ['claude-haiku-4-5'],
    tokens: emptyUsage(),
    events,
    toolCalls,
    raw: { path: '', contentHash: 'h' },
  }
}

/** A stub LLM whose completeStructured is a spy returning the given verdicts. */
function stubLlm(verdicts: Array<Record<string, unknown>>): LlmClient & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = []
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    calls,
    async completeStructured(req: StructuredRequest) {
      calls.push(req)
      return { data: { verdicts }, usage: emptyUsage() }
    },
  }
}

function ctx(session: Session, llm: LlmClient | null): ProcessorContext {
  return {
    session,
    log,
    llmEnabled: !!llm,
    llm,
    existingFeatures: [],
    rejectedFeatureTitles: [],
    userLinkedArtifacts: [],
    prBlockAttributions: [],
    sh: async () => null,
  }
}

describe('skill-outcomes', () => {
  it('returns nothing when the session has no skill firings', async () => {
    const s = buildSession([{ user: 'hi' }, { assistant: 'ok', tool: 'Bash' }])
    const llm = stubLlm([])
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(r.annotations).toBeUndefined()
    expect(llm.calls.length).toBe(0) // no LLM call when there's nothing to classify
  })

  it('classifies all firings in ONE batched call and persists a keyed array', async () => {
    const s = buildSession([
      { user: 'review this' },
      { assistant: 'running review', skill: 'review' }, // toolCalls[0]
      { assistant: 'looks good, shipping' },
      { user: 'now browse the docs' },
      { assistant: 'browsing', skill: 'browse' }, // toolCalls[1]
      { assistant: 'here is the summary' },
    ])
    const llm = stubLlm([
      { idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: 'agent shipped after' },
      { idx: 1, outcome: 'reworked', userCorrectionAdjacent: true, evidence: 'agent redid the summary' },
    ])
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(llm.calls.length).toBe(1) // batched: one call for both firings
    const verdicts = r.annotations?.find((a) => a.key === 'skill_outcomes')?.value as SkillOutcomeVerdict[]
    expect(verdicts.length).toBe(2)
    expect(verdicts[0]).toMatchObject({ idx: 0, name: 'review', outcome: 'used', userCorrectionAdjacent: false })
    expect(verdicts[1]).toMatchObject({ idx: 1, name: 'browse', outcome: 'reworked', userCorrectionAdjacent: true })
    expect(r.selfCost).toBeDefined()
  })

  it('sends the skill name + a windowed context, not the whole transcript', async () => {
    const s = buildSession([
      { user: 'do it' },
      { assistant: 'sure', skill: 'review' },
      { assistant: 'done' },
    ])
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    await skillOutcomes.run(ctx(s, llm))
    const req = llm.calls[0]!
    expect(req.toolName).toBe('record_skill_outcomes')
    expect(req.user).toContain('idx=0')
    expect(req.user).toContain('review')
    expect(req.user).toContain('the review skill fired here')
  })

  it('drops verdicts for firings the model did not return (no fabrication)', async () => {
    const s = buildSession([
      { assistant: 'a', skill: 'review' }, // idx 0
      { assistant: 'b', skill: 'browse' }, // idx 1
    ])
    // Model only returned idx 0, and with an invalid outcome.
    const llm = stubLlm([{ idx: 0, outcome: 'nonsense', userCorrectionAdjacent: 'yes', evidence: 42 }])
    const r = await skillOutcomes.run(ctx(s, llm))
    const verdicts = r.annotations?.find((a) => a.key === 'skill_outcomes')?.value as SkillOutcomeVerdict[]
    expect(verdicts.length).toBe(1) // idx 1 dropped, not invented
    expect(verdicts[0]!.idx).toBe(0)
    expect(verdicts[0]!.outcome).toBe('unclear') // invalid enum coerced to the abstain value
    expect(verdicts[0]!.userCorrectionAdjacent).toBe(false) // non-bool coerced
    expect(verdicts[0]!.evidence).toBe('') // non-string coerced
  })

  it('records spend but no annotation when the model returns nothing usable', async () => {
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    const llm = stubLlm([]) // empty verdicts
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(r.annotations).toBeUndefined()
    expect(r.selfCost).toBeDefined()
  })

  it('is a no-op when no LLM is configured', async () => {
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    const r = await skillOutcomes.run(ctx(s, null))
    expect(r).toEqual({})
  })

  it('skips sidechain skill calls', async () => {
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    s.toolCalls[0]!.isSidechain = true
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(r.annotations).toBeUndefined()
    expect(llm.calls.length).toBe(0)
  })

  it('accepts insufficient-context as a distinct outcome (kept out of the noise later)', async () => {
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    const llm = stubLlm([{ idx: 0, outcome: 'insufficient-context', userCorrectionAdjacent: false, evidence: 'ends here' }])
    const r = await skillOutcomes.run(ctx(s, llm))
    const verdicts = r.annotations?.find((a) => a.key === 'skill_outcomes')?.value as SkillOutcomeVerdict[]
    expect(verdicts[0]!.outcome).toBe('insufficient-context') // preserved, NOT coerced to unclear
  })

  it('extends the window to the next user turn and shows a following interrupt as friction', async () => {
    const s = buildSession([
      { user: 'commit this' },
      { assistant: 'using the helper', skill: 'git-commit-helper' }, // idx 0
      { assistant: 'staging files' },
      { assistant: 'writing the message' },
      { user: '[Request interrupted by user]' }, // friction after the firing, before the next real turn
      { user: 'no, do it manually' },
      { assistant: 'ok, manually then' },
    ])
    const llm = stubLlm([{ idx: 0, outcome: 'reworked', userCorrectionAdjacent: true, evidence: '' }])
    await skillOutcomes.run(ctx(s, llm))
    const sent = llm.calls[0]!.user
    // The window reaches past the +4 events the old fixed window stopped at, up to the
    // next user turn — so the interrupt and the re-steer are both visible to the model.
    expect(sent).toContain('interrupted the agent')
    expect(sent).toContain('do it manually')
  })

  it('clips over-long evidence at a word boundary, never mid-word', async () => {
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    // A ~700-char run of "wordN" tokens — past the 500-char backstop budget.
    const longText = Array.from({ length: 120 }, (_, i) => 'word' + i).join(' ')
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: longText }])
    const r = await skillOutcomes.run(ctx(s, llm))
    const ev = (r.annotations?.find((a) => a.key === 'skill_outcomes')?.value as SkillOutcomeVerdict[])[0]!.evidence
    expect(ev.length).toBeLessThan(longText.length) // was trimmed
    // No word was cut in half: the visible text (minus a trailing …) ends on a whole token.
    expect(ev.replace(/…$/, '').trimEnd()).toMatch(/word\d+$/)
  })
})
