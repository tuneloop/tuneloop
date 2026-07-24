import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { buildCards, capIdentity, classify, mapScopeKeysToRepos, parseInstalledMcp, parseInstalledSkills, queryInvoked, skillMatches, unusedCapabilities, type Classified, type InstalledCap, type InvokedCap } from './unused-capabilities'
import { insightId, type DetectorContext, type EvidenceRef, type InsightInput } from '../core/detector'

const DAY_MS = 86_400_000

// queryAll() reopens the db file read-only, so tests need a real file, not :memory:.
let dir: string
let dbN = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'unused-caps-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setupDb() {
  const db = openDb(join(dir, `t${dbN++}.db`))
  const store = new Store(db)
  return { db, store }
}

interface ToolSpec {
  name: string
  action: 'mcp_call' | 'skill' | 'other'
  sidechain?: boolean
  tsMs?: number // call timestamp; defaults to the session start (decouple to exercise the event-ts window)
}

/** Seed one session and its tool calls; repo defaults to 'o/r', null = no git repo. */
function seedSession(
  db: ReturnType<typeof openDb>,
  id: string,
  tools: ToolSpec[],
  over: { repo?: string | null; startedMs?: number } = {},
) {
  const startMs = over.startedMs ?? Date.now() - DAY_MS
  const repo = over.repo === undefined ? 'o/r' : over.repo
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)').run(
    id, id, 'claude-code', 'anthropic', repo, '/repo', new Date(startMs).toISOString(),
  )
  const ins = db.prepare(
    'INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?,?,?,?,1,0,?,?)',
  )
  tools.forEach((t, idx) => ins.run(id, idx, t.name, t.action, t.sidechain ? 1 : 0, new Date(t.tsMs ?? startMs).toISOString()))
}

const byKey = (caps: InvokedCap[]) => new Map(caps.map((c) => [`${c.kind}:${c.name}:${c.repo}`, c]))

describe('parseInstalledMcp', () => {
  it('unions server names across every source file', () => {
    // The exact shape the environment reader emits for the `mcp` category.
    const payload = {
      '.mcp.json': { servers: { atlassian: { type: 'sse', url: 'https://x' } } },
      '.claude.json': { servers: { postgres: { type: 'stdio' }, sentry: { type: 'http', url: 'https://y' } } },
    }
    expect(parseInstalledMcp(payload).sort()).toEqual(['atlassian', 'postgres', 'sentry'])
  })

  it('dedupes a server present in more than one file', () => {
    const payload = {
      '.mcp.json': { servers: { shared: {} } },
      '.claude.json': { servers: { shared: {} } },
    }
    expect(parseInstalledMcp(payload)).toEqual(['shared'])
  })

  it('returns [] for missing, non-object, or malformed payloads', () => {
    expect(parseInstalledMcp(null)).toEqual([])
    expect(parseInstalledMcp(undefined)).toEqual([])
    expect(parseInstalledMcp('nope')).toEqual([])
    expect(parseInstalledMcp({ '.mcp.json': {} })).toEqual([]) // no servers key
    expect(parseInstalledMcp({ '.mcp.json': { servers: null } })).toEqual([])
  })
})

describe('parseInstalledSkills', () => {
  it('extracts skill names in order', () => {
    const payload = {
      skills: [
        { name: 'deploy-staging', body: '...', bodyHash: 'a' },
        { name: 'review', description: 'x', body: '...', bodyHash: 'b' },
      ],
      count: 2,
    }
    expect(parseInstalledSkills(payload)).toEqual(['deploy-staging', 'review'])
  })

  it('skips entries with a missing or non-string name', () => {
    const payload = { skills: [{ name: 'ok' }, { body: 'no name' }, { name: 42 }], count: 3 }
    expect(parseInstalledSkills(payload)).toEqual(['ok'])
  })

  it('returns [] for missing, non-object, or malformed payloads', () => {
    expect(parseInstalledSkills(null)).toEqual([])
    expect(parseInstalledSkills(undefined)).toEqual([])
    expect(parseInstalledSkills('nope')).toEqual([])
    expect(parseInstalledSkills({})).toEqual([]) // no skills key
    expect(parseInstalledSkills({ skills: 'not-an-array' })).toEqual([])
  })
})

