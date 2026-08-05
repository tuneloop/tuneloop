/**
 * What binaries does a shell command actually invoke?
 *
 * The built-in tools roster promotes shell binaries (`git`, `gh`, `npm`, …) to
 * top-level rows, so a `Bash` call has to be resolved to the tools it ran — and a
 * real agent command is rarely one tool: `cd repo && npm run build | tee log`
 * involves both `npm` and `tee`. So this returns an ordered **list**, and the
 * roster's semantics are "calls **involving** `git`" (a compound call counts
 * toward every binary in it; per-row counts deliberately don't sum to the shell
 * total — see docs/plans/mcp-agent-tools-tab.md).
 *
 * A small parser, not a regex: separators inside quotes, `$(…)`, backticks and
 * heredoc bodies are text, not chain boundaries, and getting that wrong invents
 * binaries out of a heredoc'd Python script. It is deliberately shallow
 * otherwise — a runner like `npx`/`uv run` reports as itself, since collapsing it
 * to the wrapped tool is a guess, and this feeds a roster where a wrong-but-
 * confident label is worse than a coarse one.
 *
 * Pure and deterministic: it runs at ingest for every shell call, and the output
 * must be stable across re-ingest (it drives a roster + filter).
 */

/**
 * Its own segment yields nothing — it moves/sets shell state or opens a control
 * structure, and runs no tool. `for f in a b` must yield nothing rather than `f`,
 * which is why loop/case headers live here and not in PREFIXES.
 */
const NAVIGATION = new Set([
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', ':',
  'local', 'readonly', 'declare', 'typeset', 'alias',
  'for', 'while', 'until', 'case', 'select',
  'done', 'fi', 'esac', 'break', 'continue', 'return', 'exit', 'shift',
])

/**
 * Navigation builtins that can genuinely FAIL and that the shell names when they
 * do (`(eval):cd:1: no such file or directory: docs`). They are still not roster
 * entities — nobody wants a `cd` row with 1,273 calls sitting second behind
 * `echo`, and putting it in the multi-label would have it accumulating errors
 * that belong to whatever ran after it. But a failure the shell explicitly pins
 * on `cd` should be attributed to `cd` rather than left to smear across the rest
 * of the chain, so blame may name one of these even though the roster never does.
 *
 * Control keywords (`for`, `done`, `fi`, `exit`) are deliberately absent: they
 * don't fail in a way worth attributing.
 */
export const BLAMEABLE_BUILTINS = new Set([
  'cd', 'pushd', 'popd', 'source', '.', 'export', 'unset', 'set',
  'alias', 'local', 'readonly', 'declare', 'typeset',
])

/** Shell keywords that merely precede a command: step over and keep looking. */
const PREFIXES = new Set(['do', 'then', 'else', 'elif', 'if', '!'])

/** Runs another command; the interesting binary is further right. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'timeout', 'nohup', 'nice', 'command', 'exec', 'stdbuf', 'eval'])

/** Wrapper flags that swallow the NEXT token, which would otherwise read as the binary. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '--user', '--group', '--prompt']),
  doas: new Set(['-u', '-C']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S']),
  stdbuf: new Set(['-i', '-o', '-e']),
}

/** Wrappers that take a bare numeric argument (`timeout 30 pytest`, `nice 10 make`). */
const NUMERIC_ARG_WRAPPERS = new Set(['timeout', 'nice'])

/** `sh -c '<command>'` is a transport, not a tool: parse what's inside it. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/
const REDIRECT = /^\d*[<>]/

/** What an executable can actually be named — a bare name or a relative path. */
const PLAUSIBLE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._+/-]*$/

/**
 * Above this, the "chain" isn't one: it's quoted source code that a stray
 * apostrophe unquoted, so the regexes inside it read as pipes (`node -e '…'`
 * holding a classifier produced 117). Over a real corpus the honest maximum was
 * 12 — a wide gap, so the guard can be well clear of legitimate commands. When it
 * trips we keep only the first segment, which is the part that parsed before the
 * quoting went wrong.
 */
const MAX_BINARIES = 16

/** Guards a pathological `sh -c "sh -c ..."` nest; three levels is already absurd. */
const MAX_SHELL_DEPTH = 3

