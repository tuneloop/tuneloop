import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Recursively collect files under `root` ending in `ext`. Missing dirs yield []. */
export async function walkFiles(root: string, ext: string): Promise<string[]> {
  const out: string[] = []
  const rec = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await rec(full)
      else if (e.isFile() && e.name.endsWith(ext)) out.push(full)
    }
  }
  await rec(root)
  return out
}