describe('queryInvoked', () => {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString()

  it('extracts the server (2nd __ segment) from an mcp tool name', () => {
    const { db, store } = setupDb()
    seedSession(db, 's1', [
      { name: 'mcp__atlassian__getJiraIssue', action: 'mcp_call' },
      { name: 'mcp__atlassian__searchJira', action: 'mcp_call' },
      { name: 'mcp__postgres__query', action: 'mcp_call' },
    ])
    const m = byKey(queryInvoked(store, since))
    // Both atlassian tools collapse to the one server, in the one session.
    expect(m.get('mcp:atlassian:o/r')).toMatchObject({ kind: 'mcp', name: 'atlassian', sessions: 1 })
    expect(m.get('mcp:postgres:o/r')).toMatchObject({ name: 'postgres', sessions: 1 })
    expect([...m.values()]).toHaveLength(2)
  })

  it('keeps the specific skill name for skill calls', () => {
    const { db, store } = setupDb()
    seedSession(db, 's1', [{ name: 'frontend-design:frontend-design', action: 'skill' }])
    const m = byKey(queryInvoked(store, since))
    expect(m.get('skill:frontend-design:frontend-design:o/r')).toMatchObject({ kind: 'skill', sessions: 1 })
  })

  it('counts DISTINCT sessions, not call volume', () => {
    const { db, store } = setupDb()
    // One session calls sentry 3x; another once → 2 sessions, not 4 calls.
    seedSession(db, 's1', [
      { name: 'mcp__sentry__a', action: 'mcp_call' },
      { name: 'mcp__sentry__b', action: 'mcp_call' },
      { name: 'mcp__sentry__c', action: 'mcp_call' },
    ])
    seedSession(db, 's2', [{ name: 'mcp__sentry__a', action: 'mcp_call' }])
    const m = byKey(queryInvoked(store, since))
    expect(m.get('mcp:sentry:o/r')!.sessions).toBe(2)
  })

  it('groups the same capability separately per repo, and keeps null-repo usage', () => {
    const { db, store } = setupDb()
    seedSession(db, 's1', [{ name: 'deploy', action: 'skill' }], { repo: 'web' })
    seedSession(db, 's2', [{ name: 'deploy', action: 'skill' }], { repo: 'api' })
    seedSession(db, 's3', [{ name: 'deploy', action: 'skill' }], { repo: null })
    const m = byKey(queryInvoked(store, since))
    expect(m.get('skill:deploy:web')!.sessions).toBe(1)
    expect(m.get('skill:deploy:api')!.sessions).toBe(1)
    expect(m.get('skill:deploy:null')!.sessions).toBe(1)
  })

  it('ignores sidechain calls, non-cap actions, and out-of-window sessions', () => {
    const { db, store } = setupDb()
    seedSession(db, 's1', [
      { name: 'mcp__used__t', action: 'mcp_call' },
      { name: 'mcp__sub__t', action: 'mcp_call', sidechain: true },
      { name: 'Read', action: 'other' },
    ])
    seedSession(db, 'old', [{ name: 'mcp__stale__t', action: 'mcp_call' }], { startedMs: Date.now() - 60 * DAY_MS })
    const m = byKey(queryInvoked(store, since))
    expect([...m.keys()]).toEqual(['mcp:used:o/r'])
  })

  it('drops a malformed mcp name with no server segment', () => {
    const { db, store } = setupDb()
    seedSession(db, 's1', [{ name: 'mcp__nobreak', action: 'mcp_call' }])
    expect(queryInvoked(store, since)).toEqual([])
  })

  it('windows by the tool call\'s own timestamp, not the session start', () => {
    const { db, store } = setupDb()
    // A long-running session that began 40 days ago (outside the window) but invoked the
    // server yesterday. The old started_at scan dropped it — and would then read the
    // still-live server as "never used"; the last_invoked_at window keeps it.
    seedSession(db, 's1', [{ name: 'mcp__live__t', action: 'mcp_call', tsMs: Date.now() - DAY_MS }], {
      startedMs: Date.now() - 40 * DAY_MS,
    })
    const m = byKey(queryInvoked(store, since))
    expect(m.get('mcp:live:o/r')).toMatchObject({ kind: 'mcp', name: 'live' })
    expect([...m.keys()]).toEqual(['mcp:live:o/r'])
  })
})

