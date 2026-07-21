import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type DB = Database.Database

const SCHEMA_VERSION = 17

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

-- Ingest provenance: which source directories were scanned, and when each was
-- last analyzed. Upserted per run; a root untouched by a scoped re-run (e.g.
-- \`--source codex\`) keeps its prior timestamp, so this answers "when was THIS
-- directory last analyzed" per directory, unlike the store-wide meta.last_analyze_at.
CREATE TABLE IF NOT EXISTS analyzed_roots (
  source           TEXT,
  path             TEXT,
  last_analyzed_at TEXT,
  PRIMARY KEY (source, path)
);

-- Hot row per session. Aggregation queries live here; the blob is elsewhere.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT,
  source              TEXT,
  provider            TEXT,
  title               TEXT,        -- native adapter title (may be absent)
  first_prompt        TEXT,        -- full opening human prompt; display-title fallback when no native/enriched title
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
  -- Cache creation split by TTL: DISJOINT, so total cache-write is the sum of the
  -- two. They bill at different rates (1h = 2x input, 5m = 1.25x), which is why
  -- cost needs them apart. Sources with no TTL report everything as 5m.
  tok_cache_create_5m INTEGER,
  tok_cache_create_1h INTEGER,
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
  tok_cache_create_5m INTEGER, -- disjoint from _1h; see sessions
  tok_cache_create_1h INTEGER,
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

-- file -> session index for \`tuneloop search <repo:file>\`.
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

-- Insight ledger: persisted detector findings with lifecycle tracking.
CREATE TABLE IF NOT EXISTS insights (
  id                TEXT PRIMARY KEY,
  detector          TEXT NOT NULL,
  signal_key        TEXT NOT NULL,
  repo              TEXT NOT NULL DEFAULT '_unknown',
  severity          TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'surfaced',
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  count             INTEGER NOT NULL,
  fix_type          TEXT,
  fix_label         TEXT,
  fix_content       TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  state_changed_at  TEXT,
  detector_version  INTEGER NOT NULL,
  UNIQUE(detector, repo, signal_key)
);
CREATE INDEX IF NOT EXISTS ix_insights_state ON insights(state);
CREATE INDEX IF NOT EXISTS ix_insights_detector ON insights(detector);
CREATE INDEX IF NOT EXISTS ix_insights_repo ON insights(repo);

CREATE TABLE IF NOT EXISTS insight_evidence (
  insight_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  turn_idx    INTEGER NOT NULL DEFAULT -1,
  -- Optional per-occurrence human-readable note (e.g. the recurring-themes event
  -- description). Lets the insight detail show WHAT happened at each evidence
  -- turn, not just a session chip. Generic — any detector may set it.
  note        TEXT,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (insight_id, session_id, turn_idx),
  FOREIGN KEY(insight_id) REFERENCES insights(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_insight_evidence_session ON insight_evidence(session_id);

-- One row per detector: tracks when it last ran and at what version.
-- Two tables for detector execution tracking, at different grains:
--
-- detector_runs: one row per detector. Tracks the *invocation* — when it last ran,
-- whether it succeeded, and aggregate LLM cost. Cost and status belong to the run
-- as a whole (a cross-session LLM call can't be split across individual sessions).
--
-- detector_session_runs: one row per (detector × session). Tracks which sessions a
-- detector has already seen and at what content hash. Enables incremental analysis
-- for P/X-tier detectors: on re-run, only process sessions whose hash changed or
-- that weren't seen before (the delta), instead of re-analyzing the full corpus.
--
-- S-tier detectors use neither table for skip logic (they always re-run, cheap SQL).
-- P/X-tier detectors use detector_session_runs for delta computation and
-- detector_runs for cost tracking.

CREATE TABLE IF NOT EXISTS detector_runs (
  detector    TEXT PRIMARY KEY,  -- detector name (e.g. 'permission-friction')
  version     INTEGER NOT NULL,  -- detector version at time of run (for cache invalidation)
  status      TEXT,              -- 'ok' | 'error'
  model       TEXT,              -- LLM model that ran it (NULL for S-tier / non-LLM)
  in_tokens   INTEGER,           -- LLM input tokens (NULL for S-tier)
  out_tokens  INTEGER,           -- LLM output tokens (NULL for S-tier)
  cost_usd    REAL,              -- LLM cost in USD (NULL for S-tier)
  ran_at      TEXT NOT NULL      -- ISO timestamp of last run
);

CREATE TABLE IF NOT EXISTS detector_session_runs (
  detector      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  ran_at        TEXT NOT NULL,
  PRIMARY KEY (detector, session_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Fix-marker sightings: facts recorded by the fix-marker processor (a real user
-- turn contained a \`tuneloop-fix: <id>\` marker), interpreted by the reconcile
-- step in analyze (which applies lifecycle transitions). Kept separate so a
-- sighting scanned before its insight exists (store rebuild, same-run ordering)
-- is never lost — it just stays unmatched and is retried next analyze.
-- No FK on insight_id: the claimed id may not exist (yet, or ever).
-- Single-writer table (fix-marker processor), so no \`producer\` column.
CREATE TABLE IF NOT EXISTS fix_marker_sightings (
  session_id  TEXT NOT NULL,
  insight_id  TEXT NOT NULL,      -- as claimed by the marker
  seq         INTEGER NOT NULL,   -- main-thread event seq of the sighted user turn
  turn_at     TEXT NOT NULL,      -- EVENT time: transcript timestamp of that turn — the
                                  --   "fix applied" date; measurement windows key off this
  matched_at  TEXT,               -- processing time; NULL = reconcile hasn't resolved this
                                  --   against an existing insight yet. Re-stamped on
                                  --   re-scans — never use for cycle-scoping (use turn_at)
  PRIMARY KEY (session_id, insight_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_fix_marker_sightings_insight ON fix_marker_sightings(insight_id);

-- Recurring-theme mining (recurring-themes detector, tier X). A THEME is a
-- persistent, emergent friction pattern (its identity IS its LLM-minted label);
-- theme_events are its member occurrences across sessions. Kept separate from the
-- insights ledger because a theme must OUTLIVE its insight: dismiss/resolve must
-- not erase it from the extraction feed, and themes accumulate events below the
-- surfacing threshold where no insight yet exists. The insight is a projection of
-- a theme once it crosses the recurrence bar.
CREATE TABLE IF NOT EXISTS theme (
  id          TEXT PRIMARY KEY,   -- permanent; INSERT OR IGNORE, never renamed (a rename mislabels past members)
  label       TEXT NOT NULL,
  description TEXT,               -- one-sentence gap explanation (minted with the label); feeds merge + fix prompts
  type        TEXT NOT NULL,      -- frozen enum: re-steer|context-supply|tool-gap|rework|preference|other
  remedy      TEXT,               -- remedy-class hint: add_doc|add_skill|add_tool|model_or_prompt|none
  repo        TEXT,               -- NULL = global (spans repos); set only when the LLM marks a theme project-specific
  source      TEXT NOT NULL DEFAULT 'derived',
  first_seen  TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0, -- 1 keeps the theme in the extraction feed after its insight resolved
  -- LLM-generated fix, cached + hash-gated on the theme's occurrence set so a
  -- quiet re-analyze reuses it. fix_type is the InsightInput fix.type the LLM chose.
  fix_type    TEXT,
  fix_content TEXT,
  fix_hash    TEXT                -- hash of the occurrence set the current fix was generated from
);

CREATE TABLE IF NOT EXISTS theme_events (
  session_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,   -- 0-based within the session's extraction
  turn_seq    INTEGER,            -- main-thread seq of the user turn (evidence pointer); NULL if unknown
  type        TEXT NOT NULL,
  trigger     TEXT NOT NULL,      -- unprompted|after_tool_error|after_review|agent_stated
  description TEXT NOT NULL,      -- one abstract sentence; recurrences read the same
  theme_id    TEXT,              -- NULL = event survived but its proposed label was junk (topicless)
  added_at    TEXT NOT NULL,     -- when this row was written (analyze-run wall clock, bookkeeping)
  occurred_at TEXT,              -- timestamp of the user message itself (the real friction moment); drives first/last-seen
  PRIMARY KEY (session_id, idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_theme_events_theme ON theme_events(theme_id);

-- Append-only lifecycle history for insights. state_changed_at on the insights row
-- only remembers the LAST transition; measurement ("fix applied Jul 25, recurrences
-- since: 0") and reopen cycles need the full history. from_state NULL = first surface.
CREATE TABLE IF NOT EXISTS insight_state_log (
  insight_id  TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_insight_state_log_insight ON insight_state_log(insight_id);

-- Harness config snapshots (environment reader). A dated timeline of config
-- states per (source, scope, scope_key, category): global config keyed '_global',
-- project config keyed on repo root. Append-on-change — a row is written only when
-- content_hash differs from the LATEST row for that key (by captured_at), so an
-- unchanged config across many analyze runs is one row. captured_at = when this
-- state was recorded (the change timeline); last_observed_at = most recent run that
-- confirmed it (updated in place on a no-change run, so "still X" is distinguishable
-- from "assumed X, didn't look"). snapshot_json holds only allowlisted, secret-free
-- fields.
--
-- PK ends in captured_at (not content_hash) so a config can round-trip A->B->A: the
-- reverted-to A is a new row at a later captured_at, and ORDER BY captured_at DESC
-- reports it as current. captured_at is unique per key — each key is written at most
-- once per analyze run.
CREATE TABLE IF NOT EXISTS environment_snapshots (
  source           TEXT NOT NULL,   -- harness, e.g. 'claude-code'
  scope            TEXT NOT NULL,   -- 'global' | 'project'
  scope_key        TEXT NOT NULL,   -- '_global' for global; repo root for project
  category         TEXT NOT NULL,   -- 'settings' | 'mcp' | 'agents' | 'skills' | 'instructions'
  content_hash     TEXT NOT NULL,   -- hash of snapshot_json (change-detection key)
  snapshot_json    TEXT NOT NULL,   -- redacted, allowlisted payload for this category
  captured_at      TEXT NOT NULL,   -- when this state was recorded (change timeline)
  last_observed_at TEXT NOT NULL,   -- most recent analyze run that confirmed this state
  PRIMARY KEY (source, scope, scope_key, category, captured_at)
);
CREATE INDEX IF NOT EXISTS ix_env_snapshots_lookup
  ON environment_snapshots(source, scope, scope_key, category, captured_at);
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
  if (tableExists('sessions') && !has('sessions', 'first_prompt')) {
    db.exec('ALTER TABLE sessions ADD COLUMN first_prompt TEXT')
  }
  if (tableExists('insight_evidence') && !has('insight_evidence', 'note')) {
    db.exec('ALTER TABLE insight_evidence ADD COLUMN note TEXT')
  }
  if (tableExists('detector_runs') && !has('detector_runs', 'model')) {
    db.exec('ALTER TABLE detector_runs ADD COLUMN model TEXT')
  }
  // recurring-themes v2: themes gained a description + a cached LLM-generated fix.
  for (const col of ['description', 'fix_type', 'fix_content', 'fix_hash']) {
    if (tableExists('theme') && !has('theme', col)) db.exec(`ALTER TABLE theme ADD COLUMN ${col} TEXT`)
  }
  // recurring-themes v3: theme_events carry the user message's own timestamp, so
  // first/last-seen reflect when friction actually happened (not the analyze run).
  // Existing rows stay NULL until the detector version bump re-extracts them.
  if (tableExists('theme_events') && !has('theme_events', 'occurred_at')) {
    db.exec('ALTER TABLE theme_events ADD COLUMN occurred_at TEXT')
  }
  // kitchen-sink v2: one aggregate insight (signal_key 'kitchen-sink') replaces the old
  // per-session rows (signal_key 'kitchen-sink:<id>'). The LIKE ':%' matches only those
  // v1 rows, never the new key; evidence cascades. Idempotent (no-op once cleared).
  if (tableExists('insights')) {
    db.exec("DELETE FROM insights WHERE detector = 'kitchen-sink' AND signal_key LIKE 'kitchen-sink:%'")
    // cache-miss / context-exhaustion / unused-capabilities: now emit ONE cross-repo
    // insight (repo '*') instead of one per repo. Drop the orphaned per-repo rows once —
    // the detectors no longer re-emit them, so they'd linger. Evidence cascades. Idempotent.
    db.exec("DELETE FROM insights WHERE detector IN ('cache-miss','context-exhaustion','unused-capabilities') AND repo != '*'")
  }

  // Split cache creation by TTL. The old `tok_cache_create` held the whole write
  // and was priced entirely at the 5m rate, so renaming it to `_5m` (rather than
  // adding a column beside it) states what those rows already meant, and leaves
  // no column whose meaning silently changed under existing queries. The real
  // split arrives when the NORMALIZE_VERSION bump re-ingests every session.
  for (const table of ['sessions', 'usage_facts']) {
    if (!tableExists(table)) continue
    if (has(table, 'tok_cache_create') && !has(table, 'tok_cache_create_5m')) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN tok_cache_create TO tok_cache_create_5m`)
    }
    if (!has(table, 'tok_cache_create_1h')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tok_cache_create_1h INTEGER NOT NULL DEFAULT 0`)
    }
  }
}