/**
 * One command in the chain: what it runs, and the words it runs it with.
 *
 * The tokens are kept because a failure sometimes has to be traced back to the
 * segment that caused it — the shell names an offending WORD (`== not found`,
 * `no matches found: docs/*.swp`) rather than a command, and the only way from
 * that word to a binary is to find which segment contained it. See core/shell-blame.
 */
export interface ShellSegment {
  /** The binary this segment runs; null when it runs none (`cd`, a test, a `$VAR`). */
  binary: string | null
  /**
   * The navigation builtin this segment runs, when it runs one — `cd`, `source`,
   * `export`. Never a roster entity (see BLAMEABLE_BUILTINS), but a failure the
   * shell pins on it can be attributed to it, which keeps that failure off the
   * binaries that ran after it.
   */
  builtin?: string
  /** The segment's words, quotes stripped. */
  tokens: string[]
  /**
   * The separator that PRECEDED this segment; null for the first. It carries the
   * shell's exit-status rule: after `;`, a newline or a `|`, this segment is
   * guaranteed to have run, so if it is the last one its status IS the command's.
   * After `&&`/`||` that guarantee is gone — an earlier segment may have failed
   * and stopped the chain.
   */
  sep: SegmentSep | null
}

export type SegmentSep = '&&' | '||' | '|' | ';' | '\n' | '(' | ')'

/**
 * The command chain, segment by segment, in order — `sh -c` scripts flattened in
 * as their own segments. Nothing is de-duplicated here: a caller asking which
 * segment failed needs every one of them, in the order the shell ran them.
 */
export function shellSegments(command: string): ShellSegment[] {
  const segs = collectSegments(segments(command), 0)
  // The same mis-parse guard shellBinaries applies: past this many, quoting broke
  // and the "chain" is really quoted source code, so trust only its first segment.
  const named = segs.filter((x) => x.binary).length
  return named <= MAX_BINARIES ? segs : collectSegments(segments(command).slice(0, 1), 0)
}

/**
 * The ordered, de-duplicated binaries a shell command involves. Empty when the
 * command runs no tool of its own (`cd /repo`, a bare redirect, blank input).
 *
 * De-duplicated because the consumer asks "did this call involve `git`?", never
 * "how many times" — and repeats would fan out any join over the child table.
 * `seq` therefore records first appearance in the chain.
 */
export function shellBinaries(command: string): string[] {
  return dedupe(shellSegments(command).map((s) => s.binary).filter((b): b is string => !!b))
}

function dedupe(bins: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const bin of bins) {
    if (seen.has(bin)) continue
    seen.add(bin)
    out.push(bin)
  }
  return out
}

/**
 * Resolve each token list to a segment. A `sh -c '<script>'` segment is replaced
 * by the script's OWN segments, so the chain reads as what actually ran rather
 * than as the transport that carried it.
 */
function collectSegments(segs: RawSegment[], depth: number): ShellSegment[] {
  const out: ShellSegment[] = []
  for (const { tokens, sep } of segs) {
    const inner = inlineShellIn(tokens)
    if (inner !== undefined) {
      if (depth >= MAX_SHELL_DEPTH) continue
      const nested = collectSegments(segments(inner), depth + 1)
      // The script's first command inherits the separator that introduced the
      // `sh -c` itself — that's the join the outer chain actually made.
      if (nested[0]) nested[0] = { ...nested[0], sep }
      out.push(...nested)
      continue
    }
    out.push({ ...binaryOf(tokens), tokens, sep })
  }
  return out
}

interface RawSegment {
  tokens: string[]
  sep: SegmentSep | null
}

/** The inline script of a `sh -c` segment, or undefined when it isn't one. */
function inlineShellIn(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const name = binaryName(tokens[i] ?? '')
    if (SHELLS.has(name)) return inlineShellScript(tokens, i)
    // Only a LEADING shell counts; `git commit -m "bash"` must not recurse.
    if (name && !PREFIXES.has(name) && !WRAPPERS.has(name) && !tokens[i]!.startsWith('-')) return undefined
  }
  return undefined
}

