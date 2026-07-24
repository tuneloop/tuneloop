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
| `mcp`          | **Yes**                | CC, Codex, OpenCode have MCP. Pi ships no built-in MCP → no rows.                                                              |
| `agents`       | Mostly                 | Sub-agent *definitions*. Pi has no sub-agents → no rows.                                                                       |
| `skills`       | Ragged                 | CC = `SKILL.md` dirs, Codex = shell `SKILL.md` bundles, OpenCode = a `skill` tool, Pi = `SKILL.md` dirs + root `.md` files. Same label, different mechanism. |
| `instructions` | **Yes**                | The project-instructions file: `CLAUDE.md` (CC) / `AGENTS.md` (Codex, OpenCode, Pi).                                          |


The **reader is fully per-harness** — there is no shared parsing (JSON vs TOML, `mcp__<server>`
vs `<server>_<tool>` namespacing, SKILL.md vs tool-based skills). Only the storage layer and
category vocabulary are shared.

## What we capture — by category (Claude Code)

Where `$CLAUDE_HOME` = `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`.

### 1. `settings`

**Sources by scope:**


| Scope            | Path                                                              | Shared?         |
| ---------------- | ----------------------------------------------------------------- | --------------- |
| User (global)    | `$CLAUDE_HOME/settings.json`                                      | No              |
| Project (shared) | `settings.json` in every `.claude/` under the repo               | Yes (committed) |
| Project (local)  | `settings.local.json` in every `.claude/` under the repo         | No (gitignored) |

Project scope reads these in **every `.claude/` directory** under the repo (root + nested
monorepo packages — see Nested `.claude/` directories), keyed by repo-relative path.


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


**Stored shape** (keyed per settings file by repo-relative path; a file whose whole content
is dropped by the allowlist is omitted):

