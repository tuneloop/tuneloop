import { describe, expect, it } from 'vitest'
import { INTRINSIC_FACETS } from '../core/facets'
import { openDb } from './db'
import { Store } from './store'

function make() {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.registerFacets('intrinsic', INTRINSIC_FACETS)
  return { db, store }
}

function seed(db: ReturnType<typeof openDb>, id: string, source = 'claude-code') {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, source, 'anthropic')
}

describe('createUserFacet', () => {
  it('creates a session-grain annotation facet from a display name', () => {
    const { store } = make()
    const res = store.createUserFacet('Agent Name')
    expect(res).not.toHaveProperty('error')
    const facet = store.facet('agent_name')
    expect(facet).toBeDefined()
    expect(facet).toMatchObject({ key: 'agent_name', label: 'Agent Name', type: 'string', source: 'annotation' })
    expect(facet!.multi).toBeFalsy()
    expect(facet!.roles).toEqual(expect.arrayContaining(['chart', 'filter', 'detail']))
  })

  it('rejects keys colliding with an existing facet', () => {
    const { store } = make()
    expect(store.createUserFacet('repo')).toHaveProperty('error')
    expect(store.createUserFacet('Repo')).toHaveProperty('error') // collision is on the normalized key
  })

  it('rejects duplicate user facets', () => {
    const { store } = make()
    expect(store.createUserFacet('agent')).not.toHaveProperty('error')
    expect(store.createUserFacet('agent')).toHaveProperty('error')
  })

  it('rejects names that normalize to nothing', () => {
    const { store } = make()
    expect(store.createUserFacet('!!!')).toHaveProperty('error')
    expect(store.createUserFacet('   ')).toHaveProperty('error')
  })

  it('rejects reserved session-API param names', () => {
    const { store } = make()
    expect(store.createUserFacet('from')).toHaveProperty('error')
    expect(store.createUserFacet('q')).toHaveProperty('error')
  })

  it('adding a second user facet keeps the first (no per-producer sweep)', () => {
    const { store } = make()
    store.createUserFacet('agent')
    store.createUserFacet('team')
    expect(store.facet('agent')).toBeDefined()
    expect(store.facet('team')).toBeDefined()
  })

  it('survives an analyze-time facet re-registration', () => {
    const { store } = make()
    store.createUserFacet('agent')
    store.registerFacets('intrinsic', INTRINSIC_FACETS)
    store.registerFacets('enrich-session', [
      { key: 'use_case', type: 'string', source: 'block', roles: ['chart', 'filter'] },
    ])
    expect(store.facet('agent')).toBeDefined()
  })
})

