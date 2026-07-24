# Implementation Plan — Global Detector Storage, Windowed Presentation

Status: design settled (discussion 2026-07-22), not started.
Findings this closes, from the PR #84 review: **N4** (windowed detectors never resolve their insight, so a
stale claim is presented as current) and **N6** (kitchen-sink's windowed intake with unbounded evidence
accumulation). The related cost-grain erasure is already fixed — `detector_runs` became an append-only log
in `e423dda` — and is listed here only because it is the same root cause seen from the storage side.
Related: `docs/plans/detector-framework.md`, `docs/plans/kitchen-sink-detector.md`.
Drafted SQL for every view below is in the appendix, validated against a real store.

## Problem

Every detector except `recurring-themes` windows its **scan** to 30 days (`WINDOW_DAYS = 30`, declared
four separate times). That conflates two different things: what we compute over, and what we report on.
Consequences, all verified in the code:

- **Stale claims presented as current (N4).** `cache-miss`, `context-exhaustion` and `unused-capabilities`
  all `return []` when nothing qualifies, and `persistInsights` is a no-op on an empty list. The previously
  surfaced row freezes — `cache-miss.ts:202` keeps asserting "Across 14 sessions … in the last 30 days …
  $12.40 premium" when the last 30 days now contain none of that. Only `kitchen-sink.ts:426` calls
  `resolveInsight`. None of the three can be closed by fix-adoption either: that keys on a `tuneloop-fix:`
  marker, which only `fix-prompt` fixes carry, and these emit `behavioral-nudge` / `config-snippet`.
- **The trigger is not "the user fixed it."** `MIN_SESSIONS = 10` *within the window* is part of the
  qualifying filter, so not touching a repo for a few weeks freezes the card identically to fixing it.
- **Windowed intake with unbounded state (N6).** `kitchen-sink` selects candidates over 30 days but
  `mergeEvidence` only drops a session that is re-judged negative — which requires it to still be an unseen
  candidate, i.e. still inside the window. A session flagged six months ago stays in `count` forever while
  every other figure on the card is 30-day-scoped, and severity locks at `high` after three lifetime flags.
- **The promised trend is unshowable.** `context-exhaustion.ts:17-18` says "adoption shows up as a downward
  trend." A single scalar that is overwritten each run cannot show one.
- **Thresholds don't survive scale.** `MIN_WASTE_USD = 1` and `MIN_SESSIONS = 10` are absolute against
  wildly different usage volumes: a light user never clears them, a heavy user always does.

## Core design decisions (keep the rationale — these were argued through, don't relitigate)

1. **Scan globally, present windowed.** The 30 days becomes a predicate at read time, not a scan boundary.
   Nothing is discarded; the card still speaks about a recent period.

2. **Derive what you can recompute; store what you can't.** `cache-miss`, `context-exhaustion` and
   `unused-capabilities` classify from facts already in the store, so they become **SQL views — no new
   tables**. `kitchen-sink`'s verdict is LLM output: expensive, non-reproducible, permanent — so it **needs
   a table**. These are the same principle, not a contradiction.

3. **Views are the shared definition, read by detectors *and* the read path.** Display-only views would put
   the predicate in two places and let them drift. Today the compaction predicate exists only inside
   `context-exhaustion.run()`, which is why nothing else in the product can reference it.

4. **Thresholds live in one shared constants module and are interpolated into the view SQL.** Views take no
   parameters, so a literal in `db.ts` would drift from the detector that owns the concept.

5. **`first_seen_at` stays earliest-ever** (the `MIN` from commit `04c8de9`); the windowed count is a
   separate number. Both belong on the card: "12 sessions in the last 30 days, first seen in March" says
   more than either alone.

6. **`unused-capabilities` keeps recency intrinsically.** Going fully global there is actively wrong: "never
   invoked" over all history means a server used once two years ago counts as live forever. Use
   `last_invoked_at` as a global fact and apply staleness at read time.

7. **Bucket by the event's own timestamp**, not `sessions.started_at`. Today's window dates a turn by when
   its session began.

