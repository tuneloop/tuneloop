import { describe, expect, it } from 'vitest'
import { emptyUsage } from '../core/model'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { reconcileFeatures } from './feature-reconcile'
import type { LlmClient, LlmResult, StructuredRequest } from '../llm/types'

type Db = ReturnType<typeof openDb>
const log = { debug() {}, info() {}, warn() {}, error() {} }

/** A stub LLM that returns one canned reconcile result, counts calls, and records the last prompt. */
function stubLlm(data: Record<string, unknown>): LlmClient & { calls: () => number; lastUser: () => string } {
  let n = 0
  let lastUser = ''
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    calls: () => n,
    lastUser: () => lastUser,
    async completeStructured(req: StructuredRequest): Promise<LlmResult> {
      n++
      lastUser = req.user ?? ''
      return { data, usage: emptyUsage() }
    },
  }
}

function feat(db: Db, id: string, o: { repo?: string; title?: string; createdAt?: string; parent?: string | null } = {}) {
  db.prepare("INSERT INTO artifacts (id, kind, repo, source, title, created_at, parent_artifact_id, producer) VALUES (?, 'feature', ?, 'derived', ?, ?, ?, 'enrich-session')").run(
    id,
    o.repo ?? 'o/r',
    o.title ?? id,
    o.createdAt ?? null,
    o.parent ?? null,
  )
}
function sLink(db: Db, sid: string, aid: string) {
  db.prepare('INSERT OR IGNORE INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(sid, sid, 'claude-code', 'anthropic')
  db.prepare("INSERT OR IGNORE INTO session_artifacts (session_id, artifact_id, role, source, producer) VALUES (?,?, 'contributed', 'derived', 'enrich-session')").run(sid, aid)
}
function ann(db: Db, sid: string, key: string, value: unknown) {
  db.prepare('INSERT OR REPLACE INTO annotations (session_id, processor, key, value) VALUES (?,?,?,?)').run(sid, 'enrich-session', key, JSON.stringify(value))
}
const featureIds = (db: Db) => (db.prepare("SELECT id FROM artifacts WHERE kind='feature' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)
const parentOf = (db: Db, id: string) => (db.prepare('SELECT parent_artifact_id AS p FROM artifacts WHERE id = ?').get(id) as { p: string | null } | undefined)?.p ?? null

describe('reconcileFeatures', () => {
  it('fuses a synonym group into the earliest-minted canonical and repoints its links', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    feat(db, 'f-a', { title: 'Cost-per-PR', createdAt: '2026-02-01T00:00:00Z' })
    feat(db, 'f-b', { title: 'Cost per PR metric', createdAt: '2026-01-01T00:00:00Z' }) // earlier → canonical
    feat(db, 'f-c', { title: 'Dashboard KPIs', createdAt: '2026-01-15T00:00:00Z' })
    sLink(db, 's1', 'f-a')
    sLink(db, 's2', 'f-b')
    // Reference by the numbers derivedFeaturesForReconcile actually assigns (order-robust).
    const feats = store.derivedFeaturesForReconcile()
    const numOf = (id: string) => feats.findIndex((f) => f.id === id) + 1
    const llm = stubLlm({ groups: [{ members: [numOf('f-a'), numOf('f-b')] }], hierarchy: [] })

    const { applied } = await reconcileFeatures(store, llm, log)
    expect(applied).toBe(1)
    expect(featureIds(db)).toEqual(['f-b', 'f-c']) // f-a folded into the earlier f-b
    const sessions = (db.prepare('SELECT session_id AS s FROM session_artifacts WHERE artifact_id = ?').all('f-b') as Array<{ s: string }>).map((r) => r.s).sort()
    expect(sessions).toEqual(['s1', 's2']) // f-a's session link moved onto the survivor
  })

  it('assigns parent/child hierarchy among survivors', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    feat(db, 'analytics', { title: 'Analytics', createdAt: '2026-01-01T00:00:00Z' })
    feat(db, 'cost', { title: 'Cost metric', createdAt: '2026-01-02T00:00:00Z' })
    const feats = store.derivedFeaturesForReconcile()
    const numOf = (id: string) => feats.findIndex((f) => f.id === id) + 1
    const llm = stubLlm({ groups: [], hierarchy: [{ feature: numOf('cost'), parent: numOf('analytics') }] })

    const { applied } = await reconcileFeatures(store, llm, log)
    expect(applied).toBe(1)
    expect(parentOf(db, 'cost')).toBe('analytics')
  })

  it('does not group features across different repos', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    feat(db, 'a', { title: 'Auth', repo: 'o/x', createdAt: '2026-01-01T00:00:00Z' })
    feat(db, 'b', { title: 'Auth', repo: 'o/y', createdAt: '2026-01-02T00:00:00Z' })
    const feats = store.derivedFeaturesForReconcile()
    const numOf = (id: string) => feats.findIndex((f) => f.id === id) + 1
    const llm = stubLlm({ groups: [{ members: [numOf('a'), numOf('b')] }], hierarchy: [] })

    const { applied } = await reconcileFeatures(store, llm, log)
    expect(applied).toBe(0) // cross-repo merge refused
    expect(featureIds(db)).toEqual(['a', 'b'])
  })

  it("feeds each feature its linked sessions' intent gloss into the reconcile prompt", async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    feat(db, 'f-a', { title: 'Auth', createdAt: '2026-01-01T00:00:00Z' })
    feat(db, 'f-b', { title: 'Login', createdAt: '2026-01-02T00:00:00Z' })
    sLink(db, 's1', 'f-a')
    sLink(db, 's2', 'f-b')
    ann(db, 's1', 'intent_summary', 'add OAuth sign-in to the app')
    ann(db, 's2', 'intent_summary', 'fix the login token refresh')
    const llm = stubLlm({ groups: [], hierarchy: [] })

    await reconcileFeatures(store, llm, log)
    const user = llm.lastUser()
    expect(user).toContain('e.g. add OAuth sign-in to the app')
    expect(user).toContain('e.g. fix the login token refresh')
  })

  it('skips the LLM call when the feature set is unchanged since the last pass', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    feat(db, 'f-a', { title: 'A', createdAt: '2026-01-01T00:00:00Z' })
    feat(db, 'f-b', { title: 'B', createdAt: '2026-01-02T00:00:00Z' })
    const llm = stubLlm({ groups: [], hierarchy: [] })
    await reconcileFeatures(store, llm, log) // stamps the hash
    await reconcileFeatures(store, llm, log) // unchanged → early return
    expect(llm.calls()).toBe(1)
  })
})
