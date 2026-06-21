import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Bucket, Store } from '../store/store'
import { DASHBOARD_HTML } from './dashboard'

/** Read-only JSON API + dashboard SPA over the analyzed store. */
export function createDashboardServer(store: Store, dbPath: string): Server {
  return createServer((req, res) => {
    route(req, res, store, dbPath).catch((err) => sendJson(res, 500, { error: (err as Error).message }))
  })
}

async function route(req: IncomingMessage, res: ServerResponse, store: Store, dbPath: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (req.method === 'POST') {
    const body = await readBody(req)
    if (path === '/api/features') {
      const title = String(body.title ?? '').trim()
      if (!title) {
        sendJson(res, 400, { error: 'title required' })
        return
      }
      sendJson(res, 200, store.createFeature(title, body.parentId || undefined))
      return
    }
    if (path === '/api/features/update') {
      sendJson(res, 200, { ok: store.updateFeature(String(body.id), body) })
      return
    }
    if (path === '/api/features/delete') {
      sendJson(res, 200, { ok: store.deleteFeature(String(body.id)) })
      return
    }
    sendJson(res, 404, { error: 'not found' })
    return
  }

  if (path === '/' || path === '/index.html') {
    sendHtml(res, DASHBOARD_HTML)
    return
  }
  if (path === '/api/overview') {
    sendJson(res, 200, { ...store.summary(), dbPath })
    return
  }
  if (path === '/api/facets') {
    sendJson(res, 200, store.facetList())
    return
  }
  if (path === '/api/distribution') {
    const facet = url.searchParams.get('facet')
    if (!facet) {
      sendJson(res, 400, { error: 'missing facet' })
      return
    }
    sendJson(res, 200, store.facetDistribution(facet))
    return
  }
  if (path === '/api/measures') {
    sendJson(res, 200, store.measureList())
    return
  }
  if (path === '/api/breakdown') {
    const q = url.searchParams
    const measure = q.get('measure')
    if (!measure) {
      sendJson(res, 400, { error: 'missing measure' })
      return
    }
    const reserved = new Set(['measure', 'by'])
    const filters: Record<string, string> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) filters[k] = v
    }
    sendJson(res, 200, store.breakdown(measure, q.get('by') ?? undefined, filters))
    return
  }
  if (path === '/api/kpi') {
    // Windowed cost-per-shipped-artifact, hero = feature; PR/ticket are the same metric.
    const days = parseInt(url.searchParams.get('days') ?? '', 10)
    const win =
      Number.isFinite(days) && days > 0
        ? (() => {
            const to = new Date()
            const from = new Date(to.getTime() - days * 86_400_000)
            return { from: from.toISOString(), to: to.toISOString() }
          })()
        : undefined
    // No ticket source in this CLI (would need a Jira/Linear adapter), so PR + feature only.
    sendJson(res, 200, {
      feature: store.costPerArtifact('feature', win?.from, win?.to),
      pr: store.costPerArtifact('pr', win?.from, win?.to),
    })
    return
  }
  if (path === '/api/artifacts') {
    sendJson(res, 200, store.artifactList(url.searchParams.get('kind') ?? undefined))
    return
  }
  if (path === '/api/timeseries') {
    const raw = url.searchParams.get('bucket')
    const bucket: Bucket = raw === 'day' || raw === 'month' ? raw : 'week'
    sendJson(
      res,
      200,
      store.timeseries(bucket, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined),
    )
    return
  }
  if (path === '/api/sessions') {
    const q = url.searchParams
    const limit = q.get('limit')
    // Any non-reserved query param is treated as a facet filter; sessionList
    // validates keys against the registry and ignores unknown ones.
    const reserved = new Set(['q', 'artifact', 'artifact_kind', 'limit'])
    const facets: Record<string, string> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) facets[k] = v
    }
    sendJson(
      res,
      200,
      store.sessionList({
        facets,
        q: q.get('q') ?? undefined,
        artifact: q.get('artifact') ?? undefined,
        artifactKind: q.get('artifact_kind') ?? undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      }),
    )
    return
  }
  if (path === '/api/session') {
    const id = url.searchParams.get('id')
    if (!id) {
      sendJson(res, 400, { error: 'missing id' })
      return
    }
    const detail = store.sessionDetail(id)
    if (!detail) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    sendJson(res, 200, detail)
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) data = data.slice(0, 1_000_000) // guard
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}
