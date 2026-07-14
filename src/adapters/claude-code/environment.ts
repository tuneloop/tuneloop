import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '../../core/hash'
import { walkFiles } from '../../util/walk'
import type { EnvCategorySnapshot } from '../../store/types'

/**
 * Claude Code config reader (environment reader, Part 2). Produces the redacted,
 * allowlisted per-category snapshots that analyze stores as a config timeline.
 *
 * Called once for global scope (`projectPath` undefined → read `$CLAUDE_HOME`) and
 * once per project repo root (→ read `<repo>/.claude`, `<repo>/.mcp.json`, etc.).
 * Only allowlisted, secret-free fields are ever returned — see the per-category
 * readers. A category that finds nothing simply omits its entry.
 */
export async function readClaudeCodeEnvironment(projectPath?: string): Promise<EnvCategorySnapshot[]> {
  const out: EnvCategorySnapshot[] = []
  const push = (cat: EnvCategorySnapshot | null) => {
    if (cat) out.push(cat)
  }
  if (projectPath === undefined) {
    // Global scope: $CLAUDE_HOME.
    push(await readSettings('global'))
    push(await readMcp('global'))
    push(await readAgents('global'))
    push(await readSkills('global'))
    push(await readInstructions('global'))
  } else {
    // Project scope: the repo root.
    push(await readSettings('project', projectPath))
    push(await readMcp('project', projectPath))
    push(await readAgents('project', projectPath))
    push(await readSkills('project', projectPath))
    push(await readInstructions('project', projectPath))
  }
  return out
}

// ---- shared helpers --------------------------------------------------------

/** Claude Code's config home: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Read + parse a JSON file; null if it's missing or unparseable (never throws). */
async function readJsonIfExists(path: string): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Split a markdown file into its YAML frontmatter block and body. A file that does
 * not open with a `---` fence has no frontmatter (all body). Returns the raw
 * frontmatter text (unparsed) and the body after the closing fence.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) return { frontmatter: '', body: text }
  // Opening --- line, the (possibly empty) block, then a closing --- line. The
  // newline before the closing --- is optional so an empty block (`---\n---`) matches.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/)
  if (!m) return { frontmatter: '', body: text }
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' }
}

/**
 * Minimal YAML-frontmatter parser for the handful of fields we allowlist. No YAML
 * dependency: handles top-level `key: value` scalars, inline lists (`key: [a, b]`),
 * and block lists (`key:` followed by `  - item` lines). Values are returned as
 * strings or string[]; anything more exotic is ignored. Not a general YAML parser —
 * intentionally strict and small, since we only read known scalar/list fields.
 */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim() || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue // not a top-level key line (e.g. a nested "  - item" handled below)
    const key = m[1]!
    const rest = (m[2] ?? '').trim()
    if (rest === '') {
      // Possibly a block list: collect following "  - item" lines.
      const items: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const item = lines[j]!.match(/^\s+-\s*(.*)$/)
        if (!item) break
        items.push(stripQuotes(item[1]!.trim()))
      }
      if (items.length > 0) {
        out[key] = items
        i = j - 1
      }
      continue
    }
    out[key] = stripQuotes(rest)
  }
  return out
}

/** Strip a single layer of matching single/double quotes from a scalar. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Normalize a frontmatter value into a string list, accepting the forms CC allows
 * for `tools`/`disallowedTools`: a YAML block/inline list (already a string[]), an
 * inline `[a, b]`, or a comma/space-separated string (`Read, Grep Glob`). Null when
 * absent or empty.
 */
export function toStringList(v: string | string[] | undefined): string[] | null {
  if (Array.isArray(v)) return v.length > 0 ? v : null
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1) // inline list
  const parts = s
    .split(/[,\s]+/)
    .map((p) => stripQuotes(p.trim()))
    .filter(Boolean)
  return parts.length > 0 ? parts : null
}

// ---- per-category readers (stubbed in 2.1; filled in 2.2–2.6) --------------

/**
 * `settings` — allowlisted config from each settings file present, keyed by
 * filename so the source (shared vs gitignored-local) stays explicit and conflicts
 * are visible rather than merged away. Only `permissions.allow/deny/ask` and
 * `enabledPlugins` are extracted — env, hooks, auth plumbing, and preferences are never read.
 * Global scope reads `$CLAUDE_HOME/settings.json`. Project scope reads
 * `<repo>/.claude/settings.json` and `settings.local.json`.
 * A file whose entire content is dropped by the allowlist (only env/hooks) is
 * omitted; the category is null when no file yields any allowlisted field.
 */
async function readSettings(scope: 'global' | 'project', projectPath?: string): Promise<EnvCategorySnapshot | null> {
  const files =
    scope === 'global'
      ? [{ key: 'settings.json', path: join(claudeHome(), 'settings.json') }]
      : [
          { key: 'settings.json', path: join(projectPath!, '.claude', 'settings.json') },
          { key: 'settings.local.json', path: join(projectPath!, '.claude', 'settings.local.json') },
        ]
  const payload: Record<string, unknown> = {}
  for (const f of files) {
    const raw = await readJsonIfExists(f.path)
    if (!raw || typeof raw !== 'object') continue
    const kept = allowlistSettings(raw as Record<string, unknown>)
    // Omit a file whose entire content was dropped by the allowlist (e.g. a settings
    // file that is only env + hooks): `{}` carries no signal, mirroring empty instructions.
    if (Object.keys(kept).length > 0) payload[f.key] = kept
  }
  return Object.keys(payload).length > 0 ? { category: 'settings', payload } : null
}

