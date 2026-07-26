import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../../store/db'
import { Store } from '../../store/store'
import { buildEnvInventory, hasInventory } from './env-inventory'

let dir: string
let n = 0
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'env-inv-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const db = openDb(join(dir, `t${n++}.db`))
  return { db, store: new Store(db) }
}

/** Seed a session so a repo's project scope resolves via cwd (as production does). */
function seedSessionCwd(db: ReturnType<typeof openDb>, id: string, repo: string, cwd: string) {
  db.prepare('INSERT OR IGNORE INTO sessions (id, session_id, source, provider, started_at, content_hash, repo, cwd) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, id, 'claude-code', 'anthropic', new Date().toISOString(), `h-${id}`, repo, cwd)
}

describe('buildEnvInventory', () => {
  it('is empty (and hasInventory=false) when no snapshots were captured', () => {
    const { store } = setup()
    const inv = buildEnvInventory(store, null)
    expect(hasInventory(inv)).toBe(false)
    expect(inv.skills).toEqual([])
  })

  it('collects global skills/agents as "name — description", MCP servers, and ENABLED plugins only', () => {
    const { store } = setup()
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'skills',
      payload: { skills: [{ name: 'playwright', description: 'browser testing' }, { name: 'gstack' }] } })
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'agents',
      payload: { agents: [{ name: 'codex-rescue', description: 'hand off to Codex' }] } })
    // Real settings shape: keyed by FILE, plugins are `{ "name@marketplace": boolean }`.
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'settings',
      payload: { 'settings.json': { plugins: { 'codex@openai-codex': true, 'disabled@mkt': false } } } })
    const inv = buildEnvInventory(store, null)
    expect(hasInventory(inv)).toBe(true)
    expect(inv.skills).toContain('playwright — browser testing')
    expect(inv.skills).toContain('gstack') // no description → bare name
    expect(inv.agents).toContain('codex-rescue — hand off to Codex')
    expect(inv.plugins).toContain('codex@openai-codex')
    expect(inv.plugins).not.toContain('disabled@mkt') // a disabled plugin is NOT "installed"
    expect(inv.scopes).toContain('global')
  })

  it('adds a repo-scoped theme\'s own project config (resolved via a session cwd), plus MCP servers', () => {
    const { db, store } = setup()
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'skills',
      payload: { skills: [{ name: 'global-skill' }] } })
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: '/Users/x/work/app', category: 'mcp',
      payload: { '.mcp.json': { servers: { github: { type: 'stdio' } } } } })
    seedSessionCwd(db, 's1', 'acme/app', '/Users/x/work/app') // ties repo acme/app → that root
    const inv = buildEnvInventory(store, 'acme/app')
    expect(inv.skills).toContain('global-skill')
    expect(inv.mcpServers).toContain('github')
    expect(inv.scopes).toContain('project acme/app')
  })

  it('does NOT leak another repo\'s project config when two repos share a directory leaf', () => {
    const { db, store } = setup()
    // Two repos both ending in "app", at different roots, each with its own MCP.
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: '/Users/x/work/app', category: 'mcp',
      payload: { '.mcp.json': { servers: { mine: { type: 'stdio' } } } } })
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: '/Users/x/side/app', category: 'mcp',
      payload: { '.mcp.json': { servers: { theirs: { type: 'stdio' } } } } })
    seedSessionCwd(db, 's1', 'acme/app', '/Users/x/work/app')
    seedSessionCwd(db, 's2', 'other/app', '/Users/x/side/app')
    const inv = buildEnvInventory(store, 'acme/app') // both leaves are "app"
    expect(inv.mcpServers).toContain('mine')
    expect(inv.mcpServers).not.toContain('theirs') // the collision leak the fix prevents
  })

  it('a repo with no matching session cwd falls back to global (no project scope)', () => {
    const { store } = setup()
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: '/Users/x/work/app', category: 'mcp',
      payload: { '.mcp.json': { servers: { github: { type: 'stdio' } } } } })
    const inv = buildEnvInventory(store, 'acme/app') // no session seeded → can't resolve the path
    expect(inv.mcpServers).not.toContain('github')
  })

  it('a global theme ignores all project scopes', () => {
    const { db, store } = setup()
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: '/Users/x/work/app', category: 'skills',
      payload: { skills: [{ name: 'project-only' }] } })
    seedSessionCwd(db, 's1', 'acme/app', '/Users/x/work/app')
    const inv = buildEnvInventory(store, null) // global theme
    expect(inv.skills).not.toContain('project-only')
  })

  it('ignores tombstoned (deleted-config) snapshots without crashing', () => {
    const { store } = setup()
    store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'skills', payload: null })
    const inv = buildEnvInventory(store, null)
    expect(hasInventory(inv)).toBe(false)
  })
})
