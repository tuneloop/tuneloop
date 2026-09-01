/**
 * Shell-mediated edits, recovered from the transcript alone.
 *
 * Agents edit files through the Bash tool — `sed -i`, python heredocs,
 * `cat > file` — and for those the transcript records only the command text:
 * the file's before/after content is never written down. Measured on a real
 * corpus, ~7% of all file mutations take this path, so they miss files-touched
 * (hotspots), authored-lines (aiShare undercounts), and block-grain cost.
 *
 * Recovery reads the command itself. Commands leak different amounts of the
 * edit: a heredoc write carries the whole new file (a `Write` in costume), a
 * python literal `s.replace("old","new")` carries both sides (an `Edit` in
 * costume), `sed -i`/`perl -i` carry only the path — a pattern is not the
 * lines it matched. Each recovery surfaces as a synthesized `file_write` tool
 * call anchored to its Bash call via `parentId`; a PARSE_VERSION bump
 * re-derives every stored session on the next `analyze`.
 */
import { heredocSpans, shellSegments } from '../../core/shell-binaries'
import type { ToolCall } from '../../core/model'
/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

/** One old→new pair, shaped exactly like a Claude `Edit`/`MultiEdit` entry so
 *  the authored-lines claude extractor consumes it with no special case. */
export interface EditPair {
  old_string: string
  new_string: string
}

export interface SynthesizedEdit {
  path: string
  /** Whole-file content (Write shape) — heredoc/redirect writes. */
  content?: string
  /** Hunk pairs (MultiEdit shape) — python literal replaces. */
  edits?: EditPair[]
}

// ---------------------------------------------------------------------------
// Parsing tier: recover edits from the command text itself
// ---------------------------------------------------------------------------

/**
 * One heredoc found by a single left-to-right scan. The scan advances PAST each
 * body before looking for the next opener, so an example command written INTO
 * a file (`cat > doc.md <<'DOC'` whose body contains another `cat > … <<EOF`)
 * can never be mistaken for a command that ran — the phantom-edit trap.
 */
interface Heredoc {
  /** The command line containing the `<<MARKER` opener. */
  openerLine: string
  body: string
  /** [start, end) offsets of the body within the command, for masking. */
  bodyStart: number
  bodyEnd: number
}

/** Heredocs located by the SAME grammar the shell tokenizer uses (see
 *  heredocSpans): quote-aware, `<<<`-is-a-herestring, any real delimiter. A
 *  second regex grammar here once over-matched herestrings (fabricating the
 *  FOLLOWING commands as file content) and under-matched END-1 style markers
 *  (leaking unmasked bodies) — one grammar, two consumers, no drift. */
function scanHeredocs(command: string): Heredoc[] {
  return heredocSpans(command).map((h) => ({
    openerLine: h.openerLine,
    body: command.slice(h.bodyStart, h.bodyEnd),
    bodyStart: h.bodyStart,
    bodyEnd: h.bodyEnd,
  }))
}

/** The command with heredoc bodies blanked out (newlines kept so segment
 *  boundaries survive) — bodies are file CONTENT, not commands that ran. A
 *  python heredoc's body IS the script, so those stay when `keepPython`. */
function maskHeredocBodies(command: string, heredocs: Heredoc[], keepPython: boolean): string {
  let out = command
  for (const h of heredocs) {
    if (keepPython && pipesIntoPython(h.openerLine)) continue
    const masked = out.slice(h.bodyStart, h.bodyEnd).replace(/[^\n]/g, ' ')
    out = out.slice(0, h.bodyStart) + masked + out.slice(h.bodyEnd)
  }
  return out
}

/** Whether a heredoc's body is CONSUMED by a python interpreter — asked of
 *  the opener line's segment binaries, never of its raw text: a target named
 *  docs/python-tips.md must not turn its own body into a "script" (the
 *  phantom-edit trap the masking exists to prevent). */
function pipesIntoPython(openerLine: string): boolean {
  return shellSegments(openerLine).some((seg) => seg.binary === 'python' || seg.binary === 'python3')
}

