# Environment Reader — Harness Config Snapshots

Status: **design in progress**
Jira: AL-71

## Problem

tuneloop derives per-session facts (cost, files, PRs, complexity) but has no visibility into
the **harness configuration** that shaped those sessions. A developer who adds an MCP server,
installs custom agents, changes permission rules, or enables a plugin — tuneloop can't see it.
Config changes are the core adoption signal: did a config-snippet fix from a detector actually
get applied? Did adding a new agent correlate with cost/time improvement?

The environment reader captures a **versioned timeline of harness configuration**, so config
changes are visible and diffable, and the insight lifecycle can confirm a fix was adopted.

## Design principle: minimal surface area

We capture **only fields we know are useful today** and drop everything else. Two reasons:

1. **LLM safety.** Snapshots are read during processing and detector runs, some of which send
  data to an LLM (see Adoption detection — a config-diff check sends a snapshot slice to a
   model). The less we store, the less can ever leak. We never store **secrets** — env var
   values, MCP args/env/headers, hook command strings. We *do* store user-authored instruction
   bodies (agent system prompts, skill/command bodies, CLAUDE.md), because the body is the
   substance and adoption detection needs it; the tradeoff is accepted for these non-secret
   content fields. Because secrets are stripped at capture, the surviving snapshot is safe to
   send to a model.
2. **Signal over noise.** Preference fields (theme, editor mode) and auth plumbing carry no
  improvement-cycle signal. Start tight; add fields as concrete detectors need them.

The rule is an **allowlist**: a field is stored only if it appears in the tables below. Anything
else — including new keys a future harness version adds — is dropped by default.

## Goals

1. Snapshot harness config on every `analyze` run — starting with Claude Code.
2. Capture a **dated timeline** of config states (append-on-change, not per-run duplicates) so
  both "what is the config now" and "what was it at time T" are answerable.

---

## Categories are a harness-neutral vocabulary

The five categories below are the **abstract storage/UI vocabulary**, not CC-specific fields.
A harness populates only the categories it has; the `category` column is just a string, so an
absent category simply produces no rows.


| Category       | Universal?             | Notes                                                                                                                          |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `settings`     | Concept yes, format no | CC=JSON, Codex=TOML, OpenCode=JSON. Keys differ entirely per harness.                                                          |
| `mcp`          | **Yes**                | All supported harnesses (CC, Codex, OpenCode, Pi) have MCP.                                                                    |
| `agents`       | Mostly                 | Sub-agent *definitions*. Pi has no sub-agents → no rows.                                                                       |
| `skills`       | Ragged                 | CC = `SKILL.md` dirs, Codex = shell `SKILL.md` bundles, OpenCode = a `skill` tool, Pi = none. Same label, different mechanism. |
| `instructions` | **Yes**                | The project-instructions file: `CLAUDE.md` (CC) / `AGENTS.md` (Codex, OpenCode).                                               |


The **reader is fully per-harness** — there is no shared parsing (JSON vs TOML, `mcp__<server>`
vs `<server>_<tool>` namespacing, SKILL.md vs tool-based skills). Only the storage layer and
category vocabulary are shared.

## What we capture — by category (Claude Code)

Where `$CLAUDE_HOME` = `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`.

### 1. `settings`

**Sources by scope:**


| Scope            | Path                                 | Shared?         |
| ---------------- | ------------------------------------ | --------------- |
| User (global)    | `$CLAUDE_HOME/settings.json`         | No              |
| Project (shared) | `<repo>/.claude/settings.json`       | Yes (committed) |
| Project (local)  | `<repo>/.claude/settings.local.json` | No (gitignored) |


**Fields captured** (nothing else):


| Field               | Capture               | Signal                                                   |
| ------------------- | --------------------- | -------------------------------------------------------- |
| `permissions.allow` | Yes (rule patterns)   | Permission posture — core adoption signal                |
| `permissions.deny`  | Yes                   | Security posture                                         |
| `permissions.ask`   | Yes                   | Always-confirm posture (rounds out the permission lists) |
| `enabledPlugins`    | Yes (names + boolean) | Ecosystem adoption                                       |


