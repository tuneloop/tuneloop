# Environment Reader — Harness Config Snapshots

Status: **design in progress**
Jira: AL-71

## Problem

tuneloop derives per-session facts (cost, files, PRs, complexity) but has no visibility into
the **harness configuration** that shaped those sessions. A developer who adds an MCP server,
installs custom agents, changes permission rules, or enables a plugin — tuneloop can't see it.
Config changes are an important adoption signal: did a config-snippet fix from a detector
actually get applied? Did adding a new agent correlate with cost/time improvement?

The environment reader captures a versioned snapshot of harness configuration on each
`analyze` run, so config changes between runs are visible and diffable.

## Goals

1. Snapshot harness config on `analyze` — starting with Claude Code.
2. Versioned: a content-hash change between runs records a new snapshot.
3. Enable the "config adoption" signal: a detector-issued config-snippet fix can be confirmed
   by observing the config diff in subsequent snapshots.
4. Security: never capture secrets (API keys, tokens, internal URLs, auth commands).

## Non-goals (for now)

- Capturing config at the time a session was *created* (we only read current state at analyze).
- Cross-harness comparison (one adapter at a time; CC first).
- Full CLAUDE.md / skill / agent body content (proprietary instructions — hash only).
- Dashboard visualization of config diffs (separate ticket).

---

## What we capture — by category (Claude Code)

### 1. Settings

**Sources by scope:**

| Scope | Path | Shared? |
|-------|------|---------|
| User (global) | `$CLAUDE_HOME/settings.json` | No |
| Project (shared) | `<repo>/.claude/settings.json` | Yes (committed) |
| Project (local) | `<repo>/.claude/settings.local.json` | No (gitignored) |

Where `$CLAUDE_HOME` = `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`.

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| `permissions.allow` | Yes | As-is (rule patterns) | Permission posture |
| `permissions.deny` | Yes | As-is | Security posture |
| `env` | Keys only | Strip all values | Which integrations wired |
| `model` | Yes | As-is | Model preference |
| `hooks` | Event types + hook count per event | Drop commands/urls/headers/args | Automation sophistication |
| `enabledPlugins` | Yes | Plugin names + boolean | Ecosystem adoption |
| `effortLevel` | Yes | As-is | Usage pattern |
| `permissionMode` | Yes | As-is | Trust posture |
| `apiKeyHelper` | Presence only | `true`/`false` | Auth method |
| `awsCredentialExport` | Presence only | `true`/`false` | Auth method |
| `gcpAuthRefresh` | Presence only | `true`/`false` | Auth method |
| `autoMemoryEnabled` | Yes | As-is | Feature adoption |
| `availableModels` | Yes | As-is | Model restrictions |
| `theme` | Skip | — | Low value |
| `editorMode` | Skip | — | Low value |

### 2. MCP Servers

**Sources by scope:**

| Scope | Path | Shared? |
|-------|------|---------|
| Per-project (local state) | `$CLAUDE_HOME/.claude.json` → `projects.<cwd>.mcpServers` | No |
| Project (shared) | `<repo>/.mcp.json` | Yes (committed) |

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| Server names | Yes | As-is | What tools connected |
| `type` (http/sse/stdio) | Yes | As-is | Transport choice |
| `timeout` | Yes | As-is | Config sophistication |
| `alwaysLoad` | Yes | As-is | Eager vs deferred |
| `url` | No | Drop | May expose internal endpoints |
| `command` | No | Drop | Reveals infra paths |
| `args` | No | Drop | Often contains secrets/paths |
| `env` | No | Drop entirely | API keys |
| `headers` | No | Drop | Auth tokens |
| `headersHelper` | No | Drop | Secret-generating scripts |
| `oauth` | No | Drop | Client IDs, auth URLs |