## Work items (fan out; dependencies noted)

### W0 — View infrastructure + shared thresholds (BLOCKS W1, W4, W5)
Small, do first. `src/store/db.ts`, new `src/core/thresholds.ts`.
- Add a view section applied on every `openDb`, **`DROP VIEW IF EXISTS` then unconditional `CREATE VIEW`**.
- Move `DROP_SHARE`, `PEAK_FLOOR`, `HIT_READ_SHARE`, `SHRUNK_CTX_SHARE`, `MIN_CONTEXT_TOKENS` into
  `thresholds.ts`; interpolate into the schema string; detectors import from there.
- Bump `SCHEMA_VERSION`.
- Acceptance: changing a threshold constant and reopening an existing store changes the view's output.

### W1 — `usage_turns` / `compaction_event` / `cache_miss_event` views (BLOCKS W2, W3)
`src/store/db.ts`. **SQL in Appendix A** — run against a real store (15,198 turns → 9 compactions; 143 misses
of 12,179 classified). See the Landmines section; every one of them is load-bearing.
- `usage_turns`: zero-rows filtered in a CTE **before** the `LAG`s; ordered window `w` for `LAG`, unordered
  window `p` for the session-level cache gate.
- `compaction_event`, `cache_classified_turn` (the denominator), `cache_miss_event`.
- Acceptance: the diff-test harness below.

### W2 — `cache-miss` detector on views (needs W1)
`src/detectors/cache-miss.ts`. Replace the row-pull-and-loop with aggregate queries. Dollars stay in JS
(`priceFor` has no SQL equivalent) — the view yields `avoidable_tokens` plus the rate inputs.

### W3 — `context-exhaustion` detector on views (needs W1)
`src/detectors/context-exhaustion.ts`. Same shape. Session-level `peak` (used in evidence notes) is an
aggregate over `usage_turns`, not part of the event view.

### W4 — `capability_invocation` / `capability_usage` views + `unused-capabilities` (needs W0 only)
`src/store/db.ts`, `src/detectors/unused-capabilities.ts`. **SQL in Appendix B** — verified against a real store.
- `queryInvoked`'s windowed scan is replaced by `WHERE last_invoked_at >= :since`, or dropped in favour of a
  `days_since` staleness framing.
- **The set difference stays in TypeScript.** A never-invoked capability has *no row*; "never used" is the
  absence of one, and the INSTALLED side is vendor-specific JSON parsed by `parseInstalledMcp` /
  `parseInstalledSkills`. Do not push that grammar into the schema.