**Deliberately dropped:**


| Field                                                     | Why dropped                                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                                                     | Values are secrets                                                                                                                                                                                       |
| `apiKeyHelper` / `awsCredentialExport` / `gcpAuthRefresh` | Auth plumbing, no signal                                                                                                                                                                                 |
| `theme` / `editorMode`                                    | Preferences, no signal                                                                                                                                                                                   |
| `permissionMode`                                          | Only the session *default*; actual mode is per-session and changes at runtime (shift-tab). Misleading as config; belongs in the adapter if we ever need per-session mode.                                |
| `model`                                                   | Only the configured default; actual per-message model is already in `usage_facts`, and `/model` changes it mid-session. Redundant + misleading as config.                                                |
| `hooks`                                                   | Config hooks add little on their own; runtime hook execution (`hookEvent`/`hookCount`/`hookErrors`) is already in the transcript and is the better source. Revisit later if adoption detection needs it. |


**Stored shape:**

```json
{
  "permissions": { "allow": ["Bash(npm test *)"], "deny": [] },
  "plugins": { "frontend-design@claude-plugins-official": true }
}
```

### 2. `mcp`

**Sources by scope:**


| Scope                     | Path                                                      | Shared?         |
| ------------------------- | --------------------------------------------------------- | --------------- |
| User (global)             | `$CLAUDE_HOME/.claude.json` → top-level `mcpServers`      | No              |
| Per-project (local state) | `$CLAUDE_HOME/.claude.json` → `projects.<cwd>.mcpServers` | No              |
| Project (shared)          | `<repo>/.mcp.json`                                        | Yes (committed) |


**Fields captured** (only these three — nothing that carries secrets):


| Field                   | Capture | Signal                                        |
| ----------------------- | ------- | --------------------------------------------- |
| Server name             | Yes     | What capability is wired up — the core signal |
| `type` (http/sse/stdio) | Yes     | Local (stdio) vs remote (http/sse)            |
| `url`                   | Yes     | Endpoint identity (for http/sse servers)      |


Dropped: `command` (for a stdio server the user-chosen `name` already identifies it; `command`
alone is just `npx`/`uvx`), `args`, `env`, `headers`, `headersHelper`, `oauth`, `timeout`,
`alwaysLoad`. Everything dropped is either secret-bearing or a tuning knob with no signal.

**Stored shape** (keyed by source file, like `settings`; `.claude.json` at global scope is the
top-level `mcpServers`, at project scope the repo-root union of `projects.*` entries):

```json
{
  ".mcp.json": {
    "servers": { "atlassian": { "type": "sse", "url": "https://mcp.atlassian.com/v1/sse" } }
  },
  ".claude.json": {
    "servers": { "postgres": { "type": "stdio" } }
  }
}
```

### 3. `agents`

**Sources by scope:**


| Scope         | Path                         |
| ------------- | ---------------------------- |
| User (global) | `$CLAUDE_HOME/agents/*.md`   |
| Project       | `<repo>/.claude/agents/*.md` |


**Fields captured:**


| Field                                   | Capture                | Signal                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| Count                                   | Yes                    | How many custom agents                                       |
| Frontmatter `name`                      | Yes                    | Agent catalog — always present (identity)                    |
| Frontmatter `description`               | Yes                    | Purpose — effectively always present                         |
| Frontmatter `model`                     | If present             | Per-agent model preference (often `inherit` / omitted)       |
| Frontmatter `tools` / `disallowedTools` | If present             | Tool scoping (omitted = all tools)                           |
| Body (system prompt)                    | Yes — full text + hash | Instruction content — enables true adoption detection + diff |


