import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
  const scope = projectPath === undefined ? 'global' : 'project'
  // Scan the repo tree once and share it across readers: `.claude/` dirs feed
  // settings/agents/skills; CLAUDE.md files feed instructions.
  const scan: ProjectScan | undefined = projectPath === undefined ? undefined : await scanProject(projectPath)
  const out: EnvCategorySnapshot[] = []
  for (const read of [readSettings, readMcp, readAgents, readSkills, readInstructions]) {
    const cat = await read(scope, projectPath, scan)
    if (cat) out.push(cat)
  }
  return out
}

/** Repo-tree scan results, computed once per project (scanProject) and shared across readers. */
export interface ProjectScan {
  /** Every `.claude/` dir under the repo (repo-relative). */
  claudeDirs: string[]
  /** Every CLAUDE.md / CLAUDE.local.md under the repo (repo-relative). */
  instructionFiles: string[]
}

// ---- shared helpers --------------------------------------------------------

/** Claude Code's config home: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/**
 * Path to `.claude.json` (the MCP + project-state file). Its default sits at HOME
 * (`~/.claude.json`) — a SIBLING of `~/.claude/`, not inside it — so it does NOT
 * follow claudeHome()'s `.claude` default. It DOES follow `$CLAUDE_CONFIG_DIR` when
 * set (a custom config dir holds its own `.claude.json`). So: config dir if set,
 * else HOME — never `~/.claude/.claude.json`.
 */
export function claudeJsonPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json')
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
 * Read + parse a JSON file, cached by path + mtime. Used for JSON files read more than
 * once within a run — `.claude.json` and `installed_plugins.json`. The mtime key means
 * a config edit between analyze runs re-reads, and tests using distinct temp paths never
 * collide — no stale reads.
 */
const claudeJsonCache = new Map<string, { mtimeMs: number; parsed: unknown | null }>()
async function readClaudeJson(path: string): Promise<Record<string, unknown> | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    return null // missing file
  }
  const hit = claudeJsonCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed as Record<string, unknown> | null
  const parsed = await readJsonIfExists(path)
  claudeJsonCache.set(path, { mtimeMs, parsed })
  return parsed as Record<string, unknown> | null
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
 * `settings.json` + `settings.local.json` in EVERY `.claude/` dir under the repo
 * (root + nested monorepo packages — see findClaudeDirs), keyed by repo-relative
 * path so per-package config stays distinct.
 * A file whose entire content is dropped by the allowlist (only env/hooks) is
 * omitted; the category is null when no file yields any allowlisted field.
 */
async function readSettings(scope: 'global' | 'project', projectPath?: string, scan?: ProjectScan): Promise<EnvCategorySnapshot | null> {
  // Each entry: `key` is the payload key (repo-relative path), `path` the file on disk.
  const files: Array<{ key: string; path: string }> = []
  if (scope === 'global') {
    files.push({ key: 'settings.json', path: join(claudeHome(), 'settings.json') })
  } else {
    for (const rel of scan!.claudeDirs) {
      files.push({ key: `${rel}/settings.json`, path: join(projectPath!, rel, 'settings.json') })
      files.push({ key: `${rel}/settings.local.json`, path: join(projectPath!, rel, 'settings.local.json') })
    }
  }
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
 *   - user  (all projects) → `.claude.json` top-level `mcpServers` (see claudeJsonPath)
 *   - local (per-project)  → `.claude.json` `projects["<cwd>"].mcpServers`
 *   - project (shared)     → `<repo>/.mcp.json` top-level `mcpServers`
 * We map user→global scope, and (project .mcp.json + local .claude.json) →project
 * scope. Local entries are keyed by EXACT cwd, so we union every `projects` entry
 * whose path is under the repo root (repo-root union; loses per-subdir precision).
 */
async function readMcp(scope: 'global' | 'project', projectPath?: string, _scan?: ProjectScan): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}
  const claudeJson = await readClaudeJson(claudeJsonPath())

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
 * Global: `$CLAUDE_HOME/agents/`. Project: the `agents/` dir in EVERY `.claude/`
 * under the repo (root + nested packages — see findClaudeDirs); each entry carries a
 * repo-relative `dir` so same-named agents in different packages stay distinct. Within
 * one `agents/` dir CC scans recursively, so we do too. Null when no agent files exist.
 */
