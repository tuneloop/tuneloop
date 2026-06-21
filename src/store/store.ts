import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Session } from '../core/model'
import type { ProcessorResult } from '../core/processor'
import type { DB } from './db'
import { grainOf } from '../core/facets'
import type { FacetSpec } from '../core/facets'
import { aliasFor } from '../core/measures'
import type { MeasureSpec } from '../core/measures'
import type { ProcessorRunRow, UsageFactInput } from './types'

export interface Dist {
  value: string
  count: number
}

export interface Summary {
  sessions: number
  costUsd: number
  tokens: number
  firstAt: string | null
  lastAt: string | null
  models: Array<{ model: string; count: number }>
  outcomes: Array<{ type: string; count: number }>
  topTools: Array<{ name: string; calls: number; errors: number }>
  costPerMergedPr: { count: number; costPerUnit: number | null }
  /** Spend on enrichment (the "cost of running the analysis itself"). */
  analysisCostUsd: number
  /** Enrichment dimension distributions, empty when enrichment hasn't run. */
  useCases: Dist[]
  complexity: Dist[]
  autonomy: Dist[]
  success: Dist[]
  features: { total: number; derived: number; linked: number }
}

export class Store {
  constructor(private db: DB) {}

  /**
   * Content hash + parse version for a session, if already ingested. Both feed
   * the re-ingest decision: content_hash catches changed transcripts, parse
   * version catches a smarter parser (new fields extracted from the same bytes).
   */
  storedMeta(id: string): { hash: string; parseVersion: number } | undefined {
    const row = this.db
      .prepare('SELECT content_hash AS hash, parse_version AS parseVersion FROM sessions WHERE id = ?')
      .get(id) as { hash: string; parseVersion: number } | undefined
    return row
  }

  /** Set a session's resolved repo. Used to backfill repo without a full re-ingest. */
  setSessionRepo(id: string, repo: string) {
    this.db.prepare('UPDATE sessions SET repo = ? WHERE id = ?').run(repo, id)
  }