/** Idioms recovered from a Bash command. Only called for commands that
 *  SUCCEEDED — a failed command edited nothing, whatever it intended. */
export function editsFromCommand(command: string): SynthesizedEdit[] {
  const heredocs = scanHeredocs(command)
  // Bodies written to FILES must never be scanned as commands or scripts;
  // bodies piped into python ARE the script the python extractors need.
  const cmdOnly = maskHeredocBodies(command, heredocs, false)
  const withPython = maskHeredocBodies(command, heredocs, true)

  const out: SynthesizedEdit[] = []
  const covered = new Set<string>()
  // Paths written from INSIDE a python script: their write position in the
  // command is the python segment itself, which the rm ordering below needs.
  const pythonPaths = new Set<string>()
  for (const e of heredocWrites(heredocs)) {
    // Content-carrying recoveries know their target with certainty (it is the
    // redirect/open target, not a guessed operand) — so only sanity-check the
    // token, never require an extension: `Dockerfile` and `Makefile` count.
    if (!isSanePath(e.path) || covered.has(e.path)) continue
    covered.add(e.path)
    out.push(e)
  }
  for (const e of pythonReplaces(withPython)) {
    if (!isSanePath(e.path) || covered.has(e.path)) continue
    covered.add(e.path)
    pythonPaths.add(e.path)
    out.push(e)
  }
  // Path-only recovery for the idioms whose lines are not in the command: a
  // sed/perl pattern is not the lines it matched, and a computed python edit
  // carries no literals. The path alone still lights up files-touched — but a
  // path that already earned a full entry above must not gain a duplicate.
  for (const p of sedPerlTargets(cmdOnly)) {
    if (covered.has(p)) continue
    covered.add(p)
    out.push({ path: p })
  }
  for (const p of pythonWriteTargets(withPython)) {
    if (covered.has(p)) continue
    covered.add(p)
    pythonPaths.add(p)
    out.push({ path: p })
  }
  // A file this same command REMOVES after (last) writing it was scratch, not
  // an edit (`cat > t.test.ts <<EOF …; vitest t.test.ts; rm -f t.test.ts`). An
  // rm BEFORE the write (delete-then-rewrite) keeps its credit.
  const removed = scratchRemoved(cmdOnly, pythonPaths)
  return out.filter((e) => !removed.has(scratchPathKey(e.path)))
}

/**
 * Comparison identity for paths within one shell command. Empty and `.` path
 * components do not change traversal, so `./t.ts`, `t.ts`, and `src//x.ts`
 * can safely share a key. Deliberately preserve `..` (symlinks can change its
 * meaning) and a leading `//` (implementation-defined by POSIX): this is not a
 * claim to canonicalize arbitrary filesystem paths.
 */
function scratchPathKey(path: string): string {
  if (path.startsWith('//')) return path
  const absolute = path.startsWith('/')
  const parts = path.split('/').filter((part) => part && part !== '.')
  const joined = parts.join('/')
  return absolute ? `/${joined}` : joined
}

/**
 * Paths whose LAST write/remove event in segment order is a removal. Both
 * event kinds come from the tokenizer's segments, so a quoted "rm …" sentence
 * (a commit message, an echo) is one token of another command — never a
 * removal — and a later textual MENTION of a path revives nothing: only
 * write-shaped events (redirect targets, tee/sed/perl operands, a python
 * segment for the paths its masked script wrote) count as writes.
 * Conservative where matching gets fuzzy: `-r` directory removals and glob
 * operands are ignored, and an rm hidden inside `sh -c "…"` is invisible to
 * the tokenizer, so its file keeps credit rather than guessing.
 */
