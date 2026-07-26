import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { contentHash } from '../../core/hash'
import { walkFiles } from '../../util/walk'
import type { EnvCategorySnapshot } from '../../store/types'
import { isUnder, listDirs, readFrontmatterFile, readSkillFile, realpathOf, redactUrl } from '../env-shared'

/**
 * OpenCode config reader (environment reader, Part 3). Produces the redacted,
 * allowlisted per-category snapshots analyze stores as a config timeline — the
 * OpenCode counterpart to the Claude Code reader. See docs/plans/environment-reader.md.
 *
 * Called once for global scope (`projectPath` undefined → read the config home) and
 * once per project repo root. Each snapshot is an INDEPENDENT per-harness view — the
 * reader captures every location OpenCode honors, including its Claude-compatible
 * (`.claude/…`) and agent-compatible (`.agents/…`) fallbacks; there is no "skip" rule.
 * Only allowlisted, secret-free fields are ever returned.
 */
export async function readOpencodeEnvironment(projectPath?: string): Promise<EnvCategorySnapshot[]> {
  const ctx = buildCtx(projectPath)
  const config = await loadConfig(ctx)
  const out: EnvCategorySnapshot[] = []
  for (const read of [readSettings, readMcp, readAgents, readSkills, readInstructions]) {
    const cat = await read(ctx, config)
    if (cat) out.push(cat)
  }
  return out
}

// ---- config-home resolution ------------------------------------------------

/**
 * OpenCode's config home, distinct from the adapter's DATA root (~/.local/share/opencode).
 * `$OPENCODE_CONFIG_DIR` → else `$XDG_CONFIG_HOME/opencode` → else `~/.config/opencode`.
 */
export function opencodeConfigHome(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
  if (dir && dir.trim()) return dir
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.config')
  return join(base, 'opencode')
}

// ---- scope context ---------------------------------------------------------

/**
 * Where to read each category, per scope. `base` is the root that payload keys are
 * made relative to (repo root for project, config home for global). The
 * Claude-/agent-compatible dirs are folded into `skillDirs` and the instruction
 * fallbacks — OpenCode reads them, so this snapshot does too.
 */
interface Ctx {
  scope: 'global' | 'project'
  /** Directory holding `opencode.json[c]`. */
  configDir: string
  /** Explicit config file override ($OPENCODE_CONFIG), global scope only. */
  explicitConfigFile?: string
  /** Root for relative payload keys. */
  base: string
  home: string
  agentDirs: string[]
  commandDirs: string[]
  /** Each holds `<name>/SKILL.md`; searched and merged. */
  skillDirs: string[]
}

function buildCtx(projectPath?: string): Ctx {
  const home = homedir()
  if (projectPath === undefined) {
    const configDir = opencodeConfigHome()
    const explicit = process.env.OPENCODE_CONFIG?.trim()
    return {
      scope: 'global',
      configDir,
      base: configDir,
      home,
      explicitConfigFile: explicit || undefined,
      // Both plural and singular dir names — OpenCode has used each across versions;
      // scanning both is free (missing dirs yield []) and version-robust.
      agentDirs: [join(configDir, 'agents'), join(configDir, 'agent')],
      commandDirs: [join(configDir, 'commands'), join(configDir, 'command')],
      // Native then agent- then Claude-compat: realpath dedup keeps the FIRST occurrence,
      // so listing the likely-real locations first makes them win the surviving label
      // (users commonly symlink `.claude/skills` → `.agents/skills`).
      skillDirs: [join(configDir, 'skills'), join(home, '.agents', 'skills'), join(home, '.claude', 'skills')],
    }
  }
  return {
    scope: 'project',
    configDir: projectPath,
    base: projectPath,
    home,
    agentDirs: [join(projectPath, '.opencode', 'agents'), join(projectPath, '.opencode', 'agent')],
    commandDirs: [join(projectPath, '.opencode', 'commands'), join(projectPath, '.opencode', 'command')],
    skillDirs: [
      join(projectPath, '.opencode', 'skills'),
      join(projectPath, '.agents', 'skills'),
      join(projectPath, '.claude', 'skills'),
    ],
  }
}

// ---- shared helpers --------------------------------------------------------

/** Directory names we never descend into when scanning a repo. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', 'target'])

/** Read a text file; null if missing/unreadable (never throws). */
async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** A parsed config file plus the payload key (its filename). */
interface LoadedConfig {
  key: string
  config: Record<string, unknown>
}