/** Pull only the allowlisted fields from a parsed settings object. */
function allowlistSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const perms = raw.permissions
  if (perms && typeof perms === 'object') {
    const p = perms as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    if (Array.isArray(p.allow)) kept.allow = p.allow
    if (Array.isArray(p.deny)) kept.deny = p.deny
    if (Array.isArray(p.ask)) kept.ask = p.ask
    if (Object.keys(kept).length > 0) out.permissions = kept
  }
  if (raw.enabledPlugins && typeof raw.enabledPlugins === 'object') out.plugins = raw.enabledPlugins
  return out
}

/**
 * `mcp` — MCP servers, keyed by source file (like `settings`, so shared-vs-local
 * origin and name collisions stay visible). Only name, type, url are kept; command,
 * args, env, headers, headersHelper, oauth, timeout, alwaysLoad are dropped as
 * secret-bearing or signal-free.
 *
 * CC stores MCP at three scopes (docs: https://code.claude.com/docs/en/mcp-configuration.md):
 *   - user  (all projects) → `$CLAUDE_HOME/.claude.json` top-level `mcpServers`
 *   - local (per-project)  → `$CLAUDE_HOME/.claude.json` `projects["<cwd>"].mcpServers`
 *   - project (shared)     → `<repo>/.mcp.json` top-level `mcpServers`
 * We map user→global scope, and (project .mcp.json + local .claude.json) →project
 * scope. Local entries are keyed by EXACT cwd, so we union every `projects` entry
 * whose path is under the repo root (repo-root union; loses per-subdir precision).
 */
async function readMcp(scope: 'global' | 'project', projectPath?: string): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}
  const claudeJson = (await readJsonIfExists(join(claudeHome(), '.claude.json'))) as Record<string, unknown> | null

  if (scope === 'global') {
    // User scope: top-level mcpServers in .claude.json.
    const servers = redactMcpServers(claudeJson?.mcpServers)
    if (servers) payload['.claude.json'] = { servers }
  } else {
    // Project scope: shared .mcp.json + local .claude.json entries under this repo.
    const mcpJson = (await readJsonIfExists(join(projectPath!, '.mcp.json'))) as Record<string, unknown> | null
    const shared = redactMcpServers(mcpJson?.mcpServers)
    if (shared) payload['.mcp.json'] = { servers: shared }

    const projects = claudeJson?.projects
    if (projects && typeof projects === 'object') {
      const union: Record<string, unknown> = {}
      for (const [path, entry] of Object.entries(projects as Record<string, unknown>)) {
        if (!isUnder(path, projectPath!)) continue
        const servers = redactMcpServers((entry as Record<string, unknown>)?.mcpServers)
        if (servers) Object.assign(union, servers)
      }
      if (Object.keys(union).length > 0) payload['.claude.json'] = { servers: union }
    }
  }
  return Object.keys(payload).length > 0 ? { category: 'mcp', payload } : null
}

/** True when `path` is the repo root or a descendant of it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
}

/** Keep only name→{type,url} for each server; drop everything secret-bearing. Null if none. */
function redactMcpServers(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue
    const d = def as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    // Docs: an entry with no `type` but a `command` is a stdio server. Normalize so
    // a type-less stdio entry reads as {type:'stdio'} rather than an empty object.
    if (typeof d.type === 'string') kept.type = d.type
    else if (typeof d.command === 'string') kept.type = 'stdio'
    if (typeof d.url === 'string') kept.url = d.url
    out[name] = kept
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * `agents` — custom sub-agent definitions from `agents/*.md`. Per file: allowlisted
 * frontmatter (name, description, model, tools, disallowedTools) plus the full body
 * (the system prompt IS the agent) and its hash. `hooks` and `color` are dropped —
 * `hooks` can carry secrets, `color` is UI-only.
 *
 * Fields verified against docs: https://code.claude.com/docs/en/sub-agents.md
 * (only `name`+`description` are required; `model` defaults to `inherit`; `tools`/
 * `disallowedTools` accept a comma/space string OR a YAML list).
 *
 * Global: `$CLAUDE_HOME/agents/`. Project: `<repo>/.claude/agents/`. Recurses
 * subdirectories (CC scans `agents/` recursively). Null when no agent files exist.
 */
async function readAgents(scope: 'global' | 'project', projectPath?: string): Promise<EnvCategorySnapshot | null> {
  const dir = scope === 'global' ? join(claudeHome(), 'agents') : join(projectPath!, '.claude', 'agents')
  const files = await walkFiles(dir, '.md')
  const agents: Array<Record<string, unknown>> = []
  for (const path of files.sort()) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const { frontmatter, body } = splitFrontmatter(text)
    const fm = parseFrontmatter(frontmatter)
    const entry: Record<string, unknown> = {
      name: typeof fm.name === 'string' ? fm.name : basename(path, '.md'),
      body,
      bodyHash: contentHash(body),
    }
    if (typeof fm.description === 'string') entry.description = fm.description
    if (typeof fm.model === 'string') entry.model = fm.model
    const tools = toStringList(fm.tools)
    if (tools) entry.tools = tools
    const disallowed = toStringList(fm.disallowedTools)
    if (disallowed) entry.disallowedTools = disallowed
    agents.push(entry)
  }
  return agents.length > 0 ? { category: 'agents', payload: { agents, count: agents.length } } : null
}

