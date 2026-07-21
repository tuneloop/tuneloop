import { describe, expect, it } from 'vitest'
import { collectFollowups } from './followups'
import { emptyUsage, type Event, type Session } from '../../core/model'

function assistantText(seq: number, text: string): Event {
  return { kind: 'assistant', seq, isSidechain: false, blocks: [{ type: 'text', text }], usage: emptyUsage() }
}
function userTurn(seq: number, text: string): Event {
  return { kind: 'user', seq, isSidechain: false, text, blocks: [] }
}

function sessionOf(events: Event[]): Session {
  return {
    id: 's', sessionId: 's', source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/r', repo: 'o/r' }, startedAt: '2026-01-01T00:00:00Z',
    models: ['m'], tokens: emptyUsage(), events, toolCalls: [],
    raw: { path: '/x', contentHash: 'h' },
  }
}

describe('collectFollowups activity clipping', () => {
  it('keeps the last assistant message full but head+tail clips earlier ones', () => {
    const far = 'F'.repeat(2000) // an early, verbose assistant message (2+ steps from the turn)
    const near = 'N'.repeat(2000) // the message the user directly reacts to
    const session = sessionOf([
      userTurn(0, 'opener'),
      assistantText(1, far),
      assistantText(2, near),
      userTurn(3, 'no, that is wrong, redo it'),
    ])
    const [fu] = collectFollowups(session)
    expect(fu).toBeDefined()
    const activity = fu!.activity!
    // The near (last) message survives whole; the far one is clipped with a marker.
    expect(activity).toContain(near)
    expect(activity).not.toContain(far)
    expect(activity).toContain('chars clipped')
  })

  it('does not clip a short earlier message (under the head+tail budget)', () => {
    const session = sessionOf([
      userTurn(0, 'opener'),
      assistantText(1, 'a brief note'),
      assistantText(2, 'the final thing before the user reacts'),
      userTurn(3, 'wrong, try again'),
    ])
    const [fu] = collectFollowups(session)
    expect(fu!.activity).toContain('a brief note')
    expect(fu!.activity).not.toContain('chars clipped')
  })
})
