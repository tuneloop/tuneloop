import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { claudeHome, claudeJsonPath, splitFrontmatter, parseFrontmatter, toStringList, scanProject, resolvePluginDirs, readClaudeCodeEnvironment } from './environment'
import { openDb } from '../../store/db'
import { Store } from '../../store/store'
import type { EnvCategorySnapshot } from '../../store/types'

/** Find one category's payload in a readEnvironment result. */
function cat(result: EnvCategorySnapshot[], category: string): unknown {
  return result.find((c) => c.category === category)?.payload
}

describe('claudeHome', () => {
  const original = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original
  })

  it('defaults to ~/.claude', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeHome()).toBe(join(homedir(), '.claude'))
  })

  it('honors CLAUDE_CONFIG_DIR override', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude-relvy'
    expect(claudeHome()).toBe('/custom/claude-relvy')
  })
})

describe('claudeJsonPath', () => {
  const original = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original
  })

  it('defaults to ~/.claude.json (HOME sibling), NOT ~/.claude/.claude.json', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeJsonPath()).toBe(join(homedir(), '.claude.json'))
    expect(claudeJsonPath()).not.toBe(join(homedir(), '.claude', '.claude.json'))
  })

  it('lives inside CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude-relvy'
    expect(claudeJsonPath()).toBe('/custom/claude-relvy/.claude.json')
  })
})

describe('splitFrontmatter', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\ndescription: y\n---\nthe body\n')
    expect(frontmatter).toBe('name: x\ndescription: y')
    expect(body).toBe('the body\n')
  })

  it('treats a file with no fence as all body', () => {
    const { frontmatter, body } = splitFrontmatter('just a body, no frontmatter')
    expect(frontmatter).toBe('')
    expect(body).toBe('just a body, no frontmatter')
  })

  it('handles a malformed (unclosed) fence as all body', () => {
    const text = '---\nname: x\nno closing fence'
    expect(splitFrontmatter(text)).toEqual({ frontmatter: '', body: text })
  })
})

describe('parseFrontmatter / toStringList', () => {
  it('parses scalars and strips quotes', () => {
    expect(parseFrontmatter('name: code-reviewer\ndescription: "Reviews PRs"\nmodel: inherit')).toEqual({
      name: 'code-reviewer',
      description: 'Reviews PRs',
      model: 'inherit',
    })
  })

  it('parses a YAML block list', () => {
    expect(parseFrontmatter('tools:\n  - Read\n  - Grep\nmodel: sonnet')).toEqual({
      tools: ['Read', 'Grep'],
      model: 'sonnet',
    })
  })

  it('toStringList accepts array, inline list, and comma/space strings', () => {
    expect(toStringList(['Read', 'Grep'])).toEqual(['Read', 'Grep'])
    expect(toStringList('["Read", "Grep"]')).toEqual(['Read', 'Grep'])
    expect(toStringList('Read, Grep Glob')).toEqual(['Read', 'Grep', 'Glob'])
    expect(toStringList(undefined)).toBeNull()
    expect(toStringList('')).toBeNull()
  })
})