async function readAgents(scope: 'global' | 'project', projectPath?: string, scan?: ProjectScan): Promise<EnvCategorySnapshot | null> {
  // Base dirs to scan for an `agents/` subdir, paired with the repo-relative `dir`
  // label to stamp on each entry (undefined for global — no per-repo location).
  const bases =
    scope === 'global'
      ? [{ base: claudeHome(), dir: undefined as string | undefined }]
      : scan!.claudeDirs.map((rel) => ({ base: join(projectPath!, rel), dir: `${rel}/agents` }))

  const agents: Array<Record<string, unknown>> = []
  for (const { base, dir } of bases) {
    for (const path of (await walkFiles(join(base, 'agents'), '.md')).sort()) {
      const entry = await readAgentFile(path)
      if (entry) agents.push(dir ? { ...entry, dir } : entry)
    }
  }

  // Enabled plugins' agents, tagged source:plugin:<id> (a plugin's `agents` manifest
  // path may be a dir OR an individual .md file, so collect from both).
  for (const plugin of await enabledPluginDirs(scope, projectPath)) {
    for (const path of (await collectMdFiles(plugin.agentDirs)).sort()) {
      const entry = await readAgentFile(path)
      if (entry) agents.push({ ...entry, source: `plugin:${plugin.id}` })
    }
  }
  return agents.length > 0 ? { category: 'agents', payload: { agents, count: agents.length } } : null
}

/** Collect `.md` files from a list of paths, each of which may be a dir (walked) or a file. */
async function collectMdFiles(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if (p.endsWith('.md')) out.push(p) // an explicit file path from a manifest override
    else out.push(...(await walkFiles(p, '.md')))
  }
  return out
}