describe('setUserTag', () => {
  it('tags every session matching the filter, and the facet filters sessions', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2')
    seed(db, 's3', 'codex')
    store.createUserFacet('agent')
    const res = store.setUserTag({ facets: { harness: 'claude-code' } }, 'agent', 'issue_solver')
    expect(res).toEqual({ updated: 2 })
    expect(store.facetDistribution('agent')).toEqual([{ value: 'issue_solver', count: 2 }])
    expect(store.sessionCount({ facets: { agent: 'issue_solver' } })).toBe(2)
    expect(store.sessionList({ facets: { agent: 'issue_solver' } }).map((r) => r.id).sort()).toEqual(['s1', 's2'])
  })

  it('an empty filter tags all sessions', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2', 'codex')
    store.createUserFacet('agent')
    expect(store.setUserTag({}, 'agent', 'solver')).toEqual({ updated: 2 })
  })

  it('overwrites existing values (last write wins)', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2', 'codex')
    store.createUserFacet('agent')
    store.setUserTag({}, 'agent', 'a')
    store.setUserTag({ facets: { harness: 'codex' } }, 'agent', 'b')
    // count ties, so sort by value — the dist query only orders by count
    const dist = store.facetDistribution('agent').sort((x, y) => String(x.value).localeCompare(String(y.value)))
    expect(dist).toEqual([
      { value: 'a', count: 1 },
      { value: 'b', count: 1 },
    ])
  })

  it('a null value clears the tag from the matching set', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2')
    store.createUserFacet('agent')
    store.setUserTag({}, 'agent', 'a')
    expect(store.setUserTag({}, 'agent', null)).toEqual({ updated: 2 })
    expect(store.facetDistribution('agent')).toEqual([])
  })

  it('stores the value as JSON so annotation-source reads work', () => {
    const { db, store } = make()
    seed(db, 's1')
    store.createUserFacet('agent')
    store.setUserTag({}, 'agent', 'solver')
    const row = db.prepare("SELECT processor, value FROM annotations WHERE session_id='s1' AND key='agent'").get() as {
      processor: string
      value: string
    }
    expect(row.processor).toBe('user')
    expect(row.value).toBe('"solver"')
  })

  it('refuses facets not owned by the user', () => {
    const { db, store } = make()
    seed(db, 's1')
    expect(store.setUserTag({}, 'repo', 'x')).toBeNull()
    expect(store.setUserTag({}, 'nope', 'x')).toBeNull()
  })

  it('an ids filter scopes the write to exactly those sessions', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2')
    seed(db, 's3')
    store.createUserFacet('agent')
    expect(store.setUserTag({ ids: ['s2'] }, 'agent', 'solver')).toEqual({ updated: 1 })
    expect(store.sessionList({ facets: { agent: 'solver' } }).map((r) => r.id)).toEqual(['s2'])
  })
})

describe('collision with pipeline annotations', () => {
  it('rejects a field name already used as a processor annotation key', () => {
    const { db, store } = make()
    seed(db, 's1')
    db.prepare("INSERT INTO annotations (session_id, processor, key, value) VALUES ('s1','enrich-session','title','\"x\"')").run()
    expect(store.createUserFacet('title')).toHaveProperty('error')
  })

  it('user facet reads ignore processor rows that later appear under the same key', () => {
    const { db, store } = make()
    seed(db, 's1')
    seed(db, 's2')
    store.createUserFacet('agent')
    store.setUserTag({ ids: ['s1'] }, 'agent', 'solver')
    // a processor introduced after the field was created starts writing the same key
    db.prepare("INSERT INTO annotations (session_id, processor, key, value) VALUES ('s2','enrich-session','agent','\"other\"')").run()
    expect(store.facetDistribution('agent')).toEqual([{ value: 'solver', count: 1 }])
    expect(store.sessionCount({ facets: { agent: 'other' } })).toBe(0)
    expect(store.sessionCount({ facets: { agent: 'solver' } })).toBe(1)
    const fv = store.facetValues('s2').filter((v) => v.key === 'agent')[0]
    expect(fv?.value).toBeNull()
  })
})

describe('facet registry exposure', () => {
  it('facetList and facetValues expose the producer, so the client can tell user fields apart', () => {
    const { db, store } = make()
    seed(db, 's1')
    store.createUserFacet('agent')
    const byKey: Record<string, string | undefined> = {}
    store.facetList().forEach((f) => (byKey[f.key] = (f as { producer?: string }).producer))
    expect(byKey.agent).toBe('user')
    expect(byKey.repo).toBe('intrinsic')
    const fv = store.facetValues('s1').filter((v) => v.key === 'agent')[0] as { producer?: string }
    expect(fv.producer).toBe('user')
  })
})

describe('deleteUserFacet', () => {
  it('removes the facet and its annotation rows', () => {
    const { db, store } = make()
    seed(db, 's1')
    store.createUserFacet('agent')
    store.setUserTag({}, 'agent', 'a')
    expect(store.deleteUserFacet('agent')).toBe(true)
    expect(store.facet('agent')).toBeUndefined()
    const n = (db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE key='agent'").get() as { n: number }).n
    expect(n).toBe(0)
  })

  it('refuses facets not owned by the user', () => {
    const { store } = make()
    expect(store.deleteUserFacet('repo')).toBe(false)
    expect(store.facet('repo')).toBeDefined()
  })
})
