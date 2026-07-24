import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Recursively collect files under `root` ending in `ext`. Missing dirs yield [].
 * Follows symlinks — to both directories and files — because config and skills are
 * commonly symlinked (e.g. skills shared across `.claude`/`.agents`/`.opencode`). A
 * visited-realpath guard makes a symlink cycle terminate instead of looping forever.
 */
export async function walkFiles(root: string, ext: string): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const rec = async (dir: string): Promise<void> => {
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return // missing dir / dangling link
    }
    if (seen.has(real)) return // symlink cycle or a dir reached twice
    seen.add(real)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await rec(full)
      } else if (e.isFile()) {
        if (e.name.endsWith(ext)) out.push(full)
      } else if (e.isSymbolicLink()) {
        // Resolve the link's target: recurse if a dir, collect if a matching file.
        try {
          const st = await stat(full)
          if (st.isDirectory()) await rec(full)
          else if (st.isFile() && e.name.endsWith(ext)) out.push(full)
        } catch {
          /* dangling symlink — skip */
        }
      }
    }
  }
  await rec(root)
  return out
}
