import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { CanonicalAction, Session, ToolCall } from '../core/model'
import type { ProcessorResult, RefreshResult } from '../core/processor'
import Database from 'better-sqlite3'
import type { DB } from './db'
import { parseApplyPatch } from './apply-patch'
import { blockSpine, deterministicBlocks } from '../core/blocks'
import type { Block } from '../core/blocks'
import { classifyError, ERROR_CATEGORIES } from '../core/error-category'
import { facetGroupCompatible, grainOf } from '../core/facets'
import type { FacetSpec, FacetType, Grain } from '../core/facets'
import { aliasFor } from '../core/measures'
import type { MeasureSpec } from '../core/measures'
import type { ArtifactInput, DetectorRunRow, EnvSnapshotAsOf, EnvSnapshotInput, EnvSnapshotRow, FeatureRevisionInput, FixMarkerSightingInput, InsightState, ProcessorRunRow, SessionArtifactRole, ThemeEventInput, ThemeInput, ThemeRef, UsageFactInput } from './types'
import { contentHash } from '../core/hash'
import { firstUserPrompt, isSyntheticUser } from '../core/turns'
import { insightId } from '../core/detector'
import type { EvidenceRef, InsightInput } from '../core/detector'
import type { InsightRow } from './types'

/**
 * Max evidence occurrences retained per insight — a defensive bound on per-insight row
 * growth, not a display limit
 */
const EVIDENCE_CAP = 500

export interface Dist {
  value: string
  count: number
}

/** One failed tool call in the "Errors by category" drill-down (see errorOccurrences). */
export interface ErrorOccurrence {
  sessionId: string
  title: string | null
  idx: number
  name: string
  action: string
  command: string | null
  targetPath: string | null
  message: string | null
  ts: string | null
  startedAt: string | null
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
  /** Whether LLM enrichment has run (any processor recorded an LLM model). */
  enrichmentRan: boolean
  /** ISO timestamp of the most recent `analyze` run (null if never recorded). */
  lastAnalyzedAt: string | null
  /** Source directories scanned, each with its own last-analyzed time (empty until an analyze runs on this schema). */
  analyzedRoots: Array<{ source: string | null; path: string; lastAnalyzedAt: string | null }>
  /** Enrichment dimension distributions, empty when enrichment hasn't run. */
  useCases: Dist[]
  complexity: Dist[]
  autonomy: Dist[]
  features: { total: number; derived: number; linked: number }
}

/** One computed insight for the Highlights digest. The client maps `kind` to the
 *  display sentence + its drill-in; the payload carries the data. */
export interface Highlight {
  kind: string
  [field: string]: unknown
}

export class Store {
  private readonlyDb: DB | null = null

  constructor(private db: DB) {}

  /**
   * Returns a readonly DB handle for detector queries. Opens lazily on first use.
   * SQLite enforces the read-only constraint at the engine level — any write attempt
   * (including DELETE...RETURNING, UPDATE...RETURNING, PRAGMA mutations) throws.
   * This is the handle detectors use via queryAll()/queryOne().
   */
  private getReadonlyDb(): DB {
    if (!this.readonlyDb) {
      this.readonlyDb = new Database(this.db.name, { readonly: true })
    }
    return this.readonlyDb
  }

