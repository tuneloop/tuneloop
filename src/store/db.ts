import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type DB = Database.Database

const SCHEMA_VERSION = 8

/**
 * The store is fact tables only — no pre-aggregated metrics. Every dashboard
 * number is a query over these (see ARCHITECTURE.md). `producer` columns let a
 * processor's rows be replaced on re-run without touching user-authored rows.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Hot row per session. Aggregation queries live here; the blob is elsewhere.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT,
  source              TEXT,
  provider            TEXT,
  title               TEXT,
  repo                TEXT,
  branch              TEXT,
  cwd                 TEXT,
  started_at          TEXT,
  ended_at            TEXT,
  n_turns             INTEGER,
  n_tool_calls        INTEGER,
  models              TEXT,        -- json array
  tok_input           INTEGER,
  tok_output          INTEGER,
  tok_cache_create    INTEGER,
  tok_cache_read      INTEGER,
  cost_usd            REAL,
  price_table_version TEXT,
  content_hash        TEXT,
  parse_version       INTEGER,
  analyzed_at         TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS ix_sessions_repo    ON sessions(repo);

-- Normalized session JSON (gzipped) for the transcript viewer. Self-contained:
-- survives Claude Code rotating the original .jsonl files.
CREATE TABLE IF NOT EXISTS session_blobs (
  id TEXT PRIMARY KEY,
  gz BLOB,
  FOREIGN KEY(id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Relational backbone: tool/skill usage, error rates, files-touched all read here.
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id   TEXT,
  idx          INTEGER,
  name         TEXT,
  action       TEXT,
  ok           INTEGER,
  is_error     INTEGER,
  error_category TEXT,
  error_message TEXT,
  target_path  TEXT,
  command      TEXT,
  is_sidechain INTEGER,
  ts           TEXT,
  duration_ms  INTEGER,
  PRIMARY KEY (session_id, idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_tool_calls_name ON tool_calls(name);
CREATE INDEX IF NOT EXISTS ix_tool_calls_action ON tool_calls(action);
CREATE INDEX IF NOT EXISTS ix_tool_calls_error_category ON tool_calls(error_category);

-- Per-assistant-message usage facts: the atomic grain of token economics.
-- Model / main-vs-sidechain / time are dimension columns, so every usage
-- breakdown is a read-time GROUP BY (summing cost by model off sessions.models
-- would double-count). Rebuilt wholesale on re-ingest, like tool_calls.
CREATE TABLE IF NOT EXISTS usage_facts (
  session_id       TEXT,
  idx              INTEGER,
  model            TEXT,
  is_sidechain     INTEGER,
  ts               TEXT,
  tok_input        INTEGER,
  tok_output       INTEGER,
  tok_cache_create INTEGER,
  tok_cache_read   INTEGER,
  cost_usd         REAL,
  PRIMARY KEY (session_id, idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_usage_facts_model ON usage_facts(model);

-- Polymorphic artifacts (file | commit | pr | ticket | feature) with completion.
CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT,
  repo               TEXT,
  ident              TEXT,
  external_id        TEXT,
  source             TEXT,
  title              TEXT,
  owner              TEXT,
  complexity         REAL,
  complexity_basis   TEXT,
  status             TEXT,
  created_at         TEXT,
  completed_at       TEXT,
  parent_artifact_id TEXT,
  json               TEXT,
  producer           TEXT
);
CREATE INDEX IF NOT EXISTS ix_artifacts_kind_completed ON artifacts(kind, completed_at);

-- Artifact -> artifact edges (the transitive chain to features).
CREATE TABLE IF NOT EXISTS artifact_links (
  from_id    TEXT,
  to_id      TEXT,
  relation   TEXT,
  source     TEXT,
  confidence REAL,
  producer   TEXT,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS session_artifacts (
  session_id  TEXT,
  artifact_id TEXT,
  role        TEXT,
  source      TEXT,
  confidence  REAL,
  producer    TEXT,
  PRIMARY KEY (session_id, artifact_id, role),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_session_artifacts_artifact ON session_artifacts(artifact_id);

-- Multi-tag per session. artifact_id is nullable (session_success, plan_drafted, ...).
CREATE TABLE IF NOT EXISTS outcomes (
  session_id  TEXT,
  type        TEXT,
  artifact_id TEXT,
  ts          TEXT,
  producer    TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_outcomes_session ON outcomes(session_id, type);
CREATE INDEX IF NOT EXISTS ix_outcomes_type ON outcomes(type);

-- Generic facts. Every enrichment + custom dimension lands here; no migration
-- needed to add a processor.
CREATE TABLE IF NOT EXISTS annotations (
  session_id TEXT,
  processor  TEXT,
  key        TEXT,
  value      TEXT,        -- json
  PRIMARY KEY (session_id, processor, key),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_annotations_key ON annotations(session_id, key);

-- Cache + provenance + "cost of running the analysis itself".
CREATE TABLE IF NOT EXISTS processor_runs (
  session_id TEXT,
  processor  TEXT,
  version    INTEGER,
  input_hash TEXT,
  model      TEXT,
  status     TEXT,
  in_tokens  INTEGER,
  out_tokens INTEGER,
  cost_usd   REAL,
  ran_at     TEXT,
  -- Set to 1 by a user link/unlink to force the next analyze to re-run this
  -- processor; reset to 0 (the default) whenever persistResult rewrites the row.
  invalidated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, processor)
);

-- file -> session index for \`aivue search <repo:file>\`.
CREATE TABLE IF NOT EXISTS files_index (
  repo       TEXT,
  path       TEXT,
  session_id TEXT,
  producer   TEXT,
  PRIMARY KEY (repo, path, session_id)
);
CREATE INDEX IF NOT EXISTS ix_files_index_path ON files_index(path);

-- Facet registry: the single source of truth for chartable/filterable dimensions.
-- Populated each analyze from intrinsic facets + processor-declared facets, so the
-- serve process discovers them without importing processors. The source/multi/col/
-- base columns are what the generic query builder needs (see Store.facetDistribution).
CREATE TABLE IF NOT EXISTS facets (
  key      TEXT PRIMARY KEY,
  label    TEXT,
  type     TEXT,
  source   TEXT,
  col      TEXT,
  base     TEXT,
  multi    INTEGER,
  roles    TEXT,       -- json array of 'chart' | 'filter' | 'detail'
  producer TEXT
);

-- Measure registry: the "how much" axis. Crossed with facets by Store.breakdown.
-- expr is SQL over the source's anchor alias; agg is how to combine it.
CREATE TABLE IF NOT EXISTS measures (
  key      TEXT PRIMARY KEY,
  label    TEXT,
  source   TEXT,
  expr     TEXT,
  agg      TEXT,
  base     TEXT,
  format   TEXT,
  producer TEXT
);

-- Block-level attribution (handling_long_sessions). A block is a contiguous,
-- deterministic slice of a session's MAIN thread; the membership join tables map
-- each usage_facts / tool_calls row to its block so cost attributes at block grain.
-- Owned by the segment-blocks processor; block_annotations/block_artifacts are
-- layered on by enrich-session (use_case, feature) and outcomes-git (PR/commit).
CREATE TABLE IF NOT EXISTS blocks (
  session_id    TEXT,
  idx           INTEGER,        -- 0-based main-thread block ordinal
  start_seq     INTEGER,        -- inclusive main-thread seq
  end_seq       INTEGER,        -- inclusive
  boundary_kind TEXT,           -- 'user_turn' | 'commit' | 'pr_create' | 'pr_merge' | 'session_end'
  ts_start      TEXT,
  ts_end        TEXT,
  producer      TEXT,
  PRIMARY KEY (session_id, idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_blocks_session ON blocks(session_id);

-- usage_facts row -> its block. PK (session_id, usage_idx) enforces that a usage
-- row belongs to exactly one block (non-overlap); exhaustiveness is asserted.
CREATE TABLE IF NOT EXISTS block_usage (
  session_id TEXT,
  usage_idx  INTEGER,           -- usage_facts.idx
  block_idx  INTEGER,
  producer   TEXT,
  PRIMARY KEY (session_id, usage_idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_usage_block ON block_usage(session_id, block_idx);

CREATE TABLE IF NOT EXISTS block_tool (
  session_id TEXT,
  tool_idx   INTEGER,           -- tool_calls.idx
  block_idx  INTEGER,
  producer   TEXT,
  PRIMARY KEY (session_id, tool_idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_tool_block ON block_tool(session_id, block_idx);

-- Per-block labels (parallels annotations). use_case lands here.
CREATE TABLE IF NOT EXISTS block_annotations (
  session_id TEXT,
  block_idx  INTEGER,
  processor  TEXT,
  key        TEXT,
  value      TEXT,              -- json
  PRIMARY KEY (session_id, block_idx, processor, key),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- block -> artifact (PR/commit deterministic from outcomes-git; feature from enrich-session).
CREATE TABLE IF NOT EXISTS block_artifacts (
  session_id  TEXT,
  block_idx   INTEGER,
  artifact_id TEXT,
  role        TEXT,
  source      TEXT,
  confidence  REAL,
  producer    TEXT,
  PRIMARY KEY (session_id, block_idx, artifact_id, role),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_artifacts_artifact ON block_artifacts(artifact_id);

-- User overrides for session→artifact links (e.g. rejecting a derived feature link).
-- Processors check this before inserting derived links to respect user decisions.
CREATE TABLE IF NOT EXISTS user_link_overrides (
  session_id  TEXT,
  artifact_id TEXT,
  action      TEXT,              -- 'reject'
  created_at  TEXT,
  PRIMARY KEY (session_id, artifact_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db) // add columns to pre-existing tables before SCHEMA (its indexes reference them)
  db.exec(SCHEMA)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  )
  return db
}

/**
 * Add columns that `CREATE TABLE IF NOT EXISTS` can't retrofit onto an existing
 * table. Runs before SCHEMA so the schema's indexes on the new column succeed.
 * A pragma on a not-yet-created table returns nothing, so fresh DBs skip these
 * (SCHEMA creates the column directly) — keeping each step idempotent.
 */
function migrate(db: DB): void {
  const has = (table: string, col: string): boolean => {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
    return cols.length > 0 && cols.some((c) => c.name === col)
  }
  const tableExists = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as unknown[]).length > 0
  if (tableExists('tool_calls') && !has('tool_calls', 'error_category')) {
    db.exec('ALTER TABLE tool_calls ADD COLUMN error_category TEXT')
  }
  if (tableExists('tool_calls') && !has('tool_calls', 'error_message')) {
    db.exec('ALTER TABLE tool_calls ADD COLUMN error_message TEXT')
  }
  if (tableExists('processor_runs') && !has('processor_runs', 'invalidated')) {
    db.exec('ALTER TABLE processor_runs ADD COLUMN invalidated INTEGER NOT NULL DEFAULT 0')
  }
}