/**
 * Split into top-level command segments, each as its list of tokens (quotes
 * stripped). Boundaries: `&&`, `||`, `|`, `;`, newline, and subshell parens.
 * A lone `&` is NOT a boundary — it would cut `2>&1` in half, and backgrounding
 * is vanishingly rare in agent commands next to that cost.
 */
function segments(command: string): RawSegment[] {
  const segs: RawSegment[] = []
  let cur: string[] = []
  let tok = ''
  /** The separator that opened `cur`; null for the first segment. */
  let segSep: SegmentSep | null = null
  /** Heredoc delimiters opened on this line, awaiting their body at the newline. */
  let pending: string[] = []

  const endToken = () => {
    if (tok) cur.push(tok)
    tok = ''
  }
  /** Close the current segment; `nextSep` is the separator that opens the next one. */
  const endSegment = (nextSep: SegmentSep | null = null) => {
    endToken()
    if (cur.length) segs.push({ tokens: cur, sep: segSep })
    cur = []
    segSep = nextSep
  }

  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]!

    if (c === '\\' && i + 1 < n) {
      tok += command[i + 1]
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const [text, next] = readQuoted(command, i)
      tok += text
      i = next
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      const end = skipBalanced(command, i + 2)
      tok += command.slice(i, end)
      i = end
      continue
    }
    if (c === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? n : end + 1
      tok += command.slice(i, stop)
      i = stop
      continue
    }
    // A `#` opening a word comments out the rest of the LINE (a `#` inside a word
    // is literal — `http://x#frag`).
    if (c === '#' && !tok) {
      const nl = command.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    // Heredoc: remember the delimiter, drop the operator, and skip the body when
    // the line ends. `<<<` is a herestring, not a heredoc — leave it as text.
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const [delim, next] = readHeredocDelimiter(command, i + 2)
      if (delim) pending.push(delim)
      endToken()
      i = next
      continue
    }
    if (c === '\n') {
      endSegment('\n')
      i = skipHeredocBodies(command, i + 1, pending)
      pending = []
      continue
    }
    if (c === '&' && command[i + 1] === '&') {
      endSegment('&&')
      i += 2
      continue
    }
    if (c === '|') {
      const double = command[i + 1] === '|'
      endSegment(double ? '||' : '|')
      i += double ? 2 : 1
      continue
    }
    // `cnt() { … }` DEFINES a helper; it runs nothing, so the header is dropped
    // rather than reported as a binary. (A later call to it is indistinguishable
    // from a real binary, and is counted — which is honest: something ran.)
    if (c === '(' && command[i + 1] === ')') {
      endToken()
      cur = []
      i += 2
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      endSegment(c as SegmentSep)
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endToken()
      i += 1
      continue
    }
    tok += c
    i += 1
  }
  endSegment()
  return segs
}

/**
 * Read a quoted run starting at `start`; returns its contents (quotes stripped).
 * Inside DOUBLE quotes, `$(…)` and backticks stay live and may contain quotes of
 * their own — `echo "n: $(sqlite3 "$DB" "SELECT 1")"` ends at the LAST quote, not
 * the one before `$DB`. Missing that desynchronizes the whole scan and spills the
 * SQL out as if it were commands. Single quotes are wholly literal.
 */
function readQuoted(s: string, start: number): [string, number] {
  const quote = s[start]!
  let out = ''
  let i = start + 1
  while (i < s.length) {
    const c = s[i]!
    if (quote === '"') {
      if (c === '\\' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
        continue
      }
      if (c === '$' && s[i + 1] === '(') {
        const end = skipBalanced(s, i + 2)
        out += s.slice(i, end)
        i = end
        continue
      }
      if (c === '`') {
        const end = s.indexOf('`', i + 1)
        const stop = end === -1 ? s.length : end + 1
        out += s.slice(i, stop)
        i = stop
        continue
      }
    }
    if (c === quote) return [out, i + 1]
    out += c
    i += 1
  }
  return [out, s.length] // unterminated quote: take the rest
}

/** Index just past the `)` closing a `$(` opened before `start`. */
function skipBalanced(s: string, start: number): number {
  let depth = 1
  let i = start
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      i = readQuoted(s, i)[1]
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return s.length
}

