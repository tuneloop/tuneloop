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
sidechain calls, with a tooltip breakdown (skills precedent), **and so does the
used/unused dot**: a server a subagent calls is in use, and removing it would break
that subagent, so calling it unused would be advice to delete something live.

The shared `classify()` from `src/detectors/unused-capabilities.ts` is still used, but
for the remove/scope verdict behind `enoughData` and the scope-down chip — not for the
dot. So the two tabs agree on removal ADVICE, and there is exactly one case where they
read differently: a server called ONLY from a subagent is `used` here while the
main-thread-scoped detector may still offer to remove it. Deliberate, and the safer
direction of the two — but if that ever needs closing, it closes in the detector.

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

At ingest, parse each shell command into an **ordered list of meaningful binaries**
(`src/core/shell-binaries.ts`):

1. Split into top-level segments on `&&`, `||`, `;`, `|` — quote-aware (a small parser,
   not a regex). Also on **newlines** and top-level subshell parens, both of which are
   real chain boundaries in agent commands. Quotes, `$(…)`, backticks and **heredoc
   bodies** are text, not boundaries — splitting a heredoc'd Python script by line
   would invent binaries out of its source. A lone `&` is deliberately NOT a boundary:
   it would cut `2>&1` in half.
2. Per segment, take the first word; strip wrapper/navigation tokens: `cd`, `sudo`,
   `env`, `time`, `timeout`, `VAR=x` prefixes, `sh -c` unwrapping. A navigation-only
   segment (`cd /repo`) yields nothing. Absolute/`~`-relative paths reduce to their
   basename; repo-relative ones (`./deploy.sh`) stay whole — the path is what marks
   them as this project's script. Runners (`npx`, `uv run`) report as themselves;
   collapsing them to the wrapped tool is a guess.
3. Store the surviving list — **de-duplicated, first appearance wins** — in a child
   table. The consumer asks "did this call involve `git`?", never how many times, and
   repeats would fan out any join:

