import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { contentHash } from '../../core/hash'
import type { EnvCategorySnapshot } from '../../store/types'
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

/** Pull only the allowlisted fields; redact any credential-bearing URLs they carry. */
function allowlistSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (KEPT_SETTINGS.has(key) && raw[key] !== undefined) out[key] = raw[key]
  }
  // `packages` accepts HTTP(S) git sources, which Pi keeps verbatim — including any
  // `user:token@host` userinfo. Strip credentials from every source before storing.
  if (out.packages !== undefined) out.packages = redactPackages(out.packages)
  // httpProxy is an endpoint that can carry `user:pass@` — keep only its safe identity.
  if (typeof raw.httpProxy === 'string') {
    const safe = redactUrl(raw.httpProxy)
    if (safe) out.httpProxy = safe
  }
  return out
}

/**
 * Redact credentials from a `packages` array. Each entry is a source string or an
 * object with a `source` string; both forms may hold a git URL with embedded
 * credentials. Bare npm names (`pi-skills`, `@org/pkg`) and scp-style refs
 * (`git@host:path`) don't parse as URLs and pass through untouched.
 */
function redactPackages(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map((item) => {
    if (typeof item === 'string') return redactPackageSource(item)
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      if (typeof obj.source === 'string') return { ...obj, source: redactPackageSource(obj.source) }
    }
    return item
  })
}

/**
 * Strip secrets from a package URL source, preserving endpoint identity. Removes
 * `user:token@` userinfo AND the query string (`?access_token=…`), keeping the path
 * and `#ref`. Pi also accepts a `git:` prefix in front of a nested URL of ANY scheme
 * (`git:https://…`, `git:ssh://user:secret@host/repo`); `new URL()` would treat that as
 * an opaque `git:` value and miss its credentials, so the prefix is peeled before
 * redaction and restored afterward. Non-URL sources (bare npm names, scoped names,
 * scp-style `git@host:path` refs) don't parse and pass through untouched.
 */
function redactPackageSource(raw: string): string {
  const gitPrefix = /^git:[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? 'git:' : ''
  const url = raw.slice(gitPrefix.length)
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = '' // query params can carry tokens
    return gitPrefix + u.toString()
  } catch {
    return raw // bare npm name / scoped name / scp-style git ref — no URL credentials
  }
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
 * skills; in all locations, a directory containing `SKILL.md` IS a skill and its subtree
 * is not searched further (so a skill's own `examples/SKILL.md` is not a second skill);
 * in `.agents` skill dirs, root `.md` files are ignored. Name identity is the frontmatter
 * `name` when present (Pi lets it differ from the dir), falling back to the dir/file name.
 * Skills missing a description are dropped — Pi refuses to load them. Duplicates reached
 * through symlinks are collapsed by real path. Null when none exist.
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
      // Pi refuses to load a skill with no description, so it never contributes inventory.
      if (!entry || typeof entry.description !== 'string' || entry.description.trim() === '') continue
      seen.add(real)
      skills.push({ ...entry, kind: 'skill', dir: dirLabel })
    }
  }
  return skills.length > 0 ? { category: 'skills', payload: { skills, count: skills.length } } : null
}

/**
 * Enumerate the skill source files under one `skills/` root, applying Pi's discovery
 * rules. The root itself is checked first: if it directly contains `SKILL.md` it IS a
 * single skill and nothing else in the tree is discovered. Otherwise, direct-child
 * `.md` files are individual skills (only when `allowRootMd`), and each subdirectory is
 * searched for a `SKILL.md` (the first directory that has one IS a skill; its subtree is
 * not descended further). Deterministic (entries sorted per level).
 *
 * Traversal skips the same set as the repo scan — hidden directories plus the build/vendor
 * skip-list — so a dependency's `node_modules/**\/SKILL.md` never registers as a skill.
 * (Full `.gitignore`/`.ignore`/`.fdignore` parity that Pi's `fd`-based traversal applies
 * is deferred, matching the other harness readers, which prune by the same fixed list.)
 */