/**
 * `skills` — custom skills and legacy commands, as ONE merged list (docs:
 * "custom commands have been merged into skills" — `.claude/commands/deploy.md`
 * and `.claude/skills/deploy/SKILL.md` both create `/deploy`). Per entry: name,
 * `description?`, full body + hash.
 *
 * Name derivation, verified against https://code.claude.com/docs/en/custom-skills.md:
 *   - `skills/<dir>/SKILL.md` → the DIRECTORY name (not "SKILL"); frontmatter `name`
 *     is display-only and defaults to the dir name, so the dir name is the identity
 *     (`/deploy-staging`).
 *   - `commands/<file>.md`    → the filename without extension (`/deploy`).
 * We capture both sources faithfully and do NOT resolve CC's skill-over-command
 * precedence — a consumer resolves it, matching the settings/mcp approach.
 *
 * Global: `$CLAUDE_HOME/{skills,commands}`. Project: `<repo>/.claude/{skills,commands}`.
 * Null when neither source has files.
 */
async function readSkills(scope: 'global' | 'project', projectPath?: string): Promise<EnvCategorySnapshot | null> {
  const base = scope === 'global' ? claudeHome() : join(projectPath!, '.claude')
  const skills: Array<Record<string, unknown>> = []

  // Directory skills: skills/<dir>/SKILL.md — name is the containing directory.
  const skillFiles = (await walkFiles(join(base, 'skills'), '.md')).filter((p) => basename(p) === 'SKILL.md')
  for (const path of skillFiles.sort()) {
    const entry = await readSkillFile(path, basename(dirname(path)))
    if (entry) skills.push(entry)
  }

  // Legacy commands: commands/<file>.md — name is the filename.
  const commandFiles = await walkFiles(join(base, 'commands'), '.md')
  for (const path of commandFiles.sort()) {
    const entry = await readSkillFile(path, basename(path, '.md'))
    if (entry) skills.push(entry)
  }

  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

/**
 * Read one skill/command file into a { name, description?, body, bodyHash } entry.
 * `name` is the INVOKABLE identity (directory name for a SKILL.md, filename for a
 * command) — NOT the frontmatter `name`, which is display-only and per docs defaults
 * to the directory name anyway. Using the invokable name keeps it aligned with the
 * `/name` an adoption fix would reference.
 */
async function readSkillFile(path: string, name: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  const fm = parseFrontmatter(frontmatter)
  const entry: Record<string, unknown> = { name, body, bodyHash: contentHash(body) }
  if (typeof fm.description === 'string') entry.description = fm.description
  return entry
}

/**
 * `instructions` — the project-instructions files (CC's CLAUDE.md family). Plain
 * markdown, no frontmatter; we store the full body + hash, keyed by the file's
 * relative path (consistent with settings/mcp). `@import` references are kept
 * as-is, unexpanded (resolving imports is deferred).
 *
 * Sources (docs: https://code.claude.com/docs/en/memory.md):
 *   - global : `$CLAUDE_HOME/CLAUDE.md`
 *   - project: `<repo>/CLAUDE.md` and/or `<repo>/.claude/CLAUDE.md` (both allowed),
 *              plus `<repo>/CLAUDE.local.md` (personal, gitignored)
 * Empty files are omitted (an empty CLAUDE.md carries no instruction signal).
 * Null when no non-empty instructions file exists in the scope.
 */
async function readInstructions(scope: 'global' | 'project', projectPath?: string): Promise<EnvCategorySnapshot | null> {
  const files =
    scope === 'global'
      ? [{ key: 'CLAUDE.md', path: join(claudeHome(), 'CLAUDE.md') }]
      : [
          { key: 'CLAUDE.md', path: join(projectPath!, 'CLAUDE.md') },
          { key: '.claude/CLAUDE.md', path: join(projectPath!, '.claude', 'CLAUDE.md') },
          { key: 'CLAUDE.local.md', path: join(projectPath!, 'CLAUDE.local.md') },
        ]
  const payload: Record<string, unknown> = {}
  for (const f of files) {
    let body: string
    try {
      body = await readFile(f.path, 'utf8')
    } catch {
      continue // absent → omit
    }
    if (body.trim() === '') continue // empty → omit (no instruction signal)
    payload[f.key] = { body, hash: contentHash(body) }
  }
  return Object.keys(payload).length > 0 ? { category: 'instructions', payload } : null
}
