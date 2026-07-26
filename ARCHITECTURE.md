# Architecture

tuneloop turns the transcripts your AI coding tools already write — Claude Code,
Codex, OpenCode, Pi — into a small, queryable set of facts about your work: what you
built, what it cost, and what shipped. Everything runs locally against a SQLite
file on your machine. tuneloop never posts your session data anywhere: the only
thing that leaves is a transcript sent to the LLM provider whose key you supply
(enrichment only), while its other network calls are read-only — your local `gh`
for PR status, OpenRouter for a public price list.

This document is a map for anyone who wants to understand the internals, add
support for a new tool, or bend the metrics to their own definition of "shipped".

## The pipeline

```
discover ──▶ normalize ──▶ extract + enrich ──▶ persist ──▶ read
[adapter]    [adapter]        [processors]        [store]    [dashboard / query]
```

## The two extension points

Almost everything you'd want to change lives behind two small interfaces, both
kept in registries (`src/core/registry.ts`). `src/register.ts` imports the
built-ins for their registration side effects.

### 1. Source adapters — teach tuneloop a new tool

A `SourceAdapter` (`src/adapters/types.ts`) is where a vendor's quirks *should*
live: where its transcripts live, its line-type zoo, its tool names. It does
two things — find session files and parse each one into the normalized model:

```ts
interface SourceAdapter {
  id: string                 // 'claude-code'
  provider: string           // 'anthropic'
  parseVersion: number       // bump to re-ingest only this vendor's sessions
  defaultRoots(): string[]                       // where to look by default
  discover(roots): Promise<string[]>             // candidate session files
  parse(path): Promise<Session | null>           // → normalized Session
  discoverSessions?(roots): Promise<Session[]>   // for DB-backed tools (OpenCode)
}
```

Built-ins: `claude-code`, `codex`, `opencode`, `pi` (`src/adapters/*`). To add one,
implement the interface in `src/adapters/<vendor>/`, map the vendor's tool names
to canonical actions in an `actions.ts`, and `registerAdapter` it (add the import
to `src/register.ts`). For most of the pipeline that's enough — processors and
metrics work on the normalized model, so a new adapter lights up the whole
dashboard.

> **Known leak (TODO).** That boundary isn't fully clean yet. Vendor-specific code
> still lingers where *raw file edits* are parsed and rendered:
> `pr-content-match.ts` branches on `session.source` to extract the lines the
> agent authored, and `store/apply-patch.ts` + `store/store.ts` special-case
> Codex's `apply_patch` patch format against Claude/OpenCode's object-shaped
> edits. So a new adapter lights up most of the dashboard, but the file-diff view
> and content-match linkage may need a vendor branch until this is pulled up into
> a normalized file-edit shape on `ToolCall`.

### 2. Processors — derive a new fact

A `Processor` (`src/core/processor.ts`, `src/processors/`) reads a normalized
session and emits facts. Token cost is computed at ingest; *everything else* —
files touched, git/PR outcomes, LLM labels, cost attribution — is a processor.

```ts
interface Processor {
  name: string
  version: number             // bump to invalidate the cache and reprocess
  kind: 'static' | 'enrichment'
  needs?: { llm?; network? }  // gates execution (no LLM key → enrichment skips)
  requires?: string[]         // topo-sorted to run after these
  facets?: FacetSpec[]        // sliceable dimensions → dashboard cards + filters
  measures?: MeasureSpec[]    // numeric facts → dashboard metrics
  run(ctx): ProcessorResult   // emits annotations / artifacts / links / outcomes / files / blocks
}
```

The runner (`src/core/runner.ts`) topo-sorts by `requires` and **skips any
processor whose `(version, content-hash, model)` already matches a recorded
run** — so re-analyzing is cheap and only redoes what changed.

**Adding a processor, end to end.** Create one file in `src/processors/`,
implement `Processor`, `registerProcessor` it, and add the import to
`src/processors/index.ts`. Say you want "did this session run tests?": scan
`ctx.session.toolCalls` for a test command, emit
`{ annotations: [{ key: 'tests_passed', value: true }] }`, and declare
`facets: [{ key: 'tests_passed', type: 'boolean', source: 'annotation', roles: ['chart', 'filter'] }]`.
That's the whole story — no schema migration, no dashboard code. The new fact
shows up as a distribution card and a filter automatically, because the store's
`annotations` table is a generic key/value store and the dashboard renders
whatever facets are registered.