describe('mapScopeKeysToRepos', () => {
  it('maps each distinct path to its basename', () => {
    const { byRepo, ambiguous } = mapScopeKeysToRepos([
      '/Users/x/git/tuneloop',
      '/Users/x/git/resolveml',
    ])
    expect(ambiguous.size).toBe(0)
    expect(byRepo.get('tuneloop')).toBe('/Users/x/git/tuneloop')
    expect(byRepo.get('resolveml')).toBe('/Users/x/git/resolveml')
  })

  it('marks a basename backed by two distinct paths ambiguous and omits it', () => {
    const { byRepo, ambiguous } = mapScopeKeysToRepos([
      '/Users/x/work/api',
      '/Users/x/personal/api',
      '/Users/x/git/web',
    ])
    expect(ambiguous.has('api')).toBe(true)
    expect(byRepo.has('api')).toBe(false)
    // The unambiguous one still resolves.
    expect(byRepo.get('web')).toBe('/Users/x/git/web')
  })

  it('treats a repeated identical path as one (not a collision)', () => {
    const { byRepo, ambiguous } = mapScopeKeysToRepos([
      '/Users/x/git/tuneloop',
      '/Users/x/git/tuneloop',
    ])
    expect(ambiguous.size).toBe(0)
    expect(byRepo.get('tuneloop')).toBe('/Users/x/git/tuneloop')
  })

  it('returns empty maps for no scope keys', () => {
    const { byRepo, ambiguous } = mapScopeKeysToRepos([])
    expect(byRepo.size).toBe(0)
    expect(ambiguous.size).toBe(0)
  })
})

describe('skillMatches', () => {
  it('matches an exact name', () => {
    expect(skillMatches('deploy', 'deploy')).toBe(true)
  })

  it('matches a plugin-namespaced invocation on its last segment', () => {
    expect(skillMatches('frontend-design', 'frontend-design:frontend-design')).toBe(true)
    expect(skillMatches('deploy', 'my-plugin:deploy')).toBe(true)
  })

  it('does not match different skills', () => {
    expect(skillMatches('deploy', 'build')).toBe(false)
    expect(skillMatches('deploy', 'my-plugin:build')).toBe(false)
  })

  it('does not match on a plugin id alone', () => {
    // installed 'my-plugin' must not match an invocation 'my-plugin:deploy'
    expect(skillMatches('my-plugin', 'my-plugin:deploy')).toBe(false)
  })
})

