# Environment Reader — Harness Config Snapshots

Status: **design in progress**
Jira: AL-71

## Problem

tuneloop derives per-session facts (cost, files, PRs, complexity) but has no visibility into
the **harness configuration** that shaped those sessions. A developer who adds an MCP server,
installs custom agents, changes permission rules, or enables a plugin — tuneloop can't see it.
Config changes are the core adoption signal: did a config-snippet fix from a detector actually
get applied? Did adding a new agent correlate with cost/time improvement?

The environment reader captures a versioned snapshot of harness configuration, so config
changes are visible and diffable.

## Design principle: minimal surface area

We capture **only fields we know are useful today** and drop everything else. Two reasons:

1. **LLM safety.** Snapshots are read during processing and detector runs, some of which send
   data to an LLM. The less we store, the less can ever leak. We never store **secrets** — env
   var values, MCP args/env/headers, hook command strings. We *do* store user-authored
   instruction bodies (agent system prompts and skill/command bodies), because the body is the
   substance and adoption detection needs it; the tradeoff is accepted for these non-secret
   content fields.
2. **Signal over noise.** Preference fields (theme, editor mode) and auth plumbing carry no
   improvement-cycle signal. Start tight; add fields as concrete detectors need them.

The rule is an **allowlist**: a field is stored only if it appears in the tables below. Anything
else — including new keys a future harness version adds — is dropped by default.

## Goals

1. Snapshot harness config — starting with Claude Code.
2. Prefer capture **at session-creation time** via an opt-in `SessionStart` hook (accurate per
   session); fall back to **current state at `analyze` time** (approximation) when no per-session
   snapshot exists.
3. Versioned: a content-hash change records a new snapshot.
4. Enable the "config adoption" signal — confirm a detector-issued fix was applied.

## Non-goals (for now)

- Cross-harness comparison (one adapter at a time; CC first).
- Storing any secret-bearing field (env values, MCP args/env/headers, hook commands).
- Dashboard visualization of config diffs (separate ticket).

---

## What we capture — by category (Claude Code)

Where `$CLAUDE_HOME` = `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`.

### 1. Settings

**Sources by scope:**

| Scope | Path | Shared? |
|-------|------|---------|
| User (global) | `$CLAUDE_HOME/settings.json` | No |
| Project (shared) | `<repo>/.claude/settings.json` | Yes (committed) |
| Project (local) | `<repo>/.claude/settings.local.json` | No (gitignored) |

**Fields captured** (nothing else):

| Field | Capture | Signal |
|-------|---------|--------|
| `permissions.allow` | Yes (rule patterns) | Permission posture — core adoption signal |
| `permissions.deny` | Yes | Security posture |
| `enabledPlugins` | Yes (names + boolean) | Ecosystem adoption |

`permissions.allow` captures only **persisted** allow rules (the "Yes, and don't ask again"
choice, written to `settings.json`). Session-only allows ("allow for this session") live in
session runtime and never touch disk, so they are correctly excluded — this field is exactly
the durable, cross-session permission posture.

**Deliberately dropped:**

| Field | Why dropped |
|-------|-------------|
| `env` | Values are secrets |
| `apiKeyHelper` / `awsCredentialExport` / `gcpAuthRefresh` | Auth plumbing, no signal |
| `theme` / `editorMode` | Preferences, no signal |
| `permissionMode` | Only the session *default*; actual mode is per-session and changes at runtime (shift-tab). Misleading as config; belongs in the adapter if we ever need per-session mode. |
| `model` | Only the configured default; actual per-message model is already in `usage_facts`, and `/model` changes it mid-session. Redundant + misleading as config. |
| `hooks` | Config hooks add little on their own; runtime hook execution (`hookEvent`/`hookCount`/`hookErrors`) is already in the transcript and is the better source. Revisit later if adoption detection needs it. |

**Stored shape:**
```json
{
  "permissions": { "allow": ["Bash(npm test *)"], "deny": [] },
  "plugins": { "frontend-design@claude-plugins-official": true }
}
```

### 2. MCP Servers

**Sources by scope:**

| Scope | Path | Shared? |
|-------|------|---------|
| Per-project (local state) | `$CLAUDE_HOME/.claude.json` → `projects.<cwd>.mcpServers` | No |
| Project (shared) | `<repo>/.mcp.json` | Yes (committed) |

**Fields captured** (only these three — nothing that carries secrets):

| Field | Capture | Signal |
|-------|---------|--------|
| Server name | Yes | What capability is wired up — the core signal |
| `type` (http/sse/stdio) | Yes | Local (stdio) vs remote (http/sse) |
| `url` | Yes | Endpoint identity (for http/sse servers) |

