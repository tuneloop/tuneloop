import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { agentsHome, piHome, readPiEnvironment } from './environment'
import type { EnvCategorySnapshot } from '../../store/types'

/** Find one category's payload in a readEnvironment result. */
function cat(result: EnvCategorySnapshot[], category: string): any {
  return result.find((c) => c.category === category)?.payload
}

/** Write a file under `root`, creating parent dirs. Returns the absolute path. */
function write(root: string, rel: string, content: string): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

// ---- piHome (path resolution) ----------------------------------------------

describe('piHome', () => {
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('defaults to ~/.pi/agent', () => {
    delete process.env.PI_CODING_AGENT_DIR
    expect(piHome()).toBe(join(homedir(), '.pi', 'agent'))
  })

  it('honors PI_CODING_AGENT_DIR (pointing at the agent dir)', () => {
    process.env.PI_CODING_AGENT_DIR = '/custom/pi/agent'
    expect(piHome()).toBe('/custom/pi/agent')
  })

  it('expands a leading ~ in PI_CODING_AGENT_DIR', () => {
    process.env.PI_CODING_AGENT_DIR = '~/somewhere/agent'
    expect(piHome()).toBe(join(homedir(), 'somewhere', 'agent'))
  })
})

// ---- project scope (hermetic: everything under a temp repo) ----------------

