import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentHash } from '../../core/hash'
import type { EnvCategorySnapshot } from '../../store/types'
import { codexHome, readCodexEnvironment } from './environment'

function cat(result: EnvCategorySnapshot[], category: string): any {
  return result.find((item) => item.category === category)?.payload
}

function write(root: string, rel: string, content: string): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('codexHome', () => {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-resolution-'))
    process.env.HOME = home
    delete process.env.CODEX_HOME
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('defaults to ~/.codex', () => {
    expect(codexHome()).toBe(join(home, '.codex'))
  })

  it('honors CODEX_HOME', () => {
    process.env.CODEX_HOME = join(home, 'custom-codex')
    expect(codexHome()).toBe(join(home, 'custom-codex'))
  })
})

describe('readCodexEnvironment — project config', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-env-project-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('returns no categories for an empty project', async () => {
    expect(await readCodexEnvironment(repo)).toEqual([])
  })

  it('prunes dot-directories and does not capture cache-contained Codex files', async () => {
    for (const cache of ['.venv', '.tox', '.next', '.cache', '.gradle', '.terraform', '.pytest_cache', '.mypy_cache']) {
      write(repo, `${cache}/.codex/config.toml`, 'sandbox_mode = "danger-full-access"\n')
      write(
        repo,
        `${cache}/.codex/agents/stray.toml`,
        'name = "stray"\ndescription = "Cache agent"\ndeveloper_instructions = "Ignore me."\n',
      )
      write(
        repo,
        `${cache}/.agents/skills/stray/SKILL.md`,
        '---\nname: stray\ndescription: Cache skill\n---\nIgnore me.\n',
      )
      write(repo, `${cache}/AGENTS.md`, 'Cache instructions.\n')
    }

    expect(await readCodexEnvironment(repo)).toEqual([])
  })

  it('captures allowlisted settings from root and nested project configs', async () => {
    write(
      repo,
      '.codex/config.toml',
      `approval_policy = { granular = { sandbox_approval = true, request_permissions = false, secret = "drop" } }
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
web_search = "live"
notify = ["secret-command"]

[sandbox_workspace_write]
network_access = true
writable_roots = ["/secret/path"]

[features]
apps = false
hooks = true
memories = true
shell_tool = false

[features.code_mode]
enabled = true
excluded_tool_namespaces = ["z_tools", "a_tools"]
direct_only_tool_namespaces = ["mcp__history"]
`,
    )
    write(repo, 'packages/api/.codex/config.toml', 'sandbox_mode = "read-only"\nweb_search = "cached"\n')

    const settings = cat(await readCodexEnvironment(repo), 'settings')
    expect(Object.keys(settings)).toEqual(['.codex/config.toml', 'packages/api/.codex/config.toml'])
    expect(settings['.codex/config.toml']).toEqual({
      approval_policy: { granular: { sandbox_approval: true, request_permissions: false } },
      approvals_reviewer: 'auto_review',
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: { network_access: true },
      web_search: 'live',
      features: {
        apps: false,
        hooks: true,
        memories: true,
        code_mode: {
          enabled: true,
          excluded_tool_namespaces: ['a_tools', 'z_tools'],
          direct_only_tool_namespaces: ['mcp__history'],
        },
      },
    })
    expect(settings['packages/api/.codex/config.toml']).toEqual({ sandbox_mode: 'read-only', web_search: 'cached' })
    const serialized = JSON.stringify(settings)
    expect(serialized).not.toContain('secret-command')
    expect(serialized).not.toContain('/secret/path')
    expect(serialized).not.toContain('shell_tool')
    expect(serialized).not.toContain('drop')
  })

  it('omits settings when the config contains no allowlisted setting', async () => {
    write(repo, '.codex/config.toml', 'model = "gpt-example"\napi_key = "sk-secret"\n')
    expect(cat(await readCodexEnvironment(repo), 'settings')).toBeUndefined()
  })

  it('fails the scope when a root or nested config is malformed', async () => {
    write(repo, '.codex/config.toml', 'sandbox_mode = [')
    await expect(readCodexEnvironment(repo)).rejects.toThrow('invalid Codex config .codex/config.toml')

    write(repo, '.codex/config.toml', 'sandbox_mode = "read-only"\n')
    write(repo, 'packages/api/.codex/config.toml', '[mcp_servers.bad')
    await expect(readCodexEnvironment(repo)).rejects.toThrow(
      'invalid Codex config packages/api/.codex/config.toml',
    )
  })

  it('uses standards-compliant TOML parsing and deterministic output', async () => {
    write(
      repo,
      '.codex/config.toml',
      `approval_policy = "on-request"
[mcp_servers.zeta]
command = "z"
[mcp_servers.alpha]
url = "https://example.com/mcp"
`,
    )
    const first = await readCodexEnvironment(repo)
    const second = await readCodexEnvironment(repo)
    expect(second).toEqual(first)
    expect(Object.keys(cat(first, 'mcp')['.codex/config.toml'].servers)).toEqual(['alpha', 'zeta'])
  })
})