  ingestSession(
    session: Session,
    costUsd: number,
    facts: UsageFactInput[],
    priceTableVersion: string,
    parseVersion: number,
  ) {
    const nTurns = session.events.filter((e) => e.kind === 'user').length
    const tx = this.db.transaction(() => {
      // Upsert (NOT INSERT OR REPLACE): replacing the row would fire ON DELETE
      // CASCADE and wipe processor-owned children (annotations, outcomes,
      // session_artifacts) that a cache-hit processor then won't recreate. Update
      // in place so re-ingest only refreshes the session's own columns.
      this.db
        .prepare(
          `INSERT INTO sessions (
             id, session_id, source, provider, title, repo, branch, cwd,
             started_at, ended_at, n_turns, n_tool_calls, models,
             tok_input, tok_output, tok_cache_create, tok_cache_read,
             cost_usd, price_table_version, content_hash, parse_version, analyzed_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             session_id=excluded.session_id, source=excluded.source, provider=excluded.provider,
             title=excluded.title, repo=excluded.repo, branch=excluded.branch, cwd=excluded.cwd,
             started_at=excluded.started_at, ended_at=excluded.ended_at, n_turns=excluded.n_turns,
             n_tool_calls=excluded.n_tool_calls, models=excluded.models,
             tok_input=excluded.tok_input, tok_output=excluded.tok_output,
             tok_cache_create=excluded.tok_cache_create, tok_cache_read=excluded.tok_cache_read,
             cost_usd=excluded.cost_usd, price_table_version=excluded.price_table_version,
             content_hash=excluded.content_hash, parse_version=excluded.parse_version,
             analyzed_at=excluded.analyzed_at`,
        )
        .run(
          session.id,
          session.sessionId,
          session.source,
          session.provider,
          session.title ?? null,
          session.project.repo ?? null,
          session.project.branch ?? null,
          session.project.cwd ?? null,
          session.startedAt ?? null,
          session.endedAt ?? null,
          nTurns,
          session.toolCalls.length,
          JSON.stringify(session.models),
          session.tokens.input,
          session.tokens.output,
          session.tokens.cacheCreate,
          session.tokens.cacheRead,
          costUsd,
          priceTableVersion,
          session.raw.contentHash,
          parseVersion,
          new Date().toISOString(),
        )

      this.db
        .prepare('INSERT OR REPLACE INTO session_blobs (id, gz) VALUES (?, ?)')
        .run(session.id, gzipSync(Buffer.from(JSON.stringify(session))))

      this.db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(session.id)
      const insTool = this.db.prepare(
        `INSERT INTO tool_calls
           (session_id, idx, name, action, ok, is_error, target_path, command, is_sidechain, ts, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      session.toolCalls.forEach((t, idx) => {
        insTool.run(
          session.id,
          idx,
          t.name,
          t.action,
          t.result.ok ? 1 : 0,
          t.result.isError ? 1 : 0,
          t.target.paths?.[0] ?? null,
          t.target.command ?? null,
          t.isSidechain ? 1 : 0,
          t.ts ?? null,
          t.durationMs ?? null,
        )
      })

      this.db.prepare('DELETE FROM usage_facts WHERE session_id = ?').run(session.id)
      const insUsage = this.db.prepare(
        `INSERT INTO usage_facts
           (session_id, idx, model, is_sidechain, ts,
            tok_input, tok_output, tok_cache_create, tok_cache_read, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      for (const f of facts) {
        insUsage.run(
          session.id,
          f.idx,
          f.model,
          f.isSidechain ? 1 : 0,
          f.ts ?? null,
          f.tokens.input,
          f.tokens.output,
          f.tokens.cacheCreate,
          f.tokens.cacheRead,
          f.usd,
        )
      }
    })
    tx()
  }

  /**
   * Token/cost rolled up by model from `usage_facts` — the honest cost-by-model
   * the `sessions.models` array can't give (exploding it double-counts cost).
   */
  usageByModel(): Array<{ model: string; sessions: number; costUsd: number; tokens: number }> {
    return this.db
      .prepare(
        `SELECT model,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(cost_usd)              AS costUsd,
                SUM(tok_input + tok_output + tok_cache_create + tok_cache_read) AS tokens
         FROM usage_facts
         GROUP BY model
         ORDER BY costUsd DESC`,
      )
      .all() as Array<{ model: string; sessions: number; costUsd: number; tokens: number }>
  }

  /** Prior run record for cache checks. */
  processorRun(sessionId: string, processor: string): ProcessorRunRow | undefined {
    const row = this.db
      .prepare(
        'SELECT version, input_hash AS inputHash, model FROM processor_runs WHERE session_id = ? AND processor = ?',
      )
      .get(sessionId, processor) as ProcessorRunRow | undefined
    return row
  }

  /**
   * Persist one processor's output. Replaces this processor's prior rows for the
   * session (provenance via `producer`); never touches other processors' or
   * user-authored rows. Records the run for caching + analysis-cost accounting.
   */
  persistResult(
    sessionId: string,
    processor: string,
    version: number,
    inputHash: string,
    model: string | null,
    result: ProcessorResult,
  ) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM annotations WHERE session_id = ? AND processor = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM outcomes WHERE session_id = ? AND producer = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM session_artifacts WHERE session_id = ? AND producer = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM files_index WHERE session_id = ? AND producer = ?').run(sessionId, processor)

      for (const a of result.annotations ?? []) {
        this.db
          .prepare('INSERT OR REPLACE INTO annotations (session_id, processor, key, value) VALUES (?,?,?,?)')
          .run(sessionId, processor, a.key, JSON.stringify(a.value))
      }
      for (const a of result.artifacts ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO artifacts
               (id, kind, repo, ident, external_id, source, title, owner, complexity,
                complexity_basis, status, created_at, completed_at, parent_artifact_id, json, producer)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            a.id, a.kind, a.repo ?? null, a.ident ?? null, a.externalId ?? null, a.source ?? null,
            a.title ?? null, a.owner ?? null, a.complexity ?? null, a.complexityBasis ?? null,
            a.status ?? null, a.createdAt ?? null, a.completedAt ?? null, a.parentArtifactId ?? null,
            a.json === undefined ? null : JSON.stringify(a.json), processor,
          )
      }
      for (const l of result.links ?? []) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO artifact_links (from_id, to_id, relation, source, confidence, producer) VALUES (?,?,?,?,?,?)',
          )
          .run(l.fromId, l.toId, l.relation, l.source, l.confidence ?? null, processor)
      }
      for (const sa of result.sessionArtifacts ?? []) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO session_artifacts (session_id, artifact_id, role, source, confidence, producer) VALUES (?,?,?,?,?,?)',
          )
          .run(sessionId, sa.artifactId, sa.role, sa.source, sa.confidence ?? null, processor)
      }
      for (const o of result.outcomes ?? []) {
        this.db
          .prepare('INSERT INTO outcomes (session_id, type, artifact_id, ts, producer) VALUES (?,?,?,?,?)')
          .run(sessionId, o.type, o.artifactId ?? null, o.ts ?? null, processor)
      }
      for (const f of result.files ?? []) {
        this.db
          .prepare('INSERT OR REPLACE INTO files_index (repo, path, session_id, producer) VALUES (?,?,?,?)')
          .run(f.repo ?? null, f.path, sessionId, processor)
      }

      this.db
        .prepare(
          `INSERT OR REPLACE INTO processor_runs
             (session_id, processor, version, input_hash, model, status, in_tokens, out_tokens, cost_usd, ran_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId, processor, version, inputHash, model, 'ok',
          result.selfCost?.tokens.input ?? 0, result.selfCost?.tokens.output ?? 0,
          result.selfCost?.usd ?? 0, new Date().toISOString(),
        )
    })
    tx()
  }

  /** Existing features (for biasing derived feature linkage). */
  listFeatures(): Array<{ id: string; title: string }> {
    const rows = this.db
      .prepare("SELECT id, COALESCE(title, '') AS title FROM artifacts WHERE kind = 'feature'")
      .all() as Array<{ id: string; title: string }>
    return rows
  }

  /** Persist facets (intrinsic + processor-declared) so the dashboard discovers them generically. */
  registerFacets(producer: string, specs: FacetSpec[]) {
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO facets (key, label, type, source, col, base, multi, roles, producer) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    const tx = this.db.transaction(() => {
      for (const f of specs) {
        ins.run(
          f.key,
          f.label ?? f.key,
          f.type,
          f.source,
          f.column ?? null,
          f.base ?? null,
          f.multi ? 1 : 0,
          JSON.stringify(f.roles ?? []),
          producer,
        )
      }
    })
    tx()
  }

  summary(): Summary {
    const c = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(cost_usd),0) AS costUsd,
                COALESCE(SUM(tok_input+tok_output+tok_cache_create+tok_cache_read),0) AS tokens,
                MIN(started_at) AS firstAt, MAX(started_at) AS lastAt
         FROM sessions`,
      )
      .get() as { sessions: number; costUsd: number; tokens: number; firstAt: string | null; lastAt: string | null }

    const models = this.db
      .prepare(
        `SELECT value AS model, COUNT(*) AS count
         FROM sessions, json_each(sessions.models)
         GROUP BY value ORDER BY count DESC`,
      )
      .all() as Array<{ model: string; count: number }>

    const outcomes = this.db
      .prepare('SELECT type, COUNT(*) AS count FROM outcomes GROUP BY type ORDER BY count DESC')
      .all() as Array<{ type: string; count: number }>

    const topTools = this.db
      .prepare(
        'SELECT name, COUNT(*) AS calls, COALESCE(SUM(is_error),0) AS errors FROM tool_calls GROUP BY name ORDER BY calls DESC LIMIT 10',
      )
      .all() as Array<{ name: string; calls: number; errors: number }>

    const analysisCostUsd = (
      this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM processor_runs').get() as { s: number }
    ).s

    const features = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM artifacts WHERE kind='feature') AS total,
           (SELECT COUNT(*) FROM artifacts WHERE kind='feature' AND source='derived') AS derived,
           (SELECT COUNT(DISTINCT artifact_id) FROM session_artifacts WHERE role='contributed') AS linked`,
      )
      .get() as { total: number; derived: number; linked: number }

    return {
      ...c,
      models,
      outcomes,
      topTools,
      costPerMergedPr: this.costPerArtifact('pr'),
      analysisCostUsd,
      useCases: this.arrayDist('use_case'),
      complexity: this.scalarDist('complexity'),
      autonomy: this.scalarDist('autonomy'),
      success: this.scalarDist('success'),
      features,
    }
  }

  /** Distribution of a scalar annotation value across sessions. */
  private scalarDist(key: string): Dist[] {
    return this.db
      .prepare(
        "SELECT json_extract(value,'$') AS value, COUNT(*) AS count FROM annotations WHERE key = ? GROUP BY value ORDER BY count DESC",
      )
      .all(key) as Dist[]
  }

  /** Distribution of a multi-value (JSON array) annotation across sessions. */
  private arrayDist(key: string): Dist[] {
    return this.db
      .prepare(
        `SELECT je.value AS value, COUNT(*) AS count
         FROM annotations a, json_each(a.value) je
         WHERE a.key = ? GROUP BY je.value ORDER BY count DESC`,
      )
      .all(key) as Dist[]
  }

  /** Windowed cost-per-shipped-artifact KPI (no window = all time). Unique sessions per artifact. */
  costPerArtifact(kind: string, from?: string, to?: string): { count: number; costPerUnit: number | null } {
    const range = from && to ? 'AND a.completed_at >= ? AND a.completed_at < ?' : ''
    const params = from && to ? [kind, from, to] : [kind]
    const count = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.kind = ? AND a.completed_at IS NOT NULL ${range}`)
        .get(...params) as { n: number }
    ).n
    if (count === 0) return { count: 0, costPerUnit: null }
    const num = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd),0) AS s FROM (
             SELECT DISTINCT s.id, s.cost_usd
             FROM artifacts a
             JOIN session_artifacts sa ON sa.artifact_id = a.id
             JOIN sessions s ON s.id = sa.session_id
             WHERE a.kind = ? AND a.completed_at IS NOT NULL ${range})`,
        )
        .get(...params) as { s: number }
    ).s
    return { count, costPerUnit: num / count }
  }

  // ---- dashboard read API ---------------------------------------------------

  /** Spend, session count, and shipped-PR count per time bucket. */
  timeseries(bucket: Bucket, from?: string, to?: string): TimePoint[] {
    const bx = bucketExpr('started_at', bucket)
    const where = from && to ? 'WHERE started_at >= ? AND started_at < ?' : 'WHERE started_at IS NOT NULL'
    const params = from && to ? [from, to] : []
    const spend = this.db
      .prepare(
        `SELECT ${bx} AS bucket, COUNT(*) AS sessions, COALESCE(SUM(cost_usd),0) AS spend
         FROM sessions ${where} GROUP BY bucket ORDER BY bucket`,
      )
      .all(...params) as Array<{ bucket: string; sessions: number; spend: number }>

    const shipped = this.db
      .prepare(
        `SELECT ${bucketExpr('completed_at', bucket)} AS bucket, COUNT(*) AS shipped
         FROM artifacts WHERE kind='pr' AND completed_at IS NOT NULL GROUP BY bucket`,
      )
      .all() as Array<{ bucket: string; shipped: number }>
    const shippedMap = new Map(shipped.map((r) => [r.bucket, r.shipped]))
    return spend.map((r) => ({ ...r, shipped: shippedMap.get(r.bucket) ?? 0 }))
  }

  /** The facet registry — drives dist cards, filters, and (later) breakdowns. */
  facetList(): FacetSpec[] {
    const rows = this.db.prepare('SELECT * FROM facets ORDER BY key').all() as Array<Record<string, any>>
    return rows.map(rowToFacet)
  }

  facet(key: string): FacetSpec | undefined {
    const row = this.db.prepare('SELECT * FROM facets WHERE key = ?').get(key) as Record<string, any> | undefined
    return row ? rowToFacet(row) : undefined
  }

  /**
   * Sessions per value of a facet — the generic dist card. The read shape is
   * derived from (source, multi): raw column, json_each, json_extract, or a child
   * table. This is a COUNT, so exploding a multi-valued facet is safe (a session
   * present under two values is intended); SUM measures are a separate concern.
   */
  facetDistribution(key: string): Dist[] {
    const f = this.facet(key)
    if (!f) return []
    const col = f.column ?? f.key
    let sql: string
    const params: unknown[] = []
    if (f.source === 'session') {
      sql = f.multi
        ? `SELECT je.value AS value, COUNT(*) AS count
           FROM sessions s, json_each(s.${col}) je GROUP BY je.value ORDER BY count DESC`
        : `SELECT s.${col} AS value, COUNT(*) AS count
           FROM sessions s WHERE s.${col} IS NOT NULL GROUP BY s.${col} ORDER BY count DESC`
    } else if (f.source === 'annotation') {
      sql = f.multi
        ? `SELECT je.value AS value, COUNT(*) AS count
           FROM annotations a, json_each(a.value) je WHERE a.key = ? GROUP BY je.value ORDER BY count DESC`
        : `SELECT json_extract(a.value,'$') AS value, COUNT(*) AS count
           FROM annotations a WHERE a.key = ? GROUP BY value ORDER BY count DESC`
      params.push(f.key)
    } else {
      const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
      const where = f.base ? `WHERE ${f.base}` : ''
      sql = `SELECT ${col} AS value, COUNT(DISTINCT session_id) AS count
             FROM ${table} ${where} GROUP BY ${col} ORDER BY count DESC`
    }
    sql += ' LIMIT 50' // bound high-cardinality facets (e.g. free-text topics)
    return this.db.prepare(sql).all(...params) as Dist[]
  }

  /**
   * Compile a facet + value into a session-scoped boolean SQL fragment (alias `s`).
   * One compiler, reused by session filters today and cohort splits later. Column
   * identifiers and `base` are registry-defined (trusted); the value is a bound param.
   */
  private facetPredicate(f: FacetSpec, value: string): { sql: string; params: unknown[] } {
    const col = f.column ?? f.key
    if (f.source === 'session') {
      return f.multi
        ? { sql: `EXISTS (SELECT 1 FROM json_each(s.${col}) je WHERE je.value = ?)`, params: [value] }
        : { sql: `s.${col} = ?`, params: [value] }
    }
    if (f.source === 'annotation') {
      return f.multi
        ? {
            sql: `EXISTS (SELECT 1 FROM annotations a, json_each(a.value) je
                  WHERE a.session_id = s.id AND a.key = ? AND je.value = ?)`,
            params: [f.key, value],
          }
        : {
            sql: `EXISTS (SELECT 1 FROM annotations a
                  WHERE a.session_id = s.id AND a.key = ? AND json_extract(a.value,'$') = ?)`,
            params: [f.key, value],
          }
    }
    const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
    const base = f.base ? `${f.base} AND ` : ''
    return {
      sql: `EXISTS (SELECT 1 FROM ${table} c WHERE c.session_id = s.id AND ${base}c.${col} = ?)`,
      params: [value],
    }
  }

  // ---- measures ------------------------------------------------------------

  /** Persist measures (intrinsic + processor-declared) for the dashboard. */
  registerMeasures(producer: string, specs: MeasureSpec[]) {
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO measures (key, label, source, expr, agg, base, format, producer) VALUES (?,?,?,?,?,?,?,?)',
    )
    const tx = this.db.transaction(() => {
      for (const m of specs) {
        ins.run(m.key, m.label ?? m.key, m.source, m.expr, m.agg, m.base ?? null, m.format ?? null, producer)
      }
    })
    tx()
  }

  measureList(): MeasureSpec[] {
    const rows = this.db.prepare('SELECT * FROM measures ORDER BY key').all() as Array<Record<string, any>>
    return rows.map(rowToMeasure)
  }

  measure(key: string): MeasureSpec | undefined {
    const row = this.db.prepare('SELECT * FROM measures WHERE key = ?').get(key) as Record<string, any> | undefined
    return row ? rowToMeasure(row) : undefined
  }

  /**
   * The breakdown engine: aggregate a measure, optionally grouped by a facet,
   * with session-scoped filters. The grain guard keeps SUM/AVG honest — a facet
   * is valid here only at the measure's grain or session-grain (the common
   * ancestor). Finer / sibling facets need the pre-reduction (cohort) path, not
   * built yet, and return an error rather than a silently double-counted number.
   */
  breakdown(
    measureKey: string,
    byFacetKey?: string,
    filters?: Record<string, string>,
  ): { rows: Array<{ bucket: string | null; value: number }>; total: number } | { error: string } {
    const m = this.measure(measureKey)
    if (!m) return { error: 'unknown measure' }
    const gm = grainOf(m.source)

    const from =
      gm === 'session'
        ? 'FROM sessions s'
        : gm === 'usage'
          ? 'FROM usage_facts u JOIN sessions s ON s.id = u.session_id'
          : 'FROM tool_calls t JOIN sessions s ON s.id = t.session_id'

    const where: string[] = []
    const params: unknown[] = []
    if (m.base) where.push(m.base)
    for (const [k, v] of Object.entries(filters ?? {})) {
      if (!v) continue
      const spec = this.facet(k)
      if (!spec) continue
      const p = this.facetPredicate(spec, v)
      where.push(p.sql)
      params.push(...p.params)
    }

    let groupExpr: string | null = null
    let facetJoin = ''
    if (byFacetKey) {
      const f = this.facet(byFacetKey)
      if (!f) return { error: 'unknown facet' }
      const gf = grainOf(f.source)
      if (gf !== gm && gf !== 'session') return { error: 'incompatible grain' }
      const fg = facetGroupExpr(f)
      groupExpr = fg.expr
      facetJoin = fg.join
      if (fg.where) where.push(fg.where)
    }

    const agg = aggExpr(m)
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    if (groupExpr) {
      const sql = `SELECT ${groupExpr} AS bucket, ${agg} AS value ${from} ${facetJoin} ${whereSql}
                   GROUP BY bucket ORDER BY value DESC LIMIT 50`
      const rows = this.db.prepare(sql).all(...params) as Array<{ bucket: string | null; value: number }>
      return { rows, total: rows.reduce((a, r) => a + (r.value ?? 0), 0) }
    }
    const sql = `SELECT ${agg} AS value ${from} ${whereSql}`
    const r = this.db.prepare(sql).get(...params) as { value: number } | undefined
    return { rows: [{ bucket: null, value: r?.value ?? 0 }], total: r?.value ?? 0 }
  }

  /** Filtered session list. Filter VALUES are bound params; keys are hardcoded. */
  sessionList(f: SessionFilter): SessionListItem[] {
    const scalar = (key: string) =>
      `(SELECT json_extract(value,'$') FROM annotations WHERE session_id=s.id AND key='${key}')`
    const clauses: string[] = []
    const params: unknown[] = []
    // Generic facet filters: every registered facet compiles to a session-scoped
    // predicate via one compiler. Unknown keys are ignored (only the registry
    // produces SQL), so the API can pass query params through blindly.
    for (const [key, value] of Object.entries(f.facets ?? {})) {
      if (!value) continue
      const spec = this.facet(key)
      if (!spec) continue
      const p = this.facetPredicate(spec, value)
      clauses.push(p.sql)
      params.push(...p.params)
    }
    if (f.q) {
      clauses.push(`(s.title LIKE ? OR ${scalar('intent_summary')} LIKE ?)`)
      params.push(`%${f.q}%`, `%${f.q}%`)
    }
    if (f.artifact || f.artifactKind) {
      const conds: string[] = []
      if (f.artifactKind) {
        conds.push('a3.kind = ?')
        params.push(f.artifactKind)
      }
      if (f.artifact) {
        conds.push('(a3.ident LIKE ? OR a3.title LIKE ? OR a3.external_id LIKE ? OR a3.repo LIKE ?)')
        const like = `%${f.artifact}%`
        params.push(like, like, like, like)
      }
      clauses.push(
        `EXISTS (SELECT 1 FROM session_artifacts sa3 JOIN artifacts a3 ON a3.id = sa3.artifact_id
                 WHERE sa3.session_id = s.id AND ${conds.join(' AND ')})`,
      )
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
    const limit = Math.min(Math.max(1, f.limit ?? 200), 1000)

    const rows = this.db
      .prepare(
        `SELECT s.id AS id, COALESCE(s.title,'(untitled)') AS title, s.started_at AS startedAt,
                s.cost_usd AS costUsd, s.models AS modelsJson,
                ${scalar('success')} AS success, ${scalar('complexity')} AS complexity,
                (SELECT value FROM annotations WHERE session_id=s.id AND key='use_case') AS useCaseJson,
                ${scalar('intent_summary')} AS intent,
                (SELECT COUNT(*) FROM outcomes WHERE session_id=s.id AND type='pr_merged') AS prMerged
         FROM sessions s ${where} ORDER BY s.started_at DESC LIMIT ${limit}`,
      )
      .all(...params) as Array<Record<string, any>>

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      startedAt: r.startedAt,
      costUsd: r.costUsd ?? 0,
      models: safeJson(r.modelsJson, []),
      success: r.success ?? null,
      complexity: r.complexity ?? null,
      useCase: safeJson(r.useCaseJson, []),
      intent: r.intent ?? null,
      prMerged: r.prMerged ?? 0,
    }))
  }

  /** Full detail for one session, including a viewer-ready transcript from the blob. */
  sessionDetail(id: string): SessionDetail | null {
    const s = this.db
      .prepare(
        `SELECT id, title, source, provider, repo, branch, started_at AS startedAt, ended_at AS endedAt,
                n_turns AS nTurns, n_tool_calls AS nToolCalls, models AS modelsJson, cost_usd AS costUsd,
                tok_input AS tokInput, tok_output AS tokOutput, tok_cache_create AS tokCacheCreate, tok_cache_read AS tokCacheRead
         FROM sessions WHERE id = ?`,
      )
      .get(id) as Record<string, any> | undefined
    if (!s) return null

    const annRows = this.db.prepare('SELECT key, value FROM annotations WHERE session_id = ?').all(id) as Array<{
      key: string
      value: string
    }>
    const annotations: Record<string, unknown> = {}
    for (const a of annRows) annotations[a.key] = safeJson(a.value, null)

    const outcomes = this.db
      .prepare('SELECT type, artifact_id AS artifactId FROM outcomes WHERE session_id = ?')
      .all(id) as Array<{ type: string; artifactId: string | null }>

    const artifacts = this.db
      .prepare(
        `SELECT a.kind, a.title, a.ident, a.status, a.repo, a.external_id AS externalId, sa.role, sa.source
         FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id WHERE sa.session_id = ?`,
      )
      .all(id) as Array<Record<string, any>>

    let transcript: TranscriptTurn[] = []
    const blob = this.db.prepare('SELECT gz FROM session_blobs WHERE id = ?').get(id) as { gz: Buffer } | undefined
    if (blob?.gz) {
      try {
        transcript = buildTranscript(JSON.parse(gunzipSync(blob.gz).toString('utf8')) as Session)
      } catch {
        /* leave empty */
      }
    }

    return {
      session: {
        id: s.id,
        title: s.title,
        source: s.source,
        provider: s.provider,
        repo: s.repo,
        branch: s.branch,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        nTurns: s.nTurns,
        nToolCalls: s.nToolCalls,
        models: safeJson(s.modelsJson, []),
        costUsd: s.costUsd ?? 0,
        tokens: {
          input: s.tokInput ?? 0,
          output: s.tokOutput ?? 0,
          cacheCreate: s.tokCacheCreate ?? 0,
          cacheRead: s.tokCacheRead ?? 0,
        },
      },
      annotations,
      outcomes,
      artifacts,
      transcript,
    }
  }

  /**
   * Shippable artifacts (PRs + features) with session count and fully-loaded
   * cost. Cost sums the UNIQUE sessions linked to each artifact; a session
   * spanning several artifacts is counted in each, so the column can exceed
   * total spend (per-artifact attribution, by design).
   */
  artifactList(kind?: string): ArtifactListItem[] {
    const allowed = ['pr', 'feature', 'ticket']
    const kinds = kind && allowed.includes(kind) ? [kind] : ['pr', 'feature']
    const placeholders = kinds.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT a.id, a.kind, a.title, a.ident, a.repo, a.status, a.source,
                a.external_id AS externalId, a.completed_at AS completedAt,
                a.parent_artifact_id AS parentId,
                COUNT(DISTINCT sa.session_id) AS sessions,
                COALESCE((
                  SELECT SUM(c) FROM (
                    SELECT DISTINCT s.id, s.cost_usd AS c
                    FROM session_artifacts sa2 JOIN sessions s ON s.id = sa2.session_id
                    WHERE sa2.artifact_id = a.id
                  )
                ), 0) AS costUsd
         FROM artifacts a
         LEFT JOIN session_artifacts sa ON sa.artifact_id = a.id
         WHERE a.kind IN (${placeholders})
         GROUP BY a.id
         HAVING (COUNT(DISTINCT sa.session_id) > 0 OR COALESCE(a.source,'') = 'user')
         ORDER BY costUsd DESC, sessions DESC`,
      )
      .all(...kinds) as ArtifactListItem[]
  }

  // ---- feature management (dashboard writes) --------------------------------

  /** Create a user-authored feature (source='user' — never clobbered by analyze). */
  createFeature(title: string, parentId?: string): { id: string } {
    const id = `feature:user:${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, title, source, created_at, parent_artifact_id)
         VALUES (?, 'feature', ?, 'user', ?, ?)`,
      )
      .run(id, title, new Date().toISOString(), parentId ?? null)
    return { id }
  }

  /** Mark complete/reopen, rename, or reparent a feature. */
  updateFeature(id: string, patch: { completed?: boolean; parentId?: string | null; title?: string }): boolean {
    const exists = this.db.prepare("SELECT 1 FROM artifacts WHERE id = ? AND kind = 'feature'").get(id)
    if (!exists) return false
    if (patch.completed !== undefined) {
      if (patch.completed) {
        this.db.prepare("UPDATE artifacts SET completed_at = ?, status = 'shipped' WHERE id = ?").run(new Date().toISOString(), id)
      } else {
        this.db.prepare('UPDATE artifacts SET completed_at = NULL, status = NULL WHERE id = ?').run(id)
      }
    }
    if (patch.parentId !== undefined && patch.parentId !== id) {
      this.db.prepare('UPDATE artifacts SET parent_artifact_id = ? WHERE id = ?').run(patch.parentId ?? null, id)
    }
    if (patch.title !== undefined && patch.title.trim()) {
      this.db.prepare('UPDATE artifacts SET title = ? WHERE id = ?').run(patch.title.trim(), id)
    }
    return true
  }

  /** Delete a feature; promote its children to its parent and remove its links. */
  deleteFeature(id: string): boolean {
    const row = this.db.prepare("SELECT parent_artifact_id AS p FROM artifacts WHERE id = ? AND kind = 'feature'").get(id) as
      | { p: string | null }
      | undefined
    if (!row) return false
    this.db.transaction(() => {
      this.db.prepare('UPDATE artifacts SET parent_artifact_id = ? WHERE parent_artifact_id = ?').run(row.p ?? null, id)
      this.db.prepare('DELETE FROM session_artifacts WHERE artifact_id = ?').run(id)
      this.db.prepare('DELETE FROM artifact_links WHERE from_id = ? OR to_id = ?').run(id, id)
      this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id)
    })()
    return true
  }

  /**
   * Delete machine-derived artifacts no longer referenced by any session or
   * link (e.g. PRs whose false-positive links were removed on re-derivation).
   * Never touches user-authored artifacts.
   */
  pruneOrphanArtifacts(): number {
    const r = this.db
      .prepare(
        `DELETE FROM artifacts
         WHERE COALESCE(source,'') <> 'user'
           AND id NOT IN (SELECT artifact_id FROM session_artifacts)
           AND id NOT IN (SELECT from_id FROM artifact_links)
           AND id NOT IN (SELECT to_id FROM artifact_links)`,
      )
      .run()
    return r.changes
  }

  close() {
    this.db.close()
  }
}