async function collectSkillFiles(
  root: SkillRoot,
): Promise<Array<{ path: string; fallbackName: string; dirLabel: string }>> {
  const out: Array<{ path: string; fallbackName: string; dirLabel: string }> = []
  const seenDirs = new Set<string>() // realpaths — terminate symlink cycles

  const entries = await dirEntries(root.dir)
  // The skills root directory can itself be a single skill (a `SKILL.md` sitting directly
  // in it). Pi stops all further discovery in that case, for both `.pi` and `.agents`.
  if (await hasSkillMd(root.dir, entries)) {
    out.push({ path: join(root.dir, 'SKILL.md'), fallbackName: basename(root.dir), dirLabel: root.label })
    return out
  }
  for (const e of entries) {
    const childPath = join(root.dir, e.name)
    if (root.allowRootMd && (await isFileLike(childPath, e)) && e.name.endsWith('.md')) {
      // Individual `.pi` skill: name defaults to the file's base name.
      out.push({ path: childPath, fallbackName: basename(e.name, '.md'), dirLabel: root.label })
    } else if (!isPrunedDir(e.name) && (await isDirLike(childPath, e))) {
      await findSkillDirs(childPath, root, out, seenDirs)
    }
  }
  return out
}

/** True when `dir` directly contains a `SKILL.md` file (following a file symlink). */
async function hasSkillMd(dir: string, entries: Dirent[]): Promise<boolean> {
  for (const e of entries) {
    if (e.name === 'SKILL.md' && (await isFileLike(join(dir, e.name), e))) return true
  }
  return false
}

/**
 * Recurse into `dir` looking for a directory that contains `SKILL.md`. Such a directory
 * is one skill; its subtree is NOT searched further (supporting `examples/SKILL.md`
 * files must not become separate skills). A realpath guard terminates symlink cycles.
 */
async function findSkillDirs(
  dir: string,
  root: SkillRoot,
  out: Array<{ path: string; fallbackName: string; dirLabel: string }>,
  seenDirs: Set<string>,
): Promise<void> {
  const real = await realpathOf(dir)
  if (seenDirs.has(real)) return
  seenDirs.add(real)
  const entries = await dirEntries(dir)
  if (await hasSkillMd(dir, entries)) {
    // Directory skill: name defaults to the containing directory name.
    out.push({ path: join(dir, 'SKILL.md'), fallbackName: basename(dir), dirLabel: `${root.label}/${relLabel(root.dir, dir)}` })
    return // stop descending — nested SKILL.md files are this skill's own assets
  }
  for (const e of entries) {
    if (isPrunedDir(e.name)) continue // skip hidden dirs + node_modules/build/vendor trees
    const childPath = join(dir, e.name)
    if (await isDirLike(childPath, e)) await findSkillDirs(childPath, root, out, seenDirs)
  }
}

// ---- instructions ----------------------------------------------------------

/**
 * Context-file precedence WITHIN a single directory. Pi selects at most one file per
 * directory, trying these names in order (both lowercase and uppercase `.md`/`.MD`).
 */
const INSTRUCTION_PRECEDENCE = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const

/**
 * `instructions` — Pi's context files (`AGENTS.md` / `CLAUDE.md`). Plain markdown; we
 * store the full body + hash, keyed by relative path. Global scope reads the winning
 * context file in `<piHome>`; project scope stores the winning file for each directory
 * under the repo that has one (scanProject applies INSTRUCTION_PRECEDENCE per directory).
 * Empty files are omitted. Null when no non-empty instructions file exists in the scope.
 */