describe('readClaudeCodeEnvironment — empty', () => {
  it('returns no categories when nothing exists on disk', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-env-empty-'))
    try {
      // A repo path with no .claude dir → no categories.
      expect(await readClaudeCodeEnvironment(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('scanProject', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-find-'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  const mkdir = (rel: string) => mkdirSync(join(repo, rel), { recursive: true })
  const write = (rel: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), 'x')
  }

  it('finds the root and nested .claude dirs, excluding vendored/build/dot trees', async () => {
    mkdir('.claude')
    mkdir('packages/frontend/.claude')
    mkdir('packages/backend/.claude')
    mkdir('node_modules/some-pkg/.claude') // vendored — excluded
    mkdir('dist/.claude') // build output — excluded
    mkdir('vendor/lib/.claude') // vendored — excluded
    mkdir('.hidden/.claude') // other dot-dir — excluded
    const { claudeDirs } = await scanProject(repo)
    expect(claudeDirs).toEqual(['.claude', 'packages/backend/.claude', 'packages/frontend/.claude'])
  })

  it('returns empty lists for a repo with no config anywhere', async () => {
    mkdir('src')
    expect(await scanProject(repo)).toEqual({ claudeDirs: [], instructionFiles: [] })
  })

  it('returns empty lists for a missing root', async () => {
    expect(await scanProject(join(repo, 'does-not-exist'))).toEqual({ claudeDirs: [], instructionFiles: [] })
  })

  it('does not descend into a .claude dir looking for more .claude dirs', async () => {
    mkdir('.claude/skills/deploy') // a .claude subtree, not a nested .claude dir
    mkdir('.claude/nested/.claude') // even a literal .claude inside .claude is not config
    const { claudeDirs } = await scanProject(repo)
    expect(claudeDirs).toEqual(['.claude'])
  })

  it('finds instruction files at root, nested dirs, and inside .claude/, excluding vendored trees', async () => {
    write('CLAUDE.md')
    write('.claude/CLAUDE.md')
    write('packages/frontend/CLAUDE.md') // nested, no .claude/ beside it
    write('CLAUDE.local.md')
    write('node_modules/dep/CLAUDE.md') // excluded
    const { instructionFiles } = await scanProject(repo)
    expect(instructionFiles).toEqual([
      '.claude/CLAUDE.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
      'packages/frontend/CLAUDE.md',
    ])
  })
})

describe('resolvePluginDirs', () => {
  let home: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-plug-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  const writeInstalled = (obj: unknown) => {
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify(obj))
  }
  const writeManifest = (installPath: string, manifest: unknown) => {
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true })
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  }

  it('resolves default dirs for an enabled user-scope plugin', async () => {
    const ip = join(home, 'plugins', 'cache', 'fd')
    writeInstalled({ plugins: { 'fd@mkt': [{ scope: 'user', installPath: ip }] } })
    writeManifest(ip, { name: 'fd' })
    const p = (await resolvePluginDirs(['fd@mkt'], 'user'))[0]!
    expect(p.id).toBe('fd@mkt')
    expect(p.skillDirs).toEqual([join(ip, 'skills')])
    expect(p.skillRoots).toEqual([]) // no root SKILL.md → no single-skill location
    expect(p.commandDirs).toEqual([join(ip, 'commands')])
    expect(p.agentDirs).toEqual([join(ip, 'agents')])
  })

  it('auto-loads a single-skill plugin: root SKILL.md, no skills/ dir, no manifest field', async () => {
    const ip = join(home, 'plugins', 'cache', 'single')
    writeInstalled({ plugins: { 'single@mkt': [{ scope: 'user', installPath: ip }] } })
    writeManifest(ip, { name: 'single' })
    writeFileSync(join(ip, 'SKILL.md'), '---\nname: my-skill\n---\nbody\n')
    const p = (await resolvePluginDirs(['single@mkt'], 'user'))[0]!
    expect(p.skillRoots).toEqual([ip]) // the plugin root itself is the skill
  })

  it('does NOT auto-load a root SKILL.md when a skills/ dir exists', async () => {
    const ip = join(home, 'plugins', 'cache', 'both')
    writeInstalled({ plugins: { 'both@mkt': [{ scope: 'user', installPath: ip }] } })
    writeManifest(ip, { name: 'both' })
    writeFileSync(join(ip, 'SKILL.md'), 'root skill\n')
    mkdirSync(join(ip, 'skills', 'real'), { recursive: true })
    const p = (await resolvePluginDirs(['both@mkt'], 'user'))[0]!
    expect(p.skillRoots).toEqual([]) // skills/ present → auto-load layout doesn't apply
  })

  it('classifies a manifest skill path with a direct SKILL.md as a skillRoot', async () => {
    const ip = join(home, 'plugins', 'cache', 'dot')
    writeInstalled({ plugins: { 'dot@mkt': [{ scope: 'user', installPath: ip }] } })
    writeManifest(ip, { name: 'dot', skills: './' }) // "skills": "./" — the root IS the skill
    writeFileSync(join(ip, 'SKILL.md'), '---\nname: dot-skill\n---\nbody\n')
    const p = (await resolvePluginDirs(['dot@mkt'], 'user'))[0]!
    expect(p.skillRoots).toEqual([ip])
    expect(p.skillDirs).toEqual([join(ip, 'skills')]) // default scan kept, "./" not added as a dir-of-skills
  })

  it('honors manifest overrides: skills adds, agents/commands replace', async () => {
    const ip = join(home, 'plugins', 'cache', 'x')
    writeInstalled({ plugins: { 'x@mkt': [{ scope: 'user', installPath: ip }] } })
    writeManifest(ip, { name: 'x', skills: './extra-skills/', agents: ['./custom/a.md'], commands: './custom/cmds/' })
    const p = (await resolvePluginDirs(['x@mkt'], 'user'))[0]!
    expect(p.skillDirs).toEqual([join(ip, 'skills'), join(ip, 'extra-skills')]) // default + override
    expect(p.agentDirs).toEqual([join(ip, 'custom/a.md')]) // replaces default agents/
    expect(p.commandDirs).toEqual([join(ip, 'custom/cmds')]) // replaces default commands/
  })

  it('filters by scope: a project-scope install is not returned for scope=user', async () => {
    const ip = join(home, 'plugins', 'cache', 'y')
    writeInstalled({ plugins: { 'y@mkt': [{ scope: 'project', installPath: ip }] } })
    writeManifest(ip, { name: 'y' })
    expect(await resolvePluginDirs(['y@mkt'], 'user')).toEqual([])
    expect((await resolvePluginDirs(['y@mkt'], 'project'))[0]?.id).toBe('y@mkt')
  })

  it('returns [] when installed_plugins.json is missing or has no matching id', async () => {
    expect(await resolvePluginDirs(['fd@mkt'], 'user')).toEqual([]) // no file
    writeInstalled({ plugins: {} })
    expect(await resolvePluginDirs(['fd@mkt'], 'user')).toEqual([]) // id not installed
    expect(await resolvePluginDirs([], 'user')).toEqual([]) // nothing enabled
  })

  it('returns [] gracefully on garbage installed_plugins.json', async () => {
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), 'not json{{')
    expect(await resolvePluginDirs(['fd@mkt'], 'user')).toEqual([])
  })
})