## The normalized model (`src/core/model.ts`)

The contract every processor reads, identical across vendors. A `Session` has:

- ordered `events` (the full turn-by-turn transcript),
- a flattened `toolCalls` convenience view,
- rolled-up `tokens` and cost,
- `raw` (source path + content hash) as an escape hatch for a processor that
  needs vendor-specific detail.

Each `ToolCall` carries a **canonical `action`** — `file_write`, `file_read`,
`shell`, `search`, `task_spawn`, `mcp_call`, `web`, `todo`, `skill`, `other` — so
common extractors stay vendor-neutral, alongside the raw input/result for the
ones that need specifics.

## Built-in processors

| Processor | Kind | What it derives |
|---|---|---|
| `segment-blocks` | static | Splits the session's main thread into a deterministic **block** partition and maps every token/tool row to its block — the partition that cost is attributed to at read time (see below). |
| `files-touched` | static | Every file the session wrote → a `file` artifact linked to the session, plus a `file_written` outcome. The minimal example processor. |
| `outcomes-git` | static + network | Detects commits and PRs the session **created or merged** from the transcript, then asks `gh` for live PR status (degrades gracefully offline). Also catches **explicit reviews** (`gh pr review`, GitHub MCP) as a deterministic "this session reviewed PR X". |
| `pr-content-match` | network | Recovers the common case where you ask the agent to write code, then commit and push it yourself — so there's no `gh pr create` in the transcript. Matches the lines the agent authored against the added lines of each of *your own* candidate PRs; the matched fraction becomes the PR's AI-attribution. |
| `enrich-session` | enrichment (LLM) | One batched structured LLM call per session: work type, complexity, autonomy, an intent summary, key decisions, a success judgment, and feature linkage. Skipped entirely with no LLM key. |

## Blocks and cost attribution (`src/core/blocks.ts`)

A single session often does several unrelated things. To attribute cost below the
session, `segment-blocks` cuts the main thread into blocks by a pure function of
the transcript — so it's vendor-neutral and needs no LLM. The partition is fixed
by `segment-blocks`; other processors don't change it — they just attach their
facts (cost, tool calls, PR links, LLM labels) to the blocks it defines.

Each block is attributed to at most one PR, so its cost counts toward exactly one
PR and is never double-counted. When more than one processor proposes a PR link
for the same block, a fixed precedence (`prBlockRank` in `store.ts`) picks the
single winner.

## Storage (`src/store/`)

SQLite, **fact tables only — no pre-computed metrics.** Every number on the
dashboard is a query at read time. At single-developer scale SQLite aggregates
instantly, and keeping raw facts (not rollups) means a new processor's fact
becomes a new slice for free instead of a frozen dimension.

The tables (`src/store/db.ts`):

- `sessions` — one hot row per session with cost + tokens
- `session_blobs` — gzipped normalized JSON, for the transcript viewer
- `usage_facts` — per-assistant-message tokens/cost, so spend slices by model
- `tool_calls` — one row per tool call
- `blocks`, `block_usage`, `block_tool`, `block_annotations`, `block_artifacts` —
  the block partition and everything attributed to it
- `artifacts` — polymorphic: `file` / `commit` / `pr` / `ticket` / `feature`,
  with `completed_at`, `complexity`, `owner`
- `artifact_links` — the transitive chain (session → PR → ticket → feature)
- `session_artifacts`, `outcomes` — links and outcomes (an outcome may have no
  artifact, e.g. a commit with no resolvable SHA)
- `annotations` — generic key/value; new facets need no migration
- `facets`, `measures` — the registries that drive generic slicing
- `processor_runs` — the cache and per-analysis cost
- `files_index` — file → session index for search
- `user_link_overrides` — your manual link corrections, locked from auto-clobber

## The dashboard

`serve` starts a local, loopback-only web server (`src/server/`, client in
`src/server/client/`) and prints its URL. Four tabs:

- **Highlights** — a plain-language landing summary of recent work.
- **Dashboard** — the five headline metrics (below), each a clickable tile that
  expands into a detail view of charts.
- **Artifacts** — your features and PRs; mark a feature shipped, fix a link, add
  a missing one.
- **Sessions** — the full session list with facet filters; open any session to
  read its transcript and see what it touched.

A window selector (7 / 14 / 30 / 90 days / all) scopes every tile at once, and
each tile shows its change versus the previous equal-length window.

## The metrics, explained

Every headline is a one-line question first; the detail view answers it in depth.