describe('readPiEnvironment — project scope', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pi-env-proj-'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reads project settings, skills, and context files', async () => {
    write(
      repo,
      '.pi/settings.json',
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4',
        defaultThinkingLevel: 'medium',
        defaultProjectTrust: 'ask',
        enableSkillCommands: true,
        compaction: { enabled: true, reserveTokens: 8192 },
        theme: 'dark', // dropped (UI)
        shellPath: '/bin/zsh', // dropped (plumbing)
        packages: ['pi-skills'],
      }),
    )
    write(repo, '.pi/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\nDeploy steps.\n')
    write(repo, '.pi/skills/quicknote.md', '---\nname: quicknote\ndescription: Notes\n---\nNote body.\n')
    write(repo, '.agents/skills/shared/SKILL.md', '---\nname: shared\ndescription: Shared skill\n---\nShared body.\n')
    write(repo, 'AGENTS.md', '# Project rules\nRun the tests.\n')

    const res = await readPiEnvironment(repo)

    const settings = cat(res, 'settings')['.pi/settings.json']
    expect(settings).toEqual({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4',
      defaultThinkingLevel: 'medium',
      defaultProjectTrust: 'ask',
      enableSkillCommands: true,
      compaction: { enabled: true, reserveTokens: 8192 },
      packages: ['pi-skills'],
    })

    const skills = cat(res, 'skills').skills
    const names = skills.map((s: any) => s.name).sort()
    expect(names).toEqual(['deploy', 'quicknote', 'shared'])
    expect(skills.every((s: any) => s.kind === 'skill')).toBe(true)
    expect(skills.find((s: any) => s.name === 'deploy').dir).toBe('.pi/skills/deploy')
    expect(skills.find((s: any) => s.name === 'quicknote').dir).toBe('.pi/skills')
    expect(skills.find((s: any) => s.name === 'shared').dir).toBe('.agents/skills/shared')

    const instr = cat(res, 'instructions')
    expect(instr['AGENTS.md'].body).toContain('Run the tests.')
  })

  it('never emits mcp or agents categories', async () => {
    write(repo, '.pi/settings.json', JSON.stringify({ defaultProvider: 'openai' }))
    const res = await readPiEnvironment(repo)
    expect(res.map((c) => c.category).sort()).toEqual(['settings'])
  })

  it('ignores root .md files in .agents/skills but keeps SKILL.md dirs', async () => {
    write(repo, '.agents/skills/loose.md', '---\nname: loose\ndescription: nope\n---\nBody.\n')
    write(repo, '.agents/skills/real/SKILL.md', '---\nname: real\ndescription: yes\n---\nBody.\n')
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills.map((s: any) => s.name)).toEqual(['real'])
  })

  it('uses frontmatter name over the directory name', async () => {
    write(repo, '.pi/skills/dirname/SKILL.md', '---\nname: real-name\ndescription: d\n---\nB.\n')
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills[0].name).toBe('real-name')
  })

  it('discovers nested .pi and .agents in monorepo packages, dropping build trees', async () => {
    write(repo, '.pi/settings.json', JSON.stringify({ defaultProvider: 'anthropic' }))
    write(repo, 'packages/api/.pi/settings.json', JSON.stringify({ defaultModel: 'gpt-5' }))
    write(repo, 'packages/api/CLAUDE.md', 'API rules.\n')
    // node_modules is pruned — its config must not leak in.
    write(repo, 'node_modules/dep/.pi/settings.json', JSON.stringify({ defaultProvider: 'leak' }))

    const res = await readPiEnvironment(repo)
    const settingsKeys = Object.keys(cat(res, 'settings')).sort()
    expect(settingsKeys).toEqual(['.pi/settings.json', 'packages/api/.pi/settings.json'])
    expect(Object.keys(cat(res, 'instructions'))).toContain('packages/api/CLAUDE.md')
  })

  it('redacts credentials from httpProxy and drops empty instruction files', async () => {
    write(repo, '.pi/settings.json', JSON.stringify({ httpProxy: 'http://user:secret@proxy.example.com:7890/path' }))
    write(repo, 'AGENTS.md', '   \n') // empty → omitted
    const res = await readPiEnvironment(repo)
    expect(cat(res, 'settings')['.pi/settings.json'].httpProxy).toBe('http://proxy.example.com:7890/path')
    expect(cat(res, 'instructions')).toBeUndefined()
  })

  it('collapses skills reached through symlinks by real path', async () => {
    write(repo, '.pi/skills/shared/SKILL.md', '---\nname: shared\ndescription: d\n---\nB.\n')
    mkdirSync(join(repo, '.agents/skills'), { recursive: true })
    symlinkSync(join(repo, '.pi/skills/shared'), join(repo, '.agents/skills/shared'))
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills.map((s: any) => s.name)).toEqual(['shared'])
  })

  it('omits a settings file whose fields are all dropped', async () => {
    write(repo, '.pi/settings.json', JSON.stringify({ theme: 'light', editorPaddingX: 2, trackingId: 'abc' }))
    const res = await readPiEnvironment(repo)
    expect(cat(res, 'settings')).toBeUndefined()
  })

  it('strips credentials from package git URLs (string and object forms), keeping bare names', async () => {
    write(
      repo,
      '.pi/settings.json',
      JSON.stringify({
        packages: [
          'pi-skills',
          '@org/my-extension',
          'https://user:ghp_secret@github.com/org/repo.git#main',
          { source: 'git+https://tok:pat@example.com/pkg.git', skills: ['a'] },
          { source: 'internal-pkg' },
        ],
      }),
    )
    const packages = cat(await readPiEnvironment(repo), 'settings')['.pi/settings.json'].packages
    expect(packages[0]).toBe('pi-skills')
    expect(packages[1]).toBe('@org/my-extension')
    // userinfo removed, path + ref preserved
    expect(packages[2]).toBe('https://github.com/org/repo.git#main')
    expect(packages[2]).not.toContain('ghp_secret')
    expect(packages[3]).toEqual({ source: 'git+https://example.com/pkg.git', skills: ['a'] })
    expect(packages[4]).toEqual({ source: 'internal-pkg' })
  })

  it('treats a directory with SKILL.md as one skill, ignoring nested SKILL.md assets', async () => {
    write(repo, '.pi/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship\n---\nBody.\n')
    // A supporting example bundled inside the skill must NOT become a second skill.
    write(repo, '.pi/skills/deploy/examples/SKILL.md', '---\nname: example\ndescription: nope\n---\nB.\n')
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills.map((s: any) => s.name)).toEqual(['deploy'])
    expect(skills[0].dir).toBe('.pi/skills/deploy')
  })

  it('drops skills without a description (Pi refuses to load them)', async () => {
    write(repo, '.pi/skills/good/SKILL.md', '---\nname: good\ndescription: valid\n---\nB.\n')
    write(repo, '.pi/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\nMissing description.\n')
    write(repo, '.pi/skills/blank/SKILL.md', '---\nname: blank\ndescription: "   "\n---\nBlank description.\n')
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills.map((s: any) => s.name)).toEqual(['good'])
  })

  it('finds SKILL.md dirs nested below the skills root', async () => {
    write(repo, '.pi/skills/group/nested/SKILL.md', '---\nname: nested\ndescription: d\n---\nB.\n')
    const skills = cat(await readPiEnvironment(repo), 'skills').skills
    expect(skills.map((s: any) => s.name)).toEqual(['nested'])
    expect(skills[0].dir).toBe('.pi/skills/group/nested')
  })

  it('selects one context file per directory by precedence (AGENTS.md > CLAUDE.md)', async () => {
    write(repo, 'AGENTS.md', 'Agents wins.\n')
    write(repo, 'CLAUDE.md', 'Claude loses.\n')
    const instr = cat(await readPiEnvironment(repo), 'instructions')
    expect(Object.keys(instr)).toEqual(['AGENTS.md'])
    expect(instr['AGENTS.md'].body).toContain('Agents wins.')
  })

  it('captures the uppercase .MD filename variant', async () => {
    write(repo, 'packages/svc/CLAUDE.MD', 'Uppercase ext.\n')
    const instr = cat(await readPiEnvironment(repo), 'instructions')
    expect(instr['packages/svc/CLAUDE.MD'].body).toContain('Uppercase ext.')
  })

  it('detects .pi and .agents mounted via symlink', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'pi-shared-'))
    write(shared, 'settings.json', JSON.stringify({ defaultProvider: 'anthropic' }))
    write(shared, 'skills/linked/SKILL.md', '---\nname: linked\ndescription: d\n---\nB.\n')
    symlinkSync(shared, join(repo, '.pi'))
    try {
      const res = await readPiEnvironment(repo)
      expect(Object.keys(cat(res, 'settings'))).toEqual(['.pi/settings.json'])
      expect(cat(res, 'skills').skills.map((s: any) => s.name)).toEqual(['linked'])
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })
})