describe('settings reader', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-env-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-env-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const writeJson = (path: string, obj: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(obj))
  }

  it('global: keeps only allowlisted fields, drops secrets', async () => {
    writeJson(join(home, 'settings.json'), {
      permissions: { allow: ['Bash(npm test *)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] },
      enabledPlugins: { 'frontend-design@official': true },
      env: { AWS_PROFILE: 'prod', ANTHROPIC_API_KEY: 'sk-secret' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python /secret/logger.py' }] }] },
      apiKeyHelper: '/usr/local/bin/get-key.sh',
      model: 'opus',
      theme: 'light',
    })
    const payload = cat(await readClaudeCodeEnvironment(), 'settings') as Record<string, any>
    expect(payload['settings.json']).toEqual({
      permissions: { allow: ['Bash(npm test *)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] },
      plugins: { 'frontend-design@official': true },
    })
    // Security: nothing secret-bearing leaks into the serialized snapshot.
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('AWS_PROFILE')
    expect(serialized).not.toContain('logger.py')
    expect(serialized).not.toContain('get-key.sh')
    expect(serialized).not.toContain('opus')
  })

  it('project: keys shared and local by filename, no merge', async () => {
    writeJson(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['Bash(npm test *)'] } })
    writeJson(join(repo, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(rm *)'] },
      enabledPlugins: { 'frontend-design@official': false },
    })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'settings') as Record<string, any>
    expect(payload['.claude/settings.json']).toEqual({ permissions: { allow: ['Bash(npm test *)'] } })
    expect(payload['.claude/settings.local.json']).toEqual({
      permissions: { allow: ['Bash(rm *)'] },
      plugins: { 'frontend-design@official': false },
    })
  })

  it('omits a filename key when that file is absent', async () => {
    writeJson(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['a'] } })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'settings') as Record<string, any>
    expect(Object.keys(payload)).toEqual(['.claude/settings.json']) // no settings.local.json key
  })

  it('captures nested monorepo package settings, keyed by repo-relative path', async () => {
    writeJson(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['root'] } })
    writeJson(join(repo, 'packages', 'frontend', '.claude', 'settings.json'), { permissions: { allow: ['fe'] } })
    writeJson(join(repo, 'node_modules', 'dep', '.claude', 'settings.json'), { permissions: { allow: ['vendored'] } })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'settings') as Record<string, any>
    expect(payload['.claude/settings.json']).toEqual({ permissions: { allow: ['root'] } })
    expect(payload['packages/frontend/.claude/settings.json']).toEqual({ permissions: { allow: ['fe'] } })
    // node_modules excluded by the walk.
    expect(JSON.stringify(payload)).not.toContain('vendored')
  })

  it('returns no settings category when no settings file exists', async () => {
    // Home has no settings.json (fresh tmp dir) → settings absent from result.
    expect(cat(await readClaudeCodeEnvironment(), 'settings')).toBeUndefined()
  })

  it('omits a file that is entirely env/hooks (nothing allowlisted survives)', async () => {
    // Mirrors a real project settings.json with only env + hooks — all dropped.
    writeJson(join(repo, '.claude', 'settings.json'), {
      env: { AGENTLENS_API_KEY: 'dev-ingest-key' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agentlens capture' }] }] },
    })
    // No file yields an allowlisted field → no settings category at all.
    expect(cat(await readClaudeCodeEnvironment(repo), 'settings')).toBeUndefined()
  })

  it('keeps only the file that has allowlisted content when another is all-dropped', async () => {
    writeJson(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['Bash(a)'] } })
    writeJson(join(repo, '.claude', 'settings.local.json'), { env: { SECRET: 'x' } })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'settings') as Record<string, any>
    expect(Object.keys(payload)).toEqual(['.claude/settings.json']) // local omitted (all-dropped)
  })
})

