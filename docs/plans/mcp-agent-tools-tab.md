# MCP / Agent Tools Tab

## Goal

A new top-level tab that does for **tool calls** what the Skills tab does for skills:
show every MCP server and built-in tool the agent uses, with quick health stats, flag
chips, and drill-in pages — organized around **errors and what to do about them**. The
existing Metrics → Ops "tool error rate" charts are **removed entirely**; this tab is
their replacement.

Design decided 2026-08-04 (grilling session). Key reframe from the original pitch:
deferred tool loading (harnesses lazy-load MCP schemas via ToolSearch; only tool *names*
plus the server's `instructions` block are always in context) means unused/scope-down is
a hygiene signal, not a hero. **Error pills are the heroes of this tab.**

## Structure

Two sub-tabs, each a roster → detail page (the `skills.ts` pattern:
`paint*()` branching on route state, `#/tools/...` routes):

- **MCP servers** — row = server
- **Built-in tools** — row = built-in tool *or promoted shell binary* (see below)

Above each roster: a summary strip of clickable stat pills that double as filters
(the `renderSkOverview()` pattern), plus a small overall error-rate trend — the one
surviving job of the old Ops chart. Filter toolbar is the skills one: time presets
(7/14/30/90/All/Custom), name search, status dropdown, source chooser when
`availableSources.length > 1`. Default roster filter shows **used** entities.

**Clock: tool-call time (`t.ts`) everywhere** — matching skill-health, not the old
ops-over-time convention of `s.started_at`. This is deliberate; the old charts are
deleted rather than kept in disagreement.

## MCP servers sub-tab

### Entities

Server name parsed from `mcp__<server>__<tool>` (the `capability_invocation` grammar,
`src/store/db.ts`). Installed inventory from `environment_snapshots` category `'mcp'`
via `parseInstalledMcp`.

**Query `tool_calls` directly — never `capability_usage`.** The view is main-thread-only
(`is_sidechain = 0`) and would silently undercount subagent MCP usage. Counts include
sidechain calls, with a tooltip breakdown (skills precedent); the used/unused verdict
stays main-thread via the shared `classify()` from
`src/detectors/unused-capabilities.ts`, so this tab and the Recommendations tab can
never disagree.

### Status + flags

- **Status dot**: used / unused, from `classify()`.
- **Hero pills** (red/amber, drive the tab's value):
  - `high-error` — error rate ≥ 20% on ≥ 10 calls in window. Tooltip names the dominant
    error category ("38% errors, mostly integration_error").
  - `degrading` — recent window-half error rate materially worse than the older half.
    Gated: both halves need ≥ 10 calls. Experimental — both pills ship and we watch
    flap behavior on real data.
- **Hygiene chips** (quiet, secondary): `unused`, `scope-down`, `not-in-config` — ported
  from the detector vocabulary. Advice copy for unused servers is **qualitative only**
  ("tool definitions load names + instructions into every session; used in 0 of N
  sessions — consider removing"). Never print an estimated token cost: no data source
  can produce that number honestly (tool definitions never appear in transcripts,
  snapshots keep only `{type, url}`).

### Per-harness readiness

| Harness | Installed inventory | MCP invocation tagging | v1 treatment |
|---|---|---|---|
| Claude Code | ✅ | ✅ `mcp__srv__tool` | full |
| Codex | ✅ | ✅ (rebuilt to same grammar) | full |
| OpenCode | ✅ | ❌ `action='other'`, bare `<srv>_<tool>` | **port the prefix-reconciliation** from `queryInvokedOpencodeMcp` (`unused-capabilities.ts`) into the read model |
| Pi | ❌ (no MCP config exists by default — no reader will be written) | ✅ `mcp__` prefix | **permanently observed-only**: stats + error pills, config-dependent chips suppressed |

## Built-in tools sub-tab

### Flattened roster

Rows are **mixed-grain by design**:

- Non-shell built-ins at tool grain: `Read`, `Edit`, `Grep`, `WebFetch`, …
- **Shell binaries promoted to top-level rows** (`git`, `gh`, `npm`, `pytest`, …) with a
  small "shell" chip. Top-N by volume plus an "other shell" rollup row. Project-local
  scripts (`./deploy.sh`) are rows too, with a repo chip.

No used/unused status, no config chips (nothing to install or remove). Error pills
(`high-error`, `degrading`) apply exactly as for MCP rows.

### Shell command categorization (multi-label)

At ingest, parse each shell command into an **ordered list of meaningful binaries**:

1. Split into top-level segments on `&&`, `||`, `;`, `|` — quote-aware (a small parser,
   not a regex).
2. Per segment, take the first word; strip wrapper/navigation tokens: `cd`, `sudo`,
   `env`, `time`, `timeout`, `VAR=x` prefixes, `sh -c` unwrapping.
3. Store the surviving list in a child table:

```sql
CREATE TABLE tool_call_commands (
  session_id TEXT,
  idx        INTEGER,   -- FK (session_id, idx) → tool_calls
  seq        INTEGER,   -- position in the command chain
  binary     TEXT,      -- 'git', './deploy.sh', ...
  PRIMARY KEY (session_id, idx, seq)
);
```

Rewritten per session on re-ingest like every other table. Added via ALTER-safe
migration; existing stores backfill on re-ingest (back-compat required — npm users).

**Semantics: "calls involving `git`."** A compound call counts toward every involved
binary; counts across rows deliberately don't sum to total shell calls (same
relationship "sessions using skill X" has to total sessions — the UI copy says
"involving"). Errors on compound commands appear under *each* involved binary with a
**compound badge** on the occurrence row; the full command string + transcript deep-link
lets the user disambiguate. No per-segment failure attribution in v1 — a
wrong-but-confident attribution is worse than an honest multi-label.

## Drill-in page (both kinds)

In order, cloning the skill detail page skeleton:

1. Back link, title, status dot (MCP only) + chips.
2. **Stat tiles**: calls, sessions, error rate, **empty-result rate** (see below).
3. **Deterministic advice line** — the `advice()` pattern: template keyed on dominant
   error category + flags, counts substituted in. Always present, zero cost.
4. **Error-rate trend** — calendar-bucketed bars, tool-time.
5. **Errors by category** — accordion ported from `ops.ts` (`loadErrorCats()` /
   `renderOcc()`): per-category bars, expanding lazily fetches occurrences (LIMIT 50),
   each row deep-links into the transcript and starts an error walk. Keep the ported
   filter semantics: an entity/tool filter shrinks numerator *and* denominator; a
   category filter redefines only the numerator.
6. **Per-tool table** (MCP only): observed tools within the server — calls, errors,
   last used. *Observed only*: an installed-but-never-called tool is invisible (no tool
   inventory exists; snapshots keep only `{type, url}`).
7. **LLM "Suggested fix" card** — only for entities wearing `high-error`. Generated by
   the judge pipeline (skill-outcomes precedent), stored in `annotations` (key
   `tool_error_advice`), lazily loaded and hidden until it exists. The LLM reads **full
   error text from transcript files**, not the store (`error_message` is clipped to 200
   chars). Output: short diagnosis + **paste-ready CLAUDE.md snippet** (established
   product pattern) — e.g. guidance on how the agent should invoke a CLI it keeps
   misusing.
8. **Where it's used** — per-repo breakdown.
9. **Details grid** — install scope + source file (MCP), type/url, first/last used.
10. **Invocations list** (capped 100) with transcript deep-links + "Open in Sessions
    tab" CTA.

## Empty-result tracking

Error rate measures loud failures; empty-and-retry is the silent failure mass (bad
query → empty result → agent retries; `is_error = 0`, invisible today).

- New nullable `tool_calls.result_empty` column, computed at ingest, **populated only
  for retrieval-shaped calls** (`action IN ('search','web','mcp_call')`); `NULL`
  elsewhere — for shell/writes, empty output *is* success.
- Conservative heuristic: empty string, `[]`, `{}`, "no matches / no results" shapes.
- ALTER-safe migration, gated on `NORMALIZE_VERSION` bump → backfills on re-ingest.
- Surfaced as a **separate stat** (tile + roster tooltip). Not folded into error rate;
  no pill in v1.
- **Retry-chain detection is deferred** until real empty-rate distributions exist —
  a same-tool-within-k-calls heuristic can't be tuned blind.

## Error taxonomy

Ships **as-is** on the existing 19-category regex taxonomy (`src/core/error-category.ts`).
Known weakness: MCP failures collapse into the broad `integration_error`. Splitting it
(transport vs tool-returned vs auth) waits for a real corpus — the tab's own occurrence
lists are the instrument. A future split rides a `NORMALIZE_VERSION` bump and backfills
for free. The LLM card reads raw messages and doesn't need taxonomy granularity.

## Removal of the old Ops charts

The Metrics → Ops **Tools** sub-tab (tool error rate chart, errors-by-category widget,
tool call counts chart) is **deleted**, along with its KPI-tile entry point — not
stubbed, not redirected (delete-don't-caveat convention). The Ops **Skills** sub-tab is
untouched (separate cleanup, not this project). Rationale: the two homes disagree on
clocks (`started_at` vs `t.ts`); keeping both means the same week shows two different
error rates.

## Backend

New read model module (`src/server/mcp-health.ts` or `tool-health.ts`) + endpoints
following the skill-health layout, e.g.:

- `/api/tool-health` — both rosters (kind = `mcp` | `builtin`), stats, flags, sparks
- `/api/tool-health-detail?kind=&name=` — drill-in aggregates
- `/api/tool-error-advice?kind=&name=` — lazy LLM card
- reuse `/api/error-categories`, `/api/error-occurrences` (extended with entity scoping)

Window params via the `skillWindowFrom()` conventions (`days` | `from`/`to` | `source`).

## Punted (explicitly out of v1)

- ToolSearch round-trip friction stat ("N schema-load round-trips before first use")
- MCP `tools/list` capture probe for real definition-token cost (v1.5 candidate:
  url-type servers only, opt-in — stdio would mean executing configured commands)
- Per-segment failure attribution in compound shell commands
- `integration_error` taxonomy split
- Retry-chain detection for empty results
- Any per-tool-call token/cost attribution (no data; same refusal as skills)
