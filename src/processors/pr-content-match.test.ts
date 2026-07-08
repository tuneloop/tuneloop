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

// Like diff() but with removed lines too (a hunk that rewrites code).
function diffRw(removed: string[], added: string[]): string {
  return [
    'diff --git a/src/foo.ts b/src/foo.ts', 'index a..b 100644', '--- a/src/foo.ts', '+++ b/src/foo.ts',
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => '-' + l), ...added.map((l) => '+' + l),
  ].join('\n')
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
function ctx(s: Session, sh: ProcessorContext['sh']): ProcessorContext {
  return { session: s, log: noopLog, llmEnabled: false, llm: null, existingFeatures: [], rejectedFeatureTitles: [], userLinkedArtifacts: [], prBlockAttributions: [], sh }
}

// gh/git stub: toplevel /repo, origin o/r, a configurable PR list + per-number diffs.
// `baseBlobs` serves `git cat-file blob <hash>` (keyed by hash) for base-containment tests;
// a missing hash fails like a blob absent from the clone.
function sh(prList: unknown[], diffs: Record<number, string>, baseBlobs: Record<string, string> = {}): ProcessorContext['sh'] {
  return async (cmd: string, args: string[]): Promise<ShResult | null> => {
    if (cmd === 'git' && args[0] === 'cat-file') {
      const body = baseBlobs[args[2]!]
      return body != null ? { stdout: body, code: 0 } : { stdout: '', code: 128 }
    }
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
    expect(res.blockArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:5', role: 'contributed', source: 'derived' }))
  })

  it('uses gh’s host-correct url as the PR externalId (GHES round-trip, not a github.com guess)', async () => {
    const ghesUrl = 'https://github.acme-corp.com/o/r/pull/5'
    const res = await prContentMatch.run(
      ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(5, { url: ghesUrl })], { 5: FULL_DIFF })),
    )
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:5', externalId: ghesUrl }))
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

  it('does not link a PR that only MOVES session-authored code (removed+re-added)', async () => {
    // A later refactor PR re-indents/relocates lines the session once authored: every
    // added line also appears as a removed line, so nothing is net-new → no link.
    const lines = AUTHORED.split('\n')
    const moved = diffRw(lines, lines.map((l) => '    ' + l))
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(46)], { 46: moved })))
    expect(res.sessionArtifacts ?? []).toEqual([])
  })

  it('excludes moved lines from the denominator, not just the numerator', async () => {
    // PR moves 4 foreign lines and genuinely adds 3 session-authored ones →
    // confidence is 3/3 over net-new content, not 3/7.
    const foreign = ['const a = old1()', 'const b = old2()', 'const c = old3()', 'const d = old4()']
    const netNew = ['export function add(a, b) {', '  const sum = a + b', '  return sum']
    const mixed = diffRw(foreign, [...foreign.map((l) => '  ' + l), ...netNew])
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(12)], { 12: mixed })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:12', confidence: 1 }))
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:12', json: { addedLines: 3 } }))
  })

  it('does not link a PR whose added lines DUPLICATE code already in the base file', async () => {
    // The originals aren't removed (so the removed-lines rule can't catch it),
    // but they exist in the base blob (`index a..b`) → not new content → no link.
    const cloned = ['export function add(a, b) {', '  const sum = a + b', "  logger.info('adding')", '  return sum']
    const d = diff([...cloned, 'const brandNewThing = 1', 'const anotherNewThing = 2'])
    const base = ['// preamble', ...cloned, '// rest of file'].join('\n')
    const res = await prContentMatch.run(ctx(
      session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]),
      sh([pr(16)], { 16: d }, { a: base }),
    ))
    // cloned lines excluded from both sides: matched 0 of the 2 truly-new lines → no link
    expect(res.sessionArtifacts ?? []).toEqual([])
  })

  it('falls back to the removed-lines rule when the base blob is not in the clone', async () => {
    // Same duplication scenario but `git cat-file` fails (blob unfetched): the cloned
    // lines match and the link goes through — documents the degraded mode.
    const cloned = ['export function add(a, b) {', '  const sum = a + b', "  logger.info('adding')", '  return sum']
    const res = await prContentMatch.run(ctx(
      session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]),
      sh([pr(16)], { 16: diff(cloned) }),
    ))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:16', confidence: 1 }))
  })

  it('treats a zero old blob (file new at base) as all-new content', async () => {
    // `index 0000000..b` = the file did not exist at base → nothing pre-existing to
    // exclude, even though cat-file would fail for the zero hash.
    const newFile = FULL_DIFF.replace('index a..b 100644', 'index 0000000..b 100644')
    const res = await prContentMatch.run(ctx(
      session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]),
      sh([pr(21)], { 21: newFile }),
    ))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:21', confidence: 1 }))
  })

  it('excludes machine-generated lockfiles from the attribution fraction', async () => {
    // PR = 7 matched foo.ts lines + a big package-lock.json blob the session never
    // wrote → lockfile lines must not deflate the % (7/7, not 7/12).
    const lock = [
      'diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -0,0 +1,5 @@',
      ...['"lockfileVersion": 3,', '"node_modules/x": {', '"version": "1.0.0",', '"resolved": "https://registry.npmjs.org/x",', '"integrity": "sha512-abc",'].map((l) => '+' + l),
    ].join('\n')
    const res = await prContentMatch.run(ctx(session([{ kind: 'edit', file: '/repo/src/foo.ts', newString: AUTHORED }]), sh([pr(13)], { 13: FULL_DIFF + '\n' + lock })))
    expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:13', confidence: 1 }))
    expect(res.artifacts).toContainEqual(expect.objectContaining({ id: 'pr:o/r:13', json: { addedLines: 7 } }))
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

  // "Session A": PR#3 created by the session, PR#7 human-pushed, PR#11 created by the
  // session, then unrelated trailing work. The unified backward-fill must give PR#7 its
  // own contiguous block segment instead of letting PR#11's explicit fill absorb it —
  // and emit rows ONLY for the inferred PR (explicit segments stay outcomes-git's).
  describe('unified block fill', () => {
    const chunk = (tag: string) => [`const ${tag} = 1`, `function f_${tag}() {`, `  return ${tag} + 100`]
    const A = chunk('alpha'), B = chunk('beta'), C = chunk('gamma'), D = chunk('delta')
    const diffFor = (path: string, added: string[]) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1 @@', ...added.map((l) => '+' + l)].join('\n')

    it('a human-pushed PR reclaims its contiguous segment between two created PRs', async () => {
      const s = session([
        { kind: 'edit', file: '/repo/src/a.ts', newString: A.join('\n') }, // block 0
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/3' }, // closes block 0
        { kind: 'edit', file: '/repo/src/b.ts', newString: B.join('\n') }, // block 1 (PR#7's work)
        { kind: 'shell', command: 'git commit -m wip' }, // closes block 1
        { kind: 'edit', file: '/repo/src/c.ts', newString: C.join('\n') }, // block 2
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/11' }, // closes block 2
        { kind: 'edit', file: '/repo/src/d.ts', newString: D.join('\n') }, // block 3, trailing (no PR)
      ])
      const stub = sh([pr(3), pr(7), pr(11)], { 3: diffFor('src/a.ts', A), 7: diffFor('src/b.ts', B), 11: diffFor('src/c.ts', C) })
      const res = await prContentMatch.run(ctx(s, stub))
      // Attribution links for all three PRs; block rows ONLY for the inferred PR#7,
      // exactly its segment (block 1) — nothing for created PRs, nothing trailing.
      expect((res.sessionArtifacts ?? []).map((a) => a.artifactId).sort()).toEqual(['pr:o/r:11', 'pr:o/r:3', 'pr:o/r:7'])
      expect(res.blockArtifacts).toEqual([{ blockIdx: 1, artifactId: 'pr:o/r:7', role: 'contributed', source: 'derived' }])
      expect((res.outcomes ?? []).map((o) => o.artifactId)).toEqual(['pr:o/r:7'])
    })

    it('fills the unmatched thinking blocks between a PR’s matched blocks (contiguity)', async () => {
      const s = session([
        { kind: 'edit', file: '/repo/src/a.ts', newString: A.join('\n') }, // block 0
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/3' }, // closes block 0
        { kind: 'edit', file: '/repo/src/b.ts', newString: B.join('\n') }, // block 1 (PR#7 part 1)
        { kind: 'shell', command: 'git commit -m one' }, // closes block 1
        { kind: 'shell', command: 'npm test' }, // block 2 — no authored match
        { kind: 'shell', command: 'git commit -m two' }, // closes block 2
        { kind: 'edit', file: '/repo/src/b2.ts', newString: D.join('\n') }, // block 3 (PR#7 part 2)
      ])
      const prDiff = diffFor('src/b.ts', B) + '\n' + diffFor('src/b2.ts', D)
      const res = await prContentMatch.run(ctx(s, sh([pr(3), pr(7)], { 3: diffFor('src/a.ts', A), 7: prDiff })))
      // PR#7 matched blocks 1 and 3; the fill claims 1..3 including the unmatched block 2.
      expect((res.blockArtifacts ?? []).map((b) => b.blockIdx).sort()).toEqual([1, 2, 3])
      expect(new Set((res.blockArtifacts ?? []).map((b) => b.artifactId))).toEqual(new Set(['pr:o/r:7']))
    })

    it('an isolated late false-positive match cannot drag the segment rightward', async () => {
      // PR#7's real work is block 1. Block 4 edits a shared file whose one line also
      // appears in PR#7's diff — a classic late false positive. With 5 blocks G=2, the
      // {1,4} gap of 3 is uncorroborated → the anchor falls back to the earliest matched
      // block, so PR#7 claims ONLY block 1 (never 2–4).
      const SH = ['export const SHARED_TOKEN = 9']
      const s = session([
        { kind: 'edit', file: '/repo/src/a.ts', newString: A.join('\n') }, // block 0
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/3' }, // closes block 0
        { kind: 'edit', file: '/repo/src/b.ts', newString: B.join('\n') }, // block 1 (PR#7's work)
        { kind: 'shell', command: 'git commit -m one' }, // closes block 1
        { kind: 'shell', command: 'npm test' }, // block 2
        { kind: 'shell', command: 'git commit -m two' }, // closes block 2
        { kind: 'shell', command: 'npm run lint' }, // block 3
        { kind: 'shell', command: 'git commit -m three' }, // closes block 3
        { kind: 'edit', file: '/repo/src/shared.ts', newString: SH.join('\n') }, // block 4 — the FP
      ])
      const prDiff = diffFor('src/b.ts', B) + '\n' + diffFor('src/shared.ts', SH)
      const res = await prContentMatch.run(ctx(s, sh([pr(3), pr(7)], { 3: diffFor('src/a.ts', A), 7: prDiff })))
      expect(res.blockArtifacts).toEqual([{ blockIdx: 1, artifactId: 'pr:o/r:7', role: 'contributed', source: 'derived' }])
    })

    it('an explicit anchor wins a contested block; the loser gets no block rows (zero cost claim)', async () => {
      // The inferred PR's ONLY matched block is the one that also holds the create call
      // for PR#3 → explicit keeps the anchor, PR#7 gets no block rows. That is a ZERO
      // cost claim by design (the store gates the whole-session fallback off for
      // content-match links — see saNoContentMatchFallback); the block stays wholly
      // PR#3's, and PR#7's attribution % on the session link still stands.
      const s = session([
        { kind: 'edit', file: '/repo/src/a.ts', newString: A.join('\n') },
        { kind: 'edit', file: '/repo/src/b.ts', newString: B.join('\n') },
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/3' },
      ])
      const res = await prContentMatch.run(ctx(s, sh([pr(3), pr(7)], { 3: diffFor('src/a.ts', A), 7: diffFor('src/b.ts', B) })))
      expect(res.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:7', confidence: 1 }))
      expect(res.blockArtifacts ?? []).toEqual([])
    })

    it('per-line attribution: a later non-matching edit to a matched file is not a matched block', async () => {
      // Block 3 re-edits src/b.ts but with content that appears NOWHERE in PR#7's diff.
      // Under file-granular matching that block would count as "matched" (gap 2 = G →
      // corroborated!) and drag the segment to 1–3; per-line attribution keeps it out.
      const Z = ['const zeta = 99', 'function unrelated() {', '  return zeta - 1']
      const s = session([
        { kind: 'edit', file: '/repo/src/a.ts', newString: A.join('\n') }, // block 0
        { kind: 'shell', command: 'gh pr create --fill', raw: 'https://github.com/o/r/pull/3' }, // closes block 0
        { kind: 'edit', file: '/repo/src/b.ts', newString: B.join('\n') }, // block 1 (PR#7's real work)
        { kind: 'shell', command: 'git commit -m one' }, // closes block 1
        { kind: 'shell', command: 'npm test' }, // block 2
        { kind: 'shell', command: 'git commit -m two' }, // closes block 2
        { kind: 'edit', file: '/repo/src/b.ts', newString: Z.join('\n') }, // block 3 — same FILE, no matching lines
      ])
      const res = await prContentMatch.run(ctx(s, sh([pr(3), pr(7)], { 3: diffFor('src/a.ts', A), 7: diffFor('src/b.ts', B) })))
      expect(res.blockArtifacts).toEqual([{ blockIdx: 1, artifactId: 'pr:o/r:7', role: 'contributed', source: 'derived' }])
    })
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
    // gh failed → the run THROWS (so the runner keeps prior results instead of
    // persisting an empty result that would wipe previously discovered links).
    await expect(prContentMatch.run(ctx(s(), flaky))).rejects.toThrow(/gh unavailable/)
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
    expect(files[0]!.removed).toEqual([])
  })

  it('scopes removed lines per file — a deleted file (+++ /dev/null) never leaks into the previous one', () => {
    const d = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,1 @@', '-old a', '+new a',
      'diff --git a/src/gone.ts b/src/gone.ts', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-deleted line',
    ].join('\n')
    const files = parseDiff(d)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({ path: 'src/a.ts', added: ['new a'], removed: ['old a'], oldBlob: null })
  })
})
