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

/** Build a session interleaving user turns, assistant text, and skill/other tool calls.
 *  A step with `agent` is a sidechain event in that subagent's thread (its tool call is
 *  sidechain too); main-thread steps carry a seq, sidechain steps don't (as in real data). */
function buildSession(steps: Array<{ user?: string; assistant?: string; skill?: string; tool?: string; agent?: string }>): Session {
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  let seq = 0
  for (const step of steps) {
    const side = step.agent != null
    const base = side ? { isSidechain: true, agentId: step.agent } : { isSidechain: false, seq: seq++ }
    if (step.user != null) {
      events.push({ kind: 'user', text: step.user, blocks: [], ...base })
    } else {
      const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = []
      if (step.assistant) blocks.push({ type: 'text', text: step.assistant })
      const name = step.skill ?? step.tool
      let id = ''
      if (name) {
        id = `t${toolCalls.length}`
        blocks.push({ type: 'tool_use', id, name, input: {} })
      }
      events.push({ kind: 'assistant', blocks, usage: emptyUsage(), ...base })
      if (name) {
        toolCalls.push({
          id,
          name,
          action: (step.skill ? 'skill' : 'shell') as CanonicalAction,
          input: {},
          target: {},
          result: { ok: true, isError: false },
          isSidechain: side,
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

  it('skips a sidechain firing with no thread identity (agentId missing)', async () => {
    // The tool call is sidechain but its containing event has no agentId — we can't
    // reconstruct its thread, so it must be skipped, not judged against interleaved noise.
    const s = buildSession([{ assistant: 'a', skill: 'review' }])
    s.toolCalls[0]!.isSidechain = true
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(r.annotations).toBeUndefined()
    expect(llm.calls.length).toBe(0)
  })

  it('judges a subagent firing within its own thread, excluding other threads', async () => {
    const s = buildSession([
      { user: 'main: run the task' },
      { assistant: 'spawning a subagent' },
      { assistant: 'sub reasoning before', agent: 'a1' },
      { assistant: 'running review', skill: 'review', agent: 'a1' }, // toolCalls[0], sidechain
      { assistant: 'MAIN thread interleaved noise' },
      { assistant: 'sub applies the review output', agent: 'a1' },
      { assistant: 'OTHER subagent noise', agent: 'a2' },
      { assistant: 'sub finishes and reports', agent: 'a1' },
    ])
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: 'applied it' }])
    const r = await skillOutcomes.run(ctx(s, llm))
    expect(llm.calls.length).toBe(1)
    const sent = llm.calls[0]!.user
    expect(sent).toContain('the review skill fired here')
    expect(sent).toContain('inside a subagent thread') // the firing is labelled for the model
    expect(sent).toContain('sub applies the review output') // its own thread, after the firing
    expect(sent).toContain('sub reasoning before') // leading context from the same thread
    expect(sent).not.toContain('MAIN thread interleaved noise') // other threads excluded
    expect(sent).not.toContain('OTHER subagent noise')
    const verdicts = r.annotations?.find((a) => a.key === 'skill_outcomes')?.value as SkillOutcomeVerdict[]
    expect(verdicts[0]).toMatchObject({ idx: 0, name: 'review', outcome: 'used' })
  })

  it('a subagent thread ending closes the window — no truncation note', async () => {
    const s = buildSession([
      { assistant: 'sub work', skill: 'review', agent: 'a1' },
      { assistant: 'sub done', agent: 'a1' }, // thread ends here; the session continues
      ...Array.from({ length: 20 }, (_, i) => ({ assistant: `main continues ${i}` })),
    ])
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    await skillOutcomes.run(ctx(s, llm))
    const sent = llm.calls[0]!.user
    // The subagent finished — a genuinely closed episode, not a cut-off view.
    expect(sent).not.toContain('window truncated here')
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

  it('anchors a synthetic (message-recorded) firing by timestamp', async () => {
    // Explicit invocations (/skill, $skill, /skill:name) synthesize a tool call with NO
    // matching tool_use block — the window must anchor on the nearest same-thread event by ts.
    const s = buildSession([
      { user: 'run the helper' },
      { assistant: 'expanding the skill body' },
      { assistant: 'agent applies the skill steps' },
      { user: 'great, next task' },
    ])
    s.events.forEach((ev, i) => { ev.ts = `2026-07-01T00:0${i}:00Z` })
    s.toolCalls.push({
      id: 'skill-0', name: 'helper', action: 'skill', input: {}, target: {},
      result: { ok: true, isError: false }, isSidechain: false, ts: '2026-07-01T00:01:00Z',
    })
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    await skillOutcomes.run(ctx(s, llm))
    const sent = llm.calls[0]!.user
    expect(sent).toContain('the helper skill fired here')
    expect(sent).toContain('agent applies the skill steps') // real context, not the fallback
    expect(sent).not.toContain('(context unavailable)')
  })

  it('bounds a window at the next skill firing even without a Claude-style Skill block', async () => {
    // OpenCode's real skill calls use a lowercase block name, and Codex/Pi synthetics have
    // no block at all — the boundary must come from the collected firings, not block names.
    const s = buildSession([
      { user: 'go' },
      { assistant: 'first', skill: 'alpha' }, // toolCalls[0]
      { assistant: 'between work' },
      { assistant: 'second', skill: 'beta' }, // toolCalls[1] — bounds alpha's window
      { assistant: 'after the second skill' },
    ])
    const llm = stubLlm([
      { idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' },
      { idx: 1, outcome: 'used', userCorrectionAdjacent: false, evidence: '' },
    ])
    await skillOutcomes.run(ctx(s, llm))
    const alphaBlock = llm.calls[0]!.user.split('--- firing idx=1')[0]!
    expect(alphaBlock).toContain('[calls beta]') // the boundary line itself is included
    expect(alphaBlock).not.toContain('after the second skill') // but nothing past it
  })

  it('anchors a sidechain synthetic firing in its subagent thread by timestamp', async () => {
    // Codex subagent threads record explicit invocations as synthetics too — they must be
    // judged (in-thread), not dropped for lacking a tool_use block.
    const s = buildSession([
      { user: 'main thread ask' },
      { assistant: 'sub working', agent: 'a1' },
      { assistant: 'sub applies the skill output', agent: 'a1' },
    ])
    s.events.forEach((ev, i) => { ev.ts = `2026-07-01T00:0${i}:00Z` })
    s.toolCalls.push({
      id: 'skill-0', name: 'helper', action: 'skill', input: {}, target: {},
      result: { ok: true, isError: false }, isSidechain: true, ts: '2026-07-01T00:01:00Z',
    })
    const llm = stubLlm([{ idx: 0, outcome: 'used', userCorrectionAdjacent: false, evidence: '' }])
    await skillOutcomes.run(ctx(s, llm))
    expect(llm.calls.length).toBe(1) // judged, not skipped
    const sent = llm.calls[0]!.user
    expect(sent).toContain('inside a subagent thread')
    expect(sent).toContain('sub applies the skill output')
    expect(sent).not.toContain('main thread ask') // anchored in the sidechain thread
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