Dropped: `command` (for a stdio server the user-chosen `name` already identifies it; `command`
alone is just `npx`/`uvx`), `args`, `env`, `headers`, `headersHelper`, `oauth`, `timeout`,
`alwaysLoad`. Everything dropped is either secret-bearing or a tuning knob with no signal.

**Stored shape:**
```json
{
  "servers": {
    "atlassian": { "type": "sse", "url": "https://mcp.atlassian.com/v1/sse" },
    "postgres": { "type": "stdio" }
  },
  "count": 2
}
```

### 3. Agents

**Sources by scope:**

| Scope | Path |
|-------|------|
| User (global) | `$CLAUDE_HOME/agents/*.md` |
| Project | `<repo>/.claude/agents/*.md` |

**Fields captured:**

| Field | Capture | Signal |
|-------|---------|--------|
| Count | Yes | How many custom agents |
| Frontmatter `name` | Yes | Agent catalog — always present (identity) |
| Frontmatter `description` | Yes | Purpose — effectively always present |
| Frontmatter `model` | If present | Per-agent model preference (often `inherit` / omitted) |
| Frontmatter `tools` / `disallowedTools` | If present | Tool scoping (omitted = all tools) |
| Body (system prompt) | Yes — full text + hash | Instruction content — enables true adoption detection + diff |

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

### 4. Skills / Commands

Custom commands have been **merged into skills** — `.claude/commands/deploy.md` and
`.claude/skills/deploy/SKILL.md` both create `/deploy` and behave the same. We capture both
formats into **one merged list**; the skills-vs-legacy-command distinction is a dying
implementation detail with no signal.

**Sources by scope:**

| Scope | Path |
|-------|------|
| User (global) | `$CLAUDE_HOME/skills/*/SKILL.md` + `$CLAUDE_HOME/commands/*.md` |
| Project | `<repo>/.claude/skills/*/SKILL.md` + `<repo>/.claude/commands/*.md` |

**Fields captured** (mirrors agents — body is the substance):

| Field | Capture | Signal |
|-------|---------|--------|
| Count | Yes | Customization depth |
| Frontmatter `name` | Yes | Skill catalog (falls back to filename) |
| Frontmatter `description` | If present | Purpose — always parse it; absent is fine (legacy commands often omit frontmatter) |
| Body | Yes — full text + hash | Instruction content — adoption detection + diff |

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

### 5. CLAUDE.md

Plain markdown, no frontmatter — the always-on instruction file. It is the single richest
adoption target (detector nudges like "add a rule about X" land here), so we store the full
body, mirroring agents/skills. `@import` references are stored **as-is, unexpanded** for v1
(the import lines are visible in the raw text); resolving imports is deferred.

**Sources by scope:**

| Scope | Path |
|-------|------|
| User | `$CLAUDE_HOME/CLAUDE.md` |
| Project (shared) | `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md` |
| Project (local) | `<repo>/CLAUDE.local.md` |

**Fields captured:**

| Field | Capture | Signal |
|-------|---------|--------|
| Existence | Yes (boolean) | Adoption signal (did they create one) |
| Body | Yes — full text + hash | Instruction content — adoption detection + diff |

**Stored shape:**
```json
{
  "claudeMd": { "exists": true, "body": "# CLAUDE.md\n\nThis file provides...", "hash": "j0k1l2..." },
  "claudeLocalMd": { "exists": false }
}
```

Rules (`.claude/rules/*.md`) are **dropped for v1** — a rule without `paths` is just CLAUDE.md
by another name, and path-scoped rules add a `paths` signal we don't yet consume. Revisit when
a detector needs path-scoped instruction data.

---

## Scope summary

Each category has a **global** component (user-level, same across all repos) and a
**project** component (varies per repo). The snapshot distinguishes these:

| Category | Global scope | Project scope |
|----------|-------------|---------------|
| Settings | `$CLAUDE_HOME/settings.json` | `<repo>/.claude/settings.json` + `settings.local.json` |
| MCP | `$CLAUDE_HOME/.claude.json` → per-project | `<repo>/.mcp.json` |
| Agents | `$CLAUDE_HOME/agents/` | `<repo>/.claude/agents/` |
| Skills | `$CLAUDE_HOME/skills/` | `<repo>/.claude/skills/` + `commands/` |
| CLAUDE.md | `$CLAUDE_HOME/CLAUDE.md` | `<repo>/CLAUDE.md` + `.local.md` |

---

## Mechanism

### The core problem: when is config captured?

Config is **ambient state that drifts over time**. A session that ran last week ran under
whatever config existed *then*. By the time `analyze` runs, the config may have changed —
permissions added, an MCP server removed, an agent edited. Reading current state at analyze
time attributes *today's* config to *yesterday's* session. That's an approximation, and for
the adoption signal (did config change between sessions?) it can be actively wrong.