```json
{
  ".claude/settings.json": {
    "permissions": { "allow": ["Bash(npm test *)"], "deny": [], "ask": [] },
    "plugins": { "frontend-design@claude-plugins-official": true }
  }
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
| `url`                   | Yes     | Endpoint identity (for http/sse servers) — stored credential-stripped: protocol + host + path only; userinfo, query, and fragment are dropped, and an unparseable URL is not stored |


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


| Scope         | Path                                                          |
| ------------- | ------------------------------------------------------------- |
| User (global) | `$CLAUDE_HOME/agents/*.md`                                    |
| Project       | `agents/*.md` in every `.claude/` under the repo             |

Project scope scans the `agents/` dir in every `.claude/` under the repo; each entry carries a
repo-relative `dir` so same-named agents in different packages coexist (see Nested `.claude/`
directories). Plugin-contributed agents also join this list, tagged `source` (see
Plugin-provided skills & agents).

**Fields captured:**


| Field                                   | Capture                | Signal                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| Count                                   | Yes                    | How many custom agents                                       |
| Frontmatter `name`                      | Yes (else filename)    | Agent catalog                                                |
| Frontmatter `description`               | If present             | Purpose                                                      |
| Frontmatter `model`                     | If present             | Per-agent model preference (often `inherit` / omitted)       |
| Frontmatter `tools` / `disallowedTools` | If present             | Tool scoping (omitted = all tools)                           |
| Body (system prompt)                    | Yes — full text + hash | Instruction content — enables true adoption detection + diff |


The **agent body is the substance** (the system prompt IS the agent), so we store it in full,
not just a hash. This lets a detector confirm instruction-level adoption ("did the user add the
agent we suggested, with our instructions?") and diff an agent's definition across snapshots.
`bodyHash` is kept alongside as a cheap change-detection / versioning key. UI-only fields
(`color`) are dropped.

**Stored shape** (`dir` on project entries, `source` on plugin entries; neither on global):

```json
{
  "agents": [
    {
      "name": "code-reviewer",
      "description": "Review PRs for correctness",
      "model": "sonnet",
      "tools": ["Read", "Bash"],
      "body": "You are a code review specialist. For each changed file...",
      "bodyHash": "a1b2c3...",
      "dir": ".claude/agents"
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


| Scope         | Path                                                            |
| ------------- | --------------------------------------------------------------- |
| User (global) | `$CLAUDE_HOME/skills/*/SKILL.md` + `$CLAUDE_HOME/commands/*.md` |
| Project       | `skills/*/SKILL.md` + `commands/*.md` in every `.claude/` under the repo |

Project scope scans every `.claude/` under the repo; each entry carries a repo-relative `dir`
(see Nested `.claude/` directories). Plugin-contributed skills also join this list, tagged
`source` (see Plugin-provided skills & agents). A skill's name is the **directory name** for a
`SKILL.md` (invokable identity, not the frontmatter `name`) and the **filename** for a command.

**Fields captured** (mirrors agents — body is the substance):


| Field                     | Capture                | Signal                                                                             |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Count                     | Yes                    | Customization depth                                                                |
| Name                      | Yes                    | Skill catalog (SKILL.md → directory name; command → filename)                      |
| Frontmatter `description` | If present             | Purpose — always parse it; absent is fine (legacy commands often omit frontmatter) |
| Body                      | Yes — full text + hash | Instruction content — adoption detection + diff                                    |


Only `SKILL.md` files exactly one level deep (`skills/<name>/SKILL.md`) are skills; a `SKILL.md`
nested deeper (a skill's own supporting files) is not. Other frontmatter fields
(`disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`) are dropped
for now — add them if a detector needs the invocation posture.

**Stored shape** (`dir` on project entries, `source` on plugin entries):

```json
{
  "skills": [
    { "name": "deploy", "description": "Deploy to staging", "body": "Run the deploy script...", "bodyHash": "d4e5f6...", "dir": ".claude/skills" },
    { "name": "review", "body": "Review the current diff...", "bodyHash": "...", "dir": ".claude/commands" }
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


| Scope   | Path                                                        |
| ------- | ----------------------------------------------------------- |
| User    | `$CLAUDE_HOME/CLAUDE.md`                                    |
| Project | every `CLAUDE.md` / `CLAUDE.local.md` under the repo        |

Project scope finds every `CLAUDE.md` / `CLAUDE.local.md` in the repo by filename — at the root,
in nested packages (`packages/x/CLAUDE.md`), and inside any `.claude/` (`<dir>/.claude/CLAUDE.md`).
Unlike settings, these can sit directly in a directory with no `.claude/`, so they're found by a
filename walk (see Nested `.claude/` directories).


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


Except `mcp`, project scope reads from **every `.claude/` under the repo** (root + nested
packages), not just the root.

| Category       | Global scope                              | Project scope                                                  |
| -------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `settings`     | `$CLAUDE_HOME/settings.json`              | `settings.json` + `settings.local.json` in each `.claude/`     |
| `mcp`          | `$CLAUDE_HOME/.claude.json` → per-project | `<repo>/.mcp.json` + `.claude.json` entries under the repo     |
| `agents`       | `$CLAUDE_HOME/agents/`                    | `agents/` in each `.claude/`                                   |
| `skills`       | `$CLAUDE_HOME/skills/` + `commands/`      | `skills/` + `commands/` in each `.claude/`                     |
| `instructions` | `$CLAUDE_HOME/CLAUDE.md`                  | every `CLAUDE.md` / `CLAUDE.local.md` under the repo           |


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
root, read its config across every `.claude/` under the repo (settings/agents/skills), every
`CLAUDE.md`/`CLAUDE.local.md`, `.mcp.json`, and the `~/.claude.json` MCP entries under it → write
`scope='project'`, `scope_key=<repo root>` snapshots (one row per category; nested config lives
inside the payload).

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

**Deletions are tombstoned.** A category with stored history that a *successful* read no
longer returns was removed from disk; capture writes a `null`-payload snapshot through the
same gate, so current/asOf reflect the deletion ("remove X" fixes are confirmable adoptions
too). A *failed* read never tombstones — no evidence the config is gone, only that we
couldn't look.

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

## Nested `.claude/` directories (monorepo sub-packages)

CC reads config from **every `.claude/` directory** in a repo — the root and each monorepo
sub-package (`packages/frontend/.claude/…`), plus `CLAUDE.md` files that can sit directly in any
directory. The project-scope readers capture all of them. (`mcp` is exempt — it has no
nested-`.claude/` concept; its per-cwd config lives in `.claude.json` and is unioned per repo.)

### Multiple dirs live inside the per-repo payload

The several dirs are represented **inside the one per-repo snapshot**, not as extra rows — the
same "key by source path, don't merge, keep collisions visible" pattern `settings` and `mcp`
already use. `scope_key` stays the repo root, so there is still one snapshot row per
(repo, category); the append-on-change timeline and every consumer are unchanged, only the
payload is richer. A change in any package's config re-snapshots that one per-repo row.

- **settings / instructions** — keyed by each file's **repo-relative path**.
- **agents / skills** — a list, each entry carrying a repo-relative **`dir`**, so same-named
  entries in different packages coexist instead of colliding.

**Payload shape** (settings by path; agents by `dir`):
```json
{
  ".claude/settings.json":                   { "permissions": {…} },
  "packages/frontend/.claude/settings.json": { "permissions": {…} }
}
```
```json
{
  "agents": [
    { "name": "reviewer", "dir": ".claude/agents", "body": "…", "bodyHash": "…" },
    { "name": "reviewer", "dir": "packages/web/.claude/agents", "body": "…", "bodyHash": "…" }
  ],
  "count": 2
}
```

### Discovery

A single downward walk from the repo root finds every `.claude/` dir (shared across
settings/agents/skills) and every `CLAUDE.md` / `CLAUDE.local.md` (for instructions — these
can live in a directory with no `.claude/`, so they're found by filename). The walk skips
`node_modules`, `.git`, `dist`, `build`, `vendor`, `venv`, `target`, and other dot-directories
(never the user's config), and runs once per repo, shared across the readers.

Skills stay **depth-1** within each `skills/` dir — a skill is `skills/<name>/SKILL.md`; a
`SKILL.md` nested deeper (a skill's own `examples/`) is a supporting file, not a skill.

The snapshot records config **presence** (the config exists in the repo), matching the reader's
current-state model — not which sub-package a given session happened to work in.

---

## Plugin-provided skills & agents

An enabled plugin contributes its own skills and agents (e.g. `frontend-design` ships a
`frontend-design` skill). The `skills` and `agents` categories include these alongside the
user/project ones, each tagged `source: "plugin:<id>"` (parallel to the `dir` used for nested
project config) — complementing the plugin *names*, which `settings` already captures via
`enabledPlugins`.

**Resolution**, run per scope: compute EFFECTIVE enablement first — for the project snapshot,
`settings.local.json` overrides `settings.json` per plugin id (a local `false` is how CC
disables a project-enabled plugin for one user) — then map each enabled id through
`$CLAUDE_HOME/plugins/installed_plugins.json` to the install entry whose scope matches → its
`installPath` → read `.claude-plugin/plugin.json` for skill/agent dirs (`skills` adds to the
default `skills/`; `commands`/`agents` replace their defaults; a manifest path that escapes
the install root is dropped) → read those dirs and tag with the plugin id. `user` installs
feed the global snapshot; `project`/`local` installs feed the repo's.

---

## Security principles

We store a **small, fixed allowlist** of structural fields. This is the primary defense —
secrets are never read in the first place, so nothing can leak into an LLM prompt (including the
config-diff adoption check).

1. **Never store env var values** — `env` is dropped entirely (both settings and MCP).
2. **Never store MCP secrets** — only name, type, url. Command, args, env, headers,
  headersHelper, oauth, timeout, and alwaysLoad are dropped. URLs are stored
   credential-stripped (no userinfo, query, or fragment); an unparseable URL is dropped.
3. **Never store hook command strings** — hooks are dropped from settings entirely.
4. **Never touch** `credentials.json` or any auth token store.
5. **Instruction bodies are stored** (agent system prompts, skill/command bodies, CLAUDE.md).
  These are user-authored content, not secrets — the adoption signal needs them. They are the
   one place snapshot data is non-trivial in size; keep them out of any LLM prompt that doesn't
   specifically need them.
6. **Allowlist, not blocklist** — a field is captured only if it appears in the tables above.

---

# Part 3 — OpenCode reader

The storage layer, the harness-neutral category vocabulary, the two-phase capture (global once +
per unique repo root), append-on-change, and deletion tombstones are all **inherited unchanged**
from Parts 1–2. Adding OpenCode is therefore a single new reader:

- `src/adapters/opencode/environment.ts` exporting `readOpencodeEnvironment(projectPath?)` →
  `EnvCategorySnapshot[]`, plus
- one line in `src/adapters/opencode/index.ts` (`readEnvironment: readOpencodeEnvironment`).

No store, schema, or `analyze.ts` change is needed — `reposBySource` already resolves OpenCode
repo roots from `session.project.cwd`, so project-scope capture runs the moment the hook exists.

## Snapshots are independent per-harness views

Every `environment_snapshots` row is keyed by `source` (the adapter id) as the leading PK column.
The `claude-code` and `opencode` snapshots are **fully isolated** and are consumed independently —
each is read only to advise *that* harness. Nothing is summed across sources, so there is **no
double-counting** and therefore **no "skip" rule**: the OpenCode reader captures *every* location
OpenCode honors, including its Claude-compatible and agent-compatible fallback dirs
(`.claude/skills/`, `~/.claude/CLAUDE.md`, `.agents/skills/`, …). The same physical file
appearing in both the `claude-code` and `opencode` snapshots is correct — they are two different
harnesses' effective config, and advice about OpenCode must read off OpenCode's effective config.

## Structural differences from Claude Code (why it isn't copy-paste)

1. **Config home ≠ data home.** The adapter's `defaultRoots` is the *data* dir
   (`~/.local/share/opencode`, which holds `opencode.db`). Config lives elsewhere, under
   `opencodeConfigHome()`:
   `$OPENCODE_CONFIG_DIR` → else `$XDG_CONFIG_HOME/opencode` → else `~/.config/opencode`.
   An explicit config *file* override is `$OPENCODE_CONFIG`. Global-scope reads must use the
   config home, never the data root.
2. **One JSONC file feeds four categories.** `opencode.json` **or** `opencode.jsonc` packs
   `permission` + `plugin` (settings), `mcp`, inline `agent` (agents), inline `command` (skills),
   and `instructions` refs. A single parse fans out; the `.md`/`SKILL.md` scans layer on top.
3. **JSONC parsing is new.** The repo has no JSONC support today. A small comment-/trailing-
   comma-tolerant parse helper is required (JSON alone will not parse the user's `.jsonc`).
   Variable substitution (`{env:…}`, `{file:…}`) is left literal — since secrets are dropped, a
   substituted MCP url simply fails `redactUrl` and is dropped (safe).
4. **Directory names vary; config keys are singular.** In the config file the keys are singular
   (`agent`, `command`, `plugin`). On disk the docs read as plural (`agents/`, `commands/`,
   `skills/`, `plugins/`), but OpenCode has used the singular dir names across versions — so the
   reader scans **both** `agents/`+`agent/` and `commands/`+`command/` (missing dirs yield `[]`,
   so scanning both is free and version-robust). `skills/` is confirmed plural.
5. **`permission` is an object, not allow/deny/ask arrays** (`{ edit, bash, webfetch }` → enum
   `ask|allow|deny`, or nested glob→enum). Different allowlist shape from CC.
6. **`AGENTS.md` is `instructions`, not `agents`.** OpenCode's `agents/*.md` are sub-agent
   definitions; `AGENTS.md` is the CLAUDE.md-equivalent.

## Shared-helper extraction

OpenCode's `SKILL.md` and frontmatter handling are identical to CC's. Rather than reimplement or
import cross-adapter, extract the reusable primitives into **`src/adapters/env-shared.ts`** and
have both readers import them: `splitFrontmatter`, `parseFrontmatter`, `toStringList`,
`readSkillFile`, the agent-frontmatter parse, `redactUrl`, `readJsonIfExists`, `isUnder`,
`listDirs`, `contentHash`-of-body. `claude-code/environment.ts` and `opencode/environment.ts`
then share one implementation.

## What we capture — by category (OpenCode)

Where `$OC_HOME` = `opencodeConfigHome()` and `<repo>` is a project root. Each category's payload
is **keyed by on-disk source** (file path / dir+name), so every location is distinguishable and
the `content_hash` moves when any one changes.

### 1. `settings`

**Sources:** `$OC_HOME/opencode.json[c]` (global); `<repo>/opencode.json[c]` (project). Keyed by
source file path.

| Field                 | Capture                | Signal                                             |
| --------------------- | ---------------------- | -------------------------------------------------- |
| `permission`          | Yes (object as-is)     | Tool-approval posture — core adoption signal       |
| `plugin`              | Yes (npm names / specs)| Ecosystem adoption (parallel to CC `enabledPlugins`)|
| `model` / `small_model` / `default_agent` | Candidate (non-secret model posture) | Model-choice adoption — include if a detector needs it |

**Dropped:** **`provider`** (holds API keys — never read), `keybinds`/`theme`/`tui`, `formatter`/
`lsp`/`watcher`/`compaction`/`experimental`, and `mcp`/`agent`/`command` (their own categories).

### 2. `mcp`

**Sources:** the `mcp` object in the global and project `opencode.json[c]`. Keyed by source file →
server name.

| Field     | Capture                          | Notes                                             |
| --------- | -------------------------------- | ------------------------------------------------- |
| `type`    | Yes (`local` \| `remote`)        |                                                   |
| `url`     | remote only, credential-stripped | via `redactUrl`; `{env:…}` → unparseable → dropped |
| `enabled` | If present (bool)                |                                                   |

**Dropped (secret-bearing / signal-free):** `command`, `cwd`, **`environment`**, **`headers`**,
**`oauth`**, `timeout`.

### 3. `agents`

**Sources:** `agents/*.md` (`$OC_HOME/agents/`, `<repo>/.opencode/agents/`) **and** inline `agent`
objects in `opencode.json[c]` (global + project). File entries key `name` off the filename; inline
entries key off the config path + object key and tag `source: "config"`.

| Field                         | Capture                | Signal                        |
| ----------------------------- | ---------------------- | ----------------------------- |
| `name`                        | Yes (filename / key)   | Agent catalog                 |
| `description`                 | If present             | Purpose                       |
| `mode` (`primary`/`subagent`/`all`) | If present       | Agent role                    |
| `model`                       | If present             | Per-agent model preference    |
| Body (markdown body / inline `prompt`) | Yes — full + hash | System prompt — adoption + diff |

**Dropped:** `color`, `temperature`, `permission`, `steps`, `top_p`, `hidden`, `disable`, `tools`
(deprecated), provider passthrough. (Docs list no `.claude/agents` fallback for agents — native
locations only.)

### 4. `skills`

The harness-neutral `skills` category holds both OpenCode **skills** (`SKILL.md`) and **commands**
(the user-invoked `/slash` prompts) — mirroring how CC folds commands into skills — with each entry
tagged `kind: "skill" | "command"` so the two remain distinguishable.

**Skill sources — all six searched `<name>/SKILL.md` locations (merged), keyed by (location, name):**

| Scope   | Locations                                                              |
| ------- | --------------------------------------------------------------------- |
| Project | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`             |
| Global  | `$OC_HOME/skills/`, `~/.claude/skills/`, `~/.agents/skills/`          |

`name` = directory name (must equal frontmatter `name`); capture `description` + body + hash;
`kind: "skill"`. `SKILL.md` shape is identical to CC → reuse `readSkillFile`.

**Command sources:** `commands/*.md` (`$OC_HOME/commands/`, `<repo>/.opencode/commands/`) **and**
inline `command` objects in the config. `name` = filename / key; capture `description`, `agent`,
`model` + body (`template`) + hash; `kind: "command"`.

**Dropped:** `subtask`; skill `license` / `compatibility` / `metadata` (low signal).

### 5. `instructions`

**Effective/active only** — apply OpenCode's fallback precedence and store *only* what OpenCode
actually loads (a shadowed file OpenCode ignores is not stored). Keyed by file path; empty files
omitted; bodies stored full + hash.

| Scope   | Active source (in precedence order)                                                  |
| ------- | ------------------------------------------------------------------------------------ |
| Global  | `$OC_HOME/AGENTS.md`; **else** fallback `~/.claude/CLAUDE.md`                         |
| Project | `<repo>/AGENTS.md` (+ nested `AGENTS.md` under the repo); **else** fallback `<repo>/CLAUDE.md` |
| Both    | every file matched by the config `instructions[]` globs (always combined; local paths only — remote URLs deferred) |

## Scope summary (OpenCode)

| Category       | Global scope                                            | Project scope                                                        |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `settings`     | `$OC_HOME/opencode.json[c]`                             | `<repo>/opencode.json[c]`                                            |
| `mcp`          | `mcp{}` in `$OC_HOME/opencode.json[c]`                  | `mcp{}` in `<repo>/opencode.json[c]`                                 |
| `agents`       | `$OC_HOME/agents/*.md` + inline `agent{}`              | `<repo>/.opencode/agents/*.md` + inline `agent{}`                    |
| `skills`       | 3 global `skills/<n>/SKILL.md` + `commands/*.md` + inline `command{}` | 3 project `skills/<n>/SKILL.md` + `.opencode/commands/*.md` + inline |
| `instructions` | `$OC_HOME/AGENTS.md` (→ `~/.claude/CLAUDE.md`) + `instructions[]` | `<repo>/AGENTS.md` (+ nested; → `<repo>/CLAUDE.md`) + `instructions[]` |

## Symlinks & deduplication (both readers)

Skills, agents, and commands are commonly **symlinked** to share them across harness dirs (e.g.
`~/.claude/skills/foo` → `~/.agents/skills/foo`). Two shared fixes make the readers handle this —
they apply to the Claude Code reader as well, not just OpenCode:

- **Follow symlinks.** `listDirs` and `walkFiles` (in `env-shared.ts` / `util/walk.ts`) previously
  filtered on `Dirent.isDirectory()`, which is **false for a symlink-to-a-directory** — so a
  symlinked skill dir was silently dropped even though the harness loads it. Both now resolve
  symlinks (with a visited-realpath guard in `walkFiles` so a symlink cycle terminates).
- **Dedupe by real path.** Because the same physical skill can be reached through several
  locations (a real dir plus symlinks into it), each reader keeps a `Set` of source-file
  realpaths and collapses entries that resolve to the same file — so a skill symlinked into
  `.claude` **and** `.agents` appears once, not twice. Scan order lists likely-real locations
  first, so the real location wins the surviving `dir` label. This mirrors the "effective, not
  raw on-disk" choice made for instructions.

## Out of scope (v1)

Remote config (`.well-known/opencode`), `OPENCODE_CONFIG_CONTENT` inline overrides, managed
system configs (`/Library/Application Support/opencode`, `/etc/opencode`), local plugin JS bodies
in `plugins/` dirs (names captured via `settings.plugin`, not the code), remote-URL entries in
`instructions[]`, and `tui.json`.

## Security (delta from Part 2)

Same allowlist-not-blocklist principle. OpenCode-specific **never-store**: the `provider` block
(API keys), MCP `environment` / `headers` / `oauth`, any `{env:…}`-substituted value, and the data
dir's `auth.json` (never touched). Instruction/agent/skill/command bodies are stored (user-authored
content, not secrets — the adoption signal needs them), consistent with CC.

---

# Part 4 — Codex reader

Codex is the next adapter to implement the same five-category snapshot contract. The storage
lifecycle is unchanged: capture global scope once, capture each observed repository root once,
append only on content change, and write tombstones only after a successful read. The adapter adds
`readCodexEnvironment(projectPath?)`; there is no schema migration or session parse-version bump.

The discovery rules follow the current Codex documentation for the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[skills](https://learn.chatgpt.com/docs/build-skills),
[custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), and
[MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Scope and source precedence

`$CODEX_HOME` is read from the environment and defaults to `~/.codex`. Global scope reads the base
`$CODEX_HOME/config.toml`. Project scope discovers every `.codex/config.toml` below the repository
root, including nested package/service layers, and keeps each file separate in the payload. This
represents sessions launched below the root even though environment capture is keyed by repository.

Codex normally resolves project config from repository root toward the launch directory, with the
closest layer winning. The snapshot deliberately does not flatten those layers: file-keyed entries
preserve their origin and make additions/removals attributable. Nested instruction fallback settings
are applied only to their directory and descendants.

TOML is parsed with `smol-toml`, not a partial in-tree parser. If a present global or project
`config.toml` is invalid, that scope's read throws. The capture layer then keeps the last successful
snapshot rather than mistaking a parse failure for deletion and writing tombstones. Invalid
standalone agent TOMLs are local failures and are omitted individually.

## Payloads by category

### `settings`

Sources are `$CODEX_HOME/config.toml` for global scope and every discovered project
`.codex/config.toml` for project scope. The payload is keyed by source file:

```json
{
  ".codex/config.toml": {
    "approval_policy": "on-request",
    "approvals_reviewer": "auto_review",
    "sandbox_mode": "workspace-write",
    "sandbox_workspace_write": { "network_access": true },
    "web_search": "cached",
    "features": {
      "apps": true,
      "hooks": false,
      "memories": true,
      "code_mode": {
        "enabled": true,
        "excluded_tool_namespaces": ["mcp__codex_apps"],
        "direct_only_tool_namespaces": ["mcp__history"]
      }
    }
  }
}
```

Only explicit values are captured. Granular approval policy retains only its documented boolean
prompt categories. The `apps`, `hooks`, and `memories` entries above are enablement flags from
`[features]`; per-app configuration, hook definitions/commands, and memory contents are excluded.
An otherwise valid config that retains no allowlisted setting contributes no `settings` category.

### `mcp`

`mcp_servers` is read independently from each config file. Server type is derived as `http` when a
`url` exists and `stdio` when a `command` exists. The payload retains only type, a redacted URL, and
an explicitly configured enabled state:

```json
{
  ".codex/config.toml": {
    "servers": {
      "docs": { "type": "http", "url": "https://example.com/mcp", "enabled": true },
      "local": { "type": "stdio", "enabled": false }
    }
  }
}
```

URL userinfo, query strings, and fragments are removed. Unparseable URLs are omitted rather than
stored verbatim. Commands, arguments, working directories, environment/environment-variable names,
headers, authentication, bearer-token configuration, OAuth scopes, tool policy, and timeouts are
never stored.

### `agents`

Global scope scans TOML files under `$CODEX_HOME/agents`. Project scope scans every nested
`.codex/agents` directory. The reader also honors `[agents.<name>].config_file` references; relative
paths resolve beside the defining `config.toml`. Each valid file must contain Codex's required
`name`, `description`, and `developer_instructions` fields.

The harness-neutral payload remains `{ "agents": [...], "count": n }`. Each entry retains:

- `name` and `description`
- `developer_instructions` as `body`, plus `bodyHash`
- optional `model`, `model_reasoning_effort`, and `sandbox_mode`
- `dir`, the source directory relative to the scope when possible

Nested MCP servers, skills, and all other session config in an agent file are dropped. Referenced
project paths and symlink targets must remain inside the repository; global config may reference
user-owned paths outside `$CODEX_HOME`.

### `skills`

Global scope scans `~/.agents/skills/<name>/SKILL.md`. Project scope scans
`.agents/skills/<name>/SKILL.md` in every directory below the repository root. Safe
`[[skills.config]]` paths add skills or disable a discovered skill by canonical file path. Relative
paths resolve beside the defining config.

The payload remains `{ "skills": [...], "count": n }`. Entries retain `name`, optional
`description`, full `body`, `bodyHash`, `kind: "skill"`, and the source `dir`. Skill-directory
symlinks are followed, then files are deduplicated by real path. Configured project paths and
project symlink targets that escape the repository are ignored.

Plugin caches, plugin-contributed skills, admin/system skills, and bundled system skills are not
part of v1.

### `instructions`

Global scope uses the first non-empty `$CODEX_HOME/AGENTS.override.md`, otherwise
`$CODEX_HOME/AGENTS.md`. For every project directory, precedence is:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. the active `project_doc_fallback_filenames`, in configured order

At most one non-empty file per directory is stored. Each entry is keyed by scope-relative path and
contains the full `body` plus `hash`. Nested project configs replace fallback filename lists only
for their directory and descendants. The snapshot keeps complete files rather than applying the
runtime context-size cap because diff/adoption analysis needs the durable source content.

## Determinism and security

Config files, server names, project directories, agents, skills, and safe namespace lists are
sorted before emission. Realpath deduplication prevents a skill or agent reached through multiple
symlinks from causing false snapshot churn.

The reader uses fixed allowlists. It never opens `auth.json` or another credential store and never
returns provider configuration, API keys, environment values or names, shell commands/arguments,
headers, tokens, OAuth/auth configuration, hooks bodies, or MCP timeouts. Full bodies are retained
only for the three user-authored content surfaces where they are the adoption signal: agents,
skills, and instruction files.

## Deferred Codex surfaces (v1)

Profile TOMLs, CLI `--config` overrides, runtime-only session overrides, system/managed config and
requirements, memories, plugin caches and plugin-provided skills, app definitions, hook bodies,
auth files, and installed/bundled skill catalogs are intentionally deferred. Base and project
config files remain independent source records rather than a flattened effective object.


# Part 5 — Pi reader

Pi is the next adapter to implement the snapshot contract. The storage lifecycle is unchanged:
capture global scope once, capture each observed repository root once, append only on content
change, and write tombstones only after a successful read. The adapter adds
`readPiEnvironment(projectPath?)`; there is no schema migration or session parse-version bump.

Discovery follows the current Pi documentation for [settings](../../settings.md),
[skills](../../skills.md), and context files (`quickstart.md`, `usage.md`).

## Narrow category coverage

Pi is deliberately minimal: it ships **no built-in MCP and no sub-agents** (`usage.md`: "does not
include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash"). The
reader therefore emits only three of the five categories — `settings`, `skills`, and
`instructions` — and never `mcp` or `agents`. Users who want those workflows install them as
extensions or packages, which are captured indirectly through the `settings` resource pointers.

## Scope and home resolution

Pi's agent home is `$PI_CODING_AGENT_DIR` (which points AT the agent dir, e.g. `~/.pi/agent`, not
its parent), defaulting to `~/.pi/agent`. Global scope reads that home. The home-level
`~/.agents/skills` directory is a *sibling* of `~/.pi` and does **not** follow
`$PI_CODING_AGENT_DIR`; it is always resolved from the OS home.

Project scope walks the repository once (`scanProject`) collecting every `.pi/` dir, every
`.agents/` dir, and every `AGENTS.md`/`CLAUDE.md`. Nested `.pi`/`.agents` in monorepo sub-packages
are captured and kept separate; the walk prunes `node_modules`, `.git`, build/vendor trees, and
other dot-directories so vendored config never leaks in. `.pi`/`.agents` themselves are registered
but not descended into — their subtrees are skill directories, not more config dirs.

## Payloads by category

### `settings`

Sources are `<piHome>/settings.json` for global scope and every discovered project
`.pi/settings.json` for project scope, keyed by relative path. A fixed allowlist keeps only
non-secret posture: model + thinking config (`defaultProvider`, `defaultModel`,
`defaultThinkingLevel`, `thinkingBudgets`, `hideThinkingBlock`, `showCacheMissNotices`,
`enabledModels`), trust posture (`defaultProjectTrust`), context management (`compaction`,
`branchSummary`, `retry`), delivery (`steeringMode`, `followUpMode`, `transport`), `warnings`,
and resource pointers (`packages`, `extensions`, `skills`, `prompts`, `themes`,
`enableSkillCommands`). `httpProxy` is kept only as a redacted endpoint identity (userinfo, query,
and fragment stripped). Everything else — themes and other pure-UI display options,
`externalEditor`, `shellPath`/`shellCommandPrefix`/`npmCommand` execution plumbing, `sessionDir`,
`trackingId`, telemetry flags — is dropped by omission. A file whose fields are all dropped
contributes no entry.

### `skills`

Global scope scans `<piHome>/skills` and `~/.agents/skills`. Project scope scans `<repo>/.pi/skills`
and `<repo>/.agents/skills` in every such directory found. Per Pi's discovery rules, `.pi` skill
dirs discover direct root `.md` files as individual skills, all locations discover `SKILL.md`
directories recursively, and `.agents` skill dirs ignore root `.md` files. The payload is
`{ "skills": [...], "count": n }`; each entry retains `name`, optional `description`, full `body`,
`bodyHash`, `kind: "skill"`, and the source `dir`. Pi lets the frontmatter `name` differ from the
directory, so it is authoritative with the directory/file base name as fallback. Skills reached
through symlinks are deduplicated by real path.

Settings-listed skill directories, package-contributed skills, and CLI `--skill` paths are deferred
for v1 — the two on-disk conventions above cover the common case.

### `instructions`

Global scope reads `<piHome>/AGENTS.md` and `<piHome>/CLAUDE.md`. Project scope stores every
`AGENTS.md`/`CLAUDE.md` found under the repo (Pi walks up from cwd loading these, so nested files
represent sessions launched from those directories). Each entry is keyed by relative path and
holds the full `body` plus `hash`. Empty files are omitted.

## Deferred Pi surfaces (v1)

`models.json` (custom providers), `keybindings.json`, `auth.json`, package/extension *contents*
(only their settings pointers are captured), settings-referenced and CLI-supplied skill paths, and
prompt/theme resource contents are intentionally deferred.