**Stored shape:**
```json
{
  "servers": {
    "atlassian": { "type": "sse", "timeout": null, "alwaysLoad": false },
    "postgres": { "type": "stdio", "timeout": 600000, "alwaysLoad": true }
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

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| Filenames / count | Yes | As-is | Number of custom agents |
| Frontmatter `name` | Yes | As-is | Agent catalog |
| Frontmatter `description` | Yes | As-is | Purpose |
| Frontmatter `model` | Yes | As-is | Per-agent model preference |
| Frontmatter `tools` / `disallowedTools` | Yes | As-is | Tool scoping |
| Frontmatter `effort` | Yes | As-is | Budget allocation |
| Frontmatter `isolation` | Yes | As-is | Worktree usage |
| Frontmatter `hooks` | No | Drop | May contain secrets |
| Body content | No | Hash + line count | Proprietary instructions |

**Stored shape:**
```json
{
  "agents": [
    {
      "name": "code-reviewer",
      "description": "Review PRs for correctness",
      "model": "sonnet",
      "tools": ["Read", "Bash"],
      "effort": "high",
      "isolation": null,
      "bodyHash": "a1b2c3...",
      "bodyLines": 42
    }
  ],
  "count": 1
}
```

### 4. Skills / Commands

**Sources by scope:**

| Scope | Path |
|-------|------|
| User (global) | `$CLAUDE_HOME/skills/*/SKILL.md` |
| Project | `<repo>/.claude/skills/*/SKILL.md` |
| Legacy commands | `<repo>/.claude/commands/*.md` |

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| Filenames / count | Yes | As-is | Customization depth |
| Frontmatter `name` | Yes | As-is | Skill catalog |
| Frontmatter `description` | Yes | As-is | Purpose |
| Frontmatter `invocation` | Yes | As-is | manual/auto/both |
| Frontmatter `allowedTools` / `disallowedTools` | Yes | As-is | Scoping |
| Body content | No | Hash + line count | Proprietary |

**Stored shape:**
```json
{
  "skills": [
    {
      "name": "deploy",
      "description": "Deploy to staging",
      "invocation": "manual",
      "allowedTools": ["Bash"],
      "bodyHash": "d4e5f6...",
      "bodyLines": 18
    }
  ],
  "legacyCommands": ["review.md", "fix.md"],
  "count": 3
}
```

### 5. Workflows

**Sources by scope:**

| Scope | Path |
|-------|------|
| User (global) | `$CLAUDE_HOME/workflows/*.js` |
| Project | `<repo>/.claude/workflows/*.js` |

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| Filenames / count | Yes | As-is | Orchestration adoption |
| `meta.name` (parsed from export) | Yes | As-is | Workflow catalog |
| `meta.description` | Yes | As-is | Purpose |
| `meta.phases` | Yes | As-is | Complexity |
| Script body | No | Hash + line count | Proprietary |

**Stored shape:**
```json
{
  "workflows": [
    {
      "name": "review-changes",
      "description": "Review changed files across dimensions",
      "phases": ["Review", "Verify"],
      "bodyHash": "g7h8i9...",
      "bodyLines": 55
    }
  ],
  "count": 1
}
```

### 6. CLAUDE.md / Rules

**Sources by scope:**

| Scope | Path |
|-------|------|
| User | `$CLAUDE_HOME/CLAUDE.md` |
| Project (shared) | `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md` |
| Project (local) | `<repo>/CLAUDE.local.md` |
| Rules | `<repo>/.claude/rules/*.md` |

**Fields captured vs redacted:**

| Field | Capture | Redaction | Signal |
|-------|---------|-----------|--------|
| Existence (boolean) | Yes | As-is | Adoption signal |
| Line count / byte size | Yes | As-is | Instruction depth |
| Content hash | Yes | sha256 | Change detection |
| Body content | No | — | Proprietary |
| Rules: file count | Yes | As-is | Conditional instruction usage |
| Rules: `paths` globs | Yes | As-is | Which areas have rules |

**Stored shape:**
```json
{
  "claudeMd": {
    "exists": true,
    "lines": 87,
    "bytes": 3421,
    "hash": "j0k1l2..."
  },
  "claudeLocalMd": {
    "exists": false
  },
  "rules": [
    { "file": "testing.md", "paths": ["src/**/*.test.ts"], "lines": 12 }
  ],
  "rulesCount": 1
}
```

### 7. Plugins (from settings)

Captured from `settings.json` → `enabledPlugins`:

```json
{
  "plugins": {
    "frontend-design@claude-plugins-official": true
  },
  "count": 1
}
```

---

## Scope summary

Each category has a **global** component (user-level, same across all repos) and a
**project** component (varies per repo). The snapshot must distinguish these:

| Category | Global scope | Project scope |
|----------|-------------|---------------|
| Settings | `$CLAUDE_HOME/settings.json` | `<repo>/.claude/settings.json` + `settings.local.json` |
| MCP | `$CLAUDE_HOME/.claude.json` → per-project | `<repo>/.mcp.json` |
| Agents | `$CLAUDE_HOME/agents/` | `<repo>/.claude/agents/` |
| Skills | `$CLAUDE_HOME/skills/` | `<repo>/.claude/skills/` + `commands/` |
| Workflows | `$CLAUDE_HOME/workflows/` | `<repo>/.claude/workflows/` |
| CLAUDE.md | `$CLAUDE_HOME/CLAUDE.md` | `<repo>/CLAUDE.md` + `.local.md` + rules |
| Plugins | `settings.json` → `enabledPlugins` | — |

---

## Mechanism

_TBD — to be designed after scope discussion._

Options under consideration:
- **A.** Processor (per-session, cache-aware)
- **B.** Standalone pipeline step in `analyze` (per-unique-cwd + once-global)
- **C.** Hybrid (processor with cross-session dedup)

Key considerations:
- Config is ambient state, not session-derived — cache key mismatch with processors.
- Global config should be snapshotted once per run, not per session.
- Project config should be snapshotted once per unique cwd, not per session in that cwd.
- Need a content-hash-based versioning: only write a new row when config actually changed.

---

## Future harness support

This design starts with Claude Code. Each harness will need its own reader:
- **Codex**: TBD — likely `codex.json` or similar.
- **OpenCode**: TBD — `opencode.json` config.
- **Pi**: TBD — investigate config surface.
- **Cursor**: `.cursor/` directory, `.mcp.json`, rules, etc.

The storage/mechanism should be harness-agnostic; only the reader logic is per-harness.

---

## Security principles

1. **Never capture values of environment variables** — keys only.
2. **Never capture hook/MCP command strings, args, or URLs** — may contain tokens or internal infra.
3. **Never capture auth-related content** — `credentials.json`, `apiKeyHelper` output, OAuth tokens.
4. **Never capture instruction body text** — may contain proprietary business logic. Hash + size only.
5. **Capture structural metadata only** — names, counts, types, patterns, presence flags.
6. **Redact by default, allowlist what's safe** — not the reverse.
