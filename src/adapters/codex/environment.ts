import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { contentHash } from '../../core/hash'
import type { EnvCategorySnapshot } from '../../store/types'
import { walkFiles } from '../../util/walk'
import { listDirs, readSkillFile, realpathOf, redactUrl } from '../env-shared'

/**
 * Codex config reader. Each call captures one independent scope: the Codex home
 * when `projectPath` is absent, or every applicable project layer below a repo
 * root when it is present. Only the small allowlists below leave this module.
 */
export async function readCodexEnvironment(projectPath?: string): Promise<EnvCategorySnapshot[]> {
  const ctx = await buildCtx(projectPath)
  // Config parsing is deliberately eager. If any present config is invalid, the
  // whole scope read fails and captureEnvironment preserves the prior snapshots.
  const configs = await loadConfigs(ctx)
  const out: EnvCategorySnapshot[] = []
  for (const read of [readSettings, readMcp, readAgents, readSkills, readInstructions]) {
    const category = await read(ctx, configs)
    if (category) out.push(category)
  }
  return out
}

// ---- scope and config discovery -------------------------------------------

/** `$CODEX_HOME`, defaulting to the documented `~/.codex`. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return resolve(configured || join(homedir(), '.codex'))
}

interface Ctx {
  scope: 'global' | 'project'
  /** Root used for payload labels and project confinement. */
  base: string
  home: string
  configPaths: string[]
  /** Every normal project directory, root first. Empty for global scope. */
  projectDirs: string[]
}

interface LoadedConfig {
  path: string
  key: string
  config: Record<string, unknown>
}

async function buildCtx(projectPath?: string): Promise<Ctx> {
  const home = resolve(homedir())
  if (projectPath === undefined) {
    const base = codexHome()
    return {
      scope: 'global',
      base,
      home,
      configPaths: [join(base, 'config.toml')],
      projectDirs: [],
    }
  }

  // Canonicalize the project root once so confinement comparisons agree with
  // canonical source paths (macOS commonly aliases /var to /private/var).
  const base = await realpathOf(resolve(projectPath))
  const projectDirs = await walkProjectDirs(base)
  return {
    scope: 'project',
    base,
    home,
    configPaths: projectDirs.map((dir) => join(dir, '.codex', 'config.toml')),
    projectDirs,
  }
}

/**
 * Directories that cannot contain meaningful repository-owned Codex layers.
 * `.codex` and `.agents` are handled explicitly from their parent directory.
 */
const PRUNE_DIRS = new Set([
  '.git',
  '.codex',
  '.agents',
  'node_modules',
  'dist',
  'build',
  'vendor',
  'venv',
  'target',
])

/** Deterministic repo walk used to represent sessions launched below the root. */
async function walkProjectDirs(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    out.push(dir)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Do not follow arbitrary repo-directory symlinks while searching for
      // layers. Skill symlinks are followed separately with a confinement check.
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(join(dir, entry.name))
    }
  }
  await walk(root)
  return out
}

