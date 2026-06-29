import { describe, expect, it } from 'vitest'
import { outcomesGit } from './outcomes-git'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { ProcessorContext, ShResult } from '../core/processor'

// One leading user turn, then one assistant message per shell command.
function shellSession(commands: Array<{ command: string; raw?: string }>): Session {
  const events: Event[] = [{ kind: 'user', text: 'review this', blocks: [], isSidechain: false, seq: 0 }]
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
      id, name: 'Bash', action: 'shell' as CanonicalAction, input: { command: c.command },
      target: { command: c.command }, result: { ok: true, isError: false, raw: c.raw }, isSidechain: false,
    })
  })
  return {
    id: 'claude-code:s', sessionId: 's', source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' }, models: [], tokens: emptyUsage(), events, toolCalls,
    raw: { path: '', contentHash: 'h' },
  }
}

const ghSh = async (cmd: string, args: string[]): Promise<ShResult | null> => {
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
    return { stdout: JSON.stringify({ title: 'Teammate PR', state: 'OPEN' }), code: 0 }
  }
  return null
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
function ctx(session: Session): ProcessorContext {
  return { session, log: noopLog, llmEnabled: false, llm: null, existingFeatures: [], sh: ghSh }
}

describe('outcomes-git Layer 1 explicit reviews', () => {
  it('links an explicitly approved PR as reviewed (explicit, conf 1.0) + verdict outcome + block link', async () => {
    const res = await outcomesGit.run(ctx(shellSession([{ command: 'gh pr review 22 --repo o/r --approve' }])))
    expect(res.sessionArtifacts).toContainEqual(
      expect.objectContaining({ artifactId: 'pr:o/r:22', role: 'reviewed', source: 'explicit', confidence: 1 }),
    )
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_reviewed', artifactId: 'pr:o/r:22' }))
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_approved', artifactId: 'pr:o/r:22' }))
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:22', kind: 'pr', title: 'Teammate PR' }))
    expect(res.blockArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:22', role: 'reviewed' }))
  })

  it('emits pr_changes_requested for a request-changes review', async () => {
    const res = await outcomesGit.run(ctx(shellSession([{ command: 'gh pr review 8 --repo o/r --request-changes -b "fix"' }])))
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_changes_requested', artifactId: 'pr:o/r:8' }))
    expect((res.outcomes ?? []).some((o) => o.type === 'pr_approved')).toBe(false)
  })

  it('does NOT mark a PR the same session created as reviewed (self-review excluded)', async () => {
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/22' },
        { command: 'gh pr review 22 --repo o/r --comment' },
      ])),
    )
    expect((res.sessionArtifacts ?? []).filter((s) => s.role === 'reviewed')).toEqual([])
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:22', role: 'created' }))
  })
})