### Session Outcome Rate
**Of the sessions you ran in the window, what share ended in a win?** You decide
what counts as a win with the outcome picker — a merged PR, a reviewed PR, the
model's own success judgment, and so on. The detail view charts session counts
per time bucket with the "win" portion filled in, and can break the rate down by
any dimension (work type, repo, model…). Before LLM enrichment has run there may
be no outcomes to match, so the tile reads "—" rather than a misleading 0%.

### Cost per shipped artifact
**How many dollars of AI spend did it take to ship one real unit of work?** Toggle
between **per merged PR** and **per shipped feature**. This is the metric that
answers "is the assistant paying off?" — real output in the denominator, dollars
on top. The detail view has three panels: a treemap of cost by feature or PR, a
"converted vs unconverted" burn chart (spend that reached a shipped artifact vs
spend that didn't), and a throughput curve. For PRs it counts **every merged PR
you contributed to — whether you authored it or only reviewed it** — each at its
full block-attributed cost. A complexity filter lets you ask the question for,
say, only substantial work.

### Total spend
**How many dollars did all your sessions in the window cost?** Priced from token
usage against a built-in price table, with an OpenRouter price backfill for models
the table doesn't know. The detail view charts spend over time and splits it by
model, work type, repo, or any other facet.

### Sessions
**How many sessions ran in the window?** The detail view charts the count
over time and can split it into one cohort line per facet value — e.g. sessions
by work type or by repo.

### Tool error rate
**What share of the agent's tool calls came back as errors?** A proxy for how much
the agent fought its environment. The detail view charts the error rate over time,
breaks errors down by category, and shows raw tool-call counts — with a separate
Skills tab for skill-usage counts.

## Enrichment (`src/llm/`)

`enrich-session` is the one processor that calls an LLM, and only if you supply a
key. It sends one structured, batched request per session and never sees more than
your transcript. Provider presets (`src/llm/providers.ts`): `anthropic`,
`openai`, `openrouter`, `groq`, `deepseek`, `gemini`, `together`, `fireworks`,
`xai`, `ollama`, plus `openai-compatible` for any other OpenAI-shaped endpoint.
Without a key, every static processor still runs — you
just lose the LLM-derived labels (work type, complexity, feature names, the
success judgment).

## Commands (`src/cli.ts`, `src/commands/`)

- **`analyze [dirs]`** — the write path: discover → normalize → run processors →
  persist. Then serves the dashboard by default (`--no-serve` to skip).
- **`serve`** — the read path: open the dashboard over an already-analyzed store.
  Prints the URL and waits for you to press Enter before opening a browser tab
  (`--no-open` to serve headless).
- **`query "<SQL>"`** — read-only `SELECT` over the store, for ad-hoc analysis or
  a coding agent exploring the data. `query --schema` dumps the tables, facets,
  and measures.

Config lives in `~/.tuneloop/` by default (store at `tuneloop.sqlite`);
`TUNELOOP_*` environment variables and CLI flags override paths, ports, and the
enrichment provider/model. See the README for the full env reference.

**Selecting the pipeline.** `analyze --config <path>` reads a JSON file
(`src/pipeline-config.ts`) that selects which processors and detectors run;
without the flag, the shipped default (`config.json`, kept complete by a drift
test) runs everything. Each section maps a component name to `{ "enabled": … }`.
An omitted section runs every component of that kind; a present section is an
allowlist. Unknown names are warned and ignored, and an enabled processor's
`requires` deps are auto-enabled — so a config can't silently starve a dependent
of its upstream data.

## Where things live

```
src/
  adapters/      one dir per tool (claude-code, codex, opencode, pi) + types.ts
  core/          model, processor + adapter interfaces, registry, runner,
                 blocks, turns, merge, hashing
  processors/    the built-in facts (see the table above)
  store/         SQLite schema (db.ts), the Store API, patch application
  llm/           provider presets + Anthropic/OpenAI clients + JSON coercion
  pricing/       static price table + OpenRouter backfill
  query/         read-only SQL runner for `tuneloop query`
  server/        HTTP API (http.ts) + the dashboard client (client/)
  commands/      analyze / serve / query entry points
  cli.ts         argument parsing and command wiring
```

Tests sit next to what they cover as `*.test.ts` (run with `npm test`). The
extension surface is deliberately narrow: to support a new tool, write an
adapter; to derive a new fact or redefine an outcome, write a processor;
everything else is a query over facts the store already holds.
