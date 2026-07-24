import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assignSeq } from '../core/blocks'
import { insightId } from '../core/detector'
import { buildFixPrompt } from '../core/fix-prompt'
import type { Session } from '../core/model'
import type { ProcessorContext } from '../core/processor'
import { fixMarker } from '../processors/fix-marker'
import { parseClaudeCode } from './claude-code/parse'
import { parseCodex } from './codex/parse'
import { openOpencodeDb } from './opencode/db'
import { buildSessions } from './opencode/parse'
import { parsePi } from './pi/parse'

/**
 * The one promise every adapter owes the fix-adoption loop: a pasted multi-line
 * fix-prompt survives parsing as a REAL main-thread user turn with its text
 * intact, so the fix-marker processor can sight it. Per-harness risk lives in
 * each adapter's user-turn construction (codex's echo matching, opencode's
 * part assembly, …), so each gets its own fixture.
 */

const ID = insightId('repeated-nudges', '*', 'deploy-sequence')
const PROMPT = buildFixPrompt({
  id: ID,
  diagnosis: 'Across 6 recent sessions, the user had to re-explain the staging deploy sequence.',
  excerpts: ['Jun 30: "no — deploy to staging first with --no-invoker-iam-check"', 'Jul 2: "build with the prod env file first"'],
  task: 'Add a "Deploying" section to CLAUDE.md capturing the full staging deploy sequence.',
  doneWhen: 'A fresh session asked "deploy this to staging" states the correct sequence from CLAUDE.md alone.',
})

function sightingsOf(session: Session) {
  assignSeq(session) // analyze assigns seq post-merge, before processors run
  const ctx = { session, log: { debug() {}, info() {}, warn() {} } } as unknown as ProcessorContext
  const result = fixMarker.run(ctx) as { fixMarkerSightings: Array<{ insightId: string; seq: number; turnAt: string }> }
  return result.fixMarkerSightings
}

function expectSighted(session: Session | null) {
  expect(session).not.toBeNull()
  const sightings = sightingsOf(session!)
  expect(sightings.map((s) => s.insightId)).toEqual([ID])
  expect(sightings[0]!.turnAt).toBeTruthy()
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paste-survival-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a pasted fix-prompt survives every adapter as a sightable user turn', () => {
  it('claude-code', async () => {
    const sid = 'aaaa0000-1111-2222-3333-444444444444'
    const path = join(dir, `${sid}.jsonl`)
    const lines = [
      { parentUuid: null, isSidechain: false, type: 'user', cwd: '/repo', sessionId: sid, uuid: 'u1', timestamp: '2026-07-11T09:00:00.000Z', message: { role: 'user', content: PROMPT } },
      { parentUuid: 'u1', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: sid, uuid: 'a1', timestamp: '2026-07-11T09:00:05.000Z', message: { id: 'm1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    expectSighted(await parseClaudeCode(path))
  })

  it('codex (echo-gated user turns)', async () => {
    const path = join(dir, 'rollout-2026-07-11-paste.jsonl')
    const lines = [
      { timestamp: '2026-07-11T11:00:00.000Z', type: 'session_meta', payload: { id: 'cccc0000-1111-2222-3333-444444444444', timestamp: '2026-07-11T11:00:00.000Z', cwd: '/repo' } },
      { timestamp: '2026-07-11T11:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
      { timestamp: '2026-07-11T11:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: PROMPT } },
      { timestamp: '2026-07-11T11:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] } },
      { timestamp: '2026-07-11T11:00:20.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
      { timestamp: '2026-07-11T11:00:21.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }, total_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    expectSighted(await parseCodex(path))
  })

  it('opencode (part-assembled user turns)', () => {
    const path = join(dir, 'opencode.db')
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
    db.prepare(
      `INSERT INTO session (id, parent_id, workspace_id, directory, title, agent, model, version, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
       VALUES ('S', NULL, 'w1', '/repo', 'Fix session', 'build', '{"id":"m","providerID":"p"}', '1.17.9', 0.01,
         10, 2, 0, 0, 0, 1782000000000, 1782000100000)`,
    ).run()
    const insMsg = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
    insMsg.run('Mu', 'S', 1782000000000, JSON.stringify({ role: 'user', time: { created: 1782000000000 } }))
    insPart.run('Mu1', 'Mu', 'S', 1782000000000, JSON.stringify({ type: 'text', text: PROMPT }))
    insMsg.run('Ma', 'S', 1782000001000, JSON.stringify({
      role: 'assistant', modelID: 'm', providerID: 'p', path: { cwd: '/repo' }, cost: 0.01,
      time: { created: 1782000001000 }, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    insPart.run('Ma1', 'Ma', 'S', 1782000001000, JSON.stringify({ type: 'text', text: 'Done.' }))
    db.close()

    const sessions = buildSessions(openOpencodeDb(path), path)
    expect(sessions).toHaveLength(1)
    expectSighted(sessions[0]!)
  })

  it('pi', async () => {
    const path = join(dir, 'pi.jsonl')
    const lines = [
      { type: 'session', version: 3, id: 'sess-paste-001', timestamp: '2026-07-11T10:00:00.000Z', cwd: '/repo' },
      { type: 'model_change', id: 'e1', parentId: null, timestamp: '2026-07-11T10:00:00.001Z', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-07-11T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: PROMPT }], timestamp: 1783000000000 } },
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-07-11T10:00:02.000Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: 'messages', provider: 'anthropic', model: 'claude-sonnet-5',
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 1783000001000,
      } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    const result = await parsePi(path)
    expectSighted(Array.isArray(result) ? (result[0] ?? null) : result)
  })
})