describe('readCodexEnvironment — MCP', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-env-mcp-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('derives transport, strips URL credentials, and drops every secret-bearing field', async () => {
    write(
      repo,
      '.codex/config.toml',
      `[mcp_servers.local]
command = "npx-secret-command"
args = ["postgresql://user:hunter2@host/db"]
env = { TOKEN = "sk-env-secret" }
env_vars = ["SECRET_TOKEN"]
startup_timeout_sec = 99
enabled = false

[mcp_servers.remote]
url = "https://user:hunter2@mcp.example.com:8443/v1/mcp?api_key=sk-query#frag"
auth = "oauth"
bearer_token_env_var = "MCP_TOKEN"
http_headers = { Authorization = "Bearer sk-header" }
env_http_headers = { Authorization = "MCP_TOKEN" }
tool_timeout_sec = 88
enabled = true
`,
    )

    const mcp = cat(await readCodexEnvironment(repo), 'mcp')['.codex/config.toml'].servers
    expect(mcp).toEqual({
      local: { type: 'stdio', enabled: false },
      remote: { type: 'http', url: 'https://mcp.example.com:8443/v1/mcp', enabled: true },
    })
    const serialized = JSON.stringify(mcp)
    for (const secret of [
      'npx-secret-command',
      'hunter2',
      'sk-env-secret',
      'SECRET_TOKEN',
      'sk-query',
      'oauth',
      'MCP_TOKEN',
      'sk-header',
      '99',
      '88',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('drops an invalid URL but retains the derived HTTP identity', async () => {
    write(repo, '.codex/config.toml', '[mcp_servers.remote]\nurl = "not a url with token"\n')
    const servers = cat(await readCodexEnvironment(repo), 'mcp')['.codex/config.toml'].servers
    expect(servers).toEqual({ remote: { type: 'http' } })
    expect(JSON.stringify(servers)).not.toContain('token')
  })

  it('omits MCP when no valid server identity remains', async () => {
    write(repo, '.codex/config.toml', '[mcp_servers.incomplete]\nenabled = false\n')
    expect(cat(await readCodexEnvironment(repo), 'mcp')).toBeUndefined()
  })
})

describe('readCodexEnvironment — custom agents', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-env-agents-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reads root, nested, and configured agents with allowlisted fields and body hashes', async () => {
    const body = 'Review correctness and security.\n'
    write(
      repo,
      '.codex/agents/reviewer.toml',
      `name = "reviewer"
description = "Review changes"
developer_instructions = """${body}"""
model = "gpt-review"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
mcp_servers = { secret = { command = "secret-command", env = { TOKEN = "sk-secret" } } }
skills = { config = [{ path = "/secret/skill" }] }
`,
    )
    write(
      repo,
      'packages/api/.codex/agents/explorer.toml',
      'name = "explorer"\ndescription = "Explore API"\ndeveloper_instructions = "Trace requests."\n',
    )
    const configuredPath = write(
      repo,
      'custom-agents/docs.toml',
      'name = "docs"\ndescription = "Check docs"\ndeveloper_instructions = "Verify APIs."\n',
    )
    write(
      repo,
      '.codex/config.toml',
      `[agents.docs]
config_file = "../custom-agents/docs.toml"
`,
    )

    const payload = cat(await readCodexEnvironment(repo), 'agents')
    expect(payload.count).toBe(3)
    expect(payload.agents.map((agent: any) => agent.name)).toEqual(['reviewer', 'docs', 'explorer'])
    expect(payload.agents.find((agent: any) => agent.name === 'reviewer')).toEqual({
      name: 'reviewer',
      description: 'Review changes',
      body,
      bodyHash: contentHash(body),
      dir: '.codex/agents',
      model: 'gpt-review',
      model_reasoning_effort: 'high',
      sandbox_mode: 'read-only',
    })
    expect(payload.agents.find((agent: any) => agent.name === 'docs').dir).toBe('custom-agents')
    expect(configuredPath).toContain(repo)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('secret-command')
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('/secret/skill')
  })

  it('omits malformed agent files and project references that escape the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-agent-outside-'))
    try {
      write(repo, '.codex/agents/bad.toml', 'name = [')
      write(repo, '.codex/agents/missing.toml', 'name = "missing"\ndescription = "No instructions"\n')
      const external = write(
        outside,
        'external.toml',
        'name = "external"\ndescription = "Must not load"\ndeveloper_instructions = "outside secret"\n',
      )
      write(repo, '.codex/config.toml', `[agents.external]\nconfig_file = ${JSON.stringify(external)}\n`)
      expect(cat(await readCodexEnvironment(repo), 'agents')).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('readCodexEnvironment — project skills', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-env-skills-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('discovers root/nested/configured skills, applies enablement, and deduplicates symlinks', async () => {
    write(
      repo,
      '.agents/skills/disabled/SKILL.md',
      '---\nname: disabled\ndescription: Disabled skill\n---\nDo not capture.\n',
    )
    const shared = write(
      repo,
      '.agents/skills/shared/SKILL.md',
      '---\nname: shared\ndescription: Shared skill\n---\nShared body.\n',
    )
    mkdirSync(join(repo, 'packages/api/.agents/skills'), { recursive: true })
    symlinkSync(join(repo, '.agents/skills/shared'), join(repo, 'packages/api/.agents/skills/shared'))
    write(
      repo,
      'packages/api/.agents/skills/nested/SKILL.md',
      '---\nname: nested\ndescription: Nested skill\n---\nNested body.\n',
    )
    const configured = write(
      repo,
      'custom/tool/SKILL.md',
      '---\nname: configured\ndescription: Configured skill\n---\nConfigured body.\n',
    )
    write(
      repo,
      '.codex/config.toml',
      `[[skills.config]]
path = "../.agents/skills/disabled/SKILL.md"
enabled = false

[[skills.config]]
path = "../custom/tool/SKILL.md"
enabled = true
`,
    )

    const payload = cat(await readCodexEnvironment(repo), 'skills')
    expect(payload.count).toBe(3)
    expect(payload.skills.map((skill: any) => skill.name)).toEqual(['shared', 'configured', 'nested'])
    expect(payload.skills.filter((skill: any) => skill.name === 'shared')).toHaveLength(1)
    expect(payload.skills.find((skill: any) => skill.name === 'configured')).toMatchObject({
      kind: 'skill',
      dir: 'custom/tool',
      body: 'Configured body.\n',
      bodyHash: contentHash('Configured body.\n'),
    })
    expect(shared).toContain(repo)
    expect(configured).toContain(repo)
  })

  it('confines configured paths and symlink targets to the repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-skill-outside-'))
    try {
      const external = write(
        outside,
        'external/SKILL.md',
        '---\nname: external\ndescription: External\n---\noutside secret\n',
      )
      mkdirSync(join(repo, '.agents/skills'), { recursive: true })
      symlinkSync(join(outside, 'external'), join(repo, '.agents/skills/external'))
      write(repo, '.codex/config.toml', `[[skills.config]]\npath = ${JSON.stringify(external)}\nenabled = true\n`)
      expect(cat(await readCodexEnvironment(repo), 'skills')).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('readCodexEnvironment — instructions', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-env-instructions-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('applies per-directory precedence and configured fallback filenames', async () => {
    write(repo, 'AGENTS.md', 'Root instructions.\n')
    write(repo, 'AGENTS.override.md', 'Root override.\n')
    write(repo, 'packages/api/AGENTS.md', 'Shadowed nested instructions.\n')
    write(repo, 'packages/api/AGENTS.override.md', 'Nested override.\n')
    write(repo, 'packages/web/TEAM_GUIDE.md', 'Web fallback.\n')
    write(repo, 'packages/empty/AGENTS.md', '   \n')
    write(repo, '.codex/config.toml', 'project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]\n')

    const instructions = cat(await readCodexEnvironment(repo), 'instructions')
    expect(Object.keys(instructions)).toEqual([
      'AGENTS.override.md',
      'packages/api/AGENTS.override.md',
      'packages/web/TEAM_GUIDE.md',
    ])
    expect(instructions['AGENTS.override.md']).toEqual({
      body: 'Root override.\n',
      hash: contentHash('Root override.\n'),
    })
    expect(JSON.stringify(instructions)).not.toContain('Root instructions')
    expect(JSON.stringify(instructions)).not.toContain('Shadowed nested')
  })

  it('lets a nested config replace fallback names for its descendants', async () => {
    write(repo, '.codex/config.toml', 'project_doc_fallback_filenames = ["ROOT_GUIDE.md"]\n')
    write(repo, 'packages/api/.codex/config.toml', 'project_doc_fallback_filenames = ["API_GUIDE.md"]\n')
    write(repo, 'packages/api/API_GUIDE.md', 'API rules.\n')
    write(repo, 'packages/api/service/ROOT_GUIDE.md', 'Should be shadowed by nested config.\n')
    write(repo, 'packages/api/service/API_GUIDE.md', 'Service API rules.\n')

    const instructions = cat(await readCodexEnvironment(repo), 'instructions')
    expect(Object.keys(instructions)).toEqual(['packages/api/API_GUIDE.md', 'packages/api/service/API_GUIDE.md'])
  })

  it('falls through an empty override and omits directories with no non-empty instruction', async () => {
    write(repo, 'AGENTS.override.md', '\n')
    write(repo, 'AGENTS.md', 'Fallback after empty override.\n')
    write(repo, 'packages/api/AGENTS.override.md', '  \n')
    const instructions = cat(await readCodexEnvironment(repo), 'instructions')
    expect(Object.keys(instructions)).toEqual(['AGENTS.md'])
  })
})

describe('readCodexEnvironment — global scope', () => {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
  let home: string
  let configHome: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-env-global-'))
    configHome = join(home, 'custom-codex')
    process.env.HOME = home
    process.env.CODEX_HOME = configHome
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('reads the default ~/.codex home when CODEX_HOME is unset', async () => {
    delete process.env.CODEX_HOME
    write(join(home, '.codex'), 'config.toml', 'sandbox_mode = "read-only"\n')
    expect(cat(await readCodexEnvironment(), 'settings')).toEqual({
      'config.toml': { sandbox_mode: 'read-only' },
    })
  })

  it('fails the global scope when the base config is malformed', async () => {
    write(configHome, 'config.toml', 'approval_policy = [')
    await expect(readCodexEnvironment()).rejects.toThrow('invalid Codex config config.toml')
  })

  it('reads the custom home, global agents, user skills, and global instruction override', async () => {
    write(configHome, 'config.toml', 'approval_policy = "never"\n')
    write(
      configHome,
      'agents/global.toml',
      'name = "global"\ndescription = "Global helper"\ndeveloper_instructions = "Global agent body."\n',
    )
    write(
      home,
      '.agents/skills/user-skill/SKILL.md',
      '---\nname: user-skill\ndescription: User skill\n---\nUser skill body.\n',
    )
    write(configHome, 'AGENTS.md', 'Shadowed global instructions.\n')
    write(configHome, 'AGENTS.override.md', 'Global override.\n')

    const result = await readCodexEnvironment()
    expect(cat(result, 'settings')).toEqual({ 'config.toml': { approval_policy: 'never' } })
    expect(cat(result, 'agents').agents[0]).toMatchObject({ name: 'global', dir: 'agents' })
    expect(cat(result, 'skills').skills[0]).toMatchObject({ name: 'user-skill', dir: '.agents/skills/user-skill' })
    expect(cat(result, 'instructions')).toEqual({
      'AGENTS.override.md': { body: 'Global override.\n', hash: contentHash('Global override.\n') },
    })
  })

  it('allows global config to reference user-owned agent and skill paths', async () => {
    const agent = write(
      home,
      'shared/agent.toml',
      'name = "shared"\ndescription = "Shared agent"\ndeveloper_instructions = "Shared agent body."\n',
    )
    const skill = write(
      home,
      'shared/skill/SKILL.md',
      '---\nname: shared-skill\ndescription: Shared skill\n---\nShared skill body.\n',
    )
    write(
      configHome,
      'config.toml',
      `[agents.shared]
config_file = ${JSON.stringify(agent)}

[[skills.config]]
path = ${JSON.stringify(skill)}
enabled = true
`,
    )

    const result = await readCodexEnvironment()
    expect(cat(result, 'agents').agents[0]).toMatchObject({ name: 'shared', dir: 'shared' })
    expect(cat(result, 'skills').skills[0]).toMatchObject({ name: 'shared-skill', dir: 'shared/skill' })
  })

  it('uses AGENTS.md when the override is empty', async () => {
    write(configHome, 'AGENTS.override.md', ' \n')
    write(configHome, 'AGENTS.md', 'Global base.\n')
    expect(cat(await readCodexEnvironment(), 'instructions')).toEqual({
      'AGENTS.md': { body: 'Global base.\n', hash: contentHash('Global base.\n') },
    })
  })
})
