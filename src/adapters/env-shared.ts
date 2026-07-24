import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { contentHash } from '../core/hash'

/**
 * Shared primitives for harness config readers (environment reader). Both the
 * Claude Code and OpenCode readers parse the same markdown-with-frontmatter and
 * redact the same kinds of secrets, so the byte-identical helpers live here rather
 * than being duplicated per adapter. Harness-specific logic (config-home resolution,
 * per-category source layout, allowlists) stays in each adapter's `environment.ts`.
 */

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
 * Normalize a frontmatter value into a string list, accepting the forms a
 * `tools`/`disallowedTools` field allows: a YAML block/inline list (already a
 * string[]), an inline `[a, b]`, or a comma/space-separated string (`Read, Grep Glob`).
 * Null when absent or empty.
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

/** Read + parse a JSON file; null if it's missing or unparseable (never throws). */
export async function readJsonIfExists(path: string): Promise<unknown | null> {
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

/** True when `path` is the repo root or a descendant of it. */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
}

/** True when a file or directory exists at `path`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Immediate child directory names of `dir` (non-recursive); [] if `dir` is missing.
 * A symlink whose target is a directory counts as a directory — both Claude Code and
 * OpenCode follow symlinked skill dirs (users commonly symlink skills across
 * `.claude`/`.agents`/`.opencode`), so a `Dirent.isDirectory()`-only check would
 * silently drop them.
 */
export async function listDirs(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(e.name)
    } else if (e.isSymbolicLink()) {
      try {
        if ((await stat(join(dir, e.name))).isDirectory()) out.push(e.name) // stat follows the link
      } catch {
        /* dangling symlink — skip */
      }
    }
  }
  return out
}

/** Resolve a path through symlinks to its canonical real path; the input path on error. */
export async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Strip everything credential-bearing from a URL, keeping endpoint identity:
 * protocol + host(:port) + path survive; userinfo (`user:token@`), query
 * (`?api_key=...`), and fragment are dropped. Null when the URL doesn't parse —
 * an unparseable value can't be safely redacted, so it isn't stored at all.
 */
export function redactUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return null
  }
}

/**
 * Read a markdown file into its parsed frontmatter, body, and body hash; null if the
 * file can't be read. The generic primitive under the per-category readers — each
 * applies its own field allowlist to `fm` (agents keep different fields than skills).
 */
export async function readFrontmatterFile(
  path: string,
): Promise<{ fm: Record<string, string | string[]>; body: string; bodyHash: string } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  return { fm: parseFrontmatter(frontmatter), body, bodyHash: contentHash(body) }
}

/**
 * Read one skill/command file into a { name, description?, body, bodyHash } entry.
 * `name` is the INVOKABLE identity (directory name for a SKILL.md, filename for a
 * command) — NOT the frontmatter `name`, which is display-only and per docs defaults
 * to the directory name anyway. Using the invokable name keeps it aligned with the
 * `/name` an adoption fix would reference.
 *
 * EXCEPTION — `preferFrontmatterName`: for a single-skill location (where SKILL.md
 * sits directly in the dir), docs invert the precedence: frontmatter `name` determines
 * the invocation name (stable regardless of the install dir), and the passed `name`
 * (dir basename) is only the fallback.
 */
export async function readSkillFile(
  path: string,
  name: string,
  preferFrontmatterName = false,
): Promise<Record<string, unknown> | null> {
  const read = await readFrontmatterFile(path)
  if (!read) return null
  const { fm, body, bodyHash } = read
  const resolvedName = preferFrontmatterName && typeof fm.name === 'string' ? fm.name : name
  const entry: Record<string, unknown> = { name: resolvedName, body, bodyHash }
  if (typeof fm.description === 'string') entry.description = fm.description
  return entry
}
