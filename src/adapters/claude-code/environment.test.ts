import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { claudeHome, splitFrontmatter, parseFrontmatter, toStringList, readClaudeCodeEnvironment } from './environment'
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
    expect(payload['settings.json']).toEqual({ permissions: { allow: ['Bash(npm test *)'] } })
    expect(payload['settings.local.json']).toEqual({
      permissions: { allow: ['Bash(rm *)'] },
      plugins: { 'frontend-design@official': false },
    })
  })

  it('omits a filename key when that file is absent', async () => {
    writeJson(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['a'] } })
    const payload = cat(await readClaudeCodeEnvironment(repo), 'settings') as Record<string, any>
    expect(Object.keys(payload)).toEqual(['settings.json']) // no settings.local.json key
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
    expect(Object.keys(payload)).toEqual(['settings.json']) // local omitted (all-dropped)
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
    expect(a).toEqual({ name: 'bare', body: 'Just a body.\n', bodyHash: a.bodyHash })
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