  /** Read a value from the key-value `meta` table (undefined when absent). */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /** Upsert a value into the key-value `meta` table. */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value)
  }

  /**
   * Stamp each source directory scanned this run with the run timestamp. Upsert,
   * so roots a scoped re-run didn't touch keep their prior stamp — the table then
   * answers "when was THIS directory last analyzed" per directory.
   */
  recordAnalyzedRoots(roots: Array<{ source: string; path: string }>, at: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO analyzed_roots (source, path, last_analyzed_at) VALUES (?, ?, ?)
         ON CONFLICT(source, path) DO UPDATE SET last_analyzed_at = excluded.last_analyzed_at`,
    )
    const tx = this.db.transaction((rows: Array<{ source: string; path: string }>) => {
      for (const r of rows) stmt.run(r.source, r.path, at)
    })
    tx(roots)
  }

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
      const prior = this.db
        .prepare('SELECT content_hash AS hash, parse_version AS parseVersion FROM sessions WHERE id = ?')
        .get(session.id) as { hash: string | null; parseVersion: number | null } | undefined
      const normalizationChanged =
        prior != null && prior.hash === session.raw.contentHash && (prior.parseVersion ?? 0) < parseVersion
      // Upsert (NOT INSERT OR REPLACE): replacing the row would fire ON DELETE
      // CASCADE and wipe processor-owned children (annotations, outcomes,
      // session_artifacts) that a cache-hit processor then won't recreate. Update
      // in place so re-ingest only refreshes the session's own columns.
      this.db
        .prepare(
          `INSERT INTO sessions (
             id, session_id, source, provider, title, first_prompt, repo, branch, cwd,
             started_at, ended_at, n_turns, n_tool_calls, models,
             tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read,
             cost_usd, price_table_version, content_hash, parse_version, analyzed_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             session_id=excluded.session_id, source=excluded.source, provider=excluded.provider,
             title=excluded.title, first_prompt=excluded.first_prompt, repo=excluded.repo, branch=excluded.branch, cwd=excluded.cwd,
             started_at=excluded.started_at, ended_at=excluded.ended_at, n_turns=excluded.n_turns,
             n_tool_calls=excluded.n_tool_calls, models=excluded.models,
             tok_input=excluded.tok_input, tok_output=excluded.tok_output,
             tok_cache_create_5m=excluded.tok_cache_create_5m, tok_cache_create_1h=excluded.tok_cache_create_1h,
             tok_cache_read=excluded.tok_cache_read,
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
          firstUserPrompt(session),
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
          session.tokens.cacheCreate5m,
          session.tokens.cacheCreate1h,
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
           (session_id, idx, name, action, ok, is_error, error_category, error_message, target_path, command, is_sidechain, ts, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      session.toolCalls.forEach((t, idx) => {
        // For failed calls, fingerprint a cross-harness category + keep a one-line
        // error snippet (both NULL when ok), computed at ingest. Clip before classify.
        const errText = t.result.ok ? null : resultText(t.result.raw)
        const category = errText == null ? null : classifyError(t.action, errText.slice(0, 8000))
        const message = errText == null ? null : errText.replace(/\s+/g, ' ').trim().slice(0, 200) || null
        insTool.run(
          session.id,
          idx,
          t.name,
          t.action,
          t.result.ok ? 1 : 0,
          t.result.isError ? 1 : 0,
          category,
          message,
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
            tok_input, tok_output, tok_cache_create_5m, tok_cache_create_1h, tok_cache_read, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
          f.tokens.cacheCreate5m,
          f.tokens.cacheCreate1h,
          f.tokens.cacheRead,
          f.usd,
        )
      }
      // Parser upgrades can change the normalized blob/tool rows while the raw
      // transcript hash stays identical. Processor caches key on that raw hash,
      // so explicitly stale them and rebuild files, PRs, blocks, and enrichment.
      if (normalizationChanged) {
        this.db.prepare('UPDATE processor_runs SET invalidated = 1 WHERE session_id = ?').run(session.id)
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
                SUM(tok_input + tok_output + tok_cache_create_5m + tok_cache_create_1h + tok_cache_read) AS tokens
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
        'SELECT version, input_hash AS inputHash, model, invalidated FROM processor_runs WHERE session_id = ? AND processor = ?',
      )
      .get(sessionId, processor) as (Omit<ProcessorRunRow, 'invalidated'> & { invalidated: number }) | undefined
    return row ? { ...row, invalidated: row.invalidated === 1 } : undefined
  }

  unresolvedArtifacts(producer: string): ArtifactInput[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, repo, ident, external_id AS externalId, source, title, owner,
                complexity, complexity_basis AS complexityBasis, status,
                created_at AS createdAt, completed_at AS completedAt,
                parent_artifact_id AS parentArtifactId
         FROM artifacts
         WHERE producer IN (?, 'dashboard') AND status IS NOT NULL AND status NOT IN ('merged', 'closed', 'shipped')`,
      )
      .all(producer) as ArtifactInput[]
    return rows
  }

  persistRefresh(producer: string, result: RefreshResult) {
    const tx = this.db.transaction(() => {
      for (const a of result.artifacts ?? []) {
        this.db
          .prepare(
            `UPDATE artifacts SET status = ?, completed_at = ?,
                    complexity = COALESCE(?, complexity),
                    complexity_basis = COALESCE(?, complexity_basis)
             WHERE id = ? AND producer IN (?, 'dashboard')`,
          )
          .run(a.status ?? null, a.completedAt ?? null, a.complexity ?? null, a.complexityBasis ?? null, a.id, producer)
      }
      for (const o of result.outcomes ?? []) {
        const sessionId = (
          this.db
            .prepare('SELECT session_id FROM session_artifacts WHERE artifact_id = ? LIMIT 1')
            .get(o.artifactId) as { session_id: string } | undefined
        )?.session_id
        if (!sessionId) continue
        this.db
          .prepare('INSERT INTO outcomes (session_id, type, artifact_id, ts, producer) VALUES (?,?,?,?,?)')
          .run(sessionId, o.type, o.artifactId, o.ts ?? null, producer)
      }
    })
    tx()
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
      this.db.prepare('DELETE FROM blocks WHERE session_id = ? AND producer = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM block_usage WHERE session_id = ? AND producer = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM block_tool WHERE session_id = ? AND producer = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM block_annotations WHERE session_id = ? AND processor = ?').run(sessionId, processor)
      this.db.prepare('DELETE FROM block_artifacts WHERE session_id = ? AND producer = ?').run(sessionId, processor)

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
        // Field-merging upsert (NOT INSERT OR REPLACE): the same PR can be written
        // by several sessions (its creator, then any session that reviewed it), and
        // an offline run may only have a stub (no title/state). COALESCE keeps a
        // value a richer write already stored rather than blanking it. `status` gets
        // a guard so a stub's optimistic 'open' can't overwrite a terminal merged/closed.
        this.db
          .prepare(
            `INSERT INTO artifacts
               (id, kind, repo, ident, external_id, source, title, owner, complexity,
                complexity_basis, status, created_at, completed_at, parent_artifact_id, json, producer)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               repo = COALESCE(excluded.repo, artifacts.repo),
               ident = COALESCE(excluded.ident, artifacts.ident),
               external_id = COALESCE(excluded.external_id, artifacts.external_id),
               source = COALESCE(excluded.source, artifacts.source),
               title = COALESCE(excluded.title, artifacts.title),
               owner = COALESCE(excluded.owner, artifacts.owner),
               complexity = COALESCE(excluded.complexity, artifacts.complexity),
               complexity_basis = COALESCE(excluded.complexity_basis, artifacts.complexity_basis),
               status = CASE
                 WHEN artifacts.status IN ('merged', 'closed') AND COALESCE(excluded.status, '') = 'open'
                   THEN artifacts.status
                 ELSE COALESCE(excluded.status, artifacts.status) END,
               created_at = COALESCE(excluded.created_at, artifacts.created_at),
               completed_at = COALESCE(excluded.completed_at, artifacts.completed_at),
               parent_artifact_id = COALESCE(excluded.parent_artifact_id, artifacts.parent_artifact_id),
               json = COALESCE(excluded.json, artifacts.json),
               producer = excluded.producer`,
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
      const rejected = new Set(
        (this.db
          .prepare("SELECT artifact_id FROM user_link_overrides WHERE session_id = ? AND action = 'reject'")
          .all(sessionId) as Array<{ artifact_id: string }>)
          .map((r) => r.artifact_id),
      )
      for (const sa of result.sessionArtifacts ?? []) {
        if (sa.source === 'derived' && rejected.has(sa.artifactId)) continue
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
      for (const b of result.blocks ?? []) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, ts_start, ts_end, producer) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(sessionId, b.idx, b.startSeq, b.endSeq, b.boundaryKind, b.tsStart ?? null, b.tsEnd ?? null, processor)
      }
      for (const u of result.blockUsage ?? []) {
        this.db
          .prepare('INSERT OR REPLACE INTO block_usage (session_id, usage_idx, block_idx, producer) VALUES (?,?,?,?)')
          .run(sessionId, u.usageIdx, u.blockIdx, processor)
      }
      for (const t of result.blockTool ?? []) {
        this.db
          .prepare('INSERT OR REPLACE INTO block_tool (session_id, tool_idx, block_idx, producer) VALUES (?,?,?,?)')
          .run(sessionId, t.toolIdx, t.blockIdx, processor)
      }
      for (const ba of result.blockAnnotations ?? []) {
        this.db
          .prepare('INSERT OR REPLACE INTO block_annotations (session_id, block_idx, processor, key, value) VALUES (?,?,?,?,?)')
          .run(sessionId, ba.blockIdx, processor, ba.key, JSON.stringify(ba.value))
      }
      // Cross-role block reconciliation — at most one PR-kind row per block. Precedence
      // (highest first): pcm(contributed) > og(reviewed) > enrich(reviewed) > og(contributed).
      // We PREVENT the insert when an equal-or-higher-ranked PR row already holds the block;
      // when this row outranks the holder, we displace it. Feature-contributed rows (rank 0)
      // are a different artifact kind (queried separately) and skip reconciliation. The rank
      // guard makes this ORDER-INDEPENDENT — the same winner regardless of which producer ran
      // (or re-ran) first. Rejected derived links `continue` before touching the block.
      // (Follow-up: a partial UNIQUE index on the PR rows lets INSERT OR REPLACE displace the
      // loser without this explicit DELETE; the guard stays.)
      const heldPr = this.db.prepare(
        `SELECT producer, role FROM block_artifacts WHERE session_id = ? AND block_idx = ?
           AND (producer IN ('outcomes-git', 'pr-content-match') OR (producer = 'enrich-session' AND role = 'reviewed')) LIMIT 1`,
      )
      const displacePr = this.db.prepare(
        `DELETE FROM block_artifacts WHERE session_id = ? AND block_idx = ?
           AND (producer IN ('outcomes-git', 'pr-content-match') OR (producer = 'enrich-session' AND role = 'reviewed'))`,
      )
      const insertBlockArtifact = this.db.prepare(
        'INSERT OR REPLACE INTO block_artifacts (session_id, block_idx, artifact_id, role, source, confidence, producer) VALUES (?,?,?,?,?,?,?)',
      )
      for (const x of result.blockArtifacts ?? []) {
        if (x.source === 'derived' && rejected.has(x.artifactId)) continue
        const rank = prBlockRank(processor, x.role)
        if (rank > 0) {
          const held = heldPr.get(sessionId, x.blockIdx) as { producer: string; role: string | null } | undefined
          if (held) {
            if (prBlockRank(held.producer, held.role) >= rank) continue // outranked → don't insert
            displacePr.run(sessionId, x.blockIdx) // this row outranks the holder → remove it
          }
        }
        insertBlockArtifact.run(sessionId, x.blockIdx, x.artifactId, x.role, x.source ?? null, x.confidence ?? null, processor)
      }

      // The table is single-writer (fix-marker), which always emits the field when it runs.
      if (result.fixMarkerSightings) this.recordFixMarkerSightings(sessionId, result.fixMarkerSightings)

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
      // Sync, don't just upsert: drop any facet this producer registered before
      // but no longer declares, so a removed facet (e.g. a retired enrichment
      // field) leaves the registry instead of lingering as a dead breakdown /
      // filter / distribution option that still groups orphaned annotation rows.
      // Scoped to `producer`, so intrinsic and other processors' facets are safe.
      const keep = specs.map((f) => f.key)
      const notIn = keep.length ? ` AND key NOT IN (${keep.map(() => '?').join(',')})` : ''
      this.db.prepare(`DELETE FROM facets WHERE producer = ?${notIn}`).run(producer, ...keep)
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
                COALESCE(SUM(tok_input+tok_output+tok_cache_create_5m+tok_cache_create_1h+tok_cache_read),0) AS tokens,
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

    // Enrichment spend = every LLM call analyze made: processor enrichment AND
    // detector (tier P/X) passes. Both record cost_usd per run; sum both, or the
    // detectors' spend (extraction/reconcile/fix — often the bulk) is invisible.
    const analysisCostUsd =
      (this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM processor_runs').get() as { s: number }).s +
      (this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM detector_runs').get() as { s: number }).s

    // Whether LLM enrichment has ever run. Both processor_runs and detector_runs
    // record the model that ran them (NULL for non-LLM / S-tier), so a single
    // non-null model in either is a durable "enrichment ran" signal — independent of
    // which dimensions the enricher currently emits. Rows are written only on
    // success: "did enrichment produce anything", not "was a key configured".
    const enrichmentRan =
      (this.db.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM processor_runs WHERE model IS NOT NULL
           UNION ALL SELECT 1 FROM detector_runs WHERE model IS NOT NULL
         ) AS r`,
      ).get() as { r: number }).r === 1

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
      enrichmentRan,
      lastAnalyzedAt: this.getMeta('last_analyze_at') ?? null,
      analyzedRoots: this.db
        .prepare('SELECT source, path, last_analyzed_at AS lastAnalyzedAt FROM analyzed_roots ORDER BY source, path')
        .all() as Summary['analyzedRoots'],
      useCases: this.facetDistribution('use_case'),
      complexity: this.scalarDist('complexity'),
      autonomy: this.scalarDist('autonomy'),
      features,
    }
  }

  /** The single most significant week-over-week move to lead the digest with:
   *  compares this window's headline KPIs (spend, success rate, session count) to
   *  the prior equal-length window and returns the biggest mover — normalized to
   *  how many times over its own "notable" bar each one is, so one metric type
   *  can't dominate just because its natural swings run larger. Null when nothing
   *  clears its bar, or the prior window's base is too thin to trust the delta.
   *  Only called for a bounded [from, to). */
  private trendHeadline(from: string, to: string): Highlight | null {
    const span = new Date(to).getTime() - new Date(from).getTime()
    const prevFrom = new Date(new Date(from).getTime() - span).toISOString()
    const cur = this.kpis(from, to)
    const prev = this.kpis(prevFrom, from)
    const cands: Array<{ score: number; h: Highlight }> = []
    // Spend: relative change; needs a non-trivial prior base so a $1→$3 blip
    // doesn't read as "+200%".
    if (prev.totalSpend >= 5) {
      const pct = ((cur.totalSpend - prev.totalSpend) / prev.totalSpend) * 100
      if (Math.abs(pct) >= 20)
        cands.push({ score: Math.abs(pct) / 20, h: { kind: 'trend', metric: 'spend', cur: cur.totalSpend, prev: prev.totalSpend, pct: Math.round(pct) } })
    }
    // Success rate: percentage-point change; needs enough sessions both sides for
    // the rate to mean anything.
    if (cur.successRate != null && prev.successRate != null && cur.sessions >= 3 && prev.sessions >= 3) {
      const pp = (cur.successRate - prev.successRate) * 100
      if (Math.abs(pp) >= 10)
        cands.push({ score: Math.abs(pp) / 10, h: { kind: 'trend', metric: 'rate', cur: cur.successRate, prev: prev.successRate, pp: Math.round(pp) } })
    }
    // Session count: relative change; needs a non-trivial prior base.
    if (prev.sessions >= 3) {
      const pct = ((cur.sessions - prev.sessions) / prev.sessions) * 100
      if (Math.abs(pct) >= 25)
        cands.push({ score: Math.abs(pct) / 25, h: { kind: 'trend', metric: 'sessions', cur: cur.sessions, prev: prev.sessions, pct: Math.round(pct) } })
    }
    if (!cands.length) return null
    cands.sort((a, b) => b.score - a.score)
    return cands[0]!.h
  }

  /** The windowed "reliable facts" behind the Highlights digest — most-spend
   *  shipped artifact, its stalled (not-yet-shipped) counterpart, converted spend,
   *  and the busiest source file — all scoped to [from, to) (omit for all-time) so
   *  the whole digest honors the dashboard window. */
  private windowedFacts(from?: string, to?: string) {
    const w = from && to ? ' AND s.started_at >= ? AND s.started_at < ?' : ''
    const wp: string[] = from && to ? [from, to] : []
    const scalar = (sql: string) => (this.db.prepare(sql).get(...wp) as { v: number }).v

    const total = scalar(`SELECT COALESCE(SUM(cost_usd),0) AS v FROM sessions s WHERE 1=1${w}`)
    // Converted spend is BLOCK-level: a usage row counts only if its block is linked
    // to a completed artifact (any role — production OR your review of it), so only the
    // parts of a session that touched a shipped artifact count, not the whole session.
    // Matches the burn chart's green band and the cost-per-shipped-artifact basis.
    const shipped = scalar(
      `SELECT COALESCE(SUM(u.cost_usd),0) AS v
       FROM usage_facts u JOIN sessions s ON s.id = u.session_id
       WHERE EXISTS (SELECT 1 FROM block_usage bu
                     JOIN block_artifacts ba ON ba.session_id = bu.session_id AND ba.block_idx = bu.block_idx
                     JOIN artifacts a ON a.id = ba.artifact_id
                     WHERE bu.session_id = u.session_id AND bu.usage_idx = u.idx
                       AND a.completed_at IS NOT NULL)${w}`,
    )

    // Busiest source file — most distinct sessions, skipping generated noise. We
    // fetch the top two so the digest can require a CLEAR leader (a lone winner,
    // not one of a big pack tied at the same low count — that tie is what made the
    // old "more than any other" claim misleading).
    const topFiles = this.db
      .prepare(
        `SELECT fi.path AS path, COUNT(DISTINCT fi.session_id) AS sessions
         FROM files_index fi JOIN sessions s ON s.id = fi.session_id
         WHERE 1=1${w}
           AND fi.path NOT LIKE '%.lock' AND fi.path NOT LIKE '%lock.json'
           AND fi.path NOT LIKE '%lock.yaml' AND fi.path NOT LIKE '%/go.sum'
         GROUP BY fi.repo, fi.path ORDER BY sessions DESC, fi.path LIMIT 2`,
      )
      .all(...wp) as Array<{ path: string; sessions: number }>
    const topFile = topFiles[0]
      ? { path: topFiles[0].path, sessions: topFiles[0].sessions, clearLead: !topFiles[1] || topFiles[0].sessions > topFiles[1].sessions }
      : undefined

    // Biggest shipped: shipped feature → merged PR → wip feature, among artifacts
    // active in the window, ranked by block-attributed cost (matches the Artifacts table).
    // Full cost — all roles, production AND your review of it — so a PR you contributed
    // to by reviewing is ranked on its real spend (mirrors costPerArtifact).
    const blockCost = `COALESCE((SELECT SUM(cost_usd) FROM (
        SELECT DISTINCT u.session_id, u.idx AS uidx, u.cost_usd FROM block_artifacts ba
        JOIN block_usage bu ON bu.session_id = ba.session_id AND bu.block_idx = ba.block_idx
        JOIN usage_facts u ON u.session_id = bu.session_id AND u.idx = bu.usage_idx
        WHERE ba.artifact_id = a.id)), 0)`
    // An artifact is "in window" (and a candidate at all) via ANY session link in the
    // window — authored or reviewed — so every artifact you contributed to is eligible
    // for the biggest-shipped / stalled spotlight.
    const inWindow =
      from && to
        ? `EXISTS (SELECT 1 FROM session_artifacts sa JOIN sessions s ON s.id = sa.session_id
                   WHERE sa.artifact_id = a.id
                     AND s.started_at >= ? AND s.started_at < ?)`
        : `EXISTS (SELECT 1 FROM session_artifacts sa WHERE sa.artifact_id = a.id)`
    const pickWin = (kind: string, completion: 'shipped' | 'unshipped') =>
      this.db
        .prepare(
          `SELECT a.title AS title, a.repo AS repo, a.ident AS ident, ${blockCost} AS cost
           FROM artifacts a
           WHERE a.kind = ? AND a.completed_at IS ${completion === 'shipped' ? 'NOT NULL' : 'NULL'} AND ${inWindow}
           ORDER BY cost DESC LIMIT 1`,
        )
        .get(...(from && to ? [kind, from, to] : [kind])) as
        | { title: string; repo: string | null; ident: string | null; cost: number }
        | undefined

    type Pick = { kind: 'feature' | 'pr'; title: string; repo: string | null; ident: string | null; cost: number }
    // Most AI spend on SHIPPED work: a shipped feature if the user marks any
    // shipped, else the costliest merged PR. No unshipped fallback — that's what
    // `stalled` is for.
    const shippedFeat = pickWin('feature', 'shipped')
    let spotlight: Pick | null = null
    if (shippedFeat) spotlight = { kind: 'feature', ...shippedFeat }
    else {
      const pr = pickWin('pr', 'shipped')
      if (pr) spotlight = { kind: 'pr', ...pr }
    }

    // Most AI spend NOT yet shipped (stalled): an unshipped feature, but only when
    // the user actually marks features shipped (otherwise every feature is
    // trivially "unshipped" and it's noise) — else fall back to the costliest
    // open/unmerged PR, a reliable git-derived signal that works for new users.
    let stalled: Pick | null = null
    if (shippedFeat) {
      const uf = pickWin('feature', 'unshipped')
      if (uf) stalled = { kind: 'feature', ...uf }
    } else {
      const up = pickWin('pr', 'unshipped')
      if (up) stalled = { kind: 'pr', ...up }
    }

    return { total, shipped, topFile, spotlight, stalled }
  }

  /** The Highlights digest: a few reliably-interesting facts plus facet-WALKED
   *  comparisons (spend concentration, outcome-rate spread) — for each, we go down
   *  an ordered facet list and keep the FIRST facet whose breakdown clears an
   *  interestingness threshold, so nothing is hardcoded to `repo` and a dominated
   *  split (e.g. one harness at 99%) is skipped. Each insight is a typed payload;
   *  the client renders the sentence + drill-in. `from`/`to` window everything;
   *  omit for all-time. */
  highlights(from?: string, to?: string): Highlight[] {
    const out: Highlight[] = []
    // A stalled-spend insight only fires when the costliest unshipped artifact is a
    // meaningful slice of the window's spend (so a tiny unshipped feature is quiet).
    const STALLED_MIN_SHARE = 0.15
    const f = this.windowedFacts(from, to)

    // --- Week-over-week trend headline (only over a bounded window, where a
    // "previous window" exists to compare against) ---
    if (from && to) {
      const trend = this.trendHeadline(from, to)
      if (trend) out.push(trend)
    }

    // --- Reliable facts, windowed (show when the data exists) ---
    if (f.spotlight) {
      const sp = f.spotlight
      out.push({ kind: 'biggest_shipped', artifactKind: sp.kind, title: sp.title, repo: sp.repo, ident: sp.ident, cost: sp.cost })
    }
    // The stalled counterpart to biggest_shipped — kept adjacent so they read as a
    // shipped/not-yet-shipped pair.
    if (f.stalled && f.total > 0 && f.stalled.cost / f.total >= STALLED_MIN_SHARE)
      out.push({ kind: 'stalled_spend', artifactKind: f.stalled.kind, title: f.stalled.title, repo: f.stalled.repo, ident: f.stalled.ident, cost: f.stalled.cost })
    if (f.total > 0 && f.shipped > 0)
      out.push({ kind: 'converted_spend', shipped: f.shipped, total: f.total, pct: Math.round((100 * f.shipped) / f.total) })
    // Busiest file — only with a CLEAR leader and real repetition (≥3 sessions), so
    // we never surface an arbitrary file from a big low-count tie.
    if (f.topFile && f.topFile.sessions >= 3 && f.topFile.clearLead)
      out.push({ kind: 'active_file', path: f.topFile.path, sessions: f.topFile.sessions })

    // --- Facet-walked: spend concentration (one value leads, but doesn't own it
    // all). use_case is excluded: `implement` dominates almost everyone's spend, so
    // it always won the walk with an uninteresting result. ---
    for (const facet of ['repo', 'model', 'harness']) {
      const r = this.spendOverTime({ bucket: 'month', by: facet, from, to })
      if ('error' in r || !r.series || r.series.length < 2) continue
      const total = (r.overall?.points ?? []).reduce((a, p) => a + p.spend, 0)
      if (total <= 0) continue
      const top = r.series.slice().sort((a, b) => b.total - a.total)[0]
      if (!top || !top.key || top.key === 'Other') continue
      const share = top.total / total
      if (share >= 0.5 && share <= 0.9) {
        out.push({ kind: 'spend_concentration', facet, value: top.key, spend: top.total, total, pct: Math.round(share * 100) })
        break
      }
    }

    // --- Facet-walked: outcome-rate spread (a real gap between best and worst value) ---
    // use_case is intentionally excluded: it's multi-valued (a session counts under
    // several work types), so per-value rates mix overlapping populations.
    for (const facet of ['repo', 'complexity', 'model', 'autonomy']) {
      const r = this.successRate({ outcomes: ['session_success'], bucket: 'month', by: facet, from, to })
      const vals = (r.series ?? []).filter((s) => s.denom >= 3 && s.rate != null && s.key && s.key !== 'Other')
      if (vals.length < 2) continue
      const sorted = vals.slice().sort((a, b) => (b.rate as number) - (a.rate as number))
      const best = sorted[0]
      const worst = sorted[sorted.length - 1]
      if (!best || !worst) continue
      if ((best.rate as number) - (worst.rate as number) >= 0.2) {
        out.push({
          kind: 'success_spread',
          facet,
          best: { value: best.key, rate: best.rate, n: best.denom },
          worst: { value: worst.key, rate: worst.rate, n: worst.denom },
        })
        break
      }
    }

    // --- Autonomy on complex tasks: a count (enrichment-gated), with a guarded
    // delta. Only shows when enrichment has run AND there are ≥2 such sessions; the
    // "vs. prior window" delta is appended ONLY when the prior window has a real
    // base (≥3), so a 1→2 jump never reads as "+100%". ---
    if (this.db.prepare(`SELECT 1 FROM annotations WHERE key='autonomy' LIMIT 1`).get()) {
      const countAC = (a?: string, b?: string) =>
        (
          this.db
            .prepare(
              // "complex" = the two hardest complexity tiers in the enricher's taxonomy.
              `SELECT COUNT(*) AS n FROM sessions s
               WHERE EXISTS (SELECT 1 FROM annotations an WHERE an.session_id = s.id AND an.key = 'autonomy'
                             AND json_extract(an.value,'$') = 'autonomous')
                 AND EXISTS (SELECT 1 FROM annotations an WHERE an.session_id = s.id AND an.key = 'complexity'
                             AND json_extract(an.value,'$') IN ('substantial','open-ended'))${a && b ? ' AND s.started_at >= ? AND s.started_at < ?' : ''}`,
            )
            .get(...(a && b ? [a, b] : [])) as { n: number }
        ).n
      const cur = countAC(from, to)
      if (cur >= 2) {
        let delta: number | null = null
        if (from && to) {
          const span = new Date(to).getTime() - new Date(from).getTime()
          const prevFrom = new Date(new Date(from).getTime() - span).toISOString()
          const prev = countAC(prevFrom, from)
          if (prev >= 3) delta = Math.round(((cur - prev) / prev) * 100)
        }
        out.push({ kind: 'autonomy_complex', count: cur, delta })
      }
    }

    return out
  }

  /** Distribution of a scalar annotation value across sessions. */
  private scalarDist(key: string): Dist[] {
    return this.db
      .prepare(
        "SELECT json_extract(value,'$') AS value, COUNT(*) AS count FROM annotations WHERE key = ? GROUP BY value ORDER BY count DESC",
      )
      .all(key) as Dist[]
  }

  /**
   * Windowed cost-per-shipped-artifact KPI (no window = all time). The numerator is
   * the cost of the BLOCKS that produced each in-window completed artifact (block→PR
   * is deterministic; block→feature is the LLM feature_runs). Blocks partition the
   * session, so a session that also did unshipped/other work is NOT charged whole —
   * the old unique-session approximation dissolves (handling_long_sessions P1/P2).
   * Falls back to whole-session cost for any artifact with NO block links (a feature
   * the model never block-linked, or pre-block data). Both paths are at usage grain
   * and UNION-deduped, so a usage row shared across in-window artifacts counts once.
   */
  costPerArtifact(kind: string, from?: string, to?: string, complexity?: string): { count: number; costPerUnit: number | null } {
    const range = from && to ? 'AND a.completed_at >= ? AND a.completed_at < ?' : ''
    const cxFilter = complexityWhere(complexity, 'a', kind)
    const params = from && to ? [kind, from, to] : [kind]
    // Every shipped artifact you CONTRIBUTED to counts — one you authored OR one you
    // only reviewed (any session link) — as long as it's completed/merged, and its
    // FULL cost (production + your review of it) is charged. So the cost-breakdown
    // treemap, which sums the same per-artifact cost, reconciles with this KPI.
    // (Reviewed role is PRs only; the guard is a no-op for features.)
    const contributed =
      kind === 'pr'
        ? "AND EXISTS (SELECT 1 FROM session_artifacts spx WHERE spx.artifact_id = a.id)"
        : ''
    const count = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.kind = ? AND a.completed_at IS NOT NULL ${range} ${contributed} ${cxFilter}`)
        .get(...params) as { n: number }
    ).n
    if (count === 0) return { count: 0, costPerUnit: null }
    const num = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd),0) AS s FROM (
             -- block-attributed: usage rows in blocks linked to an in-window completed
             -- artifact (all roles — production AND your review of it).
             SELECT DISTINCT u.session_id, u.idx AS uidx, u.cost_usd
             FROM artifacts a
             JOIN block_artifacts ba ON ba.artifact_id = a.id
             JOIN block_usage bu ON bu.session_id = ba.session_id AND bu.block_idx = ba.block_idx
             JOIN usage_facts u ON u.session_id = bu.session_id AND u.idx = bu.usage_idx
             WHERE a.kind = ? AND a.completed_at IS NOT NULL ${range} ${contributed} ${cxFilter}
           )`,
        )
        .get(...params) as { s: number }
    ).s
    return { count, costPerUnit: num / count }
  }

  /**
   * The headline KPI row for one time window. Session-grain metrics (count,
   * spend, outcome rate) window by session start; cost-per-artifact windows by
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
    complexity?: string,
  ): {
    burn: Array<{ bucket: string; spend: number; shippedSpend: number }>
    throughput: Array<{ bucket: string; count: number }>
    /** PRs reviewed per bucket, dated at REVIEW time (the pr_reviewed outcome ts). PRs only. */
    reviewed: Array<{ bucket: string; count: number }>
    buckets: string[]
  } {
    // Anchored on usage_facts and dated at message time (COALESCE u.ts → session
    // start), so spend buckets at block-level time granularity (P5), and the
    // converted sub-band greens the BLOCKS linked to a shipped artifact (any role —
    // production or review), not the whole session. kind binds first (CASE), then
    // window. Throughput counts every completed artifact you CONTRIBUTED to (any
    // session link — authored or reviewed); PRs only, no-op for features.
    const contributed =
      kind === 'pr'
        ? "AND EXISTS (SELECT 1 FROM session_artifacts spx WHERE spx.artifact_id = artifacts.id)"
        : ''
    const cxFilter = complexityWhere(complexity, 'a', kind) // for burn subquery (alias `a`)
    const cxFilterBare = complexityWhere(complexity, 'artifacts', kind) // for throughput (bare table name)
    const burnRange = from && to ? 'AND COALESCE(u.ts, s.started_at) >= ? AND COALESCE(u.ts, s.started_at) < ?' : ''
    const burnParams = from && to ? [kind, from, to] : [kind]
    const burn = this.db
      .prepare(
        `SELECT ${bucketExpr('COALESCE(u.ts, s.started_at)', bucket)} AS bucket,
                COALESCE(SUM(u.cost_usd),0) AS spend,
                COALESCE(SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM block_usage bu
                    JOIN block_artifacts ba ON ba.session_id = bu.session_id AND ba.block_idx = bu.block_idx
                    JOIN artifacts a ON a.id = ba.artifact_id
                    WHERE bu.session_id = u.session_id AND bu.usage_idx = u.idx
                      AND a.kind = ? AND a.completed_at IS NOT NULL ${cxFilter}
                  ) THEN u.cost_usd ELSE 0 END),0) AS shippedSpend
         FROM usage_facts u JOIN sessions s ON s.id = u.session_id
         WHERE COALESCE(u.ts, s.started_at) IS NOT NULL ${burnRange}
         GROUP BY bucket ORDER BY bucket`,
      )
      .all(...burnParams) as Array<{ bucket: string; spend: number; shippedSpend: number }>
    const thRange = from && to ? 'AND completed_at >= ? AND completed_at < ?' : ''
    const thParams = from && to ? [kind, from, to] : [kind]
    const throughput = this.db
      .prepare(
        `SELECT ${bucketExpr('completed_at', bucket)} AS bucket, COUNT(*) AS count
         FROM artifacts WHERE kind = ? AND completed_at IS NOT NULL ${thRange} ${contributed} ${cxFilterBare} GROUP BY bucket ORDER BY bucket`,
      )
      .all(...thParams) as Array<{ bucket: string; count: number }>
    // PRs reviewed per bucket, dated at REVIEW time (when you reviewed, not when the
    // PR merged) — sourced from the pr_reviewed outcome. Distinct PRs, so two review
    // sessions on the same PR count once. Features have no review signal → empty.
    const revRange = from && to ? 'AND o.ts >= ? AND o.ts < ?' : ''
    const cxFilterRev = complexityWhere(complexity, 'a', kind)
    const reviewed =
      kind === 'pr'
        ? (this.db
            .prepare(
              `SELECT ${bucketExpr('o.ts', bucket)} AS bucket, COUNT(DISTINCT o.artifact_id) AS count
               FROM outcomes o
               ${cxFilterRev ? 'JOIN artifacts a ON a.id = o.artifact_id' : ''}
               WHERE o.type = 'pr_reviewed' AND o.ts IS NOT NULL ${revRange} ${cxFilterRev}
               GROUP BY bucket ORDER BY bucket`,
            )
            .all(...(from && to ? [from, to] : [])) as Array<{ bucket: string; count: number }>)
        : []
    // The x-axis: over a window, every bucket from `from` to `to` (so empty
    // periods show as gaps and the chart spans the whole window, not just the
    // periods that happen to have data); all-time falls back to the data's own
    // buckets. The series rows stay sparse — the chart zero-fills missing axis
    // buckets — and we still union in any data bucket as a safety net.
    const set = new Set<string>()
    if (from && to) this.bucketAxis(from, to, bucket).forEach((b) => set.add(b))
    burn.forEach((r) => set.add(r.bucket))
    throughput.forEach((r) => set.add(r.bucket))
    reviewed.forEach((r) => set.add(r.bucket))
    return { burn, throughput, reviewed, buckets: Array.from(set).sort() }
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
  costPeriod(kind: string, from?: string, to?: string, complexity?: string): { burn: number; throughput: number; efficiency: number | null } {
    const burnRange = from && to ? 'WHERE started_at >= ? AND started_at < ?' : 'WHERE started_at IS NOT NULL'
    const burnParams = from && to ? [from, to] : []
    const burn = (
      this.db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM sessions ${burnRange}`).get(...burnParams) as {
        s: number
      }
    ).s
    const thRange = from && to ? 'AND completed_at >= ? AND completed_at < ?' : ''
    const thParams = from && to ? [kind, from, to] : [kind]
    // Same "contributed" guard as costPerArtifact, so this throughput (the KPI
    // denominator) matches the cost-per-shipped count exactly: every completed
    // artifact you have a session link to, authored or reviewed (PRs only).
    const contributed =
      kind === 'pr'
        ? "AND EXISTS (SELECT 1 FROM session_artifacts spx WHERE spx.artifact_id = artifacts.id)"
        : ''
    const cxFilter = complexityWhere(complexity, 'artifacts', kind)
    const throughput = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE kind = ? AND completed_at IS NOT NULL ${thRange} ${contributed} ${cxFilter}`)
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
      if (!facetGroupCompatible(gf, 'usage')) return { error: 'incompatible grain' }
      const fg = facetGroupExpr(f, 'usage')
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
   * Session COUNT over time, optionally split into one series per COMPOSITE label
   * — the time-series form of the distribution cards. Each session is labeled by
   * the sorted set of its distinct values for the dimension (e.g. <opus, haiku>)
   * and grouped by it, so every session lands in exactly one series and the
   * counts partition the total (honest to STACK) — no presence-inflation. The
   * tail past top-K collapses into "Other".
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
    if (q.by) {
      const f = this.facet(q.by)
      if (f) {
        // Composite breakdown (mirrors successRate): GROUP BY (bucket, value-set),
        // so each session is counted in exactly one series → the stack is honest.
        const combo = this.comboExpr(f)
        const params: unknown[] = [...combo.params, ...baseParams]
        const rows = this.db
          .prepare(
            `SELECT tb, combo, COUNT(*) AS cnt FROM (
               SELECT ${time} AS tb, ${combo.sql} AS combo
               FROM sessions s WHERE ${baseWhere.join(' AND ')}
             ) t GROUP BY tb, combo ORDER BY tb`,
          )
          .all(...params) as Array<{ tb: string; combo: string | null; cnt: number }>

        // Order members within a combo by global volume (primary-first), which
        // also canonicalizes the key for grouping.
        const rank = new Map<string, number>()
        this.facetDistribution(q.by).forEach((d, i) => { if (d.value != null) rank.set(String(d.value), i) })
        const orderCombo = (c: string): string =>
          c.split(', ').sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : 1)).join(', ')

        const byCombo = new Map<string, CountPoint[]>()
        for (const r of rows) {
          const label = !r.combo ? '(none)' : orderCombo(r.combo)
          const pts = byCombo.get(label) ?? []
          pts.push({ bucket: r.tb, count: r.cnt })
          byCombo.set(label, pts)
        }
        let all: CountSeries[] = [...byCombo.entries()]
          .map(([key, points]) => ({ key, points, total: totals(points) }))
          .sort((a, b) => b.total - a.total)

        if (all.length > topK) {
          // Collapse the tail into "Other" so the stack still sums to the total.
          truncated = { shown: topK, total: all.length }
          const otherByBucket = new Map<string, number>()
          for (const s of all.slice(topK)) {
            for (const p of s.points) otherByBucket.set(p.bucket, (otherByBucket.get(p.bucket) ?? 0) + p.count)
          }
          const otherPts = [...otherByBucket.entries()].map(([bucket, count]) => ({ bucket, count }))
          all = [...all.slice(0, topK), { key: 'Other', points: otherPts, total: totals(otherPts) }]
        }
        series = all
      }
    }

    return { bucket, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated }
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
    // Row-level tool-name scope: restrict which calls are aggregated, so the rate
    // becomes that tool's own (denominator + numerator both shrink to these tools).
    const toolVals = (q.toolNames ?? []).filter(Boolean)
    if (toolVals.length) {
      where.push(`t.name IN (${toolVals.map(() => '?').join(', ')})`)
      params.push(...toolVals)
    }
    const fromSql = 'FROM tool_calls t JOIN sessions s ON s.id = t.session_id'
    const whereSql = 'WHERE ' + where.join(' AND ')
    // Row-level error-category scope: redefine the numerator (which errors count)
    // without touching the denominator — "rate of <these categories> among all
    // in-scope calls". These params bind in the SELECT list, AHEAD of WHERE params.
    const catVals = (q.errorCategories ?? []).filter(Boolean)
    const errPh = catVals.map(() => '?').join(', ')
    const errExpr = catVals.length
      ? `COALESCE(SUM(CASE WHEN t.error_category IN (${errPh}) THEN 1 ELSE 0 END), 0)`
      : 'COALESCE(SUM(t.is_error), 0)'
    const val = (cnt: number, errs: number) => (isRate ? (cnt ? errs / cnt : null) : cnt)

    const overallRows = this.db
      .prepare(`SELECT ${time} AS tb, COUNT(*) AS cnt, ${errExpr} AS errs ${fromSql} ${whereSql} GROUP BY tb ORDER BY tb`)
      .all(...catVals, ...params) as Array<{ tb: string; cnt: number; errs: number }>
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
        .prepare(`SELECT ${time} AS tb, t.name AS nm, COUNT(*) AS cnt, ${errExpr} AS errs ${fromSql} ${whereSql} GROUP BY tb, nm`)
        .all(...catVals, ...params) as Array<{ tb: string; nm: string | null; cnt: number; errs: number }>
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
    } else if (q.by === 'error_category') {
      // Decompose the error rate by category: each line is a category's errored
      // calls over ALL in-scope calls that bucket, so the lines sum to the overall
      // rate. (A per-category denominator would be a flat 100% — the category
      // column only exists on errored rows.) Honest only for the rate view.
      const totalByBucket = new Map(overallRows.map((r) => [r.tb, r.cnt]))
      const catWhere =
        whereSql + ' AND t.error_category IS NOT NULL' + (catVals.length ? ` AND t.error_category IN (${errPh})` : '')
      const rows = this.db
        .prepare(`SELECT ${time} AS tb, t.error_category AS cat, COUNT(*) AS errs ${fromSql} ${catWhere} GROUP BY tb, cat`)
        .all(...params, ...catVals) as Array<{ tb: string; cat: string | null; errs: number }>
      const catLabel = new Map(ERROR_CATEGORIES.map((c) => [c.key, c.label]))
      const byCat = new Map<string, { points: OpsPoint[]; errs: number }>()
      for (const r of rows) {
        if (r.cat == null) continue
        const denom = totalByBucket.get(r.tb) ?? 0
        const e = byCat.get(r.cat) ?? { points: [], errs: 0 }
        e.points.push({ bucket: r.tb, value: denom ? r.errs / denom : null, calls: denom, errors: r.errs })
        e.errs += r.errs
        byCat.set(r.cat, e)
      }
      let all: OpsSeries[] = Array.from(byCat.entries()).map(([key, e]) => ({
        key,
        label: catLabel.get(key) ?? key,
        points: e.points,
        total: tCnt ? e.errs / tCnt : null,
        calls: e.errs, // rank categories by error volume
      }))
      all.sort((a, b) => b.calls - a.calls)
      if (all.length > topK) {
        truncated = { shown: topK, total: all.length }
        all = all.slice(0, topK)
      }
      series = all
    }

    return { view: q.view, bucket, by: q.by, buckets: this.fullAxis(overallPoints.map((p) => p.bucket), bucket, q.from, q.to), overall, series, truncated, format: isRate ? 'pct' : 'int' }
  }

  /** Distinct tool-call names, busiest first — feeds the Ops error-rate tool filter. */
  toolNames(): string[] {
    return (
      this.db
        .prepare('SELECT name FROM tool_calls WHERE name IS NOT NULL GROUP BY name ORDER BY COUNT(*) DESC')
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
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
   * rate is honest). With `by`, returns one series per COMPOSITE label (top-K by
   * volume, the tail collapsed into "Other"): each session is labeled by the
   * sorted set of its distinct values for the dimension (e.g. <opus, haiku>), so
   * every session falls in exactly one series and the bars partition the
   * population — multi-valued sessions are counted once, not fanned out.
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
                          SUM(CASE WHEN ${numPred} THEN 1 ELSE 0 END) AS num,
                          COALESCE(SUM(s.cost_usd),0) AS spend
                   FROM sessions s WHERE ${where.join(' AND ')}
                   GROUP BY bucket ORDER BY bucket`
      const rows = this.db.prepare(sql).all(...params) as Array<{ bucket: string; denom: number; num: number; spend: number }>
      return rows.map((r) => ({ bucket: r.bucket, num: r.num, denom: r.denom, spend: r.spend, rate: r.denom ? r.num / r.denom : null }))
    }

    const totals = (points: RatePoint[]) => {
      const num = points.reduce((a, p) => a + p.num, 0)
      const denom = points.reduce((a, p) => a + p.denom, 0)
      const spend = points.reduce((a, p) => a + p.spend, 0)
      return { num, denom, spend, rate: denom ? num / denom : null }
    }

    const overallPoints = runBuckets('', [])
    const overall: RateSeries = { key: 'overall', points: overallPoints, ...totals(overallPoints) }

    let series: RateSeries[] | undefined
    let truncated: { shown: number; total: number } | undefined
    if (q.by) {
      const f = this.facet(q.by)
      if (f) {
        // Composite breakdown: label each session by the sorted SET of its distinct
        // values (comboExpr is a correlated subquery yielding a ", "-joined string,
        // NULL when empty), then GROUP BY (bucket, combo). Every session lands in
        // exactly one combo, so the bars partition the population — no double-count.
        const combo = this.comboExpr(f)
        const where = ['s.started_at IS NOT NULL', ...filterClauses]
        // SELECT-text param order: combo params, then numPred outcomes, then WHERE filters.
        const params: unknown[] = [...combo.params, ...outcomes, ...filterParams]
        const sql = `SELECT bucket, combo, COUNT(*) AS denom, SUM(has_outcome) AS num, COALESCE(SUM(cost),0) AS spend FROM (
                       SELECT ${bucketExpr('s.started_at', bucket)} AS bucket,
                              ${combo.sql} AS combo,
                              (CASE WHEN ${numPred} THEN 1 ELSE 0 END) AS has_outcome,
                              s.cost_usd AS cost
                       FROM sessions s WHERE ${where.join(' AND ')}
                     ) t GROUP BY bucket, combo ORDER BY bucket`
        const rows = this.db.prepare(sql).all(...params) as Array<{ bucket: string; combo: string | null; denom: number; num: number; spend: number }>

        // Order values WITHIN a combo by global volume so labels read primary-first
        // (opus before haiku), independent of the SQL key's alpha order. Re-sorting
        // in JS also canonicalizes the key, merging any combos SQLite emitted in a
        // different member order.
        const rank = new Map<string, number>()
        this.facetDistribution(q.by).forEach((d, i) => { if (d.value != null) rank.set(String(d.value), i) })
        const orderCombo = (c: string): string =>
          c.split(', ').sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : 1)).join(', ')

        const byCombo = new Map<string, RatePoint[]>()
        for (const r of rows) {
          const label = !r.combo ? '(none)' : orderCombo(r.combo)
          const pts = byCombo.get(label) ?? []
          pts.push({ bucket: r.bucket, num: r.num, denom: r.denom, spend: r.spend, rate: r.denom ? r.num / r.denom : null })
          byCombo.set(label, pts)
        }
        let all: RateSeries[] = [...byCombo.entries()]
          .map(([key, points]) => ({ key, points, ...totals(points) }))
          .sort((a, b) => b.denom - a.denom)

        if (all.length > topK) {
          // Collapse the long tail into a single "Other" series so bars still sum
          // to the bucket total; the client offers "Show all" to expand it.
          truncated = { shown: topK, total: all.length }
          const otherByBucket = new Map<string, RatePoint>()
          for (const s of all.slice(topK)) {
            for (const p of s.points) {
              const acc = otherByBucket.get(p.bucket) ?? { bucket: p.bucket, num: 0, denom: 0, spend: 0, rate: null }
              acc.num += p.num
              acc.denom += p.denom
              acc.spend += p.spend
              otherByBucket.set(p.bucket, acc)
            }
          }
          const otherPts = [...otherByBucket.values()].map((p) => ({ ...p, rate: p.denom ? p.num / p.denom : null }))
          all = [...all.slice(0, topK), { key: 'Other', points: otherPts, ...totals(otherPts) }]
        }
        series = all
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
    } else if (f.source === 'block') {
      // sessions that have a block labeled value (single label per block)
      sql = `SELECT json_extract(value,'$') AS value, COUNT(DISTINCT session_id) AS count
             FROM block_annotations WHERE key = ? GROUP BY value ORDER BY count DESC`
      params.push(f.key)
    } else {
      const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
      const where = f.base ? `WHERE ${f.base}` : ''
      sql = `SELECT ${col} AS value, COUNT(DISTINCT session_id) AS count
             FROM ${table} ${where} GROUP BY ${col} ORDER BY count DESC`
    }
    sql += ' LIMIT 50' // bound high-cardinality facets defensively
    return this.db.prepare(sql).all(...params) as Dist[]
  }

  /**
   * Compile a facet + value into a session-scoped boolean SQL fragment (alias `s`).
   * One compiler, reused by session filters today and cohort splits later. Column
   * identifiers and `base` are registry-defined (trusted); the value is a bound param.
   */
  private facetPredicate(f: FacetSpec, value: string | string[]): { sql: string; params: unknown[] } {
    const col = f.column ?? f.key
    const vals = (Array.isArray(value) ? value : [value]).filter((v) => v != null && v !== '')
    if (vals.length === 0) return { sql: '1=1', params: [] } // empty selection ⇒ no constraint
    // One value keeps today's `= ?` (byte-identical SQL); several become an OR via
    // `IN (?, ?, …)`. `cmp` wraps whichever column/JSON expression each source needs.
    const ph = vals.map(() => '?').join(', ')
    const cmp = (expr: string) => (vals.length === 1 ? `${expr} = ?` : `${expr} IN (${ph})`)
    if (f.source === 'session') {
      return f.multi
        ? { sql: `EXISTS (SELECT 1 FROM json_each(s.${col}) je WHERE ${cmp('je.value')})`, params: vals }
        : { sql: cmp(`s.${col}`), params: vals }
    }
    if (f.source === 'annotation') {
      return f.multi
        ? {
            sql: `EXISTS (SELECT 1 FROM annotations a, json_each(a.value) je
                  WHERE a.session_id = s.id AND a.key = ? AND ${cmp('je.value')})`,
            params: [f.key, ...vals],
          }
        : {
            sql: `EXISTS (SELECT 1 FROM annotations a
                  WHERE a.session_id = s.id AND a.key = ? AND ${cmp("json_extract(a.value,'$')")})`,
            params: [f.key, ...vals],
          }
    }
    if (f.source === 'block') {
      // "sessions with a block labeled <any selected value>" — session-scoped EXISTS, like model/skill.
      return {
        sql: `EXISTS (SELECT 1 FROM block_annotations ba
              WHERE ba.session_id = s.id AND ba.key = ? AND ${cmp("json_extract(ba.value,'$')")})`,
        params: [f.key, ...vals],
      }
    }
    const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
    const base = f.base ? `${f.base} AND ` : ''
    return {
      sql: `EXISTS (SELECT 1 FROM ${table} c WHERE c.session_id = s.id AND ${base}${cmp(`c.${col}`)})`,
      params: vals,
    }
  }

  /**
   * Correlated subquery (alias `s`) yielding a session's DISTINCT values for a
   * facet as one alpha-sorted, ", "-joined string — the composite label for the
   * success-rate breakdown; empty set → NULL. Mirrors facetPredicate's source
   * switch (identifiers/base are registry-defined and trusted, values are data).
   */
  private comboExpr(f: FacetSpec): { sql: string; params: unknown[] } {
    const col = f.column ?? f.key
    const cat = (valExpr: string, from: string, where: string, params: unknown[]) => ({
      sql: `(SELECT group_concat(v, ', ') FROM
             (SELECT DISTINCT ${valExpr} AS v FROM ${from}
              WHERE ${where} AND ${valExpr} IS NOT NULL ORDER BY v))`,
      params,
    })
    if (f.source === 'session') {
      return f.multi
        ? cat('je.value', `json_each(s.${col}) je`, '1=1', [])
        : { sql: `s.${col}`, params: [] }
    }
    if (f.source === 'annotation') {
      return f.multi
        ? cat('je.value', 'annotations a, json_each(a.value) je', 'a.session_id = s.id AND a.key = ?', [f.key])
        : { sql: `(SELECT json_extract(a.value,'$') FROM annotations a WHERE a.session_id = s.id AND a.key = ? LIMIT 1)`, params: [f.key] }
    }
    if (f.source === 'block') {
      return cat(`json_extract(ba.value,'$')`, 'block_annotations ba', 'ba.session_id = s.id AND ba.key = ?', [f.key])
    }
    const table = f.source === 'usage' ? 'usage_facts' : 'tool_calls'
    const base = f.base ? `${f.base} AND ` : ''
    return cat(`c.${col}`, `${table} c`, `${base}c.session_id = s.id`, [])
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
    window?: { from?: string; to?: string },
    toolNames?: string[],
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
    // Window the population to the dashboard's selected range (both bounds or
    // neither); every grain's FROM joins sessions s, so s.started_at is in scope.
    if (window?.from && window?.to) {
      where.push('s.started_at >= ? AND s.started_at < ?')
      params.push(window.from, window.to)
    }
    // Row-level tool-name scope — only sound for tool-call-grain measures (the FROM
    // is `tool_calls t`). Lets the Ops "Errors by category" widget show one tool's
    // errors, matching the error-rate chart's tool filter.
    const toolVals = (toolNames ?? []).filter(Boolean)
    if (toolVals.length && gm !== 'session' && gm !== 'usage') {
      where.push(`t.name IN (${toolVals.map(() => '?').join(', ')})`)
      params.push(...toolVals)
    }
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
      if (!facetGroupCompatible(gf, gm)) return { error: 'incompatible grain' }
      const fg = facetGroupExpr(f, gm)
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

  /**
   * Every failed tool call of one error category — the occurrence list behind the
   * "Errors by category" drill-down. Newest session first; `idx` is the tool call's
   * position in its session, which the transcript anchors as `txerr-<idx>` so a row
   * deep-links to that exact error block. Windowed like breakdown. Capped at 50; the
   * widget shows the true total (the bar count) with a "+N more" note past the cap.
   */
  errorOccurrences(category: string, window?: { from?: string; to?: string }, toolNames?: string[]): ErrorOccurrence[] {
    const where = ['t.error_category = ?']
    const params: unknown[] = [category]
    if (window?.from && window?.to) {
      where.push('s.started_at >= ? AND s.started_at < ?')
      params.push(window.from, window.to)
    }
    // Row-level tool scope, mirroring the widget's tool filter (Bash's timeouts, …).
    const toolVals = (toolNames ?? []).filter(Boolean)
    if (toolVals.length) {
      where.push(`t.name IN (${toolVals.map(() => '?').join(', ')})`)
      params.push(...toolVals)
    }
    const sql = `SELECT t.session_id AS sessionId, ${titleExpr('s')} AS title, t.idx AS idx,
                        t.name AS name, t.action AS action, t.command AS command,
                        t.target_path AS targetPath, t.error_message AS message,
                        t.ts AS ts, s.started_at AS startedAt
                 FROM tool_calls t JOIN sessions s ON s.id = t.session_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY s.started_at DESC, t.idx ASC
                 LIMIT 50`
    return this.db.prepare(sql).all(...params) as ErrorOccurrence[]
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
        `(${scalar('title')} LIKE ? OR s.title LIKE ? OR ${scalar('intent_summary')} LIKE ?
          OR EXISTS (SELECT 1 FROM annotations WHERE session_id=s.id AND key='decisions' AND value LIKE ?))`,
      )
      params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`)
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
    // Window on session start (inclusive lower, exclusive upper).
    if (f.from) {
      clauses.push('s.started_at >= ?')
      params.push(f.from)
    }
    if (f.to) {
      clauses.push('s.started_at < ?')
      params.push(f.to)
    }
    // Outcome-type filter (OR): session produced ANY of the given outcome types.
    const outcomeTypes = (f.outcomeTypes ?? []).filter(Boolean)
    if (outcomeTypes.length) {
      clauses.push(
        `EXISTS (SELECT 1 FROM outcomes o WHERE o.session_id = s.id AND o.type IN (${outcomeTypes
          .map(() => '?')
          .join(',')}))`,
      )
      params.push(...outcomeTypes)
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
    const limit = Math.min(Math.max(1, f.limit ?? 200), 1000)

    const rows = this.db
      .prepare(
        `SELECT s.id AS id, COALESCE(${titleExpr('s')}, '(untitled)') AS title, s.started_at AS startedAt,
                s.cost_usd AS costUsd, s.models AS modelsJson,
                ${scalar('complexity')} AS complexity,
                (SELECT json_group_array(v) FROM (SELECT DISTINCT json_extract(value,'$') AS v FROM block_annotations WHERE session_id=s.id AND key='use_case' ORDER BY v)) AS useCaseJson,
                ${scalar('intent_summary')} AS intent,
                (SELECT json_group_array(t) FROM (SELECT DISTINCT type AS t FROM outcomes WHERE session_id=s.id ORDER BY t)) AS outcomesJson
         FROM sessions s ${where} ORDER BY s.started_at DESC LIMIT ${limit}`,
      )
      .all(...params) as Array<Record<string, any>>

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      startedAt: r.startedAt,
      costUsd: r.costUsd ?? 0,
      models: safeJson(r.modelsJson, []),
      complexity: r.complexity ?? null,
      useCase: safeJson(r.useCaseJson, []),
      intent: r.intent ?? null,
      outcomes: safeJson(r.outcomesJson, []),
    }))
  }

  /** Full detail for one session, including a viewer-ready transcript from the blob. */
  /** Per-block labels (use_case / PR / feature) for the transcript filter bar. */
  private blockLabels(
    id: string,
  ): Map<number, { useCase?: string | null; pr?: { ident: string; title?: string } | null; feature?: { id: string; title?: string } | null }> {
    type Lbl = { useCase?: string | null; pr?: { ident: string; title?: string } | null; feature?: { id: string; title?: string } | null }
    const m = new Map<number, Lbl>()
    const ensure = (idx: number): Lbl => {
      let e = m.get(idx)
      if (!e) { e = {}; m.set(idx, e) }
      return e
    }
    const ucRows = this.db
      .prepare("SELECT block_idx AS idx, json_extract(value,'$') AS v FROM block_annotations WHERE session_id = ? AND key = 'use_case'")
      .all(id) as Array<{ idx: number; v: string }>
    for (const r of ucRows) ensure(r.idx).useCase = r.v
    const artRows = this.db
      .prepare(
        `SELECT ba.block_idx AS idx, a.id AS aid, a.ident, a.title, a.kind
         FROM block_artifacts ba JOIN artifacts a ON a.id = ba.artifact_id
         WHERE ba.session_id = ? AND a.kind IN ('pr','feature')`,
      )
      .all(id) as Array<{ idx: number; aid: string; ident: string | null; title: string | null; kind: string }>
    for (const r of artRows) {
      const e = ensure(r.idx)
      if (r.kind === 'pr') e.pr = { ident: r.ident ?? '?', title: r.title ?? undefined }
      else e.feature = { id: r.aid, title: r.title ?? undefined }
    }
    return m
  }

  sessionDetail(id: string): SessionDetail | null {
    const s = this.db
      .prepare(
        `SELECT id, ${titleExpr('sessions')} AS title, source, provider, repo, branch, started_at AS startedAt, ended_at AS endedAt,
                n_turns AS nTurns, n_tool_calls AS nToolCalls, models AS modelsJson, cost_usd AS costUsd,
                tok_input AS tokInput, tok_output AS tokOutput, tok_cache_create_5m AS tokCacheCreate5m,
                tok_cache_create_1h AS tokCacheCreate1h, tok_cache_read AS tokCacheRead
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

    // One row per artifact: a session can link the same PR under multiple roles
    // (e.g. `created` by outcomes-git + `edited` by pr-content-match for its
    // attribution %), so pick the strongest/most-explicit link for display.
    const artifacts = this.db
      .prepare(
        `SELECT id, kind, title, ident, status, repo, externalId, role, source, confidence FROM (
           SELECT a.id, a.kind, a.title, a.ident, a.status, a.repo, a.external_id AS externalId, sa.role, sa.source,
             MAX(CASE WHEN sa.producer = 'pr-content-match' THEN sa.confidence END) OVER (PARTITION BY a.id) AS confidence,
             ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY
               CASE sa.role WHEN 'created' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'edited' THEN 2 ELSE 3 END,
               CASE COALESCE(sa.source,'') WHEN 'explicit' THEN 0 WHEN 'user' THEN 1 ELSE 2 END) AS rn
           FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id WHERE sa.session_id = ?
         ) WHERE rn = 1`,
      )
      .all(id) as Array<Record<string, any>>

    let transcript: Transcript = { turns: [], subagents: [], blocks: [] }
    const blob = this.db.prepare('SELECT gz FROM session_blobs WHERE id = ?').get(id) as { gz: Buffer } | undefined
    if (blob?.gz) {
      try {
        transcript = buildTranscript(JSON.parse(gunzipSync(blob.gz).toString('utf8')) as Session)
      } catch {
        /* leave empty */
      }
    }
    // Attach per-block labels (use_case / PR / feature) the filter bar groups by.
    if (transcript.blocks.length) {
      const labels = this.blockLabels(id)
      transcript.blocks = transcript.blocks.map((b) => ({ idx: b.idx, ...(labels.get(b.idx) ?? {}) }))
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
          cacheCreate5m: s.tokCacheCreate5m ?? 0,
          cacheCreate1h: s.tokCacheCreate1h ?? 0,
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
    if (f.source === 'block') {
      // the distinct block labels this session exhibits (union rollup, e.g. use_case)
      const rows = this.db
        .prepare(
          `SELECT DISTINCT json_extract(value,'$') AS v FROM block_annotations WHERE session_id = ? AND key = ? ORDER BY v`,
        )
        .all(id, f.key) as Array<{ v: unknown }>
      return rows.map((r) => String(r.v))
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
   * A numbered one-line-per-block digest of a session's main thread (see
   * blockSpine) plus the block partition it was rendered from: each block's
   * opening user turn, a compact action summary, and its boundary tag.
   * Reconstructs the partition from the blob at read time. Returns null when the
   * session's blob is missing or unreadable.
   *
   * The `blocks` ride along so a caller reads the count and each block's startSeq
   * from the same partition the digest was rendered from, rather than re-parsing
   * the string or re-querying the stored blocks table (which can lag the blob).
   *
   * Recomputed on demand rather than stored: it's cheap for the few sessions a
   * P-tier detector inspects, and hands a detector the block digest without
   * exposing the full transcript (loadSession stays private).
   */
  blockDigest(id: string): { digest: string; blocks: Block[] } | null {
    const session = this.loadSession(id)
    if (!session) return null
    const blocks = deterministicBlocks(session)
    return { digest: blockSpine(session, blocks), blocks }
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
      const ref = toolTurn.get(tc.id) ?? { turn: -1, userTurn: -1 }
      // Codex's `apply_patch` stores the raw V4A patch TEXT (a string) and can touch
      // several files in one call. Expand it to one FileEdit per file; the object-shaped
      // path below (Claude Code, OpenCode) handles `{content}` / `{old_string,…}` inputs.
      if (typeof tc.input === 'string') {
        for (const fe of parseApplyPatch(tc.input)) {
          out.push({ ...fe, ts: tc.ts, turn: ref.turn, userTurn: ref.userTurn })
        }
        continue
      }
      const path = tc.target.paths?.[0]
      if (!path) continue
      const input = (tc.input ?? {}) as Record<string, unknown>
      let op: FileEdit['op']
      let hunks: Array<{ del: string; ins: string }>
      // Distinguish write/multiedit/edit by input shape, not the raw tool name —
      // names are case- and vendor-specific (`Write` vs `write`). Field spellings
      // also differ (Claude Code: old_string/new_string; OpenCode: oldString/newString).
      if (Array.isArray(input.edits)) {
        op = 'multiedit'
        hunks = (input.edits as Array<Record<string, unknown>>).map((e) => ({
          del: clip(String(e.old_string ?? e.oldString ?? e.oldText ?? ''), 4000),
          ins: clip(String(e.new_string ?? e.newString ?? e.newText ?? ''), 4000),
        }))
      } else if (input.content != null) {
        op = 'write'
        // Cap is generous because consecutive writes are diffed against each
        // other client-side; too small a window hides changes near the file end.
        hunks = [{ del: '', ins: clip(String(input.content ?? ''), 16000) }]
      } else {
        op = 'edit'
        hunks = [
          {
            del: clip(String(input.old_string ?? input.oldString ?? ''), 4000),
            ins: clip(String(input.new_string ?? input.newString ?? ''), 4000),
          },
        ]
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
  artifactList(kind?: string, complexity?: string, from?: string, to?: string, shippedOnly = false): ArtifactListItem[] {
    const allowed = ['pr', 'feature', 'ticket']
    const kinds = kind && allowed.includes(kind) ? [kind] : ['pr', 'feature']
    const placeholders = kinds.map(() => '?').join(',')
    // Complexity filter (buckets → this artifact's own complexity). No-op unless a
    // single kind is requested — the bucket→value mapping differs by kind.
    const cxFilter = complexityWhere(complexity, 'a', kind)
    // Completion window: keep only artifacts completed (PR merged) in [from,to], to
    // match the cost-per-artifact KPI's basis — the per-artifact cost stays all-time;
    // the window selects which artifacts count. No window (all-time) keeps every row,
    // including still-open PRs (the Artifacts tab relies on that).
    const range = from && to ? 'AND a.completed_at >= ? AND a.completed_at < ?' : ''
    const winParams = from && to ? [from, to] : []
    // Shipped/merged-only (the cost-breakdown treemap): require a completion date so
    // only shipped artifacts show — the same basis as costPerArtifact (which counts
    // every completed artifact you contributed to, at full cost), so the tiles
    // reconcile with the KPI. The HAVING clause below already requires a session link,
    // so a merged PR you only reviewed still qualifies. The Artifacts tab leaves this
    // off to list open/un-shipped rows too.
    const shippedFilter = shippedOnly ? 'AND a.completed_at IS NOT NULL' : ''
    const rows = this.db
      .prepare(
        `SELECT a.id, a.kind, a.title, a.ident, a.repo, a.status, a.source,
                a.external_id AS externalId, a.created_at AS createdAt, a.completed_at AS completedAt,
                a.parent_artifact_id AS parentId, a.complexity, a.complexity_basis AS complexityBasis,
                -- AI-attribution % = pr-content-match's confidence only (other producers write
                -- confidence on session_artifacts too, e.g. review links).
                MAX(CASE WHEN sa.producer = 'pr-content-match' THEN sa.confidence END) AS aiPct,
                COUNT(DISTINCT sa.session_id) AS sessions,
                COALESCE((
                  SELECT SUM(cost_usd) FROM (
                    -- block-attributed cost (block→artifact): blocks partition the
                    -- session, so a multi-purpose session isn't charged whole (P1).
                    SELECT DISTINCT u.session_id, u.idx AS uidx, u.cost_usd
                    FROM block_artifacts ba
                    JOIN block_usage bu ON bu.session_id = ba.session_id AND bu.block_idx = ba.block_idx
                    JOIN usage_facts u ON u.session_id = bu.session_id AND u.idx = bu.usage_idx
                    WHERE ba.artifact_id = a.id
                  )
                ), 0) AS costUsd
         FROM artifacts a
         LEFT JOIN session_artifacts sa ON sa.artifact_id = a.id
         WHERE a.kind IN (${placeholders}) ${cxFilter} ${range} ${shippedFilter}
         GROUP BY a.id
         HAVING (COUNT(DISTINCT sa.session_id) > 0 OR COALESCE(a.source,'') = 'user')
         ORDER BY COALESCE(a.created_at, a.completed_at) DESC, costUsd DESC`,
      )
      .all(...kinds, ...winParams) as ArtifactListItem[]
    // Attach the repos each row spans and its last session time. Features use the
    // subtree union/max (an epic spans/aggregates everything under it); other
    // kinds (PRs) just carry their own repo and aren't shown a last-session time.
    const hasFeature = rows.some((r) => r.kind === 'feature')
    const repoSets = hasFeature ? this.featureRepoSets() : null
    const lastSession = hasFeature ? this.featureLastSession() : null
    for (const r of rows) {
      r.repos = r.kind === 'feature' ? (repoSets?.get(r.id) ?? []) : r.repo ? [r.repo] : []
      r.lastSessionAt = r.kind === 'feature' ? (lastSession?.get(r.id) ?? null) : null
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
   * Per-feature cost rolled up over the feature hierarchy, for the hierarchical
   * cost-breakdown charts. `ownCost` is the spend attributed DIRECTLY to a feature
   * (the same block-attributed-with-whole-session-fallback cost as the artifactList
   * column); `subtreeCost` adds every descendant's own cost, so a parent epic
   * reflects the total invested beneath it (subtreeCost − Σ children.subtreeCost =
   * ownCost). All-time, not windowed: total investment per feature, matching the
   * artifactList cost semantics. Cycle-safe + memoized, mirroring featureLastSession.
   * parentId is normalized to null when it doesn't point at another feature, so the
   * client can treat such rows as roots.
   */
  featureCostTree(complexity?: string, from?: string, to?: string): Array<{
    id: string
    title: string | null
    parentId: string | null
    ownCost: number
    subtreeCost: number
  }> {
    // Complexity filter on each feature's own ordinal. Applied identically to the
    // node set and the cost query below, so survivors stay consistent; orphaned
    // children (parent filtered out) re-root and subtreeCost rolls up only the
    // surviving descendants — see the parentId/children normalization below.
    const cxNodes = complexityWhere(complexity, 'artifacts', 'feature')
    const cxCost = complexityWhere(complexity, 'a', 'feature')
    // Only SHIPPED features (completed_at set) — the treemap decomposes the
    // cost-per-shipped-feature KPI, so un-shipped features are excluded (matching
    // costPerArtifact). A window further bounds it to features shipped in [from,to];
    // per-feature cost stays all-time (the window picks which features count, not
    // which spend). No window = all shipped features.
    const win = from && to
    const rangeNodes = win ? 'AND completed_at >= ? AND completed_at < ?' : ''
    const rangeCost = win ? 'AND a.completed_at >= ? AND a.completed_at < ?' : ''
    const winParams = win ? [from, to] : []
    const rows = this.db
      .prepare(
        `SELECT id, title, parent_artifact_id AS parentId
         FROM artifacts WHERE kind = 'feature' AND completed_at IS NOT NULL ${cxNodes} ${rangeNodes}`,
      )
      .all(...winParams) as Array<{ id: string; title: string | null; parentId: string | null }>
    if (!rows.length) return []
    // Own (direct) cost per feature — identical attribution to artifactList's cost
    // column: purely block-attributed (a feature with no block links contributes zero;
    // DISTINCT so a shared usage row counts once).
    const costRows = this.db
      .prepare(
        `SELECT a.id AS id, COALESCE((
           SELECT SUM(cost_usd) FROM (
             SELECT DISTINCT u.session_id, u.idx AS uidx, u.cost_usd
             FROM block_artifacts ba
             JOIN block_usage bu ON bu.session_id = ba.session_id AND bu.block_idx = ba.block_idx
             JOIN usage_facts u ON u.session_id = bu.session_id AND u.idx = bu.usage_idx
             WHERE ba.artifact_id = a.id
           )
         ), 0) AS ownCost
         FROM artifacts a WHERE a.kind = 'feature' AND a.completed_at IS NOT NULL ${cxCost} ${rangeCost}`,
      )
      .all(...winParams) as Array<{ id: string; ownCost: number }>
    const own = new Map<string, number>()
    for (const r of costRows) own.set(r.id, r.ownCost || 0)

    const children = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.parentId || !own.has(r.parentId)) continue
      const arr = children.get(r.parentId)
      if (arr) arr.push(r.id)
      else children.set(r.parentId, [r.id])
    }
    const memo = new Map<string, number>()
    const onStack = new Set<string>()
    const subtreeCost = (id: string): number => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      let sum = own.get(id) ?? 0
      if (!onStack.has(id)) {
        onStack.add(id)
        for (const c of children.get(id) ?? []) sum += subtreeCost(c)
        onStack.delete(id)
      }
      memo.set(id, sum)
      return sum
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      parentId: r.parentId && own.has(r.parentId) ? r.parentId : null,
      ownCost: own.get(r.id) ?? 0,
      subtreeCost: subtreeCost(r.id),
    }))
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
  createFeature(title: string, parentId?: string, complexity?: number): { id: string } {
    const id = `feature:user:${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, title, source, created_at, parent_artifact_id, complexity, complexity_basis)
         VALUES (?, 'feature', ?, 'user', ?, ?, ?, ?)`,
      )
      .run(id, title, new Date().toISOString(), parentId ?? null, complexity ?? null, complexity != null ? 'user_tagged' : null)
    return { id }
  }

  /** Mark complete/reopen, rename, reparent, or set complexity of a feature. */
  updateFeature(id: string, patch: { completed?: boolean; parentId?: string | null; title?: string; complexity?: number | null }): boolean {
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
    if (patch.complexity !== undefined) {
      this.db.prepare('UPDATE artifacts SET complexity = ?, complexity_basis = ? WHERE id = ?').run(
        patch.complexity, patch.complexity !== null ? 'user_tagged' : null, id,
      )
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
  /**
   * Delete sessions whose parse_version is below the current version for their
   * source — these are sessions the parser now returns null for (e.g. synthetic-only).
   */
  pruneStaleSessionsByVersion(versionBySource: Map<string, number>): number {
    let total = 0
    for (const [source, version] of versionBySource) {
      const r = this.db
        .prepare('DELETE FROM sessions WHERE source = ? AND parse_version < ?')
        .run(source, version)
      total += r.changes
    }
    return total
  }

  pruneOrphanedBranchSessions(prefix: string, currentIds: Set<string>): number {
    // Match the exact primary id OR its branch children (`prefix~<leaf>`) only —
    // not a bare `prefix%`, which would also catch an unrelated session whose id
    // merely starts with these bytes (e.g. `pi:abc` vs `pi:abcd`).
    const stored = this.db
      .prepare("SELECT id FROM sessions WHERE id = ? OR id LIKE ? || '~%'")
      .all(prefix, prefix) as Array<{ id: string }>
    let pruned = 0
    for (const row of stored) {
      if (!currentIds.has(row.id)) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
        pruned++
      }
    }
    return pruned
  }

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

  // ---- session-link management (dashboard writes) ----------------------------

  /** Link an existing artifact to a session (user-authored, never overwritten by processors). Clears any prior rejection tombstone. */
  addSessionLink(sessionId: string, artifactId: string, role: SessionArtifactRole = 'contributed'): boolean {
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
    const artifact = this.db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get(artifactId)
    if (!session || !artifact) return false
    this.db.transaction(() => {
      this.linkUserArtifact(sessionId, artifactId, role)
      this.db.prepare('DELETE FROM user_link_overrides WHERE session_id = ? AND artifact_id = ?').run(sessionId, artifactId)
    })()
    return true
  }

  /** Reject a session→artifact link: delete existing rows and insert a tombstone so re-enrichment won't recreate it. */
  rejectSessionLink(sessionId: string, artifactId: string): boolean {
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
    if (!session) return false
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_artifacts WHERE session_id = ? AND artifact_id = ?').run(sessionId, artifactId)
      this.db.prepare('DELETE FROM block_artifacts WHERE session_id = ? AND artifact_id = ?').run(sessionId, artifactId)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO user_link_overrides (session_id, artifact_id, action, created_at)
           VALUES (?, ?, 'reject', ?)`,
        )
        .run(sessionId, artifactId, new Date().toISOString())
      this.invalidateSessionProcessors(sessionId)
    })()
    return true
  }

  /**
   * Mark every processor run for a session stale so the next analyze re-runs them.
   *
   * Called on any user link/unlink. The user-linked set feeds enrichment, and
   * unlink deletes block_artifacts across producers, so the deterministic
   * processors (outcomes-git) must re-derive too — enrich-only invalidation
   * would leave their wiped rows unregenerated. We flag rather than delete so
   * the row's cost_usd/tokens survive; persistResult resets the flag on the
   * next successful run. Cost: at most one extra analyze per explicit user
   * action (not on every analyze).
   */
  private invalidateSessionProcessors(sessionId: string): void {
    this.db.prepare('UPDATE processor_runs SET invalidated = 1 WHERE session_id = ?').run(sessionId)
  }

  /**
   * The single writer for user-created session links. Every dashboard link path
   * funnels through here so the write and its cache invalidation can never drift
   * apart (that drift is how add-pr/create-feature previously skipped it). Call
   * within the caller's own transaction so the link and invalidation commit atomically.
   */
  private linkUserArtifact(sessionId: string, artifactId: string, role: SessionArtifactRole = 'contributed'): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_artifacts (session_id, artifact_id, role, source, confidence, producer)
         VALUES (?, ?, ?, 'user', 1.0, 'dashboard')`,
      )
      .run(sessionId, artifactId, role)
    this.invalidateSessionProcessors(sessionId)
  }

  /** Titles of features the user rejected for this session (for LLM prompt context). */
  rejectedFeatureTitles(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT a.title FROM user_link_overrides o
         JOIN artifacts a ON a.id = o.artifact_id
         WHERE o.session_id = ? AND o.action = 'reject' AND a.kind = 'feature' AND a.title IS NOT NULL`,
      )
      .all(sessionId) as Array<{ title: string }>
    return rows.map((r) => r.title)
  }

  /** Blocks already attributed to PRs for a session (deterministic, from outcomes-git). */
  prBlockAttributions(sessionId: string): Array<{ blockIdx: number; artifactId: string; title: string | null }> {
    return this.db
      .prepare(
        `SELECT ba.block_idx AS blockIdx, ba.artifact_id AS artifactId, a.title
         FROM block_artifacts ba
         JOIN artifacts a ON a.id = ba.artifact_id
         WHERE ba.session_id = ? AND a.kind = 'pr' AND COALESCE(ba.role,'') <> 'reviewed' AND ba.producer <> 'enrich-session'`,
      )
      .all(sessionId) as Array<{ blockIdx: number; artifactId: string; title: string | null }>
  }

  /** All user-linked PRs/features for a session, with a flag indicating deterministic block ownership. */
  userLinkedArtifactsAll(sessionId: string): Array<{ artifactId: string; kind: 'pr' | 'feature'; title: string | null; ident: string | null; hasNonEnrichBlocks: boolean }> {
    return (this.db
      .prepare(
        `SELECT a.id AS artifactId, a.kind, a.title, a.ident,
                EXISTS(SELECT 1 FROM block_artifacts ba
                       WHERE ba.session_id = sa.session_id
                         AND ba.artifact_id = sa.artifact_id
                         AND ba.producer <> 'enrich-session') AS hasNonEnrichBlocks
         FROM session_artifacts sa
         JOIN artifacts a ON a.id = sa.artifact_id
         WHERE sa.session_id = ? AND sa.source = 'user' AND a.kind IN ('pr', 'feature')`,
      )
      .all(sessionId) as Array<{ artifactId: string; kind: 'pr' | 'feature'; title: string | null; ident: string | null; hasNonEnrichBlocks: number }>)
      .map((r) => ({ ...r, hasNonEnrichBlocks: r.hasNonEnrichBlocks === 1 }))
  }

  /** Create a new feature and link it to a session in one transaction. */
  createAndLinkFeature(sessionId: string, title: string, parentId?: string): { id: string } | null {
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
    if (!session) return null
    let id: string | undefined
    this.db.transaction(() => {
      id = this.createFeature(title, parentId).id
      this.linkUserArtifact(sessionId, id)
    })()
    return { id: id! }
  }

  /** Upsert a PR artifact and link it to a session. */
  upsertAndLinkPr(
    sessionId: string,
    repo: string,
    prNumber: string,
    meta?: { title?: string; status?: string; externalId?: string },
  ): { id: string } | null {
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
    if (!session) return null
    const id = `pr:${repo}:${prNumber}`
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO artifacts (id, kind, repo, ident, external_id, source, title, status, producer)
           VALUES (?, 'pr', ?, ?, ?, 'user', ?, ?, 'dashboard')
           ON CONFLICT(id) DO UPDATE SET
             title = COALESCE(excluded.title, artifacts.title),
             status = COALESCE(excluded.status, artifacts.status),
             external_id = COALESCE(excluded.external_id, artifacts.external_id)`,
        )
        .run(id, repo, prNumber, meta?.externalId ?? null, meta?.title ?? null, meta?.status ?? null)
      this.linkUserArtifact(sessionId, id)
    })()
    return { id }
  }

  /** Typeahead for linkable artifacts (excludes those already linked to the session). */
  suggestLinkableArtifacts(
    sessionId: string,
    q: string,
    kind?: string,
    limit = 10,
  ): Array<{ id: string; kind: string; label: string }> {
    const term = q.trim()
    if (!term) return []
    const { sql: searchSql, params } = this.artifactSearchCond(term, 'a')
    if (kind) params.push(kind)
    params.push(sessionId)
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT a.id, a.kind, a.ident, a.title, a.repo, a.status
         FROM artifacts a
         WHERE ${searchSql}
           ${kind ? 'AND a.kind = ?' : ''}
           AND a.id NOT IN (SELECT artifact_id FROM session_artifacts WHERE session_id = ?)
         ORDER BY CASE a.kind WHEN 'feature' THEN 0 WHEN 'pr' THEN 1 WHEN 'commit' THEN 2 ELSE 3 END,
                  COALESCE(a.title, a.ident)
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, any>>
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      label:
        r.kind === 'pr'
          ? `${r.repo || ''} #${r.ident || ''}${r.title ? ' — ' + r.title : ''}${r.status ? ' (' + r.status + ')' : ''}`
          : String(r.title || r.ident || r.id),
    }))
  }

  // ---- Insight Ledger ---------------------------------------------------------

  /**
   * Read-only query helper for detectors. Uses a separate readonly DB handle so
   * writes are rejected at the SQLite engine level — not just by convention.
   * Detectors can ask any question across all sessions but cannot mutate data.
   */
  queryAll(sql: string, ...params: unknown[]): unknown[] {
    return this.getReadonlyDb().prepare(sql).all(...params)
  }

  queryOne(sql: string, ...params: unknown[]): unknown {
    return this.getReadonlyDb().prepare(sql).get(...params)
  }

  /**
   * Hydrate a full `Session` from its stored blob for a P/X-tier detector — the
   * content SQL-only detectors can't reach. Null when the blob is absent/corrupt.
   */
  hydrateSession(id: string): Session | null {
    return this.loadSession(id)
  }

  detectorRun(detector: string): DetectorRunRow | undefined {
    const row = this.db.prepare('SELECT version, status, ran_at as ranAt FROM detector_runs WHERE detector = ?').get(detector) as
      | { version: number; status: string | null; ranAt: string }
      | undefined
    return row ? { version: row.version, status: row.status, ranAt: row.ranAt } : undefined
  }

  /**
   * Returns session IDs that a detector hasn't seen yet or whose content has changed
   * since the detector last processed them. Used by P/X-tier detectors to compute
   * the delta — only run expensive LLM analysis on new/changed sessions.
   */
  detectorUnseen(detector: string): Array<{ sessionId: string; contentHash: string }> {
    return this.db.prepare(`
      SELECT s.id as sessionId, s.content_hash as contentHash
      FROM sessions s
      LEFT JOIN detector_session_runs d ON d.detector = ? AND d.session_id = s.id
      WHERE d.session_id IS NULL OR d.content_hash != s.content_hash
    `).all(detector) as Array<{ sessionId: string; contentHash: string }>
  }

  /**
   * Mark sessions as seen by a detector at their current content hash.
   * Called after a P/X-tier detector has processed a session's data.
   */
  markDetectorSessionSeen(detector: string, sessions: Array<{ sessionId: string; contentHash: string }>): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO detector_session_runs (detector, session_id, content_hash, ran_at)
       VALUES (?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const s of sessions) {
        stmt.run(detector, s.sessionId, s.contentHash, now)
      }
    })()
  }

  /**
   * Forget a detector's per-session tracking so its whole corpus counts as unseen
   * again. The runner calls this when a P/X-tier detector's version changed since
   * its last run: a new prompt/schema must re-extract every session, not just the
   * content-hash delta. Themes themselves are untouched — re-extraction re-matches
   * against them (stable ids), it doesn't wipe the taxonomy.
   */
  resetDetectorSessionRuns(detector: string): void {
    this.db.prepare('DELETE FROM detector_session_runs WHERE detector = ?').run(detector)
  }

  // ---- Recurring-theme mining -------------------------------------------------

  /**
   * Themes visible to a session's extraction: its repo's themes + globals (repo
   * NULL). Fed into the prompt as the existing-theme list so the model matches
   * before minting (assign-at-extraction). Ordered oldest-first so the merge
   * pass's "keep the older id" rule has a stable reference.
   */
  listThemes(repo: string | null): ThemeRef[] {
    return this.db
      .prepare(
        `SELECT id, COALESCE(label,'') AS label, description, COALESCE(type,'other') AS type, repo
         FROM theme WHERE repo IS NULL OR repo = ? ORDER BY first_seen`,
      )
      .all(repo ?? '') as ThemeRef[]
  }

  /** Every theme (all repos + globals) — the merge pass's input. */
  allThemes(): ThemeRef[] {
    return this.db
      .prepare(`SELECT id, COALESCE(label,'') AS label, description, COALESCE(type,'other') AS type, repo, source FROM theme ORDER BY first_seen`)
      .all() as ThemeRef[]
  }

  /**
   * Persist one session's extraction: upsert referenced themes (OR IGNORE keeps
   * identity stable — re-minting an existing id never renames/retypes it), replace
   * that session's events, then prune derived themes left with no member events.
   * All-in-one transaction so a session's events and their themes commit together.
   */
  persistThemeExtraction(sessionId: string, themes: ThemeInput[], events: ThemeEventInput[]): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const t of themes) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO theme (id, label, description, type, remedy, repo, source, first_seen)
             VALUES (?,?,?,?,?,?,'derived',?)`,
          )
          .run(t.id, t.label, t.description ?? null, t.type, t.remedy ?? null, t.repo ?? null, t.firstSeen ?? now)
      }
      this.db.prepare('DELETE FROM theme_events WHERE session_id = ?').run(sessionId)
      for (const e of events) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO theme_events (session_id, idx, turn_seq, type, trigger, description, theme_id, added_at, occurred_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(sessionId, e.idx, e.turnSeq ?? null, e.type, e.trigger, e.description, e.themeId ?? null, now, e.occurredAt ?? null)
      }
      // Prune derived themes with no surviving member events (a re-extraction may
      // have moved the last event off a theme). Kept from pruning: resolved themes
      // (so a recurrence can reopen them), and any theme still backing a live
      // (non-dismissed) insight — else a version-bump full re-extract could delete
      // a surfaced theme mid-run and orphan its insight. User themes never prune.
      this.db
        .prepare(
          `DELETE FROM theme WHERE source = 'derived' AND resolved = 0
             AND id NOT IN (SELECT DISTINCT theme_id FROM theme_events WHERE theme_id IS NOT NULL)
             AND id NOT IN (SELECT signal_key FROM insights WHERE detector = 'recurring-themes' AND state != 'dismissed')`,
        )
        .run()
    })()
  }

  /**
   * Apply one theme merge: re-point every member event of `dropId` to `keepId`,
   * then delete the absorbed theme. Only derived themes are absorbed. Returns
   * false if either id is missing or they're equal. (Rewording the keeper is a
   * separate step — see retitleTheme.)
   */
  applyThemeMerge(keepId: string, dropId: string): boolean {
    return this.db.transaction(() => {
      const keep = this.db.prepare('SELECT id FROM theme WHERE id = ?').get(keepId)
      const drop = this.db.prepare("SELECT id FROM theme WHERE id = ? AND source <> 'user'").get(dropId)
      if (!keep || !drop || keepId === dropId) return false
      this.db.prepare('UPDATE theme_events SET theme_id = ? WHERE theme_id = ?').run(keepId, dropId)
      this.db.prepare('DELETE FROM theme WHERE id = ?').run(dropId)
      return true
    })()
  }

  /**
   * Friction events the extractor recorded but couldn't confidently attach to a
   * theme (varied wording, or a sibling session minted the theme concurrently so
   * it wasn't yet visible). Grouped by session repo so the reconcile pass can scope
   * a minted theme correctly. Most recent first.
   */
  orphanThemeEvents(): Array<{ sessionId: string; idx: number; repo: string | null; type: string; description: string }> {
    return this.db
      .prepare(
        `SELECT e.session_id AS sessionId, e.idx, s.repo, e.type, e.description
         FROM theme_events e JOIN sessions s ON s.id = e.session_id
         WHERE e.theme_id IS NULL ORDER BY e.added_at DESC, e.session_id, e.idx`,
      )
      .all() as Array<{ sessionId: string; idx: number; repo: string | null; type: string; description: string }>
  }

  /** Attach a previously-orphaned event to a theme (the reconcile pass's write). */
  assignThemeEvent(sessionId: string, idx: number, themeId: string): void {
    this.db.prepare('UPDATE theme_events SET theme_id = ? WHERE session_id = ? AND idx = ?').run(themeId, sessionId, idx)
  }

  /** Mint a derived theme if absent (INSERT OR IGNORE — never renames an existing id). */
  ensureTheme(input: ThemeInput): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO theme (id, label, description, type, remedy, repo, source, first_seen)
         VALUES (?,?,?,?,?,?,'derived',?)`,
      )
      .run(input.id, input.label, input.description ?? null, input.type, input.remedy ?? null, input.repo ?? null, input.firstSeen ?? now)
  }

  /** Rewrite a derived theme's wording (label/description). Never touches a user theme. */
  retitleTheme(id: string, label?: string, description?: string): void {
    if (!label && !description) return
    const row = this.db.prepare("SELECT source FROM theme WHERE id = ?").get(id) as { source: string } | undefined
    if (!row || row.source === 'user') return
    if (label) this.db.prepare('UPDATE theme SET label = ? WHERE id = ?').run(label, id)
    if (description) this.db.prepare('UPDATE theme SET description = ? WHERE id = ?').run(description, id)
  }

  /**
   * Every theme with its member events aggregated — the surfacing step's input.
   * `sessionCount` and `eventCount` drive the recurrence threshold; `descriptions`
   * and `evidence` feed the insight's copy + drill-in pointers.
   */
  themesWithEvents(): Array<{
    id: string
    label: string
    description: string | null
    type: string
    remedy: string | null
    repo: string | null
    resolved: number
    fixType: string | null
    fixContent: string | null
    fixHash: string | null
    eventCount: number
    sessionCount: number
    evidence: Array<{ sessionId: string; turnSeq: number | null; description: string }>
    descriptions: string[]
    // Real friction window from the member events' message timestamps (null until a
    // post-schema-17 re-extraction populates occurred_at).
    firstSeenAt: string | null
    lastSeenAt: string | null
  }> {
    const themes = this.db
      .prepare(
        `SELECT id, COALESCE(label,'') AS label, description, COALESCE(type,'other') AS type, remedy, repo, resolved,
                fix_type AS fixType, fix_content AS fixContent, fix_hash AS fixHash
         FROM theme ORDER BY first_seen`,
      )
      .all() as Array<{
        id: string; label: string; description: string | null; type: string; remedy: string | null; repo: string | null
        resolved: number; fixType: string | null; fixContent: string | null; fixHash: string | null
      }>
    const evStmt = this.db.prepare(
      `SELECT session_id AS sessionId, turn_seq AS turnSeq, description, occurred_at AS occurredAt
       FROM theme_events WHERE theme_id = ? ORDER BY added_at DESC, session_id, idx`,
    )
    return themes.map((t) => {
      const evs = evStmt.all(t.id) as Array<{ sessionId: string; turnSeq: number | null; description: string; occurredAt: string | null }>
      const sessions = new Set(evs.map((e) => e.sessionId))
      // Friction window = min/max of the events' message timestamps. Ignore nulls
      // (pre-schema-17 rows); all-null → null (caller falls back).
      const times = evs.map((e) => e.occurredAt).filter((x): x is string => !!x).sort()
      return {
        ...t,
        eventCount: evs.length,
        sessionCount: sessions.size,
        evidence: evs.map((e) => ({ sessionId: e.sessionId, turnSeq: e.turnSeq, description: e.description })),
        descriptions: evs.map((e) => e.description),
        firstSeenAt: times[0] ?? null,
        lastSeenAt: times[times.length - 1] ?? null,
      }
    })
  }

  /** Flag/unflag a theme resolved — keeps it in the extraction feed after its insight resolves. */
  setThemeResolved(id: string, resolved: boolean): void {
    this.db.prepare('UPDATE theme SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id)
  }

  /** Cache a theme's LLM-generated fix + the hash of the occurrence set it was built from. */
  setThemeFix(id: string, fixType: string, fixContent: string, fixHash: string): void {
    this.db.prepare('UPDATE theme SET fix_type = ?, fix_content = ?, fix_hash = ? WHERE id = ?').run(fixType, fixContent, fixHash, id)
  }

  /**
   * The lifecycle state + last-persisted occurrence count of an existing insight,
   * or null if none exists yet. A detector reads this before re-surfacing a theme
   * so a dismissed insight stays gone and a resolved one only reopens on a GENUINE
   * recurrence (new occurrences)
   */
  insightStatus(detector: string, repo: string, signalKey: string): { state: InsightState; count: number } | null {
    const row = this.db
      .prepare('SELECT state, count FROM insights WHERE detector = ? AND repo = ? AND signal_key = ?')
      .get(detector, repo, signalKey) as { state: string; count: number } | undefined
    return row ? { state: row.state as InsightState, count: row.count } : null
  }

  /**
   * Retire a theme's insight so it stops showing — used when the theme was absorbed
   * by a merge (its id is gone) OR when the fix pass later vetoes it (no longer worth
   * surfacing). Marked resolved with a state-log entry, not deleted, so its history
   * and any adoption survive. No-op if there's no insight for that theme or it's
   * already terminal.
   */
  retireInsightForTheme(detector: string, signalKey: string): void {
    const row = this.db
      .prepare("SELECT id, state FROM insights WHERE detector = ? AND signal_key = ?")
      .get(detector, signalKey) as { id: string; state: string } | undefined
    if (!row || row.state === 'resolved' || row.state === 'dismissed') return
    const now = new Date().toISOString()
    this.db.prepare('UPDATE insights SET state = ?, state_changed_at = ? WHERE id = ?').run('resolved', now, row.id)
    this.logInsightState(row.id, row.state as InsightState, 'resolved', now)
  }

  /**
   * Resolve an insight by its (detector, repo, signalKey) triple — for a detector that
   * stops emitting a still-open insight, so no stale surfaced row lingers. No-op if absent or already terminal.
   */
  resolveInsight(detector: string, repo: string, signalKey: string): void {
    const row = this.db
      .prepare('SELECT id, state FROM insights WHERE detector = ? AND repo = ? AND signal_key = ?')
      .get(detector, repo, signalKey) as { id: string; state: string } | undefined
    if (!row || row.state === 'resolved' || row.state === 'dismissed') return
    const now = new Date().toISOString()
    this.db.prepare('UPDATE insights SET state = ?, state_changed_at = ? WHERE id = ?').run('resolved', now, row.id)
    this.logInsightState(row.id, row.state as InsightState, 'resolved', now)
  }

  /**
   * Fetch the actual user-turn text for a set of (sessionId, seq) evidence
   * pointers, live from the session blobs — so merge/fix prompts can show the
   * user's real words without storing a snippet copy. Hydrates each session once.
   * Missing/pruned turns are simply omitted. Text is returned verbatim (callers clip).
   */
  turnTexts(refs: Array<{ sessionId: string; seq: number | null }>): Map<string, string> {
    const out = new Map<string, string>() // key: `${sessionId}:${seq}`
    const bySession = new Map<string, number[]>()
    for (const r of refs) {
      if (r.seq == null) continue
      const list = bySession.get(r.sessionId) ?? []
      list.push(r.seq)
      bySession.set(r.sessionId, list)
    }
    for (const [sessionId, seqs] of bySession) {
      const session = this.loadSession(sessionId)
      if (!session) continue
      const want = new Set(seqs)
      for (const ev of session.events) {
        if (ev.kind !== 'user' || ev.isSidechain || ev.seq == null || !want.has(ev.seq)) continue
        out.set(`${sessionId}:${ev.seq}`, ev.text.replace(/\s+/g, ' ').trim())
      }
    }
    return out
  }

  persistInsights(detector: string, version: number, inputs: InsightInput[], cost?: { inTokens: number; outTokens: number; usd: number; model?: string }): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const input of inputs) {
        // Real occurrence times when the detector sources them (recurring-themes reads
        // the events' message timestamps); else the analyze-run time as a coarse floor.
        const lastSeen = input.lastSeenAt ?? now
        const firstSeen = input.firstSeenAt ?? now
        const existing = this.db
          .prepare('SELECT id, state FROM insights WHERE detector = ? AND repo = ? AND signal_key = ?')
          .get(detector, input.repo, input.signalKey) as { id: string; state: string } | undefined

        if (existing && existing.state === 'dismissed') continue

        // A fix-prompt that doesn't embed its own insight id can never adopt —
        // a detector bug worth failing loudly on (the runner records the error).
        if (input.fix.type === 'fix-prompt' && !input.fix.content.includes(insightId(detector, input.repo, input.signalKey))) {
          throw new Error(`detector ${detector}: fix-prompt for "${input.signalKey}" does not embed its insight id`)
        }

        if (existing) {
          // Re-detection of a resolved insight means the problem came back — reopen it.
          const reopened = existing.state === 'resolved'
          // first_seen_at: overwrite only when the detector supplies a real earliest
          // occurrence (COALESCE keeps the stored value otherwise — never clobber a
          // real creation time with the run time for detectors that don't source it).
          this.db
            .prepare(
              `UPDATE insights SET severity = ?, title = ?, description = ?, count = ?,
               fix_type = ?, fix_label = ?, fix_content = ?, first_seen_at = COALESCE(?, first_seen_at), last_seen_at = ?, detector_version = ?,
               state = CASE WHEN state = 'resolved' THEN 'surfaced' ELSE state END,
               state_changed_at = CASE WHEN state = 'resolved' THEN ? ELSE state_changed_at END
               WHERE id = ?`,
            )
            .run(
              input.severity,
              input.title,
              input.description,
              input.count,
              input.fix.type,
              input.fix.label,
              input.fix.content,
              input.firstSeenAt ?? null,
              lastSeen,
              version,
              now,
              existing.id,
            )
          if (reopened) this.logInsightState(existing.id, 'resolved', 'surfaced', now)
          this.db.prepare('DELETE FROM insight_evidence WHERE insight_id = ?').run(existing.id)
          this.writeEvidence(existing.id, input.evidence, now)
        } else {
          const id = insightId(detector, input.repo, input.signalKey)
          this.db
            .prepare(
              `INSERT INTO insights (id, detector, signal_key, repo, severity, state, title, description, count,
               fix_type, fix_label, fix_content, first_seen_at, last_seen_at, detector_version)
               VALUES (?, ?, ?, ?, ?, 'surfaced', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              detector,
              input.signalKey,
              input.repo,
              input.severity,
              input.title,
              input.description,
              input.count,
              input.fix.type,
              input.fix.label,
              input.fix.content,
              firstSeen,
              lastSeen,
              version,
            )
          this.writeEvidence(id, input.evidence, now)
          this.logInsightState(id, null, 'surfaced', now)
        }
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO detector_runs (detector, version, status, model, in_tokens, out_tokens, cost_usd, ran_at)
           VALUES (?, ?, 'ok', ?, ?, ?, ?, ?)`,
        )
        .run(detector, version, cost?.model ?? null, cost?.inTokens ?? null, cost?.outTokens ?? null, cost?.usd ?? null, now)
    })()
  }

  persistDetectorError(detector: string, version: number): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR REPLACE INTO detector_runs (detector, version, status, in_tokens, out_tokens, cost_usd, ran_at)
         VALUES (?, ?, 'error', NULL, NULL, NULL, ?)`,
      )
      .run(detector, version, now)
  }

  /**
   * Write an insight's evidence rows (assumes any prior rows were cleared).
   * Capped generously: the insight card shows a few chips, but the detail view
   * lists every occurrence, so we keep enough to be useful without unbounded rows.
   */
  private writeEvidence(insightId: string, evidence: EvidenceRef[], now: string): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO insight_evidence (insight_id, session_id, turn_idx, note, added_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const ev of evidence.slice(0, EVIDENCE_CAP)) {
      stmt.run(insightId, ev.sessionId, ev.turnIdx ?? -1, ev.note ?? null, now)
    }
  }

  /**
   * Every stored occurrence for an insight — the detail view's drill-in list.
   * Joins the session's display title so each row reads as "what happened, in
   * which session" and links to the transcript turn (turn_idx = main-thread seq).
   */
  insightEvidence(insightId: string): Array<{ sessionId: string; turnIdx: number | null; note: string | null; sessionTitle: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT e.session_id AS sessionId, e.turn_idx AS turnIdx, e.note AS note,
                  ${titleExpr('s')} AS sessionTitle
           FROM insight_evidence e LEFT JOIN sessions s ON s.id = e.session_id
           WHERE e.insight_id = ? ORDER BY e.added_at DESC, e.session_id, e.turn_idx`,
        )
        .all(insightId) as Array<{ sessionId: string; turnIdx: number; note: string | null; sessionTitle: string | null }>
    ).map((r) => ({ ...r, turnIdx: r.turnIdx === -1 ? null : r.turnIdx }))
  }

  insights(opts?: { state?: InsightState; detector?: string; repo?: string }): InsightRow[] {
    let sql = `SELECT id, detector, signal_key, repo, severity, state, title, description, count,
               fix_type, fix_label, fix_content, first_seen_at, last_seen_at, state_changed_at, detector_version
               FROM insights WHERE state != 'dismissed'`
    const params: unknown[] = []
    if (opts?.state) {
      sql += ' AND state = ?'
      params.push(opts.state)
    }
    if (opts?.detector) {
      sql += ' AND detector = ?'
      params.push(opts.detector)
    }
    if (opts?.repo) {
      sql += ' AND repo = ?'
      params.push(opts.repo)
    }
    // Rank most-valuable-first: severity, then recurrence (how often it bit), then
    // recency
    sql += ` ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, count DESC, last_seen_at DESC`

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      detector: string
      signal_key: string
      repo: string
      severity: string
      state: string
      title: string
      description: string
      count: number
      fix_type: string | null
      fix_label: string | null
      fix_content: string | null
      first_seen_at: string
      last_seen_at: string
      state_changed_at: string | null
      detector_version: number
    }>

    return rows.map((r) => {
      const evidence = this.db
        .prepare('SELECT session_id, turn_idx FROM insight_evidence WHERE insight_id = ? ORDER BY added_at DESC LIMIT 10')
        .all(r.id) as Array<{ session_id: string; turn_idx: number }>
      // Fix sessions are scoped to the current lifecycle cycle: after a reopen,
      // the previous cycle's fix must read as history, not as the current fix.
      // Same boundary reconcile gates on, so state and refs can't disagree.
      const boundary = this.insightCycleBoundary(r.id)
      const fixSessions = this.db
        .prepare(
          `SELECT session_id, seq, turn_at FROM fix_marker_sightings
           WHERE insight_id = ? AND matched_at IS NOT NULL AND (? IS NULL OR turn_at > ?)
           ORDER BY turn_at ASC`,
        )
        .all(r.id, boundary, boundary) as Array<{ session_id: string; seq: number; turn_at: string }>
      return {
        id: r.id,
        detector: r.detector,
        signalKey: r.signal_key,
        repo: r.repo,
        severity: r.severity as InsightRow['severity'],
        state: r.state as InsightState,
        title: r.title,
        description: r.description,
        count: r.count,
        fix: { type: r.fix_type ?? '', label: r.fix_label ?? '', content: r.fix_content ?? '' },
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        stateChangedAt: r.state_changed_at,
        detectorVersion: r.detector_version,
        evidence: evidence.map((e) => ({ sessionId: e.session_id, turnIdx: e.turn_idx === -1 ? null : e.turn_idx })),
        // Event time of the first fix application in the current cycle. When the
        // fix session was pruned (transcript rotated → sightings cascade away),
        // fall back to the state log's adoption entry — processing time, but it
        // keeps "recurrences since adoption" answerable.
        adoptedAt: fixSessions[0]?.turn_at ?? this.adoptedAtFromLog(r.id, r.state as InsightState, boundary),
        fixSessions: fixSessions.map((f) => ({ sessionId: f.session_id, seq: f.seq, turnAt: f.turn_at })),
      }
    })
  }

  dismissInsight(id: string): boolean {
    return this.transitionInsight(id, 'dismissed')
  }

  transitionInsight(id: string, newState: InsightState): boolean {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      surfaced: ['fix_issued', 'resolved', 'dismissed'],
      fix_issued: ['adopted', 'resolved', 'dismissed'],
      adopted: ['resolved', 'dismissed'],
      resolved: ['surfaced', 'dismissed'],
    }
    const row = this.db.prepare('SELECT state FROM insights WHERE id = ?').get(id) as { state: string } | undefined
    if (!row) return false
    const allowed = VALID_TRANSITIONS[row.state]
    if (!allowed || !allowed.includes(newState)) return false
    const now = new Date().toISOString()
    this.db.prepare('UPDATE insights SET state = ?, state_changed_at = ? WHERE id = ?').run(newState, now, id)
    this.logInsightState(id, row.state as InsightState, newState, now)
    return true
  }

  /** Append one row to the lifecycle history. from = null means first surface. */
  private logInsightState(id: string, from: InsightState | null, to: InsightState, at: string): void {
    this.db
      .prepare('INSERT INTO insight_state_log (insight_id, from_state, to_state, at) VALUES (?, ?, ?, ?)')
      .run(id, from, to, at)
  }

  /** Current-cycle adoption time from the state log — the fallback when the fix session's sightings were pruned with it. */
  private adoptedAtFromLog(id: string, state: InsightState, boundary: string | null): string | null {
    if (state !== 'adopted' && state !== 'resolved') return null
    const row = this.db
      .prepare(
        `SELECT MAX(at) as at FROM insight_state_log
         WHERE insight_id = ? AND to_state = 'adopted' AND (? IS NULL OR at > ?)`,
      )
      .get(id, boundary, boundary) as { at: string | null }
    return row.at
  }

  /**
   * Event-time lower bound of the insight's current cycle: the resolve that
   * preceded the latest reopen (null when never reopened). A fix applied after
   * that resolve can only belong to the current cycle; one applied before it is
   * a previous cycle's fix. Deliberately NOT the reopen timestamp — reopens are
   * logged at processing time, which can postdate a genuine re-fix's event time
   * (paste yesterday, analyze today). Shared by reconcile and the read path so
   * they can't disagree on what "current cycle" means.
   */
  private insightCycleBoundary(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(at) as at FROM insight_state_log
         WHERE insight_id = ? AND to_state = 'resolved'
           AND at <= (SELECT MAX(at) FROM insight_state_log
                      WHERE insight_id = ? AND from_state = 'resolved' AND to_state = 'surfaced')`,
      )
      .get(id, id) as { at: string | null }
    return row.at
  }

  /**
   * Persist the fix-marker sightings for one session. matched_at is intentionally NOT preserved 
   * across replaces: reconcile re-stamps it, since "the claimed id exists" is re-checkable.
   */
  recordFixMarkerSightings(sessionId: string, sightings: FixMarkerSightingInput[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM fix_marker_sightings WHERE session_id = ?').run(sessionId)
      for (const s of sightings) {
        this.db
          .prepare('INSERT OR IGNORE INTO fix_marker_sightings (session_id, insight_id, seq, turn_at) VALUES (?, ?, ?, ?)')
          .run(sessionId, s.insightId, s.seq, s.turnAt)
      }
    })()
  }

  /**
   * Interpret unmatched sightings: a marker sighting whose claimed insight exists
   * means the user ran that insight's fix-prompt — walk the insight to `adopted`
   * (marker presence proves the fix was issued). Runs after the detector phase in
   * analyze so insights created in the same run are visible. Idempotent: sightings
   * on already-adopted/resolved/dismissed insights are matched without transitions;
   * unknown ids stay unmatched and are retried next run (self-heals after rebuilds).
   * Returns the number of insights newly flipped to adopted.
   */
  reconcileFixSightings(): number {
    let adopted = 0
    this.db.transaction(() => {
      const pending = this.db
        .prepare(
          `SELECT f.session_id as sessionId, f.insight_id as insightId, f.turn_at as turnAt, i.state
           FROM fix_marker_sightings f JOIN insights i ON i.id = f.insight_id
           WHERE f.matched_at IS NULL`,
        )
        .all() as Array<{ sessionId: string; insightId: string; turnAt: string; state: InsightState }>
      const now = new Date().toISOString()
      for (const p of pending) {
        // Only a current-cycle fix may transition: a previous cycle's fix session
        // being re-scanned (wipe-and-replace on resume) must not re-adopt a
        // reopened insight off stale evidence.
        const boundary = this.insightCycleBoundary(p.insightId)
        const currentCycle = boundary === null || p.turnAt > boundary
        if (currentCycle) {
          if (p.state === 'surfaced') this.transitionInsight(p.insightId, 'fix_issued')
          if (p.state === 'surfaced' || p.state === 'fix_issued') {
            if (this.transitionInsight(p.insightId, 'adopted')) adopted++
          }
        }
        // Matched regardless of state or cycle — a re-scanned fix session keeps
        // its link, dismissed means dead, and out-of-cycle sightings must not
        // retry forever.
        this.db
          .prepare('UPDATE fix_marker_sightings SET matched_at = ? WHERE session_id = ? AND insight_id = ?')
          .run(now, p.sessionId, p.insightId)
      }
    })()
    return adopted
  }

  // ---- environment reader (harness config snapshots) -----------------------

  /**
   * Append-on-change write of one category's config snapshot. Hashes the payload
   * and compares to the latest stored state for (source, scope, scope_key,
   * category): an unchanged hash just bumps `last_observed_at` (no new row), so a
   * config that holds steady across many analyze runs stays one row; a changed
   * hash appends a new row, building the dated change timeline. `captured_at` marks
   * when a state first appeared; `last_observed_at` the most recent run that saw it.
   *
   * `now` defaults to the current time; callers (tests) may pass an explicit
   * timestamp to control the timeline and keep `captured_at` unique across writes.
   */
  recordEnvSnapshot(input: EnvSnapshotInput, now: string = new Date().toISOString()): void {
    // Hash a canonical serialization (object keys sorted at every level; array order
    // preserved) so a meaning-preserving key reorder in the source config doesn't read
    // as a change. Arrays aren't sorted — element order can be meaningful (e.g. the
    // order of permission rules) and is already consistent across reads.
    const hash = contentHash(canonicalJson(input.payload))
    this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT content_hash, captured_at FROM environment_snapshots
           WHERE source = ? AND scope = ? AND scope_key = ? AND category = ?
           ORDER BY captured_at DESC LIMIT 1`,
        )
        .get(input.source, input.scope, input.scopeKey, input.category) as
        | { content_hash: string; captured_at: string }
        | undefined
      if (existing?.content_hash === hash) {
        // Same state — confirm we still see it, no new row. Target the latest row by
        // captured_at (its PK): a prior round-trip can leave the same hash on an
        // earlier row, which must not be touched.
        this.db
          .prepare(
            `UPDATE environment_snapshots SET last_observed_at = ?
             WHERE source = ? AND scope = ? AND scope_key = ? AND category = ? AND captured_at = ?`,
          )
          .run(now, input.source, input.scope, input.scopeKey, input.category, existing.captured_at)
        return
      }
      this.db
        .prepare(
          `INSERT INTO environment_snapshots
             (source, scope, scope_key, category, content_hash, snapshot_json, captured_at, last_observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.source, input.scope, input.scopeKey, input.category, hash, JSON.stringify(input.payload), now, now)
    })()
  }

  /** The current config state for a key — the newest snapshot by captured_at, or null if none. */
  envSnapshotCurrent(source: string, scope: string, scopeKey: string, category: string): EnvSnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_json, captured_at, last_observed_at FROM environment_snapshots
         WHERE source = ? AND scope = ? AND scope_key = ? AND category = ?
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(source, scope, scopeKey, category) as
      | { snapshot_json: string; captured_at: string; last_observed_at: string }
      | undefined
    return row ? toEnvSnapshotRow(row) : null
  }

  /**
   * Point-in-time read: the config state as of `at` (the newest snapshot with
   * captured_at <= at). Per-session detectors MUST use this rather than "current",
   * so an old session isn't judged against today's config. `stale` is true when no
   * snapshot precedes `at` — we never observed the config that early, so the caller
   * should abstain or down-weight rather than treat the (absent) result as fact.
   */
  envSnapshotAsOf(source: string, scope: string, scopeKey: string, category: string, at: string): EnvSnapshotAsOf {
    const row = this.db
      .prepare(
        `SELECT snapshot_json, captured_at, last_observed_at FROM environment_snapshots
         WHERE source = ? AND scope = ? AND scope_key = ? AND category = ? AND captured_at <= ?
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(source, scope, scopeKey, category, at) as
      | { snapshot_json: string; captured_at: string; last_observed_at: string }
      | undefined
    return { row: row ? toEnvSnapshotRow(row) : null, stale: !row }
  }

  /**
   * Distinct categories with any stored snapshot for a key. Used by capture to
   * detect deletions: a category with history that a successful read no longer
   * returns has been removed from disk and gets a null tombstone snapshot.
   */
  envSnapshotCategories(source: string, scope: string, scopeKey: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT category FROM environment_snapshots
           WHERE source = ? AND scope = ? AND scope_key = ?`,
        )
        .all(source, scope, scopeKey) as Array<{ category: string }>
    ).map((r) => r.category)
  }

  close() {
    this.readonlyDb?.close()
    this.db.close()
  }
}

/**
 * Deterministic JSON for hashing: object keys sorted recursively, array order kept.
 * So `{a:1,b:2}` and `{b:2,a:1}` hash identically, but `[1,2]` and `[2,1]` do not.
 */
function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(canon(value))
}

/** Map a raw environment_snapshots row to the read-facing shape (parses snapshot_json). */
function toEnvSnapshotRow(row: { snapshot_json: string; captured_at: string; last_observed_at: string }): EnvSnapshotRow {
  return {
    payload: JSON.parse(row.snapshot_json),
    capturedAt: row.captured_at,
    lastObservedAt: row.last_observed_at,
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
  /** PR creation time (from `gh`); null when not captured (offline / pre-backfill). */
  createdAt: string | null
  completedAt: string | null
  parentId: string | null
  complexity: number | null
  complexityBasis: string | null
  sessions: number
  costUsd: number
  /** Max content-match AI-attribution fraction across the artifact's session links (0–1);
   * null when no content-match link exists (e.g. an explicit-only PR). PRs only. */
  aiPct: number | null
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
  /** Total session cost (USD) in the bucket — feeds the per-value cost table
   *  (total spend, and $/session = spend/denom). Summed over the SAME population
   *  as `denom` (all sessions, not just successful ones), so spend/denom is an
   *  honest avg cost per session. */
  spend: number
  /** num/denom, or null when the bucket has no sessions (drawn as a gap). */
  rate: number | null
}

/** A success-rate line: per-bucket points plus the windowed totals/rate. */
export interface RateSeries {
  key: string
  points: RatePoint[]
  num: number
  denom: number
  /** Window-total session cost (USD); spend/denom = avg cost per session. */
  spend: number
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
  /** Session-level facet filters (multi-value OR within a facet), applied to
   *  numerator and denominator alike. */
  filters?: Record<string, string[]>
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
  /** Display label when the key isn't already human-readable (error categories). */
  label?: string
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
  /** 'name' splits by tool name; 'error_category' decomposes the rate by category. */
  by?: string
  from?: string
  to?: string
  /** Generic session-level facet filters (harness/repo/model); unused by the Ops UI today. */
  filters?: Record<string, string[]>
  /** Row-level scope: only count calls of these tool names (denominator + numerator). */
  toolNames?: string[]
  /** Row-level scope: only these categories count as errors (numerator only). */
  errorCategories?: string[]
  topK?: number
}

export interface OpsOverTimeResult {
  view: string
  bucket: Bucket
  /** The active breakdown dimension, echoed back so the client can label series. */
  by?: string
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
  filters?: Record<string, string[]>
  topK?: number
}

export interface SessionsOverTimeResult {
  bucket: Bucket
  buckets: string[]
  overall: { points: CountPoint[]; total: number }
  series?: CountSeries[]
  truncated?: { shown: number; total: number }
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
  filters?: Record<string, string[]>
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
  /** Window on session start (ISO); inclusive lower / exclusive upper bound. */
  from?: string
  to?: string
  /** Match sessions that produced ANY of these outcome types (OR). */
  outcomeTypes?: string[]
  limit?: number
}

export interface SessionListItem {
  id: string
  title: string
  startedAt: string | null
  costUsd: number
  models: string[]
  complexity: string | null
  useCase: string[]
  intent: string | null
  /** Distinct outcome types this session produced (e.g. pr_merged, session_success). */
  outcomes: string[]
}

export interface TranscriptTool {
  name: string
  action: string
  ok: boolean
  /** This call's index in session.toolCalls — the transcript anchors a failed call as `txerr-<idx>`. */
  idx?: number
  target?: string
  /** Full tool input rendered as displayable text (key field or JSON). */
  command?: string
  /** Tool output/result text (clipped to OUTPUT_MAX, with an explicit tail notice if cut). */
  output?: string
  /** For Edit/Write: old→new hunks for inline diff rendering. */
  hunks?: { del: string; ins: string }[]
  /** For a multi-file apply_patch: preserve each file's identity and hunks. */
  fileDiffs?: Array<{ path: string; hunks: { del: string; ins: string }[] }>
  error?: string
  /** For a subagent-spawning call (`Task`/`Agent`), the agentId it links to. */
  agentId?: string
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system'
  ts?: string
  sidechain: boolean
  /** Which subagent emitted this turn; undefined for main-thread turns. */
  agentId?: string
  /** Main-thread sequence index (undefined for sidechain turns). */
  seq?: number
  /** Block this turn belongs to (handling_long_sessions); undefined if unmapped. */
  blockIdx?: number
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
/** One block's identity + labels, for the transcript's filter bar. */
export interface TranscriptBlock {
  idx: number
  useCase?: string | null
  pr?: { ident: string; title?: string } | null
  feature?: { id: string; title?: string } | null
}

export interface Transcript {
  turns: TranscriptTurn[]
  subagents: SubagentInfo[]
  /** Block partition + per-block labels, for filtering the transcript by PR / feature / use-case. */
  blocks: TranscriptBlock[]
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

/**
 * Precedence of a PR-kind block attribution — higher wins the single row that block keeps
 * (cross-role 1-1, applied in persistResult). 0 = not a ranked PR row (e.g. enrich's
 * feature-contributed, a different artifact kind that coexists). Order of the ranks:
 * pcm content-match (the code literally shipped) > og explicit review > enrich derived
 * review > og proximity-fill contribution.
 */
function prBlockRank(producer: string, role: string | null | undefined): number {
  if (producer === 'pr-content-match') return 4
  if (producer === 'outcomes-git') return role === 'reviewed' ? 3 : 1
  if (producer === 'enrich-session' && role === 'reviewed') return 2
  return 0
}

export type ComplexityBucket = 'trivial' | 'small' | 'medium' | 'large' | 'xl'

const COMPLEXITY_RANGES: Record<ComplexityBucket, [number, number]> = {
  trivial: [0, 10],
  small: [11, 100],
  medium: [101, 500],
  large: [501, 1500],
  xl: [1501, 999999999],
}

const FEATURE_COMPLEXITY: Record<string, number> = {
  trivial: 1, small: 2, medium: 3, large: 4, xl: 5,
}

function complexityWhere(bucket: string | undefined, alias: string, kind?: string): string {
  if (!bucket) return ''
  const buckets = bucket.split(',').filter(Boolean)
  if (!buckets.length) return ''
  if (kind !== 'feature' && kind !== 'pr') return ''
  const clauses: string[] = []
  let hasNone = false
  for (const b of buckets) {
    if (b === 'none') { hasNone = true; continue }
    if (kind === 'feature') {
      const val = FEATURE_COMPLEXITY[b]
      if (val) clauses.push(`${alias}.complexity = ${val}`)
    } else {
      const range = COMPLEXITY_RANGES[b as ComplexityBucket]
      if (range) clauses.push(`(${alias}.complexity >= ${range[0]} AND ${alias}.complexity <= ${range[1]})`)
    }
  }
  if (hasNone) clauses.push(`${alias}.complexity IS NULL`)
  if (!clauses.length) return ''
  return `AND (${clauses.join(' OR ')})`
}

// Display title: the enrichment-derived `title` annotation, else the native
// adapter title, else the session's opening prompt (clipped for display at the
// render site). NULLIF keeps an empty native title from masking the fallback.
function titleExpr(alias: string): string {
  return `COALESCE((SELECT json_extract(value,'$') FROM annotations WHERE session_id=${alias}.id AND key='title'), NULLIF(${alias}.title, ''), NULLIF(${alias}.first_prompt, ''))`
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

/**
 * Group expression + any join/where a facet contributes to a breakdown. `anchorGrain`
 * is the MEASURE's grain (alias s/u/t) — needed to bridge a block facet up from the
 * measure's own anchor (usage_facts / tool_calls) through the block membership tables.
 */
function facetGroupExpr(f: FacetSpec, anchorGrain: Grain): { join: string; expr: string; where?: string } {
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
  if (f.source === 'block') {
    // Bridge the measure's anchor (usage_facts / tool_calls) up to its block, then to
    // the per-block label. Only reached for usage/tool_call measures (block is their
    // ancestor); session measures can't group by a finer block facet (guard rejects).
    const anchor = aliasFor(anchorGrain)
    const member = anchorGrain === 'tool_call' ? 'block_tool' : 'block_usage'
    const memberCol = anchorGrain === 'tool_call' ? 'tool_idx' : 'usage_idx'
    return {
      join:
        `JOIN ${member} bm ON bm.session_id = ${anchor}.session_id AND bm.${memberCol} = ${anchor}.idx ` +
        `JOIN block_annotations ba ON ba.session_id = bm.session_id AND ba.block_idx = bm.block_idx AND ba.key = '${f.key}'`,
      expr: `json_extract(ba.value,'$')`,
    }
  }
  // same-grain child facet (usage / tool-call): a column on the measure's own anchor
  return { join: '', expr: `${aliasFor(grainOf(f.source))}.${col}`, where: f.base }
}

function buildTranscript(session: Session): Transcript {
  const turns = buildTranscriptCore(session).turns
  // Map each main-thread turn to its block via seq (labels are attached in
  // sessionDetail, which has DB access). Deterministic, so idx matches storage.
  const blocks = deterministicBlocks(session)
  if (blocks.length) {
    const maxSeq = blocks[blocks.length - 1]!.endSeq
    const seqToBlock = new Array<number>(maxSeq + 1).fill(-1)
    for (const b of blocks) for (let s = b.startSeq; s <= b.endSeq; s++) seqToBlock[s] = b.idx
    for (const t of turns) {
      if (t.seq == null || t.seq < 0 || t.seq > maxSeq) continue
      const bi = seqToBlock[t.seq]
      if (bi != null && bi >= 0) t.blockIdx = bi
    }
  }
  return {
    turns,
    subagents: (session.subagents ?? []).map((s) => ({
      agentId: s.agentId,
      agentType: s.agentType,
      description: s.description,
      toolUseId: s.toolUseId,
    })),
    blocks: blocks.map((b) => ({ idx: b.idx })),
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
  const tcById = new Map(session.toolCalls.map((t) => [t.id, t]))
  const idxById = new Map(session.toolCalls.map((t, i) => [t.id, i]))
  const childrenByParent = new Map<string, ToolCall[]>()
  for (const tc of session.toolCalls) {
    if (!tc.parentId) continue
    const children = childrenByParent.get(tc.parentId) ?? []
    children.push(tc)
    childrenByParent.set(tc.parentId, children)
  }
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
          const direct = tcById.get(b.id)
          const children = childrenByParent.get(b.id) ?? []
          const candidates: Array<{ tc?: ToolCall; name: string; input: unknown; semantic?: boolean }> =
            direct
              ? [{ tc: direct, name: b.name, input: b.input }]
              : children.length
                ? children.map((tc) => ({ tc, name: tc.name, input: tc.input, semantic: true }))
                : [{ name: b.name, input: b.input }]

          for (const candidate of candidates) {
            const tc = candidate.tc
            const input = candidate.input as Record<string, unknown> | undefined
            if (tc) ids.push(tc.id)
            else ids.push(b.id)
            // Prefer the adapter-normalized target (paths/command) over re-parsing the
            // raw input blob, so per-vendor field spellings live in the adapter.
            const target = tc?.target.paths?.[0] ?? tc?.target.command
            const res = tc?.result
            const ok = res ? res.ok : true
            const command = toolCommandText(tc, input)
            const output = res?.raw != null ? clipOutput(readableOutput(tc?.action, res.raw)) : undefined
            const tool: TranscriptTool = {
              name: candidate.name,
              action: candidate.semantic ? tc?.action ?? '' : '',
              ok,
              idx: tc ? idxById.get(tc.id) : undefined,
              target: clip(target, 1500),
            }
            if (command) tool.command = command
            if (output) tool.output = output
            // file_write → inline diff, read from the normalized tc.input (not the block's
            // raw input): a Codex shell `apply_patch <<'PATCH'` keeps the {cmd} object on the
            // block but carries the patch string on tc.input. Identical for other harnesses.
            // Field names differ (Claude: old_string/new_string; OpenCode: camelCase).
            const fileInput = tc?.action === 'file_write' ? tc.input : candidate.input
            if (tc?.action === 'file_write' && typeof fileInput === 'string') {
              const patchEdits = parseApplyPatch(fileInput)
              if (patchEdits.length) {
                tool.fileDiffs = patchEdits.map((edit) => ({ path: edit.path, hunks: edit.hunks }))
                tool.command = patchEdits.length === 1 ? patchEdits[0]!.path : `${patchEdits.length} files changed`
              }
            } else if (tc?.action === 'file_write' && fileInput && typeof fileInput === 'object') {
              const fi = fileInput as Record<string, unknown>
              if (Array.isArray(fi.edits)) {
                tool.hunks = (fi.edits as Array<Record<string, unknown>>).map((e) => ({
                  del: clip(String(e.old_string ?? e.oldString ?? e.oldText ?? ''), 2000),
                  ins: clip(String(e.new_string ?? e.newString ?? e.newText ?? ''), 2000),
                }))
              } else {
                const old_s = clip(String(fi.old_string ?? fi.oldString ?? ''), 2000)
                const new_s = clip(String(fi.new_string ?? fi.newString ?? ''), 2000)
                if (old_s || new_s) tool.hunks = [{ del: old_s, ins: new_s }]
                else {
                  const content = clip(String(fi.content ?? ''), 2000)
                  if (content) tool.hunks = [{ del: '', ins: content }]
                }
              }
            }
            if (!ok) tool.error = clipError(resultText(res?.raw))
            const spawned = spawnToAgent.get(tc?.id ?? b.id) ?? spawnToAgent.get(b.id)
            if (spawned) tool.agentId = spawned
            tools.push(tool)
          }
        }
      }
      if (!text && tools.length === 0) continue
      const idx = turns.length
      for (const id of ids) toolTurn.set(id, { turn: idx, userTurn: lastUserIdx })
      turns.push({ role: 'assistant', ts: ev.ts, sidechain: ev.isSidechain, agentId: ev.agentId, seq: ev.seq, text: clip(text, 20000), tools })
    } else if (ev.kind === 'user') {
      const text = ev.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim()
      if (!text) continue
      // Only real prompts become the "intent" an edit links back to (the turn is
      // still shown in the transcript, just not used as a jump/grouping target).
      if (!isSyntheticUser(text)) lastUserIdx = turns.length
      turns.push({ role: 'user', ts: ev.ts, sidechain: ev.isSidechain, agentId: ev.agentId, seq: ev.seq, text: clip(text, 20000), tools: [] })
    }
  }
  return { turns, toolTurn }
}

/** Extract the meaningful output text for a tool, handling action-specific payloads. */
function readableOutput(action: CanonicalAction | undefined, raw: unknown): string {
  if (raw == null) return ''
  if (action === 'file_read' && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    // Claude Code's Read result is {"type":"text","file":{"filePath":"...","content":"..."}};
    // OpenCode stores a plain string, which falls through to resultText below.
    const file = o.file as Record<string, unknown> | undefined
    if (file && typeof file.content === 'string') return file.content
  }
  return resultText(raw)
}

/**
 * One-line description of a tool call for the transcript. Dispatches on the
 * adapter-assigned canonical `action` (not the raw vendor tool name), so the
 * vocabulary differences across harnesses (`Bash` vs `bash`, `Agent` vs `task`,
 * `AskUserQuestion` vs `question`) stay inside the adapters. Paths and shell
 * commands come from the already-normalized `target`; everything else reads the
 * genuinely vendor-neutral input fields (`prompt`, `pattern`, `url`, `todos`,
 * `questions`), whose spellings match across harnesses.
 */
function toolCommandText(tc: ToolCall | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  switch (tc?.action) {
    case 'file_read':
    case 'file_write':
      return clip(tc.target.paths?.[0] ?? '', 2000)
    case 'shell':
      return clip(tc.target.command ?? '', 2000)
    case 'task_spawn':
      return firstStringField(input, ['prompt'])
    case 'skill':
      return firstStringField(input, ['skill', 'name'])
    case 'web':
      return firstStringField(input, ['url', 'query'])
    case 'search':
      return firstStringField(input, ['pattern', 'query', 'path'])
    case 'todo':
      return renderTodos(input)
  }
  // 'other' / 'mcp_call' / unmapped: a question prompt (AskUserQuestion /
  // OpenCode `question`) or generic query if present, else the raw input as JSON.
  const qs = input.questions
  if (Array.isArray(qs) && qs.length && typeof qs[0] === 'object' && qs[0]) {
    return String((qs[0] as Record<string, unknown>).question ?? '')
  }
  const query = firstStringField(input, ['query'])
  if (query) return query
  try {
    return clip(JSON.stringify(input, null, 2), 2000)
  } catch {
    return ''
  }
}

/** First non-empty string among the given input keys, clipped for display. */
function firstStringField(input: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const val = input[k]
    if (typeof val === 'string' && val) return clip(val, 2000)
  }
  return ''
}

/** Render a todo-list tool's items as a checkbox summary. */
function renderTodos(input: Record<string, unknown>): string {
  const todos = input.todos
  if (!Array.isArray(todos) || !todos.length) return ''
  const lines = todos.map((t) => {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const status = typeof o.status === 'string' ? o.status : ''
    const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '▶' : '○'
    return `${mark} ${typeof o.content === 'string' ? o.content : ''}`
  })
  return clip(lines.join('\n'), 2000)
}

function clip(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + ' …' : s
}

/**
 * Clip tool output for the transcript viewer. Generous cap (the detail payload is
 * built per-session on demand, so this only ships for the one session being viewed),
 * and the tail notice makes the cut explicit rather than a silent " …".
 */
const OUTPUT_MAX = 20000
function clipOutput(s: string): string {
  if (!s) return ''
  if (s.length <= OUTPUT_MAX) return s
  return s.slice(0, OUTPUT_MAX) + `\n\n… ${s.length - OUTPUT_MAX} more characters truncated …`
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
    for (const k of ['stdout', 'stderr', 'error', 'message', 'content']) {
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
