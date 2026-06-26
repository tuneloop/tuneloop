import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Bucket, Store } from '../store/store'
import { ERROR_CATEGORIES } from '../core/error-category'

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
    await sendFile(res, join(clientDir(), 'index.html'), 'text/html; charset=utf-8')
    return
  }
  if (path.startsWith('/client/')) {
    await serveClientAsset(res, path)
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
  if (path === '/api/error-categories') {
    // Taxonomy metadata (labels + tooltip descriptions) for the error-category widget.
    sendJson(res, 200, ERROR_CATEGORIES)
    return
  }
  if (path === '/api/error-occurrences') {
    // Drill-down: every failed tool call of one category, windowed, for the widget.
    const category = url.searchParams.get('category')
    if (!category) {
      sendJson(res, 400, { error: 'missing category' })
      return
    }
    const window = { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined }
    sendJson(res, 200, store.errorOccurrences(category, window))
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
    const reserved = new Set(['measure', 'by', 'from', 'to'])
    const filters: Record<string, string> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) filters[k] = v
    }
    const window = { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined }
    sendJson(res, 200, store.breakdown(measure, q.get('by') ?? undefined, filters, window))
    return
  }
  if (path === '/api/kpis') {
    // Headline KPI row, windowed (default 7 days) plus the same-length prior
    // period so the UI can show a delta. Session-grain metrics window by session
    // start; cost-per-artifact by completion (see Store.costPerArtifact). No
    // ticket source in this CLI (would need a Jira/Linear adapter), so the
    // cost-per-artifact KPIs are PR + feature only.
    // Outcome types counting as success for the rate KPI (the UI's editable
    // success definition). Empty → Store.kpis defaults to ['session_success'].
    const outcomes = (url.searchParams.get('outcomes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // Window = the dashboard's top-level selector. 'all' → whole history with no
    // prior period (so no deltas); a number → that many days plus the same-length
    // prior period.
    const daysRaw = url.searchParams.get('days') ?? '7'
    if (daysRaw === 'all') {
      sendJson(res, 200, { days: 'all', window: null, current: store.kpis(undefined, undefined, outcomes), previous: null })
      return
    }
    const parsed = parseInt(daysRaw, 10)
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
    const span = days * 86_400_000
    const now = Date.now()
    const to = new Date(now).toISOString()
    const from = new Date(now - span).toISOString()
    const prevFrom = new Date(now - 2 * span).toISOString()
    sendJson(res, 200, {
      days,
      window: { from, to },
      current: store.kpis(from, to, outcomes),
      previous: store.kpis(prevFrom, from, outcomes),
    })
    return
  }
  if (path === '/api/ops-over-time') {
    // Operational tool-call metrics over time. view = tool_calls | error_rate |
    // skill_usage; by=name splits by tool/skill name; bucket day|week|month.
    const q = url.searchParams
    const rawView = q.get('view')
    const view: 'tool_calls' | 'error_rate' | 'skill_usage' =
      rawView === 'tool_calls' || rawView === 'skill_usage' ? rawView : 'error_rate'
    const rawBucket = q.get('bucket')
    const bucket: Bucket = rawBucket === 'day' || rawBucket === 'month' ? rawBucket : 'week'
    const reserved = new Set(['view', 'bucket', 'by', 'from', 'to', 'topK'])
    const filters: Record<string, string> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) filters[k] = v
    }
    const opsTopK = parseInt(q.get('topK') ?? '', 10)
    sendJson(
      res,
      200,
      store.opsOverTime({
        view,
        bucket,
        by: q.get('by') === 'name' ? 'name' : undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        filters,
        topK: Number.isFinite(opsTopK) && opsTopK > 0 ? opsTopK : undefined,
      }),
    )
    return
  }
  if (path === '/api/sessions-over-time') {
    // Session count per bucket, optionally split into one series per facet value.
    const q = url.searchParams
    const rawBucket = q.get('bucket')
    const bucket: Bucket = rawBucket === 'day' || rawBucket === 'month' ? rawBucket : 'week'
    const reserved = new Set(['bucket', 'by', 'from', 'to', 'topK'])
    // Repeated params (?model=a&model=b) collect into one OR'd filter per facet.
    const filters: Record<string, string[]> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) (filters[k] ??= []).push(v)
    }
    const sessTopK = parseInt(q.get('topK') ?? '', 10)
    sendJson(
      res,
      200,
      store.sessionsOverTime({
        bucket,
        by: q.get('by') || undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        filters,
        topK: Number.isFinite(sessTopK) && sessTopK > 0 ? sessTopK : undefined,
      }),
    )
    return
  }
  if (path === '/api/spend-over-time') {
    // The burn / total-spend-breakdown view: spend per bucket, optionally split
    // into one series per facet value. `bucket` day|week|month; `by` optional
    // facet; any other query param is a session-level filter.
    const q = url.searchParams
    const rawBucket = q.get('bucket')
    const bucket: Bucket = rawBucket === 'day' || rawBucket === 'month' ? rawBucket : 'week'
    const reserved = new Set(['bucket', 'by', 'from', 'to', 'topK'])
    // Repeated params (?model=a&model=b) collect into one OR'd filter per facet.
    const filters: Record<string, string[]> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) (filters[k] ??= []).push(v)
    }
    const spendTopK = parseInt(q.get('topK') ?? '', 10)
    sendJson(
      res,
      200,
      store.spendOverTime({
        bucket,
        by: q.get('by') || undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        filters,
        topK: Number.isFinite(spendTopK) && spendTopK > 0 ? spendTopK : undefined,
      }),
    )
    return
  }
  if (path === '/api/cost-artifact') {
    // Cost-per-shipped-artifact detail: the windowed unit-cost KPI (current +
    // prior period for a delta) plus the two decomposition curves (burn,
    // throughput) over the same window and the burn-efficiency period sum.
    // `days` is a number or 'all' (whole history, no prior period); `kind` is
    // feature | pr.
    const q = url.searchParams
    const kind = q.get('kind') === 'pr' ? 'pr' : 'feature'
    const rawBucket = q.get('bucket')
    const bucket: Bucket = rawBucket === 'day' || rawBucket === 'month' ? rawBucket : 'week'
    const daysRaw = q.get('days') ?? '7'
    if (daysRaw === 'all') {
      const curves = store.costCurves(kind, bucket)
      sendJson(res, 200, {
        kind,
        days: 'all',
        window: null,
        kpi: { current: store.costPerArtifact(kind), previous: null },
        period: store.costPeriod(kind),
        burn: curves.burn,
        throughput: curves.throughput,
        buckets: curves.buckets,
      })
      return
    }
    const parsed = parseInt(daysRaw, 10)
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
    const span = days * 86_400_000
    const now = Date.now()
    const to = new Date(now).toISOString()
    const from = new Date(now - span).toISOString()
    const prevFrom = new Date(now - 2 * span).toISOString()
    // Curves share the KPI's window so the chart shows the same N days.
    const curves = store.costCurves(kind, bucket, from, to)
    sendJson(res, 200, {
      kind,
      days,
      window: { from, to },
      kpi: { current: store.costPerArtifact(kind, from, to), previous: store.costPerArtifact(kind, prevFrom, from) },
      period: store.costPeriod(kind, from, to),
      burn: curves.burn,
      throughput: curves.throughput,
      buckets: curves.buckets,
    })
    return
  }
  if (path === '/api/outcome-types') {
    sendJson(res, 200, store.outcomeTypes())
    return
  }
  if (path === '/api/success-rate') {
    // Session Outcome Rate over time. `outcomes` = the success set (numerator,
    // default session_success); `bucket` = day|week|month; `by` = optional facet
    // to split into series; any other query param is a session-level filter.
    const q = url.searchParams
    const outcomes = (q.get('outcomes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const rawBucket = q.get('bucket')
    const bucket: Bucket = rawBucket === 'day' || rawBucket === 'month' ? rawBucket : 'week'
    const reserved = new Set(['outcomes', 'bucket', 'by', 'from', 'to', 'topK'])
    // Repeated params (?model=a&model=b) collect into one OR'd filter per facet.
    const filters: Record<string, string[]> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) (filters[k] ??= []).push(v)
    }
    const srTopK = parseInt(q.get('topK') ?? '', 10)
    sendJson(
      res,
      200,
      store.successRate({
        outcomes: outcomes.length ? outcomes : ['session_success'],
        bucket,
        by: q.get('by') || undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        filters,
        topK: Number.isFinite(srTopK) && srTopK > 0 ? srTopK : undefined,
      }),
    )
    return
  }
  if (path === '/api/artifact-suggest') {
    // Typeahead for the session-list artifact search.
    const q = url.searchParams.get('q') ?? ''
    const kind = url.searchParams.get('kind') || undefined
    const lim = parseInt(url.searchParams.get('limit') ?? '', 10)
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 25) : 10
    sendJson(res, 200, store.suggestArtifacts(q, kind, limit))
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
    const reserved = new Set(['q', 'artifact', 'artifact_kind', 'from', 'to', 'outcome_types', 'limit'])
    const facets: Record<string, string> = {}
    for (const [k, v] of q.entries()) {
      if (!reserved.has(k) && v) facets[k] = v
    }
    const outcomeTypesRaw = q.get('outcome_types')
    sendJson(
      res,
      200,
      store.sessionList({
        facets,
        q: q.get('q') ?? undefined,
        artifact: q.get('artifact') ?? undefined,
        artifactKind: q.get('artifact_kind') ?? undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        outcomeTypes: outcomeTypesRaw ? outcomeTypesRaw.split(',').filter(Boolean) : undefined,
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
  if (path === '/api/session-files') {
    const id = url.searchParams.get('id')
    if (!id) {
      sendJson(res, 400, { error: 'missing id' })
      return
    }
    sendJson(res, 200, { edits: store.fileChanges(id) })
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

// The dashboard SPA is built by tsup into dist/client (app.js + index.html +
// styles.css) and served from there. Resolve that directory once, tolerating
// both prod (this module runs from dist/) and dev (tsx from src/, where the
// build still emits to <pkg>/dist/client).
let CLIENT_DIR: string | null = null
function clientDir(): string {
  if (CLIENT_DIR) return CLIENT_DIR
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'client', 'index.html'))) return (CLIENT_DIR = join(dir, 'client'))
    if (existsSync(join(dir, 'dist', 'client', 'index.html'))) return (CLIENT_DIR = join(dir, 'dist', 'client'))
    dir = dirname(dir)
  }
  return (CLIENT_DIR = join(process.cwd(), 'dist', 'client'))
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function serveClientAsset(res: ServerResponse, urlPath: string): Promise<void> {
  const base = clientDir()
  const file = join(base, urlPath.slice('/client/'.length))
  if (!file.startsWith(base)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  const ext = file.slice(file.lastIndexOf('.'))
  await sendFile(res, file, CONTENT_TYPES[ext] ?? 'application/octet-stream')
}

async function sendFile(res: ServerResponse, file: string, type: string): Promise<void> {
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': type })
    res.end(buf)
  } catch {
    sendJson(res, 404, { error: 'not found' })
  }
}
