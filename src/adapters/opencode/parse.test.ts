import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeSessionCost } from '../../pricing/pricing'
import type { Session } from '../../core/model'
import { openOpencodeDb } from './db'
import { buildSessions } from './parse'

/**
 * Build a minimal opencode.db fixture: one parent session that spawns one
 * subagent (child) session, with the message/part shapes OpenCode actually
 * writes. Only the columns the adapter reads are created.
 */
function writeFixture(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, workspace_id TEXT, directory TEXT,
      title TEXT, agent TEXT, model TEXT, version TEXT, cost REAL,
      tokens_input INT, tokens_output INT, tokens_reasoning INT,
      tokens_cache_read INT, tokens_cache_write INT, time_created INT, time_updated INT
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INT, data TEXT);
  `)

  db.prepare('INSERT INTO workspace (id, branch) VALUES (?, ?)').run('w1', 'main')

  const insSession = db.prepare(
    `INSERT INTO session (id, parent_id, workspace_id, directory, title, agent, model, version,
       cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
     VALUES (@id,@parent_id,@workspace_id,@directory,@title,@agent,@model,@version,
       @cost,@ti,@to,@tr,@tcr,@tcw,@tc,@tu)`,
  )
  insSession.run({
    id: 'P', parent_id: null, workspace_id: 'w1', directory: '/repo', title: 'Parent session',
    agent: 'build', model: '{"id":"zai-org/GLM-5.2","providerID":"togetherai","variant":"high"}',
    version: '1.17.9', cost: 0.01, ti: 100, to: 20, tr: 5, tcr: 10, tcw: 0,
    tc: 1782000000000, tu: 1782000100000,
  })
  insSession.run({
    id: 'C', parent_id: 'P', workspace_id: 'w1', directory: '/repo', title: 'Explore stuff (@explore subagent)',
    agent: 'explore', model: '{"id":"zai-org/GLM-5.1","providerID":"togetherai"}',
    version: '1.17.9', cost: 0.02, ti: 200, to: 40, tr: 0, tcr: 0, tcw: 0,
    tc: 1782000050000, tu: 1782000080000,
  })

  const insMsg = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')

  // Parent: user turn + assistant turn (reasoning, bash tool, task tool that spawns C).
  insMsg.run('Pu', 'P', 1782000000000, JSON.stringify({ role: 'user', time: { created: 1782000000000 } }))
  insPart.run('Pu1', 'Pu', 'P', 1782000000000, JSON.stringify({ type: 'text', text: 'do the thing' }))

  insMsg.run('Pa', 'P', 1782000001000, JSON.stringify({
    role: 'assistant', modelID: 'zai-org/GLM-5.2', providerID: 'togetherai',
    path: { cwd: '/repo/sub' }, cost: 0.01, time: { created: 1782000001000 },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
  }))
  insPart.run('Pa1', 'Pa', 'P', 1782000001000, JSON.stringify({ type: 'reasoning', text: 'thinking...' }))
  insPart.run('Pa2', 'Pa', 'P', 1782000001100, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call_bash',
    state: { status: 'completed', input: { command: 'ls -la' }, output: 'a\nb', time: { start: 10, end: 30 } },
  }))
  insPart.run('Pa3', 'Pa', 'P', 1782000001200, JSON.stringify({
    type: 'tool', tool: 'task', callID: 'call_task',
    state: { status: 'completed', input: { description: 'Explore stuff', subagent_type: 'explore', prompt: '...' } },
  }))

  // Child (subagent): one assistant turn with a read tool and an errored grep.
  insMsg.run('Ca', 'C', 1782000060000, JSON.stringify({
    role: 'assistant', modelID: 'zai-org/GLM-5.1', providerID: 'togetherai',
    cost: 0.02, time: { created: 1782000060000 },
    tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
  }))
  insPart.run('Ca1', 'Ca', 'C', 1782000060000, JSON.stringify({
    type: 'tool', tool: 'read', callID: 'call_read',
    state: { status: 'completed', input: { filePath: '/repo/x.ts' }, output: '...' },
  }))
  insPart.run('Ca2', 'Ca', 'C', 1782000060100, JSON.stringify({
    type: 'tool', tool: 'grep', callID: 'call_grep',
    state: { status: 'error', input: { pattern: 'foo' }, error: 'boom' },
  }))

  db.close()
}

describe('opencode adapter', () => {
  let dir: string
  let sessions: Session[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-test-'))
    const path = join(dir, 'opencode.db')
    writeFixture(path)
    const db = openOpencodeDb(path)
    try {
      sessions = buildSessions(db, path)
    } finally {
      db.close()
    }
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('emits only top-level sessions (child folded)', () => {
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('opencode:P')
    expect(sessions[0]!.source).toBe('opencode')
  })

  it('normalizes ids, project, provider, models', () => {
    const s = sessions[0]!
    expect(s.provider).toBe('togetherai')
    expect(s.project).toEqual({ cwd: '/repo/sub', branch: 'main' })
    expect(s.title).toBe('Parent session')
    // From message modelIDs + parsed session.model JSON of parent and child.
    expect(new Set(s.models)).toEqual(new Set(['zai-org/GLM-5.2', 'zai-org/GLM-5.1']))
  })

  it('folds subagent tokens (reasoning into output) across parent + child', () => {
    const s = sessions[0]!
    // parent: in100 out20+reason5 cacheRead10 ; child: in200 out40
    expect(s.tokens).toEqual({ input: 300, output: 65, cacheCreate: 0, cacheRead: 10 })
  })

  it('maps tool actions and marks sidechain tool calls', () => {
    const s = sessions[0]!
    const byId = Object.fromEntries(s.toolCalls.map((t) => [t.id, t]))
    expect(byId.call_bash!.action).toBe('shell')
    expect(byId.call_bash!.target.command).toBe('ls -la')
    expect(byId.call_bash!.isSidechain).toBe(false)
    expect(byId.call_task!.action).toBe('task_spawn')
    expect(byId.call_read!.action).toBe('file_read')
    expect(byId.call_read!.isSidechain).toBe(true)
    expect(byId.call_read!.target.paths).toEqual(['/repo/x.ts'])
    expect(byId.call_grep!.action).toBe('search')
    expect(byId.call_grep!.result).toMatchObject({ ok: false, isError: true })
  })

  it('links each subagent to its spawning task call', () => {
    const s = sessions[0]!
    expect(s.subagents).toHaveLength(1)
    expect(s.subagents![0]).toMatchObject({
      agentId: 'C',
      agentType: 'explore',
      toolUseId: 'call_task',
    })
  })

  it('uses native per-message cost when the model is unpriced', () => {
    const cost = computeSessionCost(sessions[0]!)
    // togetherai isn't in models.json → falls back to summed native costs (0.01 + 0.02).
    expect(cost.usd).toBeCloseTo(0.03, 6)
    expect(cost.unpriced).toHaveLength(0)
  })
})
