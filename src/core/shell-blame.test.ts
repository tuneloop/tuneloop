import { describe, expect, it } from 'vitest'
import { blameBinary } from './shell-blame'
import { shellBinaries, shellSegments, type ShellSegment } from './shell-binaries'

/** A stand-in chain when the test cares about the binaries, not the command text. */
const segs = (...binaries: string[]): ShellSegment[] =>
  // `&&`-joined: these fixtures test the name-matching rules, and `&&` keeps the
  // exit-position rule (which only fires after `;`/newline/`|`) out of the way.
  binaries.map((b, i) => ({ binary: b, tokens: [b], sep: i === 0 ? null : '&&' }))

describe('blameBinary — the exit code came from the last segment', () => {
  it('blames the last segment of a `;` list, with no error text at all', () => {
    // The idiom this exists for: an existence probe with stderr discarded. The
    // shell's status IS the last command's, so `ls` is what failed — and nothing
    // in the output says so.
    const cmd = 'echo "--- lockfiles ---"; ls /repo/*lock* /repo/pnpm-lock.yaml 2>/dev/null'
    expect(blameBinary('/repo/package-lock.json', shellSegments(cmd))).toBe('ls')
  })

  it('applies after a newline and after a pipe, the other last-ran separators', () => {
    expect(blameBinary('out', shellSegments('echo hi\nls /nope'))).toBe('ls')
    expect(blameBinary('out', shellSegments('cat log | wc -l'))).toBe('wc')
  })

  it('stays silent after `&&` — the chain may have stopped anywhere', () => {
    // Exactly the case blame was built for: `ls missing && tsc` fails at ls, so
    // blaming the last segment would pin it on the command that never ran.
    expect(blameBinary('out', shellSegments('ls missing && npx tsc'))).toBeNull()
    expect(blameBinary('out', shellSegments('ls missing || npx tsc'))).toBeNull()
  })

  it('stays silent when an `&&` sits ANYWHERE earlier, not just before the last segment', () => {
    // `A && B | C`: the pipe says C follows B, but if A failed the whole pipeline
    // was skipped. Checking only the final join blamed `sed` on real commands
    // whose earlier link never ran.
    expect(blameBinary('out', shellSegments('nl -ba a.ts | sed -n 1,5p && nl -ba b.ts | sed -n 9,10p'))).toBeNull()
  })

  it('finds a shell abort even when it lands past the self-prefix scan window', () => {
    // A command that dumps a file before aborting pushes its `(eval)` line far
    // down; missing it let the exit-position rule fire on a list that never
    // reached its end, blaming the trailing `sed`.
    const cmd = 'sed -n 1,60p a.ts; echo ===; sed -n 350,400p b.ts'
    const out = new Array(80).fill('a line of the dumped file').join('\n') + '\n(eval):1: == not found'
    expect(blameBinary(out, shellSegments(cmd))).toBe('echo')
  })

  it('stays silent when the shell aborted — the list never reached its end', () => {
    // `echo ===` abandons the rest, so the last segment never ran. Rule 1 blames
    // `echo`; the exit-position rule must not overrule it with `grep`.
    const cmd = 'sed -n 1,5p f.ts; echo ===; grep -n x f.ts'
    expect(blameBinary('(eval):1: == not found', shellSegments(cmd))).toBe('echo')
    // And when the aborting word can't be located, it abstains rather than
    // falling through to the last segment.
    expect(blameBinary('(eval):1: ^^ not found', shellSegments(cmd))).toBeNull()
  })

  it('stays silent when the exit code was not the command\'s verdict', () => {
    // A decline ran nothing, and a timeout is the harness's kill rather than a
    // command's answer — neither says the last segment is at fault. A decline
    // keeps its multi-label by decision: it is signal, not noise.
    const cmd = 'echo hi; ls /nope'
    expect(blameBinary('User rejected tool use', shellSegments(cmd))).toBeNull()
    expect(blameBinary('Error: Exit code 143\nCommand timed out after 2m 0s', shellSegments(cmd))).toBeNull()
  })

  it('stays silent when the last segment runs nothing', () => {
    expect(blameBinary('out', shellSegments('npm test; cd /repo'))).toBeNull()
  })

  it('yields to the error text when it names a binary', () => {
    // Reading the output beats inferring from position.
    const cmd = 'ls /nope; grep -n x f.ts'
    expect(blameBinary('ls: /nope: No such file or directory', shellSegments(cmd))).toBe('ls')
  })
})

