import { describe, expect, it } from 'vitest'
import { parsePrRefs } from './github-pr'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'

function tc(action: CanonicalAction, fields: Partial<ToolCall>): ToolCall {
  return {
    id: 'tc',
    name: '',
    action,
    input: null,
    target: {},
    result: { ok: true, isError: false },
    isSidechain: false,
    ...fields,
  }
}

function sess(toolCalls: ToolCall[], events: Event[] = []): Session {
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo' },
    models: [],
    tokens: emptyUsage(),
    events,
    toolCalls,
    raw: { path: '', contentHash: '' },
  }
}

function userEvent(text: string, isSidechain = false): Event {
  return { kind: 'user', text, blocks: [], isSidechain }
}

describe('parsePrRefs', () => {
  it('detects a created PR from gh pr create output (the URL gh prints)', () => {
    const refs = parsePrRefs(
      sess([tc('shell', { target: { command: 'git push && gh pr create --fill' }, result: { ok: true, isError: false, raw: 'https://github.com/acme/x/pull/7\n' } })]),
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ id: 'pr:acme/x:7', kind: 'create', toolIndex: 0 })
  })

  it('detects a merged PR when the URL is the merge argument', () => {
    const refs = parsePrRefs(
      sess([tc('shell', { target: { command: 'gh pr merge https://github.com/acme/x/pull/7 --squash' } })]),
    )
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:acme/x:7', kind: 'merge' })])
  })

  it('detects a read from `gh pr diff <num> --repo owner/repo`', () => {
    const refs = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr diff 21 --repo Relvy-AI/aivue' } })]))
    expect(refs).toEqual([
      expect.objectContaining({ id: 'pr:Relvy-AI/aivue:21', kind: 'read', url: 'https://github.com/Relvy-AI/aivue/pull/21' }),
    ])
  })

  it('skips a bare `gh pr diff 21` with no repo (owner unknown)', () => {
    expect(parsePrRefs(sess([tc('shell', { target: { command: 'gh pr diff 21' } })]))).toEqual([])
  })

  it('does NOT pick up an incidental PR URL sitting in unrelated command output', () => {
    // A grep whose output merely contains a PR URL is not a review of that PR.
    const refs = parsePrRefs(
      sess([tc('shell', { target: { command: 'grep -r TODO src' }, result: { ok: true, isError: false, raw: 'see https://github.com/some/repo/pull/999' } })]),
    )
    expect(refs).toEqual([])
  })

  it('reads identity from the gh command, ignoring a different PR URL in its output', () => {
    // `gh pr view 5` whose body happens to mention pull/999 → only PR 5 counts.
    const refs = parsePrRefs(
      sess([tc('shell', { target: { command: 'gh pr view 5 --repo o/r' }, result: { ok: true, isError: false, raw: 'linked: https://github.com/o/r/pull/999' } })]),
    )
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:o/r:5', kind: 'read' })])
  })

  it('detects a read from a web fetch of a PR URL', () => {
    const refs = parsePrRefs(sess([tc('web', { input: { url: 'https://github.com/acme/x/pull/12' } })]))
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:acme/x:12', kind: 'read' })])
  })

  it('detects a read from a structured MCP get_pull_request input', () => {
    const refs = parsePrRefs(
      sess([tc('mcp_call', { name: 'github__get_pull_request', input: { owner: 'acme', repo: 'x', pull_number: 33 } })]),
    )
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:acme/x:33', kind: 'read' })])
  })

  it('detects a read from a PR link a human pasted in a prompt (toolIndex -1)', () => {
    const refs = parsePrRefs(sess([], [userEvent('please review https://github.com/acme/x/pull/8')]))
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:acme/x:8', kind: 'read', toolIndex: -1 })])
  })

  it('ignores a PR link in a sidechain (subagent) turn, not a real human prompt', () => {
    expect(parsePrRefs(sess([], [userEvent('https://github.com/acme/x/pull/8', true)]))).toEqual([])
  })
})
