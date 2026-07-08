import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeSessionCost } from '../../pricing/pricing'
import { trimInheritedPrefix } from '../../core/merge'
import type { Session } from '../../core/model'
import { parsePi } from './parse'
import { findBranchPaths, findLeaves } from './tree'
import type { TreeEntry } from './tree'

/** Unwrap parse result to a single session (for linear fixtures). */
function single(result: Session | Session[] | null): Session | null {
  if (Array.isArray(result)) return result[0] ?? null
  return result
}

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
    session = single(await parsePi(path))
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

describe('pi adapter — branched session (multi-leaf split)', () => {
  let dir: string
  let sessions: Session[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
    const path = branchedFixture(dir)
    const result = await parsePi(path)
    sessions = Array.isArray(result) ? result : result ? [result] : []
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns multiple sessions (one per leaf)', () => {
    expect(sessions).toHaveLength(2)
  })

  it('primary session has no suffix in ID', () => {
    expect(sessions[0]!.id).toBe('pi:sess-branch-002')
    expect(sessions[0]!.sessionId).toBe('sess-branch-002')
  })

  it('non-primary session has ~leafId suffix', () => {
    expect(sessions[1]!.id).toBe('pi:sess-branch-002~b6')
    expect(sessions[1]!.sessionId).toBe('sess-branch-002~b6')
  })

  it('primary has no forkedFromId (or external fork only)', () => {
    expect(sessions[0]!.forkedFromId).toBeUndefined()
  })

  it('non-primary has forkedFromId pointing to primary session id', () => {
    expect(sessions[1]!.forkedFromId).toBe('sess-branch-002')
  })

  it('primary picks canonical path (latest leaf)', () => {
    // Canonical path goes: b1 → b2 → b3 → b7 → b8 → b9
    expect(sessions[0]!.endedAt).toBe('2026-07-02T10:07:00.000Z')
  })

  it('primary events contain only canonical path messages', () => {
    const kinds = sessions[0]!.events.map((e) => e.kind)
    // user (b2), assistant (b3), user (b7), assistant (b8), system/bashExecution (b9)
    expect(kinds).toEqual(['user', 'assistant', 'user', 'assistant', 'system'])
  })

  it('bashExecution becomes SystemEvent on primary', () => {
    const sys = sessions[0]!.events.find((e) => e.kind === 'system')!
    expect(sys.subtype).toBe('bash_execution')
    expect(sys.text).toBe('npm run build')
  })

  it('primary has no tool calls (canonical branch has none)', () => {
    expect(sessions[0]!.toolCalls).toHaveLength(0)
  })

  it('non-primary events contain abandoned branch path', () => {
    const kinds = sessions[1]!.events.map((e) => e.kind)
    // Abandoned path: b1 → b2 → b3 → b4 → b5 → b6
    // user (b2), assistant (b3), user (b4), assistant (b5)
    expect(kinds).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('non-primary has the abandoned tool call', () => {
    const ids = sessions[1]!.toolCalls.map((t) => t.id)
    expect(ids).toContain('tc_abandoned')
    expect(sessions[1]!.toolCalls).toHaveLength(1)
  })

  it('primary tokens are from its full path only', () => {
    // Primary path: b3 (in300+out50+cw100) + b8 (in350+out40)
    expect(sessions[0]!.tokens).toEqual({ input: 650, output: 90, cacheCreate: 100, cacheRead: 0 })
  })

  it('non-primary tokens are from its full path only', () => {
    // Non-primary path: b3 (in300+out50+cw100) + b5 (in400+out60)
    expect(sessions[1]!.tokens).toEqual({ input: 700, output: 110, cacheCreate: 100, cacheRead: 0 })
  })

  it('no double-counting: shared prefix counted on both (trimInheritedPrefix handles dedup later)', () => {
    // b3 is shared (in300+out50+cw100) — appears in both sessions' tokens
    // This is intentional: trimInheritedPrefix in analyze.ts removes it from the child
    const totalInput = sessions[0]!.tokens.input + sessions[1]!.tokens.input
    // 650 + 700 = 1350 (includes double-counted shared b3: 300*2=600)
    // After trimInheritedPrefix: 650 + 400 = 1050 (actual spend)
    expect(totalInput).toBe(1350)
  })

  it('models union includes all branches on both sessions', () => {
    expect(sessions[0]!.models).toEqual(['us.anthropic.claude-opus-4-6-v1'])
    expect(sessions[1]!.models).toEqual(['us.anthropic.claude-opus-4-6-v1'])
  })

  it('both sessions share the same title', () => {
    expect(sessions[0]!.title).toBeUndefined() // no session_info in branched fixture
    expect(sessions[1]!.title).toBeUndefined()
  })

  it('cost for primary uses its own events', () => {
    const cost = computeSessionCost(sessions[0]!)
    expect(cost.usd).toBeCloseTo(0.0045 + 0.0039, 4)
  })

  it('cost for non-primary uses its own events', () => {
    const cost = computeSessionCost(sessions[1]!)
    expect(cost.usd).toBeCloseTo(0.0045 + 0.0046, 4)
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

    parentSession = single(await parsePi(parentPath))
    forkSession = single(await parsePi(forkPath))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('parent has no forkedFromId', () => {
    expect(parentSession!.forkedFromId).toBeUndefined()
  })

  it('fork has forkedFromId pointing to parent (raw id, no prefix)', () => {
    expect(forkSession!.forkedFromId).toBe('sess-parent-001')
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

describe('pi adapter — unresolved tool calls on branch path', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('flushes tool calls whose result is on a different branch', async () => {
    // Tree: user → assistant(tc1) → [branch: toolResult(tc1) on one side, assistant(tc2) on the other]
    // Canonical path skips the toolResult for tc1, hitting the second assistant directly
    const path = join(dir, 'unresolved-tools.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-unresolved', timestamp: '2026-07-03T10:00:00.000Z', cwd: '/repo' }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-03T10:00:01.000Z', message: { role: 'user', content: 'do something', timestamp: 1783200000000 } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-03T10:00:02.000Z', message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/repo/file.ts' } }],
        model: 'claude-sonnet-5', provider: 'anthropic',
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 } },
        stopReason: 'toolUse', timestamp: 1783200001000,
      } }),
      // toolResult for tc1 on an abandoned branch (earlier timestamp leaf)
      JSON.stringify({ type: 'message', id: 'tr1', parentId: 'a1', timestamp: '2026-07-03T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false, timestamp: 1783200002000 } }),
      // canonical branch: a second assistant (later leaf)
      JSON.stringify({ type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-07-03T10:00:04.000Z', message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { command: 'npm test' } }],
        model: 'claude-sonnet-5', provider: 'anthropic',
        usage: { input: 150, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 180, cost: { total: 0.002 } },
        stopReason: 'toolUse', timestamp: 1783200003000,
      } }),
      JSON.stringify({ type: 'message', id: 'tr2', parentId: 'a2', timestamp: '2026-07-03T10:00:05.000Z', message: { role: 'toolResult', toolCallId: 'tc2', toolName: 'bash', content: [{ type: 'text', text: 'PASS' }], isError: false, timestamp: 1783200004000 } }),
    ]
    writeFileSync(path, lines.join('\n'))
    const result = await parsePi(path)
    const sessions = Array.isArray(result) ? result : result ? [result] : []

    // Two leaves: tr2 (ts 10:00:05, canonical) and tr1 (ts 10:00:03, abandoned)
    // Canonical path: u1 → a1 → a2 → tr2
    // a1 has tc1, but toolResult for tc1 is NOT on this path
    const canonical = sessions[0]!
    const tcIds = canonical.toolCalls.map((t) => t.id)
    expect(tcIds).toContain('tc1')
    expect(tcIds).toContain('tc2')

    // tc1 should be flushed as incomplete (no result on this path)
    const tc1 = canonical.toolCalls.find((t) => t.id === 'tc1')!
    expect(tc1.result.isError).toBe(false)
    expect(tc1.result.ok).toBe(false)
    expect(tc1.action).toBe('file_read')

    // tc2 should be resolved normally
    const tc2 = canonical.toolCalls.find((t) => t.id === 'tc2')!
    expect(tc2.result.ok).toBe(true)
    expect(tc2.action).toBe('shell')
  })
})

describe('pi adapter — trimInheritedPrefix integration', () => {
  let dir: string
  let sessions: Session[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-test-'))
    const path = branchedFixture(dir)
    const result = await parsePi(path)
    sessions = Array.isArray(result) ? result : result ? [result] : []
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('pre-trim: child has shared prefix events', () => {
    // Non-primary (index 1) has full path: user(b2), assistant(b3), user(b4), assistant(b5)
    const child = sessions[1]!
    expect(child.events).toHaveLength(4)
    expect(child.events[0]!.kind).toBe('user')
    expect(child.events[1]!.kind).toBe('assistant')
  })

  it('trimInheritedPrefix removes shared prefix from child', () => {
    const primary = { ...sessions[0]! }
    const child = { ...sessions[1]!, events: [...sessions[1]!.events], toolCalls: [...sessions[1]!.toolCalls], tokens: { ...sessions[1]!.tokens } }

    trimInheritedPrefix(child, primary)

    // After trim: only the divergent part remains
    // Shared assistant is b3 (usage: in300+out50+cw100) — matches on both paths
    // After trim: user(b4), assistant(b5) remain
    expect(child.events).toHaveLength(2)
    expect(child.events[0]!.kind).toBe('user')
    expect(child.events[1]!.kind).toBe('assistant')
  })

  it('trimInheritedPrefix recalculates tokens to unique-only', () => {
    const primary = { ...sessions[0]! }
    const child = { ...sessions[1]!, events: [...sessions[1]!.events], toolCalls: [...sessions[1]!.toolCalls], tokens: { ...sessions[1]!.tokens } }

    trimInheritedPrefix(child, primary)

    // Only b5's tokens remain: input=400, output=60, cacheCreate=0, cacheRead=0
    expect(child.tokens).toEqual({ input: 400, output: 60, cacheCreate: 0, cacheRead: 0 })
  })

  it('no double-counting after trim', () => {
    const primary = { ...sessions[0]! }
    const child = { ...sessions[1]!, events: [...sessions[1]!.events], toolCalls: [...sessions[1]!.toolCalls], tokens: { ...sessions[1]!.tokens } }

    trimInheritedPrefix(child, primary)

    // Primary: in650 + out90 (full canonical path)
    // Child after trim: in400 + out60 (unique abandoned branch)
    // Total: in1050 + out150 = actual tree total
    expect(primary.tokens.input + child.tokens.input).toBe(1050)
    expect(primary.tokens.output + child.tokens.output).toBe(150)
  })

  it('trimInheritedPrefix removes shared tool calls from child', () => {
    const primary = { ...sessions[0]! }
    const child = { ...sessions[1]!, events: [...sessions[1]!.events], toolCalls: [...sessions[1]!.toolCalls], tokens: { ...sessions[1]!.tokens } }

    trimInheritedPrefix(child, primary)

    // Primary has 0 tool calls, child has 1 (tc_abandoned)
    // No shared tool call IDs to trim in this case, so child keeps tc_abandoned
    expect(child.toolCalls).toHaveLength(1)
    expect(child.toolCalls[0]!.id).toBe('tc_abandoned')
  })
})

describe('findBranchPaths', () => {
  // Tree:  a → b → c → d (leaf, ts 10:05)
  //                  ↘ e (leaf, ts 10:03)
  const entries: TreeEntry[] = [
    { id: 'a', parentId: null, timestamp: '2026-07-01T10:00:00.000Z' },
    { id: 'b', parentId: 'a', timestamp: '2026-07-01T10:01:00.000Z' },
    { id: 'c', parentId: 'b', timestamp: '2026-07-01T10:02:00.000Z' },
    { id: 'd', parentId: 'c', timestamp: '2026-07-01T10:05:00.000Z' },
    { id: 'e', parentId: 'b', timestamp: '2026-07-01T10:03:00.000Z' },
  ]

  it('identifies correct leaves', () => {
    const leaves = findLeaves(entries)
    expect(leaves.sort()).toEqual(['d', 'e'])
  })

  it('returns branches sorted by timestamp descending (canonical first)', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    expect(branches).toHaveLength(2)
    expect(branches[0]!.leafId).toBe('d') // latest timestamp
    expect(branches[1]!.leafId).toBe('e')
  })

  it('full path for each branch is root→leaf', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    expect(branches[0]!.path.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(branches[1]!.path.map((e) => e.id)).toEqual(['a', 'b', 'e'])
  })

  it('unique IDs are disjoint between branches', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    const unique0 = branches[0]!.uniqueIds
    const unique1 = branches[1]!.uniqueIds
    for (const id of unique0) {
      expect(unique1.has(id)).toBe(false)
    }
    for (const id of unique1) {
      expect(unique0.has(id)).toBe(false)
    }
  })

  it('shared entries are not in any uniqueIds set', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    // 'a' and 'b' are shared (on both paths)
    expect(branches[0]!.uniqueIds.has('a')).toBe(false)
    expect(branches[0]!.uniqueIds.has('b')).toBe(false)
    expect(branches[1]!.uniqueIds.has('a')).toBe(false)
    expect(branches[1]!.uniqueIds.has('b')).toBe(false)
  })

  it('unique entries for canonical branch are c and d', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    expect(branches[0]!.uniqueIds).toEqual(new Set(['c', 'd']))
  })

  it('unique entries for non-canonical branch is just e', () => {
    const leaves = findLeaves(entries)
    const branches = findBranchPaths(entries, leaves)
    expect(branches[1]!.uniqueIds).toEqual(new Set(['e']))
  })

  it('works with linear session (single leaf)', () => {
    const linear: TreeEntry[] = [
      { id: 'x', parentId: null, timestamp: '2026-07-01T10:00:00.000Z' },
      { id: 'y', parentId: 'x', timestamp: '2026-07-01T10:01:00.000Z' },
      { id: 'z', parentId: 'y', timestamp: '2026-07-01T10:02:00.000Z' },
    ]
    const leaves = findLeaves(linear)
    expect(leaves).toEqual(['z'])
    const branches = findBranchPaths(linear, leaves)
    expect(branches).toHaveLength(1)
    expect(branches[0]!.path.map((e) => e.id)).toEqual(['x', 'y', 'z'])
    // All entries are unique (only one branch)
    expect(branches[0]!.uniqueIds).toEqual(new Set(['x', 'y', 'z']))
  })

  it('handles 3-leaf tree correctly', () => {
    // Tree:  r → a → b (leaf, ts 10:04)
    //            ↘ c (leaf, ts 10:05)    ← canonical
    //        r → d (leaf, ts 10:02)
    const tree: TreeEntry[] = [
      { id: 'r', parentId: null, timestamp: '2026-07-01T10:00:00.000Z' },
      { id: 'a', parentId: 'r', timestamp: '2026-07-01T10:01:00.000Z' },
      { id: 'b', parentId: 'a', timestamp: '2026-07-01T10:04:00.000Z' },
      { id: 'c', parentId: 'a', timestamp: '2026-07-01T10:05:00.000Z' },
      { id: 'd', parentId: 'r', timestamp: '2026-07-01T10:02:00.000Z' },
    ]
    const leaves = findLeaves(tree)
    const branches = findBranchPaths(tree, leaves)
    expect(branches).toHaveLength(3)
    // Sorted by timestamp desc: c (10:05), b (10:04), d (10:02)
    expect(branches[0]!.leafId).toBe('c')
    expect(branches[1]!.leafId).toBe('b')
    expect(branches[2]!.leafId).toBe('d')
    // 'r' is shared across all 3, 'a' shared between b and c
    expect(branches[0]!.uniqueIds).toEqual(new Set(['c']))
    expect(branches[1]!.uniqueIds).toEqual(new Set(['b']))
    expect(branches[2]!.uniqueIds).toEqual(new Set(['d']))
  })
})