function scratchRemoved(cmdOnly: string, pythonPaths: Set<string>): Set<string> {
  const lastWrite = new Map<string, number>()
  const lastRm = new Map<string, number>()
  const pythonPathKeys = new Set([...pythonPaths].map(scratchPathKey))
  let lastPy = -1
  shellSegments(cmdOnly).forEach((seg, k) => {
    if (seg.binary === 'python' || seg.binary === 'python3') lastPy = k
    if (seg.binary === 'rm') {
      const args = seg.tokens.slice(binaryIndex(seg.tokens, 'rm') + 1)
      if (args.some((a) => /^-[a-zA-Z]*r/i.test(a))) return // directory removal — out of scope
      for (const a of args) {
        if (a.startsWith('-') || /[*?[]/.test(a)) continue
        lastRm.set(scratchPathKey(a), k)
      }
      return
    }
    for (let i = 0; i < seg.tokens.length; i++) {
      const t = seg.tokens[i]!
      if ((t === '>' || t === '>>') && seg.tokens[i + 1]) lastWrite.set(scratchPathKey(seg.tokens[i + 1]!), k)
      else if (t.startsWith('>') && t.length > 1 && !t.startsWith('>&')) lastWrite.set(scratchPathKey(t.replace(/^>{1,2}/, '')), k)
    }
    if (seg.binary === 'tee') {
      for (const t of seg.tokens.slice(binaryIndex(seg.tokens, 'tee') + 1)) {
        if (!t.startsWith('-')) lastWrite.set(scratchPathKey(t), k)
      }
    }
    if (seg.binary === 'sed' || seg.binary === 'perl') {
      for (const p of inPlaceOperands(seg)) lastWrite.set(scratchPathKey(p), k)
    }
  })
  const out = new Set<string>()
  for (const [p, rmK] of lastRm) {
    const wK = Math.max(lastWrite.get(p) ?? -1, pythonPathKeys.has(p) ? lastPy : -1)
    if (rmK > wK) out.add(p)
  }
  return out
}

/** Index of the segment's binary token — matched by name OR trailing path
 *  component, so `/usr/bin/sed` resolves instead of silently yielding -1. */
function binaryIndex(tokens: string[], binary: string): number {
  return tokens.findIndex((t) => t === binary || t.endsWith('/' + binary))
}

/**
 * A heredoc whose opener line writes a file — `cat > f <<'EOF'`,
 * `cat <<'EOF' > f`, or `… <<'EOF' | tee f` — in ANY word order: the opener
 * line is tokenized by the real shell tokenizer (word boundaries and quoting
 * included, so `concat`/`committee` never match), and the target is the
 * `>`/`>>` redirect operand or tee's file operand. The body IS the new file.
 */
function heredocWrites(heredocs: Heredoc[]): SynthesizedEdit[] {
  const out: SynthesizedEdit[] = []
  for (const h of heredocs) {
    for (const seg of shellSegments(h.openerLine)) {
      let path: string | undefined
      let append = false
      for (let i = 0; i < seg.tokens.length; i++) {
        const t = seg.tokens[i]!
        if ((t === '>' || t === '>>') && seg.tokens[i + 1]) {
          path = seg.tokens[i + 1]
          append = t === '>>'
        } else if (t.startsWith('>') && t.length > 1 && !t.startsWith('>&')) {
          path = t.replace(/^>{1,2}/, '')
          append = t.startsWith('>>')
        }
      }
      if (!path && seg.binary === 'tee') {
        path = seg.tokens.slice(1).find((t) => !t.startsWith('-'))
        append = seg.tokens.includes('-a')
      }
      if (path) {
        // Only cat/tee pass their input through verbatim — for them the body
        // IS the file. Any other binary with a redirect certainly WROTE the
        // file, but its output is not the heredoc body: path-only.
        const verbatim = seg.binary === 'cat' || seg.binary === 'tee' || seg.binary === null
        // An APPEND knows what was added but not the file's content — that is
        // an Edit in shape (old side empty), never a Write: claiming the body
        // as whole-file content would replay a false full rewrite downstream.
        out.push(!verbatim ? { path } : append ? { path, edits: [{ old_string: '', new_string: h.body }] } : { path, content: h.body })
        break
      }
    }
  }
  return out
}

/**
 * Python literal replace: the script must visibly READ and WRITE the same
 * path (reads-A-writes-B gets no line credit — the literals describe A, not
 * B), and each `.replace(old, new)` with two string literals contributes one
 * edit pair. Both quote styles and triple quotes are handled; escape
 * sequences are decoded the way python would.
 */
function pythonReplaces(command: string): SynthesizedEdit[] {
  if (!command.includes('.replace(')) return []
  const reads = new Set(openCalls(command, 'r'))
  const writes = new Set(openCalls(command, 'w'))
  const both = [...writes].filter((p) => reads.has(p))
  if (both.length !== 1) return []
  const path = both[0]!

  const edits: EditPair[] = []
  // Disjoint per quote style — overlapping alternation branches backtrack
  // exponentially on escape-heavy strings.
  const re =
    /\.replace\(\s*(?:("""|\'\'\')([\s\S]*?)\1|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)")\s*,\s*(?:("""|\'\'\')([\s\S]*?)\5|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)")\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    const oldS = m[2] !== undefined ? pyUnescape(m[2]) : pyUnescape(m[3] ?? m[4] ?? '')
    const newS = m[6] !== undefined ? pyUnescape(m[6]) : pyUnescape(m[7] ?? m[8] ?? '')
    if (oldS) edits.push({ old_string: oldS, new_string: newS })
  }
  return edits.length ? [{ path, edits }] : []
}

/**
 * Paths passed to python `open(...)`, filtered by mode. Real scripts rarely
 * inline the path — the dominant shape (measured on the live corpus) is
 * `p='path'` once, then `open(p)` / `open(p,'w')` — so bare identifiers are
 * resolved through simple `var = 'literal'` assignments first.
 */
function openCalls(command: string, mode: 'r' | 'w'): string[] {
  const vars = new Map<string, string>()
  // Trailing whitespace is matched with a LOOKAHEAD — consuming the newline
  // would eat the anchor the NEXT assignment needs, silently dropping every
  // assignment that follows another one.
  const assign = /(?:^|\n)[ \t]*(\w+)[ \t]*=[ \t]*(?:'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)")[ \t]*(?=\n|$)/g
  let a: RegExpExecArray | null
  while ((a = assign.exec(command))) vars.set(a[1]!, pyUnescape((a[2] ?? a[3])!))

  const out: string[] = []
  const re = /open\(\s*(?:'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|(\w+))\s*(?:,\s*["']([rwab+]+)["'])?\s*[,)]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    const raw = m[1] ?? m[2]
    const path = raw !== undefined ? pyUnescape(raw) : vars.get(m[3]!)
    if (!path) continue
    const mode2 = m[4] ?? 'r' // open(path) defaults to read
    const isWrite = /[wa+]/.test(mode2)
    if ((mode === 'w') === isWrite) out.push(path)
  }
  return out
}

/**
 * `sed -i` / `perl -i`: the file operands, taken from the real shell
 * tokenizer's segments — so a "sed" inside a quoted string is not a command,
 * operands never cross into the next segment, and quoting is already
 * resolved. The first non-option operand is sed's SCRIPT when no `-e` was
 * given, never a file (`s/area/weight/` is not a path). Pattern edits carry
 * no lines, so these yield path-only entries.
 */
function sedPerlTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of shellSegments(command)) {
    if (seg.binary !== 'sed' && seg.binary !== 'perl') continue
    out.push(...inPlaceOperands(seg).filter(looksLikeFile))
  }
  return out
}

/** File operands of an in-place sed/perl segment; [] when not in-place.
 *  In-place is the LOWERCASE `-i` flag (possibly bundled: -pi, -i.bak) —
 *  case-exact, because perl's `-Ilib` include flag also contains an i and a
 *  read-only `perl -Ilib -ne …` must never yield a phantom write. With no
 *  `-e`, the first non-option operand is the SCRIPT — sed's inline program or
 *  perl's program FILE — never an edited target. */
function inPlaceOperands(seg: { binary: string | null; tokens: string[] }): string[] {
  if (seg.binary !== 'sed' && seg.binary !== 'perl') return []
  const bi = binaryIndex(seg.tokens, seg.binary)
  if (bi < 0) return []
  const args = seg.tokens.slice(bi + 1)
  if (!args.some((t) => /^-[a-z]*i/.test(t))) return []
  let scriptConsumed = args.some((t) => /^-\w*e$/.test(t) || /^-\w*e./.test(t))
  const out: string[] = []
  for (const t of args) {
    if (t.startsWith('-')) continue
    if (!scriptConsumed) {
      scriptConsumed = true // the inline script / program file, not a target
      continue
    }
    out.push(t)
  }
  return out
}

/** Python scripts that write files but carry no recoverable literals. */
function pythonWriteTargets(command: string): string[] {
  if (!/\bpython3?\b/.test(command)) return []
  return openCalls(command, 'w').filter(looksLikeFile)
}

/**
 * Guessed operands (sed/perl file arguments, python write targets) must be
 * conservatively filtered: sane path AND an extensioned basename — junk like
 * `s/a/b/` shapes or option-ish tokens must never become file artifacts.
 */
function looksLikeFile(t: string): boolean {
  if (!isSanePath(t)) return false
  if (/^[a-z]\//i.test(t) && /\/.*\//.test(t) && !t.includes('.')) return false // s/a/b/ shapes
  const base = t.split('/').pop() ?? ''
  return /^[\w.@-]+$/.test(base) && base.includes('.')
}

/** Sanity for a path we are CERTAIN about (a redirect/open target is not a
 *  guess): no scratch, no URLs, no shell metacharacters or unexpanded $VARS —
 *  but extensionless names (`Dockerfile`, `Makefile`) are fine. */
function isSanePath(t: string): boolean {
  if (!t || t.startsWith('/tmp/') || t.startsWith('/private/tmp/')) return false
  // `> /dev/null` is DISCARDED output, not a file edit (13 hits on the live
  // corpus, every one a redirect-to-silence) — and /dev generally is devices.
  if (t === '/dev/null' || t.startsWith('/dev/')) return false
  if (/^https?:/.test(t) || t.startsWith('-')) return false
  if (/["'()\[\]{}$\\,;|&<>*`\s]/.test(t)) return false
  return /^[\w.@\/-]+$/.test(t)
}

/** Decode python escape sequences the way python would — including hex,
 *  unicode, octal, and the control escapes; not just the common five. */
function pyUnescape(s: string): string {
  return s.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|n|t|r|a|b|f|v|\\|'|")/g,
    (_, c: string) => {
      if (c[0] === 'x' || c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16))
      if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8))
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' }
      return map[c] ?? c
    },
  )
}

// ---------------------------------------------------------------------------
// Synthesis: every recovery lands as the same kind of tool call
// ---------------------------------------------------------------------------

/**
 * A synthesized `file_write` call. `parentId` anchors it to the Bash call it
 * was recovered from (the model's documented meaning for that field), the
 * MultiEdit/Write-shaped `input` feeds authored-lines untouched, and the
 * `file_write` action feeds files-touched untouched.
 */
export function synthShellEdit(
  edit: SynthesizedEdit,
  anchor: { bashId: string; n: number; ts?: string; isSidechain: boolean },
): ToolCall {
  const input: Record<string, unknown> = { file_path: edit.path }
  if (edit.content !== undefined) input.content = edit.content
  if (edit.edits !== undefined) input.edits = edit.edits
  return {
    id: `${anchor.bashId}#shell-edit-${anchor.n}`,
    parentId: anchor.bashId,
    name: 'ShellEdit',
    action: 'file_write',
    // Derived, not invoked: the model never called a tool named ShellEdit, so
    // per-tool analytics (tool health, n_tool_calls) must not count it.
    derived: true,
    input,
    target: { paths: [edit.path] },
    result: { ok: true, isError: false },
    isSidechain: anchor.isSidechain,
    ts: anchor.ts,
  }
}
