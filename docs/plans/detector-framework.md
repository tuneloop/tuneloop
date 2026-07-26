# Detector Framework — Insight Ledger + Registry

Status: **implemented** — `src/core/detector.ts`, `src/core/detector-runner.ts`,
`src/core/registry.ts` (extended), `src/store/db.ts` (schema v10),
`src/store/store.ts` (insight methods), `src/commands/analyze.ts` (pipeline hook),
`src/detectors/index.ts` (empty barrel). This document is the design of record.

## Problem

Processors derive per-session facts (cost, files touched, PRs, complexity), but tuneloop has
no mechanism to surface **cross-session patterns** as actionable improvement suggestions.
A developer repeatedly hitting the same permission prompt, or an agent looping on the same
error — these patterns are invisible unless someone manually reviews dozens of sessions.

The framework needs:
1. An interface for pattern detectors that query across all sessions.
2. A persisted ledger so findings survive across runs, support lifecycle states (dismiss,
   resolve), and dedup on re-detection.
3. Integration into the analyze pipeline, running after processors so detectors see the
   fully-populated store.

## Core design decisions

1. **Detectors are NOT processors.** Processors look at one session at a time and emit
   structured facts. Detectors look across all sessions and emit insights — a fundamentally
   different scope. They share no dependency ordering (detectors are independent of each
   other), no per-session caching, and no ProcessorResult output shape. A separate interface
   avoids overloading the processor contract.

2. **DetectorContext gives read-only store access, not pre-fetched data.** Processors receive
   a `ProcessorContext` with pre-loaded session data because every processor asks a predictable
   question about one session. Detectors ask unpredictable questions across all data — each one
   runs different SQL. Pre-fetching is impossible without anticipating every future detector's
   needs. Instead, detectors get `store.queryAll(sql, ...params)` / `store.queryOne(sql, ...params)`
   — enforced read-only via a separate `readonly: true` SQLite handle. Any write attempt
   (including `DELETE...RETURNING` or `PRAGMA` mutations) throws at the engine level.
   All writes go through the runner via `store.persistInsights()`.

3. **Insights persist to a ledger with lifecycle states.** Unlike read-time computations
   (which would be always-fresh but stateless), persisted insights support:
   - **Dismiss** — "I don't care" is permanent; the insight never resurfaces.
   - **Dedup** — same `(detector, repo, signal_key)` on re-detection updates the existing row.
   - **Lifecycle** — `surfaced → fix_issued → adopted → resolved | dismissed`.
   - **Reopen** — a resolved insight that re-fires flips back to `surfaced`.
   - **Evidence** — which sessions triggered this finding, for drill-in links.

4. **Per-detector versioning.** Each detector carries its own `version: number`. Bumping one
   detector's version does not invalidate or re-run others. The `detector_runs` table records
   what version last ran, enabling future P-tier cache logic without a global invalidation
   cascade.

5. **S-tier detectors always re-run (no caching).** SQL queries are sub-millisecond on a
   local SQLite store. Caching them would add complexity for no wall-clock gain, and risks
   stale insights when new sessions are ingested. P/X-tier (LLM) detectors use
   `detector_session_runs` for incremental analysis — only process new/changed sessions.

6. **Parallel execution with full error isolation.** Detectors are independent — no `requires`
   graph, no shared state. The runner fires all applicable detectors concurrently via
   `Promise.allSettled`. S-tier completes instantly; P-tier benefits from not waiting in
   sequence. Both `run()` failures and persistence failures are caught per-detector —
   a single detector's failure does not block others or abort the analyze run.

7. **Dismissed = terminal.** Once a user dismisses an insight, `persistInsights` skips that
   `(detector, repo, signal_key)` on all future runs. The only recovery is manual (a future
   "un-dismiss" endpoint, not built). This is a deliberate product decision: dismissed
   findings are noise the user already evaluated and rejected.

8. **Enforced read-only access for detectors.** Detectors do not receive a write-capable DB
   handle. `queryAll()` / `queryOne()` use a separate `new Database(path, { readonly: true })`
   connection — SQLite enforces the constraint at the engine level, not just by convention.

9. **Repo scoping on insights.** Insights carry a `repo` column for per-repo faceting:
   - Repo name (e.g. `'tuneloop'`) — insight specific to that repo
   - `'*'` — cross-repo insight (pattern spans multiple repos)
   - cwd path — for sessions not in a git repo
   - `'_unknown'` — fallback when neither repo nor cwd is available