// ---- global scope (HOME + PI_CODING_AGENT_DIR redirected to a temp home) ----

describe('readPiEnvironment — global scope', () => {
  let home: string
  let agentHome: string
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-env-global-'))
    agentHome = join(home, '.pi', 'agent')
    process.env.HOME = home
    process.env.PI_CODING_AGENT_DIR = agentHome
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves the home-level ~/.agents dir from HOME (not the agent home)', () => {
    expect(agentsHome()).toBe(join(home, '.agents'))
    expect(piHome()).toBe(agentHome)
  })

  it('reads global settings, skills (agent home + ~/.agents), and AGENTS.md', async () => {
    write(agentHome, 'settings.json', JSON.stringify({ defaultProvider: 'anthropic', enableSkillCommands: false }))
    write(agentHome, 'skills/greet/SKILL.md', '---\nname: greet\ndescription: Greets\n---\nGreet.\n')
    write(agentHome, 'skills/note.md', '---\nname: note\ndescription: Note\n---\nNote.\n')
    write(join(home, '.agents'), 'skills/user/SKILL.md', '---\nname: user\ndescription: User skill\n---\nBody.\n')
    write(agentHome, 'AGENTS.md', 'Global rules.\n')

    const res = await readPiEnvironment() // no arg → global scope
    expect(cat(res, 'settings')['settings.json']).toEqual({ defaultProvider: 'anthropic', enableSkillCommands: false })

    const skills = cat(res, 'skills').skills
    expect(skills.map((s: any) => s.name).sort()).toEqual(['greet', 'note', 'user'])
    expect(skills.find((s: any) => s.name === 'user').dir).toBe('.agents/skills/user')

    expect(cat(res, 'instructions')['AGENTS.md'].body).toContain('Global rules.')
  })

  it('reads a global CLAUDE.md context file when present', async () => {
    write(agentHome, 'CLAUDE.md', 'Global fallback.\n')
    const instr = cat(await readPiEnvironment(), 'instructions')
    expect(instr['CLAUDE.md'].body).toContain('Global fallback.')
  })

  it('returns an empty result when nothing is configured', async () => {
    expect(await readPiEnvironment()).toEqual([])
  })
})
