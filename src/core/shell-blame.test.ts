import { describe, expect, it } from 'vitest'
import { blameBinary } from './shell-blame'
import { shellSegments, type ShellSegment } from './shell-binaries'

/** A stand-in chain when the test cares about the binaries, not the command text. */
const segs = (...binaries: string[]): ShellSegment[] => binaries.map((b) => ({ binary: b, tokens: [b] }))

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

  it('does NOT blame a glob no-match — it is a different failure from an abort', () => {
    // Measured under zsh: an unresolvable WORD aborts the whole list and sets the
    // exit code whatever the separator, but a glob no-match only skips its own
    // command — `grep --include=*.x; echo B` prints B and exits 0. So the call's
    // error came from elsewhere, and blaming the glob's segment would be wrong.
    // It only propagates inside an `&&` chain, which needs separator awareness.
    const cmd = 'grep -rn x src/ --include=*.ts; echo done'
    expect(blameBinary('(eval):1: no matches found: --include=*.ts', shellSegments(cmd))).toBeNull()
  })

  it('takes the FIRST segment holding the word — the shell stops at the first one', () => {
    const cmd = 'echo === && printf === && ls'
    expect(blameBinary('(eval):1: == not found', shellSegments(cmd))).toBe('echo')
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