describe('classify', () => {
  const mcp = (name: string, scope: 'global' | 'project', repo?: string): InstalledCap => ({ kind: 'mcp', name, scope, repo })
  const skill = (name: string, scope: 'global' | 'project', repo?: string): InstalledCap => ({ kind: 'skill', name, scope, repo })
  const inv = (kind: 'mcp' | 'skill', name: string, repo: string | null, sessions = 1): InvokedCap => ({ kind, name, repo, sessions })
  // Enough sessions to clear MIN_SESSIONS (10).
  const plenty = new Map([['web', 20], ['api', 15], ['cli', 12]])
  const only = (c: Classified[]) => c.map((x) => ({ name: x.cap.name, verdict: x.verdict, scopeToRepos: x.scopeToRepos }))

  it('global + never used anywhere + enough sessions → remove', () => {
    expect(only(classify([mcp('sentry', 'global')], [], plenty))).toEqual([
      { name: 'sentry', verdict: 'remove', scopeToRepos: undefined },
    ])
  })

  it('global + never used but too few sessions → silent (thin data, not disuse)', () => {
    expect(classify([mcp('sentry', 'global')], [], new Map([['web', 5]]))).toEqual([])
  })

  it('global + used in a minority of repos (2 of 20) → scope to exactly those repos', () => {
    const many = new Map(Array.from({ length: 20 }, (_, i) => [`r${i}`, 12]))
    const invoked = [inv('mcp', 'sentry', 'r3'), inv('mcp', 'sentry', 'r7')]
    expect(only(classify([mcp('sentry', 'global')], invoked, many))).toEqual([
      { name: 'sentry', verdict: 'scope', scopeToRepos: ['r3', 'r7'] },
    ])
  })

  it('global + used in more repos than the cap (6 of 20) → keep', () => {
    const many = new Map(Array.from({ length: 20 }, (_, i) => [`r${i}`, 12]))
    const invoked = Array.from({ length: 6 }, (_, i) => inv('mcp', 'sentry', `r${i}`))
    expect(classify([mcp('sentry', 'global')], invoked, many)).toEqual([])
  })

  it('global + used in more than half of repos → keep (genuinely shared)', () => {
    // 2 of 3 observed repos = 67% > 50% share → shared.
    const invoked = [inv('mcp', 'sentry', 'web'), inv('mcp', 'sentry', 'api')]
    expect(classify([mcp('sentry', 'global')], invoked, plenty)).toEqual([])
  })

  it('global + used in one of two repos (50% share) → scope', () => {
    // 1 of 2 = exactly 50%, which is within the ≤ 50% share bound.
    const invoked = [inv('mcp', 'sentry', 'web')]
    expect(only(classify([mcp('sentry', 'global')], invoked, new Map([['web', 20], ['api', 15]])))).toEqual([
      { name: 'sentry', verdict: 'scope', scopeToRepos: ['web'] },
    ])
  })

  it('global + used only in a null-repo session → keep, never remove (used but unattributable)', () => {
    const invoked = [inv('skill', 'deploy', null)]
    expect(classify([skill('deploy', 'global')], invoked, plenty)).toEqual([])
  })

  it('global + used in one repo AND a null-repo session → keep, do NOT scope', () => {
    // Scoping to web would break the unattributed usage — stay safe.
    const invoked = [inv('mcp', 'sentry', 'web'), inv('mcp', 'sentry', null)]
    expect(classify([mcp('sentry', 'global')], invoked, plenty)).toEqual([])
  })

  it('project + never used in its repo + enough sessions → remove', () => {
    expect(only(classify([mcp('pg', 'project', 'web')], [], plenty))).toEqual([
      { name: 'pg', verdict: 'remove', scopeToRepos: undefined },
    ])
  })

  it('project + used in its own repo → keep', () => {
    const invoked = [inv('mcp', 'pg', 'web')]
    expect(classify([mcp('pg', 'project', 'web')], invoked, plenty)).toEqual([])
  })

  it('project + used only in a DIFFERENT repo → remove from this one', () => {
    // Installed in web, but only ever used in api → dead weight in web.
    const invoked = [inv('mcp', 'pg', 'api')]
    expect(only(classify([mcp('pg', 'project', 'web')], invoked, plenty))).toEqual([
      { name: 'pg', verdict: 'remove', scopeToRepos: undefined },
    ])
  })

  it('project + never used but its repo has too few sessions → silent', () => {
    expect(classify([mcp('pg', 'project', 'web')], [], new Map([['web', 5]]))).toEqual([])
  })

  it('matches a plugin-namespaced skill invocation as use', () => {
    const many = new Map(Array.from({ length: 10 }, (_, i) => [`r${i}`, 12]))
    const invoked = [inv('skill', 'frontend-design:frontend-design', 'r2')]
    // Used in one of ten repos → scope, not remove (proves the name matched).
    expect(only(classify([skill('frontend-design', 'global')], invoked, many))).toEqual([
      { name: 'frontend-design', verdict: 'scope', scopeToRepos: ['r2'] },
    ])
  })

  it('does not cross kinds: a skill named like a server is independent', () => {
    // An mcp server 'x' used; an installed skill 'x' never used → skill still flagged.
    const invoked = [inv('mcp', 'x', 'web')]
    expect(only(classify([skill('x', 'global')], invoked, plenty))).toEqual([
      { name: 'x', verdict: 'remove', scopeToRepos: undefined },
    ])
  })
})

