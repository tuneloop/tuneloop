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
    async complete() {
      return {
        text: JSON.stringify({
          complexity: 'routine',
          autonomy: 'autonomous',
          intent_summary: 'review a PR',
          decisions: [],
          success: 'unknown',
          features: [],
          feature_revisions: [],
          use_case_runs: [{ from: 0, to: Math.max(0, blocks - 1), use_case: 'review' }],
          feature_runs: [],
        }),
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
  return { session, log: noopLog, llmEnabled: true, llm, existingFeatures: [], sh }
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
      async complete() {
        return {
          text: JSON.stringify({
            complexity: 'routine', autonomy: 'autonomous', intent_summary: 'build', decisions: [],
            success: 'unknown', features: [], feature_revisions: [],
            use_case_runs: [{ from: 0, to: 0, use_case: 'implement' }], feature_runs: [],
          }),
          usage: emptyUsage(),
        }
      },
    }
    const res = await enrichSession.run(ctx(session, implementingLlm))
    expect((res.sessionArtifacts ?? []).some((s) => s.role === 'reviewed')).toBe(false)
  })
})
