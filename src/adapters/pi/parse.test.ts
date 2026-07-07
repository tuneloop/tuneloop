import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeSessionCost } from '../../pricing/pricing'
import type { Session } from '../../core/model'
import { parsePi } from './parse'

/** Minimal fixture: linear session (no branching) with realistic entry types. */
function linearFixture(dir: string): string {
  const path = join(dir, 'linear.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-linear-001', timestamp: '2026-07-01T10:00:00.000Z', cwd: '/repo' }),
    JSON.stringify({ type: 'model_change', id: 'e1', parentId: null, timestamp: '2026-07-01T10:00:00.001Z', provider: 'anthropic', modelId: 'claude-sonnet-5' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'e2', parentId: 'e1', timestamp: '2026-07-01T10:00:00.002Z', thinkingLevel: 'high' }),
    JSON.stringify({ type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-07-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }], timestamp: 1783000000000 } }),
    JSON.stringify({ type: 'message', id: 'e4', parentId: 'e3', timestamp: '2026-07-01T10:00:02.000Z', message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me look at the code' },
        { type: 'text', text: 'I\'ll check the file.' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/repo/main.ts' } },
        { type: 'toolCall', id: 'tc2', name: 'bash', arguments: { command: 'npm test' } },
      ],
      api: 'messages', provider: 'anthropic', model: 'claude-sonnet-5',
      usage: { input: 500, output: 100, cacheRead: 50, cacheWrite: 200, totalTokens: 850, cost: { input: 0.005, output: 0.001, cacheRead: 0.0001, cacheWrite: 0.002, total: 0.0081 } },
      stopReason: 'toolUse', timestamp: 1783000001000,
    } }),
    JSON.stringify({ type: 'message', id: 'e5', parentId: 'e4', timestamp: '2026-07-01T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: [{ type: 'text', text: 'file contents here' }], isError: false, timestamp: 1783000002000 } }),
    JSON.stringify({ type: 'message', id: 'e6', parentId: 'e5', timestamp: '2026-07-01T10:00:04.000Z', message: { role: 'toolResult', toolCallId: 'tc2', toolName: 'bash', content: [{ type: 'text', text: 'PASS' }], isError: false, timestamp: 1783000003000 } }),
    JSON.stringify({ type: 'message', id: 'e7', parentId: 'e6', timestamp: '2026-07-01T10:00:05.000Z', message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Fixed!' },
        { type: 'toolCall', id: 'tc3', name: 'edit', arguments: { path: '/repo/main.ts', old_string: 'bug', new_string: 'fix' } },
      ],
      api: 'messages', provider: 'anthropic', model: 'claude-sonnet-5',
      usage: { input: 600, output: 80, cacheRead: 100, cacheWrite: 0, totalTokens: 780, cost: { input: 0.006, output: 0.0008, cacheRead: 0.0002, cacheWrite: 0, total: 0.007 } },
      stopReason: 'toolUse', timestamp: 1783000004000,
    } }),
    JSON.stringify({ type: 'message', id: 'e8', parentId: 'e7', timestamp: '2026-07-01T10:00:06.000Z', message: { role: 'toolResult', toolCallId: 'tc3', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1783000005000 } }),
    JSON.stringify({ type: 'session_info', id: 'e9', parentId: 'e8', timestamp: '2026-07-01T10:00:07.000Z', name: 'Fix the login bug' }),
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

