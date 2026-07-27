import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeSh } from './sh'
import { resolveRepo } from './repo'

const sh = makeSh()

/** Run git synchronously in `cwd`; test-setup only (throws on failure, unlike the app's `sh`). */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

describe('resolveRepo', () => {
  let base: string
  let repoRoot: string // the main checkout, name = basename(repoRoot)
  let worktreePath: string // a linked worktree whose basename is NOT the repo name

  beforeAll(() => {
    // realpath: macOS /tmp is a symlink to /private/tmp, and git reports canonical paths.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'repo-resolve-')))
    repoRoot = join(base, 'my-repo')
    mkdirSync(repoRoot)
    git(repoRoot, 'init', '-q')
    git(repoRoot, 'config', 'user.email', 'test@example.com')
    git(repoRoot, 'config', 'user.name', 'Test')
    writeFileSync(join(repoRoot, 'README.md'), '# my-repo\n')
    git(repoRoot, 'add', '.')
    git(repoRoot, 'commit', '-q', '-m', 'init')
    // A linked worktree checked out to a dir whose basename ('feature-x') differs from the repo.
    worktreePath = join(repoRoot, '.worktrees', 'feature-x')
    git(repoRoot, 'worktree', 'add', '-q', '-b', 'feature-x', worktreePath)
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('resolves the repo name and root from the repo root', async () => {
    const got = await resolveRepo(sh, repoRoot)
    expect(got).toEqual({ name: 'my-repo', root: repoRoot })
  })

  it('resolves from a subdirectory to the repo root, not the subdir', async () => {
    const sub = join(repoRoot, 'src', 'nested')
    mkdirSync(sub, { recursive: true })
    const got = await resolveRepo(sh, sub)
    expect(got).toEqual({ name: 'my-repo', root: repoRoot })
  })

  it('resolves a linked worktree to the MAIN repo, not the worktree dir name', async () => {
    // The regression: show-toplevel returns the worktree path, whose basename is
    // 'feature-x'. The repo name must be 'my-repo' and the root the main checkout.
    expect(basename(worktreePath)).toBe('feature-x') // guard: the trap the old code fell into
    const got = await resolveRepo(sh, worktreePath)
    expect(got).toEqual({ name: 'my-repo', root: repoRoot })
  })

  it('resolves a subdirectory of a linked worktree to the MAIN repo', async () => {
    const sub = join(worktreePath, 'src')
    mkdirSync(sub, { recursive: true })
    const got = await resolveRepo(sh, sub)
    expect(got).toEqual({ name: 'my-repo', root: repoRoot })
  })

  it('returns null for a non-git directory', async () => {
    const plain = join(base, 'not-a-repo')
    mkdirSync(plain)
    expect(await resolveRepo(sh, plain)).toBeNull()
  })

  it('returns null when cwd is undefined', async () => {
    expect(await resolveRepo(sh, undefined)).toBeNull()
  })
})