/** Parse one agent .md into its allowlisted { name, description?, model?, tools?, body, bodyHash } entry. */
async function readAgentFile(path: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
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
  return entry
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
 * Global: `$CLAUDE_HOME/{skills,commands}`. Project: `{skills,commands}` in EVERY
 * `.claude/` under the repo (root + nested packages); each entry carries a repo-
 * relative `dir` so same-named skills in different packages stay distinct.
 * Null when no source has files.
 */
async function readSkills(scope: 'global' | 'project', projectPath?: string, scan?: ProjectScan): Promise<EnvCategorySnapshot | null> {
  // Base `.claude` dirs to scan, paired with the repo-relative label to stamp
  // (undefined for global — no per-repo location).
  const bases =
    scope === 'global'
      ? [{ base: claudeHome(), rel: undefined as string | undefined }]
      : scan!.claudeDirs.map((rel) => ({ base: join(projectPath!, rel), rel }))

  const skills: Array<Record<string, unknown>> = []
  const withDir = (entry: Record<string, unknown>, dir: string | undefined) => (dir ? { ...entry, dir } : entry)

  for (const { base, rel } of bases) {
    // Directory skills: exactly `skills/<dir>/SKILL.md` — a skill's SKILL.md sits one
    // level deep. Immediate child dirs only (NOT recursive): a SKILL.md nested deeper
    // (e.g. a skill's own `examples/SKILL.md` supporting file) is not a skill.
    for (const dir of (await listDirs(join(base, 'skills'))).sort()) {
      const entry = await readSkillFile(join(base, 'skills', dir, 'SKILL.md'), dir)
      if (entry) skills.push(withDir(entry, rel && `${rel}/skills`))
    }
    // Legacy commands: commands/<file>.md — name is the filename.
    for (const path of (await walkFiles(join(base, 'commands'), '.md')).sort()) {
      const entry = await readSkillFile(path, basename(path, '.md'))
      if (entry) skills.push(withDir(entry, rel && `${rel}/commands`))
    }
  }

  // Enabled plugins' skills + commands, tagged source:plugin:<id>.
  for (const plugin of await enabledPluginDirs(scope, projectPath)) {
    const tag = (entry: Record<string, unknown>) => ({ ...entry, source: `plugin:${plugin.id}` })
    // skillDirs: each holds `<name>/SKILL.md` (depth-1, same as project skills).
    for (const skillsDir of plugin.skillDirs) {
      for (const dir of (await listDirs(skillsDir)).sort()) {
        const entry = await readSkillFile(join(skillsDir, dir, 'SKILL.md'), dir)
        if (entry) skills.push(tag(entry))
      }
    }
    // skillRoots: the location's own SKILL.md is one skill (single-skill plugin or a
    // manifest path like "./"). Frontmatter `name` wins here, dir basename fallback.
    for (const skillRoot of plugin.skillRoots) {
      const entry = await readSkillFile(join(skillRoot, 'SKILL.md'), basename(skillRoot), true)
      if (entry) skills.push(tag(entry))
    }
    // commandDirs: flat `.md` files (dir walked, or an explicit file from a manifest override).
    for (const path of (await collectMdFiles(plugin.commandDirs)).sort()) {
      const entry = await readSkillFile(path, basename(path, '.md'))
      if (entry) skills.push(tag(entry))
    }
  }

  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

/** True when a file or directory exists at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Immediate child directory names of `dir` (non-recursive); [] if `dir` is missing. */
async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Directory names we never descend into when scanning a repo for config. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', 'target'])

/** Filenames collected as `instructions` by scanProject. */
const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md'])

/**
 * One walk of the repo tree collecting everything the category readers need:
 *   - every `.claude/` dir, as repo-relative paths (the root's own is `.claude`) —
 *     CC reads config from nested `.claude/` dirs in monorepo sub-packages, not just
 *     the root, and the readers key each config file by where it lives.
 *   - every `CLAUDE.md` / `CLAUDE.local.md`, repo-relative — unlike settings these
 *     can live directly in any directory (`packages/frontend/CLAUDE.md`) with no
 *     `.claude/` beside them, so they're found by filename. A `.claude/CLAUDE.md`
 *     is valid too, so the walk descends into `.claude/` dirs — but only for
 *     instruction files (a `.claude` subtree isn't more `.claude` dirs).
 *
 * Bounded by a skip-list (node_modules/.git/dist/build/vendor/venv/target) plus all
 * other dot-directories — vendored/build trees can ship their own `.claude/` that is
 * not the user's config. No depth cap: pruning those trees keeps the walk cheap.
 * Returns empty lists when repoRoot is missing or has no config anywhere.
 */
export async function scanProject(repoRoot: string): Promise<ProjectScan> {
  const claudeDirs: string[] = []
  const instructionFiles: string[] = []
  const walk = async (dir: string, rel: string, insideClaude: boolean): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isFile()) {
        if (INSTRUCTION_FILES.has(e.name)) instructionFiles.push(childRel)
        continue
      }
      if (!e.isDirectory()) continue
      if (e.name === '.claude') {
        if (!insideClaude) claudeDirs.push(childRel)
        await walk(join(dir, e.name), childRel, true)
        continue
      }
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await walk(join(dir, e.name), childRel, insideClaude)
    }
  }
  await walk(repoRoot, '', false)
  return { claudeDirs: claudeDirs.sort(), instructionFiles: instructionFiles.sort() }
}

/** A resolved plugin's contributed config locations (absolute paths). */
export interface PluginDirs {
  id: string
  /** Dirs to scan for `<name>/SKILL.md`. */
  skillDirs: string[]
  /**
   * Dirs whose OWN `SKILL.md` is a single skill: a manifest `skills` path that
   * contains SKILL.md directly (e.g. `"./"`), or the plugin root of a single-skill
   * plugin (root SKILL.md, no `skills/` dir, no manifest field — auto-loaded per
   * docs since CC v2.1.142). Naming there is frontmatter-`name`-first.
   */
  skillRoots: string[]
  /** Dirs to scan for flat `.md` commands, and individual command files. */
  commandDirs: string[]
  /** Dirs to scan for agent `*.md`, and individual agent files. */
  agentDirs: string[]
}