describe('mcp reader', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-mcp-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-mcp-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const writeJson = (path: string, obj: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(obj))
  }

  it('global: reads user-scope top-level mcpServers, keeps only name/type/url', async () => {
    writeJson(join(home, '.claude.json'), {
      mcpServers: { atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } },
    })
    const payload = cat(await readClaudeCodeEnvironment(), 'mcp') as Record<string, any>
    expect(payload['.claude.json'].servers).toEqual({
      atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' },
    })
  })

  it('project: keys .mcp.json (shared) and .claude.json (local) separately', async () => {
    writeJson(join(repo, '.mcp.json'), {
      mcpServers: { atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } },
    })
    writeJson(join(home, '.claude.json'), {
      projects: { [repo]: { mcpServers: { postgres: { type: 'stdio', command: 'npx' } } } },
    })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'mcp') as Record<string, any>
    expect(payload['.mcp.json'].servers).toEqual({ atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } })
    expect(payload['.claude.json'].servers).toEqual({ postgres: { type: 'stdio' } }) // command dropped
  })

  it('unions .claude.json entries from subdirectories under the repo root', async () => {
    writeJson(join(home, '.claude.json'), {
      projects: {
        [repo]: { mcpServers: { root: { type: 'sse', url: 'u1' } } },
        [join(repo, 'frontend')]: { mcpServers: { fe: { type: 'stdio' } } },
        ['/some/other/repo']: { mcpServers: { nope: { type: 'stdio' } } }, // not under repo — excluded
      },
    })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'mcp') as Record<string, any>
    expect(payload['.claude.json'].servers).toEqual({ root: { type: 'sse', url: 'u1' }, fe: { type: 'stdio' } })
    expect(payload['.claude.json'].servers.nope).toBeUndefined()
  })

  it('strips MCP secrets: env, args, headers, oauth never appear', async () => {
    writeJson(join(repo, '.mcp.json'), {
      mcpServers: {
        postgres: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@mcp/postgres', 'postgresql://user:hunter2@host/db'],
          env: { PG_PASSWORD: 'hunter2' },
          headers: { Authorization: 'Bearer sk-secret' },
          oauth: { clientId: 'client-abc' },
        },
      },
    })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'mcp') as Record<string, any>
    expect(payload['.mcp.json'].servers).toEqual({ postgres: { type: 'stdio' } })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('client-abc')
    expect(serialized).not.toContain('postgresql://')
    expect(serialized).not.toContain('npx')
  })

  it('infers type:stdio for a type-less entry that has a command', async () => {
    writeJson(join(repo, '.mcp.json'), {
      mcpServers: { 'shared-server': { command: '/path/to/server', args: [], env: {} } },
    })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'mcp') as Record<string, any>
    expect(payload['.mcp.json'].servers).toEqual({ 'shared-server': { type: 'stdio' } })
  })

  it('returns no mcp category when no MCP config exists', async () => {
    expect(cat(await readClaudeCodeEnvironment(repo), 'mcp')).toBeUndefined()
  })
})

