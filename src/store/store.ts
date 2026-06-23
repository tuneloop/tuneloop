import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Session } from '../core/model'
import type { ProcessorResult } from '../core/processor'
import type { DB } from './db'
import { grainOf } from '../core/facets'
import type { FacetSpec, FacetType } from '../core/facets'
import { aliasFor } from '../core/measures'
import type { MeasureSpec } from '../core/measures'
import { isSyntheticUser } from '../core/turns'
import type { FeatureRevisionInput, ProcessorRunRow, UsageFactInput } from './types'

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
        if (a.kind === 'feature') {
          // Features are shared, evolving rows: a re-derive that re-proposes the
          // same feature must NOT wipe completion/status/owner a user set on the
          // dashboard, and must never clobber a user-authored feature at all.
          // Upsert title + parent (parent only when a fresh one is supplied) and
          // leave everything else intact; the WHERE guard skips user features.
          this.db
            .prepare(
              `INSERT INTO artifacts
                 (id, kind, repo, source, title, created_at, parent_artifact_id, producer)
               VALUES (?, 'feature', ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 repo = COALESCE(artifacts.repo, excluded.repo),
                 parent_artifact_id = COALESCE(excluded.parent_artifact_id, artifacts.parent_artifact_id),
                 producer = excluded.producer
               WHERE COALESCE(artifacts.source, '') <> 'user'`,
            )
            .run(a.id, a.repo ?? null, a.source ?? null, a.title ?? null, a.createdAt ?? null, a.parentArtifactId ?? null, processor)
          continue
        }
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
      this.applyFeatureRevisions(result.featureRevisions ?? [])
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

  /**
   * Apply an enrichment processor's hierarchy edits: REPARENT existing features.
   * (Auto-rename is intentionally unsupported — see FeatureRevisionInput.) Skips
   * user-authored features (locked) and any reparent that would form a cycle or
   * self-parent. Caller runs this inside a transaction.
   */
  private applyFeatureRevisions(revisions: FeatureRevisionInput[]) {
    for (const rev of revisions) {
      if (rev.parentId === undefined) continue
      const row = this.db
        .prepare("SELECT source FROM artifacts WHERE id = ? AND kind = 'feature'")
        .get(rev.id) as { source: string | null } | undefined
      if (!row || row.source === 'user') continue
      const parent = rev.parentId
      if (parent !== rev.id && !this.wouldCreateFeatureCycle(rev.id, parent)) {
        this.db.prepare('UPDATE artifacts SET parent_artifact_id = ? WHERE id = ?').run(parent ?? null, rev.id)
      }
    }
  }

  /** True if parenting `id` under `newParentId` would create a cycle (walks ancestors). */
  private wouldCreateFeatureCycle(id: string, newParentId: string | null): boolean {
    let cur = newParentId
    const seen = new Set<string>()
    while (cur) {
      if (cur === id || seen.has(cur)) return true
      seen.add(cur)
      const r = this.db.prepare('SELECT parent_artifact_id AS p FROM artifacts WHERE id = ?').get(cur) as
        | { p: string | null }
        | undefined
      cur = r?.p ?? null
    }
    return false
  }

  /**
   * The WHOLE feature hierarchy — what an enrichment processor needs to attach a
   * session to the most specific feature, slot a new feature under the right
   * parent, and refine the tree. The hierarchy is global and human-managed (a
   * single epic may span repos), so the processor sees everything; repo isolation
   * is enforced only on auto-derived *linkage* (see `repos`). `source` flags
   * user-authored features so the processor leaves them locked.
   *
   * `repos` = repos associated anywhere in a feature's subtree (itself + every
   * descendant), unioned from linked sessions and any explicit `repo` column.
   * Empty = unscoped/global. A feature is a safe auto-link target for a session
   * iff its `repos` is empty or already contains the session's repo.
   */
  listFeatures(): Array<{ id: string; title: string; parentId: string | null; source: string | null; repos: string[] }> {
    const repoSets = this.featureRepoSets()
    const rows = this.db
      .prepare("SELECT id, COALESCE(title, '') AS title, parent_artifact_id AS parentId, source FROM artifacts WHERE kind = 'feature'")
      .all() as Array<{ id: string; title: string; parentId: string | null; source: string | null }>
    return rows.map((r) => ({ ...r, repos: repoSets.get(r.id) ?? [] }))
  }

  /**
   * Per-feature subtree repo set: the repos associated anywhere in a feature's
   * subtree (itself + every descendant), unioned from each feature's explicit
   * `repo` column and the repos of sessions linked to it. Shared by feature
   * extraction (linkage isolation) and the dashboard (the Features repo column).
   */
  private featureRepoSets(): Map<string, string[]> {
    const rows = this.db
      .prepare("SELECT id, parent_artifact_id AS parentId, repo FROM artifacts WHERE kind = 'feature'")
      .all() as Array<{ id: string; parentId: string | null; repo: string | null }>

    const own = new Map<string, Set<string>>()
    const addRepo = (id: string, repo: string | null) => {
      if (!repo) return
      let set = own.get(id)
      if (!set) own.set(id, (set = new Set()))
      set.add(repo)
    }
    for (const r of rows) addRepo(r.id, r.repo)
    const links = this.db
      .prepare(
        `SELECT sa.artifact_id AS id, s.repo AS repo
         FROM session_artifacts sa JOIN sessions s ON s.id = sa.session_id
         JOIN artifacts a ON a.id = sa.artifact_id
         WHERE a.kind = 'feature' AND s.repo IS NOT NULL AND s.repo <> ''`,
      )
      .all() as Array<{ id: string; repo: string }>
    for (const l of links) addRepo(l.id, l.repo)

    const children = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.parentId) continue
      const arr = children.get(r.parentId)
      if (arr) arr.push(r.id)
      else children.set(r.parentId, [r.id])
    }
    const memo = new Map<string, Set<string>>()
    const onStack = new Set<string>()
    const subtreeRepos = (id: string): Set<string> => {
      const cached = memo.get(id)
      if (cached) return cached
      const acc = new Set<string>(own.get(id) ?? [])
      if (!onStack.has(id)) {
        onStack.add(id)
        for (const c of children.get(id) ?? []) for (const rp of subtreeRepos(c)) acc.add(rp)
        onStack.delete(id)
      }
      memo.set(id, acc)
      return acc
    }
    const out = new Map<string, string[]>()
    for (const r of rows) out.set(r.id, [...subtreeRepos(r.id)].sort())
    return out
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

  /**
   * The headline KPI row for one time window. Session-grain metrics (count,
   * spend, success rate) window by session start; cost-per-artifact windows by
   * completion (see costPerArtifact). The API calls this twice — current and the
   * same-length prior period — to derive deltas. No window = all time.
   */
  kpis(from?: string, to?: string, outcomes?: string[]): KpiSnapshot {
    const range = from && to ? 'WHERE s.started_at >= ? AND s.started_at < ?' : ''
    const params = from && to ? [from, to] : []
    // Which outcome types count as success (the UI's editable definition).
    // Empty → the default. The placeholders sit in the SELECT subquery, so their
    // params bind before the WHERE range params (see successRate's same note).
    const oc = outcomes && outcomes.length ? outcomes : ['session_success']
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(s.cost_usd),0) AS totalSpend,
                AVG(CASE WHEN EXISTS (
                      SELECT 1 FROM outcomes o
                      WHERE o.session_id = s.id AND o.type IN (${oc.map(() => '?').join(',')})
                    ) THEN 1.0 ELSE 0.0 END) AS successRate
         FROM sessions s ${range}`,
      )
      .get(...oc, ...params) as { sessions: number; totalSpend: number; successRate: number | null }
    // Tool-call error rate over the same session-start window (tool calls join up
    // to their session for the time basis, consistent with the other KPIs).
    const tc = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(t.is_error),0) AS errs
         FROM tool_calls t JOIN sessions s ON s.id = t.session_id ${range}`,
      )
      .get(...params) as { calls: number; errs: number }
    return {
      sessions: agg.sessions,
      totalSpend: agg.totalSpend,
      // Null (not 0) when the window has no sessions, so the UI shows "—" not "0%".
      successRate: agg.sessions ? (agg.successRate ?? 0) : null,
      errorRate: tc.calls ? tc.errs / tc.calls : null,
      costPerFeature: this.costPerArtifact('feature', from, to),
      costPerPr: this.costPerArtifact('pr', from, to),
    }
  }

  /**
   * The two decomposition curves for the cost-per-artifact section
   * (cost_per_shipped_artifact.md). Both are PURE SUMS (0 is a real value, no
   * attribution): burn = AI spend per bucket dated at SESSION time (with a
   * `shippedSpend` sub-band = spend of sessions linked to a completed `kind`
   * artifact — the gap to `spend` is in-flight/never-shipped spend); throughput
   * = count of `kind` artifacts per bucket dated at COMPLETION. Both honor the
   * optional window (burn by session start, throughput by completion); no window
   * = full history. The `bucket` granularity is the caller's (day/week/month).
   */
  costCurves(
    kind: string,
    bucket: Bucket,
    from?: string,
    to?: string,
  ): {
    burn: Array<{ bucket: string; spend: number; shippedSpend: number }>
    throughput: Array<{ bucket: string; count: number }>
    buckets: string[]
  } {
    // kind binds first (it sits in the SELECT subquery), then the window params.
    const burnRange = from && to ? 'AND s.started_at >= ? AND s.started_at < ?' : ''
    const burnParams = from && to ? [kind, from, to] : [kind]
    const burn = this.db
      .prepare(
        `SELECT ${bucketExpr('s.started_at', bucket)} AS bucket,
                COALESCE(SUM(s.cost_usd),0) AS spend,
                COALESCE(SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id
                    WHERE sa.session_id = s.id AND a.kind = ? AND a.completed_at IS NOT NULL
                  ) THEN s.cost_usd ELSE 0 END),0) AS shippedSpend
         FROM sessions s WHERE s.started_at IS NOT NULL ${burnRange}
         GROUP BY bucket ORDER BY bucket`,
      )
      .all(...burnParams) as Array<{ bucket: string; spend: number; shippedSpend: number }>
    const thRange = from && to ? 'AND completed_at >= ? AND completed_at < ?' : ''
    const thParams = from && to ? [kind, from, to] : [kind]
    const throughput = this.db
      .prepare(
        `SELECT ${bucketExpr('completed_at', bucket)} AS bucket, COUNT(*) AS count
         FROM artifacts WHERE kind = ? AND completed_at IS NOT NULL ${thRange} GROUP BY bucket ORDER BY bucket`,
      )
      .all(...thParams) as Array<{ bucket: string; count: number }>
    // The x-axis: over a window, every bucket from `from` to `to` (so empty
    // periods show as gaps and the chart spans the whole window, not just the
    // periods that happen to have data); all-time falls back to the data's own
    // buckets. The series rows stay sparse — the chart zero-fills missing axis
    // buckets — and we still union in any data bucket as a safety net.
    const set = new Set<string>()
    if (from && to) this.bucketAxis(from, to, bucket).forEach((b) => set.add(b))
    burn.forEach((r) => set.add(r.bucket))
    throughput.forEach((r) => set.add(r.bucket))
    return { burn, throughput, buckets: Array.from(set).sort() }
  }

  /**
   * The complete ordered list of bucket labels spanning [from, to] at the given
   * granularity. Walks one calendar day at a time in SQL and buckets each with
   * the same expression as the data, so the labels match exactly (no JS attempt
   * to reproduce SQLite's %W week numbering). Used to give the cost curves a
   * continuous x-axis across the window.
   */
  private bucketAxis(from: string, to: string, bucket: Bucket): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE days(d) AS (
           SELECT date(?)
           UNION ALL
           SELECT date(d, '+1 day') FROM days WHERE d < date(?)
         )
         SELECT DISTINCT ${bucketExpr('d', bucket)} AS bucket FROM days ORDER BY bucket`,
      )
      .all(from, to) as Array<{ bucket: string }>
    return rows.map((r) => r.bucket)
  }

  /**
   * The x-axis for a windowed time series: every bucket from `from` to `to`
   * (so the chart spans the whole window and empty periods show as gaps),
   * unioned with the data's own buckets as a safety net. No window → the data's
   * buckets as-is (all-time). Shared by the dashboard time-series endpoints.
   */
  private fullAxis(dataBuckets: string[], bucket: Bucket, from?: string, to?: string): string[] {
    if (!(from && to)) return dataBuckets
    const set = new Set<string>(this.bucketAxis(from, to, bucket))
    dataBuckets.forEach((b) => set.add(b))
    return Array.from(set).sort()
  }

  /**
   * The "burn efficiency" lens for a window: Σ session spend in the window ÷
   * count of `kind` artifacts completed in the window. Deliberately distinct
   * from the unit-cost KPI (whose numerator includes pre-window spend) — the doc
   * insists both be shown so dividing the curves doesn't read as a contradiction.
   * `throughput` here equals the KPI denominator exactly. No window = all time.
   */
  costPeriod(kind: string, from?: string, to?: string): { burn: number; throughput: number; efficiency: number | null } {
    const burnRange = from && to ? 'WHERE started_at >= ? AND started_at < ?' : 'WHERE started_at IS NOT NULL'
    const burnParams = from && to ? [from, to] : []
    const burn = (
      this.db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM sessions ${burnRange}`).get(...burnParams) as {
        s: number
      }
    ).s
    const thRange = from && to ? 'AND completed_at >= ? AND completed_at < ?' : ''
    const thParams = from && to ? [kind, from, to] : [kind]
    const throughput = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE kind = ? AND completed_at IS NOT NULL ${thRange}`)
        .get(...thParams) as { n: number }
    ).n
    return { burn, throughput, efficiency: throughput ? burn / throughput : null }
  }

  /**
   * Spend over time, optionally split into one series per facet value — the doc's
   * non-headline "total spend breakdown" / burn view (cost_per_shipped_artifact.md
   * §Separate). Anchored on usage_facts so cost-by-model splits HONESTLY (each
   * usage row attributed to its own model), not by charging a multi-model
   * session's whole cost to each model. Spend is dated at session start (matching
   * the burn curve). Only usage/session-grain facets are valid (the cost measure's
   * grain guard); tool-call facets (skill) are rejected. Multi-valued facets
   * (use_case) presence-inflate — flagged via `presenceInflated`.
   */
  spendOverTime(q: SpendOverTimeQuery): SpendOverTimeResult | { error: string } {
    const bucket = q.bucket
    const topK = q.topK ?? 6
    const time = bucketExpr('s.started_at', bucket)

    const where: string[] = ['s.started_at IS NOT NULL']
    const params: unknown[] = []
    if (q.from && q.to) {
      where.push('s.started_at >= ? AND s.started_at < ?')
      params.push(q.from, q.to)
    }
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (!v) continue
      const spec = this.facet(k)
      if (!spec) continue
      const p = this.facetPredicate(spec, v)
      where.push(p.sql)
      params.push(...p.params)
    }
    const fromSql = 'FROM usage_facts u JOIN sessions s ON s.id = u.session_id'
    const whereSql = 'WHERE ' + where.join(' AND ')

    const overallRows = this.db
      .prepare(`SELECT ${time} AS tb, SUM(u.cost_usd) AS spend ${fromSql} ${whereSql} GROUP BY tb ORDER BY tb`)
      .all(...params) as Array<{ tb: string; spend: number }>
    const overallPoints = overallRows.map((r) => ({ bucket: r.tb, spend: r.spend }))
    const overall = { points: overallPoints, total: overallPoints.reduce((a, p) => a + p.spend, 0) }

    let series: SpendSeries[] | undefined
    let truncated: { shown: number; total: number } | undefined
    let presenceInflated: boolean | undefined
    if (q.by) {
      const f = this.facet(q.by)
      if (!f) return { error: 'unknown facet' }
      const gf = grainOf(f.source)
      if (gf !== 'usage' && gf !== 'session') return { error: 'incompatible grain' }
      const fg = facetGroupExpr(f)
      const sql = `SELECT ${time} AS tb, ${fg.expr} AS val, SUM(u.cost_usd) AS spend
                   ${fromSql} ${fg.join} ${whereSql}${fg.where ? ' AND ' + fg.where : ''}
                   GROUP BY tb, val`
      const rows = this.db.prepare(sql).all(...params) as Array<{ tb: string; val: string | null; spend: number }>
      const byVal = new Map<string, SpendPoint[]>()
      for (const r of rows) {
        if (r.val == null) continue
        const arr = byVal.get(String(r.val)) ?? []
        arr.push({ bucket: r.tb, spend: r.spend })
        byVal.set(String(r.val), arr)
      }
      let all: SpendSeries[] = Array.from(byVal.entries()).map(([key, points]) => ({
        key,
        points,
        total: points.reduce((a, p) => a + p.spend, 0),
      }))
      all.sort((a, b) => b.total - a.total)
      if (all.length > topK) {
        truncated = { shown: topK, total: all.length }
        all = all.slice(0, topK)
      }
      series = all
      presenceInflated = !!f.multi
    }

    return { bucket, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated, presenceInflated }
  }

  /**
   * Session COUNT over time, optionally split into one series per facet value —
   * the time-series form of the distribution cards. Counts explode safely, so
   * (unlike spendOverTime) ANY facet works: each value adds a session-scoped
   * predicate (via the facet compiler) to a COUNT over sessions, so "sessions
   * that used model X / skill Y" is well-defined and multi-per-session facets
   * (model, skill, use_case) overlap across series (`presenceInflated`).
   */
  sessionsOverTime(q: SessionsOverTimeQuery): SessionsOverTimeResult {
    const bucket = q.bucket
    const topK = q.topK ?? 6
    const time = bucketExpr('s.started_at', bucket)

    const baseWhere: string[] = ['s.started_at IS NOT NULL']
    const baseParams: unknown[] = []
    if (q.from && q.to) {
      baseWhere.push('s.started_at >= ? AND s.started_at < ?')
      baseParams.push(q.from, q.to)
    }
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (!v) continue
      const spec = this.facet(k)
      if (!spec) continue
      const p = this.facetPredicate(spec, v)
      baseWhere.push(p.sql)
      baseParams.push(...p.params)
    }

    const runBuckets = (extraSql: string, extraParams: unknown[]): CountPoint[] => {
      const where = [...baseWhere]
      const params = [...baseParams]
      if (extraSql) {
        where.push(extraSql)
        params.push(...extraParams)
      }
      const rows = this.db
        .prepare(`SELECT ${time} AS tb, COUNT(*) AS cnt FROM sessions s WHERE ${where.join(' AND ')} GROUP BY tb ORDER BY tb`)
        .all(...params) as Array<{ tb: string; cnt: number }>
      return rows.map((r) => ({ bucket: r.tb, count: r.cnt }))
    }
    const totals = (pts: CountPoint[]) => pts.reduce((a, p) => a + p.count, 0)

    const overallPoints = runBuckets('', [])
    const overall = { points: overallPoints, total: totals(overallPoints) }

    let series: CountSeries[] | undefined
    let truncated: { shown: number; total: number } | undefined
    let presenceInflated: boolean | undefined
    if (q.by) {
      const f = this.facet(q.by)
      if (f) {
        const values = this.facetDistribution(q.by)
          .map((d) => d.value)
          .filter((v) => v != null)
        const shown = values.slice(0, topK)
        if (values.length > shown.length) truncated = { shown: shown.length, total: values.length }
        series = shown.map((v) => {
          const p = this.facetPredicate(f, String(v))
          const pts = runBuckets(p.sql, p.params)
          return { key: String(v), points: pts, total: totals(pts) }
        })
        // A session can fall under several values when the facet is multi-valued
        // or lives at a child grain (model/skill) → series sum past overall.
        presenceInflated = !!f.multi || grainOf(f.source) !== 'session'
      }
    }

    return { bucket, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated, presenceInflated }
  }

  /**
   * Operational tool-call metrics over time. One anchor (tool_calls t JOIN
   * sessions s, dated at session start); the `view` selects what to plot:
   * tool_calls = COUNT(*), error_rate = SUM(is_error)/COUNT(*), skill_usage =
   * COUNT(*) WHERE action='skill'. `by:'name'` splits by tool_calls.name (tool
   * name in general; skill name when skills-only), ranked top-K by call volume.
   */
  opsOverTime(q: OpsOverTimeQuery): OpsOverTimeResult {
    const bucket = q.bucket
    const topK = q.topK ?? 6
    const isRate = q.view === 'error_rate'
    const time = bucketExpr('s.started_at', bucket)

    const where: string[] = ['s.started_at IS NOT NULL']
    const params: unknown[] = []
    if (q.view === 'skill_usage') where.push("t.action = 'skill'")
    if (q.from && q.to) {
      where.push('s.started_at >= ? AND s.started_at < ?')
      params.push(q.from, q.to)
    }
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (!v) continue
      const spec = this.facet(k)
      if (!spec) continue
      const p = this.facetPredicate(spec, v)
      where.push(p.sql)
      params.push(...p.params)
    }
    const fromSql = 'FROM tool_calls t JOIN sessions s ON s.id = t.session_id'
    const whereSql = 'WHERE ' + where.join(' AND ')
    const val = (cnt: number, errs: number) => (isRate ? (cnt ? errs / cnt : null) : cnt)

    const overallRows = this.db
      .prepare(`SELECT ${time} AS tb, COUNT(*) AS cnt, COALESCE(SUM(t.is_error),0) AS errs ${fromSql} ${whereSql} GROUP BY tb ORDER BY tb`)
      .all(...params) as Array<{ tb: string; cnt: number; errs: number }>
    const overallPoints: OpsPoint[] = overallRows.map((r) => ({
      bucket: r.tb,
      value: val(r.cnt, r.errs),
      calls: r.cnt,
      errors: r.errs,
    }))
    const tCnt = overallRows.reduce((a, r) => a + r.cnt, 0)
    const tErr = overallRows.reduce((a, r) => a + r.errs, 0)
    const overall = { points: overallPoints, total: val(tCnt, tErr) }

    let series: OpsSeries[] | undefined
    let truncated: { shown: number; total: number } | undefined
    if (q.by === 'name') {
      const rows = this.db
        .prepare(`SELECT ${time} AS tb, t.name AS nm, COUNT(*) AS cnt, COALESCE(SUM(t.is_error),0) AS errs ${fromSql} ${whereSql} GROUP BY tb, nm`)
        .all(...params) as Array<{ tb: string; nm: string | null; cnt: number; errs: number }>
      const byVal = new Map<string, { points: OpsPoint[]; cnt: number; errs: number }>()
      for (const r of rows) {
        if (r.nm == null) continue
        const e = byVal.get(r.nm) ?? { points: [], cnt: 0, errs: 0 }
        e.points.push({ bucket: r.tb, value: val(r.cnt, r.errs), calls: r.cnt, errors: r.errs })
        e.cnt += r.cnt
        e.errs += r.errs
        byVal.set(r.nm, e)
      }
      let all: OpsSeries[] = Array.from(byVal.entries()).map(([key, e]) => ({
        key,
        points: e.points,
        total: val(e.cnt, e.errs),
        calls: e.cnt,
      }))
      all.sort((a, b) => b.calls - a.calls) // rank by call volume — the tools that matter
      if (all.length > topK) {
        truncated = { shown: topK, total: all.length }
        all = all.slice(0, topK)
      }
      series = all
    }

    return { view: q.view, bucket, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated, format: isRate ? 'pct' : 'int' }
  }

  /**
   * Outcome types present in the data, with the count of distinct sessions that
   * produced each — feeds the success-rate "what counts as success" selector.
   * (A first-class outcome-type registry, parallel to facets/measures, is a
   * deferred follow-up; for now the selector reflects what's actually in the DB.)
   */
  outcomeTypes(): Array<{ type: string; sessions: number }> {
    return this.db
      .prepare(
        'SELECT type, COUNT(DISTINCT session_id) AS sessions FROM outcomes GROUP BY type ORDER BY sessions DESC',
      )
      .all() as Array<{ type: string; sessions: number }>
  }

  /**
   * Session Outcome Rate over time (headline_metrics.md): the fraction of
   * sessions — cohorted by START date — that produced any outcome in the
   * selected set. Numerator = sessions with an outcome in `outcomes`; denominator
   * = all sessions in the bucket. Session-level filters apply to BOTH (so the
   * rate is honest). With `by`, returns one series per facet value (top-K by
   * volume): each value adds a session-scoped predicate to numerator AND
   * denominator via the facet compiler, so multi-valued facets overlap
   * (any_match) and nothing fans out past session grain.
   */
  successRate(q: SuccessRateQuery): SuccessRateResult {
    const outcomes = q.outcomes.length ? q.outcomes : ['session_success']
    const bucket = q.bucket
    const topK = q.topK ?? 6
    const numPred = `EXISTS (SELECT 1 FROM outcomes o WHERE o.session_id = s.id AND o.type IN (${outcomes
      .map(() => '?')
      .join(',')}))`

    // Filter clauses shared by numerator and denominator (window + session facets).
    const filterClauses: string[] = []
    const filterParams: unknown[] = []
    if (q.from && q.to) {
      filterClauses.push('s.started_at >= ? AND s.started_at < ?')
      filterParams.push(q.from, q.to)
    }
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (!v) continue
      const spec = this.facet(k)
      if (!spec) continue
      const p = this.facetPredicate(spec, v)
      filterClauses.push(p.sql)
      filterParams.push(...p.params)
    }

    // Run the bucketed num/denom for the base population plus an optional extra
    // (per-series) predicate. Param order follows SQL text: numPred's outcome
    // params sit in the SELECT, so they bind before the WHERE params.
    const runBuckets = (extraSql: string, extraParams: unknown[]): RatePoint[] => {
      const where = ['s.started_at IS NOT NULL', ...filterClauses]
      const params: unknown[] = [...outcomes, ...filterParams]
      if (extraSql) {
        where.push(extraSql)
        params.push(...extraParams)
      }
      const sql = `SELECT ${bucketExpr('s.started_at', bucket)} AS bucket,
                          COUNT(*) AS denom,
                          SUM(CASE WHEN ${numPred} THEN 1 ELSE 0 END) AS num
                   FROM sessions s WHERE ${where.join(' AND ')}
                   GROUP BY bucket ORDER BY bucket`
      const rows = this.db.prepare(sql).all(...params) as Array<{ bucket: string; denom: number; num: number }>
      return rows.map((r) => ({ bucket: r.bucket, num: r.num, denom: r.denom, rate: r.denom ? r.num / r.denom : null }))
    }

    const totals = (points: RatePoint[]) => {
      const num = points.reduce((a, p) => a + p.num, 0)
      const denom = points.reduce((a, p) => a + p.denom, 0)
      return { num, denom, rate: denom ? num / denom : null }
    }

    const overallPoints = runBuckets('', [])
    const overall: RateSeries = { key: 'overall', points: overallPoints, ...totals(overallPoints) }

    let series: RateSeries[] | undefined
    let truncated: { shown: number; total: number } | undefined
    if (q.by) {
      const f = this.facet(q.by)
      if (f) {
        const values = this.facetDistribution(q.by)
          .map((d) => d.value)
          .filter((v) => v != null)
        const shown = values.slice(0, topK)
        if (values.length > shown.length) truncated = { shown: shown.length, total: values.length }
        series = shown.map((v) => {
          const p = this.facetPredicate(f, String(v))
          const pts = runBuckets(p.sql, p.params)
          return { key: String(v), points: pts, ...totals(pts) }
        })
      }
    }

    return { outcomes, bucket, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated }
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
    if (f.source === 'feature') {
      sql = `SELECT a.title AS value, COUNT(DISTINCT sa.session_id) AS count
             FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id
             WHERE a.kind = 'feature' AND a.title IS NOT NULL
             GROUP BY a.title ORDER BY count DESC`
    } else if (f.source === 'session') {
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
    if (f.source === 'feature') {
      // A session matches a feature cohort when it's directly linked (session_artifacts)
      // to a feature artifact of that title.
      return {
        sql: `EXISTS (SELECT 1 FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id
               WHERE sa.session_id = s.id AND a.kind = 'feature' AND a.title = ?)`,
        params: [value],
      }
    }
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
      // Search title + intent + the decisions list (matched against its raw JSON
      // text, which is enough to surface a decision by any word it contains).
      clauses.push(
        `(s.title LIKE ? OR ${scalar('intent_summary')} LIKE ?
          OR EXISTS (SELECT 1 FROM annotations WHERE session_id=s.id AND key='decisions' AND value LIKE ?))`,
      )
      params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`)
    }
    if (f.artifact || f.artifactKind) {
      const conds: string[] = []
      if (f.artifactKind) {
        conds.push('a3.kind = ?')
        params.push(f.artifactKind)
      }
      if (f.artifact) {
        const { sql: artSql, params: artParams } = this.artifactSearchCond(f.artifact, 'a3')
        conds.push(artSql)
        params.push(...artParams)
      }
      clauses.push(
        `EXISTS (SELECT 1 FROM session_artifacts sa3 JOIN artifacts a3 ON a3.id = sa3.artifact_id
                 WHERE sa3.session_id = s.id AND ${conds.join(' AND ')})`,
      )
    }
    if (f.bucket && f.bucketValue) {
      // Drill from a chart bucket: match the server's own bucket label so the
      // filtered sessions are exactly that bar's sessions (same timezone/bucketing).
      clauses.push(`${bucketExpr('s.started_at', f.bucket)} = ?`)
      params.push(f.bucketValue)
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

    let transcript: Transcript = { turns: [], subagents: [] }
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
      facets: this.facetValues(id),
      transcript,
    }
  }

  /**
   * The session's value for every facet flagged for the `detail` role — the
   * registry-driven metadata list the drawer renders. Keeps the drawer from
   * hardcoding which dimensions exist: a new processor facet with a `detail`
   * role appears here with no store or client edits. Ordered by registration
   * (intrinsic first, then processors) rather than alphabetically.
   */
  facetValues(id: string): FacetValue[] {
    const facets = (this.db.prepare('SELECT * FROM facets ORDER BY rowid').all() as Array<Record<string, any>>)
      .map(rowToFacet)
      .filter((f) => (f.roles ?? []).includes('detail'))
    return facets.map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type, value: this.facetValueFor(f, id) }))
  }

  /** Resolve one facet's value(s) for a session, branching on (source, multi) like facetPredicate. */
  private facetValueFor(f: FacetSpec, id: string): string | string[] | null {
    const col = f.column ?? f.key
    if (f.source === 'session') {
      if (f.multi) {
        const rows = this.db
          .prepare(`SELECT je.value AS v FROM sessions s, json_each(s.${col}) je WHERE s.id = ?`)
          .all(id) as Array<{ v: unknown }>
        return rows.map((r) => String(r.v))
      }
      const row = this.db.prepare(`SELECT ${col} AS v FROM sessions WHERE id = ?`).get(id) as { v: unknown } | undefined
      return row?.v == null || row.v === '' ? null : String(row.v)
    }
    if (f.source === 'annotation') {
      const row = this.db.prepare('SELECT value FROM annotations WHERE session_id = ? AND key = ?').get(id, f.key) as
        | { value: string }
        | undefined
      const parsed = row ? safeJson<unknown>(row.value, null) : null
      if (f.multi) return Array.isArray(parsed) ? parsed.map(String) : []
      return parsed == null || parsed === '' ? null : String(parsed)
    }
    // usage / tool-call child grain: the distinct values this session exhibits.
    const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
    const base = f.base ? `${f.base} AND ` : ''
    const rows = this.db
      .prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE session_id = ? AND ${base}${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`)
      .all(id) as Array<{ v: unknown }>
    return rows.map((r) => String(r.v))
  }

  /** Gunzip + parse a session's stored blob (the full normalized Session), or null. */
  private loadSession(id: string): Session | null {
    const blob = this.db.prepare('SELECT gz FROM session_blobs WHERE id = ?').get(id) as { gz: Buffer } | undefined
    if (!blob?.gz) return null
    try {
      return JSON.parse(gunzipSync(blob.gz).toString('utf8')) as Session
    } catch {
      return null
    }
  }

  /**
   * The session's successful file edits as a flat, CHRONOLOGICAL list — the
   * Files-changed view. Each carries its raw before/after (Edit), full content
   * (Write), or hunks (MultiEdit), plus the transcript turn it happened in and
   * the preceding (non-synthetic) user turn, so the UI can group by file or by
   * prompt and link each change to its intent. Rejected / not-yet-read edits are
   * excluded (they changed nothing). Reconstructs from the blob at read time.
   */
  fileChanges(id: string): FileEdit[] {
    const session = this.loadSession(id)
    if (!session) return []
    const { toolTurn } = buildTranscriptCore(session)
    const out: FileEdit[] = []
    for (const tc of session.toolCalls) {
      if (tc.action !== 'file_write' || !tc.result.ok) continue
      const path = tc.target.paths?.[0]
      if (!path) continue
      const input = (tc.input ?? {}) as Record<string, unknown>
      const ref = toolTurn.get(tc.id) ?? { turn: -1, userTurn: -1 }
      let op: FileEdit['op']
      let hunks: Array<{ del: string; ins: string }>
      if (tc.name === 'Write') {
        op = 'write'
        // Cap is generous because consecutive writes are diffed against each
        // other client-side; too small a window hides changes near the file end.
        hunks = [{ del: '', ins: clip(String(input.content ?? ''), 16000) }]
      } else if (Array.isArray(input.edits)) {
        op = 'multiedit'
        hunks = (input.edits as Array<Record<string, unknown>>).map((e) => ({
          del: clip(String(e.old_string ?? ''), 4000),
          ins: clip(String(e.new_string ?? ''), 4000),
        }))
      } else {
        op = 'edit'
        hunks = [{ del: clip(String(input.old_string ?? ''), 4000), ins: clip(String(input.new_string ?? ''), 4000) }]
      }
      out.push({ path, op, hunks, ts: tc.ts, turn: ref.turn, userTurn: ref.userTurn })
    }
    return out
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
    const rows = this.db
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
    // Attach the repos each row spans and its last session time. Features use the
    // subtree union/max (an epic spans/aggregates everything under it); other
    // kinds (PRs) just carry their own repo and aren't shown a last-session time.
    const hasFeature = rows.some((r) => r.kind === 'feature')
    const repoSets = hasFeature ? this.featureRepoSets() : null
    const lastSession = hasFeature ? this.featureLastSession() : null
    const mergedPrStmt = hasFeature
      ? this.db.prepare(
          `SELECT EXISTS (SELECT 1 FROM session_artifacts saf
                         JOIN outcomes o ON o.session_id = saf.session_id
                         WHERE saf.artifact_id = ? AND o.type = 'pr_merged') AS has`,
        )
      : null
    for (const r of rows) {
      r.repos = r.kind === 'feature' ? (repoSets?.get(r.id) ?? []) : r.repo ? [r.repo] : []
      r.lastSessionAt = r.kind === 'feature' ? (lastSession?.get(r.id) ?? null) : null
      // A "mark shipped" nudge: the feature isn't shipped but a session under it
      // merged a PR — likely shippable from the dashboard's perspective.
      if (r.kind === 'feature' && mergedPrStmt) {
        const row = mergedPrStmt.get(r.id) as { has: number } | undefined
        r.hasMergedPr = !r.completedAt && !!row?.has
      }
    }
    return rows
  }

  /**
   * Per-feature last session time: the most recent start of any session linked to
   * the feature OR any descendant (subtree max), so a parent reflects the latest
   * activity beneath it. Null when nothing under it has a dated session.
   */
  private featureLastSession(): Map<string, string | null> {
    const rows = this.db
      .prepare("SELECT id, parent_artifact_id AS parentId FROM artifacts WHERE kind = 'feature'")
      .all() as Array<{ id: string; parentId: string | null }>
    const direct = new Map<string, string>()
    const dl = this.db
      .prepare(
        `SELECT sa.artifact_id AS id, MAX(s.started_at) AS last
         FROM session_artifacts sa JOIN sessions s ON s.id = sa.session_id
         JOIN artifacts a ON a.id = sa.artifact_id
         WHERE a.kind = 'feature' AND s.started_at IS NOT NULL
         GROUP BY sa.artifact_id`,
      )
      .all() as Array<{ id: string; last: string | null }>
    for (const r of dl) if (r.last) direct.set(r.id, r.last)

    const children = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.parentId) continue
      const arr = children.get(r.parentId)
      if (arr) arr.push(r.id)
      else children.set(r.parentId, [r.id])
    }
    const memo = new Map<string, string | null>()
    const onStack = new Set<string>()
    const subtreeMax = (id: string): string | null => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      let max = direct.get(id) ?? null
      if (!onStack.has(id)) {
        onStack.add(id)
        for (const c of children.get(id) ?? []) {
          const cm = subtreeMax(c)
          if (cm && (!max || cm > max)) max = cm // ISO timestamps compare lexically
        }
        onStack.delete(id)
      }
      memo.set(id, max)
      return max
    }
    const out = new Map<string, string | null>()
    for (const r of rows) out.set(r.id, subtreeMax(r.id))
    return out
  }

  /**
   * Build a SQL condition + params for artifact text search that handles plain
   * terms, `#N` (PR number with hash prefix), and `repo#N` (repo + number).
   */
  private artifactSearchCond(term: string, alias: string): { sql: string; params: unknown[] } {
    const a = alias
    const base = `%${term}%`
    const parts: string[] = [`${a}.ident LIKE ?`, `${a}.title LIKE ?`, `${a}.external_id LIKE ?`, `${a}.repo LIKE ?`]
    const params: unknown[] = [base, base, base, base]
    if (term.startsWith('#')) {
      parts.push(`${a}.ident LIKE ?`)
      params.push(`%${term.slice(1)}%`)
    }
    const hashIdx = term.indexOf('#')
    if (hashIdx > 0) {
      const repoPart = term.slice(0, hashIdx)
      const numPart = term.slice(hashIdx + 1)
      if (repoPart && numPart) {
        parts.push(`(${a}.repo LIKE ? AND ${a}.ident LIKE ?)`)
        params.push(`%${repoPart}%`, `%${numPart}%`)
      }
    }
    return { sql: '(' + parts.join(' OR ') + ')', params }
  }

  /**
   * Typeahead suggestions for the session-list artifact search. Only artifacts
   * actually linked to a session (so a pick yields results), matched on the same
   * columns the filter uses (ident/title/external_id/repo). `value` is what to
   * put in the filter input (feature→title, pr→external_id|ident, file→path);
   * `label` is for display. Features/PRs rank above the many file rows.
   */
  suggestArtifacts(q: string, kind: string | undefined, limit = 10): Array<{ kind: string; value: string; label: string }> {
    const term = q.trim()
    if (!term) return []
    const allowed = ['file', 'pr', 'feature']
    const kindFilter = kind && allowed.includes(kind) ? 'AND a.kind = ?' : ''
    const { sql: searchSql, params } = this.artifactSearchCond(term, 'a')
    if (kindFilter) params.push(kind)
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT a.kind AS kind, a.ident AS ident, a.title AS title, a.external_id AS externalId,
                a.repo AS repo, a.status AS status
         FROM artifacts a
         WHERE a.id IN (SELECT artifact_id FROM session_artifacts)
           AND ${searchSql}
           ${kindFilter}
         GROUP BY a.id
         ORDER BY CASE a.kind WHEN 'feature' THEN 0 WHEN 'pr' THEN 1 ELSE 2 END,
                  COALESCE(a.title, a.ident)
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, any>>
    return rows
      .map((r) => {
        if (r.kind === 'pr') {
          const label = (r.repo ? r.repo + ' ' : '') + '#' + (r.ident ?? '') +
            (r.title ? ' — ' + r.title : '') + (r.status ? ' (' + r.status + ')' : '')
          return { kind: 'pr', value: String(r.externalId || r.ident || ''), label }
        }
        if (r.kind === 'feature') return { kind: 'feature', value: String(r.title ?? ''), label: String(r.title || '(untitled)') }
        return { kind: 'file', value: String(r.ident ?? ''), label: String(r.ident ?? '') }
      })
      .filter((x) => x.value)
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
  /** Repos this artifact spans — a feature's full subtree union; one entry for a PR. */
  repos: string[]
  /** Most recent linked session start; for a feature, the max across its subtree. Null if none. */
  lastSessionAt: string | null
  status: string | null
  source: string | null
  externalId: string | null
  completedAt: string | null
  parentId: string | null
  sessions: number
  costUsd: number
  /** Feature only: a session linked to it produced a merged PR (a "mark shipped" nudge). */
  hasMergedPr?: boolean
}

/** One window's worth of headline KPIs (see Store.kpis). */
export interface KpiSnapshot {
  sessions: number
  totalSpend: number
  /** Fraction of sessions judged success; null when the window has no sessions. */
  successRate: number | null
  /** Tool-call error rate (fraction); null when the window has no tool calls. */
  errorRate: number | null
  costPerFeature: { count: number; costPerUnit: number | null }
  costPerPr: { count: number; costPerUnit: number | null }
}

/** One bucket of a success-rate series: the cohort's numerator/denominator/rate. */
export interface RatePoint {
  bucket: string
  num: number
  denom: number
  /** num/denom, or null when the bucket has no sessions (drawn as a gap). */
  rate: number | null
}

/** A success-rate line: per-bucket points plus the windowed totals/rate. */
export interface RateSeries {
  key: string
  points: RatePoint[]
  num: number
  denom: number
  rate: number | null
}

export interface SuccessRateQuery {
  /** Outcome types counting as success (numerator). Empty → ['session_success']. */
  outcomes: string[]
  bucket: Bucket
  /** Facet key to split into one series per value (top-K by volume). */
  by?: string
  from?: string
  to?: string
  /** Session-level facet filters, applied to numerator and denominator alike. */
  filters?: Record<string, string>
  topK?: number
}

export interface SuccessRateResult {
  outcomes: string[]
  bucket: Bucket
  /** The x-axis: every bucket label the overall line spans. */
  buckets: string[]
  overall: RateSeries
  /** Present when `by` is set. */
  series?: RateSeries[]
  /** Set when more facet values existed than were drawn. */
  truncated?: { shown: number; total: number }
}

/** One bucket of an operational (tool-call) series: count + error split. */
export interface OpsPoint {
  bucket: string
  /** The plotted metric: call count (count views) or error rate (rate view), null if no calls. */
  value: number | null
  calls: number
  errors: number
}

export interface OpsSeries {
  key: string
  points: OpsPoint[]
  /** Total count, or overall error rate, depending on the view. */
  total: number | null
  /** Call volume — used to rank series (top-K most-used tools/skills). */
  calls: number
}

export interface OpsOverTimeQuery {
  /** tool_calls = count all; error_rate = AVG(is_error); skill_usage = count where action='skill'. */
  view: 'tool_calls' | 'error_rate' | 'skill_usage'
  bucket: Bucket
  /** 'name' splits by tool_calls.name (tool name, or skill name when skills-only). */
  by?: string
  from?: string
  to?: string
  filters?: Record<string, string>
  topK?: number
}

export interface OpsOverTimeResult {
  view: string
  bucket: Bucket
  buckets: string[]
  overall: { points: OpsPoint[]; total: number | null }
  series?: OpsSeries[]
  truncated?: { shown: number; total: number }
  format: 'int' | 'pct'
}

/** One bucket of a session-count series. */
export interface CountPoint {
  bucket: string
  count: number
}

export interface CountSeries {
  key: string
  points: CountPoint[]
  total: number
}

export interface SessionsOverTimeQuery {
  bucket: Bucket
  by?: string
  from?: string
  to?: string
  filters?: Record<string, string>
  topK?: number
}

export interface SessionsOverTimeResult {
  bucket: Bucket
  buckets: string[]
  overall: { points: CountPoint[]; total: number }
  series?: CountSeries[]
  truncated?: { shown: number; total: number }
  presenceInflated?: boolean
}

/** One bucket of a spend series. */
export interface SpendPoint {
  bucket: string
  spend: number
}

/** A spend line: per-bucket points plus the total over the range. */
export interface SpendSeries {
  key: string
  points: SpendPoint[]
  total: number
}

export interface SpendOverTimeQuery {
  bucket: Bucket
  /** Facet key to split into one series per value (top-K by total spend). */
  by?: string
  from?: string
  to?: string
  filters?: Record<string, string>
  topK?: number
}

export interface SpendOverTimeResult {
  bucket: Bucket
  buckets: string[]
  overall: { points: SpendPoint[]; total: number }
  series?: SpendSeries[]
  truncated?: { shown: number; total: number }
  /** True when the breakdown facet is multi-valued, so series sum past overall. */
  presenceInflated?: boolean
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
  /** Drill from a chart bucket: restrict to sessions whose start falls in this bucket. */
  bucket?: Bucket
  bucketValue?: string
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

export interface TranscriptTool {
  name: string
  action: string
  ok: boolean
  target?: string
  error?: string
  /** Clipped successful result text, shown collapsed-by-default in the transcript. */
  result?: string
  /** For a subagent-spawning call (`Task`/`Agent`), the agentId it links to. */
  agentId?: string
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system'
  ts?: string
  sidechain: boolean
  /** Which subagent emitted this turn; undefined for main-thread turns. */
  agentId?: string
  text: string
  tools: TranscriptTool[]
}

/** One subagent's identity, for the transcript's per-subagent tab + spawn link. */
export interface SubagentInfo {
  agentId: string
  agentType?: string
  description?: string
  /** tool_use id of the spawning call in the parent thread (absent for workflow subagents). */
  toolUseId?: string
}

/**
 * A session's viewer-ready transcript: one flat, globally-indexed list of turns
 * (each tagged with its `agentId`, so the client can split the main thread from
 * each subagent into its own tab) plus the subagent roster.
 */
export interface Transcript {
  turns: TranscriptTurn[]
  subagents: SubagentInfo[]
}

/** A facet's resolved value for one session — the registry-driven detail row. */
export interface FacetValue {
  key: string
  label: string
  type: FacetType
  /** scalar, list (multi / child-grain facets), or null when the session has none. */
  value: string | string[] | null
}

export interface SessionDetail {
  session: Record<string, unknown>
  annotations: Record<string, unknown>
  outcomes: Array<{ type: string; artifactId: string | null }>
  artifacts: Array<Record<string, unknown>>
  facets: FacetValue[]
  transcript: Transcript
}

/**
 * One successful file write in the session — a before/after (Edit), full content
 * (Write), or hunks (MultiEdit). Returned as a flat, chronological list so the
 * client can group it either by file or by prompt.
 */
export interface FileEdit {
  path: string
  op: 'edit' | 'multiedit' | 'write'
  hunks: Array<{ del: string; ins: string }>
  ts?: string
  /** Index into the transcript turns of the assistant turn that made the edit. */
  turn: number
  /** Index of the preceding (non-synthetic) user turn — the prompting intent, or -1. */
  userTurn: number
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
  if (f.source === 'feature') {
    // Join the session's linked features (by title). A session under multiple
    // features fans its usage rows across each → series overlap (presenceInflated),
    // the same honest behavior as other multi-valued cohort splits.
    return {
      join: `JOIN session_artifacts sfa ON sfa.session_id = s.id JOIN artifacts a ON a.id = sfa.artifact_id AND a.kind = 'feature'`,
      expr: 'a.title',
      where: 'a.title IS NOT NULL',
    }
  }
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

function buildTranscript(session: Session): Transcript {
  return {
    turns: buildTranscriptCore(session).turns,
    subagents: (session.subagents ?? []).map((s) => ({
      agentId: s.agentId,
      agentType: s.agentType,
      description: s.description,
      toolUseId: s.toolUseId,
    })),
  }
}

/**
 * Transcript turns PLUS a map from each tool_use id to its turn index and the
 * index of the preceding user turn — so the Files-changed view can link an edit
 * back to the user message that prompted it (the "intent"). Turn indices match
 * positions in `turns`, which is exactly what the client anchors as `txt-<i>`.
 */
function buildTranscriptCore(session: Session): {
  turns: TranscriptTurn[]
  toolTurn: Map<string, { turn: number; userTurn: number }>
} {
  const resById = new Map(session.toolCalls.map((t) => [t.id, t.result]))
  // toolUseId of a spawning call → the subagent it spawned, so the main-thread
  // chip can link to that subagent's transcript tab.
  const spawnToAgent = new Map<string, string>()
  for (const sa of session.subagents ?? []) if (sa.toolUseId) spawnToAgent.set(sa.toolUseId, sa.agentId)
  const turns: TranscriptTurn[] = []
  const toolTurn = new Map<string, { turn: number; userTurn: number }>()
  let lastUserIdx = -1
  for (const ev of session.events) {
    if (ev.kind === 'assistant') {
      let text = ''
      const tools: TranscriptTool[] = []
      const ids: string[] = []
      for (const b of ev.blocks) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text
        else if (b.type === 'tool_use') {
          ids.push(b.id)
          const input = b.input as { file_path?: string; command?: string; path?: string } | undefined
          const target = input?.file_path ?? input?.path ?? input?.command
          const res = resById.get(b.id)
          const ok = res ? res.ok : true
          // Keep the full command/path (capped for payload) so the UI can show a
          // short preview on the chip and expand to the whole thing on demand.
          const tool: TranscriptTool = { name: b.name, action: '', ok, target: clip(target, 1500) }
          if (!ok) tool.error = clipError(resultText(res?.raw))
          else {
            // Surface a clipped successful result so the transcript can show it
            // collapsed-by-default (expand on demand). Subagent spawns carry no
            // result text worth showing — their transcript lives in its own scope.
            if (!spawnToAgent.has(b.id)) {
              const rt = resultText(res?.raw).trim()
              if (rt) tool.result = clip(rt, 4000)
            }
          }
          const spawned = spawnToAgent.get(b.id)
          if (spawned) tool.agentId = spawned
          tools.push(tool)
        }
      }
      if (!text && tools.length === 0) continue
      const idx = turns.length
      for (const id of ids) toolTurn.set(id, { turn: idx, userTurn: lastUserIdx })
      turns.push({ role: 'assistant', ts: ev.ts, sidechain: ev.isSidechain, agentId: ev.agentId, text: clip(text, 20000), tools })
    } else if (ev.kind === 'user') {
      const text = ev.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim()
      if (!text) continue
      // Only real prompts become the "intent" an edit links back to (the turn is
      // still shown in the transcript, just not used as a jump/grouping target).
      if (!isSyntheticUser(text)) lastUserIdx = turns.length
      turns.push({ role: 'user', ts: ev.ts, sidechain: ev.isSidechain, agentId: ev.agentId, text: clip(text, 20000), tools: [] })
    }
  }
  return { turns, toolTurn }
}

function clip(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + ' …' : s
}

/**
 * Clip a long tool error keeping BOTH ends: the head (e.g. "Error: Exit code 1")
 * and the tail, where the actual failure usually is. The UI auto-scrolls the
 * panel to the bottom so that tail is what you see first.
 */
function clipError(s: string): string {
  const MAX = 1000
  if (s.length <= MAX) return s
  const head = 160
  const tail = MAX - head
  return s.slice(0, head).trimEnd() + `\n  … ${s.length - head - tail} chars omitted … \n` + s.slice(-tail).trimStart()
}

/** Best-effort readable text from a tool result's raw payload (string, content-block array, or object). */
function resultText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['stderr', 'error', 'message', 'content']) {
      const v = o[k]
      if (typeof v === 'string' && v) return v
      if (Array.isArray(v)) return resultText(v)
    }
    try {
      return JSON.stringify(o)
    } catch {
      return ''
    }
  }
  return String(raw)
}
