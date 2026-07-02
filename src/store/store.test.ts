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
    expect(cost['pr:o/r:11']).toBe(1) // block 0 only — its block-1 row is superseded
    expect(cost['pr:o/r:7']).toBe(2) // reclaimed block 1

    // Rejecting the derived link deletes pr-content-match's block rows → the
    // suppression lifts and outcomes-git's proximity fill counts again (graceful revert).
    store.rejectSessionLink('s1', 'pr:o/r:7')
    const after = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    expect(after['pr:o/r:11']).toBe(3) // blocks 0+1 back
    expect(after['pr:o/r:7']).toBeUndefined() // link gone entirely
  })

  it('a content-match link with no block rows claims zero cost (whole-session fallback gated off)', () => {
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
    // …and PR#7 claims NOTHING — without the gate, the whole-session fallback would
    // charge it the full $3 (all of PR#3's work). Attribution % still lives on the link.
    expect(cost['pr:o/r:7']).toBe(0)

    // The fallback still works for its real audience: a user-linked PR with no block rows.
    seedSession(store, db, 's2')
    db.prepare('INSERT INTO usage_facts (session_id, idx, cost_usd) VALUES (?,?,?)').run('s2', 0, 5)
    const prC: ArtifactInput = { ...richPr, id: 'pr:o/r:9', ident: '9', externalId: 'https://github.com/o/r/pull/9' }
    store.persistResult('s2', 'outcomes-git', 3, 'h2', null, { artifacts: [prC] })
    db.prepare("INSERT INTO session_artifacts (session_id, artifact_id, role, source, confidence, producer) VALUES ('s2','pr:o/r:9','edited','user',1,'dashboard')").run()
    const cost2 = Object.fromEntries(store.artifactList('pr').map((r) => [r.id, r.costUsd]))
    expect(cost2['pr:o/r:9']).toBe(5) // whole-session fallback intact for user links
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