```sql
CREATE TABLE tool_call_commands (
  session_id TEXT,
  idx        INTEGER,   -- FK (session_id, idx) → tool_calls
  seq        INTEGER,   -- first appearance in the command chain
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

**Blame, where the output says so** (`src/core/shell-blame.ts`, added while building
AL-143). For `&&` chains the multi-label isn't just vague, it's wrong: in
`ls missing && tsc`, tsc never ran, yet it carried the failure — on a real corpus
`psql` and `createdb` had failure rates built entirely from commands they never
executed. Unix tools usually prefix their own name onto a failure, so ingest reads
that prefix (bash's name-first form, zsh's name-last form, a usage dump) and stores
`tool_calls.failed_binary` when exactly one of the call's OWN binaries is named. The
error then counts against that binary alone; NULL keeps the multi-label. High
precision, low recall by design — 6 of 89 failed shell calls on the corpus — because
a wrong blame moves a failure onto an innocent tool while no blame just falls back.
The compound badge therefore means "the output didn't say which part failed".

**A shell-level error is still an AGENT failure — blame the segment, not nobody.**
`echo ===` fails under zsh (equals expansion looks up a command named `==`) and
aborts the rest of the list, so later segments never run. It is tempting to read
that as "the shell failed, charge no binary", and that is wrong: the agent wrote a
command that isn't portable across shells, which is exactly the kind of thing this
tab should count. The shell NAMES the offending word (`== not found`), the word
appears verbatim in the command, so blame the segment that contains it. **Built.**

Scoped to that ABORT class only, on measurement. A glob no-match
(`no matches found: docs/*.swp`) reads like the same thing and isn't: under zsh an
unresolvable word aborts the whole list and sets the exit code whatever the
separator, while a glob no-match only skips its own command —
`grep --include=*.x; echo B` prints B and exits 0, so the call's error came from
somewhere else and blaming the glob's segment would be wrong. It propagates only
inside an `&&` chain, which the `;`-list rule below is what would tell apart.

**A user-declined call KEEPS its multi-label — decided 2026-08-04, not changed.**
`User rejected tool use` means nothing executed (about a fifth of failed shell
calls), so "blame nobody" is tempting and was proposed. Rejected: a decline is
information the user wants. You decline because you didn't want the agent running
*that call as it stood*, and a tool you keep declining is worth seeing. Erasing it
would delete the signal. Attributing it to the most consequential binary in the
chain would be better still, but there is no honest way to rank consequence, so
the multi-label stands.

**A `;`-joined list ends in the segment that set the exit code.** The shell's exit
status IS the last command's, so an errored `;`-list (or pipeline) failed in its
final segment — no error text required, which matters because agent commands
routinely silence stderr (`ls a b 2>/dev/null` as an existence probe was the most
common failing idiom observed, and it leaves nothing to parse). Does NOT apply to
`&&`/`||`, where the status could belong to any segment, nor when a shell-level
abort line shows the list never reached its end.

Two states, then, as before: a named binary, or unknown (NULL — the honest
multi-label). No "nobody" state, because the one case that argued for it
(a user decline) is signal worth keeping.

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
7. **LLM "Suggested fix" card** — only for entities wearing `high-error`. Lazily
   loaded and hidden until it exists. The LLM reads **full error text**, not the store
   (`error_message` is clipped to 200 chars) — confirmed worth doing on a real corpus,
   where the clip cuts off before the actual error: `mkdir`'s 200 stored characters
   became 1500 from the blob, revealing an `ERR_MODULE_NOT_FOUND` stack. Output: short
   diagnosis + **paste-ready CLAUDE.md snippet** (established product pattern) — e.g.
   guidance on how the agent should invoke a CLI it keeps misusing.

   **Built (AL-144) with two corrections to this spec:**
   - *Storage is its own `tool_error_advice` table, not `annotations`.* Annotations are
     session-scoped by primary key and foreign key; this advice is about a
     cross-session pattern for an ENTITY, so it has no session to hang off. The table
     follows the `theme.fix_hash` precedent, including the evidence hash that lets an
     unchanged failure set reuse the card for free.
   - *"Transcript files" means the session blob.* The blob is the normalized transcript
     the store keeps precisely so analysis survives the harness rotating its `.jsonl`
     files; reading the original paths would break on any rotated session.

   Generated by an X-tier detector that emits **no insights** — a per-tool card in the
   Recommendations ledger would drown the signals that need a decision.
8. **Where it's used** — per-repo breakdown.
9. **Details grid** — install scope + source file (MCP), type/url, first/last used.
10. **Invocations list**, grouped by session, with transcript deep-links + "Open in
    Sessions tab" CTA. Capped at 50 sessions × 25 items each, NOT a flat 100: a
    global cap is spent on the first few busy sessions, which left 22 of 29 `echo`
    groups expanding to nothing — including 8 that reported errors and listed none.
    Worst case is therefore 1,250 items, and a busy binary reaches ~700 (~450 KB),
    the page's largest payload. The caps bound the LISTING only; each group reports
    its session's true total from an aggregate, so a capped list never understates
    how often a tool ran.

## Empty-result tracking

Error rate measures loud failures; empty-and-retry is the silent failure mass (bad
query → empty result → agent retries; `is_error = 0`, invisible today).

- New nullable `tool_calls.result_empty` column, computed at ingest
  (`src/core/empty-result.ts`), **populated only for retrieval-shaped calls**
  (`action IN ('search','web','mcp_call')`); `NULL` elsewhere — for shell/writes,
  empty output *is* success. Also `NULL` for a **failed** retrieval call: it already
  counts as an error, and counting it twice would make the two stats overlap. So the
  empty rate's denominator is successful retrieval calls — exactly the
  silent-failure framing.
- Conservative heuristic: empty string, `[]`, `{}`, "no matches / no results" shapes.
- ALTER-safe migration, gated on `NORMALIZE_VERSION` bump → backfills on re-ingest.
- Surfaced as a **separate stat** (tile + roster tooltip). Not folded into error rate;
  no pill in v1.
- **Retry-chain detection is deferred** until real empty-rate distributions exist —
  a same-tool-within-k-calls heuristic can't be tuned blind.

## Error taxonomy

Ships **as-is** on the existing 19-category regex taxonomy (`src/core/error-category.ts`).

Known weakness 1: `user_rejected` is a user DECISION, not a tool failure, but it counts
toward error rate — so an interactive tool earns a `high-error` pill for being declined.
Observed on real data (AL-141): `AskUserQuestion`, 10 calls — 7 answered, 3 declined —
trips the 20% gate at a 30% "error" rate. **Decided 2026-08-04: leave it.** Error rate
means the same thing everywhere in the app today; excluding the category from the pill
alone would show a tile reading "30% errors" with no pill, which reads as a bug. Changing
it app-wide moves a headline metric and needs its own ticket.

Known weakness 2: MCP failures collapse into the broad `integration_error`. Splitting it
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