async function readInstructions(
  scope: 'global' | 'project',
  projectPath?: string,
  scan?: ProjectScan,
): Promise<EnvCategorySnapshot | null> {
  const files: Array<{ key: string; path: string }> =
    scope === 'global'
      ? INSTRUCTION_PRECEDENCE.map((name) => ({ key: name, path: join(piHome(), name) }))
      : scan!.instructionFiles.map((rel) => ({ key: rel, path: join(projectPath!, rel) }))

  const payload: Record<string, unknown> = {}
  for (const f of files) {
    let body: string
    try {
      body = await readFile(f.path, 'utf8')
    } catch {
      continue // absent → try the next variant (global) / omit (project has one per dir)
    }
    // Global scope is one directory: the first PRESENT file wins by precedence, even if
    // empty (Pi would load it and stop). Empty files carry no signal, so we still omit.
    if (body.trim() !== '') payload[f.key] = { body, hash: contentHash(body) }
    if (scope === 'global') break
  }
  return Object.keys(payload).length > 0 ? { category: 'instructions', payload } : null
}

// ---- repo scan -------------------------------------------------------------

/** Directory names we never descend into when scanning a repo for config. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', 'target'])

/** A directory to prune from any traversal: a hidden dir or a known build/vendor tree. */
function isPrunedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.')
}

/** Sorted directory entries; [] when the dir is missing/unreadable. */
async function dirEntries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** True when `path` is a file, resolving a symlink to its target if needed (Pi follows them). */
async function isFileLike(path: string, e: Dirent): Promise<boolean> {
  if (e.isFile()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return (await stat(path)).isFile() // follows the link
  } catch {
    return false // dangling symlink
  }
}

/** True when `path` is a directory, resolving a symlink to its target if needed. */
async function isDirLike(path: string, e: Dirent): Promise<boolean> {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return (await stat(path)).isDirectory() // follows the link
  } catch {
    return false // dangling symlink
  }
}

/**
 * One walk of the repo tree collecting everything the category readers need:
 *   - every `.pi/` dir (repo-relative) — settings + a `skills/` dir. Pi reads project
 *     config from `.pi/`, and monorepo sub-packages can carry their own.
 *   - every `.agents/` dir (repo-relative) — a `skills/` dir shared across harnesses.
 *   - the winning context file per directory (repo-relative) — Pi selects one file per
 *     directory by INSTRUCTION_PRECEDENCE, walking up from cwd loading these, so nested
 *     ones represent sessions launched from those directories.
 *
 * `.pi`/`.agents` are detected even when symlinked (shared config is commonly mounted
 * that way) but not descended into (their subtrees are skill dirs, not more config dirs).
 * General subdirectories are followed only when they are real directories — arbitrary
 * directory symlinks are not chased, avoiding escapes out of the repo and cycles.
 * Bounded by a skip-list plus all other dot-directories.
 */
export async function scanProject(repoRoot: string): Promise<ProjectScan> {
  const piDirs: string[] = []
  const agentsDirs: string[] = []
  const instructionFiles: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await dirEntries(dir)
    const fileNames = new Set<string>()
    const subdirs: Array<{ path: string; rel: string }> = []
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childPath = join(dir, e.name)
      if (e.name === '.pi' || e.name === '.agents') {
        // Register (even when symlinked); never descend — the subtree is a skill dir.
        if (await isDirLike(childPath, e)) (e.name === '.pi' ? piDirs : agentsDirs).push(childRel)
        continue
      }
      if (e.isDirectory()) {
        if (isPrunedDir(e.name)) continue
        subdirs.push({ path: childPath, rel: childRel })
      } else if (await isFileLike(childPath, e)) {
        fileNames.add(e.name)
      }
    }
    // At most one context file per directory, by precedence.
    const chosen = INSTRUCTION_PRECEDENCE.find((name) => fileNames.has(name))
    if (chosen) instructionFiles.push(rel ? `${rel}/${chosen}` : chosen)
    for (const child of subdirs) await walk(child.path, child.rel)
  }
  await walk(repoRoot, '')
  return {
    piDirs: piDirs.sort(),
    agentsDirs: agentsDirs.sort(),
    instructionFiles: instructionFiles.sort(),
  }
}
