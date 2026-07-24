import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { contentHash } from '../../core/hash'
import type { EnvCategorySnapshot } from '../../store/types'
import { walkFiles } from '../../util/walk'
import { readJsonIfExists, readSkillFile, realpathOf, redactUrl } from '../env-shared'

/**
 * Pi config reader (environment reader). Produces the redacted, allowlisted
 * per-category snapshots that analyze stores as a config timeline.
 *
 * Called once for global scope (`projectPath` undefined → read Pi's agent home)
 * and once per project repo root (→ read `<repo>/.pi`, `<repo>/.agents`, context
 * files). Only allowlisted, secret-free fields are ever returned.
 *
 * Pi's category coverage is intentionally narrow — it ships no built-in MCP and no
 * sub-agents (`usage.md`: "does not include built-in MCP, sub-agents, ..."), so it
 * populates only `settings`, `skills`, and `instructions`. The `mcp` and `agents`
 * categories are never emitted.
 */
export async function readPiEnvironment(projectPath?: string): Promise<EnvCategorySnapshot[]> {
  const scope = projectPath === undefined ? 'global' : 'project'
  // Scan the repo tree once and share it across readers: `.pi/` dirs feed
  // settings + skills; `.agents/` dirs feed skills; AGENTS.md/CLAUDE.md feed instructions.
  const scan: ProjectScan | undefined = projectPath === undefined ? undefined : await scanProject(projectPath)
  const out: EnvCategorySnapshot[] = []
  for (const read of [readSettings, readSkills, readInstructions]) {
    const cat = await read(scope, projectPath, scan)
    if (cat) out.push(cat)
  }
  return out
}

/** Repo-tree scan results, computed once per project (scanProject) and shared across readers. */
export interface ProjectScan {
  /** Every `.pi/` dir under the repo (repo-relative). Holds settings + a `skills/` dir. */
  piDirs: string[]
  /** Every `.agents/` dir under the repo (repo-relative). Holds a `skills/` dir. */
  agentsDirs: string[]
  /** Every AGENTS.md / CLAUDE.md under the repo (repo-relative). */
  instructionFiles: string[]
}

// ---- shared helpers --------------------------------------------------------

/**
 * Pi's agent config home. Honors `$PI_CODING_AGENT_DIR` (Pi's own override, which
 * points AT the agent dir, not its parent), else `~/.pi/agent`. A leading `~` in
 * the override is expanded so tests and configured overrides resolve consistently.
 */
export function piHome(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  if (configured) return resolve(configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured)
  return resolve(join(homedir(), '.pi', 'agent'))
}

/**
 * The home-level `~/.agents/skills` directory — a SIBLING of `~/.pi`, not inside the
 * agent home. Pi reads global skills from here in addition to `<piHome>/skills`, so
 * it does NOT follow `$PI_CODING_AGENT_DIR` (which only relocates the Pi agent home).
 */
export function agentsHome(): string {
  return resolve(join(homedir(), '.agents'))
}

/** Repo-relative label for a path (forward-slashed); the basename when not under root. */
function relLabel(root: string, path: string): string {
  const rel = relative(root, path)
  return rel === '' ? '.' : rel.split('\\').join('/')
}

// ---- settings --------------------------------------------------------------

/**
 * `settings` — allowlisted config from each `settings.json` present, keyed by
 * repo-relative path so the source (global vs project, root vs nested package) stays
 * explicit. Global scope reads `<piHome>/settings.json`. Project scope reads
 * `settings.json` in EVERY `.pi/` dir under the repo. A file whose entire content is
 * dropped by the allowlist is omitted; the category is null when nothing survives.
 */
async function readSettings(
  scope: 'global' | 'project',
  projectPath?: string,
  scan?: ProjectScan,
): Promise<EnvCategorySnapshot | null> {
  const files: Array<{ key: string; path: string }> =
    scope === 'global'
      ? [{ key: 'settings.json', path: join(piHome(), 'settings.json') }]
      : scan!.piDirs.map((rel) => ({ key: `${rel}/settings.json`, path: join(projectPath!, rel, 'settings.json') }))

  const payload: Record<string, unknown> = {}
  for (const f of files) {
    const raw = await readJsonIfExists(f.path)
    if (!raw || typeof raw !== 'object') continue
    const kept = allowlistSettings(raw as Record<string, unknown>)
    if (Object.keys(kept).length > 0) payload[f.key] = kept
  }
  return Object.keys(payload).length > 0 ? { category: 'settings', payload } : null
}

