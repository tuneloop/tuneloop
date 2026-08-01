import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { INTRINSIC_FACETS } from '../core/facets'
import { createDashboardServer } from './http'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

async function start() {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.registerFacets('intrinsic', INTRINSIC_FACETS)
  const seed = (id: string, source = 'claude-code') =>
    db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, source, 'anthropic')
  server = createDashboardServer(store, ':memory:')
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as Record<string, any> }
  }
  const get = async (path: string) => (await fetch(base + path)).json()
  return { db, store, seed, post, get }
}

describe('user facet endpoints', () => {
  it('POST /api/user-facets creates a facet that /api/facets lists', async () => {
    const { post, get } = await start()
    const r = await post('/api/user-facets', { key: 'Agent Name' })
    expect(r.status).toBe(200)
    expect(r.body.facet).toMatchObject({ key: 'agent_name', label: 'Agent Name' })
    const facets = (await get('/api/facets')) as Array<{ key: string }>
    expect(facets.map((f) => f.key)).toContain('agent_name')
  })

  it('POST /api/user-facets rejects unusable keys with 400', async () => {
    const { post } = await start()
    expect((await post('/api/user-facets', { key: '!!!' })).status).toBe(400)
    expect((await post('/api/user-facets', { key: 'repo' })).status).toBe(400)
    expect((await post('/api/user-facets', {})).status).toBe(400)
  })

  it('POST /api/sessions/tag applies to the filtered set, and clears with a null value', async () => {
    const { post, get, seed } = await start()
    seed('s1')
    seed('s2')
    seed('s3', 'codex')
    await post('/api/user-facets', { key: 'agent' })

    const r = await post('/api/sessions/tag', { key: 'agent', value: 'solver', filter: { harness: 'claude-code' } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ updated: 2 })

    const list = (await get('/api/sessions?agent=solver')) as { rows: Array<{ id: string }>; total: number }
    expect(list.total).toBe(2)
    expect(list.rows.map((x) => x.id).sort()).toEqual(['s1', 's2'])

    const clear = await post('/api/sessions/tag', { key: 'agent', value: null, filter: {} })
    expect(clear.status).toBe(200)
    expect(clear.body).toEqual({ updated: 2 })
    const after = (await get('/api/sessions?agent=solver')) as { total: number }
    expect(after.total).toBe(0)
  })

  it('POST /api/sessions/tag rejects non-user facets with 400', async () => {
    const { post, seed } = await start()
    seed('s1')
    expect((await post('/api/sessions/tag', { key: 'repo', value: 'x', filter: {} })).status).toBe(400)
    expect((await post('/api/sessions/tag', { value: 'x', filter: {} })).status).toBe(400)
  })

  it('POST /api/sessions/tag with filter.ids tags a single session', async () => {
    const { post, get, seed } = await start()
    seed('s1')
    seed('s2')
    await post('/api/user-facets', { key: 'agent' })
    const r = await post('/api/sessions/tag', { key: 'agent', value: 'solver', filter: { ids: ['s1'] } })
    expect(r.body).toEqual({ updated: 1 })
    const list = (await get('/api/sessions?agent=solver')) as { rows: Array<{ id: string }> }
    expect(list.rows.map((x) => x.id)).toEqual(['s1'])
  })

  it('POST /api/user-facets/delete removes the facet', async () => {
    const { post, get } = await start()
    await post('/api/user-facets', { key: 'agent' })
    const r = await post('/api/user-facets/delete', { key: 'agent' })
    expect(r.status).toBe(200)
    const facets = (await get('/api/facets')) as Array<{ key: string }>
    expect(facets.map((f) => f.key)).not.toContain('agent')
  })
})