/** Load `opencode.json` then `.jsonc` (or the explicit $OPENCODE_CONFIG file); null if none parse. */
async function loadConfig(ctx: Ctx): Promise<LoadedConfig | null> {
  const candidates = ctx.explicitConfigFile
    ? [ctx.explicitConfigFile]
    : [join(ctx.configDir, 'opencode.json'), join(ctx.configDir, 'opencode.jsonc')]
  for (const path of candidates) {
    const text = await readTextIfExists(path)
    if (text == null) continue
    const parsed = parseJsonc(text)
    if (parsed && typeof parsed === 'object') return { key: basename(path), config: parsed as Record<string, unknown> }
  }
  return null
}

/**
 * Parse JSON with Comments (OpenCode's `opencode.jsonc`): strip `//` line and
 * `/* *\/` block comments (respecting string literals) and tolerate trailing commas,
 * then `JSON.parse`. Null on unparseable input (never throws). Variable substitution
 * (`{env:…}`, `{file:…}`) is left literal — secrets are dropped downstream regardless.
 */
export function parseJsonc(text: string): unknown | null {
  try {
    return JSON.parse(stripJsonc(text))
  } catch {
    return null
  }
}

/** Remove comments (string-aware) and trailing commas from JSONC text. */
function stripJsonc(s: string): string {
  let out = ''
  let inStr = false
  let strCh = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    const n = s[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i++
      } else if (c === strCh) {
        inStr = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strCh = c
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i++ // skip the '*' ; loop's i++ skips the '/'
      continue
    }
    out += c
  }
  // Drop trailing commas (`,` before a closing `}`/`]`). Comments are already gone.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Payload key for a file: relative to the scope base, else to home, else absolute. */
function labelFile(ctx: Ctx, path: string): string {
  if (isUnder(path, ctx.base)) return relative(ctx.base, path)
  if (isUnder(path, ctx.home)) return relative(ctx.home, path)
  return path
}

/** Repo-/home-relative dir label stamped on file-sourced agent/skill entries. */
function labelDir(ctx: Ctx, dir: string): string {
  if (isUnder(dir, ctx.base)) return relative(ctx.base, dir) || '.'
  if (isUnder(dir, ctx.home)) return relative(ctx.home, dir)
  return dir
}

/** All files under `root`, pruning heavy/dot dirs. Missing root → []. */
async function walkAllFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(p)
      } else if (e.isFile()) {
        out.push(p)
      }
    }
  }
  await walk(root)
  return out
}

// ---- per-category readers --------------------------------------------------

/**
 * `settings` — `permission` (tool-approval posture) + `plugin` (npm plugin names) +
 * optional model posture, keyed by the config filename. `provider` (API keys) and all
 * preference/tooling keys are dropped by the allowlist. Null when nothing is kept.
 */
async function readSettings(_ctx: Ctx, config: LoadedConfig | null): Promise<EnvCategorySnapshot | null> {
  if (!config) return null
  const c = config.config
  const kept: Record<string, unknown> = {}
  if (c.permission && typeof c.permission === 'object') kept.permission = c.permission
  if (Array.isArray(c.plugin)) kept.plugin = c.plugin
  for (const k of ['model', 'small_model', 'default_agent'] as const) {
    if (typeof c[k] === 'string') kept[k] = c[k]
  }
  if (Object.keys(kept).length === 0) return null
  return { category: 'settings', payload: { [config.key]: kept } }
}

/**
 * `mcp` — servers from the config `mcp` object, keyed by config file → server name.
 * Only `type`, `url` (credential-stripped), and `enabled` are kept; `command`, `cwd`,
 * `environment`, `headers`, `oauth`, `timeout` are dropped as secret-bearing or noise.
 */
async function readMcp(_ctx: Ctx, config: LoadedConfig | null): Promise<EnvCategorySnapshot | null> {
  if (!config) return null
  const servers = redactMcpServers(config.config.mcp)
  if (!servers) return null
  return { category: 'mcp', payload: { [config.key]: { servers } } }
}

