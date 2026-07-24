import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { DROP_SHARE, HIT_READ_SHARE, MIN_CONTEXT_TOKENS, PEAK_FLOOR, SHRUNK_CTX_SHARE } from '../core/thresholds'

export type DB = Database.Database

const SCHEMA_VERSION = 21

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

-- Two tables for detector execution tracking, at different grains:
--
-- detector_runs: append-only log — one row per detector INVOCATION. Records the
-- version and model it ran under, whether it succeeded, and the LLM spend it
-- incurred (cost belongs to the run as a whole: a cross-session LLM call can't be
-- split across individual sessions). Append rather than upsert because detector
-- work is INCREMENTAL — each run pays only for its delta, so the last run's cost
-- is not what the current insights cost to produce. Overwriting one row per
-- detector would report a $0.02 top-up as the whole bill for a $0.42 corpus, and
-- would let a failed run erase the accounting of the successful one before it.
-- Readers therefore take the latest row (current state) or the latest successful
-- row (the model whose extractions are actually in the store) — never a sole row.
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
  id          INTEGER PRIMARY KEY, -- rowid alias; ascending = run order (the log is never deleted from)
  detector    TEXT NOT NULL,       -- detector name (e.g. 'permission-friction')
  version     INTEGER NOT NULL,    -- detector version at time of run (for cache invalidation)
  status      TEXT NOT NULL,       -- 'ok' | 'error'
  model       TEXT,                -- LLM model that ran it (NULL for S-tier / non-LLM / error runs)
  in_tokens   INTEGER,             -- LLM input tokens (NULL for S-tier)
  out_tokens  INTEGER,             -- LLM output tokens (NULL for S-tier)
  cost_usd    REAL,                -- LLM cost in USD (NULL for S-tier)
  ran_at      TEXT NOT NULL        -- ISO timestamp of this run
);
CREATE INDEX IF NOT EXISTS idx_detector_runs_detector ON detector_runs(detector, id DESC);

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

