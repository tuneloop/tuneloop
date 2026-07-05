import { describe, expect, it } from 'vitest'
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

describe('friction events + topics persistence', () => {
  const ev = (idx: number, topicId?: string) => ({
    idx,
    turnSeq: idx * 2,
    type: 'context-supply' as const,
    trigger: 'unprompted' as const,
    remedyHint: 'add_doc' as const,
    description: `event ${idx}`,
    topicId,
  })
  const topic = { id: 'friction:derived:o-r:sqlite-db', label: 'Default Sqlite Db Not Known', type: 'context-supply' as const, repo: 'o/r' }

  it('round-trips events + topics; re-persist replaces; orphaned derived topics are pruned', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')

    store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', {
      frictionTopics: [topic],
      frictionEvents: [ev(0, topic.id), ev(1)],
    })
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events').get()).toMatchObject({ c: 2 })
    expect(store.listFrictionTopics('o/r')).toEqual([expect.objectContaining({ id: topic.id, label: topic.label })])
    // repo scoping: another repo does not see it; globals would.
    expect(store.listFrictionTopics('other/repo')).toEqual([])

    // Re-persist with no friction at all: events replaced, orphan topic pruned.
    store.persistResult('s1', 'enrich-friction', 2, 'h2', 'm', {})
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events').get()).toMatchObject({ c: 0 })
    expect(store.listFrictionTopics('o/r')).toEqual([])
  })

  it('re-minting an existing topic id keeps the original row (identity is stable)', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    seedSession(store, db, 's2')

    store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', { frictionTopics: [topic], frictionEvents: [ev(0, topic.id)] })
    store.persistResult('s2', 'enrich-friction', 1, 'h2', 'm', {
      frictionTopics: [{ ...topic, label: 'A Different Label' }],
      frictionEvents: [ev(0, topic.id)],
    })
    expect(store.listFrictionTopics('o/r')).toEqual([expect.objectContaining({ label: 'Default Sqlite Db Not Known' })])
    // Both sessions' events share the topic.
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events WHERE topic_id = ?').get(topic.id)).toMatchObject({ c: 2 })
  })

  it('a repo slice constrains a GLOBAL topic to sliced event counts and drill-down events', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 'sa')
    seedSession(store, db, 'sb')
    db.prepare("UPDATE sessions SET repo = 'a' WHERE id = 'sa'").run()
    db.prepare("UPDATE sessions SET repo = 'b' WHERE id = 'sb'").run()
    const g = { id: 'friction:derived:global:oss-pr', label: 'OSS PR Descriptions', type: 'preference' as const }
    store.persistResult('sa', 'enrich-friction', 1, 'ha', 'm', { frictionTopics: [g], frictionEvents: [ev(0, g.id), ev(1, g.id)] })
    store.persistResult('sb', 'enrich-friction', 1, 'hb', 'm', { frictionTopics: [g], frictionEvents: [ev(0, g.id)] })

    expect(store.frictionOverview(null).topics[0]).toMatchObject({ id: g.id, events: 3 })
    // Sliced to repo a: the row's occurrences must agree with its sliced session stats.
    expect(store.frictionOverview('a').topics[0]).toMatchObject({ id: g.id, events: 2, sessions: 1 })
    expect(store.frictionTopicEvents(g.id)).toHaveLength(3)
    expect(store.frictionTopicEvents(g.id, 'a')).toHaveLength(2)
  })

  it('a time window constrains counts, baseline, and drill-down — but lastSeen stays all-time', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 'old')
    seedSession(store, db, 'new')
    db.prepare("UPDATE sessions SET started_at = '2026-01-10T00:00:00Z' WHERE id = 'old'").run()
    db.prepare("UPDATE sessions SET started_at = '2026-06-10T00:00:00Z' WHERE id = 'new'").run()
    store.persistResult('old', 'enrich-friction', 2, 'h1', 'm', {
      frictionTopics: [topic],
      frictionEvents: [ev(0, topic.id)],
      annotations: [{ key: 'friction_count', value: 1 }],
    })
    store.persistResult('new', 'enrich-friction', 2, 'h2', 'm', {
      frictionTopics: [topic],
      frictionEvents: [ev(0, topic.id), ev(1, topic.id)],
      annotations: [{ key: 'friction_count', value: 2 }],
    })

    const all = store.frictionOverview(null)
    expect(all.topics[0]).toMatchObject({ id: topic.id, events: 3, sessions: 2, lastSeen: '2026-06-10T00:00:00Z' })
    expect(all.baseline.sessions).toBe(2)

    // Window covering only the OLD session: counts shrink, lastSeen still reports
    // the all-time latest occurrence (the resolved-vs-active signal).
    const w = store.frictionOverview(null, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')
    expect(w.topics[0]).toMatchObject({ id: topic.id, events: 1, sessions: 1, lastSeen: '2026-06-10T00:00:00Z' })
    expect(w.baseline.sessions).toBe(1)
    expect(store.frictionTopicEvents(topic.id, null, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toHaveLength(1)

    // A window with no member sessions hides the topic entirely.
    expect(store.frictionOverview(null, '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z').topics).toEqual([])
  })

  it('deleting a session cascades its friction events', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', { frictionTopics: [topic], frictionEvents: [ev(0, topic.id)] })
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events').get()).toMatchObject({ c: 0 })
  })
})
