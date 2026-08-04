import { describe, expect, it } from 'vitest'
import { blameBinary } from './shell-blame'

describe('blameBinary — naming the segment that failed', () => {
  it('blames the binary that prefixed the error line', () => {
    // The case that motivated this: `ls` failed, so the `tsc` after the `&&` never
    // ran at all — yet it was carrying the error and a 100% failure rate.
    const out = 'Error: Exit code 1\nls: node_modules/.bin/tsc: No such file or directory'
    expect(blameBinary(out, ['ls', 'echo', './node_modules/.bin/tsc', 'tail'])).toBe('ls')
  })

  it('matches a path-invoked binary by its basename', () => {
    expect(blameBinary('./node_modules/.bin/tsc: Permission denied', ['ls', './node_modules/.bin/tsc'])).toBe('./node_modules/.bin/tsc')
    expect(blameBinary('tsc: error TS2307: Cannot find module', ['npm', './node_modules/.bin/tsc'])).toBe('./node_modules/.bin/tsc')
  })

  it('reads the command named by a shell wrapper, not the wrapper', () => {
    expect(blameBinary('bash: line 1: pytest: command not found', ['pytest', 'echo'])).toBe('pytest')
    expect(blameBinary('/bin/sh: tsc: command not found', ['tsc'])).toBe('tsc')
  })

  it('finds the blame line among surrounding output', () => {
    const out = ['total 24', 'drwxr-xr-x  5 me  staff   160 Aug  4 09:00 .', '--- direct run ---', 'psql: error: connection refused'].join('\n')
    expect(blameBinary(out, ['ls', 'echo', 'psql'])).toBe('psql')
  })

  it('reads a usage dump as the tool complaining about its own invocation', () => {
    const out = '--yes required when not running interactively\nUsage:  gh gist delete {<id> | <url>} [flags]'
    expect(blameBinary(out, ['gh', 'echo', 'head'])).toBe('gh')
  })

  it('is silent when two different binaries are named — that is genuinely ambiguous', () => {
    expect(blameBinary('git: bad\nnpm: also bad', ['git', 'npm'])).toBeNull()
  })

  it('is silent when the named command is not one of the call\'s binaries', () => {
    // Never invent a row: blaming something the parser didn't see would create an
    // entity out of an error message.
    expect(blameBinary('docker: Cannot connect to the Docker daemon', ['npm', 'echo'])).toBeNull()
  })

  it('is silent when nothing names a binary', () => {
    expect(blameBinary('Error: Exit code 1', ['npm', 'echo'])).toBeNull()
    expect(blameBinary('', ['npm'])).toBeNull()
    expect(blameBinary('Segmentation fault', ['npm'])).toBeNull()
  })

  it('does not blame from a mid-line mention', () => {
    // "…run npm install" is advice, not a failure prefix.
    expect(blameBinary('Error: modules missing, try running npm install first', ['npm', 'node'])).toBeNull()
  })

  it('needs the colon-space shape, not a bare word', () => {
    expect(blameBinary('npm\nsomething went wrong', ['npm'])).toBeNull()
  })

  it('repeats of the SAME binary still blame it', () => {
    expect(blameBinary('git: bad ref\ngit: fatal: exiting', ['git', 'echo'])).toBe('git')
  })

  it('ignores blame lines far down a long payload', () => {
    // A binary named 500 lines into a successful-looking dump is not the failure
    // prefix; capping the scan keeps a stray mention from becoming a verdict.
    const out = new Array(400).fill('some output line').join('\n') + '\nnpm: this is too far down to trust'
    expect(blameBinary(out, ['npm', 'echo'])).toBeNull()
  })
})