/**
 * Scalar/object settings kept verbatim: model + delivery posture, trust posture,
 * context-management posture, and resource pointers (which extensions/skills/prompts/
 * themes/packages load). None of these carry secrets — they are identifiers, flags,
 * booleans, or file paths. Everything else (theme + other pure-UI display options,
 * `externalEditor`, `shellPath`/`shellCommandPrefix`/`npmCommand` execution plumbing,
 * `sessionDir`, `trackingId`, telemetry flags) is dropped by omission.
 */
const KEPT_SETTINGS = new Set([
  // Model & thinking posture
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'thinkingBudgets',
  'hideThinkingBlock',
  'showCacheMissNotices',
  'enabledModels',
  // Trust / security posture
  'defaultProjectTrust',
  // Context management
  'compaction',
  'branchSummary',
  'retry',
  // Message delivery
  'steeringMode',
  'followUpMode',
  'transport',
  // Warnings
  'warnings',
  // Resource pointers (adoption)
  'packages',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'enableSkillCommands',
])

/** Pull only the allowlisted fields; redact the one URL-bearing field (`httpProxy`). */
function allowlistSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (KEPT_SETTINGS.has(key) && raw[key] !== undefined) out[key] = raw[key]
  }
  // httpProxy is an endpoint that can carry `user:pass@` — keep only its safe identity.
  if (typeof raw.httpProxy === 'string') {
    const safe = redactUrl(raw.httpProxy)
    if (safe) out.httpProxy = safe
  }
  return out
}

// ---- skills ----------------------------------------------------------------

interface SkillRoot {
  /** Absolute path to a `skills/` directory. */
  dir: string
  /** Root `.md` files (direct children) are individual skills only in `.pi` skill dirs. */
  allowRootMd: boolean
  /** Repo-relative (or home-relative) label base for entries' `dir`. */
  label: string
}

/**
 * `skills` — custom skills, as one merged list. Per entry: name, `description?`,
 * full body + hash, `kind: "skill"`, and the source `dir`.
 *
 * Locations (docs: `skills.md`):
 *   - global : `<piHome>/skills` and `~/.agents/skills`
 *   - project: `<repo>/.pi/skills` and `<repo>/.agents/skills` (every such dir found)
 *
 * Discovery per Pi's rules: in `.pi` skill dirs, direct root `.md` files are individual
 * skills; in all locations, directories containing `SKILL.md` are discovered recursively;
 * in `.agents` skill dirs, root `.md` files are ignored. Name identity is the frontmatter
 * `name` when present (Pi lets it differ from the dir), falling back to the dir/file name.
 * Duplicates reached through symlinks are collapsed by real path. Null when none exist.
 */