describe('agents reader', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-agents-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-agents-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const writeFile = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('reads frontmatter + full body + hash (YAML-list tools)', async () => {
    writeFile(
      join(repo, '.claude', 'agents', 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: Review PRs\nmodel: sonnet\ntools:\n  - Read\n  - Bash\n---\nYou are a reviewer.\n',
    )
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[]; count: number }
    expect(payload.count).toBe(1)
    const a = payload.agents[0]
    expect(a.name).toBe('code-reviewer')
    expect(a.description).toBe('Review PRs')
    expect(a.model).toBe('sonnet')
    expect(a.tools).toEqual(['Read', 'Bash'])
    expect(a.body).toBe('You are a reviewer.\n')
    expect(typeof a.bodyHash).toBe('string')
  })

  it('accepts comma-string tools and falls back to filename for name', async () => {
    writeFile(join(repo, '.claude', 'agents', 'fixer.md'), '---\ndescription: Fixes things\ntools: Read, Grep\n---\nbody\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[] }
    const a = payload.agents[0]
    expect(a.name).toBe('fixer') // filename fallback (no name in frontmatter)
    expect(a.tools).toEqual(['Read', 'Grep'])
  })

  it('drops color and does not leak hooks content', async () => {
    writeFile(
      join(repo, '.claude', 'agents', 'x.md'),
      '---\nname: x\ndescription: y\ncolor: yellow\nhooks:\n  PreToolUse:\n    - command: /secret/hook.sh\n---\nbody\n',
    )
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[] }
    const a = payload.agents[0]
    expect(a.color).toBeUndefined()
    expect(a.hooks).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('/secret/hook.sh')
  })

  it('handles empty frontmatter → name from filename, body + hash only', async () => {
    writeFile(join(repo, '.claude', 'agents', 'bare.md'), '---\n---\nJust a body.\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[] }
    const a = payload.agents[0]
    expect(a).toEqual({ name: 'bare', body: 'Just a body.\n', bodyHash: a.bodyHash, dir: '.claude/agents' })
    expect(typeof a.bodyHash).toBe('string')
    expect(a.description).toBeUndefined()
    expect(a.model).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  it('handles a file with no frontmatter at all', async () => {
    writeFile(join(repo, '.claude', 'agents', 'nofm.md'), 'Just instructions, no fence.\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[] }
    const a = payload.agents[0]
    expect(a.name).toBe('nofm')
    expect(a.body).toBe('Just instructions, no fence.\n')
    expect(typeof a.bodyHash).toBe('string')
  })

  it('captures nested-package agents with a repo-relative dir; same name across dirs coexists', async () => {
    writeFile(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nroot reviewer\n')
    writeFile(join(repo, 'packages', 'web', '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nweb reviewer\n')
    writeFile(join(repo, 'node_modules', 'dep', '.claude', 'agents', 'x.md'), 'vendored\n') // excluded
    const payload = cat(await readClaudeCodeEnvironment(repo), 'agents') as { agents: any[]; count: number }
    const byDir = Object.fromEntries(payload.agents.map((a) => [a.dir, a]))
    expect(byDir['.claude/agents'].body).toBe('root reviewer\n')
    expect(byDir['packages/web/.claude/agents'].body).toBe('web reviewer\n')
    expect(payload.count).toBe(2) // both 'reviewer' entries coexist, disambiguated by dir
    expect(JSON.stringify(payload)).not.toContain('vendored')
  })

  it('global agents carry no dir field', async () => {
    writeFile(join(home, 'agents', 'g.md'), '---\nname: g\n---\nbody\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'agents') as { agents: any[] }
    expect(payload.agents[0].dir).toBeUndefined()
  })

  it('captures an enabled plugin agent tagged source, ignores a not-enabled installed plugin', async () => {
    const ipOn = join(home, 'plugins', 'cache', 'on')
    const ipOff = join(home, 'plugins', 'cache', 'off')
    writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'on@mkt': true, 'off@mkt': false } }))
    writeFile(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'on@mkt': [{ scope: 'user', installPath: ipOn }], 'off@mkt': [{ scope: 'user', installPath: ipOff }] } }),
    )
    writeFile(join(ipOn, 'agents', 'helper.md'), '---\nname: helper\n---\nplugin agent\n')
    writeFile(join(ipOff, 'agents', 'nope.md'), '---\nname: nope\n---\nshould not appear\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'agents') as { agents: any[]; count: number }
    const helper = payload.agents.find((a) => a.name === 'helper')
    expect(helper.source).toBe('plugin:on@mkt')
    expect(helper.body).toBe('plugin agent\n')
    expect(payload.agents.find((a) => a.name === 'nope')).toBeUndefined() // disabled plugin ignored
  })

  it('returns no agents category when the dir is absent', async () => {
    expect(cat(await readClaudeCodeEnvironment(repo), 'agents')).toBeUndefined()
  })
})

