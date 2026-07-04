import { describe, expect, it } from 'vitest'
import { enrichSession } from './enrich-session'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { ProcessorContext, ShResult } from '../core/processor'
import type { LlmClient } from '../llm/types'

// A session: one leading user turn, then one assistant message per shell command
// (each command is a tool_use whose result feeds parsePrRefs / block detection).
function buildSession(commands: Array<{ command: string; raw?: string }>): Session {
  const events: Event[] = [{ kind: 'user', text: 'take a look at this', blocks: [], isSidechain: false, seq: 0 }]
  const toolCalls: ToolCall[] = []
  commands.forEach((c, i) => {
    const id = `t${i}`
    events.push({
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id, name: 'Bash', input: { command: c.command } }],
      usage: emptyUsage(),
      isSidechain: false,
      seq: i + 1,
    })
    toolCalls.push({
      id,
      name: 'Bash',
      action: 'shell' as CanonicalAction,
      input: { command: c.command },
      target: { command: c.command },
      result: { ok: true, isError: false, raw: c.raw },
      isSidechain: false,
    })
  })
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

// An LLM stub that labels every block `review` — the use-case half the gate needs.
function reviewingLlm(blocks: number): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    async completeStructured() {
      return {
        data: {
          complexity: 'routine',
          autonomy: 'autonomous',
          intent_summary: 'review a PR',
          decisions: [],
          success: 'unknown',
          features: [],
          feature_revisions: [],
          use_case_runs: [{ from: 0, to: Math.max(0, blocks - 1), use_case: 'review' }],
          feature_runs: [],
        },
        usage: emptyUsage(),
      }
    },
  }
}

// Interleave user turns with commands — a real user turn opens a new block.
function buildMixedSession(steps: Array<{ user: string } | { command: string; raw?: string }>): Session {
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  let cmd = 0
  steps.forEach((step, seq) => {
    if ('user' in step) {
      events.push({ kind: 'user', text: step.user, blocks: [], isSidechain: false, seq })
      return
    }
    const id = `t${cmd++}`
    events.push({
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id, name: 'Bash', input: { command: step.command } }],
      usage: emptyUsage(), isSidechain: false, seq,
    })
    toolCalls.push({
      id, name: 'Bash', action: 'shell' as CanonicalAction, input: { command: step.command },
      target: { command: step.command }, result: { ok: true, isError: false, raw: step.raw }, isSidechain: false,
    })
  })
  return {
    id: 'claude-code:s', sessionId: 's', source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' }, models: ['claude-haiku-4-5'], tokens: emptyUsage(), events, toolCalls,
    raw: { path: '', contentHash: 'h' },
  }
}

// An LLM stub with explicit per-range use_case labels.
function llmWithUseCases(runs: Array<{ from: number; to: number; use_case: string }>): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    async completeStructured() {
      return {
        data: {
          complexity: 'routine', autonomy: 'autonomous', intent_summary: 'x', decisions: [],
          success: 'unknown', features: [], feature_revisions: [], use_case_runs: runs, feature_runs: [],
        },
        usage: emptyUsage(),
      }
    },
  }
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

// A `gh` stub: `gh pr view` returns an open PR with a title; anything else misses.
const ghSh = async (cmd: string, args: string[]): Promise<ShResult | null> => {
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
    return { stdout: JSON.stringify({ title: 'Teammate PR', state: 'OPEN', author: { login: 'bob' } }), code: 0 }
  }
  return null
}

function ctx(session: Session, llm: LlmClient, sh = ghSh): ProcessorContext {
  return { session, log: noopLog, llmEnabled: true, llm, existingFeatures: [], existingTopics: [], rejectedFeatureTitles: [], userLinkedArtifacts: [], prBlockAttributions: [], sh }
}