/**
 * Resolve the on-disk skill/agent/command locations for each enabled plugin at a
 * given scope. `$CLAUDE_HOME/plugins/installed_plugins.json` maps each plugin id to
 * its install entries (scope + installPath); a missing or unreadable file yields [].
 * Maps each enabled id to its install entry whose `scope` matches, then resolves dirs
 * from `.claude-plugin/plugin.json`:
 *   - `skills`   (string|array) ADDS to the default `skills/` dir. A listed path that
 *     contains `SKILL.md` DIRECTLY (e.g. `"./"`) is itself one skill → skillRoots.
 *   - `commands` (string|array) REPLACES the default `commands/` dir.
 *   - `agents`   (string|array) REPLACES the default `agents/` dir.
 * Paths in the manifest are relative to the plugin root. Absent field → default dir.
 * Single-skill auto-load (docs, CC v2.1.142+): a root `SKILL.md` with no `skills/`
 * dir and no manifest `skills` field loads the plugin root itself as one skill.
 */
export async function resolvePluginDirs(enabledIds: string[], scope: 'user' | 'project' | 'local'): Promise<PluginDirs[]> {
  if (enabledIds.length === 0) return []
  // Cached read: this file is read several times per repo in a run (skills + agents,
  // each across project/local scopes), so the path+mtime cache parses it once.
  const installed = (await readClaudeJson(join(claudeHome(), 'plugins', 'installed_plugins.json'))) as
    | { plugins?: Record<string, Array<{ scope?: string; installPath?: string }>> }
    | null
  const registry = installed?.plugins
  if (!registry || typeof registry !== 'object') return []

  const out: PluginDirs[] = []
  for (const id of enabledIds) {
    const entry = (registry[id] ?? []).find((e) => e.scope === scope && typeof e.installPath === 'string')
    if (!entry?.installPath) continue
    const root = entry.installPath
    const manifest = (await readJsonIfExists(join(root, '.claude-plugin', 'plugin.json'))) as Record<string, unknown> | null

    // `skills` adds to default skills/; `commands`/`agents` replace their defaults.
    const skillDirs = [join(root, 'skills')]
    const skillRoots: string[] = []
    for (const p of toPaths(manifest?.skills, root)) {
      // A manifest skill path whose SKILL.md sits directly in it IS one skill;
      // otherwise it's a dir of <name>/SKILL.md skills like the default.
      if (await pathExists(join(p, 'SKILL.md'))) skillRoots.push(p)
      else skillDirs.push(p)
    }
    if (manifest?.skills === undefined && !(await pathExists(join(root, 'skills'))) && (await pathExists(join(root, 'SKILL.md')))) {
      skillRoots.push(root) // single-skill plugin auto-load
    }
    const commandOverride = toPaths(manifest?.commands, root)
    const agentOverride = toPaths(manifest?.agents, root)
    out.push({
      id,
      skillDirs,
      skillRoots,
      commandDirs: commandOverride.length > 0 ? commandOverride : [join(root, 'commands')],
      agentDirs: agentOverride.length > 0 ? agentOverride : [join(root, 'agents')],
    })
  }
  return out
}

/** Normalize a manifest path field (string | string[]) to absolute paths under `root`. */
function toPaths(field: unknown, root: string): string[] {
  const list = typeof field === 'string' ? [field] : Array.isArray(field) ? field.filter((x) => typeof x === 'string') : []
  // join collapses `./` and (unlike a trailing-slash literal) normalizes the result,
  // but a trailing slash on the manifest value survives — strip it for a clean path.
  return (list as string[]).map((p) => join(root, p).replace(/\/+$/, ''))
}