/** Branched fixture: shared prefix splits into two branches with different timestamps. */
function branchedFixture(dir: string): string {
  const path = join(dir, 'branched.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-branch-002', timestamp: '2026-07-02T10:00:00.000Z', cwd: '/repo' }),
    JSON.stringify({ type: 'model_change', id: 'b1', parentId: null, timestamp: '2026-07-02T10:00:00.001Z', provider: 'amazon-bedrock', modelId: 'us.anthropic.claude-opus-4-6-v1' }),
    // Shared prefix: user + assistant
    JSON.stringify({ type: 'message', id: 'b2', parentId: 'b1', timestamp: '2026-07-02T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'refactor auth' }], timestamp: 1783100000000 } }),
    JSON.stringify({ type: 'message', id: 'b3', parentId: 'b2', timestamp: '2026-07-02T10:02:00.000Z', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'I will refactor the auth module.' }],
      provider: 'amazon-bedrock', model: 'us.anthropic.claude-opus-4-6-v1',
      usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 100, totalTokens: 450, cost: { input: 0.003, output: 0.0005, cacheRead: 0, cacheWrite: 0.001, total: 0.0045 } },
      stopReason: 'stop', timestamp: 1783100001000,
    } }),
    // Branch 1 (abandoned): user asks different question, assistant responds (earlier timestamp)
    JSON.stringify({ type: 'message', id: 'b4', parentId: 'b3', timestamp: '2026-07-02T10:03:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'actually use middleware' }], timestamp: 1783100002000 } }),
    JSON.stringify({ type: 'message', id: 'b5', parentId: 'b4', timestamp: '2026-07-02T10:04:00.000Z', message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc_abandoned', name: 'bash', arguments: { command: 'gh pr create --title middleware' } },
      ],
      provider: 'amazon-bedrock', model: 'us.anthropic.claude-opus-4-6-v1',
      usage: { input: 400, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 460, cost: { input: 0.004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0046 } },
      stopReason: 'toolUse', timestamp: 1783100003000,
    } }),
    JSON.stringify({ type: 'message', id: 'b6', parentId: 'b5', timestamp: '2026-07-02T10:04:30.000Z', message: { role: 'toolResult', toolCallId: 'tc_abandoned', toolName: 'bash', content: [{ type: 'text', text: 'created PR #99' }], isError: false, timestamp: 1783100004000 } }),
    // Branch 2 (canonical - later timestamp): user goes back and says "understood"
    JSON.stringify({ type: 'message', id: 'b7', parentId: 'b3', timestamp: '2026-07-02T10:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'understood, do it' }], timestamp: 1783100005000 } }),
    JSON.stringify({ type: 'message', id: 'b8', parentId: 'b7', timestamp: '2026-07-02T10:06:00.000Z', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done with the refactor.' }],
      provider: 'amazon-bedrock', model: 'us.anthropic.claude-opus-4-6-v1',
      usage: { input: 350, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 390, cost: { input: 0.0035, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0039 } },
      stopReason: 'stop', timestamp: 1783100006000,
    } }),
    // bashExecution on branch 2 (user ran a command themselves)
    JSON.stringify({ type: 'message', id: 'b9', parentId: 'b8', timestamp: '2026-07-02T10:07:00.000Z', message: { role: 'bashExecution', command: 'npm run build', output: 'ok', exitCode: 0, cancelled: false, truncated: false, timestamp: 1783100007000 } }),
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

/** Non-session file (no assistant messages). */
function nonSessionFixture(dir: string): string {
  const path = join(dir, 'empty.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-empty', timestamp: '2026-07-03T10:00:00.000Z', cwd: '/repo' }),
    JSON.stringify({ type: 'model_change', id: 'x1', parentId: null, timestamp: '2026-07-03T10:00:00.001Z', provider: 'openai', modelId: 'gpt-5' }),
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

describe('pi adapter — linear session', () => {
  let dir: string
  let session: Session | null

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
    const path = linearFixture(dir)
    session = await parsePi(path)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('parses successfully', () => {
    expect(session).not.toBeNull()
  })

  it('has correct identity fields', () => {
    expect(session!.id).toBe('pi:sess-linear-001')
    expect(session!.sessionId).toBe('sess-linear-001')
    expect(session!.source).toBe('pi')
  })

  it('resolves provider from model_change entry', () => {
    expect(session!.provider).toBe('anthropic')
  })

  it('collects distinct models from assistant messages', () => {
    expect(session!.models).toEqual(['claude-sonnet-5'])
  })

  it('sets project cwd from header', () => {
    expect(session!.project.cwd).toBe('/repo')
  })

  it('sets timestamps from header and last entry', () => {
    expect(session!.startedAt).toBe('2026-07-01T10:00:00.000Z')
    expect(session!.endedAt).toBe('2026-07-01T10:00:07.000Z')
  })

  it('picks title from session_info entry', () => {
    expect(session!.title).toBe('Fix the login bug')
  })

  it('sums tokens across all assistant messages', () => {
    expect(session!.tokens).toEqual({ input: 1100, output: 180, cacheCreate: 200, cacheRead: 150 })
  })

  it('emits events in correct order (skips model_change/thinking_level_change)', () => {
    const kinds = session!.events.map((e) => e.kind)
    expect(kinds).toEqual(['user', 'assistant', 'assistant'])
  })

  it('extracts tool calls with correct actions', () => {
    expect(session!.toolCalls).toHaveLength(3)
    const byId = Object.fromEntries(session!.toolCalls.map((t) => [t.id, t]))
    expect(byId.tc1!.action).toBe('file_read')
    expect(byId.tc1!.target.paths).toEqual(['/repo/main.ts'])
    expect(byId.tc2!.action).toBe('shell')
    expect(byId.tc2!.target.command).toBe('npm test')
    expect(byId.tc3!.action).toBe('file_write')
    expect(byId.tc3!.target.paths).toEqual(['/repo/main.ts'])
  })

  it('joins tool results correctly', () => {
    for (const tc of session!.toolCalls) {
      expect(tc.result.ok).toBe(true)
      expect(tc.result.isError).toBe(false)
    }
  })

  it('sets costUsd on assistant events from native cost', () => {
    const assistants = session!.events.filter((e) => e.kind === 'assistant')
    expect(assistants[0]!.costUsd).toBeCloseTo(0.0081, 4)
    expect(assistants[1]!.costUsd).toBeCloseTo(0.007, 4)
  })

  it('cost computation uses native costUsd', () => {
    const cost = computeSessionCost(session!)
    expect(cost.usd).toBeCloseTo(0.0081 + 0.007, 4)
    expect(cost.unpriced).toHaveLength(0)
  })

  it('has no subagents', () => {
    expect(session!.subagents).toBeUndefined()
  })
})

describe('pi adapter — branched session', () => {
  let dir: string
  let session: Session | null

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
    const path = branchedFixture(dir)
    session = await parsePi(path)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('parses successfully', () => {
    expect(session).not.toBeNull()
    expect(session!.id).toBe('pi:sess-branch-002')
  })

  it('picks canonical path (latest leaf)', () => {
    // Canonical path goes: b1 → b2 → b3 → b7 → b8 → b9
    // NOT through b4/b5/b6 (earlier branch)
    expect(session!.endedAt).toBe('2026-07-02T10:07:00.000Z')
  })

  it('events contain only canonical path messages', () => {
    const kinds = session!.events.map((e) => e.kind)
    // user (b2), assistant (b3), user (b7), assistant (b8), system/bashExecution (b9)
    expect(kinds).toEqual(['user', 'assistant', 'user', 'assistant', 'system'])
  })

  it('bashExecution becomes SystemEvent', () => {
    const sys = session!.events.find((e) => e.kind === 'system')!
    expect(sys.subtype).toBe('bash_execution')
    expect(sys.text).toBe('npm run build')
  })

  it('tool calls from abandoned branch are excluded', () => {
    const ids = session!.toolCalls.map((t) => t.id)
    expect(ids).not.toContain('tc_abandoned')
    expect(session!.toolCalls).toHaveLength(0)
  })

  it('tokens sum across ALL branches (total > canonical-only)', () => {
    // Canonical: b3 (in300+out50+cw100) + b8 (in350+out40)
    // Abandoned: b5 (in400+out60)
    expect(session!.tokens).toEqual({ input: 1050, output: 150, cacheCreate: 100, cacheRead: 0 })
  })

  it('models union includes all branches', () => {
    expect(session!.models).toEqual(['us.anthropic.claude-opus-4-6-v1'])
  })

  it('cost sums all branches via costUsd', () => {
    const cost = computeSessionCost(session!)
    // Canonical path events only: 0.0045 + 0.0039 = 0.0084
    // (abandoned branch tokens are in session.tokens but costUsd is per-event from canonical path)
    expect(cost.usd).toBeCloseTo(0.0045 + 0.0039, 4)
  })
})

describe('pi adapter — forked session', () => {
  let dir: string
  let parentSession: Session | null
  let forkSession: Session | null

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))

    // Create parent session
    const parentPath = join(dir, 'parent.jsonl')
    writeFileSync(parentPath, [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-parent-001', timestamp: '2026-07-01T08:00:00.000Z', cwd: '/repo' }),
      JSON.stringify({ type: 'model_change', id: 'p1', parentId: null, timestamp: '2026-07-01T08:00:00.001Z', provider: 'anthropic', modelId: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'message', id: 'p2', parentId: 'p1', timestamp: '2026-07-01T08:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1783000000000 } }),
      JSON.stringify({ type: 'message', id: 'p3', parentId: 'p2', timestamp: '2026-07-01T08:02:00.000Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        provider: 'anthropic', model: 'claude-sonnet-5',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
        stopReason: 'stop', timestamp: 1783000001000,
      } }),
    ].join('\n'))

    // Create forked session pointing to parent
    const forkPath = join(dir, 'fork.jsonl')
    writeFileSync(forkPath, [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-fork-001', timestamp: '2026-07-01T09:00:00.000Z', cwd: '/repo', parentSession: parentPath }),
      JSON.stringify({ type: 'model_change', id: 'f1', parentId: null, timestamp: '2026-07-01T09:00:00.001Z', provider: 'anthropic', modelId: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'message', id: 'f2', parentId: 'f1', timestamp: '2026-07-01T09:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'continue from before' }], timestamp: 1783100000000 } }),
      JSON.stringify({ type: 'message', id: 'f3', parentId: 'f2', timestamp: '2026-07-01T09:02:00.000Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'continuing' }],
        provider: 'anthropic', model: 'claude-sonnet-5',
        usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.002 } },
        stopReason: 'stop', timestamp: 1783100001000,
      } }),
    ].join('\n'))

    parentSession = await parsePi(parentPath)
    forkSession = await parsePi(forkPath)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('parent has no forkedFromId', () => {
    expect(parentSession!.forkedFromId).toBeUndefined()
  })

  it('fork has forkedFromId pointing to parent', () => {
    expect(forkSession!.forkedFromId).toBe('pi:sess-parent-001')
  })

  it('fork is not marked as subagent', () => {
    expect(forkSession!.isSubagent).toBeUndefined()
  })

  it('fork is its own session with independent events', () => {
    expect(forkSession!.id).toBe('pi:sess-fork-001')
    expect(forkSession!.events).toHaveLength(2) // user + assistant
  })
})

describe('pi adapter — non-session files', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null for file with no assistant messages', async () => {
    const path = nonSessionFixture(dir)
    const session = await parsePi(path)
    expect(session).toBeNull()
  })

  it('returns null for non-session file (no header)', async () => {
    const path = join(dir, 'random.jsonl')
    writeFileSync(path, '{"type":"something","id":"x"}\n')
    const session = await parsePi(path)
    expect(session).toBeNull()
  })

  it('returns null for empty file', async () => {
    const path = join(dir, 'empty.jsonl')
    writeFileSync(path, '')
    const session = await parsePi(path)
    expect(session).toBeNull()
  })
})