async function loadConfigs(ctx: Ctx): Promise<LoadedConfig[]> {
  const configs: LoadedConfig[] = []
  for (const path of [...ctx.configPaths].sort()) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`unable to read Codex config ${labelFile(ctx, path)}`)
    }

    let parsed: unknown
    try {
      parsed = parse(text)
    } catch {
      throw new Error(`invalid Codex config ${labelFile(ctx, path)}`)
    }
    if (!isTable(parsed)) throw new Error(`invalid Codex config ${labelFile(ctx, path)}`)
    configs.push({ path, key: labelFile(ctx, path), config: parsed })
  }
  return configs
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function slash(path: string): string {
  return path.split('\\').join('/')
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

function labelFile(ctx: Ctx, path: string): string {
  if (isWithin(path, ctx.base)) return slash(relative(ctx.base, path))
  if (isWithin(path, ctx.home)) return slash(relative(ctx.home, path))
  return slash(path)
}

function labelDir(ctx: Ctx, path: string): string {
  return labelFile(ctx, path) || '.'
}

async function allowedSource(ctx: Ctx, path: string): Promise<{ allowed: boolean; real: string }> {
  const real = await realpathOf(path)
  return { allowed: ctx.scope === 'global' || isWithin(real, ctx.base), real }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ---- settings --------------------------------------------------------------

/**
 * Keep only security/adoption posture. In particular, no shell environment,
 * hook bodies, app definitions, provider/auth settings, or model endpoints pass.
 */
async function readSettings(_ctx: Ctx, configs: LoadedConfig[]): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}
  for (const config of configs) {
    const source = config.config
    const kept: Record<string, unknown> = {}

    const approval = redactApprovalPolicy(source.approval_policy)
    if (approval !== undefined) kept.approval_policy = approval
    if (typeof source.approvals_reviewer === 'string') kept.approvals_reviewer = source.approvals_reviewer
    if (typeof source.sandbox_mode === 'string') kept.sandbox_mode = source.sandbox_mode

    const workspace = isTable(source.sandbox_workspace_write) ? source.sandbox_workspace_write : null
    if (workspace && typeof workspace.network_access === 'boolean') {
      kept.sandbox_workspace_write = { network_access: workspace.network_access }
    }

    if (typeof source.web_search === 'string') kept.web_search = source.web_search

    const features = redactFeatures(source.features)
    if (features) kept.features = features

    if (Object.keys(kept).length > 0) payload[config.key] = kept
  }
  return Object.keys(payload).length > 0 ? { category: 'settings', payload } : null
}

function redactApprovalPolicy(raw: unknown): unknown | undefined {
  if (typeof raw === 'string') return raw
  if (!isTable(raw) || !isTable(raw.granular)) return undefined
  const granular: Record<string, boolean> = {}
  for (const key of ['sandbox_approval', 'rules', 'mcp_elicitations', 'request_permissions', 'skill_approval']) {
    if (typeof raw.granular[key] === 'boolean') granular[key] = raw.granular[key]
  }
  return Object.keys(granular).length > 0 ? { granular } : undefined
}

function redactFeatures(raw: unknown): Record<string, unknown> | null {
  if (!isTable(raw)) return null
  const kept: Record<string, unknown> = {}
  for (const key of ['apps', 'hooks', 'memories']) {
    if (typeof raw[key] === 'boolean') kept[key] = raw[key]
  }

  if (typeof raw.code_mode === 'boolean') {
    kept.code_mode = raw.code_mode
  } else if (isTable(raw.code_mode)) {
    const codeMode: Record<string, unknown> = {}
    if (typeof raw.code_mode.enabled === 'boolean') codeMode.enabled = raw.code_mode.enabled
    for (const key of ['excluded_tool_namespaces', 'direct_only_tool_namespaces']) {
      const values = stringList(raw.code_mode[key])
      if (values) codeMode[key] = values
    }
    if (Object.keys(codeMode).length > 0) kept.code_mode = codeMode
  }
  return Object.keys(kept).length > 0 ? kept : null
}

function stringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const values = [...new Set(raw.filter((value): value is string => typeof value === 'string'))].sort()
  return values.length > 0 ? values : null
}

// ---- MCP -------------------------------------------------------------------

async function readMcp(_ctx: Ctx, configs: LoadedConfig[]): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}
  for (const config of configs) {
    const servers = redactMcpServers(config.config.mcp_servers)
    if (servers) payload[config.key] = { servers }
  }
  return Object.keys(payload).length > 0 ? { category: 'mcp', payload } : null
}

