import { describe, expect, it } from 'vitest'
import { collectFollowups } from './followups'
import { emptyUsage, type Event, type Session } from '../../core/model'

function assistantText(seq: number, text: string): Event {
  return { kind: 'assistant', seq, isSidechain: false, blocks: [{ type: 'text', text }], usage: emptyUsage() }
}
// An assistant turn that issues a tool_use, plus the matching ToolCall the session carries.
function assistantBash(seq: number, id: string, command: string): { ev: Event; call: any } {
  return {
    ev: { kind: 'assistant', seq, isSidechain: false, blocks: [{ type: 'tool_use', id, name: 'Bash', input: {} } as any], usage: emptyUsage() },
    call: { id, name: 'Bash', action: 'shell', input: {}, target: { command }, result: { ok: true, isError: false }, isSidechain: false },
  }
}
function userTurn(seq: number, text: string): Event {
  return { kind: 'user', seq, isSidechain: false, text, blocks: [] }
}
// A harness-injected user-role turn (skill body, slash-command expansion).
function metaTurn(seq: number, text: string): Event {
  return { kind: 'user', seq, isSidechain: false, isMeta: true, text, blocks: [] }
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

  it('caps a long Bash tool-header command at 60 chars but keeps a short one whole', () => {
    const longCmd = 'npm test -- --coverage && git add -A && git commit -m "wip" && git push origin main'
    const shortCmd = 'npm test'
    const a = assistantBash(1, 'u1', longCmd)
    const b = assistantBash(2, 'u2', shortCmd)
    const session = sessionOf([
      userTurn(0, 'opener'),
      a.ev, b.ev,
      userTurn(3, 'that broke the build'),
    ])
    session.toolCalls = [a.call, b.call]
    const activity = collectFollowups(session)[0]!.activity!
    // Long command: keeps the 60-char prefix + ellipsis, drops the tail.
    expect(activity).toContain('[tool] Bash: ' + longCmd.slice(0, 60) + '…')
    expect(activity).not.toContain('git push origin main')
    // Short command: passes through untouched, no ellipsis.
    expect(activity).toContain('[tool] Bash: npm test')
  })
})

describe('collectFollowups excludes injected turns', () => {
  // Reproduces a real transcript: "review PR#62." → Claude invokes the `review`
  // skill → the harness expands the skill BODY into an isMeta user message. That
  // block is instructions, not the user reacting to the agent; counted as a
  // follow-up it inflates the steering signal and feeds the extraction LLM a
  // 200-word "correction" that never happened.
  const SKILL_BODY =
    'Review target: GitHub pull request `62`.\n\n' +
    "Gather this target's diff with (instead of any local `git diff`):\n" +
    '1. `gh pr view 62 --json title,body,author` for context\n' +
    '2. `gh pr diff 62` for the unified diff\n\n' +
    'Analyze the changes and provide a thorough code review.'

  it('does not treat an expanded skill body as a follow-up', () => {
    const session = sessionOf([
      userTurn(0, 'review PR#62.'),
      assistantText(1, 'Launching the review skill.'),
      metaTurn(2, SKILL_BODY),
      assistantText(3, 'Here is the review: …'),
    ])
    // The opener is the only real turn, so there is nothing to steer with.
    expect(collectFollowups(session)).toEqual([])
  })

  it('still reports the genuine follow-up that comes after an injected turn', () => {
    const session = sessionOf([
      userTurn(0, 'review PR#62.'),
      metaTurn(1, SKILL_BODY),
      assistantText(2, 'Here is the review: …'),
      userTurn(3, 'post 1,2,3,4 as comments please'),
    ])
    const fus = collectFollowups(session)
    expect(fus.map((f) => f.text)).toEqual(['post 1,2,3,4 as comments please'])
    // The injected block must not leak in as agent activity either — it is not
    // something the agent said.
    expect(fus[0]!.activity ?? '').not.toContain('Review target')
  })
})