describe('buildCards', () => {
  const gcap = (kind: 'mcp' | 'skill', name: string): InstalledCap => ({ kind, name, scope: 'global' })
  const pcap = (kind: 'mcp' | 'skill', name: string, repo: string): InstalledCap => ({ kind, name, scope: 'project', repo })
  const remove = (cap: InstalledCap): Classified => ({ cap, verdict: 'remove' })
  const scope = (cap: InstalledCap, repos: string[]): Classified => ({ cap, verdict: 'scope', scopeToRepos: repos })
  const noInv = new Map<string, EvidenceRef[]>() // no scope-invocation evidence supplied

  it('returns no cards for no verdicts', () => {
    expect(buildCards([], noInv)).toEqual([])
  })

  it('folds globals and every project repo into one cross-repo card', () => {
    const classified = [
      remove(gcap('mcp', 'sentry')),
      scope(gcap('skill', 'frontend-design'), ['web']),
      remove(pcap('mcp', 'pg', 'web')),
      remove(pcap('skill', 'lint', 'api')),
    ]
    const cards = buildCards(classified, noInv)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.repo).toBe('*')
    expect(cards[0]!.signalKey).toBe('unused-caps')
    expect(cards[0]!.fix.type).toBe('fix-prompt')
    expect(cards[0]!.count).toBe(4) // total flagged items across all scopes
    // Fix carries the global section plus a per-repo removal section for each project.
    expect(cards[0]!.fix.content).toContain('Remove from the global config:')
    expect(cards[0]!.fix.content).toContain("Remove from api's config:")
    expect(cards[0]!.fix.content).toContain("Remove from web's config:")
  })

  it('global snippet lists removals and scoping moves with target repos', () => {
    const cards = buildCards(
      [remove(gcap('mcp', 'sentry')), scope(gcap('skill', 'frontend-design'), ['web', 'docs'])],
      noInv,
    )
    const global = cards.find((c) => c.repo === '*')!
    expect(global.fix.content).toContain('Remove from the global config:')
    expect(global.fix.content).toContain('- MCP server: sentry')
    expect(global.fix.content).toContain('Move out of global config')
    expect(global.fix.content).toContain('- skill: frontend-design → move to web, docs')
  })

  it('names the project repo and lists its capabilities in the fix', () => {
    const cards = buildCards([remove(pcap('mcp', 'pg', 'web'))], noInv)
    const card = cards[0]!
    expect(card.repo).toBe('*')
    expect(card.description).toContain('web')
    expect(card.fix.content).toContain("Remove from web's config:")
    expect(card.fix.content).toContain('- MCP server: pg')
  })

  it('severity is medium at 3+ items, low below', () => {
    const three = buildCards([remove(gcap('mcp', 'a')), remove(gcap('mcp', 'b')), remove(gcap('mcp', 'c'))], noInv)
    expect(three[0]!.severity).toBe('medium')
    const two = buildCards([remove(gcap('mcp', 'a')), remove(gcap('mcp', 'b'))], noInv)
    expect(two[0]!.severity).toBe('low')
  })

  it('scope evidence is the capability’s invocations; a co-present removal adds none', () => {
    const cap = gcap('mcp', 'sentry')
    const scopeInv = new Map<string, EvidenceRef[]>([[capIdentity(cap), [
      { sessionId: 'inv1', turnIdx: 4, note: 'web · uses MCP server sentry' },
      { sessionId: 'inv2', note: 'web · uses MCP server sentry' },
    ]]])
    // The project-remove (pg/api) contributes no evidence — only the scope invocations show.
    const cards = buildCards([scope(cap, ['web']), remove(pcap('mcp', 'pg', 'api'))], scopeInv)
    expect(cards.find((c) => c.repo === '*')!.evidence).toEqual([
      { sessionId: 'inv1', turnIdx: 4, note: 'web · uses MCP server sentry' },
      { sessionId: 'inv2', note: 'web · uses MCP server sentry' },
    ])
  })

  it('caps evidence at 10 invocation sessions', () => {
    const cap = gcap('mcp', 'sentry')
    const refs = Array.from({ length: 25 }, (_, i) => ({ sessionId: `s${i}`, note: 'web · uses MCP server sentry' }))
    const cards = buildCards([scope(cap, ['web'])], new Map([[capIdentity(cap), refs]]))
    expect(cards.find((c) => c.repo === '*')!.evidence).toHaveLength(10)
  })

  it('a removal-only card has no evidence at all', () => {
    const cards = buildCards([remove(gcap('mcp', 'sentry')), remove(pcap('mcp', 'pg', 'web'))], noInv)
    expect(cards[0]!.evidence).toEqual([])
  })

  it('emits a fix-prompt carrying the adoption marker', () => {
    const fix = buildCards([remove(gcap('mcp', 'sentry'))], noInv)[0]!.fix
    expect(fix.type).toBe('fix-prompt')
    // The marker lets the fix session self-identify so the insight can flip to adopted.
    expect(fix.content).toContain(`tuneloop-fix: ${insightId('unused-capabilities', '*', 'unused-caps')}`)
    // The concrete config edit still reads through — it IS the agent's task.
    expect(fix.content).toContain('- MCP server: sentry')
  })

  it('the fix-prompt addresses the agent, not the user (no second-person "your")', () => {
    // A scope verdict exercises the "used in … repos" diagnosis; a global + a project
    // removal exercise both config sections — every phrase that reaches the prompt.
    const classified = [remove(gcap('mcp', 'sentry')), scope(gcap('skill', 'fd'), ['web']), remove(pcap('mcp', 'pg', 'api'))]
    const content = buildCards(classified, noInv)[0]!.fix.content
    expect(content).not.toMatch(/\byour\b/i)
  })

  it('carries no token or dollar figures in any copy', () => {
    const cards = buildCards(
      [remove(gcap('mcp', 'sentry')), scope(gcap('skill', 'fd'), ['web']), remove(pcap('mcp', 'pg', 'api'))],
      noInv,
    )
    for (const c of cards) {
      const text = `${c.title} ${c.description} ${c.fix.label} ${c.fix.content}`
      expect(text).not.toMatch(/\$|\btokens?\b|\d+\s*(k|K|tok)/)
    }
  })
})

