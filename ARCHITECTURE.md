# Architecture

aivue is a local pipeline that turns AI coding session transcripts into linked,
queryable facts. This document is the contract; it's stable across vendors.

## Pipeline

```
discover → parse/normalize → extract (static) → enrich (LLM) → persist → serve
           [adapter]          [processors]       [processors]    [store]   [dashboard]
```

The hard rule: **`analyze` only writes the store; the dashboard, `search`, and
`observe` only read it.** So `observe` is `analyze` in a watch loop, `search` is
a store query, and the (future) dashboard is swappable — none are entangled with
parsing or LLM logic.

## The two extension points

Everything extensible lives in two registries (`src/core/registry.ts`):

1. **Source adapters** (`SourceAdapter`, `src/adapters/`) — turn a vendor's
   transcript into the normalized model. Claude Code today. An adapter is the
   *only* place that knows a vendor's quirks (line-type zoo, `toolUseResult`,
   sidechains, tool names).
2. **Processors** (`Processor`, `src/core/processor.ts`, `src/processors/`) —
   derive facts from a normalized session. Token/cost is computed at ingest;
   everything else (files-touched, git/PR outcomes, future LLM enrichment) is a
   processor.

## The normalized model (`src/core/model.ts`)

The contract every processor reads. A `Session` has ordered `events`, a
flattened `toolCalls` convenience view, rolled-up `tokens`, and `raw` (path +
content hash) as an escape hatch. Each `ToolCall` carries a **canonical
`action`** (`file_write | file_read | shell | search | task_spawn | mcp_call |
web | todo | skill | other`) so common extractors stay vendor-neutral, plus its
raw input/result for specialized ones.

## The processor interface

```ts
interface Processor {
  name: string
  version: number          // bump to invalidate the cache and reprocess
  kind: 'static' | 'enrichment'
  needs?: { llm?; network? } // gates execution (llm skips with no key)
  requires?: string[]      // topo-sorted before this runs
  dimensions?: DimensionSpec[] // sliceable facts → dashboard registry
  run(ctx): ProcessorResult    // emits annotations / artifacts / links / outcomes / files
}
```

The runner (`src/core/runner.ts`) topo-sorts by `requires` and skips any
processor whose `(version, content-hash, model)` already matches a recorded run
— cheap re-runs. The store stamps every row with its producing processor, so a
re-run replaces that processor's rows without touching others' or user-authored
ones (explicit-over-implicit precedence).

### Adding a processor (the whole story)

Create one file in `src/processors/`, implement `Processor`, `registerProcessor`
it, add it to `src/processors/index.ts`. Example — "did this session run tests?":
scan `ctx.session.toolCalls` for test commands, emit
`{ annotations: [{ key: 'tests_passed', value: true }] }`, and declare
`dimensions: [{ key: 'tests_passed', type: 'boolean', sliceable: true }]`. Done
— no store migration, no dashboard code.

## Storage & metrics (`src/store/`)

SQLite, **fact tables only — no pre-aggregated metrics.** Every dashboard number
is a query at read time. Tables: `sessions` (hot row + cost + tokens),
`session_blobs` (gzipped normalized JSON for the viewer), `tool_calls`,
`artifacts` (polymorphic: file/commit/pr/ticket/feature, with `completed_at` +
`complexity` + `owner`), `artifact_links` (the transitive chain to features),
`session_artifacts`, `outcomes` (multi-tag, nullable artifact), `annotations`
(generic EAV — new dimensions need no migration), `processor_runs` (cache +
analysis-cost), `files_index`, `dimensions` (registry powering generic slicing).

Why query-time, not rollups: at individual-dev scale SQLite aggregates instantly,
rollups would freeze the slicing dimensions and fight the extensibility story. A
metric is a `WHERE`/`GROUP BY`; a new processor's fact is a new slice for free.
Session-level metrics cohort on `started_at`; the cost-per-shipped KPI windows on
`completed_at`.

## Data model decisions

- **Cost per shipped artifact** is the metric of record (windowed KPI + burn and
  throughput curves), not the old session-start "cost per outcome". `feature` is
  a first-class artifact reached transitively (session → PR → ticket → feature).
- **Features in the CLI** are created manually in the UI (later) or, optionally,
  inferred from the codebase behind an upfront cost estimate. Completion is a
  manual "mark shipped".
- **Outcomes may have no artifact** (`session_success`, `plan_drafted`, a commit
  with no resolvable SHA) — `outcomes.artifact_id` is nullable.

## v1 scope

Built: Claude Code adapter, normalized model, registry + runner + cache, SQLite
store, cost from a static price table, `files-touched` and `outcomes-git`
processors, the `analyze` command. Designed-for-but-not-built: LLM enrichment
processor, the web dashboard, `observe` and `search` commands, additional
adapters (Codex, Cursor).