/** After `<<`, read the (possibly quoted, possibly `-`-prefixed) body delimiter. */
function readHeredocDelimiter(s: string, start: number): [string, number] {
  let i = start
  if (s[i] === '-') i += 1
  while (s[i] === ' ' || s[i] === '\t') i += 1
  let delim = ''
  while (i < s.length) {
    const c = s[i]!
    if (c === "'" || c === '"') {
      const [text, next] = readQuoted(s, i)
      delim += text
      i = next
      continue
    }
    if (/[\s;|&<>()]/.test(c)) break
    delim += c
    i += 1
  }
  return [delim, i]
}

/** Consume each pending heredoc body, stopping after its terminator line. */
function skipHeredocBodies(s: string, start: number, delims: string[]): number {
  let i = start
  for (const delim of delims) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i)
      const end = nl === -1 ? s.length : nl
      const line = s.slice(i, end)
      i = nl === -1 ? s.length : nl + 1
      if (line.trim() === delim) break
    }
  }
  return i
}

/** The single binary one segment invokes, or null when it invokes none. */
function binaryOf(tokens: string[]): { binary: string | null; builtin?: string } {
  /** Set while stepping over a wrapper's own options (`sudo -u x`, `timeout 30`). */
  let wrapper: string | null = null
  let i = 0
  while (i < tokens.length) {
    const raw = tokens[i]!
    // A condition, not an invocation: `[ -x /bin/ls ]` names a path it does not run.
    if (raw === '[' || raw === '[[' || raw === 'test') return { binary: null }
    // Not a binary at any position: blank, a VAR=x prefix, a redirect, a flag, or
    // punctuation (`{`, `]`, `;` from an escaped `\;`).
    if (!raw || ASSIGNMENT.test(raw) || REDIRECT.test(raw) || raw.startsWith('-') || !/[A-Za-z0-9]/.test(raw)) {
      i += WRAPPER_VALUE_FLAGS[wrapper ?? '']?.has(raw) ? 2 : 1
      continue
    }
    // `"$CHROME" --headless` runs something we can't name without executing the
    // shell. Nothing beats a wrong label here, so the segment yields nothing.
    if (raw.startsWith('$')) return { binary: null }
    if (wrapper) {
      if (NUMERIC_ARG_WRAPPERS.has(wrapper) && DURATION.test(raw)) {
        i += 1
        continue
      }
      wrapper = null
    }
    const name = binaryName(raw)
    // An unnameable first word means the segment came out of a mis-parse (a
    // regex fragment, a `{3,4}` quantifier); we don't know what ran, so say so.
    if (!PLAUSIBLE_NAME.test(name)) return { binary: null }
    if (PREFIXES.has(name)) {
      i += 1
      continue
    }
    // Runs no tool, so it is never a roster row — but remember WHICH builtin, so a
    // failure the shell pins on it can be attributed rather than smeared.
    if (NAVIGATION.has(name)) return { binary: null, builtin: BLAMEABLE_BUILTINS.has(name) ? name : undefined }
    if (WRAPPERS.has(name)) {
      wrapper = name
      i += 1
      continue
    }
    return { binary: name }
  }
  return { binary: null }
}

/**
 * The script a `sh -c` runs, or undefined when this shell invocation isn't one
 * (`bash script.sh`). Empty string when `-c` is the last token — the parse
 * yields nothing, which is the honest answer.
 */
function inlineShellScript(tokens: string[], shellIdx: number): string | undefined {
  for (let i = shellIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (/^-[a-z]*c$/.test(t)) return tokens[i + 1] ?? ''
    if (!t.startsWith('-')) return undefined // a script path, not an inline command
  }
  return undefined
}

/**
 * The roster name for a token. An absolute or home-relative path is the same
 * tool wherever it lives, so it reduces to its basename; a repo-relative path
 * (`./deploy.sh`, `scripts/gen.ts`) is kept whole, because the path is what
 * identifies it as this project's own script.
 */
function binaryName(token: string): string {
  const t = token.startsWith('~/') ? token.slice(1) : token
  if (!t.startsWith('/')) return token
  const base = t.slice(t.lastIndexOf('/') + 1)
  return base
}