describe('skills reader', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-skills-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-skills-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const writeFile = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  const findByName = (skills: any[], name: string) => skills.find((s) => s.name === name)

  it('merges SKILL.md (dir name) and legacy command (filename) into one list', async () => {
    writeFile(
      join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: ignored-display-name\ndescription: Deploy to staging\n---\nRun the deploy script.\n',
    )
    writeFile(join(repo, '.claude', 'commands', 'review.md'), 'Review the current diff.\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'skills') as { skills: any[]; count: number }
    expect(payload.count).toBe(2)

    const deploy = findByName(payload.skills, 'deploy')
    expect(deploy.name).toBe('deploy') // directory name, NOT frontmatter name
    expect(deploy.description).toBe('Deploy to staging')
    expect(deploy.body).toBe('Run the deploy script.\n')
    expect(typeof deploy.bodyHash).toBe('string')

    const review = findByName(payload.skills, 'review') // filename, no frontmatter
    expect(review.name).toBe('review')
    expect(review.description).toBeUndefined() // bare command has no description
    expect(review.body).toBe('Review the current diff.\n')
  })

  it('uses the directory name for SKILL.md even when frontmatter name differs', async () => {
    writeFile(join(repo, '.claude', 'skills', 'my-skill', 'SKILL.md'), '---\nname: other\n---\nbody\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'skills') as { skills: any[] }
    expect(payload.skills[0].name).toBe('my-skill')
  })

  it('reads global skills from $CLAUDE_HOME', async () => {
    writeFile(join(home, 'skills', 'quick-check', 'SKILL.md'), '---\ndescription: Check files\n---\nCheck.\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'skills') as { skills: any[] }
    expect(payload.skills[0].name).toBe('quick-check')
    expect(payload.skills[0].description).toBe('Check files')
  })

  it('captures an enabled plugin skill tagged source:plugin:<id>', async () => {
    const ip = join(home, 'plugins', 'cache', 'fd')
    writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fd@mkt': true } }))
    writeFile(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fd@mkt': [{ scope: 'user', installPath: ip }] } }))
    writeFile(join(ip, 'skills', 'frontend-design', 'SKILL.md'), '---\ndescription: UI design\n---\nDesign guidance.\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'skills') as { skills: any[] }
    const fd = payload.skills.find((s) => s.name === 'frontend-design')
    expect(fd.source).toBe('plugin:fd@mkt')
    expect(fd.description).toBe('UI design')
    expect(fd.body).toBe('Design guidance.\n')
  })

  it('captures a single-skill plugin (root SKILL.md), named by frontmatter with basename fallback', async () => {
    const named = join(home, 'plugins', 'cache', 'named-install')
    const bare = join(home, 'plugins', 'cache', 'bare-install')
    writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'named@mkt': true, 'bare@mkt': true } }))
    writeFile(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'named@mkt': [{ scope: 'user', installPath: named }],
          'bare@mkt': [{ scope: 'user', installPath: bare }],
        },
      }),
    )
    // Docs: frontmatter `name` determines the invocation name for this layout
    // (stable regardless of install dir); the dir basename is only the fallback.
    writeFile(join(named, 'SKILL.md'), '---\nname: pdf-processor\ndescription: Process PDFs\n---\nProcess.\n')
    writeFile(join(bare, 'SKILL.md'), 'No frontmatter here.\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'skills') as { skills: any[] }
    const names = Object.fromEntries(payload.skills.map((s) => [s.name, s.source]))
    expect(names['pdf-processor']).toBe('plugin:named@mkt') // frontmatter name, not 'named-install'
    expect(names['bare-install']).toBe('plugin:bare@mkt') // fallback: install-dir basename
    expect(payload.skills.find((s) => s.name === 'pdf-processor').description).toBe('Process PDFs')
  })

  it('only reads skills/<dir>/SKILL.md at depth 1, ignoring nested supporting SKILL.md files', async () => {
    // Real skill at depth 1, plus a supporting file named SKILL.md nested inside it.
    writeFile(join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), 'Deploy the app.\n')
    writeFile(join(repo, '.claude', 'skills', 'deploy', 'examples', 'SKILL.md'), 'An example, not a skill.\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'skills') as { skills: any[]; count: number }
    expect(payload.count).toBe(1)
    expect(payload.skills.map((s) => s.name)).toEqual(['deploy']) // no phantom 'examples' skill
  })

  it('captures nested-package skills/commands with a repo-relative dir', async () => {
    writeFile(join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), 'root deploy\n')
    writeFile(join(repo, 'packages', 'web', '.claude', 'skills', 'deploy', 'SKILL.md'), 'web deploy\n')
    writeFile(join(repo, 'packages', 'web', '.claude', 'commands', 'ship.md'), 'ship it\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'skills') as { skills: any[]; count: number }
    const byDir = payload.skills.map((s) => ({ name: s.name, dir: s.dir }))
    expect(byDir).toContainEqual({ name: 'deploy', dir: '.claude/skills' })
    expect(byDir).toContainEqual({ name: 'deploy', dir: 'packages/web/.claude/skills' })
    expect(byDir).toContainEqual({ name: 'ship', dir: 'packages/web/.claude/commands' })
    expect(payload.count).toBe(3)
  })

  it('captures project- and local-scope plugin skills (matched to their install scope)', async () => {
    const ipProj = join(home, 'plugins', 'cache', 'proj')
    const ipLocal = join(home, 'plugins', 'cache', 'local')
    // project plugin enabled in shared settings; local plugin enabled in local settings.
    writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'proj@mkt': true } }))
    writeFile(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'local@mkt': true } }))
    writeFile(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'proj@mkt': [{ scope: 'project', installPath: ipProj }],
          'local@mkt': [{ scope: 'local', installPath: ipLocal }], // local-scope install
        },
      }),
    )
    writeFile(join(ipProj, 'skills', 'proj-skill', 'SKILL.md'), 'project plugin skill\n')
    writeFile(join(ipLocal, 'skills', 'local-skill', 'SKILL.md'), 'local plugin skill\n')

    const payload = cat(await readClaudeCodeEnvironment(repo), 'skills') as { skills: any[] }
    const bySource = Object.fromEntries(payload.skills.map((s) => [s.name, s.source]))
    expect(bySource['proj-skill']).toBe('plugin:proj@mkt')
    expect(bySource['local-skill']).toBe('plugin:local@mkt') // local-scope plugin now captured
  })

  it('returns no skills category when neither dir has files', async () => {
    expect(cat(await readClaudeCodeEnvironment(repo), 'skills')).toBeUndefined()
  })
})