export interface ArtifactListItem {
  id: string
  kind: string
  title: string | null
  ident: string | null
  repo: string | null
  status: string | null
  source: string | null
  externalId: string | null
  completedAt: string | null
  parentId: string | null
  sessions: number
  costUsd: number
}

export type Bucket = 'day' | 'week' | 'month'

export interface TimePoint {
  bucket: string
  sessions: number
  spend: number
  shipped: number
}

export interface SessionFilter {
  /** facetKey -> value; compiled to predicates via the facet registry. */
  facets?: Record<string, string>
  q?: string
  /** Match sessions linked to an artifact whose path/PR/url/repo/feature-title matches. */
  artifact?: string
  /** Restrict the artifact match to a kind: file | pr | feature | ticket | commit. */
  artifactKind?: string
  limit?: number
}

export interface SessionListItem {
  id: string
  title: string
  startedAt: string | null
  costUsd: number
  models: string[]
  success: string | null
  complexity: string | null
  useCase: string[]
  intent: string | null
  prMerged: number
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system'
  ts?: string
  sidechain: boolean
  text: string
  tools: Array<{ name: string; action: string; ok: boolean; target?: string }>
}

export interface SessionDetail {
  session: Record<string, unknown>
  annotations: Record<string, unknown>
  outcomes: Array<{ type: string; artifactId: string | null }>
  artifacts: Array<Record<string, unknown>>
  transcript: TranscriptTurn[]
}