async function readSkills(
  scope: 'global' | 'project',
  projectPath?: string,
  scan?: ProjectScan,
): Promise<EnvCategorySnapshot | null> {
  const roots: SkillRoot[] =
    scope === 'global'
      ? [
          { dir: join(piHome(), 'skills'), allowRootMd: true, label: '.pi/skills' },
          { dir: join(agentsHome(), 'skills'), allowRootMd: false, label: '.agents/skills' },
        ]
      : [
          ...scan!.piDirs.map((rel) => ({ dir: join(projectPath!, rel, 'skills'), allowRootMd: true, label: `${rel}/skills` })),
          ...scan!.agentsDirs.map((rel) => ({ dir: join(projectPath!, rel, 'skills'), allowRootMd: false, label: `${rel}/skills` })),
        ]

  const skills: Array<Record<string, unknown>> = []
  const seen = new Set<string>() // source-file realpaths — collapse symlinked duplicates
  for (const root of roots) {
    for (const { path, fallbackName, dirLabel } of await collectSkillFiles(root)) {
      const real = await realpathOf(path)
      if (seen.has(real)) continue
      // Pi's frontmatter `name` is authoritative and may differ from the directory.
      const entry = await readSkillFile(path, fallbackName, true)
      if (!entry) continue
      seen.add(real)
      skills.push({ ...entry, kind: 'skill', dir: dirLabel })
    }
  }
  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

/**
 * Enumerate the skill source files under one `skills/` root, applying Pi's discovery
 * rules. A file qualifies when it is a `SKILL.md` at any depth (a directory skill), or
 * — only when `allowRootMd` — a direct-child `.md` file (an individual `.pi` skill).
 * Deterministic (sorted by path).
 */
async function collectSkillFiles(
  root: SkillRoot,
): Promise<Array<{ path: string; fallbackName: string; dirLabel: string }>> {
  const out: Array<{ path: string; fallbackName: string; dirLabel: string }> = []
  for (const path of (await walkFiles(root.dir, '.md')).sort()) {
    const rel = relative(root.dir, path)
    const isRootMd = !rel.includes('/') && !rel.includes('\\')
    if (basename(path) === 'SKILL.md') {
      // Directory skill: name defaults to the containing directory name.
      out.push({ path, fallbackName: basename(dirname(path)), dirLabel: `${root.label}/${relLabel(root.dir, dirname(path))}` })
    } else if (root.allowRootMd && isRootMd) {
      // Individual `.pi` skill: name defaults to the file's base name.
      out.push({ path, fallbackName: basename(path, '.md'), dirLabel: root.label })
    }
  }
  return out
}

// ---- instructions ----------------------------------------------------------

/**
 * `instructions` — Pi's context files (`AGENTS.md` / `CLAUDE.md`). Plain markdown; we
 * store the full body + hash, keyed by relative path. Global scope reads
 * `<piHome>/AGENTS.md` and `<piHome>/CLAUDE.md`; project scope stores every AGENTS.md /
 * CLAUDE.md found under the repo (Pi walks up from cwd loading these). Empty files are
 * omitted. Null when no non-empty instructions file exists in the scope.
 */
async function readInstructions(
  scope: 'global' | 'project',
  projectPath?: string,
  scan?: ProjectScan,
): Promise<EnvCategorySnapshot | null> {
  const files: Array<{ key: string; path: string }> =
    scope === 'global'
      ? [
          { key: 'AGENTS.md', path: join(piHome(), 'AGENTS.md') },
          { key: 'CLAUDE.md', path: join(piHome(), 'CLAUDE.md') },
        ]
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

// ---- repo scan -------------------------------------------------------------

/** Directory names we never descend into when scanning a repo for config. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', 'target'])

/** Filenames collected as `instructions` by scanProject. */
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])

/**
 * One walk of the repo tree collecting everything the category readers need:
 *   - every `.pi/` dir (repo-relative) — settings + a `skills/` dir. Pi reads project
 *     config from `.pi/`, and monorepo sub-packages can carry their own.
 *   - every `.agents/` dir (repo-relative) — a `skills/` dir shared across harnesses.
 *   - every `AGENTS.md` / `CLAUDE.md` (repo-relative) — context files, which can live
 *     directly in any directory. Pi walks up from cwd loading these, so nested ones
 *     represent sessions launched from those directories.
 *
 * `.pi`/`.agents` are registered but not descended into (their subtrees are skill
 * dirs, not more config dirs). Bounded by a skip-list plus all other dot-directories —
 * vendored/build trees can ship their own `.pi`/`.agents` that is not the user's config.
 */
export async function scanProject(repoRoot: string): Promise<ProjectScan> {
  const piDirs: string[] = []
  const agentsDirs: string[] = []
  const instructionFiles: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
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
      if (e.name === '.pi') {
        piDirs.push(childRel)
        continue // don't descend — its subtree is a skill dir, not more config
      }
      if (e.name === '.agents') {
        agentsDirs.push(childRel)
        continue
      }
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await walk(join(dir, e.name), childRel)
    }
  }
  await walk(repoRoot, '')
  return {
    piDirs: piDirs.sort(),
    agentsDirs: agentsDirs.sort(),
    instructionFiles: instructionFiles.sort(),
  }
}