describe('blameBinary — naming the segment that failed', () => {
  it('blames the binary that prefixed the error line', () => {
    // The case that motivated this: `ls` failed, so the `tsc` after the `&&` never
    // ran at all — yet it was carrying the error and a 100% failure rate.
    const out = 'Error: Exit code 1\nls: node_modules/.bin/tsc: No such file or directory'
    expect(blameBinary(out, segs('ls', 'echo', './node_modules/.bin/tsc', 'tail'))).toBe('ls')
  })

  it('matches a path-invoked binary by its basename', () => {
    expect(blameBinary('./node_modules/.bin/tsc: Permission denied', segs('ls', './node_modules/.bin/tsc'))).toBe('./node_modules/.bin/tsc')
    expect(blameBinary('tsc: error TS2307: Cannot find module', segs('npm', './node_modules/.bin/tsc'))).toBe('./node_modules/.bin/tsc')
  })

  it('reads the command named by a shell wrapper, not the wrapper', () => {
    expect(blameBinary('bash: line 1: pytest: command not found', segs('pytest', 'echo'))).toBe('pytest')
    expect(blameBinary('/bin/sh: tsc: command not found', segs('tsc'))).toBe('tsc')
  })

  it('finds the blame line among surrounding output', () => {
    const out = ['total 24', 'drwxr-xr-x  5 me  staff   160 Aug  4 09:00 .', '--- direct run ---', 'psql: error: connection refused'].join('\n')
    expect(blameBinary(out, segs('ls', 'echo', 'psql'))).toBe('psql')
  })

  it('reads zsh\'s name-after-message form as well as bash\'s name-first one', () => {
    // zsh: `(eval):1: command not found: jq`; bash: `bash: jq: command not found`.
    // Both shells show up in real transcripts, so both have to parse.
    expect(blameBinary('(eval):1: command not found: jq', segs('jq', 'curl'))).toBe('jq')
    expect(blameBinary('(eval):cd:1: no such file or directory: docs', segs('cd', 'ls'))).toBe('cd')
  })

  it('reads a usage dump as the tool complaining about its own invocation', () => {
    const out = '--yes required when not running interactively\nUsage:  gh gist delete {<id> | <url>} [flags]'
    expect(blameBinary(out, segs('gh', 'echo', 'head'))).toBe('gh')
  })

  it('is silent when two different binaries are named — that is genuinely ambiguous', () => {
    expect(blameBinary('git: bad\nnpm: also bad', segs('git', 'npm'))).toBeNull()
  })

  it('is silent when the named command is not one of the call\'s binaries', () => {
    // Never invent a row: blaming something the parser didn't see would create an
    // entity out of an error message.
    expect(blameBinary('docker: Cannot connect to the Docker daemon', segs('npm', 'echo'))).toBeNull()
  })

  it('is silent when nothing names a binary', () => {
    expect(blameBinary('Error: Exit code 1', segs('npm', 'echo'))).toBeNull()
    expect(blameBinary('', segs('npm'))).toBeNull()
    expect(blameBinary('Segmentation fault', segs('npm'))).toBeNull()
  })

  it('does not blame from a mid-line mention', () => {
    // "…run npm install" is advice, not a failure prefix.
    expect(blameBinary('Error: modules missing, try running npm install first', segs('npm', 'node'))).toBeNull()
  })

  it('needs the colon-space shape, not a bare word', () => {
    expect(blameBinary('npm\nsomething went wrong', segs('npm'))).toBeNull()
  })

  it('repeats of the SAME binary still blame it', () => {
    expect(blameBinary('git: bad ref\ngit: fatal: exiting', segs('git', 'echo'))).toBe('git')
  })

  it('blames the segment holding the word the SHELL rejected', () => {
    // The reported case: `echo ===` dies under zsh (`===` parses as `=` plus a
    // lookup for a command named `==`) and abandons the rest of the list. Nothing
    // in the message names a binary, but `==` is in the `echo ===` segment — and
    // the failure is real and the agent's: the command wasn't shell-portable.
    const cmd = 'sed -n 1,80p src/config.ts; echo ===; grep -n "enrich" src/cli.ts | head -30'
    const out = 'import { homedir } from \'node:os\'\n(eval):1: == not found'
    expect(blameBinary(out, shellSegments(cmd))).toBe('echo')
  })

  it('blames a glob no-match only when its failure could reach the exit code', () => {
    // A glob no-match skips its own command instead of abandoning the list, so
    // unlike an abort it has to be shown to matter. Measured under zsh:
    // `grep --include=*.x; echo B` prints B and exits 0 — the call's error came
    // from elsewhere, so grep is not to blame. Behind an `&&` the chain stops
    // there, and it is.
    const err = '(eval):1: no matches found: --include=*.ts'
    expect(blameBinary(err, shellSegments('grep -rn x src/ --include=*.ts && echo done'))).toBe('grep')
    expect(blameBinary(err, shellSegments('echo hi; grep -rn x src/ --include=*.ts'))).toBe('grep')
    expect(blameBinary(err, shellSegments('grep -rn x src/ --include=*.ts; echo done'))).not.toBe('grep')
  })

  it('takes the FIRST segment holding the word — the shell stops at the first one', () => {
    const cmd = 'echo === && printf === && ls'
    expect(blameBinary('(eval):1: == not found', shellSegments(cmd))).toBe('echo')
  })

  it('blames a navigation builtin the shell named, even though it is never a roster row', () => {
    // `cd docs` failing means nothing after the `&&` ran, so charging `cat` would
    // be wrong. `cd` is not a rostered binary, so blaming it charges the error to
    // no binary at all — which is the correct outcome, not a lost one.
    const cmd = 'cd docs && cat messaging.md && echo done'
    expect(blameBinary('(eval):cd:1: no such file or directory: docs', shellSegments(cmd))).toBe('cd')
  })

  it('exposes navigation builtins on the segment without rostering them', () => {
    const segs = shellSegments('cd docs && npm test')
    expect(segs[0]).toMatchObject({ binary: null, builtin: 'cd' })
    expect(segs[1]).toMatchObject({ binary: 'npm' })
    // The roster still sees only real tools.
    expect(shellBinaries('cd docs && npm test')).toEqual(['npm'])
  })

  it('does not make control keywords blameable', () => {
    // `for`/`done` cannot fail in a way worth attributing.
    expect(shellSegments('for f in a b; do npm test; done')[0]).toMatchObject({ binary: null, builtin: undefined })
  })

  it('stays silent when the rejected word is in a segment that runs nothing', () => {
    // `cd` is navigation, so there is no binary to carry the failure.
    expect(blameBinary('zsh:1: no matches found: build/*', shellSegments('cd build/*'))).toBeNull()
  })

  it('will not locate a one-character word — it would match almost any segment', () => {
    expect(blameBinary('(eval):1: = not found', shellSegments('echo = && ls'))).toBeNull()
  })

  it('prefers a named binary over locating a word', () => {
    // When the output names a real binary, that beats the fuzzier token search.
    const cmd = 'ls missing && echo ==='
    expect(blameBinary('ls: missing: No such file or directory', shellSegments(cmd))).toBe('ls')
  })

  it('ignores blame lines far down a long payload', () => {
    // A binary named 500 lines into a successful-looking dump is not the failure
    // prefix; capping the scan keeps a stray mention from becoming a verdict.
    const out = new Array(400).fill('some output line').join('\n') + '\nnpm: this is too far down to trust'
    expect(blameBinary(out, segs('npm', 'echo'))).toBeNull()
  })
})