describe('enrich-session reviewed-PR linkage', () => {
  it('links a PR read inside a review block as reviewed', async () => {
    const session = buildSession([{ command: 'gh pr diff 21 --repo o/r' }])
    const res = await enrichSession.run(ctx(session, reviewingLlm(1)))

    expect(res.sessionArtifacts).toContainEqual(
      expect.objectContaining({ artifactId: 'pr:o/r:21', role: 'reviewed', source: 'derived' }),
    )
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_reviewed', artifactId: 'pr:o/r:21' }))
    // The artifact row was enriched via the gh stub (so it isn't a bare stub).
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:21', kind: 'pr', title: 'Teammate PR', owner: 'bob' }))
    // Block-level link so review cost attributes to the review block, not whole session.
    expect(res.blockArtifacts).toContainEqual(
      expect.objectContaining({ blockIdx: 0, artifactId: 'pr:o/r:21', role: 'reviewed' }),
    )
  })

  it('does NOT mark a self-created PR as reviewed, even when it later views it', async () => {
    const session = buildSession([
      { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/21' },
      { command: 'gh pr view 21 --repo o/r' },
    ])
    const res = await enrichSession.run(ctx(session, reviewingLlm(2)))

    const reviewed = (res.sessionArtifacts ?? []).filter((s) => s.role === 'reviewed')
    expect(reviewed).toEqual([])
    expect((res.outcomes ?? []).some((o) => o.type === 'pr_reviewed')).toBe(false)
  })

  it('does NOT link a PR that was only read in a non-review block', async () => {
    // Same read, but the LLM labels the work `implement`, not `review`.
    const session = buildSession([{ command: 'gh pr diff 21 --repo o/r' }])
    const implementingLlm: LlmClient = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      async completeStructured() {
        return {
          data: {
            complexity: 'routine', autonomy: 'autonomous', intent_summary: 'build', decisions: [],
            success: 'unknown', features: [], feature_revisions: [],
            use_case_runs: [{ from: 0, to: 0, use_case: 'implement' }], feature_runs: [],
          },
          usage: emptyUsage(),
        }
      },
    }
    const res = await enrichSession.run(ctx(session, implementingLlm))
    expect((res.sessionArtifacts ?? []).some((s) => s.role === 'reviewed')).toBe(false)
  })

  it('defers to Layer 1: a PR both read and explicitly reviewed gets no derived link', async () => {
    // The explicit `gh pr review` is owned by outcomes-git (Layer 1), so enrich must
    // NOT also derive-link the same PR — even though it was read in a review block.
    const session = buildSession([
      { command: 'gh pr diff 21 --repo o/r' },
      { command: 'gh pr review 21 --repo o/r --approve' },
    ])
    const res = await enrichSession.run(ctx(session, reviewingLlm(1)))
    expect((res.sessionArtifacts ?? []).some((s) => s.role === 'reviewed')).toBe(false)
  })

  // --- forward-fill over review blocks (aligns Layer 2 with Layer 1) ---

  const reviewedBlocks = (res: Awaited<ReturnType<typeof enrichSession.run>>) =>
    new Map((res.blockArtifacts ?? []).filter((b) => b.role === 'reviewed').map((b) => [b.blockIdx, b.artifactId]))

  it('forward-fills: analysis blocks after a read attribute to the reviewed PR', async () => {
    const session = buildMixedSession([
      { user: 'review PR 21' },
      { command: 'gh pr diff 21 --repo o/r' }, // block 0: read 21
      { user: 'what about error handling' },
      { command: 'cat src/err.ts' }, // block 1: analysis, no read
      { user: 'and the tests' },
      { command: 'cat src/err.test.ts' }, // block 2: analysis, no read
    ])
    const res = await enrichSession.run(ctx(session, llmWithUseCases([{ from: 0, to: 2, use_case: 'review' }])))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:21', role: 'reviewed', source: 'derived' }))
    const byBlock = reviewedBlocks(res)
    expect(byBlock.get(0)).toBe('pr:o/r:21')
    expect(byBlock.get(1)).toBe('pr:o/r:21') // analysis carries the review forward
    expect(byBlock.get(2)).toBe('pr:o/r:21')
  })

  it('forward-fill segments two PRs reviewed in sequence', async () => {
    const session = buildMixedSession([
      { user: 'review 21 and 30' },
      { command: 'gh pr diff 21 --repo o/r' }, // block 0: read 21
      { user: 'thoughts on 21' },
      { command: 'cat notes.md' }, // block 1: analysis → 21
      { user: 'now 30' },
      { command: 'gh pr diff 30 --repo o/r' }, // block 2: read 30
      { user: 'and 30 tests' },
      { command: 'cat t.md' }, // block 3: analysis → 30
    ])
    const res = await enrichSession.run(ctx(session, llmWithUseCases([{ from: 0, to: 3, use_case: 'review' }])))
    const byBlock = reviewedBlocks(res)
    expect(byBlock.get(0)).toBe('pr:o/r:21')
    expect(byBlock.get(1)).toBe('pr:o/r:21')
    expect(byBlock.get(2)).toBe('pr:o/r:30')
    expect(byBlock.get(3)).toBe('pr:o/r:30')
    for (const id of ['pr:o/r:21', 'pr:o/r:30']) {
      expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: id, role: 'reviewed' }))
    }
  })

  it('two PRs read in one review block: earliest wins, the conflict loser is dropped entirely', async () => {
    const session = buildSession([
      { command: 'gh pr diff 21 --repo o/r' },
      { command: 'gh pr diff 30 --repo o/r' },
    ]) // one block, both reads inside it
    const res = await enrichSession.run(ctx(session, reviewingLlm(1)))
    // #21 (read first) wins block 0 and gets the link
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:21', role: 'reviewed' }))
    expect((res.blockArtifacts ?? []).filter((b) => b.role === 'reviewed')).toEqual([
      expect.objectContaining({ blockIdx: 0, artifactId: 'pr:o/r:21' }),
    ])
    // #30 lost the only block it was read in → no link at all: session, block, or outcome
    expect((res.sessionArtifacts ?? []).some((s) => s.artifactId === 'pr:o/r:30')).toBe(false)
    expect((res.blockArtifacts ?? []).some((b) => b.artifactId === 'pr:o/r:30')).toBe(false)
    expect((res.outcomes ?? []).some((o) => o.artifactId === 'pr:o/r:30')).toBe(false)
  })

  it('a human-pasted PR link in a review block is attributed (tightened gate)', async () => {
    const session = buildMixedSession([
      { user: 'please review https://github.com/o/r/pull/42' },
      { command: 'cat src/foo.ts' }, // analysis in the same block
    ])
    const res = await enrichSession.run(ctx(session, reviewingLlm(1)))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:42', role: 'reviewed', source: 'derived' }))
    expect(reviewedBlocks(res).get(0)).toBe('pr:o/r:42')
  })

  it('tightened gate: a link pasted in a NON-review block is not linked, even if the session has a review block', async () => {
    const session = buildMixedSession([
      { user: 'implement the change from https://github.com/o/r/pull/42' }, // block 0
      { command: 'cat src/foo.ts' },
      { user: 'now review PR 99' },
      { command: 'gh pr diff 99 --repo o/r' }, // block 1
    ])
    const res = await enrichSession.run(
      ctx(session, llmWithUseCases([
        { from: 0, to: 0, use_case: 'implement' },
        { from: 1, to: 1, use_case: 'review' },
      ])),
    )
    // #42 was pasted in an 'implement' block → NOT linked (the old loose gate would have linked it)
    expect((res.sessionArtifacts ?? []).some((s) => s.artifactId === 'pr:o/r:42')).toBe(false)
    // #99 was read in the review block → linked
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:99', role: 'reviewed' }))
  })
})
