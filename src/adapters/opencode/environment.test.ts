import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { opencodeConfigHome, parseJsonc, readOpencodeEnvironment } from './environment'
import type { EnvCategorySnapshot } from '../../store/types'

/** Find one category's payload in a readEnvironment result. */
function cat(result: EnvCategorySnapshot[], category: string): any {
  return result.find((c) => c.category === category)?.payload
}

/** Write a file under `root`, creating parent dirs. */
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// ---- opencodeConfigHome (path resolution) ----------------------------------

describe('opencodeConfigHome', () => {
  const saved = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('defaults to ~/.config/opencode', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
    expect(opencodeConfigHome()).toBe(join(homedir(), '.config', 'opencode'))
  })

  it('honors XDG_CONFIG_HOME', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(opencodeConfigHome()).toBe(join('/xdg', 'opencode'))
  })

  it('OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/opencode'
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(opencodeConfigHome()).toBe('/custom/opencode')
  })
})

// ---- parseJsonc (comments + trailing commas) -------------------------------

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1, "b": [2, 3]}')).toEqual({ a: 1, b: [2, 3] })
  })

  it('strips // line and /* block */ comments', () => {
    const text = `{
      // a line comment
      "a": 1,
      /* block
         comment */
      "b": 2
    }`
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 })
  })

  it('tolerates trailing commas', () => {
    expect(parseJsonc('{ "a": 1, "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] })
  })

  it('returns null on unparseable input', () => {
    expect(parseJsonc('{ not json')).toBeNull()
  })
})

// ---- project scope (hermetic: everything under a temp repo) ----------------

