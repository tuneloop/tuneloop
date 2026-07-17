# Detector: unused MCP servers / skills + startup overhead

Status: **planned** (ready to build)
Jira: AL-74 (subtask of AL-72 "Tier S detectors")
Branch: cut from `feat/environment-reader` (needs the environment reader's `environment_snapshots` data)

## Summary

A Tier-S (SQL-only) detector that flags MCP servers and skills which are **installed but never invoked**, framed as **startup overhead** the user can trim. It makes only structural claims — installed set (from config snapshots) minus invoked set (from tool-call usage). It does **not** quantify token or dollar cost, because per-item startup-token attribution is impossible without a live probe (verified — see "Why no cost/token numbers").

## Ticket (AL-74)

> High first-turn token count; installed servers/skills never used across the corpus. Extract first-turn token signal.
> Fix: removal/per-project-scoping snippet.
> Loop metric: startup tokens drop.

## Why no cost / token numbers

Verified 2026-07-16 against the Anthropic Messages API docs and real Claude Code transcripts:

- The API `usage` object is **aggregate-only** — `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, the TTL split, thinking tokens, server-tool request counts. Docs are explicit: **no per-tool, per-system-prompt, or per-MCP-tool breakdown.**
- **Tool/MCP schemas are never written to the transcript** (grep for `inputSchema` / any `tools` array across `~/.claude/projects/**/*.jsonl` → nothing). CC sends them to the model at startup but doesn't persist them, so there's no on-disk artifact to read. MCP schemas typically dominate startup bloat and are exactly what we can't see.
- Startup cost is only ever a **lump sum**: the first non-sidechain assistant row per session (`MIN(idx)`, `is_sidechain=0`) = system prompt + tool defs + MCP schemas + CLAUDE.md + first user message. Reportable as a total; never decomposable.

Consequence: we can say "installed but never used" and mention startup overhead **qualitatively**, but cannot predict per-server savings. The only free per-server number is a **measured before/after drop** once a capability is removed (also the loop metric). Per-server *prediction* needs a live MCP probe — deferred (see "Out of scope").

## Files

- **New:** `src/detectors/unused-capabilities.ts` — detector + `registerDetector`
- **New:** `src/detectors/unused-capabilities.test.ts`
- **Edit:** `src/detectors/index.ts` — add `import './unused-capabilities'`
- Modeled structurally on `src/detectors/cache-miss.ts` (Tier S, SQL-only, sync `run`).

## Metadata

`name: 'unused-capabilities'`, `version: 1`, `tier: 'S'`, `needsLlm: false`.

## Inputs

- **Installed set** — `store.envSnapshotCurrent()` for categories `mcp` + `skills`, at `global`/`_global` and each `project`/`<repo-root>` scope.
  - MCP → `payload["<file>"].servers` keys.
  - skills → `payload.skills[].name`.
- **Invoked set** — `tool_calls ⋈ sessions`, `is_sidechain = 0`, rolling `WINDOW_DAYS = 30`.
  - MCP server = 2nd `__`-segment of `mcp__<server>__<tool>`.
  - skill = `name` where `action = 'skill'`.
  - Grouped by repo, with per-repo session counts.
- **Startup framing** — first non-sidechain `usage_facts` row per session; used only as qualitative motivation, never as a per-item number.

## Classification (per installed capability)

1. **Never invoked anywhere** + **≥ 10 sessions** observed since it appeared → **remove**.
2. **Global-installed, invoked in exactly one repo** (no session minimum) → **scope to that repo**.
3. Used in ≥ 2 repos, or < 10 sessions and never used → not flagged (genuinely shared / too early to tell).

## Reconciliation rules

- **Repo-key mapping:** `environment_snapshots` project `scope_key` is the git-root **path**; usage tables key on repo **name**. Map `repoName = basename(scope_key)`. If two roots collapse to the same basename → **skip both** and `log.debug` the ambiguity (never misattribute).
- **Skill name matching:** match an invoked skill on its exact name **and** its last `:`-segment, so a plugin-namespaced invocation (`frontend-design:frontend-design`) matches its installed entry.
- **Unattributed usage counts as used:** a global skill invoked in a no-repo session (null `sessions.repo`) is treated as used and never recommended for removal. Only zero-invocation-anywhere → remove.
- **v1 scope cut:** legacy `commands/*.md` slash commands are excluded (client-expanded, unreliable in `tool_calls`). v1 covers **MCP servers + `SKILL.md` skills** only; `log.debug` the exclusion.

## Output (holistic per scope, no token numbers)

- **One global card** (`repo: '*'`): global capabilities that are never-used or used-in-one-repo; owns the scoping recommendations (the config edit is to global config).
- **One card per project repo** (`repo: '<name>'`): project-installed capabilities never invoked in that repo.
- `signalKey: 'unused-caps'` — stable per card; the `(detector, repo, signalKey)` identity triple stays unique per scope, so cards update in place rather than duplicating each run.
- `severity`: by count of unused items (≥ 3 → medium, else low). **Not** gated on startup magnitude.
- `fix.type: 'config-snippet'` — removal lines + per-project scoping instructions.
- **Framing:** each card mentions startup overhead qualitatively — e.g. *"These load into every session's startup and add to its overhead. Remove or scope them for a leaner startup."* — with no token/dollar figure.
- `count` = number of unused capabilities; `evidence` = sample sessions from the repo (session-level, no `turnIdx`).

## Loop metric

"Startup tokens drop" — measured **after** the fix as an observed before/after from the `environment_snapshots` timeline (the config change flips the snapshot; compare median first-turn tokens before vs. after). Shown as measurement, never as an on-card prediction. Note: `config-diff` adoption is marked *not-yet-wired* in `core/fix-types.ts` — surfacing the insight is this ticket; wiring adoption detection + the before/after measurement is follow-up.

## Tests (mirror `cache-miss.test.ts`)

Seed `environment_snapshots` + `tool_calls` + `usage_facts` fixtures; assert:

- never-used fires only at ≥ 10 sessions;
- used-in-one-repo fires with no session minimum;
- used-in-multiple-repos is silent;
- global vs per-repo card routing;
- plugin-namespaced skill matches its installed entry;
- basename collision → skipped + logged;
- no token/cost text appears in output.

## Out of scope (→ future ticket)

`--probe-mcp`: an opt-in MCP schema token-count probe — connect to each server, call `tools/list`, count tokens (store **counts, not schema text**). The only path to per-server *prediction* (verified). Deferred because it adds network/liveness dependence, uses the **unredacted** headers/env AL-71 deliberately strips, and requires spawning processes for stdio servers. New sub-ticket under AL-72, HTTP/SSE-first, with its own risk review.

## Implementation plan

Built bottom-up along the data flow — **installed → invoked → reconcile → classify → format → wire** — so each step consumes the previous one's output and is independently testable before the next exists.

Testing note: `cache-miss.ts` keeps all helpers internal and tests only through `run()`. This detector has more discrete pure logic (payload parsing, repo-key reconciliation, name matching, classification), so those helpers are **exported** and unit-tested in isolation; the final wiring is still tested end-to-end through `run()` like cache-miss. Pure helpers take plain args (no `Store`/db), so their tests need no fixtures.

Data types used across tasks:
- `InstalledCap = { kind: 'mcp' | 'skill', name: string, scope: 'global' | 'project', repo?: string }` — `repo` set (basename of scope_key) for project scope.
- `InvokedCap = { kind: 'mcp' | 'skill', name: string, repo: string | null }` with a session count.

### Task 1 — Parse installed capabilities from snapshot payloads
- **Add:** `parseInstalledMcp(payload): string[]`, `parseInstalledSkills(payload): string[]` in `unused-capabilities.ts` (exported).
- MCP → union of `payload["<file>"].servers` keys across files. Skills → `payload.skills[].name`.
- Defensive against missing/malformed payloads (return `[]`).
- **Test:** feed the exact JSON shapes the environment reader emits (copy from `environment.ts` docs / a real snapshot) → expect the name lists. Malformed → `[]`.
- *Independently testable: pure function, plain JSON in.*

### Task 2 — Read invoked capabilities from usage
- **Add:** `queryInvoked(store, sinceIso): InvokedCap[]` (exported; takes `store`).
- SQL over `tool_calls ⋈ sessions`, `is_sidechain=0`, `ts >= since`: MCP rows (`action='mcp_call'`) → server = 2nd `__`-segment of `name`; skill rows (`action='skill'`) → `name`. Group by `(kind, name, repo)` with distinct-session counts. `repo` may be null.
- **Test:** seed `sessions` + `tool_calls` fixtures (mirror cache-miss's `seedSession`), assert grouping, segment extraction, null-repo rows, sidechain exclusion, window boundary.
- *Independently testable: real db, no dependence on Task 1.*

### Task 3 — Repo-key reconciliation (basename + collision skip)
- **Add:** `mapScopeKeysToRepos(scopeKeys: string[]): { byRepo: Map<string, string>, ambiguous: Set<string> }` (exported).
- `basename(scopeKey)` → repo name; when two scope_keys share a basename, mark that name ambiguous.
- **Test:** distinct paths → clean map; two paths same basename → both in `ambiguous`, absent from `byRepo`.
- *Independently testable: pure, array of strings in.*

### Task 4 — Skill-name matching
- **Add:** `skillMatches(installedName: string, invokedName: string): boolean` (exported).
- Match on exact equality OR last `:`-segment of the invoked name (plugin namespacing).
- **Test:** `deploy`↔`deploy` true; `frontend-design`↔`frontend-design:frontend-design` true; `deploy`↔`build` false.
- *Independently testable: pure, two strings in.*

### Task 5 — Classification
- **Add:** `classify(installed: InstalledCap[], invoked: InvokedCap[], sessionCountByRepo, opts): Classified[]` (exported), where each result is `{ cap, verdict: 'remove' | 'scope', scopeToRepo?: string }`.
- Rules: never-invoked-anywhere + ≥`MIN_SESSIONS` → `remove`; global + invoked in exactly one repo → `scope` (no minimum); unattributed (null-repo) invocation counts as used; uses Task 4 for skill matching, Task 3's map to align invoked-repo to installed-repo. Multi-repo / below-threshold → dropped.
- **Test:** table-driven — one case per branch, feeding plain arrays (no db). Assert verdicts + `scopeToRepo`.
- *Independently testable: pure, consumes Tasks 3-4 outputs as plain data.*

### Task 6 — Card formatting
- **Add:** `buildCards(classified: Classified[], startupByRepo): InsightInput[]` (exported).
- Group into one global card (`repo:'*'`, owns `scope` verdicts + never-used globals) and one per project repo. Build `title`/`description` (qualitative startup-overhead framing, **no token numbers**), `severity` by count, `fix.type:'config-snippet'` with removal/scoping content, `signalKey:'unused-caps'`, `count`, `evidence` sample.
- **Test:** feed classified fixtures → assert card routing, severity thresholds, snippet content, and that no `$`/token digits appear in copy.
- *Independently testable: pure, consumes Task 5 output.*

### Task 7 — Wire `run()` + register
- **Add:** the `Detector` object (`unused-capabilities`, v1, tier S) whose `run(ctx)` calls Tasks 1-2 (read), 3-5 (reconcile+classify), 6 (format); `log.debug` the ambiguous-repo skips and the legacy-commands exclusion. `registerDetector(...)`. Edit `src/detectors/index.ts` to import it.
- **Test:** none new here — covered by Task 8.

### Task 8 — End-to-end detector test
- **Add:** integration cases in `unused-capabilities.test.ts` seeding `environment_snapshots` + `sessions` + `tool_calls` + `usage_facts`, calling `run(ctx)`, asserting the full `InsightInput[]` (mirrors cache-miss's top-level tests): never-used fires only at ≥10 sessions; used-in-one-repo scopes; used-in-multiple silent; global vs per-repo routing; plugin-namespaced skill matches; basename collision skipped; no token/cost text.

### Suggested commits
1. Task 1-2 (readers) + their tests.
2. Task 3-5 (reconcile + classify) + their tests.
3. Task 6 (formatting) + its test.
4. Task 7-8 (wire + e2e) + register + index edit.

(Plan doc + `.gitignore` setup can be commit 0.)

## Decision log

- Insight shape: **holistic per-scope card** (not per-signal, not per-item).
- Fix scope: **removal + per-project scoping**.
- Startup-magnitude gate: **none** — report-only; startup overhead is framing + the loop metric, never fires an insight on its own.
- "Never used" trust threshold: **10 sessions** since install.
- Scoping case (global-installed, used in only one repo): **no** session minimum.
- Cost/token quantification: **dropped** — no honest per-item number exists without a live probe.
- Startup framing wording: **mention startup overhead qualitatively** (it is a startup-overhead problem; we just can't quantify it yet).