function redactMcpServers(raw: unknown): Record<string, unknown> | null {
  if (!isTable(raw)) return null
  const servers: Record<string, unknown> = {}
  for (const name of Object.keys(raw).sort()) {
    const definition = raw[name]
    if (!isTable(definition)) continue
    const kept: Record<string, unknown> = {}
    if (typeof definition.url === 'string') {
      kept.type = 'http'
      const safe = redactUrl(definition.url)
      if (safe) kept.url = safe
    } else if (typeof definition.command === 'string') {
      kept.type = 'stdio'
    } else {
      continue
    }
    if (typeof definition.enabled === 'boolean') kept.enabled = definition.enabled
    servers[name] = kept
  }
  return Object.keys(servers).length > 0 ? servers : null
}

// ---- custom agents ---------------------------------------------------------

async function readAgents(ctx: Ctx, configs: LoadedConfig[]): Promise<EnvCategorySnapshot | null> {
  const defaultPaths: string[] = []
  if (ctx.scope === 'global') {
    defaultPaths.push(...(await walkFiles(join(ctx.base, 'agents'), '.toml')).sort())
  } else {
    for (const dir of ctx.projectDirs) {
      defaultPaths.push(...(await walkFiles(join(dir, '.codex', 'agents'), '.toml')).sort())
    }
  }

  const referencedPaths: string[] = []
  for (const config of configs) {
    const agents = isTable(config.config.agents) ? config.config.agents : null
    if (!agents) continue
    for (const name of Object.keys(agents).sort()) {
      const definition = agents[name]
      if (!isTable(definition) || typeof definition.config_file !== 'string') continue
      const path = await resolveConfigReference(ctx, config, definition.config_file)
      if (path) referencedPaths.push(path)
    }
  }

  const seen = new Set<string>()
  const found: Array<{ key: string; entry: Record<string, unknown> }> = []
  for (const path of [...defaultPaths, ...referencedPaths]) {
    const source = await allowedSource(ctx, path)
    if (!source.allowed || seen.has(source.real)) continue
    seen.add(source.real)
    const entry = await readAgentFile(ctx, path)
    if (!entry) continue
    found.push({ key: `${String(entry.dir)}\0${String(entry.name)}\0${slash(path)}`, entry })
  }
  found.sort((a, b) => a.key.localeCompare(b.key))
  const agents = found.map(({ entry }) => entry)
  return agents.length > 0 ? { category: 'agents', payload: { agents, count: agents.length } } : null
}

async function readAgentFile(ctx: Ctx, path: string): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(path)
  if (text == null) return null
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    return null
  }
  if (!isTable(parsed)) return null
  if (
    typeof parsed.name !== 'string' ||
    parsed.name.trim() === '' ||
    typeof parsed.description !== 'string' ||
    typeof parsed.developer_instructions !== 'string'
  ) {
    return null
  }

  const body = parsed.developer_instructions
  const entry: Record<string, unknown> = {
    name: parsed.name,
    description: parsed.description,
    body,
    bodyHash: contentHash(body),
    dir: labelDir(ctx, dirname(path)),
  }
  if (typeof parsed.model === 'string') entry.model = parsed.model
  if (typeof parsed.model_reasoning_effort === 'string') entry.model_reasoning_effort = parsed.model_reasoning_effort
  if (typeof parsed.sandbox_mode === 'string') entry.sandbox_mode = parsed.sandbox_mode
  return entry
}

// ---- skills ----------------------------------------------------------------

interface ConfiguredSkill {
  path: string
  real: string
  enabled: boolean
}