/**
 * Enabled plugins' resolved dirs for a snapshot scope. Reads `enabledPlugins` from
 * the settings files at that scope, keeping ids whose value is `true`, and resolves
 * each against its MATCHING install scope (a plugin's install scope in
 * installed_plugins.json must equal the settings file it was enabled from, else its
 * install entry won't be found):
 *   - global snapshot  ← `$CLAUDE_HOME/settings.json`        → `user` installs
 *   - project snapshot ← `<repo>/.claude/settings.json`      → `project` installs
 *                      + `<repo>/.claude/settings.local.json` → `local`   installs
 * Both project files feed the project snapshot. Deduped per (id, install) — the same
 * plugin id resolved to the SAME install path (e.g. enabled in both files pointing at
 * one install) appears once; a plugin installed at two distinct paths (project + local)
 * is kept as two entries, since those are genuinely different installs.
 */
async function enabledPluginDirs(scope: 'global' | 'project', projectPath?: string): Promise<PluginDirs[]> {
  const idsFrom = async (path: string): Promise<string[]> => {
    const raw = (await readJsonIfExists(path)) as Record<string, unknown> | null
    const ep = raw?.enabledPlugins
    if (!ep || typeof ep !== 'object') return []
    return Object.entries(ep as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([id]) => id)
  }
  if (scope === 'global') {
    return resolvePluginDirs(await idsFrom(join(claudeHome(), 'settings.json')), 'user')
  }
  const project = await resolvePluginDirs(await idsFrom(join(projectPath!, '.claude', 'settings.json')), 'project')
  const local = await resolvePluginDirs(await idsFrom(join(projectPath!, '.claude', 'settings.local.json')), 'local')
  // Dedup per (id, install) — skillDirs[0] is always `<installPath>/skills`, so the key
  // is effectively id+installPath. Same plugin at the SAME install (enabled in both
  // files) → one entry; the same plugin at two DISTINCT installs (project + local) →
  // kept as two, since they're genuinely different installs.
  const seen = new Set<string>()
  return [...project, ...local].filter((p) => {
    const key = `${p.id} ${p.skillDirs[0] ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Read one skill/command file into a { name, description?, body, bodyHash } entry.
 * `name` is the INVOKABLE identity (directory name for a SKILL.md, filename for a
 * command) — NOT the frontmatter `name`, which is display-only and per docs defaults
 * to the directory name anyway. Using the invokable name keeps it aligned with the
 * `/name` an adoption fix would reference.
 *
 * EXCEPTION — `preferFrontmatterName`: for a single-skill location (a skillRoot,
 * where SKILL.md sits directly in the dir), docs invert the precedence: frontmatter
 * `name` determines the invocation name (stable regardless of the install dir), and
 * the passed `name` (dir basename) is only the fallback.
 */
async function readSkillFile(path: string, name: string, preferFrontmatterName = false): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  const fm = parseFrontmatter(frontmatter)
  const resolvedName = preferFrontmatterName && typeof fm.name === 'string' ? fm.name : name
  const entry: Record<string, unknown> = { name: resolvedName, body, bodyHash: contentHash(body) }
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
 *   - project: every `CLAUDE.md` / `CLAUDE.local.md` under the repo — at the root,
 *              in nested monorepo packages (`packages/x/CLAUDE.md`), and inside any
 *              `.claude/` (`<dir>/.claude/CLAUDE.md`). Unlike settings these can sit
 *              directly in a dir with no `.claude/`, so scanProject finds them by
 *              filename rather than via `.claude/` dirs. Keyed by repo-relative path.
 * Empty files are omitted (an empty CLAUDE.md carries no instruction signal).
 * Null when no non-empty instructions file exists in the scope.
 */
async function readInstructions(scope: 'global' | 'project', projectPath?: string, scan?: ProjectScan): Promise<EnvCategorySnapshot | null> {
  const files: Array<{ key: string; path: string }> =
    scope === 'global'
      ? [{ key: 'CLAUDE.md', path: join(claudeHome(), 'CLAUDE.md') }]
      : scan!.instructionFiles.map((rel) => ({ key: rel, path: join(projectPath!, rel) }))
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
