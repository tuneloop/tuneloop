import type { Store } from '../../store/store'

// What the user already has installed (skills / agents / mcp / plugins, from the
// environment-reader snapshots), as names + one-line descriptions — fed to the fix
// pass so it says "use/tighten your existing X" instead of guessing "install one".
// Names + descriptions only, not bodies (future: bodies, to quote/edit exact wording).
export interface EnvInventory {
  skills: string[] // "name — description"
  agents: string[]
  mcpServers: string[] // server names
  plugins: string[]
  /** Sources the inventory was drawn from (for the prompt's honesty about scope). */
  scopes: string[]
}

/**
 * Build the inventory the fix pass should reason against for one theme: the GLOBAL
 * harness config, plus — for a repo-scoped theme — that repo's own project config.
 * Uses the CURRENT snapshot (the fix is applied now, so "what you have today" is what
 * matters). Empty inventory when nothing was captured (env reader off / no snapshot).
 */
export function buildEnvInventory(store: Store, repo: string | null): EnvInventory {
  const inv: EnvInventory = { skills: [], agents: [], mcpServers: [], plugins: [], scopes: [] }
  const sources = envSources(store)
  if (sources.length === 0) return inv

  for (const source of sources) {
    // Global config always applies; a repo-scoped theme also pulls that repo's project config.
    collectScope(store, inv, source, 'global', '_global', 'global')
    if (repo && repo !== '*') {
      for (const key of projectScopeKeys(store, source, repo)) {
        collectScope(store, inv, source, 'project', key, `project ${repo}`)
      }
    }
  }

  // Stable, de-duplicated (same skill can appear global + project).
  inv.skills = uniqSorted(inv.skills)
  inv.agents = uniqSorted(inv.agents)
  inv.mcpServers = uniqSorted(inv.mcpServers)
  inv.plugins = uniqSorted(inv.plugins)
  inv.scopes = uniqSorted(inv.scopes)
  return inv
}

/** True when the fix pass has any inventory to ground against. */
export function hasInventory(inv: EnvInventory): boolean {
  return inv.skills.length + inv.agents.length + inv.mcpServers.length + inv.plugins.length > 0
}

/** Distinct harness sources that captured any environment snapshot. */
function envSources(store: Store): string[] {
  const rows = store.queryAll('SELECT DISTINCT source FROM environment_snapshots') as Array<{ source: string }>
  return rows.map((r) => r.source)
}

/**
 * Project scope_keys (repo ROOT PATHS) belonging to `repo`. Resolved via this repo's
 * sessions — a snapshot matches when a session tagged with `repo` ran at or under that
 * path — so two repos sharing a leaf name (…/app) can't leak each other's config. A
 * repo with no matching session cwd just falls back to global.
 */
function projectScopeKeys(store: Store, source: string, repo: string): string[] {
  const keys = (store.queryAll(
    `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
    source,
  ) as Array<{ scope_key: string }>).map((r) => r.scope_key)
  if (keys.length === 0) return []
  const cwds = (store.queryAll(
    `SELECT DISTINCT cwd FROM sessions WHERE repo = ? AND cwd IS NOT NULL`,
    repo,
  ) as Array<{ cwd: string }>).map((r) => r.cwd)
  // A scope_key matches when some session of this repo ran at or under that root path.
  return keys.filter((key) => cwds.some((cwd) => cwd === key || cwd.startsWith(key + '/')))
}

function collectScope(store: Store, inv: EnvInventory, source: string, scope: string, scopeKey: string, label: string): void {
  let touched = false
  touched = named(store, source, scope, scopeKey, 'skills', 'skills', inv.skills) || touched
  touched = named(store, source, scope, scopeKey, 'agents', 'agents', inv.agents) || touched
  touched = mcp(store, source, scope, scopeKey, inv.mcpServers) || touched
  touched = plugins(store, source, scope, scopeKey, inv.plugins) || touched
  if (touched) inv.scopes.push(label)
}

/** Pull `{ <listKey>: [{name, description?}] }` into "name — description" lines. */
function named(store: Store, source: string, scope: string, scopeKey: string, category: string, listKey: string, out: string[]): boolean {
  const payload = current(store, source, scope, scopeKey, category)
  const list = payload && Array.isArray((payload as Record<string, unknown>)[listKey]) ? ((payload as Record<string, unknown>)[listKey] as unknown[]) : null
  if (!list) return false
  for (const item of list) {
    const o = item as Record<string, unknown>
    const name = typeof o?.name === 'string' ? o.name : null
    if (!name) continue
    const desc = typeof o?.description === 'string' ? o.description.trim() : ''
    out.push(desc ? `${name} — ${desc}` : name)
  }
  return list.length > 0
}

/** MCP payload is `{ "<file>": { servers: { <name>: {...} } } }` across scopes. */
function mcp(store: Store, source: string, scope: string, scopeKey: string, out: string[]): boolean {
  const payload = current(store, source, scope, scopeKey, 'mcp') as Record<string, unknown> | null
  if (!payload) return false
  let any = false
  for (const file of Object.values(payload)) {
    const servers = (file as Record<string, unknown>)?.servers
    if (servers && typeof servers === 'object') {
      for (const name of Object.keys(servers as Record<string, unknown>)) { out.push(name); any = true }
    }
  }
  return any
}

/**
 * ENABLED plugins. The settings payload is keyed BY FILE — `{ "<file>": { plugins:
 * { "<name@marketplace>": boolean } } }` — so plugins live one level down, under each
 * settings file. We only surface plugins whose flag is `true` (a `false` entry means
 * the user explicitly DISABLED it — recommending it would be wrong).
 */
function plugins(store: Store, source: string, scope: string, scopeKey: string, out: string[]): boolean {
  const payload = current(store, source, scope, scopeKey, 'settings') as Record<string, unknown> | null
  if (!payload) return false
  let any = false
  for (const file of Object.values(payload)) {
    const p = (file as Record<string, unknown>)?.plugins
    if (!p || typeof p !== 'object') continue
    for (const [name, enabled] of Object.entries(p as Record<string, unknown>)) {
      if (enabled === true) { out.push(name); any = true }
    }
  }
  return any
}

function current(store: Store, source: string, scope: string, scopeKey: string, category: string): unknown {
  return store.envSnapshotCurrent(source, scope, scopeKey, category)?.payload ?? null
}

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort()
}