## The Detector interface

```typescript
interface Detector {
  name: string              // dedup namespace in the insights table
  version: number           // bump to force re-run (per-detector)
  tier: 'S' | 'P' | 'X'   // S=SQL-only, P=per-session LLM, X=cross-session LLM
  needsLlm?: boolean       // runner skips when no provider configured
  applicable?(ctx): boolean // static pre-gate (avoid wasted LLM spend)
  run(ctx): Promise<InsightInput[]> | InsightInput[]
}
```

P/X-tier support is structural: a detector can declare `tier: 'P'`, `needsLlm: true`, and
call `ctx.llm.completeStructured(...)` inside `run()` with its own prompt and output schema.
The runner's LLM gate (`needsLlm && !llmEnabled → skip`) is already in place.

## What the runner does

```
1. Filter: remove detectors that need LLM (when none configured) or fail applicable()
2. Run:    fire all applicable detectors in parallel (Promise.allSettled)
3. Persist: for each result, try store.persistInsights(); catch failures per-detector
4. Log:    both run() and persist failures are warned + recorded, never fatal
```

## Schema (4 tables, SCHEMA_VERSION 9 → 10)

### `insights` — one row per unique finding

| Column | Type | Purpose |
|--------|------|---------|
| id | TEXT PK | UUID, generated on first detection |
| detector | TEXT | Which detector produced this |
| signal_key | TEXT | Dedup key within the detector |
| repo | TEXT NOT NULL DEFAULT '_unknown' | Repo scope (name, '*', cwd, or '_unknown') |
| severity | TEXT | 'high' \| 'medium' \| 'low' |
| state | TEXT | Lifecycle: surfaced \| fix_issued \| adopted \| resolved \| dismissed |
| title | TEXT | One-line card heading |
| description | TEXT | Explanation with evidence context |
| count | INTEGER | Total occurrences |
| fix_type | TEXT | 'config-snippet' \| 'behavioral-nudge' \| 'install-command' \| 'fix-prompt' |
| fix_label | TEXT | Action button text |
| fix_content | TEXT | The deliverable (JSON, prose, command, or prompt) |
| first_seen_at | TEXT | ISO timestamp of first detection |
| last_seen_at | TEXT | ISO timestamp of most recent detection |
| state_changed_at | TEXT | When lifecycle state last transitioned |
| detector_version | INTEGER | Version of detector that last wrote this |

`UNIQUE(detector, repo, signal_key)` enforces dedup at the DB level.

### `insight_evidence` — session/turn refs per insight

| Column | Type | Purpose |
|--------|------|---------|
| insight_id | TEXT | FK → insights.id (CASCADE) |
| session_id | TEXT | FK → sessions.id (CASCADE) |
| turn_idx | INTEGER | Turn within the session (-1 = session-level) |
| added_at | TEXT | When this evidence was recorded |

PK: `(insight_id, session_id, turn_idx)`. Capped at 10 per insight in the store method.

### `detector_runs` — one row per detector (invocation receipt)

| Column | Type | Purpose |
|--------|------|---------|
| detector | TEXT PK | Detector name |
| version | INTEGER | Version at time of run |
| status | TEXT | 'ok' \| 'error' |
| in_tokens | INTEGER | LLM input tokens (NULL for S-tier) |
| out_tokens | INTEGER | LLM output tokens (NULL for S-tier) |
| cost_usd | REAL | LLM cost in USD (NULL for S-tier) |
| ran_at | TEXT | ISO timestamp |

### `detector_session_runs` — per-(detector × session) cache

| Column | Type | Purpose |
|--------|------|---------|
| detector | TEXT | Detector name |
| session_id | TEXT | FK → sessions.id (CASCADE) |
| content_hash | TEXT | Session content hash at time of processing |
| ran_at | TEXT | ISO timestamp |

PK: `(detector, session_id)`. Enables incremental analysis for P/X-tier: on re-run,
`store.detectorUnseen(name)` returns only sessions whose hash changed or weren't seen before.

## Store persistence logic (`persistInsights`)

For each `InsightInput` the detector returned:

