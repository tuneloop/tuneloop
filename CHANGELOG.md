# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.3.0
[0.2.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.2.0
[0.1.0]: https://github.com/tuneloop/tuneloop/releases/tag/v0.1.0

[#62]: https://github.com/tuneloop/tuneloop/pull/62
[#64]: https://github.com/tuneloop/tuneloop/pull/64
[#63]: https://github.com/tuneloop/tuneloop/pull/63
[#60]: https://github.com/tuneloop/tuneloop/pull/60
