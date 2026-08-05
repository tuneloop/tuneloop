import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { INTRINSIC_FACETS } from '../core/facets'
import { createDashboardServer } from './http'

let server: Server | undefined
let tmpDir: string | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

/**
 * `onDisk` is needed by any endpoint whose read model calls `store.queryAll`: that
 * reopens the database read-only by path, which SQLite refuses for `:memory:`.
 */
async function start(onDisk = false) {
  const path = onDisk ? join((tmpDir = mkdtempSync(join(tmpdir(), 'http-test-'))), 'store.db') : ':memory:'
  const db = openDb(path)
  const store = new Store(db)
  store.registerFacets('intrinsic', INTRINSIC_FACETS)
  const seed = (id: string, source = 'claude-code') =>
    db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, source, 'anthropic')
  server = createDashboardServer(store, path)
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

describe('tool-health endpoints', () => {
  /** A session with two MCP calls (one failed) and a compound shell call. */
  const seedTools = (db: ReturnType<typeof openDb>) => {
    const ts = new Date().toISOString()
    db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, started_at) VALUES (?,?,?,?,?,?)').run(
      's1',
      's1',
      'claude-code',
      'anthropic',
      'o/r',
      ts,
    )
    const calls: Array<[string, string, number, string | null, string | null]> = [
      ['mcp__sentry__listIssues', 'mcp_call', 0, null, null],
      ['mcp__sentry__getEvent', 'mcp_call', 1, 'auth', null],
      ['Bash', 'shell', 0, null, 'npm ci && npm test'],
    ]
    calls.forEach(([name, action, isError, cat, command], idx) => {
      db.prepare(
        `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, error_category, command, is_sidechain, ts)
         VALUES ('s1',?,?,?,?,?,?,?,0,?)`,
      ).run(idx, name, action, isError ? 0 : 1, isError, cat, command, ts)
    })
    db.prepare("INSERT INTO tool_call_commands VALUES ('s1', 2, 0, 'npm')").run()
  }

  it('GET /api/tool-health returns both rosters', async () => {
    const { db, get } = await start(true)
    seedTools(db)
    const r = (await get('/api/tool-health')) as {
      mcp: { rows: Array<{ name: string; calls: number }> }
      builtin: { rows: Array<{ name: string; shell?: boolean }> }
    }
    expect(r.mcp.rows).toMatchObject([{ name: 'sentry', calls: 2 }])
    expect(r.builtin.rows).toMatchObject([{ name: 'npm', shell: true }])
  })

  it('GET /api/tool-health-detail scopes to one entity', async () => {
    const { db, get } = await start(true)
    seedTools(db)
    const d = (await get('/api/tool-health-detail?kind=mcp&name=sentry')) as {
      perTool: Array<{ name: string }>
      errorCategories: Array<{ category: string }>
    }
    expect(d.perTool.map((t) => t.name).sort()).toEqual(['getEvent', 'listIssues'])
    expect(d.errorCategories).toEqual([{ category: 'auth', calls: 1 }])
  })

  it('GET /api/tool-health-detail rejects a bad kind', async () => {
    const { get } = await start()
    expect(await get('/api/tool-health-detail?kind=nonsense&name=x')).toMatchObject({ error: expect.any(String) })
  })

  it('GET /api/tool-error-advice is null until a card has been drafted', async () => {
    const { db, get } = await start(true)
    seedTools(db)
    expect(await get('/api/tool-error-advice?kind=mcp&name=sentry')).toBeNull()
  })

  it('GET /api/tool-error-advice returns the drafted card', async () => {
    const { db, store, get } = await start(true)
    seedTools(db)
    store.setToolErrorAdvice('claude-code', 'mcp', 'sentry', {
      diagnosis: 'The token has expired.',
      snippet: '## sentry\nRe-auth before querying.',
      evidenceHash: 'h1',
      model: 'test-model',
    })
    expect(await get('/api/tool-error-advice?kind=mcp&name=sentry')).toMatchObject({
      diagnosis: 'The token has expired.',
      model: 'test-model',
    })
  })

  it('GET /api/tool-error-advice rejects a missing name', async () => {
    const { get } = await start(true)
    expect(await get('/api/tool-error-advice?kind=mcp')).toMatchObject({ error: expect.any(String) })
  })

  it('GET /api/error-occurrences scopes by entity when kind+name are given', async () => {
    const { db, get } = await start(true)
    seedTools(db)
    const scoped = (await get('/api/error-occurrences?category=auth&kind=mcp&name=sentry')) as Array<{ name: string }>
    expect(scoped.map((o) => o.name)).toEqual(['mcp__sentry__getEvent'])
    // Without them it stays the Ops widget's unscoped query.
    expect((await get('/api/error-occurrences?category=auth')) as unknown[]).toHaveLength(1)
  })
})