/** Keep only name→{type,url?,enabled?} per server; drop everything secret-bearing. Null if none. */
function redactMcpServers(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue
    const d = def as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    if (typeof d.type === 'string') kept.type = d.type
    if (typeof d.url === 'string') {
      const safe = redactUrl(d.url)
      if (safe) kept.url = safe
    }
    if (typeof d.enabled === 'boolean') kept.enabled = d.enabled
    out[name] = kept
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * `agents` — custom sub-agent definitions: `agents/*.md` (frontmatter + body) plus
 * inline `agent{}` objects in the config (inline `prompt` is the body). Allowlist:
 * `description`, `mode`, `model` + body + hash. `color`/`temperature`/`permission`/…
 * are dropped. File entries carry a `dir`; inline entries carry `source: "config"`.
 */
async function readAgents(ctx: Ctx, config: LoadedConfig | null): Promise<EnvCategorySnapshot | null> {
  const agents: Array<Record<string, unknown>> = []
  const seen = new Set<string>() // source-file realpaths — collapse symlinked duplicates
  for (const dir of ctx.agentDirs) {
    for (const path of (await walkFiles(dir, '.md')).sort()) {
      const entry = await readAgentMd(ctx, path)
      if (!entry) continue
      const real = await realpathOf(path)
      if (seen.has(real)) continue
      seen.add(real)
      agents.push(entry)
    }
  }
  const inline = config?.config.agent
  if (inline && typeof inline === 'object') {
    for (const [name, def] of Object.entries(inline as Record<string, unknown>)) {
      const entry = inlineAgent(name, def)
      if (entry) agents.push(entry)
    }
  }
  return agents.length > 0 ? { category: 'agents', payload: { agents, count: agents.length } } : null
}

async function readAgentMd(ctx: Ctx, path: string): Promise<Record<string, unknown> | null> {
  const read = await readFrontmatterFile(path)
  if (!read) return null
  const { fm, body, bodyHash } = read
  const entry: Record<string, unknown> = {
    name: typeof fm.name === 'string' ? fm.name : basename(path, '.md'),
    body,
    bodyHash,
    dir: labelDir(ctx, join(path, '..')),
  }
  if (typeof fm.description === 'string') entry.description = fm.description
  if (typeof fm.mode === 'string') entry.mode = fm.mode
  if (typeof fm.model === 'string') entry.model = fm.model
  return entry
}

function inlineAgent(name: string, def: unknown): Record<string, unknown> | null {
  if (!def || typeof def !== 'object') return null
  const d = def as Record<string, unknown>
  const body = typeof d.prompt === 'string' ? d.prompt : ''
  const entry: Record<string, unknown> = { name, body, bodyHash: contentHash(body), source: 'config' }
  if (typeof d.description === 'string') entry.description = d.description
  if (typeof d.mode === 'string') entry.mode = d.mode
  if (typeof d.model === 'string') entry.model = d.model
  return entry
}

/**
 * `skills` — OpenCode skills (`<name>/SKILL.md` across all six searched locations) and
 * commands (`commands/*.md` + inline `command{}`), as ONE list with each entry tagged
 * `kind: "skill" | "command"`. Skill `name` is the directory name; command `name` is the
 * filename/key. Bodies (skill instructions / command templates) are stored + hashed.
 */
async function readSkills(ctx: Ctx, config: LoadedConfig | null): Promise<EnvCategorySnapshot | null> {
  const skills: Array<Record<string, unknown>> = []
  const seen = new Set<string>() // source-file realpaths — collapse symlinked duplicates
  const pushFile = async (sourceFile: string, entry: Record<string, unknown> | null): Promise<void> => {
    if (!entry) return
    const real = await realpathOf(sourceFile)
    if (seen.has(real)) return
    seen.add(real)
    skills.push(entry)
  }

  for (const base of ctx.skillDirs) {
    for (const name of (await listDirs(base)).sort()) {
      const src = join(base, name, 'SKILL.md')
      const entry = await readSkillFile(src, name)
      await pushFile(src, entry && { ...entry, kind: 'skill', dir: labelDir(ctx, join(base, name)) })
    }
  }
  for (const dir of ctx.commandDirs) {
    for (const path of (await walkFiles(dir, '.md')).sort()) {
      // Command discovery is recursive; the invocable name is the path relative to the
      // commands dir (namespaced), not just the basename — `discovery/approve.md` is
      // `discovery/approve`, and two same-named files in different subdirs stay distinct.
      const name = relative(dir, path)
        .replace(/\.md$/, '')
        .split(/[\\/]/)
        .join('/')
      const entry = await readCommandMd(path, name)
      await pushFile(path, entry && { ...entry, dir: labelDir(ctx, join(path, '..')) })
    }
  }
  const inline = config?.config.command
  if (inline && typeof inline === 'object') {
    for (const [name, def] of Object.entries(inline as Record<string, unknown>)) {
      const entry = inlineCommand(name, def)
      if (entry) skills.push(entry) // inline has no source file — always kept
    }
  }
  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

async function readCommandMd(path: string, name: string): Promise<Record<string, unknown> | null> {
  const read = await readFrontmatterFile(path)
  if (!read) return null
  const { fm, body, bodyHash } = read
  const entry: Record<string, unknown> = { name, body, bodyHash, kind: 'command' }
  if (typeof fm.description === 'string') entry.description = fm.description
  if (typeof fm.agent === 'string') entry.agent = fm.agent
  if (typeof fm.model === 'string') entry.model = fm.model
  return entry
}

function inlineCommand(name: string, def: unknown): Record<string, unknown> | null {
  if (!def || typeof def !== 'object') return null
  const d = def as Record<string, unknown>
  const body = typeof d.template === 'string' ? d.template : ''
  const entry: Record<string, unknown> = { name, body, bodyHash: contentHash(body), kind: 'command', source: 'config' }
  if (typeof d.description === 'string') entry.description = d.description
  if (typeof d.agent === 'string') entry.agent = d.agent
  if (typeof d.model === 'string') entry.model = d.model
  return entry
}

/**
 * `instructions` — the EFFECTIVE always-on instruction files OpenCode loads, keyed by
 * path. Primary is `AGENTS.md` (config home for global; repo root + nested for project);
 * `CLAUDE.md` / `~/.claude/CLAUDE.md` is read ONLY as a fallback when no AGENTS.md exists
 * (a shadowed CLAUDE.md is not stored). Files matched by the config `instructions[]`
 * globs are always combined. Empty files omitted.
 */
async function readInstructions(ctx: Ctx, config: LoadedConfig | null): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}

  const agentsMd = await findAgentsMd(ctx)
  const primary = agentsMd.length > 0 ? agentsMd : claudeFallbacks(ctx)
  for (const path of primary) await addInstruction(ctx, payload, path)

  for (const glob of instructionGlobs(config)) {
    for (const path of await resolveGlob(ctx, glob)) await addInstruction(ctx, payload, path)
  }

  return Object.keys(payload).length > 0 ? { category: 'instructions', payload } : null
}

