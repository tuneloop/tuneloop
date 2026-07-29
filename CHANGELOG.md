# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Clear error on unsupported Node versions** — the CLI's `bin` entry is now a
  dependency-free wrapper that checks the running Node against `engines` before
  loading the bundle, so old Nodes get a one-line "requires Node.js >= 22.19.0"
  message instead of a `TypeError: webidl.util.markAsUncloneable is not a
  function` stack trace from deep inside undici.
- **`engines.node` raised to `>=22.19.0`** to match the floor inherited from
  the direct `undici` dependency; `>=22` admitted Node 22.x versions that crash
  at startup. CI now tests the exact floor plus latest 22.x and 24.x.
  
### Added

- **Keyless header-auth gateways.** A new `openai-compatible-nokey` provider preset
  drives an OpenAI-compatible endpoint that authenticates by request headers instead
  of an API key — an intranet or self-hosted gateway (e.g. a LiteLLM proxy). Set the
  endpoint with `TUNELOOP_LLM_BASE_URL` and pass credentials as a JSON object in
  `TUNELOOP_LLM_HEADERS` (attached to every request). Selecting the preset is the
  keyless opt-in, so a forgotten key on the keyed `openai-compatible` variant still
  fails safe. A malformed `TUNELOOP_LLM_HEADERS` warns and leaves enrichment off
  rather than sending unauthenticated requests.

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

[Unreleased]: https://github.com/tuneloop/tuneloop/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.5.0
[0.4.1]: https://github.com/tuneloop/tuneloop/releases/tag/v0.4.1
[0.4.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.4.0
[0.3.1]: https://github.com/tuneloop/tuneloop/releases/tag/v0.3.1
[0.3.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.3.0
[0.2.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.2.0
[0.1.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.1.0

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