The **agent body is the substance** (the system prompt IS the agent), so we store it in full,
not just a hash. This lets a detector confirm instruction-level adoption ("did the user add the
agent we suggested, with our instructions?") and diff an agent's definition across snapshots.
`bodyHash` is kept alongside as a cheap change-detection / versioning key. UI-only fields
(`color`) are dropped.

**Stored shape:**

```json
{
  "agents": [
    {
      "name": "code-reviewer",
      "description": "Review PRs for correctness",
      "model": "sonnet",
      "tools": ["Read", "Bash"],
      "body": "You are a code review specialist. For each changed file...",
      "bodyHash": "a1b2c3..."
    }
  ],
  "count": 1
}
```

### 4. `skills`

Custom commands have been **merged into skills** — `.claude/commands/deploy.md` and
`.claude/skills/deploy/SKILL.md` both create `/deploy` and behave the same. We capture both
formats into **one merged list**; the skills-vs-legacy-command distinction is a dying
implementation detail with no signal.

**Sources by scope:**


| Scope         | Path                                                                |
| ------------- | ------------------------------------------------------------------- |
| User (global) | `$CLAUDE_HOME/skills/*/SKILL.md` + `$CLAUDE_HOME/commands/*.md`     |
| Project       | `<repo>/.claude/skills/*/SKILL.md` + `<repo>/.claude/commands/*.md` |


**Fields captured** (mirrors agents — body is the substance):


| Field                     | Capture                | Signal                                                                             |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Count                     | Yes                    | Customization depth                                                                |
| Frontmatter `name`        | Yes                    | Skill catalog (falls back to filename)                                             |
| Frontmatter `description` | If present             | Purpose — always parse it; absent is fine (legacy commands often omit frontmatter) |
| Body                      | Yes — full text + hash | Instruction content — adoption detection + diff                                    |


Other frontmatter fields (`disable-model-invocation`, `user-invocable`, `allowed-tools`,
`disallowed-tools`) are dropped for now — add them if a detector needs the invocation posture.

**Stored shape:**

```json
{
  "skills": [
    { "name": "deploy", "description": "Deploy to staging", "body": "Run the deploy script...", "bodyHash": "d4e5f6..." },
    { "name": "review", "body": "Review the current diff...", "bodyHash": "..." }
  ],
  "count": 2
}
```

(`description` is omitted from an entry when the file has none — e.g. a bare legacy command.)

### 5. `instructions`

The project-instructions file — CC's `CLAUDE.md`. Plain markdown, no frontmatter, always-on. It
is the single richest adoption target (detector nudges like "add a rule about X" land here), so
we store the full body, mirroring agents/skills. `@import` references are stored **as-is,
unexpanded** for v1 (the import lines are visible in the raw text); resolving imports is deferred.

**Sources by scope:**


| Scope            | Path                                             |
| ---------------- | ------------------------------------------------ |
| User             | `$CLAUDE_HOME/CLAUDE.md`                         |
| Project (shared) | `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md` |
| Project (local)  | `<repo>/CLAUDE.local.md`                         |


**Fields captured** (per file, keyed by relative path like settings/mcp):


| Field | Capture                | Signal                                          |
| ----- | ---------------------- | ----------------------------------------------- |
| Body  | Yes — full text + hash | Instruction content — adoption detection + diff |


Absent and empty (whitespace-only) files are omitted — presence of a path key means a
non-empty file exists, so no separate `exists` flag is needed. `@import` references are stored
as-is, unexpanded.

**Stored shape:**

```json
{
  "CLAUDE.md": { "body": "# CLAUDE.md\n\nThis file provides...", "hash": "j0k1l2..." },
  ".claude/CLAUDE.md": { "body": "...", "hash": "..." },
  "CLAUDE.local.md": { "body": "...", "hash": "..." }
}
```

Rules (`.claude/rules/*.md`) are **dropped for v1** — a rule without `paths` is just CLAUDE.md
by another name, and path-scoped rules add a `paths` signal we don't yet consume. Revisit when
a detector needs path-scoped instruction data.

---

## Scope summary

Each category has a **global** component (user-level, same across all repos) and a
**project** component (varies per repo). The snapshot distinguishes these:


| Category       | Global scope                              | Project scope                                          |
| -------------- | ----------------------------------------- | ------------------------------------------------------ |
| `settings`     | `$CLAUDE_HOME/settings.json`              | `<repo>/.claude/settings.json` + `settings.local.json` |
| `mcp`          | `$CLAUDE_HOME/.claude.json` → per-project | `<repo>/.mcp.json`                                     |
| `agents`       | `$CLAUDE_HOME/agents/`                    | `<repo>/.claude/agents/`                               |
| `skills`       | `$CLAUDE_HOME/skills/` + `commands/`      | `<repo>/.claude/skills/` + `commands/`                 |
| `instructions` | `$CLAUDE_HOME/CLAUDE.md`                  | `<repo>/CLAUDE.md` + `.local.md`                       |


---

## Mechanism

### When: on every `analyze` run

Config is captured at analyze time, not via a hook. The reasoning: adoption detection needs a
**timeline of config states over calendar time** ("did the permission rule appear after we
suggested it?"), which analyze-time snapshots give directly. It doesn't need per-session
accuracy. Analyze-time capture is also zero-setup, works for every user and every past session
immediately, and avoids the install/maintenance burden of a hook. (See Deferred: SessionStart
hook for the one case that would justify a hook.)

### Two-phase read (global once + per unique project)

The reader piggybacks on paths analyze already resolves. Analyze parses each session's
`project.cwd` and resolves it to a repo root via git (cached per cwd). So the set of distinct
repo roots across all sessions *is* the project list — no separate discovery pass.

**Phase A — global (once per run):** read `$CLAUDE_HOME` config → write `scope='global'`,
`scope_key='_global'` snapshots for each category present.

**Phase B — per unique project (once per repo root, not per session):** for each distinct repo
root, read that repo's `.claude/`, `.mcp.json`, `CLAUDE.md`, plus the `~/.claude.json` MCP
entries under it → write `scope='project'`, `scope_key=<repo root>` snapshots.

Only repos with **sessions this run** are snapshotted — a configured-but-unused repo won't
appear. That's fine for adoption (adoption cares about repos with activity).

### Placement in the analyze pipeline

Runs after the session loop (repos all resolved) and **before detectors**, so a config-diff
detector in the same run sees the fresh snapshot:

```
discover → normalize → [per session: ingest + processors]
  → ★ capture environment (global once + per unique repo)   ← here
  → refresh artifacts → prune
  → run detectors            (config-diff detector reads fresh snapshots)
  → reconcile fix sightings  (existing marker path, feat/fix-delivery)
  → stamp last_analyze_at
```

It is a **standalone pipeline step**, not a processor — config is not session-derived, and a
per-session processor would re-read the same files N times.

### Deferred: SessionStart hook (per-session accuracy)

A hook that captures config at session-creation time (writing one file per session under
`~/.tuneloop/env-snapshots/<source>/<session-id>.json`) is the only way to get **true
point-in-time** config. It is deferred, not part of v1, because:

- Adoption (the primary use case) needs a config *timeline*, not per-session attribution.
- The analyze-time timeline + point-in-time lookup (below) is a good-enough approximation.
- A hook is real install/support surface (edits `settings.json`, must handle custom
`CLAUDE_CONFIG_DIR`, breaks if CC changes hook format) and only works going forward.

**Named trigger to revisit:** when a P-tier (per-session LLM) detector needs accurate
point-in-time config and the analyze-cadence approximation proves too coarse (see the staleness
caveat under Reading). That is the concrete need the hook — and per-session capture — would
serve.

---

## Storage

### Table

```sql
CREATE TABLE IF NOT EXISTS environment_snapshots (
  source           TEXT NOT NULL,   -- 'claude-code' (which harness)
  scope            TEXT NOT NULL,   -- 'global' | 'project'
  scope_key        TEXT NOT NULL,   -- '_global' for global; repo root for project
  category         TEXT NOT NULL,   -- 'settings' | 'mcp' | 'agents' | 'skills' | 'instructions'
  content_hash     TEXT NOT NULL,   -- hash of snapshot_json (the change-detection key)
  snapshot_json    TEXT NOT NULL,   -- the redacted captured payload for this category
  captured_at      TEXT NOT NULL,   -- when this state FIRST appeared (change timeline)
  last_observed_at TEXT NOT NULL,   -- most recent analyze run that confirmed this state
  PRIMARY KEY (source, scope, scope_key, category, content_hash)
);
CREATE INDEX IF NOT EXISTS ix_env_snapshots_lookup
  ON environment_snapshots(source, scope, scope_key, category, captured_at);
```

### Two timestamps (the timeline nuance)

- `captured_at` — when this config state *first appeared*. Across rows, these form the dated
change timeline. A state is understood to persist from its `captured_at` until the next row's
`captured_at` — so we get a full timeline without storing per-run duplicates.
- `last_observed_at` — the last analyze run that saw this exact state, updated in place on a
no-change run. Distinguishes "confirmed still X" from "assumed X, didn't look" (config could
have round-tripped between two runs we never observed).

### Write logic (append-on-change, no duplicates)

For each `(scope, scope_key, category)` read this run:

```
h = hash(payload)
latest = latest row for (source, scope, scope_key, category)
if latest and latest.content_hash == h:
    UPDATE latest.last_observed_at = now       # confirm, no new row
else:
    INSERT new row (captured_at = last_observed_at = now)
```

### Reading

**Current state** (adoption "is the fix present now"):

```sql
SELECT snapshot_json FROM environment_snapshots
WHERE source=? AND scope=? AND scope_key=? AND category=?
ORDER BY captured_at DESC LIMIT 1
```

**Point-in-time** (`configAsOf` — a P-tier detector wanting config as it was for a session):

```sql
SELECT snapshot_json FROM environment_snapshots
WHERE source=? AND scope=? AND scope_key=? AND category=? AND captured_at <= ?   -- session.startedAt
ORDER BY captured_at DESC LIMIT 1
```

Per-session detectors MUST read via `configAsOf`, never "latest" — else an old session gets
today's config and a detector can wrongly suppress a real insight. If the query returns nothing
(no reading before the session — common on first analyze), the caller flags the result
**stale** so a detector can down-weight or abstain rather than assert. True point-in-time
requires the deferred hook.

### Retention

v1 **keeps everything** — volume is change-gated (single-digit rows per category per year;
config changes are rare) so there is no space pressure, and premature pruning risks deleting the
*before* state a later-surfaced insight needs for its diff.

The latest row per `(scope, scope_key, category)` is kept indefinitely (current state). Orphan-
pruning of *superseded* historical rows — those with no live session in their active window and
no open insight referencing them — is a **fast-follow**, mirroring analyze's existing
`pruneOrphanArtifacts` step. Not v1.

### `scope_key` for project MCP

File config (`.claude/`, `.mcp.json`, `CLAUDE.md`) keys cleanly on **repo root**. But
`~/.claude.json` MCP is keyed by **exact cwd** — a repo can have different MCP servers per
subdirectory the user worked in. v1 simplification: key everything on **repo root**, and
**union** the MCP servers from every `~/.claude.json` entry under that repo into one repo-level
`mcp` snapshot. Lossy (drops per-subdirectory precision), but rare in practice — most users run
from the repo root or share one MCP config. Revisit if subdir-scoped MCP proves to matter.

---

## Security principles

We store a **small, fixed allowlist** of structural fields. This is the primary defense —
secrets are never read in the first place, so nothing can leak into an LLM prompt (including the
config-diff adoption check).

1. **Never store env var values** — `env` is dropped entirely (both settings and MCP).
2. **Never store MCP secrets** — only name, type, url. Command, args, env, headers,
  headersHelper, oauth, timeout, and alwaysLoad are dropped.
3. **Never store hook command strings** — hooks are dropped from settings entirely.
4. **Never touch** `credentials.json` or any auth token store.
5. **Instruction bodies are stored** (agent system prompts, skill/command bodies, CLAUDE.md).
  These are user-authored content, not secrets — the adoption signal needs them. They are the
   one place snapshot data is non-trivial in size; keep them out of any LLM prompt that doesn't
   specifically need them.
6. **Allowlist, not blocklist** — a field is captured only if it appears in the tables above.