- `MAX(t.ts)` replaces `s.started_at` as the usage timestamp — verified populated (32/32 calls, 0 null).
- **Two time axes now, not one — keep them separate (added post-PR #86, `4ed0378`).** A *second*, unrelated
  window already gates this detector: the **config-tenure** gate. A `remove` verdict is trusted only for a
  capability that was already installed at `tenureCutoffIso` (`MIN_REMOVAL_TENURE_DAYS` = 10, read via
  `envSnapshotAsOf` over the environment-snapshot timeline) — a capability installed 3 days ago can't be
  "unused across the 30-day window", its absence from older sessions isn't disuse. That is orthogonal to the
  *usage* window this work item globalizes: tenure is about how long the config has held, usage about when it
  last ran. When W4 replaces the `s.started_at` usage scan with `last_invoked_at` / `days_since`, leave the
  tenure gate (`removalEligible`, `loadInstalled`'s `tenureCutoffIso` arg) untouched. `scope` verdicts rest
  on positive use and are gated by neither.
- **The tenure gate is a down-payment on N4 here.** It already reads the config *timeline* (`envSnapshotAsOf`,
  which the environment reader tombstones on deletion), which is exactly the structural signal for detecting
  that a user *applied* the fix — a capability that dropped out of config. W7's resolve step for this detector
  should build on that timeline rather than the marker mechanism (`config-snippet` fixes carry no
  `tuneloop-fix:` id, so adoption can't be detected the marker way).

### W5 — `kitchen-sink`: verdict table + windowed presentation (needs W0, W6) — LANDED 2026-07-24
`src/store/db.ts`, `src/detectors/kitchen-sink.ts`.
- New table for the verdict — session id, verdict, split block idx, reason, judged-at, model, detector
  version. Root cause of N6 is that the verdict has no home, so `insight_evidence` (a *display* table, capped
  at `EVIDENCE_CAP`, coupled to insight lifecycle) became the system of record.
- Candidate selection goes global; the card computes count and evidence over the last 30 days of
  **`sessions.started_at`**, not `judged_at` — otherwise re-judging shifts sessions into the window.
- Severity keys off the **windowed** count so it can come back down.
- Ageing-out becomes automatic; `mergeEvidence`'s negative path shrinks to correcting a changed verdict.
- The existing `resolveInsight` call at `:426` then fires naturally when the window empties.
- Verdicts are cached per session (`detector_session_runs`), so going global is a **one-time backfill**, not
  recurring spend. The judgement is a property of immutable content and never goes stale.

**As landed:** `kitchen_sink_verdict` (session_id PK) stores every JUDGED session — positive AND negative —
with `split_block_idx` + the resolved `split_seq` (the evidence pointer, computed at judge time so the read
path never re-hydrates), `reason`, `model`, `detector_version`, `judged_at`. `recordKitchenSinkVerdicts` is a
plain `INSERT OR REPLACE`, so a positive re-judged negative just flips `is_kitchen_sink` and drops out of the
card — `mergeEvidence`/`seenWindow`/the `insight_evidence` read-back are all deleted. `candidates()` scans all
history (`ALL_TIME = ''`); `run()` rebuilds the card EVERY analyze from `kitchenSinkPositives(windowStart)`, so
a positive ages off on its own even when nothing was judged. Per decision 5, `firstSeenAt` is the MIN over ALL
positives (whole history) while count/evidence/`lastSeenAt` are windowed. Detector bumped **v2 → v3** so the
runner's version-reset re-judges the corpus into the new table (the one-time backfill). SCHEMA_VERSION 20 → 21.

### W6 — `--limit` bounds detectors (BLOCKS W5) — LANDED 2026-07-24
Round-1 finding #4. W5's first run judges every historical candidate with an LLM and there is currently no
way to cap or dry-run it. Land the bound (and ideally a pre-run cost estimate) first.

**As landed:** the existing `--limit` now bounds detectors too (threaded `analyze` → `runDetectors` →
`DetectorContext.limit`). **P-tier** detectors (kitchen-sink) judge at most `limit` unseen candidates per run —
safe because each verdict is cached and the card rebuilds from the table, so the backfill is throttled across
runs. **X-tier** (cross-session) detectors are **skipped entirely** under a limit and say so at `info`: their
extract-per-session → reconcile → surface-over-the-whole-corpus flow can't be partially bounded without leaving
written rows inconsistent (design decision, 2026-07-24). The optional pre-run cost estimate is **deferred** —
`--limit` gives the throttle; a token-count dry-run can follow if wanted.

### W7 — Resolve sweep (after W2–W5)
Verify each detector's empty path ends in `resolveInsight`. For W2/W3/W5 this should fall out of the design;
confirm rather than assume. Where a detector still needs an explicit call, distinguish **"clean now"** from
**"not enough data"** — `qualifying.length === 0` collapses both today, and resolving on the second tells a
user back from a month off that they fixed everything.

## Landmines (each one bit during the SQL drafting)

1. **Filter zero-token rows *before* the `LAG`.** Both JS loops `continue` before updating `prevOcc`/
   `prevCtx`, so "previous" means previous *real* turn. `LAG` over unfiltered rows invents a 100% drop.
2. **Partition by `(session_id, is_sidechain)`, not `session_id`.** Sidechain rows share the session and
   interleave by `idx`. Note all subagents share `is_sidechain = 1` — `usage_facts` has no agent column — so
   sidechain series are not per-agent. Consumers should stay on `is_sidechain = 0`.
3. **Two windows, not one.** `MAX(...) OVER w` where `w` has an `ORDER BY` yields a *running* max
   (`RANGE UNBOUNDED PRECEDING`), so early turns fail a gate later turns pass.
4. **2-arg `MIN()` returns NULL if either argument is NULL** — the trap behind the B4 fix. Safe in
   `cache_classified_turn` only because the `WHERE` guarantees `prev_ctx` is non-null.
5. **Never `CREATE VIEW IF NOT EXISTS`.** On a definition change it is a silent no-op and an existing store
   keeps the old view forever, with nothing recording which.
6. **Normalize timestamps before comparing** — `strftime('%Y-%m-%dT%H:%M:%SZ', ts)` for MIN/MAX. Fixes N10
   at the source instead of at each comparison site.

## Verification harness

**The acceptance gate for W1–W4 is a diff test**: run the existing JS detector and the new SQL over the same
corpus and assert the event sets are *identical* — same sessions, same turn indices, same counts. A silent
divergence here would be very hard to spot later. Keep the old implementation available until the diff is
green over a real store, not just fixtures.

## Open decisions — RESOLVED for cache-miss (W2, 2026-07-23)

Settled while landing W2, after seeing the real store: the absolute rate gate
(`MIN_MISS_RATE`) suppressed **every** repo — a heavy user's 1–5 % cold-start rate never
clears 25 % — while $132/mo of avoidable premium sat unsurfaced (aivue $76, newCo-X $57).
So the level card is now gated on **dollars, not rate**.

- **Replace or supplement → LEVEL card only, for cache-miss.** A dollar-gated card
  (`signalKey 'cache-misses'`, `repo '*'`, gated on `sessions ≥ MIN_SESSIONS` and
  `wasteUsd ≥ MIN_WASTE_USD`; the miss-rate gate is retired). It resolves at its empty path
  (the N4 fix, inline — doesn't wait for W7). A weekly deviation/"spiking" card was
  prototyped and **dropped**: two insights from one detector was too noisy for the value it
  added, and the level card already carries the dollars that matter. The card text reports
  the **share of sessions that saw a miss** (not a per-turn rate), the premium paid, and
  the >5-min timing split.
- **Deferred (not relitigated): the trend/deviation form.** The weekly-bucket +
  own-baseline design (rolling 7-day current window, ≥2 active baseline weeks to have a
  baseline, current ≥ max(K× median, $ floor)) was validated end-to-end against the real
  store before removal. Revisit only if a "getting worse" signal is explicitly wanted, and
  for `context-exhaustion` (W3), where a level alert has no principled dollar threshold (no
  cost units) — trend may be the only honest form there.

## Explicitly deferred (write down so they aren't relitigated)

- **`model_prices` table.** Dollars stay in JS; views stop at token counts.
- **Per-model context-window normalization.** `PEAK_FLOOR = 100_000` is absolute, so a user migrating from a
  200K-context model to a 1M one sees their compaction rate move for reasons unrelated to their habits — and
  a trend line reads that as adoption. Needs per-model context windows, which the store doesn't have.
- **Measures-framework repoint.** `source` binds to a physical table in ~4 places in `store.ts`
  (1784, 1832, 1867, 2255). Either add a `FacetSource` or define the view as a superset of `usage_facts` and
  repoint `'usage'` — the latter is a one-line change per site, but verify none of those paths *writes*
  through the alias, since views are read-only.
- **Installed-side JSON in SQL** for `unused-capabilities` (see W4).
- **`recurring-themes` decay.** It is already global, but a theme that fired eight times last spring and
  never since still clears `MIN_EVENTS` and keeps surfacing. Same staleness problem from the other direction.

## Appendix A — usage views (W1)

Thresholds appear as literals below for readability; per decision 4 they are interpolated from
`src/core/thresholds.ts` into the schema string (`PEAK_FLOOR` = 100000, `DROP_SHARE` = 0.4,
`HIT_READ_SHARE` = 0.5, `SHRUNK_CTX_SHARE` = 0.5, `MIN_CONTEXT_TOKENS` = 10000). Apply with
`DROP VIEW IF EXISTS` then an unconditional `CREATE VIEW` on every `openDb` (landmine 5).

```sql
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
  -- HERE so the LAGs below mean "previous real turn", matching the JS loops' `continue`
  -- BEFORE prevOcc/prevCtx update (landmine 1).
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
       -- RUNNING max, failing early turns that later turns pass (landmine 3).
       MAX(creates_5m + creates_1h + reads) OVER p AS session_cache_tokens
FROM live
-- Partition on (session_id, is_sidechain): sidechain rows share the session and
-- interleave by idx; without it a subagent turn becomes a main turn's "previous"
-- (landmine 2). All subagents share is_sidechain=1 — no per-agent series here.
WINDOW w AS (PARTITION BY session_id, is_sidechain ORDER BY idx),
       p AS (PARTITION BY session_id, is_sidechain);

DROP VIEW IF EXISTS compaction_event;
CREATE VIEW compaction_event AS
SELECT session_id, idx, ts, repo, model, prev_occupancy, occupancy,
       prev_occupancy - occupancy AS dropped_tokens
FROM usage_turns
WHERE is_sidechain = 0
  AND prev_occupancy >= 100000            -- PEAK_FLOOR
  AND occupancy <= prev_occupancy * 0.4;  -- DROP_SHARE

DROP VIEW IF EXISTS cache_classified_turn;   -- the DENOMINATOR; miss rate needs both halves
CREATE VIEW cache_classified_turn AS
SELECT session_id, idx, ts, repo, model, provider,
       prev_ctx, reads, input, creates_5m, creates_1h, creates,
       CASE WHEN reads < prev_ctx * 0.5 THEN 1 ELSE 0 END AS is_miss,   -- HIT_READ_SHARE
       -- 2-arg MIN() returns NULL if EITHER arg is NULL (landmine 4 / the B4 trap);
       -- safe only because the WHERE guarantees prev_ctx is non-null.
       MIN(prev_ctx - reads, CASE WHEN creates > 0 THEN creates ELSE input END) AS avoidable_tokens,
       CAST((julianday(ts) - julianday(prev_ts)) * 86400000 AS INTEGER) AS gap_ms
FROM usage_turns
WHERE is_sidechain = 0
  AND session_cache_tokens > 0        -- provider reports caching at all
  AND prev_ctx >= 10000               -- MIN_CONTEXT_TOKENS
  AND new_ctx >= prev_ctx * 0.5;      -- SHRUNK_CTX_SHARE — a rewrite is neither hit nor miss

DROP VIEW IF EXISTS cache_miss_event;
CREATE VIEW cache_miss_event AS SELECT * FROM cache_classified_turn WHERE is_miss = 1;
```

Dollars stay in JS (`priceFor` is a JS table with no SQL equivalent): `cache_miss_event` stops at
`avoidable_tokens` and exposes the rate inputs (`creates_5m`, `creates_1h`, `input`, `model`, `provider`)
for the detector to price. Session-level `peak` for W3's evidence notes is `MAX(occupancy)` grouped over
`usage_turns`, not a column on the event view.

## Appendix B — capability views (W4)

```sql
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
       -- formats can't produce a wrong "latest" (landmine 6 / N10, fixed at source).
       MIN(strftime('%Y-%m-%dT%H:%M:%SZ', ts)) AS first_invoked_at,
       MAX(strftime('%Y-%m-%dT%H:%M:%SZ', ts)) AS last_invoked_at
FROM capability_invocation
WHERE is_sidechain = 0   -- a subagent runs against its own context; we ask what the
GROUP BY source, kind, name, repo;   -- user wired into their OWN sessions
```

A never-invoked capability has **no row** here — "never used" is the absence of one, expressible only as an
anti-join against the INSTALLED set (`parseInstalledMcp` / `parseInstalledSkills` over
`environment_snapshots` JSON, which stays in TypeScript). `queryInvoked`'s `WHERE s.started_at >= since`
scan becomes `WHERE last_invoked_at >= :since` on the consumer side, or is dropped for a `days_since`
staleness framing (`unused-capabilities` keeps recency intrinsically — decision 6).