/** All `AGENTS.md` OpenCode would load for this scope. */
async function findAgentsMd(ctx: Ctx): Promise<string[]> {
  if (ctx.scope === 'global') {
    const p = join(ctx.configDir, 'AGENTS.md')
    return (await readTextIfExists(p)) != null ? [p] : []
  }
  return (await walkAllFiles(ctx.base)).filter((p) => basename(p) === 'AGENTS.md').sort()
}

/** The Claude-compat instruction fallback path(s) for this scope. */
function claudeFallbacks(ctx: Ctx): string[] {
  return ctx.scope === 'global' ? [join(ctx.home, '.claude', 'CLAUDE.md')] : [join(ctx.base, 'CLAUDE.md')]
}

/** Local-path entries of the config `instructions[]` array (remote URLs deferred). */
function instructionGlobs(config: LoadedConfig | null): string[] {
  const arr = config?.config.instructions
  if (!Array.isArray(arr)) return []
  return arr.filter((g): g is string => typeof g === 'string' && !/^https?:\/\//.test(g))
}

/** Resolve one `instructions[]` entry (literal path or `*`/`**` glob) to existing files. */
async function resolveGlob(ctx: Ctx, glob: string): Promise<string[]> {
  if (!glob.includes('*')) {
    const p = join(ctx.base, glob)
    return (await readTextIfExists(p)) != null ? [p] : []
  }
  const re = globToRegex(glob)
  return (await walkAllFiles(ctx.base)).filter((p) => re.test(relative(ctx.base, p))).sort()
}

/** Minimal glob → RegExp: `*` matches within a path segment, `**` across segments. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'))
  return new RegExp(`^${body}$`)
}

/** Read one instruction file into the payload (body + hash), keyed by path. Empty files skipped. */
async function addInstruction(ctx: Ctx, payload: Record<string, unknown>, path: string): Promise<void> {
  const body = await readTextIfExists(path)
  if (body == null || body.trim() === '') return
  payload[labelFile(ctx, path)] = { body, hash: contentHash(body) }
}
