---
name: tuneloop-query
description: Query the local tuneloop store of AI agent sessions with read-only SQL. Use when the user wants any metric, slice, or aggregation of their tuneloop data — cost, tokens, tool usage, or artifacts.
---

# Querying the tuneloop store

`tuneloop analyze` builds a local SQLite store of your AI agent sessions. This
skill runs read-only SQL over it — any query, from a quick count to a custom
aggregation.

**Prerequisite:** the `tuneloop` CLI must be on your PATH — install with
`npm i -g tuneloop`, or run it through `npx tuneloop`. If the command isn't found,
the store isn't set up; say so instead of guessing at the data.

Run queries with:

```bash
tuneloop query "<SQL>"          # text table
tuneloop query --json "<SQL>"   # JSON rows
tuneloop query --limit 200 …    # row cap (default 1000)
tuneloop query --schema         # tables + facets + measures
tuneloop query --db <path> …    # non-default store location
```

Only `SELECT` / `WITH … SELECT` run — writes, `PRAGMA`, `ATTACH`, and stacked
statements are rejected, and `session_blobs` (raw transcripts) is off-limits.
Query the fact tables.

## Steps

1. **Learn the shape and extent.** Run `tuneloop query --schema` — it prints the
   store's coverage (session count, date span, sources, repos, analyzed
   directories, last analyzed) then every table, facet, and measure. Done when you can name each table/column the
   query touches and know the data's span — never guess a column or a date range.
   ([reference/schema.md](reference/schema.md) has the table shapes offline.)
2. **Confirm the rows exist.** `artifacts`, `annotations`, and `block_annotations`
   are populated only if the relevant processor/enrichment ran. Probe first — e.g.
   `SELECT kind, COUNT(*) FROM artifacts GROUP BY kind` or
   `SELECT DISTINCT processor, key FROM annotations`. Done when every table the
   query depends on is confirmed non-empty (or the query is adjusted to what is).
3. **Aggregate at the right grain.** Apply the grain rules below. Done when every
   SUM/COUNT sits at the grain that owns the number and no join crosses grains to
   fan out.
4. **Run and read the caps.** A result stops at the row/byte/time cap and prints
   why. Widen with `--limit`, or narrow the query. Done when the result is
   complete, or the truncation is reported to the user with its cause.

## Grain

Every row lives at a grain, nested:

```
session  ⊃  block  ⊃  { usage_facts , tool_calls }
```

Aggregate each number at the grain that owns it, or you double-count. Three rules:

- **Cost and tokens live at usage grain** — `usage_facts`, one row per assistant
  message (`model`, `is_sidechain`, token columns, `cost_usd`). Break cost down by
  model *here*. `sessions.cost_usd` / `sessions.models` are convenience rollups;
  never `GROUP BY` a model off `sessions` — its `models` is a JSON array and you
  would double-count.
- **Never join `usage_facts` to `tool_calls`.** They are siblings under a block, so
  a direct join fans out — every usage row × every tool row — and inflates every
  SUM. Aggregate each to `session_id` in separate subqueries, then join those.
- **Sidechain rolls up — it's counted, not dropped.** Block *boundaries* are cut on
  the main thread, but `block_usage` / `block_tool` map EVERY row into a block:
  sub-agent (sidechain) usage rolls up to the block whose `Task` call spawned it
  (nearest-by-time for orphans). So block-grain is exhaustive over all usage — a
  per-PR / per-feature cost already includes sub-agent spend.

## EAV / JSON values

Enrichment lands in generic key/value tables whose `value` is JSON-encoded:
`annotations` (session grain — e.g. `complexity`, `autonomy`, `intent`) and
`block_annotations` (block grain — e.g. `use_case`). Extract with
`json_extract(value, '$')`.

## What's populated

Only `artifacts.kind IN ('file','pr','feature')` populate in the OSS CLI;
`commit`/`ticket` and `artifact_links` are usually empty. Reach artifacts from
sessions via `session_artifacts` / `block_artifacts`.

## Recipes

Worked queries for the common analyses — sidechain split, cost-per-model, cache
leverage, tool latency, `action` breakdown, PR cycle time, spend-by-branch — in
[reference/recipes.md](reference/recipes.md).
