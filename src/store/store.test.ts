import { describe, expect, it } from 'vitest'
import { emptyUsage, type Session } from '../core/model'
import { openDb } from './db'
import { Store } from './store'
import type { ArtifactInput } from './types'

function seedSession(store: Store, db: ReturnType<typeof openDb>, id: string) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, 'claude-code', 'anthropic')
}

const richPr: ArtifactInput = {
  id: 'pr:o/r:5',
  kind: 'pr',
  repo: 'o/r',
  ident: '5',
  externalId: 'https://github.com/o/r/pull/5',
  source: 'github',
  title: 'A nicely enriched PR',
  owner: 'alice',
  status: 'merged',
  completedAt: '2026-01-01T00:00:00Z',
  complexity: 120,
  complexityBasis: 'diff_size',
}

const stubPr: ArtifactInput = {
  id: 'pr:o/r:5',
  kind: 'pr',
  repo: 'o/r',
  ident: '5',
  externalId: 'https://github.com/o/r/pull/5',
  source: 'github',
  status: 'open', // an offline reviewer only knows it's a PR, optimistically "open"
}

describe('Codex semantic child persistence and display', () => {
  it('preserves literal event names for direct non-envelope tool calls', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const session = codexSemanticSession('unused')
    session.id = 'claude-code:direct'
    session.sessionId = 'direct'
    session.source = 'claude-code'
    session.provider = 'anthropic'
    session.events[0] = {
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id: 'direct-tool', name: 'Skill', input: { skill: 'review' } }],
      usage: emptyUsage(),
      isSidechain: false,
      seq: 0,
    }
    session.toolCalls[0] = {
      id: 'direct-tool',
      name: 'review',
      action: 'skill',
      input: { skill: 'review' },
      target: {},
      result: { ok: true, isError: false },
      isSidechain: false,
    }
    store.ingestSession(session, 0, [], 'test', 8005)

    expect(store.sessionDetail(session.id)?.transcript.turns[0]?.tools[0]).toMatchObject({
      name: 'Skill',
      action: '',
      command: 'review',
    })
  })

  it('renders the semantic child of an exec envelope, not the raw JS wrapper', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const session = codexSemanticSession('const r = await tools.exec_command({cmd:"gh pr create --fill"}); text(r.output);')
    store.ingestSession(session, 0, [], 'test', 3005)

    const transcript = store.sessionDetail(session.id)?.transcript
    expect(transcript?.turns).toHaveLength(1)
    expect(transcript?.turns[0]?.tools).toHaveLength(1)
    const tool = transcript?.turns[0]?.tools[0] as Record<string, unknown> | undefined
    expect(tool).toMatchObject({ name: 'exec_command', command: 'gh pr create --fill' })
    // The raw exec JavaScript is intentionally not surfaced — the child row is the view.
    expect(tool).not.toHaveProperty('rawWrapper')
  })

  it('renders a multi-file apply_patch as separate named transcript diffs', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/src/store/store.test.ts',
      '@@',
      '-const before = true',
      '+const after = true',
      '*** Update File: /repo/src/adapters/codex/parse.ts',
      '@@',
      '-const mapped = mapAction(name, input)',
      '+const mapped = operation.resolved ? mapAction(name, input) : fallback',
      '*** Add File: /repo/src/adapters/codex/exec-envelope.test.ts',
      '+import { describe, it } from \'vitest\'',
      '+describe(\'exec envelope\', () => { it(\'parses\', () => {}) })',
      '*** End Patch',
    ].join('\n')
    const envelope = `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`
    const session = codexSemanticSession(envelope)
    session.toolCalls[0] = {
      id: 'outer:0',
      parentId: 'outer',
      name: 'apply_patch',
      action: 'file_write',
      input: patch,
      target: {
        paths: [
          '/repo/src/store/store.test.ts',
          '/repo/src/adapters/codex/parse.ts',
          '/repo/src/adapters/codex/exec-envelope.test.ts',
        ],
      },
      result: { ok: true, isError: false, raw: '[{"type":"input_text","text":"{}"}]' },
      isSidechain: false,
    }
    store.ingestSession(session, 0, [], 'test', 3005)

    expect(store.sessionDetail(session.id)?.transcript.turns[0]?.tools[0]).toMatchObject({
      name: 'apply_patch',
      command: '3 files changed',
      fileDiffs: [
        {
          path: '/repo/src/store/store.test.ts',
          hunks: [{ del: 'const before = true', ins: 'const after = true' }],
        },
        {
          path: '/repo/src/adapters/codex/parse.ts',
          hunks: [
            {
              del: 'const mapped = mapAction(name, input)',
              ins: 'const mapped = operation.resolved ? mapAction(name, input) : fallback',
            },
          ],
        },
        {
          path: '/repo/src/adapters/codex/exec-envelope.test.ts',
          hunks: [
            {
              del: '',
              ins: "import { describe, it } from 'vitest'\ndescribe('exec envelope', () => { it('parses', () => {}) })",
            },
          ],
        },
      ],
    })
  })

  it('renders a file diff for a shell `apply_patch` heredoc from tc.input, not the raw {cmd} block', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/calculator/operations/floor_divide.py',
      '+def floor_divide(a, b):',
      '+    return a // b',
      '*** End Patch',
    ].join('\n')
    // The transcript block keeps the literal shell command ({cmd} object); the tool call
    // carries the extracted patch string. The diff must come from tc.input.
    const session = codexSemanticSession('unused')
    session.id = 'codex:heredoc'
    session.events[0] = {
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id: 'heredoc-tool', name: 'exec_command', input: { cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH` } }],
      usage: emptyUsage(),
      isSidechain: false,
      seq: 0,
    }
    session.toolCalls = [
      {
        id: 'heredoc-tool',
        name: 'exec_command',
        action: 'file_write',
        input: patch,
        target: { paths: ['src/calculator/operations/floor_divide.py'] },
        result: { ok: true, isError: false, raw: 'Success. Updated the following files:\nA src/calculator/operations/floor_divide.py' },
        isSidechain: false,
      },
    ]
    store.ingestSession(session, 0, [], 'test', 4005)

    expect(store.sessionDetail(session.id)?.transcript.turns[0]?.tools[0]).toMatchObject({
      name: 'exec_command',
      command: 'src/calculator/operations/floor_divide.py',
      fileDiffs: [
        {
          path: 'src/calculator/operations/floor_divide.py',
          hunks: [{ del: '', ins: 'def floor_divide(a, b):\n    return a // b' }],
        },
      ],
    })
  })

  it('invalidates processor runs when normalized parsing changes over unchanged bytes', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const session = codexSemanticSession('wrapper')
    store.ingestSession(session, 0, [], 'test', 2005)
    store.persistResult(session.id, 'files-touched', 1, session.raw.contentHash, null, {})
    expect(store.processorRun(session.id, 'files-touched')?.invalidated).toBe(false)

    store.ingestSession(session, 0, [], 'test', 3005)
    expect(store.processorRun(session.id, 'files-touched')?.invalidated).toBe(true)
  })
})

function codexSemanticSession(envelope: string): Session {
  const parentId = 'outer'
  return {
    id: 'codex:semantic',
    sessionId: 'semantic',
    source: 'codex',
    provider: 'openai',
    project: { cwd: '/repo', repo: 'o/r' },
    models: [],
    tokens: emptyUsage(),
    events: [
      {
        kind: 'assistant',
        blocks: [{ type: 'tool_use', id: parentId, name: 'exec', input: envelope }],
        usage: emptyUsage(),
        isSidechain: false,
        seq: 0,
      },
    ],
    toolCalls: [
      {
        id: `${parentId}:0`,
        parentId,
        name: 'exec_command',
        action: 'shell',
        input: { cmd: 'gh pr create --fill' },
        target: { command: 'gh pr create --fill' },
        result: { ok: true, isError: false, raw: 'https://github.com/o/r/pull/1' },
        isSidechain: false,
      },
    ],
    raw: { path: '/tmp/rollout.jsonl', contentHash: 'same-bytes' },
  } as Session
}

describe('artifact upsert (PR clobber safety)', () => {
  it('a later stub write does not blank out a richer PR row', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    seedSession(store, db, 's2')

    // s1 (creator) writes the enriched PR.
    store.persistResult('s1', 'outcomes-git', 3, 'h1', null, { artifacts: [richPr] })
    // s2 (reviewer, offline) writes a stub for the SAME PR.
    store.persistResult('s2', 'enrich-session', 13, 'h2', 'model-x', { artifacts: [stubPr] })

    const row = db
      .prepare('SELECT title, owner, status, completed_at, complexity FROM artifacts WHERE id = ?')
      .get('pr:o/r:5') as Record<string, unknown>

    expect(row.title).toBe('A nicely enriched PR') // not blanked
    expect(row.owner).toBe('alice')
    expect(row.status).toBe('merged') // stub 'open' did NOT overwrite a terminal state
    expect(row.completed_at).toBe('2026-01-01T00:00:00Z')
    expect(row.complexity).toBe(120)
  })

  it('persists a content-match link (role=edited, source=derived) + PR json + block link + outcome', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')

    store.persistResult('s1', 'pr-content-match', 1, 'h1', null, {
      artifacts: [{ ...stubPr, json: { addedLines: 7 } }],
      sessionArtifacts: [{ artifactId: 'pr:o/r:5', role: 'edited', source: 'derived', confidence: 0.85 }],
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:5', role: 'contributed', source: 'derived' }],
      outcomes: [{ type: 'pr_contributed', artifactId: 'pr:o/r:5', ts: '2026-06-30T00:00:00Z' }],
    })

    const sa = db.prepare('SELECT role, source, confidence, producer FROM session_artifacts WHERE session_id=? AND artifact_id=?').get('s1', 'pr:o/r:5') as Record<string, unknown>
    expect(sa).toMatchObject({ role: 'edited', source: 'derived', confidence: 0.85, producer: 'pr-content-match' })
    expect(db.prepare('SELECT json FROM artifacts WHERE id=?').get('pr:o/r:5')).toMatchObject({ json: '{"addedLines":7}' })
    expect(db.prepare("SELECT COUNT(*) c FROM block_artifacts WHERE artifact_id='pr:o/r:5' AND role='contributed'").get()).toMatchObject({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM outcomes WHERE type='pr_contributed'").get()).toMatchObject({ c: 1 })

    // A DIFFERENT producer also links this PR with its own (higher) confidence — a review
    // link at confidence 1. AI-attribution must stay pr-content-match's 0.85, not the review's 1.
    store.persistResult('s1', 'outcomes-git', 3, 'h2', null, {
      sessionArtifacts: [{ artifactId: 'pr:o/r:5', role: 'reviewed', source: 'explicit', confidence: 1 }],
    })

    // The AI-attribution fraction surfaces to both UI reads: PR table (aiPct) + drawer chip (confidence).
    const prRow = store.artifactList('pr').find((r) => r.id === 'pr:o/r:5')
    expect(prRow?.aiPct).toBeCloseTo(0.85) // not 1 (the review link's confidence)
    const chip = store.sessionDetail('s1')?.artifacts.find((a) => a.id === 'pr:o/r:5') as { confidence?: number } | undefined
    expect(chip?.confidence).toBeCloseTo(0.85)
  })

  it('pr-content-match block rows supersede outcomes-git’s proximity fill for the same block', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    // Two blocks with $1 and $2 of usage.
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s1', 0, 1)
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s1', 1, 2)
    db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx) VALUES (?,?,?)').run('s1', 0, 0)
    db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx) VALUES (?,?,?)').run('s1', 1, 1)

    const prA: ArtifactInput = { ...richPr, id: 'pr:o/r:11', ident: '11', externalId: 'https://github.com/o/r/pull/11' }
    const prB: ArtifactInput = { ...richPr, id: 'pr:o/r:7', ident: '7', externalId: 'https://github.com/o/r/pull/7' }
    // outcomes-git's explicit-only backward-fill absorbed BOTH blocks into created PR#11…
    store.persistResult('s1', 'outcomes-git', 3, 'h1', null, {
      artifacts: [prA],
      sessionArtifacts: [{ artifactId: prA.id, role: 'created', source: 'explicit' }],
      blockArtifacts: [
        { blockIdx: 0, artifactId: prA.id, role: 'contributed', source: 'explicit' },
        { blockIdx: 1, artifactId: prA.id, role: 'contributed', source: 'explicit' },
      ],
    })
    // …but pr-content-match proved block 1 was human-pushed PR#7's work.
    store.persistResult('s1', 'pr-content-match', 1, 'h1', null, {
      artifacts: [prB],
      sessionArtifacts: [{ artifactId: prB.id, role: 'edited', source: 'derived', confidence: 1 }],
      blockArtifacts: [{ blockIdx: 1, artifactId: prB.id, role: 'contributed', source: 'derived' }],
    })

    const rows = store.artifactList('pr')
    const cost = Object.fromEntries(rows.map((r) => [r.id, r.costUsd]))
    expect(cost['pr:o/r:11']).toBe(1) // block 0 only — block 1's outcomes-git row was displaced at write time
    expect(cost['pr:o/r:7']).toBe(2) // reclaimed block 1
    // The table is 1-1: block 1 has exactly the content-match row, not both.
    const blockRows = db
      .prepare(`SELECT producer FROM block_artifacts WHERE session_id = 's1' AND block_idx = 1 AND role = 'contributed'`)
      .all() as Array<{ producer: string }>
    expect(blockRows.map((r) => r.producer)).toEqual(['pr-content-match'])

    // Rejecting the derived link deletes pr-content-match's block rows. Because the
    // displaced outcomes-git row was removed at WRITE time, block 1 is momentarily
    // orphaned — its cost is unattributed until the next analyze regenerates the
    // deterministic fill (reject flags the session's processors invalidated for exactly
    // that). Reject no longer reverts synchronously — the accepted trade for a 1-1 table.
    store.rejectSessionLink('s1', 'pr:o/r:7')
    const afterReject = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    expect(afterReject['pr:o/r:11']).toBe(1) // block 1 orphaned, not yet back
    expect(afterReject['pr:o/r:7']).toBeUndefined() // link gone entirely

    // Next analyze: outcomes-git re-derives its fill; the link is tombstoned so
    // content-match no longer contests block 1, which reverts to PR#11.
    store.persistResult('s1', 'outcomes-git', 3, 'h1', null, {
      artifacts: [prA],
      sessionArtifacts: [{ artifactId: prA.id, role: 'created', source: 'explicit' }],
      blockArtifacts: [
        { blockIdx: 0, artifactId: prA.id, role: 'contributed', source: 'explicit' },
        { blockIdx: 1, artifactId: prA.id, role: 'contributed', source: 'explicit' },
      ],
    })
    const afterReanalyze = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    expect(afterReanalyze['pr:o/r:11']).toBe(3) // blocks 0+1 back
  })

  it('cost is block-grain only: any link with no block rows claims zero (no whole-session fallback)', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s1', 0, 1)
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s1', 1, 2)
    db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx) VALUES (?,?,?)').run('s1', 0, 0)
    db.prepare('INSERT INTO block_usage (session_id, usage_idx, block_idx) VALUES (?,?,?)').run('s1', 1, 1)

    const prA: ArtifactInput = { ...richPr, id: 'pr:o/r:3', ident: '3', externalId: 'https://github.com/o/r/pull/3' }
    const prB: ArtifactInput = { ...richPr, id: 'pr:o/r:7', ident: '7', externalId: 'https://github.com/o/r/pull/7' }
    // outcomes-git: created PR#3, fill claims blocks 0+1.
    store.persistResult('s1', 'outcomes-git', 3, 'h1', null, {
      artifacts: [prA],
      sessionArtifacts: [{ artifactId: prA.id, role: 'created', source: 'explicit' }],
      blockArtifacts: [
        { blockIdx: 0, artifactId: prA.id, role: 'contributed', source: 'explicit' },
        { blockIdx: 1, artifactId: prA.id, role: 'contributed', source: 'explicit' },
      ],
    })
    // pr-content-match: PR#7's only matched block was contested away by an explicit
    // anchor → session-level attribution link, NO block rows.
    store.persistResult('s1', 'pr-content-match', 2, 'h1', null, {
      artifacts: [prB],
      sessionArtifacts: [{ artifactId: prB.id, role: 'edited', source: 'derived', confidence: 1 }],
    })

    const cost = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    // PR#3 keeps its blocks untouched…
    expect(cost['pr:o/r:3']).toBe(3)
    // …and PR#7 claims NOTHING — no block rows means no cost, since there is no
    // whole-session fallback anymore. Attribution % still lives on the link.
    expect(cost['pr:o/r:7']).toBe(0)

    // Same rule for a user-linked PR with no block rows: zero for now, reconciled to
    // block-grain cost on the next analyze (manual links don't carry block rows yet).
    seedSession(store, db, 's2')
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s2', 0, 5)
    const prC: ArtifactInput = { ...richPr, id: 'pr:o/r:9', ident: '9', externalId: 'https://github.com/o/r/pull/9' }
    store.persistResult('s2', 'outcomes-git', 3, 'h2', null, { artifacts: [prC] })
    db.prepare("INSERT INTO session_artifacts (session_id, artifact_id, role, source, confidence, producer) VALUES ('s2','pr:o/r:9','edited','user',1,'dashboard')").run()
    const cost2 = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    expect(cost2['pr:o/r:9']).toBe(0) // no block rows → zero (no whole-session fallback)
  })

  it('a genuine status transition (open -> merged) still applies', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')

    // First write: an open PR with known churn.
    store.persistResult('s1', 'outcomes-git', 3, 'h1', null, { artifacts: [{ ...richPr, status: 'open', completedAt: undefined }] })
    // Second write: now merged, but this enrichment didn't carry churn (undefined).
    store.persistResult('s1', 'outcomes-git', 3, 'h2', null, { artifacts: [{ ...richPr, complexity: undefined }] })

    const row = db.prepare('SELECT status, title, complexity FROM artifacts WHERE id = ?').get('pr:o/r:5') as Record<string, unknown>
    expect(row.status).toBe('merged') // real new value overwrites the old 'open'
    expect(row.title).toBe('A nicely enriched PR')
    expect(row.complexity).toBe(120) // the earlier non-null churn is preserved, not blanked
  })
})

describe('cross-role block reconciliation (1-1 per block)', () => {
  // One PR-kind row per block, by precedence pcm > og-reviewed > enrich-reviewed > og-contributed.
  const prRows = (db: ReturnType<typeof openDb>) =>
    db
      .prepare(
        `SELECT block_idx AS blockIdx, producer, role, artifact_id AS artifactId
         FROM block_artifacts WHERE session_id = 's1' ORDER BY block_idx, producer`,
      )
      .all()

  it('enrich review displaces an outcomes-git contribution on the same block', () => {
    const db = openDb(':memory:'); const store = new Store(db); seedSession(store, db, 's1')
    store.persistResult('s1', 'outcomes-git', 5, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:11', role: 'contributed', source: 'explicit' }],
    })
    store.persistResult('s1', 'enrich-session', 17, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:7', role: 'reviewed', source: 'derived', confidence: 0.6 }],
    })
    expect(prRows(db)).toEqual([{ blockIdx: 0, producer: 'enrich-session', role: 'reviewed', artifactId: 'pr:o/r:7' }])
  })

  it('an explicit outcomes-git review holds the block against a derived enrich review', () => {
    const db = openDb(':memory:'); const store = new Store(db); seedSession(store, db, 's1')
    store.persistResult('s1', 'outcomes-git', 5, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:11', role: 'reviewed', source: 'explicit', confidence: 1 }],
    })
    store.persistResult('s1', 'enrich-session', 17, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:7', role: 'reviewed', source: 'derived', confidence: 0.6 }],
    })
    expect(prRows(db)).toEqual([{ blockIdx: 0, producer: 'outcomes-git', role: 'reviewed', artifactId: 'pr:o/r:11' }])
  })

  it('pr-content-match displaces both outcomes-git (any role) and enrich review rows', () => {
    const db = openDb(':memory:'); const store = new Store(db); seedSession(store, db, 's1')
    store.persistResult('s1', 'outcomes-git', 5, 'h1', null, {
      blockArtifacts: [
        { blockIdx: 0, artifactId: 'pr:o/r:11', role: 'reviewed', source: 'explicit', confidence: 1 },
        { blockIdx: 1, artifactId: 'pr:o/r:12', role: 'contributed', source: 'explicit' },
      ],
    })
    store.persistResult('s1', 'enrich-session', 17, 'h1', null, {
      blockArtifacts: [{ blockIdx: 1, artifactId: 'pr:o/r:7', role: 'reviewed', source: 'derived', confidence: 0.6 }],
    })
    store.persistResult('s1', 'pr-content-match', 5, 'h1', null, {
      blockArtifacts: [
        { blockIdx: 0, artifactId: 'pr:o/r:99', role: 'contributed', source: 'derived' },
        { blockIdx: 1, artifactId: 'pr:o/r:99', role: 'contributed', source: 'derived' },
      ],
    })
    expect(prRows(db)).toEqual([
      { blockIdx: 0, producer: 'pr-content-match', role: 'contributed', artifactId: 'pr:o/r:99' },
      { blockIdx: 1, producer: 'pr-content-match', role: 'contributed', artifactId: 'pr:o/r:99' },
    ])
  })

  it('a feature-contributed row coexists with a PR row on the same block (different kind)', () => {
    const db = openDb(':memory:'); const store = new Store(db); seedSession(store, db, 's1')
    store.persistResult('s1', 'outcomes-git', 5, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:11', role: 'contributed', source: 'explicit' }],
    })
    store.persistResult('s1', 'enrich-session', 17, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'feature:x', role: 'contributed', source: 'derived', confidence: 0.5 }],
    })
    expect(prRows(db)).toEqual([
      { blockIdx: 0, producer: 'enrich-session', role: 'contributed', artifactId: 'feature:x' },
      { blockIdx: 0, producer: 'outcomes-git', role: 'contributed', artifactId: 'pr:o/r:11' },
    ])
  })

  it('is order-independent: a lower-ranked producer that persists LATER cannot displace the winner', () => {
    const db = openDb(':memory:'); const store = new Store(db); seedSession(store, db, 's1')
    // pcm persists FIRST, og-contributed SECOND — og(1) must not clobber pcm(4).
    store.persistResult('s1', 'pr-content-match', 5, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:99', role: 'contributed', source: 'derived' }],
    })
    store.persistResult('s1', 'outcomes-git', 5, 'h1', null, {
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:11', role: 'contributed', source: 'explicit' }],
    })
    expect(prRows(db)).toEqual([{ blockIdx: 0, producer: 'pr-content-match', role: 'contributed', artifactId: 'pr:o/r:99' }])
  })
})

describe('recordAnalyzedRoots (ingest provenance)', () => {
  it('upserts scanned roots; a root a scoped re-run skips keeps its prior stamp', () => {
    const db = openDb(':memory:')
    const store = new Store(db)

    // First run scans both harnesses' roots.
    store.recordAnalyzedRoots(
      [{ source: 'claude-code', path: '/home/u/.claude/projects' }, { source: 'codex', path: '/home/u/.codex/sessions' }],
      '2026-01-01T00:00:00Z',
    )
    // A scoped re-run (`--source claude`) touches only the claude-code root.
    store.recordAnalyzedRoots([{ source: 'claude-code', path: '/home/u/.claude/projects' }], '2026-02-01T00:00:00Z')

    const rows = db.prepare('SELECT source, path, last_analyzed_at FROM analyzed_roots ORDER BY path').all()
    expect(rows).toEqual([
      { source: 'claude-code', path: '/home/u/.claude/projects', last_analyzed_at: '2026-02-01T00:00:00Z' }, // re-stamped
      { source: 'codex', path: '/home/u/.codex/sessions', last_analyzed_at: '2026-01-01T00:00:00Z' }, // untouched, prior stamp
    ])
  })
})

describe('summary.enrichmentRan', () => {
  it('is true only once an LLM-backed processor run is recorded', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')

    // Sessions analyzed but nothing enriched yet → false.
    expect(store.summary().enrichmentRan).toBe(false)

    // A non-LLM processor run (model = null) is not enrichment.
    store.persistResult('s1', 'outcomes-git', 1, 'h1', null, {})
    expect(store.summary().enrichmentRan).toBe(false)

    // An LLM-backed run records its model — the durable "enrichment ran" signal,
    // independent of which annotation dimensions the enricher happens to emit.
    store.persistResult('s1', 'enrich-session', 1, 'h1', 'some-llm', {})
    expect(store.summary().enrichmentRan).toBe(true)
  })

  it('is true when only an LLM detector ran (model recorded), no LLM processor', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    expect(store.summary().enrichmentRan).toBe(false)
    // An LLM detector records its model; an S-tier detector would leave it null.
    store.persistInsights('recurring-themes', 1, [], { inTokens: 100, outTokens: 20, usd: 0.5, model: 'some-llm' })
    expect(store.summary().enrichmentRan).toBe(true)
  })
})

describe('summary.analysisCostUsd', () => {
  it('sums BOTH processor enrichment and detector LLM cost', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    // A processor enrichment run (cost via selfCost) + a detector run, each with cost.
    store.persistResult('s1', 'enrich-session', 1, 'h1', 'some-llm', {
      selfCost: { tokens: { input: 50, output: 10, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 0.30 },
    })
    store.persistInsights('recurring-themes', 1, [], { inTokens: 100, outTokens: 20, usd: 1.20, model: 'some-llm' })
    expect(store.summary().analysisCostUsd).toBeCloseTo(1.50, 5)
  })
})

describe('pruneOrphanedBranchSessions', () => {
  it('deletes stored sessions with matching prefix that are not in the current emit set', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    // Simulate Run 1: file emitted primary + branch ~e4
    seedSession(store, db, 'pi:abc')
    seedSession(store, db, 'pi:abc~e4')
    seedSession(store, db, 'pi:abc~e6')

    // Run 2: file now emits primary + ~e4 only (e6 is no longer a leaf)
    const currentIds = new Set(['pi:abc', 'pi:abc~e4'])
    const pruned = store.pruneOrphanedBranchSessions('pi:abc', currentIds)

    expect(pruned).toBe(1)
    const remaining = db.prepare("SELECT id FROM sessions WHERE id LIKE 'pi:abc%'").all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id).sort()).toEqual(['pi:abc', 'pi:abc~e4'])
  })

  it('does nothing when all stored sessions are in the emit set', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 'pi:xyz')
    seedSession(store, db, 'pi:xyz~b2')

    const currentIds = new Set(['pi:xyz', 'pi:xyz~b2'])
    const pruned = store.pruneOrphanedBranchSessions('pi:xyz', currentIds)

    expect(pruned).toBe(0)
  })

  it('does not affect sessions from a different prefix', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 'pi:abc')
    seedSession(store, db, 'pi:abc~e4')
    seedSession(store, db, 'pi:other')
    seedSession(store, db, 'pi:other~x1')

    const currentIds = new Set(['pi:abc'])
    store.pruneOrphanedBranchSessions('pi:abc', currentIds)

    // pi:other sessions untouched
    const others = db.prepare("SELECT id FROM sessions WHERE id LIKE 'pi:other%'").all() as Array<{ id: string }>
    expect(others).toHaveLength(2)
  })

  it('does not delete a session whose id merely starts with the prefix bytes', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 'pi:abc')
    seedSession(store, db, 'pi:abc~e4')
    seedSession(store, db, 'pi:abcd') // unrelated session, prefix collision

    const currentIds = new Set(['pi:abc'])
    const pruned = store.pruneOrphanedBranchSessions('pi:abc', currentIds)

    expect(pruned).toBe(1) // only pi:abc~e4
    const remaining = db.prepare("SELECT id FROM sessions WHERE id LIKE 'pi:abc%'").all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id).sort()).toEqual(['pi:abc', 'pi:abcd'])
  })
})

describe('summary.lastAnalyzedAt', () => {
  it('is null until recorded, then round-trips the stamped timestamp', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    expect(store.summary().lastAnalyzedAt).toBe(null)
    store.setMeta('last_analyze_at', '2026-06-30T12:00:00.000Z')
    expect(store.summary().lastAnalyzedAt).toBe('2026-06-30T12:00:00.000Z')
  })
})

describe('display title fallback (first_prompt)', () => {
  // Seed one session row with explicit title / first_prompt and an optional
  // enrichment `title` annotation, then read it back through BOTH the list and
  // the detail query — they share titleExpr, so this asserts the whole chain.
  function seed(db: ReturnType<typeof openDb>, id: string, cols: { title?: string; first_prompt?: string; enriched?: string }) {
    db.prepare('INSERT INTO sessions (id, session_id, source, provider, title, first_prompt, started_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, id, 'claude-code', 'anthropic', cols.title ?? null, cols.first_prompt ?? null, '2026-06-30T00:00:00Z')
    if (cols.enriched != null) {
      db.prepare("INSERT INTO annotations (session_id, processor, key, value) VALUES (?, 'enrich-session', 'title', ?)")
        .run(id, JSON.stringify(cols.enriched))
    }
  }

  it('falls back to the opening prompt when no native/enriched title, in list AND detail', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seed(db, 's-fallback', { first_prompt: 'Fix the login redirect loop' })

    const listed = store.sessionList({}).find((r) => r.id === 's-fallback')
    expect(listed?.title).toBe('Fix the login redirect loop')
    expect(store.sessionDetail('s-fallback')?.session.title).toBe('Fix the login redirect loop')
  })

  it('prefers enriched title, then native title, over the opening prompt', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seed(db, 's-enriched', { enriched: 'Auth Redirect Fix', title: 'native', first_prompt: 'Fix the login redirect loop' })
    seed(db, 's-native', { title: 'Native Session Title', first_prompt: 'Fix the login redirect loop' })

    const list = store.sessionList({})
    expect(list.find((r) => r.id === 's-enriched')?.title).toBe('Auth Redirect Fix')
    expect(list.find((r) => r.id === 's-native')?.title).toBe('Native Session Title')
  })

  it('still shows (untitled) in the list when there is no prompt at all', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seed(db, 's-empty', {})
    expect(store.sessionList({}).find((r) => r.id === 's-empty')?.title).toBe('(untitled)')
  })
})