describe('readOpencodeEnvironment — project scope', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'oc-env-'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('returns no categories for an empty repo', async () => {
    expect(await readOpencodeEnvironment(repo)).toEqual([])
  })

  it('settings — keeps permission + plugin, drops the provider secrets', async () => {
    write(
      repo,
      'opencode.json',
      JSON.stringify({
        permission: { edit: 'ask', bash: 'allow' },
        plugin: ['opencode-helicone-session', '@my-org/custom-plugin'],
        provider: { anthropic: { options: { apiKey: 'sk-ant-SECRET' } } },
      }),
    )
    const settings = cat(await readOpencodeEnvironment(repo), 'settings')
    expect(settings['opencode.json'].permission).toEqual({ edit: 'ask', bash: 'allow' })
    expect(settings['opencode.json'].plugin).toEqual(['opencode-helicone-session', '@my-org/custom-plugin'])
    const serialized = JSON.stringify(settings)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('provider')
    expect(serialized).not.toContain('apiKey')
  })

  it('mcp — keeps type/url/enabled, strips every secret-bearing field', async () => {
    write(
      repo,
      'opencode.json',
      JSON.stringify({
        mcp: {
          'local-fs': {
            type: 'local',
            command: ['npx', '-y', 'fs-mcp'],
            environment: { TOKEN: 'SECRET_ENV' },
            enabled: true,
          },
          'remote-api': {
            type: 'remote',
            url: 'https://user:tok@api.example.com/mcp?api_key=SECRET_QS',
            headers: { Authorization: 'Bearer SECRET_HDR' },
            oauth: { clientSecret: 'SECRET_OAUTH' },
          },
        },
      }),
    )
    const mcp = cat(await readOpencodeEnvironment(repo), 'mcp')
    const servers = mcp['opencode.json'].servers
    expect(servers['local-fs'].type).toBe('local')
    expect(servers['local-fs'].enabled).toBe(true)
    expect(servers['remote-api'].type).toBe('remote')
    // url credential-stripped: no userinfo, no query string.
    expect(servers['remote-api'].url).toBe('https://api.example.com/mcp')

    const serialized = JSON.stringify(mcp)
    for (const secret of ['SECRET_ENV', 'SECRET_QS', 'SECRET_HDR', 'SECRET_OAUTH', 'npx', 'command', 'headers', 'oauth', 'environment']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('agents — reads .md files and inline config agents, capturing the body', async () => {
    write(
      repo,
      '.opencode/agents/reviewer.md',
      '---\ndescription: Reviews code\nmode: subagent\nmodel: anthropic/claude-opus-4-8\ncolor: red\n---\nYou are a meticulous reviewer.\n',
    )
    write(
      repo,
      'opencode.json',
      JSON.stringify({ agent: { planner: { description: 'Plans work', mode: 'primary', prompt: 'You plan things.' } } }),
    )
    const agents = cat(await readOpencodeEnvironment(repo), 'agents')
    expect(agents.count).toBe(2)

    const reviewer = agents.agents.find((a: any) => a.name === 'reviewer')
    expect(reviewer.description).toBe('Reviews code')
    expect(reviewer.mode).toBe('subagent')
    expect(reviewer.model).toBe('anthropic/claude-opus-4-8')
    expect(reviewer.body.trim()).toBe('You are a meticulous reviewer.')
    expect(reviewer.bodyHash).toBeTruthy()

    const planner = agents.agents.find((a: any) => a.name === 'planner')
    expect(planner.body.trim()).toBe('You plan things.') // inline `prompt` is the body
    expect(planner.source).toBe('config')

    expect(JSON.stringify(agents)).not.toContain('color') // UI-only field dropped
  })

  it('skills — merges all SKILL.md locations + commands, tagged by kind', async () => {
    write(repo, '.opencode/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploys\n---\nDeploy steps.\n')
    write(repo, '.claude/skills/lint/SKILL.md', '---\nname: lint\ndescription: Lints\n---\nLint steps.\n')
    write(repo, '.agents/skills/format/SKILL.md', '---\nname: format\ndescription: Formats\n---\nFormat steps.\n')
    write(repo, '.opencode/commands/test.md', '---\ndescription: Run tests\nagent: build\n---\nRun the tests: $ARGUMENTS\n')
    write(repo, 'opencode.json', JSON.stringify({ command: { ship: { description: 'Ship it', template: 'Ship the release.' } } }))

    const skills = cat(await readOpencodeEnvironment(repo), 'skills')
    const byName = Object.fromEntries(skills.skills.map((s: any) => [s.name, s]))
    expect(skills.count).toBe(5)

    // All three SKILL.md search locations captured (no skip rule for .claude / .agents).
    expect(byName.deploy.kind).toBe('skill')
    expect(byName.lint.kind).toBe('skill')
    expect(byName.format.kind).toBe('skill')
    expect(byName.deploy.body.trim()).toBe('Deploy steps.')

    // Commands (file + inline) land in the same category, tagged kind: 'command'.
    expect(byName.test.kind).toBe('command')
    expect(byName.test.description).toBe('Run tests')
    expect(byName.ship.kind).toBe('command')
    expect(byName.ship.body.trim()).toBe('Ship the release.') // inline `template` is the body
  })

  it('skills — nested commands are discovered recursively with namespaced names', async () => {
    write(repo, '.opencode/commands/top.md', '---\ndescription: Top level\n---\nTop body.\n')
    write(repo, '.opencode/commands/planning/epic.md', '---\ndescription: Plan an epic\n---\nEpic body.\n')
    write(repo, '.opencode/commands/planning/impl.md', '---\ndescription: Plan impl\n---\nImpl body.\n')

    const skills = cat(await readOpencodeEnvironment(repo), 'skills')
    const names = skills.skills.map((s: any) => s.name).sort()
    expect(names).toEqual(['planning/epic', 'planning/impl', 'top'])
    expect(skills.skills.every((s: any) => s.kind === 'command')).toBe(true)
  })

  it('skills — follows a symlinked skill directory', async () => {
    const ext = mkdtempSync(join(tmpdir(), 'oc-ext-'))
    try {
      write(ext, 'external-skill/SKILL.md', '---\nname: external-skill\ndescription: Ext\n---\nExt body.\n')
      mkdirSync(join(repo, '.opencode', 'skills'), { recursive: true })
      symlinkSync(join(ext, 'external-skill'), join(repo, '.opencode', 'skills', 'external-skill'))
      const skills = cat(await readOpencodeEnvironment(repo), 'skills')
      expect(skills.skills.some((s: any) => s.name === 'external-skill')).toBe(true)
    } finally {
      rmSync(ext, { recursive: true, force: true })
    }
  })

  it('skills — collapses a symlink resolving to an already-captured skill (realpath dedup)', async () => {
    write(repo, '.agents/skills/shared/SKILL.md', '---\nname: shared\ndescription: Shared\n---\nShared body.\n')
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(join(repo, '.agents', 'skills', 'shared'), join(repo, '.claude', 'skills', 'shared'))
    const skills = cat(await readOpencodeEnvironment(repo), 'skills')
    const shared = skills.skills.filter((s: any) => s.name === 'shared')
    expect(shared.length).toBe(1)
    expect(shared[0].dir).toBe('.agents/skills/shared') // real location scanned first → wins the label
  })

  it('instructions — effective only: AGENTS.md wins, shadowed CLAUDE.md is not stored', async () => {
    write(repo, 'AGENTS.md', 'Use tabs, not spaces.\n')
    write(repo, 'CLAUDE.md', 'SHADOWED claude rules.\n')
    write(repo, 'docs/extra.md', 'Extra project guidance.\n')
    write(repo, 'opencode.json', JSON.stringify({ instructions: ['docs/extra.md'] }))

    const instr = cat(await readOpencodeEnvironment(repo), 'instructions')
    expect(instr['AGENTS.md'].body).toContain('Use tabs')
    expect(instr['docs/extra.md'].body).toContain('Extra project guidance')
    expect(instr['CLAUDE.md']).toBeUndefined()
    expect(JSON.stringify(instr)).not.toContain('SHADOWED')
  })

  it('instructions — falls back to CLAUDE.md only when no AGENTS.md exists', async () => {
    write(repo, 'CLAUDE.md', 'Fallback project rules.\n')
    const instr = cat(await readOpencodeEnvironment(repo), 'instructions')
    expect(instr['CLAUDE.md'].body).toContain('Fallback project rules')
  })

  it('instructions — captures nested AGENTS.md for monorepos', async () => {
    write(repo, 'AGENTS.md', 'root rules')
    write(repo, 'packages/x/AGENTS.md', 'package x rules')
    const instr = cat(await readOpencodeEnvironment(repo), 'instructions')
    expect(instr['AGENTS.md'].body).toContain('root rules')
    expect(instr['packages/x/AGENTS.md'].body).toContain('package x rules')
  })

  it('parses opencode.jsonc (comments + trailing commas) end-to-end', async () => {
    write(
      repo,
      'opencode.jsonc',
      `{
        // permissions posture
        "permission": { "edit": "ask", },
        "plugin": ["p1"],
      }`,
    )
    const settings = cat(await readOpencodeEnvironment(repo), 'settings')
    expect(settings['opencode.jsonc'].permission).toEqual({ edit: 'ask' })
    expect(settings['opencode.jsonc'].plugin).toEqual(['p1'])
  })
})

// ---- global scope (HOME redirected so ~/.claude etc. stay sandboxed) --------

describe('readOpencodeEnvironment — global scope', () => {
  let home: string
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    process.env.HOME = home
    delete process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('reads config-home config, agents, skills, and AGENTS.md', async () => {
    const cfg = join(home, '.config', 'opencode')
    write(cfg, 'opencode.json', JSON.stringify({ permission: { edit: 'deny' }, plugin: ['g1'] }))
    write(cfg, 'agents/helper.md', '---\ndescription: Global helper\nmode: subagent\n---\nGlobal agent body.\n')
    write(cfg, 'skills/greet/SKILL.md', '---\nname: greet\ndescription: Greets\n---\nGreet steps.\n')
    write(cfg, 'AGENTS.md', 'Global instructions.\n')

    const res = await readOpencodeEnvironment() // no arg → global scope
    expect(cat(res, 'settings')['opencode.json'].plugin).toEqual(['g1'])
    expect(cat(res, 'agents').agents.some((a: any) => a.name === 'helper')).toBe(true)
    expect(cat(res, 'skills').skills.some((s: any) => s.name === 'greet' && s.kind === 'skill')).toBe(true)
    const instr = cat(res, 'instructions')
    expect(instr['AGENTS.md'].body).toContain('Global instructions')
  })

  it('captures Claude-compatible global skills (~/.claude/skills)', async () => {
    write(join(home, '.claude'), 'skills/ccskill/SKILL.md', '---\nname: ccskill\ndescription: CC compat\n---\nBody.\n')
    const skills = cat(await readOpencodeEnvironment(), 'skills')
    expect(skills.skills.some((s: any) => s.name === 'ccskill')).toBe(true)
  })

  it('instructions — falls back to ~/.claude/CLAUDE.md when no global AGENTS.md', async () => {
    write(join(home, '.claude'), 'CLAUDE.md', 'Global fallback rules.\n')
    const instr = cat(await readOpencodeEnvironment(), 'instructions')
    const key = Object.keys(instr).find((k) => instr[k].body.includes('Global fallback rules'))
    expect(key).toBeTruthy()
  })
})
