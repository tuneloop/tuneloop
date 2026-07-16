import { describe, expect, it } from 'vitest'
import { emptyUsage, type Event, type Session } from './model'
import { firstUserPrompt, followupTurns, isApproval, userTurnEvents } from './turns'

function session(events: Event[]): Session {
  return {
    id: 'claude-code:x',
    sessionId: 'x',
    source: 'claude-code',
    provider: 'anthropic',
    project: {},
    models: [],
    tokens: emptyUsage(),
    events,
    toolCalls: [],
    raw: { path: '/x', contentHash: 'h' },
  }
}

function user(text: string, opts: Partial<Event> = {}): Event {
  return { kind: 'user', text, blocks: [], isSidechain: false, ...opts } as Event
}

describe('firstUserPrompt', () => {
  it('returns the first real human turn, whitespace-collapsed', () => {
    const s = session([user('Fix   the\n  login bug'), user('now add tests')])
    expect(firstUserPrompt(s)).toBe('Fix the login bug')
  })

  it('does not clip — returns the full prompt (presentation clips it)', () => {
    const long = 'a'.repeat(500)
    expect(firstUserPrompt(session([user(long)]))).toBe(long)
  })

  it('skips sidechain (subagent) turns', () => {
    const s = session([user('subagent noise', { isSidechain: true }), user('the real ask')])
    expect(firstUserPrompt(s)).toBe('the real ask')
  })

  it('skips injected system-reminder-only and synthetic turns', () => {
    const s = session([
      user('<system-reminder>be nice</system-reminder>'),
      user('<command-name>/clear</command-name>'),
      user('actually do the thing'),
    ])
    expect(firstUserPrompt(s)).toBe('actually do the thing')
  })

  it('strips a leading system-reminder but keeps the real prompt after it', () => {
    const s = session([user('<system-reminder>ctx</system-reminder>\nBuild the dashboard')])
    expect(firstUserPrompt(s)).toBe('Build the dashboard')
  })

  it('returns null when there is no genuine human prompt', () => {
    const s = session([
      { kind: 'assistant', blocks: [], usage: emptyUsage(), isSidechain: false },
    ])
    expect(firstUserPrompt(s)).toBeNull()
  })
})

describe('isApproval', () => {
  it('treats bare affirmations/continuations as approvals (case- and punctuation-insensitive)', () => {
    for (const t of ['yes', 'Yes!', 'ok', 'sure, go ahead', 'lgtm', 'looks good', 'ship it', 'continue', 'thanks']) {
      expect(isApproval(t)).toBe(true)
    }
  })

  it('empty / whitespace-only turns are approvals (nothing to steer with)', () => {
    expect(isApproval('')).toBe(true)
    expect(isApproval('   ')).toBe(true)
  })

  it('substantive turns are not approvals', () => {
    for (const t of ['no, use postgres instead', 'that broke the build', 'why did you delete that file']) {
      expect(isApproval(t)).toBe(false)
    }
  })

  it('a long turn is never a bare approval even if it opens with an approval word', () => {
    expect(isApproval('yes but also please refactor the parser and add tests')).toBe(false)
  })
})

describe('followupTurns', () => {
  it('drops the opener and bare approvals, keeps substantive follow-ups', () => {
    const turns = ['fix the bug', 'yes', 'no, the other file', 'lgtm', 'now add a test']
    expect(followupTurns(turns)).toEqual(['no, the other file', 'now add a test'])
  })

  it('an opener with no follow-ups yields nothing', () => {
    expect(followupTurns(['just the opener'])).toEqual([])
    expect(followupTurns([])).toEqual([])
  })
})

describe('userTurnEvents', () => {
  it('keeps each real turn with its seq; skips sidechain and synthetic turns', () => {
    const s = session([
      user('opener', { seq: 0 }),
      user('subagent', { seq: 1, isSidechain: true }),
      user('<command-name>/compact</command-name>', { seq: 2 }),
      user('real follow-up', { seq: 3 }),
    ])
    expect(userTurnEvents(s)).toEqual([
      { text: 'opener', seq: 0 },
      { text: 'real follow-up', seq: 3 },
    ])
  })
})
