import { execFile } from 'node:child_process'
import type { ShResult } from '../core/processor'

/**
 * Run a local binary, resolving null when it's missing (ENOENT) so processors
 * that shell out to `git`/`gh` degrade gracefully offline or uninstalled.
 */
export function makeSh() {
  return (cmd: string, args: string[], opts?: { cwd?: string }): Promise<ShResult | null> =>
    new Promise((resolvePromise) => {
      execFile(
        cmd,
        args,
        { cwd: opts?.cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
          if (e && e.code === 'ENOENT') return resolvePromise(null)
          const code = typeof e?.code === 'number' ? e.code : e ? 1 : 0
          resolvePromise({ stdout: stdout?.toString() ?? stderr?.toString() ?? '', code })
        },
      )
    })
}