function bucketExpr(col: string, bucket: Bucket): string {
  if (bucket === 'day') return `date(${col})`
  if (bucket === 'month') return `strftime('%Y-%m', ${col})`
  return `strftime('%Y-W%W', ${col})`
}

function safeJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function rowToFacet(r: Record<string, any>): FacetSpec {
  return {
    key: r.key,
    label: r.label ?? undefined,
    type: r.type,
    source: r.source,
    column: r.col ?? undefined,
    base: r.base ?? undefined,
    multi: !!r.multi,
    roles: safeJson(r.roles, [] as FacetSpec['roles']),
  }
}

function rowToMeasure(r: Record<string, any>): MeasureSpec {
  return {
    key: r.key,
    label: r.label ?? undefined,
    source: r.source,
    expr: r.expr,
    agg: r.agg,
    base: r.base ?? undefined,
    format: r.format ?? undefined,
  }
}

function aggExpr(m: MeasureSpec): string {
  switch (m.agg) {
    case 'sum':
      return `SUM(${m.expr})`
    case 'avg':
      return `AVG(${m.expr})`
    case 'count':
      return 'COUNT(*)'
    case 'count_distinct':
      return `COUNT(DISTINCT ${m.expr})`
    case 'rate':
      return `AVG(CASE WHEN ${m.expr} THEN 1.0 ELSE 0.0 END)`
  }
}