-- Kitchen-sink verdicts (kitchen-sink detector, tier P). The LLM's judgement of
-- whether a session mixed unrelated objectives — expensive, non-reproducible, and a
-- property of immutable session content — gets a permanent home here rather than
-- living in insight_evidence (a DISPLAY table capped at EVIDENCE_CAP and coupled to
-- the insight lifecycle: that coupling is exactly the bug this table avoids). One row per JUDGED
-- session, positive AND negative, so the card is a pure projection — windowed
-- positives, rebuilt every run, ageing out on their own. A positive re-judged
-- negative just flips is_kitchen_sink (a plain upsert), dropping it from the card.
-- split_seq is the main-thread seq the evidence points at; NULL for a negative verdict.
CREATE TABLE IF NOT EXISTS kitchen_sink_verdict (
  session_id       TEXT PRIMARY KEY,
  is_kitchen_sink  INTEGER NOT NULL,   -- 1 = mixed unrelated work, 0 = coherent
  split_block_idx  INTEGER,            -- block where the 2nd objective begins (NULL if coherent)
  split_seq        INTEGER,            -- that block's opening main-thread seq (the evidence pointer)
  reason           TEXT,               -- the LLM's one-sentence explanation
  model            TEXT,               -- model that produced the verdict
  detector_version INTEGER NOT NULL,   -- detector version at judge time
  judged_at        TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_kitchen_sink_verdict_positive ON kitchen_sink_verdict(is_kitchen_sink);

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

/**
 * Read-time views that turn `usage_facts` into the events the detectors and the
 * read path classify over. These are the SHARED definition of "a compaction" /
 * "a cache miss": the predicate lives here, in SQL, rather than inside one
 * detector's run loop, so nothing else in the product has to reimplement it.
 *
 * The thresholds are interpolated from `../core/thresholds` so a view literal can
 * never drift from the detector that owns the concept.
 *
 * Applied on every `openDb` with `DROP VIEW IF EXISTS` then an UNCONDITIONAL
 * `CREATE VIEW` — NEVER `CREATE VIEW IF NOT EXISTS`. On a definition change (a
 * threshold edit, a bug fix) the `IF NOT EXISTS` form is a silent no-op and an
 * existing store keeps the stale view forever, with nothing recording which.
 * Recreating unconditionally is cheap (views hold no data).
 */
function buildUsageViews(): string {
  return `
DROP VIEW IF EXISTS usage_turns;
CREATE VIEW usage_turns AS
WITH live AS (
  SELECT u.session_id, u.idx, u.ts, u.model, u.is_sidechain, s.provider, s.started_at,
         COALESCE(NULLIF(s.repo,''), NULLIF(s.cwd,''), '_unknown') AS repo,
         COALESCE(u.tok_input,0) AS input, COALESCE(u.tok_output,0) AS output,
         COALESCE(u.tok_cache_create_5m,0) AS creates_5m,
         COALESCE(u.tok_cache_create_1h,0) AS creates_1h,
         COALESCE(u.tok_cache_read,0) AS reads
  FROM usage_facts u JOIN sessions s ON s.id = u.session_id
  -- All-zero rows aren't API calls (content flushes, ingest-deduped repeats). Dropped
  -- HERE so the LAGs below mean "previous real turn", matching the JS loops' \`continue\`
  -- BEFORE prevOcc/prevCtx update.
  WHERE COALESCE(u.tok_input,0) + COALESCE(u.tok_output,0) + COALESCE(u.tok_cache_create_5m,0)
      + COALESCE(u.tok_cache_create_1h,0) + COALESCE(u.tok_cache_read,0) > 0
)
SELECT session_id, idx, ts, model, provider, repo, is_sidechain, started_at,
       input, output, creates_5m, creates_1h, reads,
       creates_5m + creates_1h AS creates,
       -- Occupancy excludes output: the reply isn't part of the prompt.
       input + reads + creates_5m + creates_1h AS occupancy,
       -- What the next warm turn would read back: reads plus what THIS turn cached
       -- (creates, or billed input under read-discount caching).
       reads + CASE WHEN creates_5m + creates_1h > 0 THEN creates_5m + creates_1h ELSE input END AS new_ctx,
       LAG(input + reads + creates_5m + creates_1h) OVER w AS prev_occupancy,
       LAG(reads + CASE WHEN creates_5m + creates_1h > 0 THEN creates_5m + creates_1h ELSE input END) OVER w AS prev_ctx,
       LAG(ts) OVER w AS prev_ts,
       -- Unordered window p → whole-session max. MAX(...) OVER w (ordered) would be a
       -- RUNNING max, failing early turns that later turns pass.
       MAX(creates_5m + creates_1h + reads) OVER p AS session_cache_tokens
FROM live
-- Partition on (session_id, is_sidechain): sidechain rows share the session and
-- interleave by idx; without it a subagent turn becomes a main turn's "previous".
-- All subagents share is_sidechain=1 — no per-agent series here.
WINDOW w AS (PARTITION BY session_id, is_sidechain ORDER BY idx),
       p AS (PARTITION BY session_id, is_sidechain);

DROP VIEW IF EXISTS compaction_event;
CREATE VIEW compaction_event AS
SELECT session_id, idx, ts, repo, model, prev_occupancy, occupancy,
       prev_occupancy - occupancy AS dropped_tokens
FROM usage_turns
WHERE is_sidechain = 0
  AND prev_occupancy >= ${PEAK_FLOOR}
  AND occupancy <= prev_occupancy * ${DROP_SHARE};

DROP VIEW IF EXISTS cache_classified_turn;   -- the DENOMINATOR; miss rate needs both halves
CREATE VIEW cache_classified_turn AS
SELECT session_id, idx, ts, repo, model, provider,
       prev_ctx, reads, input, creates_5m, creates_1h, creates,
       CASE WHEN reads < prev_ctx * ${HIT_READ_SHARE} THEN 1 ELSE 0 END AS is_miss,
       -- 2-arg MIN() returns NULL if EITHER arg is NULL;
       -- safe only because the WHERE guarantees prev_ctx is non-null.
       MIN(prev_ctx - reads, CASE WHEN creates > 0 THEN creates ELSE input END) AS avoidable_tokens,
       CAST((julianday(ts) - julianday(prev_ts)) * 86400000 AS INTEGER) AS gap_ms
FROM usage_turns
WHERE is_sidechain = 0
  AND session_cache_tokens > 0        -- provider reports caching at all
  AND prev_ctx >= ${MIN_CONTEXT_TOKENS}
  AND new_ctx >= prev_ctx * ${SHRUNK_CTX_SHARE};   -- a rewrite is neither hit nor miss

DROP VIEW IF EXISTS cache_miss_event;
CREATE VIEW cache_miss_event AS SELECT * FROM cache_classified_turn WHERE is_miss = 1;
`
}

/**
 * Read-time views for capability usage — the shared definition of "this MCP server /
 * skill was invoked", read by `unused-capabilities` (and available to anything else).
 * The (kind, name) derivation — the MCP-server-from-tool-name grammar — lived only
 * inside that detector's query; hoisting it here makes it the one definition.
 *
 * Same lifecycle contract as `buildUsageViews`: `DROP VIEW IF EXISTS` then an
 * unconditional `CREATE VIEW` on every `openDb`. No thresholds here — the recency
 * window is a read-time predicate the consumer applies (`last_invoked_at >= since`),
 * since a capability used once long ago is not current use.
 */
function buildCapabilityViews(): string {
  return `
DROP VIEW IF EXISTS capability_invocation;
CREATE VIEW capability_invocation AS
WITH derived AS (
  SELECT t.session_id, t.idx, t.ts, t.is_sidechain, s.source, s.repo,
         CASE t.action WHEN 'mcp_call' THEN 'mcp' ELSE 'skill' END AS kind,
         -- Installed unit is the SERVER: text between the 1st and 2nd '__' in
         -- mcp__<server>__<tool>. Empty when there's no 2nd '__' — the substr length
         -- would go negative, which SQLite reads backwards.
         CASE t.action WHEN 'mcp_call' THEN
                CASE WHEN instr(substr(t.name, 6), '__') > 0
                     THEN substr(t.name, 6, instr(substr(t.name, 6), '__') - 1)
                     ELSE '' END
              ELSE t.name END AS name
  FROM tool_calls t JOIN sessions s ON s.id = t.session_id
  WHERE t.action IN ('mcp_call', 'skill')
)
SELECT session_id, idx, ts, is_sidechain, source, repo, kind, name
FROM derived WHERE name <> '';   -- drop malformed mcp names; don't emit a phantom "" capability

DROP VIEW IF EXISTS capability_usage;
CREATE VIEW capability_usage AS
SELECT source, kind, name, repo,
       COUNT(DISTINCT session_id) AS sessions,   -- adoption breadth, not chattiness
       COUNT(*)                   AS calls,
       -- strftime normalizes any offset to UTC before MIN/MAX, so mixed timestamp
       -- formats can't produce a wrong "latest" — fixed at source, not per comparison.
       MIN(strftime('%Y-%m-%dT%H:%M:%SZ', ts)) AS first_invoked_at,
       MAX(strftime('%Y-%m-%dT%H:%M:%SZ', ts)) AS last_invoked_at
FROM capability_invocation
WHERE is_sidechain = 0   -- a subagent runs against its own context; we ask what the
GROUP BY source, kind, name, repo;   -- user wired into their OWN sessions
`
}

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db) // add columns to pre-existing tables before SCHEMA (its indexes reference them)
  db.exec(SCHEMA)
  db.exec(buildUsageViews()) // after SCHEMA: the views read the tables it defines
  db.exec(buildCapabilityViews())
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
  // detector_runs became an append-only run log. The old shape keyed on `detector`
  // and upserted, so each run erased the previous one's spend — and an error run,
  // which has no model or cost of its own, blanked the last successful run's.
  // Rebuild (SQLite can't drop a PRIMARY KEY), carrying each detector's surviving
  // row over as its first log entry. Must follow the ADD COLUMN above so `model`
  // exists to copy. COALESCE on status because the old column was nullable and the
  // new one isn't — a NULL there would fail the insert and brick the store.
  if (tableExists('detector_runs') && !has('detector_runs', 'id')) {
    db.exec(`
      ALTER TABLE detector_runs RENAME TO detector_runs_v1;
      CREATE TABLE detector_runs (
        id          INTEGER PRIMARY KEY,
        detector    TEXT NOT NULL,
        version     INTEGER NOT NULL,
        status      TEXT NOT NULL,
        model       TEXT,
        in_tokens   INTEGER,
        out_tokens  INTEGER,
        cost_usd    REAL,
        ran_at      TEXT NOT NULL
      );
      INSERT INTO detector_runs (detector, version, status, model, in_tokens, out_tokens, cost_usd, ran_at)
        SELECT detector, version, COALESCE(status, 'ok'), model, in_tokens, out_tokens, cost_usd, ran_at
        FROM detector_runs_v1;
      DROP TABLE detector_runs_v1;
    `)
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