describe('unusedCapabilities.run (end to end)', () => {
  const ctxFor = (store: Store): DetectorContext =>
    ({ store, log: { debug() {}, info() {}, warn() {} }, llmEnabled: false, llm: null }) as unknown as DetectorContext
  const run = (store: Store) => unusedCapabilities.run(ctxFor(store)) as InsightInput[]

  // Seed N sessions in a repo, each optionally invoking some capabilities.
  // `invocations`: [{ action, name }] applied to EVERY seeded session.
  function seedRepo(
    db: ReturnType<typeof openDb>,
    repo: string | null,
    count: number,
    invocations: Array<{ action: 'mcp_call' | 'skill'; name: string }> = [],
    idPrefix = repo ?? 'norepo',
  ) {
    const startMs = Date.now() - DAY_MS
    const sIns = db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)')
    const tIns = db.prepare('INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?,?,?,?,1,0,0,?)')
    for (let i = 0; i < count; i++) {
      const id = `${idPrefix}-${i}`
      sIns.run(id, id, 'claude-code', 'anthropic', repo, '/repo', new Date(startMs).toISOString())
      invocations.forEach((iv, idx) => tIns.run(id, idx, iv.name, iv.action, new Date(startMs).toISOString()))
    }
  }

  // Config first observed well past the removal-tenure cutoff (10 days): a never-used
  // capability seen this long ago is eligible for a remove verdict.
  const OLD = new Date(Date.now() - 40 * DAY_MS).toISOString()
  // Config first observed today: inside the tenure cutoff, so the removal gate holds
  // fire (used by the fresh-install test).
  const NEW = new Date().toISOString()

  const installGlobalMcp = (store: Store, servers: string[], capturedAt = OLD) =>
    store.recordEnvSnapshot({
      source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'mcp',
      payload: { '.claude.json': { servers: Object.fromEntries(servers.map((s) => [s, { type: 'stdio' }])) } },
    }, capturedAt)
  const installGlobalSkills = (store: Store, names: string[], capturedAt = OLD) =>
    store.recordEnvSnapshot({
      source: 'claude-code', scope: 'global', scopeKey: '_global', category: 'skills',
      payload: { skills: names.map((n) => ({ name: n, body: 'x', bodyHash: 'h' })), count: names.length },
    }, capturedAt)
  const installProjectMcp = (store: Store, rootPath: string, servers: string[], capturedAt = OLD) =>
    store.recordEnvSnapshot({
      source: 'claude-code', scope: 'project', scopeKey: rootPath, category: 'mcp',
      payload: { '.mcp.json': { servers: Object.fromEntries(servers.map((s) => [s, { type: 'stdio' }])) } },
    }, capturedAt)

  it('returns nothing when no config snapshots have been captured', () => {
    const { db, store } = setupDb()
    seedRepo(db, 'web', 20)
    expect(run(store)).toEqual([])
  })

  it('persists cleanly — the fix-prompt marker id matches the insight id (no throw)', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 12)
    const cards = run(store)
    expect(cards).toHaveLength(1)
    // persistInsights throws if a fix-prompt does not embed its own (detector, repo,
    // signalKey) id — this locks the DETECTOR/SIGNAL_KEY/repo triple against drift.
    expect(() => store.persistInsights('unused-capabilities', 1, cards)).not.toThrow()
    expect(store.insightStatus('unused-capabilities', '*', 'unused-caps')?.state).toBe('surfaced')
  })

  it('flags a global server never used, once past the session minimum', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 12) // ≥ MIN_SESSIONS
    const cards = run(store)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ repo: '*', signalKey: 'unused-caps', count: 1 })
    expect(cards[0]!.fix.content).toContain('- MCP server: sentry')
  })

  it('stamps last-seen from the most recent examined session, not the analyze run', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 12)
    // Push one session's start later than the others (seedRepo uses now − 1 day) but
    // still in window; it becomes MAX(started_at) → the card's last-seen. (No
    // first-seen for a structural finding.)
    const latest = new Date(Date.now() - DAY_MS / 2).toISOString()
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(latest, 'web-0')
    const card = run(store)[0]!
    expect(card.lastSeenAt).toBe(latest)
    expect(card.firstSeenAt).toBeUndefined()
  })

  it('stays silent when the global server is unused but sessions are too few', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 5) // < MIN_SESSIONS
    expect(run(store)).toEqual([])
  })

  it('does not flag a freshly-installed server for removal', () => {
    const { db, store } = setupDb()
    // First observed today — inside the tenure cutoff. Its absence from the older
    // sessions is not disuse (it didn't exist then), so the removal gate holds fire.
    installGlobalMcp(store, ['sentry'], NEW)
    seedRepo(db, 'web', 20) // plenty of sessions, but all predate the install
    expect(run(store)).toEqual([])
  })

  it('flags a server observed installed past the tenure cutoff', () => {
    const { db, store } = setupDb()
    // First observed 40 days ago plus a fresh no-change re-capture: the as-of read at
    // the 10-day cutoff still finds the old row, so the capability is removal-eligible.
    installGlobalMcp(store, ['sentry'], OLD)
    installGlobalMcp(store, ['sentry'], NEW)
    seedRepo(db, 'web', 12)
    expect(run(store)).toHaveLength(1)
  })

  it('flags a server observed 15 days ago — tenure (10d) is shorter than the session window (30d)', () => {
    const { db, store } = setupDb()
    // Past the 10-day tenure cutoff but well inside the 30-day session window: eligible.
    installGlobalMcp(store, ['sentry'], new Date(Date.now() - 15 * DAY_MS).toISOString())
    seedRepo(db, 'web', 12)
    expect(run(store)).toHaveLength(1)
  })

  it('scopes a global server used in a minority of repos to those repos', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 8, [{ action: 'mcp_call', name: 'mcp__sentry__issues' }])
    seedRepo(db, 'api', 8)
    seedRepo(db, 'cli', 8)
    seedRepo(db, 'docs', 8) // used in 1 of 4 repos → minority
    const global = run(store).find((c) => c.repo === '*')!
    expect(global.fix.content).toContain('- MCP server: sentry → move to web')
  })

  it('scope evidence points at the sessions that invoked the capability, noting it and the repo', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 8, [{ action: 'mcp_call', name: 'mcp__sentry__issues' }])
    seedRepo(db, 'api', 8)
    seedRepo(db, 'cli', 8)
    seedRepo(db, 'docs', 8) // used in 1 of 4 repos → scope to web
    const global = run(store).find((c) => c.repo === '*')!
    expect(global.fix.content).toContain('- MCP server: sentry → move to web')
    // Evidence is the web sessions that actually ran sentry, not arbitrary recent ones.
    expect(global.evidence.length).toBeGreaterThan(0)
    expect(global.evidence.every((e) => e.sessionId.startsWith('web-'))).toBe(true)
    expect(global.evidence.every((e) => e.note === 'web · uses MCP server sentry')).toBe(true)
    expect(global.evidence.every((e) => e.turnIdx === undefined)).toBe(true) // no block mapping seeded
  })

  it('lands scope evidence on the invocation’s block turn when the call is mapped', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 8, [{ action: 'mcp_call', name: 'mcp__sentry__x' }])
    seedRepo(db, 'api', 8)
    seedRepo(db, 'cli', 8)
    seedRepo(db, 'docs', 8)
    // web-0's sentry call (tool_calls.idx 0) sits in a block opening at user-turn seq 7.
    db.prepare('INSERT INTO blocks (session_id, idx, start_seq, end_seq, boundary_kind, producer) VALUES (?,?,?,?,?,?)')
      .run('web-0', 0, 7, 12, 'user_turn', 'test')
    db.prepare('INSERT INTO block_tool (session_id, tool_idx, block_idx, producer) VALUES (?,?,?,?)')
      .run('web-0', 0, 0, 'test')
    const global = run(store).find((c) => c.repo === '*')!
    const web0 = global.evidence.find((e) => e.sessionId === 'web-0')!
    expect(web0.turnIdx).toBe(7)
  })

  it('keeps a global server used across most repos', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    seedRepo(db, 'web', 8, [{ action: 'mcp_call', name: 'mcp__sentry__x' }])
    seedRepo(db, 'api', 8, [{ action: 'mcp_call', name: 'mcp__sentry__x' }]) // 2 of 2 → shared
    expect(run(store)).toEqual([])
  })

  it('resolves a prior card once nothing is flagged and the window has enough sessions', () => {
    const { db, store } = setupDb()
    store.persistInsights('unused-capabilities', 1, [{
      signalKey: 'unused-caps', repo: '*', severity: 'medium', title: 'stale', description: 'stale',
      evidence: [], count: 3, fix: { type: 'behavioral-nudge', label: 'x', content: 'y' },
    }])
    installGlobalMcp(store, ['sentry'])
    // sentry now used across both repos → shared → nothing flagged. 16 sessions ≥ MIN_SESSIONS.
    seedRepo(db, 'web', 8, [{ action: 'mcp_call', name: 'mcp__sentry__x' }])
    seedRepo(db, 'api', 8, [{ action: 'mcp_call', name: 'mcp__sentry__x' }])
    expect(run(store)).toEqual([])
    expect(store.insightStatus('unused-capabilities', '*', 'unused-caps')!.state).toBe('resolved')
  })

  it('does NOT resolve when the window has too few sessions — not enough data', () => {
    const { db, store } = setupDb()
    store.persistInsights('unused-capabilities', 1, [{
      signalKey: 'unused-caps', repo: '*', severity: 'medium', title: 'stale', description: 'stale',
      evidence: [], count: 3, fix: { type: 'behavioral-nudge', label: 'x', content: 'y' },
    }])
    installGlobalMcp(store, ['sentry'])
    // Nothing flagged (sentry used), but only 5 sessions — too thin to conclude the config
    // was cleaned up, so the stale card must stay surfaced.
    seedRepo(db, 'web', 5, [{ action: 'mcp_call', name: 'mcp__sentry__x' }])
    expect(run(store)).toEqual([])
    expect(store.insightStatus('unused-capabilities', '*', 'unused-caps')!.state).toBe('surfaced')
  })

  it('matches a plugin-namespaced skill invocation, so a used skill is not flagged', () => {
    const { db, store } = setupDb()
    installGlobalSkills(store, ['frontend-design'])
    // Used everywhere (both repos) via the plugin-namespaced name → shared, no card.
    seedRepo(db, 'web', 8, [{ action: 'skill', name: 'frontend-design:frontend-design' }])
    seedRepo(db, 'api', 8, [{ action: 'skill', name: 'frontend-design:frontend-design' }])
    expect(run(store)).toEqual([])
  })

  it('surfaces a project-scoped unused server in the aggregate, noting its repo', () => {
    const { db, store } = setupDb()
    installProjectMcp(store, '/Users/x/git/web', ['pg'])
    seedRepo(db, 'web', 12) // pg never used in web
    const cards = run(store)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ repo: '*', count: 1 })
    expect(cards[0]!.fix.content).toContain("Remove from web's config:")
    expect(cards[0]!.fix.content).toContain('- MCP server: pg')
  })

  it('shows no evidence for a removal — there is no invocation to point at', () => {
    const { db, store } = setupDb()
    installProjectMcp(store, '/Users/x/git/web', ['pg'])
    seedRepo(db, 'web', 12) // pg never used in web → project remove
    const card = run(store)[0]!
    expect(card.fix.content).toContain("Remove from web's config:")
    // The finding is "never used here"; recent sessions that didn't use it aren't evidence.
    expect(card.evidence).toEqual([])
  })

  it('skips a project repo whose basename collides with another root', () => {
    const { db, store } = setupDb()
    // Two distinct roots, same basename 'api' → ambiguous, both skipped.
    installProjectMcp(store, '/Users/x/work/api', ['pg'])
    installProjectMcp(store, '/Users/x/personal/api', ['redis'])
    seedRepo(db, 'api', 12)
    expect(run(store)).toEqual([])
  })

  it('does not read another harness’s sessions (source scoping)', () => {
    const { db, store } = setupDb()
    installGlobalMcp(store, ['sentry'])
    // A codex session that uses sentry must not count as claude-code usage.
    db.prepare('INSERT INTO sessions (id, session_id, source, provider, repo, cwd, started_at) VALUES (?,?,?,?,?,?,?)')
      .run('cx-1', 'cx-1', 'codex', 'openai', 'web', '/repo', new Date(Date.now() - DAY_MS).toISOString())
    db.prepare('INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts) VALUES (?,?,?,?,1,0,0,?)')
      .run('cx-1', 0, 'mcp__sentry__x', 'mcp_call', new Date(Date.now() - DAY_MS).toISOString())
    seedRepo(db, 'web', 12) // 12 claude-code sessions, none using sentry
    // sentry still reads as never-used for claude-code → remove card.
    const cards = run(store)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.fix.content).toContain('- MCP server: sentry')
  })
})