describe('instructions reader', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-instr-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-instr-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const writeFile = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('reads body + hash, keyed by relative path', async () => {
    writeFile(join(repo, 'CLAUDE.md'), '# CLAUDE.md\n\nUse vitest. @AGENTS.md\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'instructions') as Record<string, any>
    expect(payload['CLAUDE.md'].body).toBe('# CLAUDE.md\n\nUse vitest. @AGENTS.md\n')
    expect(typeof payload['CLAUDE.md'].hash).toBe('string')
    // @import kept as-is, unexpanded.
    expect(payload['CLAUDE.md'].body).toContain('@AGENTS.md')
  })

  it('captures CLAUDE.md, .claude/CLAUDE.md, and CLAUDE.local.md separately', async () => {
    writeFile(join(repo, 'CLAUDE.md'), 'root instructions\n')
    writeFile(join(repo, '.claude', 'CLAUDE.md'), 'dot-claude instructions\n')
    writeFile(join(repo, 'CLAUDE.local.md'), 'personal instructions\n')
    const payload = cat(await readClaudeCodeEnvironment(repo), 'instructions') as Record<string, any>
    expect(payload['CLAUDE.md'].body).toBe('root instructions\n')
    expect(payload['.claude/CLAUDE.md'].body).toBe('dot-claude instructions\n')
    expect(payload['CLAUDE.local.md'].body).toBe('personal instructions\n')
  })

  it('captures a nested CLAUDE.md that has NO .claude/ dir beside it', async () => {
    // A monorepo package with CLAUDE.md directly (no .claude/) — keying off .claude/
    // dirs would miss it, so scanProject finds instruction files by filename.
    writeFile(join(repo, 'CLAUDE.md'), 'root\n')
    writeFile(join(repo, 'packages', 'frontend', 'CLAUDE.md'), 'frontend instructions\n')
    writeFile(join(repo, 'node_modules', 'dep', 'CLAUDE.md'), 'vendored\n') // excluded
    const payload = cat(await readClaudeCodeEnvironment(repo), 'instructions') as Record<string, any>
    expect(payload['CLAUDE.md'].body).toBe('root\n')
    expect(payload['packages/frontend/CLAUDE.md'].body).toBe('frontend instructions\n')
    expect(JSON.stringify(payload)).not.toContain('vendored')
  })

  it('omits an empty file (whitespace-only)', async () => {
    writeFile(join(repo, 'CLAUDE.md'), '   \n\n')
    expect(cat(await readClaudeCodeEnvironment(repo), 'instructions')).toBeUndefined()
  })

  it('reads global CLAUDE.md from $CLAUDE_HOME', async () => {
    writeFile(join(home, 'CLAUDE.md'), 'global prefs\n')
    const payload = cat(await readClaudeCodeEnvironment(), 'instructions') as Record<string, any>
    expect(payload['CLAUDE.md'].body).toBe('global prefs\n')
  })

  it('returns no instructions category when no file exists', async () => {
    expect(cat(await readClaudeCodeEnvironment(repo), 'instructions')).toBeUndefined()
  })
})

