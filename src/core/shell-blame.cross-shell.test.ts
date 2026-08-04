/**
 * Cross-shell guard for failure attribution.
 *
 * The blame rules are written against error TEXT, and shells disagree about that
 * text — bash names a missing command first (`bash: jq: command not found`), zsh
 * names it last (`zsh:1: command not found: jq`). Worse, they disagree about what
 * fails at all: `echo ===` is a hard error under zsh and perfectly fine under
 * bash. It would be easy to tune the rules to whichever shell the author happens
 * to run and quietly ship a feature that only works there.
 *
 * So this runs REAL failing commands through REAL shells and checks the
 * attribution, rather than asserting against error strings written from memory.
 * Shells that aren't installed are skipped, not failed.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellSegments } from './shell-binaries'
import { blameBinary } from './shell-blame'

const SHELLS = ['bash', 'zsh', 'sh'] as const
type Shell = (typeof SHELLS)[number]

function available(shell: string): boolean {
  try {
    execFileSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Run a command for real; returns its combined output and exit code. */
function run(shell: string, cmd: string): { out: string; code: number } {
  try {
    return { out: execFileSync(shell, ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { out: (err.stdout ?? '') + (err.stderr ?? ''), code: err.status ?? 1 }
  }
}

/**
 * `want` is per shell because some failures only EXIST in one: `echo ===` dies
 * under zsh's equals expansion and succeeds everywhere else, so bash has nothing
 * to attribute rather than something it gets wrong.
 */
const CASES: Array<{ label: string; cmd: string; want: Record<Shell, string | null> }> = [
  {
    label: 'a tool that names itself in the failure',
    cmd: 'echo hi && ls /nope/missing-xyz.txt',
    want: { bash: 'ls', zsh: 'ls', sh: 'ls' },
  },
  {
    label: 'a command that is not installed (shell reports it, formats differ)',
    cmd: 'echo hi && notinstalledxyz --version',
    want: { bash: 'notinstalledxyz', zsh: 'notinstalledxyz', sh: 'notinstalledxyz' },
  },
  {
    label: 'a bad flag, answered with a usage dump',
    cmd: 'echo hi && ls --badflagxyz',
    want: { bash: 'ls', zsh: 'ls', sh: 'ls' },
  },
  {
    label: 'a traceback that names no command — abstain',
    cmd: 'echo hi && python3 -c "import nosuchmodulexyz"',
    want: { bash: null, zsh: null, sh: null },
  },
  {
    label: "a tool that prefixes 'error:' instead of its own name — abstain",
    cmd: 'echo hi && git checkout nonexistent-branch-xyz',
    want: { bash: null, zsh: null, sh: null },
  },
  {
    label: 'zsh equals expansion — a failure that only exists in zsh',
    cmd: 'echo A; echo ===; echo B',
    want: { bash: null, zsh: 'echo', sh: null },
  },
]

describe('shell blame, across shells', () => {
  for (const shell of SHELLS) {
    const canRun = available(shell)
    describe.skipIf(!canRun)(shell, () => {
      for (const c of CASES) {
        it(c.label, () => {
          const { out, code } = run(shell, c.cmd)
          // A command that succeeds in this shell has no failure to attribute —
          // which is itself the point for the zsh-only cases.
          if (code === 0) {
            expect(c.want[shell]).toBeNull()
            return
          }
          expect(blameBinary(out, shellSegments(c.cmd))).toBe(c.want[shell])
        })
      }
    })
  }
})
