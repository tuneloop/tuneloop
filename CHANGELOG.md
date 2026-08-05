# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-08-05

### Added

- **MCP / Tools tab.** A new top-level tab that does for tool calls what the Skills
  tab does for skills, organized around errors and what to do about them. Two
  sub-tabs — **MCP servers** (row = server, parsed from `mcp__<server>__<tool>`) and
  **Built-in tools** (row = a built-in tool or a shell binary promoted from the
  commands it ran) — each a roster with clickable stat pills that double as filters,
  an error-rate trend, and a drill-in detail page carrying per-tool chips, an
  errors-by-category breakdown, and the failing calls grouped by session. The hero
  signals are the `high-error` and `degrading` pills; `unused`, `scope-down` and
  `not-in-config` stay as quiet hygiene chips. Counts read `tool_calls` directly and
  include sidechain calls, so a server only ever called by a subagent still reads as
  in use. ([#119])
- **LLM "Suggested fix" card for failing tools.** A server or tool carrying the
  `high-error` pill gets a short diagnosis plus a paste-ready agent-instructions
  snippet, cached per entity and regenerated only when the underlying failures
  change, so a quiet re-analyze costs nothing. ([#119])
- **Shell failure attribution.** A failing `Bash` call is now blamed on the binary
  that actually failed rather than smeared across every binary in the chain — read
  from the error text (bash and zsh formats), from exit position for unconditional
  chains, and, for compound failures the deterministic rules can't call, by a new
  `shell-error-attribution` LLM processor. Shell calls are also multi-labeled: `cd
  repo && npm run build | tee log` counts toward both `npm` and `tee`, which is why
  per-binary counts don't sum to the shell-call total. ([#119])
- **Empty-result tracking.** A successful retrieval call that came back with nothing
  is recorded as such, decided per binary and per MCP tool, so a search that
  silently finds nothing is visible instead of counting as a clean success. ([#119])

### Changed

- **Tab order.** Highlights, Metrics, Skills, MCP/Tools, Artifacts, Sessions,
  Recommendations. ([#119])
- **The Metrics → Ops "Tool error rate" KPI is removed**, along with its Tools and
  Skills sub-tabs — both are now top-level tabs that answer the same question with
  drill-in. `/api/ops-over-time` and `/api/tool-names` go with it; an old
  `#/dashboard/ops` bookmark falls back rather than erroring. ([#119])

### Fixed

- **Transcript viewer no longer silently truncates tool input.** Long commands were
  clipped server-side at 2,000 characters with a bare ellipsis, and the expand toggle
  then made the clipped block look complete. The cap is now 20,000 characters, and
  when it does fire the marker names what it dropped. ([#119])
- **Errors-by-category widget lost its scoped styles** on the tool detail page, so a
  count and its share ran together ("542%" for 5 errors at 42%). ([#119])

## [0.7.0] - 2026-07-31

### Added

- **Skill Health tab.** A new dashboard tab reporting on the skills your agent
  harness has installed: a per-skill roster with a used/unused verdict, invocation
  count and trend sparkline, own-call error rate, scope-down and not-in-config
  flags, and the SKILL.md description; a version-drift timeline (append-on-change
  snapshot diffing, scoped per skill and repo) with a before/after usage delta
  around each edit; and skill co-occurrence and activation outcomes. It is a pure
  read model over existing session data — no new aggregate tables — and works
  across all four adapters (claude-code, codex, opencode, pi). Each report covers
  one source, resolved to the busiest harness by real usage. ([#112])
- **`--address` flag for interface binding.** `tuneloop serve` (and `tuneloop
  analyze`) accept `--address <host>` to bind the dashboard to a specific
  interface, e.g. `0.0.0.0` so a reverse proxy can forward to it. The default is
  unchanged (`127.0.0.1`, loopback only), and binding a non-loopback address
  prints a warning — the dashboard is unauthenticated, so exposure should be a
  deliberate choice with auth/TLS handled at the proxy layer. The printed URL
  adapts to the bind, and `EADDRNOTAVAIL` gets a clear "not an address of this
  machine" error. ([#116])
- **Custom session tags.** Sessions can now be labeled with user-defined key:value
  fields (e.g. `agent: issue_solver`), and each field becomes a first-class facet —
  it shows up in session filters, metric filters, and break-down selectors like any
  built-in dimension. Tag in bulk from the sessions tab: narrow
  the list with the existing filters, then "Tag" applies a field/value to every
  matching session (the button states the count before writing). One-off corrections
  live in the session drawer, where each user field is inline-editable and "+ field"
  defines a new one. Values are single-valued per field, overwritten on re-tag, and
  clearable/deletable from the same controls; they persist through re-analysis and
  need no schema migration. ([#117])

## [0.6.0] - 2026-07-30

### Added

- **Keyless header-auth gateways.** A new `openai-compatible-nokey` provider preset
  drives an OpenAI-compatible endpoint that authenticates by request headers instead
  of an API key — an intranet or self-hosted gateway (e.g. a LiteLLM proxy). Set the
  endpoint with `TUNELOOP_LLM_BASE_URL` and pass credentials as a JSON object in
  `TUNELOOP_LLM_HEADERS` (attached to every request). Selecting the preset is the
  keyless opt-in, so a forgotten key on the keyed `openai-compatible` variant still
  fails safe. A malformed `TUNELOOP_LLM_HEADERS` warns and leaves enrichment off
  rather than sending unauthenticated requests. ([#110])
- **Sortable feature list and paginated sessions.** The Features tab (Artifacts >
  Features) gets column sorting like the PR table — Feature, Last session, Sessions,
  Cost — reordering sibling groups only so the hierarchy is preserved. The sessions
  list is no longer silently capped at 200 rows: it gets server-side sorting (Session,
  Date, Cost, Complexity) and a 50-per-page pager, with the pager total always
  agreeing with the page rows. Sort and page round-trip through the URL. ([#109])
- **Dashboard opens on a 14-day window and the PR lens.** The default KPI window is now
  14 days (was 7), and Cost-per-artifact opens on the PR lens, falling back to Features
  only when the window has merged no PRs but does have features. ([#109])

### Changed

- **Feature cost breakdown reflects in-flight work and windowed spend.** The feature
  treemap no longer filters to shipped features — in-flight features always count — and
  the window now scopes the *spend* shown rather than only which features appear. It
  therefore agrees with the cost-per-shipped-feature KPI it sits under, and no longer
  renders permanently empty for stores with no shipped features. ([#109])
- **Table headers in product green.** The Features grid header and the PR/Sessions table
  headers switch from muted grey to the product emerald; every other table keeps the
  muted style. ([#109])

### Fixed

- **Clear error on unsupported Node versions** — the CLI's `bin` entry is now a
  dependency-free wrapper that checks the running Node against `engines` before
  loading the bundle, so old Nodes get a one-line "requires Node.js >= 22.19.0"
  message instead of a `TypeError: webidl.util.markAsUncloneable is not a
  function` stack trace from deep inside undici. ([#108])
- **`engines.node` raised to `>=22.19.0`** to match the floor inherited from
  the direct `undici` dependency; `>=22` admitted Node 22.x versions that crash
  at startup. CI now enforces `engine-strict` on install and tests the exact floor
  plus latest 22.x and 24.x. ([#108])
- Dashboard detail views follow late state changes: an open Cost-by-Artifact detail
  re-renders when the async KPI fallback flips the lens; deep links to
  `#/artifacts/feature` seed the correct per-kind default sort; and the sessions list
  normalizes the URL when it snaps a stale page, so a reload does not repeat the snap.
  ([#109])

## [0.5.0] - 2026-07-28

### Added

- **Recommendations v1** — a new Recommendations tab that surfaces evidence-backed,
  cross-session recommendations for more effective agent usage, each with a concrete
  fix. It's powered by five detectors: ([#66], [#74])
  - **Recurring themes** — LLM analysis of patterns across your sessions where you
    repeatedly stepped in to course-correct, recommending fixes to agent files
    (CLAUDE.md / AGENTS.md), skills, tooling, or config. Runs on a Sonnet-class heavy
    model. ([#84])
  - **Unused capabilities** — flags installed MCP servers and skills that never get
    invoked yet inflate every session's startup, recommending their removal or
    scoping. Covers all supported harnesses. ([#83])
  - **Prompt cache misses** — flags steady, avoidable spend from sessions that
    repeatedly miss the prompt cache, gated to a dollar floor so only material waste
    surfaces. ([#71])
  - **Context exhaustion** — flags sessions that grew large enough to trigger
    compaction, pointing at context-management fixes. ([#82])
  - **Kitchen-sink sessions** — an LLM-as-judge detector that flags sessions mixing
    unrelated work in one context, recommending tighter session scoping. ([#85])
- On providers with a strong sibling (Anthropic, OpenAI, Bedrock, OpenRouter, Gemini),
  a Sonnet-class **heavy model** is now selected automatically for the recommendation
  detectors, so recurring-themes works out of the box without setting
  `TUNELOOP_LLM_MODEL_HEAVY`. ([#105])
- `TUNELOOP_DISABLE_DEFAULT_LLM_HEAVY` opts out of that automatic heavy model, keeping
  every detector on the cheaper base model to hold down analysis spend. An explicit
  `TUNELOOP_LLM_MODEL_HEAVY` / `--llm-model-heavy` still takes precedence, and the heavy
  detectors can also be turned off individually via `config.json`.

### Fixed

- Worktree sessions are now handled correctly. Repo detection canonicalizes through
  `git rev-parse --git-common-dir`, so a session run inside a linked git worktree is
  attributed to its main repo instead of the worktree's branch slug — previously each
  worktree fragmented into its own phantom repo, splitting that repo's sessions and
  config timeline. Project config for worktrees checked out outside the repo directory
  is matched by canonical repo name as well. ([#103])

## [0.4.1] - 2026-07-15

### Fixed

- Codex exec tool envelopes are now parsed: outputs are split per command, and
  shell `apply_patch` invocations (including heredocs) are rendered as file
  writes with diffs instead of raw shell payloads. ([#79])
- Codex patches render as proper transcript diffs, with multi-file patches
  split per file and transcript tool controls aligned. ([#79])
- Codex guardian approval sessions are now linked to their parent session
  instead of appearing as standalone sessions. ([#80])

## [0.4.0] - 2026-07-13

### Added

- Pi package support: `tuneloop` can now be installed directly into the Pi coding
  agent with `pi install npm:tuneloop`. It ships the `tuneloop-query` skill plus a
  new `/tuneloop` command — `analyze | open | stop | status` — that builds the local
  store and serves the dashboard as a background process (printing its URL in pi's
  TUI), using the bundled CLI with no separate global install. LLM enrichment is
  offered per run through pi's own dialogs and stays optional but recommended.
- GPT-5.6 pricing, so sessions on the new model are costed correctly. ([#76])
- Untitled sessions fall back to their opening prompt for a title instead of
  showing no title. ([#72])

### Fixed

- Claude Code cache writes are now priced at their real TTL rate rather than a
  flat rate. ([#73])

## [0.3.1] - 2026-07-13

### Fixed

- Claude Code token and cost totals were double-counted; usage is now tallied once
  per API message instead of per transcript line. ([#69])

## [0.3.0] - 2026-07-09

### Added

- Pi coding agent adapter, so Pi sessions can be ingested and analyzed alongside
  Claude Code and Codex. ([#62])
- AWS Bedrock provider for LLM enrichment, letting enrichment run against Anthropic
  models hosted on Amazon Bedrock. ([#64])

### Fixed

- PR URLs are now host-aware, generating correct links for non-github.com git
  hosts. ([#63])

## [0.2.0] - 2026-07-06

### Added

- `analyze` offers an interactive, run-only setup for LLM enrichment, so you can
  opt into enrichment without editing config files. ([#60])

## [0.1.0] - 2026-07-04

### Added

- First open-source release: local analytics for your AI coding sessions.
- Headline-metrics dashboard with a bundled, modular client.
- Session transcript view with subagent transcripts as separate tabs.
- Features tab with a repo-isolated hierarchy of extracted features.
- Files-changed tab linking each edit back to its originating prompt.
- PRs tab with cost-per-artifact KPI and artifact search matching PR titles and
  `#N` / `repo#N` patterns.
- LLM enrichment for session intent and key-decision extraction.
- `analyze` serves the dashboard by default.

[Unreleased]: https://github.com/tuneloop/tuneloop/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.8.0
[0.7.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.7.0
[0.6.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.6.0
[0.5.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.5.0
[0.4.1]: https://github.com/tuneloop/tuneloop/releases/tag/v0.4.1
[0.4.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.4.0
[0.3.1]: https://github.com/tuneloop/tuneloop/releases/tag/v0.3.1
[0.3.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.3.0
[0.2.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.2.0
[0.1.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.1.0

[#119]: https://github.com/tuneloop/tuneloop/pull/119
[#117]: https://github.com/tuneloop/tuneloop/pull/117
[#116]: https://github.com/tuneloop/tuneloop/pull/116
[#112]: https://github.com/tuneloop/tuneloop/pull/112
[#110]: https://github.com/tuneloop/tuneloop/pull/110
[#109]: https://github.com/tuneloop/tuneloop/pull/109
[#108]: https://github.com/tuneloop/tuneloop/pull/108
[#105]: https://github.com/tuneloop/tuneloop/pull/105
[#103]: https://github.com/tuneloop/tuneloop/pull/103
[#85]: https://github.com/tuneloop/tuneloop/pull/85
[#84]: https://github.com/tuneloop/tuneloop/pull/84
[#83]: https://github.com/tuneloop/tuneloop/pull/83
[#82]: https://github.com/tuneloop/tuneloop/pull/82
[#74]: https://github.com/tuneloop/tuneloop/pull/74
[#71]: https://github.com/tuneloop/tuneloop/pull/71
[#66]: https://github.com/tuneloop/tuneloop/pull/66
[#80]: https://github.com/tuneloop/tuneloop/pull/80
[#79]: https://github.com/tuneloop/tuneloop/pull/79
[#76]: https://github.com/tuneloop/tuneloop/pull/76
[#73]: https://github.com/tuneloop/tuneloop/pull/73
[#72]: https://github.com/tuneloop/tuneloop/pull/72
[#69]: https://github.com/tuneloop/tuneloop/pull/69
[#62]: https://github.com/tuneloop/tuneloop/pull/62
[#64]: https://github.com/tuneloop/tuneloop/pull/64
[#63]: https://github.com/tuneloop/tuneloop/pull/63
[#60]: https://github.com/tuneloop/tuneloop/pull/60
