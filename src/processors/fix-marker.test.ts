import { describe, expect, it } from 'vitest'
import { fixMarker } from './fix-marker'
import { emptyUsage } from '../core/model'
import type { Event, Session } from '../core/model'
import type { ProcessorContext } from '../core/processor'

const ID_A = 'aaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbb'
const marker = (id: string) => `tuneloop-fix: ${id}\n\nAcross 6 sessions...\nTask: fix it.`

function buildSession(events: Event[], over: Partial<Session> = {}): Session {
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' },
    startedAt: '2026-07-10T08:00:00Z',
    models: [],
    tokens: emptyUsage(),
    events,
    toolCalls: [],
    raw: { path: '', contentHash: 'h' },
    ...over,
  }
}

function run(session: Session) {
  const ctx = { session, log: { debug() {}, info() {}, warn() {} } } as unknown as ProcessorContext
  return fixMarker.run(ctx) as { fixMarkerSightings: Array<{ insightId: string; seq: number; turnAt: string }> }
}

describe('fix-marker processor', () => {
  it('sights a marker in a real user turn, with seq and the turn timestamp', () => {
    const session = buildSession([
      { kind: 'user', text: 'hello', blocks: [], isSidechain: false, seq: 0, ts: '2026-07-10T09:00:00Z' },
      { kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 4, ts: '2026-07-10T09:05:00Z' },
    ])
    expect(run(session).fixMarkerSightings).toEqual([{ insightId: ID_A, seq: 4, turnAt: '2026-07-10T09:05:00Z' }])
  })

  it('falls back to session start when the turn has no timestamp', () => {
    const session = buildSession([{ kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 0 }])
    expect(run(session).fixMarkerSightings[0]!.turnAt).toBe('2026-07-10T08:00:00Z')
  })

  it('skips the sighting when there is no event timestamp at all (never stamps scan time)', () => {
    const session = buildSession([{ kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 0 }], { startedAt: undefined })
    expect(run(session).fixMarkerSightings).toEqual([])
  })

  it('ignores markers quoted in agent output, synthetic user turns, reminder blocks, and sidechains', () => {
    const session = buildSession([
      // Agent echoing the marker back in a summary.
      { kind: 'assistant', text: '', blocks: [{ type: 'text', text: marker(ID_A) }], usage: emptyUsage(), isSidechain: false, seq: 0 } as unknown as Event,
      // Claude-injected machinery: slash-command echo quoting the marker.
      { kind: 'user', text: `<command-name>/fix</command-name><command-args>${marker(ID_A)}</command-args>`, blocks: [], isSidechain: false, seq: 1 },
      // Marker inside an injected <system-reminder> within an otherwise-real turn (e.g. recalled memory).
      { kind: 'user', text: `continue please <system-reminder>${marker(ID_A)}</system-reminder>`, blocks: [], isSidechain: false, seq: 2 },
      // Sidechain "user" turn — parent-authored subagent prompt (no seq by construction).
      { kind: 'user', text: marker(ID_A), blocks: [], isSidechain: true },
    ])
    expect(run(session).fixMarkerSightings).toEqual([])
  })

  it('two different markers → two sightings; the same marker twice → one (matches the PK)', () => {
    const session = buildSession([
      { kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 0, ts: '2026-07-10T09:00:00Z' },
      { kind: 'user', text: marker(ID_B), blocks: [], isSidechain: false, seq: 5, ts: '2026-07-10T09:10:00Z' },
      { kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 9, ts: '2026-07-10T09:20:00Z' },
    ])
    expect(run(session).fixMarkerSightings.map((s) => s.insightId)).toEqual([ID_A, ID_B])
  })

  it('always emits the field, even with no markers, so stale sightings get wiped on re-scan', () => {
    const session = buildSession([{ kind: 'user', text: 'just a normal prompt', blocks: [], isSidechain: false, seq: 0 }])
    expect(run(session).fixMarkerSightings).toEqual([])
  })

  it('a Codex orphan fork replaying the parent marker turn is sighted under the child (benign: adoption is idempotent)', () => {
    // Parent rollout file rotated away → inherited prefix not trimmed (ADR-0005),
    // so the replayed marker turn looks like the child's own real user turn.
    const child = buildSession(
      [{ kind: 'user', text: marker(ID_A), blocks: [], isSidechain: false, seq: 0, ts: '2026-07-10T09:00:00Z' }],
      { id: 'codex:child', sessionId: 'child', source: 'codex', provider: 'openai', forkedFromId: 'gone' },
    )
    expect(run(child).fixMarkerSightings.map((s) => s.insightId)).toEqual([ID_A])
  })
})
