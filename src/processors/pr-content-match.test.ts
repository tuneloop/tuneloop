import { beforeEach, describe, expect, it } from 'vitest'
import { prContentMatch, parseDiff, parseCodexPatch, __resetPrCache } from './pr-content-match'
import { emptyUsage } from '../core/model'
import type { CanonicalAction, Event, Session, ToolCall } from '../core/model'
import type { ProcessorContext, ShResult } from '../core/processor'

type Spec = { kind: 'edit'; file: string; newString: string } | { kind: 'shell'; command: string; raw?: string }

// Builds a session with one user turn then one assistant message per spec, with the
// seq/tool_use wiring deterministicBlocks + blockMembership need.
function session(specs: Spec[]): Session {
  const events: Event[] = [{ kind: 'user', text: 'do the thing', blocks: [], isSidechain: false, seq: 0 }]
  const toolCalls: ToolCall[] = []
  specs.forEach((s, i) => {
    const id = `t${i}`
    if (s.kind === 'edit') {
      const input = { file_path: s.file, new_string: s.newString }
      events.push({ kind: 'assistant', blocks: [{ type: 'tool_use', id, name: 'Edit', input }], usage: emptyUsage(), isSidechain: false, seq: i + 1 })
      toolCalls.push({ id, name: 'Edit', action: 'file_write' as CanonicalAction, input, target: { paths: [s.file] }, result: { ok: true, isError: false }, isSidechain: false })
    } else {
      const input = { command: s.command }
      events.push({ kind: 'assistant', blocks: [{ type: 'tool_use', id, name: 'Bash', input }], usage: emptyUsage(), isSidechain: false, seq: i + 1 })
      toolCalls.push({ id, name: 'Bash', action: 'shell' as CanonicalAction, input, target: { command: s.command }, result: { ok: true, isError: false, raw: s.raw }, isSidechain: false })
    }
  })
  return {
    id: 'claude-code:s', sessionId: 's', source: 'claude-code', provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' }, models: [], tokens: emptyUsage(), endedAt: '2026-06-30T00:00:00Z',
    events, toolCalls, raw: { path: '', contentHash: 'h' },
  }
}

const AUTHORED = [
  'export function add(a, b) {',
  '  const sum = a + b',
  "  logger.info('adding')",
  '  return sum',
  '}',
  "export const VERSION = '1.2.3'",
  '  const internal = computeThing(42)',
  '  doSideEffect(internal)',
].join('\n')

// A unified diff that adds the same lines under src/foo.ts (full content match).
function diff(added: string[]): string {
  return ['diff --git a/src/foo.ts b/src/foo.ts', 'index a..b 100644', '--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -0,0 +1,8 @@', ...added.map((l) => '+' + l)].join('\n')
}
const FULL_DIFF = diff(AUTHORED.split('\n'))

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
function ctx(s: Session, sh: ProcessorContext['sh']): ProcessorContext {
  return { session: s, log: noopLog, llmEnabled: false, llm: null, existingFeatures: [], rejectedFeatureTitles: [], sh }
}

// gh/git stub: toplevel /repo, origin o/r, a configurable PR list + per-number diffs.
function sh(prList: unknown[], diffs: Record<number, string>): ProcessorContext['sh'] {
  return async (cmd: string, args: string[]): Promise<ShResult | null> => {
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: '/repo\n', code: 0 }
    if (cmd === 'git' && args.includes('remote')) return { stdout: 'git@github.com:o/r.git\n', code: 0 }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { stdout: JSON.stringify(prList), code: 0 }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') {
      const d = diffs[Number(args[2])]
      return d ? { stdout: d, code: 0 } : null
    }
    return null
  }
}
const pr = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `PR ${number}`, author: { login: 'me' }, state: 'MERGED', createdAt: '2026-06-01T00:00:00Z', mergedAt: '2026-06-02T00:00:00Z', additions: 8, deletions: 0, ...extra })

