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
      blockArtifacts: [{ blockIdx: 0, artifactId: 'pr:o/r:5', role: 'edited', source: 'derived', confidence: 0.85 }],
      outcomes: [{ type: 'pr_contributed', artifactId: 'pr:o/r:5', ts: '2026-06-30T00:00:00Z' }],
    })

    const sa = db.prepare('SELECT role, source, confidence, producer FROM session_artifacts WHERE session_id=? AND artifact_id=?').get('s1', 'pr:o/r:5') as Record<string, unknown>
    expect(sa).toMatchObject({ role: 'edited', source: 'derived', confidence: 0.85, producer: 'pr-content-match' })
    expect(db.prepare('SELECT json FROM artifacts WHERE id=?').get('pr:o/r:5')).toMatchObject({ json: '{"addedLines":7}' })
    expect(db.prepare("SELECT COUNT(*) c FROM block_artifacts WHERE artifact_id='pr:o/r:5' AND role='edited'").get()).toMatchObject({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM outcomes WHERE type='pr_contributed'").get()).toMatchObject({ c: 1 })
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