1. Look up `(detector, repo, signal_key)` in the `insights` table.
2. **Exists + state = 'dismissed'** → skip. Dead means dead.
3. **Exists + state = 'resolved'** → reopen: flip state to 'surfaced', update state_changed_at.
   Then UPDATE severity, title, description, count, fix, last_seen_at, detector_version.
   Replace evidence rows (DELETE + re-INSERT, capped at 10).
4. **Exists + other state** → UPDATE severity, title, description, count, fix,
   last_seen_at, detector_version. Replace evidence rows (capped at 10). State unchanged.
5. **Not exists** → INSERT with state = 'surfaced', first_seen_at = now, new UUID.

Then upsert the `detector_runs` row. The entire operation is one transaction.

## Lifecycle state machine

```
surfaced → fix_issued → adopted → resolved
    ↓           ↓           ↓         ↓
 dismissed   dismissed   dismissed  dismissed

resolved → surfaced  (reopen: re-detection or manual)
```

Any state can skip ahead to `resolved` (e.g. behavioral nudges with no intermediate steps).
`resolved` can reopen to `surfaced` on re-detection or via API. `transitionInsight()` enforces
valid moves; invalid transitions return false and do nothing.

## Pipeline placement

```
analyze:
  discover → normalize → [per session: run processors] → refresh artifacts → prune
  → ★ run detectors (here — after all facts are written, stale data pruned)
  → stamp last_analyze_at
```

Detectors see the fully-populated, pruned store. They never run during per-session
processing (they'd see incomplete data).

## Registration (same pattern as processors)

```
src/core/registry.ts:   registerDetector(d) / getDetectors()
src/detectors/index.ts: barrel of side-effect imports (currently empty)
src/register.ts:        import './detectors'
```

Adding a new detector = one file that defines a `Detector` object and calls
`registerDetector(...)` at module scope, plus one line in `src/detectors/index.ts`.

## How to write a detector (for the next ticket)

```typescript
// src/detectors/my-detector.ts
import { registerDetector } from '../core/registry'
import type { Detector, InsightInput } from '../core/detector'

const myDetector: Detector = {
  name: 'my-detector',
  version: 1,
  tier: 'S',

  run(ctx) {
    const rows = ctx.store.queryAll(`
      SELECT ... FROM tool_calls WHERE ... GROUP BY ... HAVING count >= 3
    `) as Array<{ ... }>

    return rows.map(row => ({
      signalKey: row.someKey,
      repo: row.repo ?? '_unknown',
      severity: row.count >= 10 ? 'high' : 'medium',
      title: `...`,
      description: `...`,
      evidence: [{ sessionId: row.sessionId }],
      count: row.count,
      fix: { type: 'behavioral-nudge', label: 'Suggestion', content: '...' },
    }))
  },
}

registerDetector(myDetector)
```

Then add `import './my-detector'` to `src/detectors/index.ts`. Done.

## Explicitly deferred

- **P/X-tier cache logic in the runner.** The `detector_session_runs` table and
  `store.detectorUnseen()` / `store.markDetectorSessionSeen()` exist, but the runner does
  not call them automatically. P/X-tier detectors use them inside their own `run()` to
  compute the delta. Will promote to automatic runner logic after patterns emerge from
  the first LLM detectors.
- **LLM cost passthrough.** `persistInsights` accepts a `cost` parameter, but `run()` does
  not return cost info. A P-tier detector would need to track its own token usage internally
  and the runner would surface it.
- **API endpoints + dashboard tab.** The client rendering code (`src/server/client/insights.ts`)
  and Store read methods (`insights()`, `dismissInsight()`, `transitionInsight()`) exist, but
  no HTTP endpoints or UI wiring. Shipped separately with the first detectors.
- **Automated lifecycle transitions.** The state machine supports `fix_issued → adopted →
  resolved`, but nothing auto-advances today. Future: tuneloop detects config changes or
  metric improvement and transitions automatically.
- **Measurement loop + metrics.** The `measured` state and per-insight metric columns are
  deferred until we build the measurement loop alongside actual detectors — at that point
  we'll know what metrics look like (single number vs. multiple signals) and when to
  transition between states.
- **Detector concurrency limits.** `Promise.allSettled` fires all at once. For a large number
  of P-tier detectors hitting rate-limited APIs, a concurrency cap (e.g. `p-limit`) would be
  needed. Not required for S-tier.