describe('pr-content-match', () => {
  beforeEach(() => __resetPrCache())

  it('links a human-pushed PR whose diff matches the agent-authored lines', async () => {
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(5)], { 5: FULL_DIFF })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', source: 'derived', confidence: 1 }))
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:5', kind: 'pr', title: 'PR 5', json: { addedLines: 7 } }))
    expect(res.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_contributed', artifactId: 'pr:o/r:5' }))
    expect(res.blockArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', source: 'derived' }))
  })

  it('still measures attribution for a self-created PR, but defers its cost/outcome to outcomes-git', async () => {
    const s = session([
      { kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED },
      { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/7' },
    ])
    const res = await prContentMatch.run(ctx(s, sh([pr(7)], { 7: FULL_DIFF })))
    // Attribution link IS recorded (AI-attribution % is wanted for the agent's own PRs)…
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:7', role: 'edited', confidence: 1 }))
    // …but block-cost + the contributed outcome are left to outcomes-git (no redundant rows).
    expect((res.outcomes ?? []).some((o) => o.artifactId === 'pr:o/r:7')).toBe(false)
    expect((res.blockArtifacts ?? []).some((b) => b.artifactId === 'pr:o/r:7')).toBe(false)
  })

  it('links a small PR the agent fully authored (just clears the matched-line floor)', async () => {
    // 4 meaningful added lines, all authored by the session → matched 4 ≥ MIN_MATCHED(3)
    // and confidence 1.0 → a credible link even for a tiny PR.
    const small = diff(['export function add(a, b) {', '  const sum = a + b', "  logger.info('adding')", '  return sum'])
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(5)], { 5: small })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', confidence: 1 }))
  })

  it('does not link below the matched-line floor', async () => {
    // PR adds one matching line + unrelated content → matched (1) < MIN_MATCHED.
    const thin = diff(['  return sum', 'totally unrelated content here', 'another unrelated line entirely'])
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(9)], { 9: thin })))
    expect(res.sessionArtifacts ?? []).toEqual([])
  })

  it('only considers the user’s own PRs (gh pr list is author-scoped)', async () => {
    // The stub returns no PRs (as if --author @me filtered them all out) → no links.
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([], {})))
    expect(res.sessionArtifacts ?? []).toEqual([])
  })

  it('extracts authored lines from an OpenCode session (camelCase write/edit fields)', async () => {
    const oc: Session = {
      id: 'opencode:s', sessionId: 's', source: 'opencode', provider: 'anthropic',
      project: { cwd: '/repo', repo: 'o/r' }, models: [], tokens: emptyUsage(), endedAt: '2026-06-30T00:00:00Z',
      events: [
        { kind: 'user', text: 'do it', blocks: [], isSidechain: false, seq: 0 },
        { kind: 'assistant', blocks: [{ type: 'tool_use', id: 't0', name: 'write', input: { filePath: '/repo/src/foo.ts', content: AUTHORED } }], usage: emptyUsage(), isSidechain: false, seq: 1 },
      ],
      toolCalls: [{ id: 't0', name: 'write', action: 'file_write' as CanonicalAction, input: { filePath: '/repo/src/foo.ts', content: AUTHORED }, target: { paths: ['/repo/src/foo.ts'] }, result: { ok: true, isError: false }, isSidechain: false }],
      raw: { path: '', contentHash: 'h' },
    }
    const res = await prContentMatch.run(ctx(oc, sh([pr(5)], { 5: FULL_DIFF })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', confidence: 1 }))
  })

  it('extracts authored lines from a Codex apply_patch (raw *** Begin Patch string)', async () => {
    const patch = ['*** Begin Patch', '*** Add File: src/foo.ts', ...AUTHORED.split('\n').map((l) => '+' + l), '*** End Patch'].join('\n')
    const cx: Session = {
      id: 'codex:s', sessionId: 's', source: 'codex', provider: 'openai',
      project: { cwd: '/repo', repo: 'o/r' }, models: [], tokens: emptyUsage(), endedAt: '2026-06-30T00:00:00Z',
      events: [
        { kind: 'user', text: 'do it', blocks: [], isSidechain: false, seq: 0 },
        { kind: 'assistant', blocks: [{ type: 'tool_use', id: 't0', name: 'apply_patch', input: patch }], usage: emptyUsage(), isSidechain: false, seq: 1 },
      ],
      toolCalls: [{ id: 't0', name: 'apply_patch', action: 'file_write' as CanonicalAction, input: patch, target: { paths: ['src/foo.ts'] }, result: { ok: true, isError: false }, isSidechain: false }],
      raw: { path: '', contentHash: 'h' },
    }
    const res = await prContentMatch.run(ctx(cx, sh([pr(5)], { 5: FULL_DIFF })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', confidence: 1 }))
  })

  it('extracts authored lines from an OpenCode apply_patch ({ patchText }) plus an edit', async () => {
    const patchText = ['*** Begin Patch', '*** Add File: src/foo.ts', ...AUTHORED.split('\n').slice(0, 5).map((l) => '+' + l), '*** End Patch'].join('\n')
    const editBody = AUTHORED.split('\n').slice(5).join('\n')
    const oc: Session = {
      id: 'opencode:s', sessionId: 's', source: 'opencode', provider: 'anthropic',
      project: { cwd: '/repo', repo: 'o/r' }, models: [], tokens: emptyUsage(), endedAt: '2026-06-30T00:00:00Z',
      events: [
        { kind: 'user', text: 'do it', blocks: [], isSidechain: false, seq: 0 },
        { kind: 'assistant', blocks: [{ type: 'tool_use', id: 't0', name: 'apply_patch', input: { patchText } }], usage: emptyUsage(), isSidechain: false, seq: 1 },
        { kind: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'edit', input: { filePath: '/repo/src/foo.ts', oldString: '', newString: editBody } }], usage: emptyUsage(), isSidechain: false, seq: 2 },
      ],
      toolCalls: [
        { id: 't0', name: 'apply_patch', action: 'file_write' as CanonicalAction, input: { patchText }, target: {}, result: { ok: true, isError: false }, isSidechain: false },
        { id: 't1', name: 'edit', action: 'file_write' as CanonicalAction, input: { filePath: '/repo/src/foo.ts', oldString: '', newString: editBody }, target: { paths: ['/repo/src/foo.ts'] }, result: { ok: true, isError: false }, isSidechain: false },
      ],
      raw: { path: '', contentHash: 'h' },
    }
    // apply_patch supplies the first 5 lines, the edit's newString the rest → the full diff.
    const res = await prContentMatch.run(ctx(oc, sh([pr(5)], { 5: FULL_DIFF })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'edited', confidence: 1 }))
  })

  it('skips a PR that merged before the session started (cannot contain its code)', async () => {
    // pr(5) merged 2026-06-02; session started 2026-06-10 → provably not this session's work.
    const s = { ...session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), startedAt: '2026-06-10T00:00:00Z' }
    const res = await prContentMatch.run(ctx(s, sh([pr(5)], { 5: FULL_DIFF })))
    expect(res.sessionArtifacts ?? []).toEqual([])
  })

  it('keeps a PR that merged after the session started', async () => {
    const s = { ...session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), startedAt: '2026-06-01T00:00:00Z' }
    const res = await prContentMatch.run(ctx(s, sh([pr(5)], { 5: FULL_DIFF }))) // pr(5) merged 2026-06-02
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', confidence: 1 }))
  })

  it('does not cache a transient gh failure (later sessions in the repo still match)', async () => {
    // First `gh pr list` fails (code 1); a second attempt succeeds. The failure must not
    // poison the per-repo cache — otherwise every later session sees zero candidate PRs.
    let listCalls = 0
    const flaky: ProcessorContext['sh'] = async (cmd, args) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: '/repo\n', code: 0 }
      if (cmd === 'git' && args.includes('remote')) return { stdout: 'git@github.com:o/r.git\n', code: 0 }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return ++listCalls === 1 ? { stdout: '', code: 1 } : { stdout: JSON.stringify([pr(5)]), code: 0 }
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return Number(args[2]) === 5 ? { stdout: FULL_DIFF, code: 0 } : null
      return null
    }
    const s = () => session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }])
    const first = await prContentMatch.run(ctx(s(), flaky))
    expect(first.sessionArtifacts ?? []).toEqual([]) // gh failed → no links this run
    const second = await prContentMatch.run(ctx(s(), flaky))
    expect(second.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', confidence: 1 }))
  })

  it('does nothing for a read-only session (no file writes)', async () => {
    const res = await prContentMatch.run(ctx(session([{ kind: 'shell', command: 'ls' }]), sh([pr(5)], { 5: FULL_DIFF })))
    expect(res).toEqual({})
  })
})

describe('parseCodexPatch', () => {
  it('extracts added lines per file across Add/Update, following a Move to: rename', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const a = 1',
      '+export const b = 2',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '+const moved = true',
      '*** End Patch',
    ].join('\n')
    const files = parseCodexPatch(patch)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.lines]))
    expect(byPath['src/new.ts']).toEqual(['export const a = 1', 'export const b = 2'])
    // Added lines after a Move to: are attributed to the NEW path, not the old one
    // (the old path may linger as an empty entry, which matches nothing downstream).
    expect(byPath['src/renamed.ts']).toEqual(['const moved = true'])
    expect(byPath['src/old.ts'] ?? []).toEqual([])
  })
})

describe('parseDiff', () => {
  it('extracts per-file added lines, ignoring hunk headers and the +++ marker', () => {
    const files = parseDiff(FULL_DIFF)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('src/foo.ts')
    expect(files[0]!.added).toContain('export function add(a, b) {')
    expect(files[0]!.added).not.toContain('+++ b/src/foo.ts')
  })
})
