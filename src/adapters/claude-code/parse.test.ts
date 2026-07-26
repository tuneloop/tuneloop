import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cacheCreateTotal } from '../../core/model'
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
    expect(session.tokens).toEqual({ input: 10, output: 160, cacheCreate5m: 30_500, cacheCreate1h: 0, cacheRead: 430_000 })
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

// Subagent transcripts don't repeat identical usage: Claude Code streams
// output_tokens UP across the message's blocks (input/cache stay fixed), so only
// the LAST line carries the true output — earlier lines report a partial count.
const STREAM_SID = 'bbbb0000-1111-2222-3333-444444444444'
const FIXED = { input_tokens: 8, cache_creation_input_tokens: 17_903, cache_read_input_tokens: 9417 }
const STREAM_LINES = [
  { parentUuid: null, isSidechain: true, type: 'user', cwd: '/repo', sessionId: STREAM_SID, uuid: 'su0', timestamp: '2026-07-14T10:00:00.000Z', message: { role: 'user', content: 'scan the diff' } },
  { parentUuid: 'su0', isSidechain: true, type: 'assistant', cwd: '/repo', sessionId: STREAM_SID, uuid: 'sa1', timestamp: '2026-07-14T10:00:01.000Z', message: { id: 'msg_s1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'thinking', thinking: '...' }], usage: { ...FIXED, output_tokens: 1 } } },
  { parentUuid: 'sa1', isSidechain: true, type: 'assistant', cwd: '/repo', sessionId: STREAM_SID, uuid: 'sa2', timestamp: '2026-07-14T10:00:02.000Z', message: { id: 'msg_s1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: "I'll scan it." }], usage: { ...FIXED, output_tokens: 1 } } },
  { parentUuid: 'sa2', isSidechain: true, type: 'assistant', cwd: '/repo', sessionId: STREAM_SID, uuid: 'sa3', timestamp: '2026-07-14T10:00:03.000Z', message: { id: 'msg_s1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 'st1', name: 'Bash', input: { command: 'git diff' } }], usage: { ...FIXED, output_tokens: 17_655 } } },
]

async function parseStream() {
  const path = join(dir, `${STREAM_SID}.jsonl`)
  writeFileSync(path, STREAM_LINES.map((l) => JSON.stringify(l)).join('\n'))
  const session = await parseClaudeCode(path)
  expect(session).not.toBeNull()
  return session!
}

describe('claude-code usage dedup (subagent output_tokens stream up across lines)', () => {
  it('counts the final (last-line) output, not the partial first line', async () => {
    const session = await parseStream()
    // Not 1 (first line), not 1+1+17655 (per-line sum) — the message's final usage.
    expect(session.tokens).toEqual({ input: 8, output: 17_655, cacheCreate5m: 17_903, cacheCreate1h: 0, cacheRead: 9417 })
  })

  it('attributes the full message usage to the first event; repeats carry zero', async () => {
    const session = await parseStream()
    const assistants = session.events.filter((e) => e.kind === 'assistant')
    expect(assistants).toHaveLength(3)
    expect(assistants.map((a) => (a.kind === 'assistant' ? a.usage.output : -1))).toEqual([17_655, 0, 0])
  })
})

// Claude Code splits cache creation across TTLs and bills them differently — a
// 1h write costs 2x input vs 1.25x for 5m. Pricing it all at 5m under-counts.
const TTL_SID = 'cccc0000-1111-2222-3333-444444444444'
const ttlLines = (fiveMin: number, oneHour: number) => [
  { parentUuid: null, isSidechain: false, type: 'user', cwd: '/repo', sessionId: TTL_SID, uuid: 'tu0', timestamp: '2026-07-14T11:00:00.000Z', message: { role: 'user', content: 'hi' } },
  { parentUuid: 'tu0', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: TTL_SID, uuid: 'ta1', timestamp: '2026-07-14T11:00:01.000Z', message: { id: 'msg_t1', model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: fiveMin + oneHour, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: fiveMin, ephemeral_1h_input_tokens: oneHour } } } },
]

async function parseTtl(fiveMin: number, oneHour: number) {
  const path = join(dir, `${TTL_SID}.jsonl`)
  writeFileSync(path, ttlLines(fiveMin, oneHour).map((l) => JSON.stringify(l)).join('\n'))
  const session = await parseClaudeCode(path)
  expect(session).not.toBeNull()
  return session!
}

describe('claude-code cache-creation TTL split', () => {
  it('splits the cache-creation total into disjoint 5m and 1h parts', async () => {
    const session = await parseTtl(400_000, 600_000)
    expect(session.tokens.cacheCreate5m).toBe(400_000)
    expect(session.tokens.cacheCreate1h).toBe(600_000)
    expect(cacheCreateTotal(session.tokens)).toBe(1_000_000) // disjoint: the two re-sum to the write total
  })

  it('prices each TTL at its own rate', async () => {
    // opus-4-8: 5m write $6.25/MTok, 1h write $10/MTok. 0.4M @ 6.25 + 0.6M @ 10 = $8.50.
    // Billing the whole 1M at the 5m rate would say $6.25 — the old under-count.
    const { usd } = computeSessionCost(await parseTtl(400_000, 600_000))
    expect(usd).toBeCloseTo(8.5, 6)
  })

  it('prices an all-5m write exactly as before', async () => {
    const { usd } = computeSessionCost(await parseTtl(1_000_000, 0))
    expect(usd).toBeCloseTo(6.25, 6)
  })

  it('treats a transcript without the TTL breakdown as all-5m, keeping every token', async () => {
    const path = join(dir, `${TTL_SID}-nottl.jsonl`)
    const lines = ttlLines(0, 0)
    // Claude Code predating the breakdown: a write total, no `cache_creation` at
    // all. Reading the ephemeral_* fields straight off it would zero BOTH TTLs and
    // silently drop the whole 1M-token write from tokens and cost — hence all three
    // assertions, not just the cost one.
    ;(lines[1] as any).message.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 }
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    const session = (await parseClaudeCode(path))!
    expect(session.tokens.cacheCreate5m).toBe(1_000_000)
    expect(session.tokens.cacheCreate1h).toBe(0)
    expect(computeSessionCost(session).usd).toBeCloseTo(6.25, 6)
  })
})

describe('claude-code isMeta (harness-injected user turns)', () => {
  const META_SID = 'cccc0000-1111-2222-3333-444444444444'

  it('carries isMeta through to the user event, and leaves real turns unflagged', async () => {
    const path = join(dir, `${META_SID}.jsonl`)
    const lines = [
      { parentUuid: null, isSidechain: false, type: 'user', cwd: '/repo', sessionId: META_SID, uuid: 'm1', timestamp: '2026-07-08T20:20:04.762Z', message: { role: 'user', content: 'review PR#62.' } },
      { parentUuid: 'm1', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: META_SID, uuid: 'm2', timestamp: '2026-07-08T20:20:11.936Z', message: { id: 'msg_m1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'review', args: '62' } }], usage: USAGE } },
      // The skill body: role user, but isMeta — the harness wrote it, not the human.
      { parentUuid: 'm2', isSidechain: false, isMeta: true, type: 'user', cwd: '/repo', sessionId: META_SID, uuid: 'm3', timestamp: '2026-07-08T20:20:11.945Z', message: { role: 'user', content: 'Review target: GitHub pull request `62`.' } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    const session = (await parseClaudeCode(path))!
    const users = session.events.filter((e) => e.kind === 'user')
    expect(users.map((u) => (u.kind === 'user' ? !!u.isMeta : null))).toEqual([false, true])
  })
})

describe('claude-code explicit skill invocation (/skill-name)', () => {
  const EXP_SID = 'dddd0000-1111-2222-3333-444444444444'

  it('captures a skill invoked via the /skill-name command envelope as a skill tool call', async () => {
    const path = join(dir, `${EXP_SID}.jsonl`)
    // The explicit `/hello-world` path: a <command-name> user turn, then an isMeta user
    // turn injecting the SKILL.md body prefixed "Base directory for this skill: <dir>".
    // No `Skill` tool_use is emitted — the model acts directly (Bash). We synthesize the
    // skill invocation from the isMeta body so `action='skill'` capture is not lost.
    const lines = [
      { parentUuid: null, isSidechain: false, type: 'user', cwd: '/repo', sessionId: EXP_SID, uuid: 'x1', timestamp: '2026-07-24T13:12:00.000Z', message: { role: 'user', content: '<command-message>hello-world</command-message>\n<command-name>/hello-world</command-name>' } },
      { parentUuid: 'x1', isSidechain: false, isMeta: true, type: 'user', cwd: '/repo', sessionId: EXP_SID, uuid: 'x2', timestamp: '2026-07-24T13:12:00.100Z', message: { role: 'user', content: 'Base directory for this skill: /repo/.claude/skills/hello-world\n\n# Hello World\n\nRun ./greet.sh' } },
      { parentUuid: 'x2', isSidechain: false, type: 'assistant', cwd: '/repo', sessionId: EXP_SID, uuid: 'x3', timestamp: '2026-07-24T13:12:01.000Z', message: { id: 'msg_x1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: './greet.sh' } }], usage: USAGE } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    const session = (await parseClaudeCode(path))!
    const skills = session.toolCalls.filter((t) => t.action === 'skill')
    expect(skills.map((s) => s.name)).toEqual(['hello-world'])
  })
})
