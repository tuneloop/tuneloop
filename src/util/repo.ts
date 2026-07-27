import { basename, dirname, resolve } from 'node:path'
import type { ShResult } from '../core/processor'

/** The `sh` runner shape (makeSh / ProcessorContext.sh): resolves null when the binary is missing. */
export type Sh = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ShResult | null>

/**
 * Resolve a working directory to the repo it belongs to: the repo's short name
 * (`sessions.repo`) and its canonical root path (the environment reader's project
 * scope_key + where it reads `<root>/.claude/...`). Shells out to git twice, so
 * callers cache by cwd.
 *
 * A linked git worktree checks out to a directory OUTSIDE the repo — commonly a branch
 * slug like `.claude/worktrees/<branch>` — and `git rev-parse --show-toplevel` returns
 * THAT worktree dir, whose basename is the branch/worktree name, not the repo. Using it
 * tagged every worktree session with a different "repo" (the branch), fragmenting one
 * repo's sessions and its config timeline. So we canonicalize through `--git-common-dir`:
 * the SHARED `.git` dir every worktree of a repo points at, whose parent is the main
 * worktree root — identical for the main checkout and all its linked worktrees. In the
 * main checkout that value is relative (`.git`, `../.git` from a subdir); for a linked
 * worktree it's absolute — `resolve(cwd, …)` normalizes both. Falls back to the worktree
 * toplevel when the common dir isn't a plain `<root>/.git` (e.g. a bare repo).
 *
 * Null when `cwd` is undefined, gone, or not a git checkout.
 */
export async function resolveRepo(sh: Sh, cwd: string | undefined): Promise<{ name: string; root: string } | null> {
  if (!cwd) return null
  const topRes = await sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (!topRes || topRes.code !== 0) return null
  const top = topRes.stdout.trim()
  if (!top) return null

  let root = top
  const commonRes = await sh('git', ['-C', cwd, 'rev-parse', '--git-common-dir'])
  if (commonRes && commonRes.code === 0) {
    const common = commonRes.stdout.trim()
    // `--git-common-dir` is relative to cwd in the main checkout, absolute in a linked
    // worktree; resolve() handles both. Its parent is the repo root only when it's the
    // conventional `<root>/.git` — otherwise keep the worktree toplevel.
    if (common) {
      const absCommon = resolve(cwd, common)
      if (basename(absCommon) === '.git') root = dirname(absCommon)
    }
  }
  return { name: basename(root), root }
}
