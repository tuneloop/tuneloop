import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeSessionCost } from '../../pricing/pricing'
import { parseClaudeCode } from './parse'

const SID = 'aaaa0000-1111-2222-3333-444444444444'
const USAGE = { input_tokens: 4, output_tokens: 120, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 200_000 }

// One API message streamed as two transcript lines (text block, then tool_use
// block) — same message id, the full usage repeated on both, as Claude Code
// writes it — followed by a genuinely separate second message.
const LINES = [
  { parentUuid: null, isSidechain: false, type: 'user', cwd: '/repo', sessionId: SID, uuid: 'u1', timestamp: '2026-07-14T09:00:00.000Z', message: { role: 'user', content: 'do the thing' } },
  { parentUuid: 'u1', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: SID, uuid: 'a1', timestamp: '2026-07-14T09:00:05.000Z', message: { id: 'msg_01', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: 'On it.' }], usage: USAGE } },
  { parentUuid: 'a1', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: SID, uuid: 'a2', timestamp: '2026-07-14T09:00:06.000Z', message: { id: 'msg_01', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: USAGE } },
  { parentUuid: 'a2', isSidechain: false, type: 'user', cwd: '/repo', sessionId: SID, uuid: 'u2', timestamp: '2026-07-14T09:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { parentUuid: 'u2', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: SID, uuid: 'a3', timestamp: '2026-07-14T09:00:09.000Z', message: { id: 'msg_02', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 6, output_tokens: 40, cache_creation_input_tokens: 500, cache_read_input_tokens: 230_000 } } },
]

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-parse-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function parse() {
  const path = join(dir, `${SID}.jsonl`)
  writeFileSync(path, LINES.map((l) => JSON.stringify(l)).join('\n'))
  const session = await parseClaudeCode(path)
  expect(session).not.toBeNull()
  return session!
}

describe('claude-code usage dedup (one API message = many transcript lines)', () => {
  it('counts usage once per API message id in the session totals', async () => {
    const session = await parse()
    expect(session.tokens).toEqual({ input: 10, output: 160, cacheCreate: 30_500, cacheRead: 430_000 })
  })

  it('keeps every line as an event (transcript intact); repeats carry zero usage', async () => {
    const session = await parse()
    const assistants = session.events.filter((e) => e.kind === 'assistant')
    expect(assistants).toHaveLength(3)
    expect(assistants.map((a) => (a.kind === 'assistant' ? a.usage.cacheRead : -1))).toEqual([200_000, 0, 230_000])
  })

  it('usage facts stay 1:1 with assistant events, but repeats price at $0', async () => {
    const session = await parse()
    const { facts } = computeSessionCost(session)
    expect(facts).toHaveLength(3)
    expect(facts[1]!.usd).toBe(0)
    expect(facts[0]!.usd).toBeGreaterThan(0)
    expect(facts[2]!.usd).toBeGreaterThan(0)
  })
})
