import { describe, expect, it } from 'vitest'
import { firstUserPrompt } from './turns'
import type { Event, Session } from './model'

function session(events: Event[]): Session {
  return {
    id: 'claude-code:x',
    sessionId: 'x',
    source: 'claude-code',
    provider: 'anthropic',
    project: {},
    models: [],
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
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
    const s = session([{ kind: 'assistant', blocks: [], usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, isSidechain: false } as Event])
    expect(firstUserPrompt(s)).toBeNull()
  })
})