The accurate answer is to capture config **at session-creation time**. Claude Code fires a
`SessionStart` hook exactly then. So we offer two tiers.

### Tier 1 (accurate): opt-in `SessionStart` hook

tuneloop ships a small hook script users can install. On every session start, CC invokes it
with the session id and cwd; the script reads the allowlisted config surface, and writes a
snapshot to disk keyed by session id:

```
~/.tuneloop/env-snapshots/claude-code/<session-id>.json
```

One file per session, written once at the moment the session began — so it records the config
that actually shaped that session, immune to later drift.

Install is opt-in (a `tuneloop install-hook` command, exact name TBD) that adds a `SessionStart`
entry to the user's `settings.json` pointing at the bundled script. Users who don't install it
fall back to Tier 2.

### Tier 2 (fallback): read current state at `analyze`

When no per-session snapshot file exists for a session, `analyze` reads the current on-disk
config and uses it as an approximation. This is the zero-setup default: works with no hook
installed, at the cost of drift for older sessions.

### Lookup order during analysis

For each session:
1. Look for `~/.tuneloop/env-snapshots/<source>/<session-id>.json` — use it if present.
2. Else read current config from `$CLAUDE_HOME` + the session's `cwd`.

### Shared reader module

The read/extract logic is identical for Tier 1 (hook) and Tier 2 (analyze fallback), so it
lives in one module callable from both. Per-harness: the paths and field extraction. The
storage layer and the per-session snapshot file format are harness-agnostic.

### Storage & versioning (open)

A snapshot row is written only when its content hash differs from the last stored snapshot for
the same (scope, scope-key, category) — so an unchanged config across many runs stores one row,
and a real change appends a new one. Table shape TBD, likely:
`environment_snapshots(source, scope, scope_key, category, hash, snapshot_json, captured_at)`
where `scope ∈ {global, project}` and `scope_key` is the cwd/repo for project scope.

Open: whether the analyze-time read is a standalone pipeline step, a processor, or folded into
the adapter. Leaning standalone step keyed by (scope, scope-key) with hash versioning — global
config read once per run, project config once per unique cwd — since config is not
session-derived and a per-session processor would re-read the same files N times.

---

## Adoption detection

Two kinds of fix, two detection paths:

- **Structural fixes** (permissions, MCP servers, plugins) are captured in structured fields —
  a detector confirms its exact fix appears in the next snapshot.
- **Instruction-body fixes** (adding/editing an agent's system prompt, a skill's steps) are
  captured as **full body text** plus a `bodyHash`. The hash detects *that* it changed cheaply;
  the stored body lets a detector confirm *what* changed and diff the definition across
  snapshots — no live-file re-read needed, and history is preserved.

Bodies are stored for agents, skills/commands, and CLAUDE.md. The tradeoff — larger storage +
these non-secret content fields present in snapshots read by detectors — is accepted for the
adoption signal.

---

## Future harness support

This design starts with Claude Code. Each harness needs its own reader (and, ideally, its own
session-start hook if the harness supports one):
- **Codex**: TBD — `~/.codex/config.toml`, MCP config.
- **OpenCode**: TBD — `opencode.json`.
- **Pi**: TBD — investigate config surface.
- **Cursor**: `.cursor/` directory, `.mcp.json`, rules.

The storage and per-session snapshot mechanism are harness-agnostic; only the reader logic
(paths + field extraction) is per-harness.

---

## Security principles

We store a **small, fixed allowlist** of structural fields. This is the primary defense —
secrets are never read in the first place, so nothing can leak into an LLM prompt.

1. **Never store env var values** — `env` is dropped entirely (both settings and MCP).
2. **Never store MCP secrets** — only name, type, url. Command, args, env, headers,
   headersHelper, oauth, timeout, and alwaysLoad are dropped.
3. **Never store hook command strings** — hooks are dropped from settings entirely.
4. **Never touch `credentials.json`** or any auth token store.
5. **Instruction bodies are stored** (agent system prompts, skill/command bodies). These are
   user-authored content, not secrets — the adoption signal needs them. They are the one place
   snapshot data is non-trivial in size; keep them out of any LLM prompt that doesn't
   specifically need them.
6. **Allowlist, not blocklist** — a field is captured only if it appears in the tables above.

## Related future opportunity (not this ticket)

CC records **hook execution** in the session transcript (`hookEvent`, `hookName`, `hookCount`,
`hookErrors` — e.g. `"hookEvent":"Stop"` firing 11×, with error counts). The CC adapter does
not parse this today. It is genuine runtime signal (did automation fire, how often, did it
error) and likely belongs as session/tool data in the adapter — a separate piece of work from
this config reader.