// N.4 — integration: the real CC reader through the store, on a fixture monorepo.
// Proves N.1–N.3 (nested discovery + path-keys + dir fields) flow through
// recordEnvSnapshot as one row per category, secrets absent, append-on-change intact.
describe('nested monorepo — reader through the store', () => {
  let home: string
  let repo: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-int-home-'))
    repo = mkdtempSync(join(tmpdir(), 'cc-int-repo-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const write = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }

  async function captureProject(store: Store, now: string) {
    for (const c of await readClaudeCodeEnvironment(repo)) {
      store.recordEnvSnapshot({ source: 'claude-code', scope: 'project', scopeKey: repo, category: c.category, payload: c.payload }, now)
    }
  }

  it('stores one row per category with root + nested config, no secrets, append-on-change', async () => {
    // Root config across all categories.
    write('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test *)'] }, env: { API_KEY: 'sk-secret' } }))
    write('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nroot reviewer\n')
    write('.claude/skills/deploy/SKILL.md', 'root deploy\n')
    write('CLAUDE.md', 'root instructions\n')
    // Nested package config.
    write('packages/web/.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(vite *)'] } }))
    write('packages/web/.claude/agents/reviewer.md', '---\nname: reviewer\n---\nweb reviewer\n')
    write('packages/web/CLAUDE.md', 'web instructions\n')
    // Bare nested CLAUDE.md (no .claude/) + a vendored decoy that must be excluded.
    write('packages/api/CLAUDE.md', 'api instructions\n')
    write('node_modules/dep/.claude/settings.json', JSON.stringify({ permissions: { allow: ['vendored'] } }))

    const db = openDb(':memory:')
    const store = new Store(db)
    await captureProject(store, '2026-01-01T00:00:00Z')

    const rows = db
      .prepare(`SELECT category, snapshot_json FROM environment_snapshots WHERE scope='project' AND scope_key=? ORDER BY category`)
      .all(repo) as Array<{ category: string; snapshot_json: string }>

    // One row per category (nested config lives INSIDE the payload, not as extra rows).
    expect(rows.map((r) => r.category)).toEqual(['agents', 'instructions', 'settings', 'skills'])

    const payloads = Object.fromEntries(rows.map((r) => [r.category, JSON.parse(r.snapshot_json)]))
    // settings: root + nested keys.
    expect(payloads.settings['.claude/settings.json']).toEqual({ permissions: { allow: ['Bash(npm test *)'] } })
    expect(payloads.settings['packages/web/.claude/settings.json']).toEqual({ permissions: { allow: ['Bash(vite *)'] } })
    // instructions: root + nested (incl. the bare packages/api/CLAUDE.md).
    expect(Object.keys(payloads.instructions).sort()).toEqual(['CLAUDE.md', 'packages/api/CLAUDE.md', 'packages/web/CLAUDE.md'])
    // agents: same-named 'reviewer' in two dirs coexist.
    expect(payloads.agents.count).toBe(2)
    expect(payloads.agents.agents.map((a: any) => a.dir).sort()).toEqual(['.claude/agents', 'packages/web/.claude/agents'])

    // Security: no secret, no vendored config anywhere in the stored rows.
    const all = rows.map((r) => r.snapshot_json).join('\n')
    expect(all).not.toContain('sk-secret')
    expect(all).not.toContain('vendored')

    // Append-on-change: a second capture with identical config adds no rows.
    await captureProject(store, '2026-01-02T00:00:00Z')
    const count = (db.prepare(`SELECT COUNT(*) as n FROM environment_snapshots WHERE scope='project' AND scope_key=?`).get(repo) as { n: number }).n
    expect(count).toBe(4) // still 4 (one per category), last_observed_at bumped
    store.close()
  })
})

// P.3 — integration: an enabled plugin's skill + agent land in the stored GLOBAL
// snapshot tagged source:plugin:<id>, with secrets absent and append-on-change intact.
describe('enabled plugin — reader through the store (global scope)', () => {
  let home: string
  const originalHome = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-plugint-'))
    process.env.CLAUDE_CONFIG_DIR = home
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  async function captureGlobal(store: Store, now: string) {
    for (const c of await readClaudeCodeEnvironment()) {
      store.recordEnvSnapshot({ source: 'claude-code', scope: 'global', scopeKey: '_global', category: c.category, payload: c.payload }, now)
    }
  }

  it('stores plugin skill + agent tagged source, secrets absent, append-on-change', async () => {
    const ip = join(home, 'plugins', 'cache', 'fd')
    // Enable the plugin globally + a settings.json with a secret that must be dropped.
    write(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] }, env: { KEY: 'sk-secret' }, enabledPlugins: { 'fd@mkt': true } }))
    write(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fd@mkt': [{ scope: 'user', installPath: ip }] } }))
    write(join(ip, 'skills', 'frontend-design', 'SKILL.md'), '---\ndescription: UI\n---\nDesign guidance.\n')
    write(join(ip, 'agents', 'critic.md'), '---\nname: critic\n---\nCritique the UI.\n')

    const db = openDb(':memory:')
    const store = new Store(db)
    await captureGlobal(store, '2026-01-01T00:00:00Z')

    const rows = db
      .prepare(`SELECT category, snapshot_json FROM environment_snapshots WHERE scope='global' AND scope_key='_global' ORDER BY category`)
      .all() as Array<{ category: string; snapshot_json: string }>
    const payloads = Object.fromEntries(rows.map((r) => [r.category, JSON.parse(r.snapshot_json)]))

    // Plugin skill + agent present, tagged source.
    const skill = payloads.skills.skills.find((s: any) => s.name === 'frontend-design')
    expect(skill.source).toBe('plugin:fd@mkt')
    expect(skill.body).toBe('Design guidance.\n')
    const agent = payloads.agents.agents.find((a: any) => a.name === 'critic')
    expect(agent.source).toBe('plugin:fd@mkt')

    // Security: the settings secret never reaches any stored row.
    expect(rows.map((r) => r.snapshot_json).join('\n')).not.toContain('sk-secret')

    // Append-on-change: re-capture unchanged → no new rows.
    const before = rows.length
    await captureGlobal(store, '2026-01-02T00:00:00Z')
    const after = (db.prepare(`SELECT COUNT(*) as n FROM environment_snapshots WHERE scope='global'`).get() as { n: number }).n
    expect(after).toBe(before)
    store.close()
  })
})
