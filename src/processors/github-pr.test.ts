import { describe, expect, it } from 'vitest'
import { enrichPrArtifact, parsePrRefs, prArtifactBase } from './github-pr'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { ShResult } from '../core/processor'

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

  it('parses a GitHub Enterprise Server PR URL, keeping the enterprise host in the ref URL', () => {
    const refs = parsePrRefs(
      sess([tc('shell', { target: { command: 'gh pr merge https://github.acme-corp.com/acme/x/pull/7 --squash' } })]),
    )
    expect(refs).toEqual([
      expect.objectContaining({ id: 'pr:acme/x:7', kind: 'merge', url: 'https://github.acme-corp.com/acme/x/pull/7' }),
    ])
  })

  it('detects a read from `gh pr diff <num> --repo owner/repo`', () => {
    const refs = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr diff 21 --repo tuneloop/tuneloop' } })]))
    expect(refs).toEqual([
      expect.objectContaining({ id: 'pr:tuneloop/tuneloop:21', kind: 'read', url: 'https://github.com/tuneloop/tuneloop/pull/21' }),
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

  // ---- Layer 1: explicit reviews ------------------------------------------

  it('detects an explicit approve via `gh pr review --approve`', () => {
    const refs = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr review 22 --repo o/r --approve' } })]))
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:o/r:22', kind: 'review', verdict: 'approved' })])
  })

  it('detects request-changes and comment verdicts', () => {
    const rc = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr review https://github.com/o/r/pull/5 --request-changes -b "fix"' } })]))
    expect(rc[0]).toMatchObject({ id: 'pr:o/r:5', kind: 'review', verdict: 'changes_requested' })
    const cm = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr review 9 --repo o/r --comment -b "nit"' } })]))
    expect(cm[0]).toMatchObject({ id: 'pr:o/r:9', kind: 'review', verdict: 'commented' })
  })

  it('treats `gh pr diff` as a read, not a review (verb split)', () => {
    const refs = parsePrRefs(sess([tc('shell', { target: { command: 'gh pr diff 7 --repo o/r' } })]))
    expect(refs[0]).toMatchObject({ id: 'pr:o/r:7', kind: 'read' })
    expect(refs[0]).not.toHaveProperty('verdict')
  })

  it('detects an explicit review via a GitHub MCP review tool, with its event verdict', () => {
    const refs = parsePrRefs(
      sess([tc('mcp_call', { name: 'github__create_pull_request_review', input: { owner: 'o', repo: 'r', pull_number: 3, event: 'APPROVE' } })]),
    )
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:o/r:3', kind: 'review', verdict: 'approved' })])
  })

  it('treats an MCP get_pull_request_reviews (reading reviews) as a read', () => {
    const refs = parsePrRefs(
      sess([tc('mcp_call', { name: 'github__get_pull_request_reviews', input: { owner: 'o', repo: 'r', pull_number: 3 } })]),
    )
    expect(refs).toEqual([expect.objectContaining({ id: 'pr:o/r:3', kind: 'read' })])
  })
})

describe('enrichPrArtifact', () => {
  // A GHES externalId (host captured from a link): enrich must pass it through unchanged.
  const ref = { id: 'pr:acme/x:7', owner: 'acme', repo: 'x', num: '7', url: 'https://github.acme-corp.com/acme/x/pull/7', kind: 'read' as const, toolIndex: 0 }

  it('addresses gh by the full externalId URL, so the enterprise host round-trips', async () => {
    const calls: string[][] = []
    const sh = async (cmd: string, args: string[]): Promise<ShResult | null> => {
      calls.push([cmd, ...args])
      return { stdout: JSON.stringify({ title: 'Enterprise PR', state: 'OPEN' }), code: 0 }
    }
    const art = await enrichPrArtifact(sh, prArtifactBase(ref))
    expect(calls[0]).toEqual(['gh', 'pr', 'view', ref.url, '--json', 'title,state,createdAt,mergedAt,additions,deletions,author'])
    expect(art).toMatchObject({ externalId: ref.url, title: 'Enterprise PR', status: 'open' })
  })

  it('leaves the base row intact when gh is unavailable', async () => {
    const base = prArtifactBase(ref)
    expect(await enrichPrArtifact(async () => null, base)).toEqual(base)
  })
})
