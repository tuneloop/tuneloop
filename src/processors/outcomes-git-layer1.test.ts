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

// Like shellSession but user turns can be interleaved between commands — a real user
// turn starts a new block, so this builds user-turn-bounded blocks around the anchors.
function mixedSession(steps: Array<{ user: string } | { command: string; raw?: string }>): Session {
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
  return { session, log: noopLog, llmEnabled: false, llm: null, existingFeatures: [], rejectedFeatureTitles: [], userLinkedArtifacts: [], prBlockAttributions: [], sh: ghSh }
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

  // Mixed create + review of DIFFERENT PRs: blocks must partition by role, 1-1.
  it('mixed — create B then review A: block 0 (production) → B contributed, block 1 (review) → A reviewed', async () => {
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
        { command: 'gh pr review 22 --repo o/r --approve' },
      ])),
    )
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:50', role: 'created' }))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:22', role: 'reviewed', confidence: 1 }))
    expect(res.blockArtifacts).toContainEqual({ blockIdx: 0, artifactId: 'pr:o/r:50', role: 'contributed', source: 'explicit' })
    expect(res.blockArtifacts).toContainEqual({ blockIdx: 1, artifactId: 'pr:o/r:22', role: 'reviewed', source: 'explicit', confidence: 1 })
    // 1-1: every block maps to exactly one PR row.
    const blockIdxs = (res.blockArtifacts ?? []).map((b) => b.blockIdx)
    expect(new Set(blockIdxs).size).toBe(blockIdxs.length)
  })

  it('mixed — review A then create B: the pr_review boundary keeps them separate (A is not swallowed by B)', async () => {
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'gh pr review 22 --repo o/r --approve' },
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
      ])),
    )
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:22', role: 'reviewed', confidence: 1 }))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:50', role: 'created' }))
    // WITHOUT a pr_review boundary these collapse into one block and #22 gets zero blocks.
    expect(res.blockArtifacts).toContainEqual({ blockIdx: 0, artifactId: 'pr:o/r:22', role: 'reviewed', source: 'explicit', confidence: 1 })
    expect(res.blockArtifacts).toContainEqual({ blockIdx: 1, artifactId: 'pr:o/r:50', role: 'contributed', source: 'explicit' })
    expect((res.blockArtifacts ?? []).some((b) => b.artifactId === 'pr:o/r:22')).toBe(true)
    const blockIdxs = (res.blockArtifacts ?? []).map((b) => b.blockIdx)
    expect(new Set(blockIdxs).size).toBe(blockIdxs.length)
  })

  // --- backward-fill over INTERMEDIATE (commit-bounded) blocks ---

  it('contributed backfill: the commit-bounded blocks leading up to a create all attribute to it; trailing work does not', async () => {
    // 4 blocks: [commit a][commit b][gh pr create #50][commit c (trailing)]
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'git commit -m "impl a"' },
        { command: 'git commit -m "impl b"' },
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
        { command: 'git commit -m "follow-up"' },
      ])),
    )
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    // blocks 0,1,2 (the two lead-up commits + the create) → #50 contributed
    for (const i of [0, 1, 2]) {
      expect(byBlock.get(i)).toMatchObject({ artifactId: 'pr:o/r:50', role: 'contributed' })
    }
    // block 3 is AFTER the last event → unattributed
    expect(byBlock.has(3)).toBe(false)
  })

  it('mixed backfill: review #22, then two commits building #50, then create #50', async () => {
    // 4 blocks: [review #22][commit a][commit b][gh pr create #50]
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'gh pr review 22 --repo o/r --approve' },
        { command: 'git commit -m "impl a"' },
        { command: 'git commit -m "impl b"' },
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
      ])),
    )
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    // review isolated to its own block; the intermediate commits belong to the create
    expect(byBlock.get(0)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' })
    for (const i of [1, 2, 3]) {
      expect(byBlock.get(i)).toMatchObject({ artifactId: 'pr:o/r:50', role: 'contributed' })
    }
    const blockIdxs = [...byBlock.keys()]
    expect(new Set(blockIdxs).size).toBe(blockIdxs.length) // 1-1
  })

  it('mixed backfill: two commits building #50, create #50, then review #22', async () => {
    // 4 blocks: [commit a][commit b][gh pr create #50][review #22]
    const res = await outcomesGit.run(
      ctx(shellSession([
        { command: 'git commit -m "impl a"' },
        { command: 'git commit -m "impl b"' },
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
        { command: 'gh pr review 22 --repo o/r --approve' },
      ])),
    )
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    // the lead-up commits + create → #50; the review is its own block → #22
    for (const i of [0, 1, 2]) {
      expect(byBlock.get(i)).toMatchObject({ artifactId: 'pr:o/r:50', role: 'contributed' })
    }
    expect(byBlock.get(3)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' })
    const blockIdxs = [...byBlock.keys()]
    expect(new Set(blockIdxs).size).toBe(blockIdxs.length) // 1-1
  })

  // --- user-turn-bounded blocks preceding an anchor get tagged via the fill ---

  it('user-turn blocks before a review are tagged reviewed (backfill across a user_turn boundary)', async () => {
    // [user "review 22" + diff] [user "check errors" + review 22] — both blocks → #22
    const res = await outcomesGit.run(
      ctx(mixedSession([
        { user: 'please review PR 22' },
        { command: 'gh pr diff 22 --repo o/r' },
        { user: 'and check the error handling' },
        { command: 'gh pr review 22 --repo o/r --approve' },
      ])),
    )
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    // the earlier user-turn block (before the review submission) is tagged too
    expect(byBlock.get(0)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' })
    expect(byBlock.get(1)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' })
    const idxs = [...byBlock.keys()]
    expect(new Set(idxs).size).toBe(idxs.length) // 1-1
  })

  it('mixed with user turns: review block → reviewed, a later user-turn production block → the created PR', async () => {
    // [user + diff + review 22] [user "now implement" + commit] [create 50]
    const res = await outcomesGit.run(
      ctx(mixedSession([
        { user: 'review PR 22 first' },
        { command: 'gh pr diff 22 --repo o/r' },
        { command: 'gh pr review 22 --repo o/r --approve' },
        { user: 'now implement the fix and open a PR' },
        { command: 'git commit -m "fix"' },
        { command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/50' },
      ])),
    )
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    expect(byBlock.get(0)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' }) // user + diff + review
    expect(byBlock.get(1)).toMatchObject({ artifactId: 'pr:o/r:50', role: 'contributed' }) // user + commit
    expect(byBlock.get(2)).toMatchObject({ artifactId: 'pr:o/r:50', role: 'contributed' }) // create
    const idxs = [...byBlock.keys()]
    expect(new Set(idxs).size).toBe(idxs.length) // 1-1
  })

  it('several PRs reviewed in a row (some back-to-back, some after a user turn) each get their own block', async () => {
    // [user + diff + review 22] [diff + review 30] [user + diff + review 41]
    // review 22 and review 30 are separated ONLY by the pr_review boundary — no user turn
    // between them. Without that boundary they'd share a block and #30 would be dropped.
    const res = await outcomesGit.run(
      ctx(mixedSession([
        { user: 'review PRs 22 and 30' },
        { command: 'gh pr diff 22 --repo o/r' },
        { command: 'gh pr review 22 --repo o/r --approve' },
        { command: 'gh pr diff 30 --repo o/r' },
        { command: 'gh pr review 30 --repo o/r --request-changes -b "nit"' },
        { user: 'now also review PR 41' },
        { command: 'gh pr diff 41 --repo o/r' },
        { command: 'gh pr review 41 --repo o/r --approve' },
      ])),
    )
    for (const id of ['pr:o/r:22', 'pr:o/r:30', 'pr:o/r:41']) {
      expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: id, role: 'reviewed', confidence: 1 }))
    }
    // one block per review, no crossover (1-1)
    const byBlock = new Map((res.blockArtifacts ?? []).map((b) => [b.blockIdx, b]))
    expect(byBlock.get(0)).toMatchObject({ artifactId: 'pr:o/r:22', role: 'reviewed' })
    expect(byBlock.get(1)).toMatchObject({ artifactId: 'pr:o/r:30', role: 'reviewed' })
    expect(byBlock.get(2)).toMatchObject({ artifactId: 'pr:o/r:41', role: 'reviewed' })
    expect((res.blockArtifacts ?? []).length).toBe(3)
    // verdicts still flow through per PR
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_approved', artifactId: 'pr:o/r:22' }))
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_changes_requested', artifactId: 'pr:o/r:30' }))
  })
})
