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

  it('deleting a session cascades its friction events', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(store, db, 's1')
    store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', { frictionTopics: [topic], frictionEvents: [ev(0, topic.id)] })
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events').get()).toMatchObject({ c: 0 })
  })
})