async function readSkills(ctx: Ctx, configs: LoadedConfig[]): Promise<EnvCategorySnapshot | null> {
  const configured: ConfiguredSkill[] = []
  for (const config of configs) {
    const skills = isTable(config.config.skills) ? config.config.skills : null
    if (!skills || !Array.isArray(skills.config)) continue
    for (const item of skills.config) {
      if (!isTable(item) || typeof item.path !== 'string') continue
      let path = await resolveConfigReference(ctx, config, item.path)
      if (!path) continue
      try {
        if ((await stat(path)).isDirectory()) path = join(path, 'SKILL.md')
      } catch {
        // Missing configured skills simply do not contribute an entry.
      }
      const source = await allowedSource(ctx, path)
      if (!source.allowed) continue
      configured.push({ path, real: source.real, enabled: item.enabled !== false })
    }
  }

  // Later applicable config entries replace earlier ones for the same file.
  const enablement = new Map<string, boolean>()
  for (const item of configured) enablement.set(item.real, item.enabled)

  const skillRoots =
    ctx.scope === 'global'
      ? [join(ctx.home, '.agents', 'skills')]
      : ctx.projectDirs.map((dir) => join(dir, '.agents', 'skills'))

  const seen = new Set<string>()
  const found: Array<{ key: string; entry: Record<string, unknown> }> = []
  const add = async (path: string, fallbackName: string, preferFrontmatterName = false): Promise<void> => {
    const source = await allowedSource(ctx, path)
    if (!source.allowed || seen.has(source.real) || enablement.get(source.real) === false) return
    const read = await readSkillFile(path, fallbackName, preferFrontmatterName)
    if (!read) return
    seen.add(source.real)
    const entry: Record<string, unknown> = { ...read, kind: 'skill', dir: labelDir(ctx, dirname(path)) }
    found.push({ key: `${String(entry.dir)}\0${String(entry.name)}\0${slash(path)}`, entry })
  }

  for (const root of skillRoots) {
    for (const name of (await listDirs(root)).sort()) {
      await add(join(root, name, 'SKILL.md'), name)
    }
  }
  for (const item of configured) {
    if (enablement.get(item.real) !== true) continue
    await add(item.path, basename(dirname(item.path)), true)
  }

  found.sort((a, b) => a.key.localeCompare(b.key))
  const skills = found.map(({ entry }) => entry)
  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

async function resolveConfigReference(ctx: Ctx, config: LoadedConfig, raw: string): Promise<string | null> {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const path = resolve(isAbsolute(trimmed) ? trimmed : join(dirname(config.path), trimmed))
  const source = await allowedSource(ctx, path)
  return source.allowed ? path : null
}

// ---- AGENTS.md instructions ------------------------------------------------

async function readInstructions(ctx: Ctx, configs: LoadedConfig[]): Promise<EnvCategorySnapshot | null> {
  const payload: Record<string, unknown> = {}
  if (ctx.scope === 'global') {
    await addFirstInstruction(ctx, payload, [join(ctx.base, 'AGENTS.override.md'), join(ctx.base, 'AGENTS.md')])
  } else {
    for (const dir of ctx.projectDirs) {
      const candidates = [
        join(dir, 'AGENTS.override.md'),
        join(dir, 'AGENTS.md'),
        ...fallbacksForDir(ctx, configs, dir).map((name) => join(dir, name)),
      ]
      await addFirstInstruction(ctx, payload, candidates)
    }
  }
  return Object.keys(payload).length > 0 ? { category: 'instructions', payload } : null
}

function fallbacksForDir(ctx: Ctx, configs: LoadedConfig[], dir: string): string[] {
  let active: string[] = []
  for (const config of configs) {
    const layerDir = dirname(dirname(config.path))
    if (!isWithin(dir, layerDir)) continue
    const raw = config.config.project_doc_fallback_filenames
    if (!Array.isArray(raw)) continue
    active = raw.filter(
      (name): name is string =>
        typeof name === 'string' && name.trim() !== '' && basename(name) === name && name !== '.' && name !== '..',
    )
  }
  return active
}

async function addFirstInstruction(
  ctx: Ctx,
  payload: Record<string, unknown>,
  candidates: string[],
): Promise<void> {
  for (const path of candidates) {
    const source = await allowedSource(ctx, path)
    if (!source.allowed) continue
    const body = await readTextIfExists(path)
    if (body == null || body.trim() === '') continue
    payload[labelFile(ctx, path)] = { body, hash: contentHash(body) }
    return
  }
}