/** Group expression + any join/where a facet contributes to a breakdown (alias `s`/`u`/`t`). */
function facetGroupExpr(f: FacetSpec): { join: string; expr: string; where?: string } {
  const col = f.column ?? f.key
  if (f.source === 'session') {
    return f.multi
      ? { join: `, json_each(s.${col}) fje`, expr: 'fje.value' }
      : { join: '', expr: `s.${col}` }
  }
  if (f.source === 'annotation') {
    return f.multi
      ? {
          join: `JOIN annotations fa ON fa.session_id = s.id AND fa.key = '${f.key}' JOIN json_each(fa.value) fje`,
          expr: 'fje.value',
        }
      : {
          join: `JOIN annotations fa ON fa.session_id = s.id AND fa.key = '${f.key}'`,
          expr: `json_extract(fa.value,'$')`,
        }
  }
  // same-grain child facet (usage / tool-call): a column on the measure's own anchor
  return { join: '', expr: `${aliasFor(grainOf(f.source))}.${col}`, where: f.base }
}

function buildTranscript(session: Session): TranscriptTurn[] {
  const okById = new Map(session.toolCalls.map((t) => [t.id, t.result.ok]))
  const turns: TranscriptTurn[] = []
  for (const ev of session.events) {
    if (ev.kind === 'assistant') {
      let text = ''
      const tools: TranscriptTurn['tools'] = []
      for (const b of ev.blocks) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text
        else if (b.type === 'tool_use') {
          const input = b.input as { file_path?: string; command?: string; path?: string } | undefined
          const target = input?.file_path ?? input?.path ?? input?.command
          tools.push({ name: b.name, action: '', ok: okById.get(b.id) ?? true, target: clip(target, 140) })
        }
      }
      if (!text && tools.length === 0) continue
      turns.push({ role: 'assistant', ts: ev.ts, sidechain: ev.isSidechain, text: clip(text, 6000), tools })
    } else if (ev.kind === 'user') {
      const text = ev.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim()
      if (!text) continue
      turns.push({ role: 'user', ts: ev.ts, sidechain: ev.isSidechain, text: clip(text, 6000), tools: [] })
    }
  }
  return turns
}

function clip(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + ' …' : s
}
