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
import { shellSegments } from '../../core/shell-binaries'
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

function scanHeredocs(command: string): Heredoc[] {
  const out: Heredoc[] = []
  const opener = /<<\s*(-?)\s*(?:'(\w+)'|"(\w+)"|(\w+))[^\n]*\n/g
  let m: RegExpExecArray | null
  while ((m = opener.exec(command))) {
    const marker = (m[2] ?? m[3] ?? m[4])!
    const dash = m[1] === '-'
    const lineStart = command.lastIndexOf('\n', m.index) + 1
    const openerLine = command.slice(lineStart, command.indexOf('\n', m.index) === -1 ? command.length : m.index + m[0].length - 1)
    const bodyStart = m.index + m[0].length
    // Terminator is a WHOLE line (a body line merely starting with the marker
    // does not end the capture); `<<-` allows tab indentation.
    const term = new RegExp(`\\n${dash ? '\\t*' : ''}${marker}(?:\\n|$)`)
    const hay = '\n' + command.slice(bodyStart)
    const tm = term.exec(hay)
    const bodyEnd = tm ? bodyStart + tm.index : command.length
    out.push({ openerLine, body: hay.slice(1, tm ? tm.index : undefined), bodyStart, bodyEnd })
    // Resume scanning AFTER the terminator — never inside the body.
    opener.lastIndex = tm ? bodyStart + tm.index + tm[0].length : command.length
  }
  return out
}

/** The command with heredoc bodies blanked out (newlines kept so segment
 *  boundaries survive) — bodies are file CONTENT, not commands that ran. A
 *  python heredoc's body IS the script, so those stay when `keepPython`. */
function maskHeredocBodies(command: string, heredocs: Heredoc[], keepPython: boolean): string {
  let out = command
  for (const h of heredocs) {
    if (keepPython && /\bpython3?\b/.test(h.openerLine)) continue
    const masked = out.slice(h.bodyStart, h.bodyEnd).replace(/[^\n]/g, ' ')
    out = out.slice(0, h.bodyStart) + masked + out.slice(h.bodyEnd)
  }
  return out
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
  for (const e of [...heredocWrites(heredocs), ...pythonReplaces(withPython)]) {
    // Content-carrying recoveries know their target with certainty (it is the
    // redirect/open target, not a guessed operand) — so only sanity-check the
    // token, never require an extension: `Dockerfile` and `Makefile` count.
    if (!isSanePath(e.path) || covered.has(e.path)) continue
    covered.add(e.path)
    out.push(e)
  }
  // Path-only recovery for the idioms whose lines are not in the command: a
  // sed/perl pattern is not the lines it matched, and a computed python edit
  // carries no literals. The path alone still lights up files-touched — but a
  // path that already earned a full entry above must not gain a duplicate.
  for (const p of [...sedPerlTargets(cmdOnly), ...pythonWriteTargets(withPython)]) {
    if (covered.has(p)) continue
    covered.add(p)
    out.push({ path: p })
  }
  // A file this same command REMOVES after writing it was scratch, not an edit
  // (`cat > t.test.ts <<EOF …; vitest t.test.ts; rm -f t.test.ts`). Order
  // matters: an rm BEFORE the write (`rm -f f; cat > f <<EOF`) is a rewrite
  // and keeps its credit. Offsets in cmdOnly and withPython are comparable —
  // masking replaces characters with spaces, never moves them.
  const rms = rmSpans(cmdOnly)
  return out.filter((e) => {
    const rmEnd = rms.get(e.path)
    if (rmEnd === undefined) return true
    return withPython.lastIndexOf(e.path) > rmEnd
  })
}

/** Files removed by a plain `rm` in the command → the END offset of the last
 *  such rm span, for the order check above. Conservative: `-r` removals
 *  (directories — matching a file INSIDE one needs path logic the miss doesn't
 *  earn) and glob operands (a glob is not a path) are ignored. Heredoc bodies
 *  are already masked out of `cmdOnly`, so an rm in written example text never
 *  counts. */
function rmSpans(cmdOnly: string): Map<string, number> {
  const spans = new Map<string, number>()
  const re = /(?:^|[;&|\n])\s*rm\s+([^\n;|&]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmdOnly))) {
    const end = m.index + m[0].length
    const args = m[1]!.trim().split(/\s+/)
    if (args.some((a) => /^-[a-zA-Z]*r/i.test(a))) continue
    for (const a of args) {
      if (a.startsWith('-') || /[*?[]/.test(a)) continue
      const prev = spans.get(a)
      if (prev === undefined || end > prev) spans.set(a, end)
    }
  }
  return spans
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
      for (let i = 0; i < seg.tokens.length; i++) {
        const t = seg.tokens[i]!
        if ((t === '>' || t === '>>') && seg.tokens[i + 1]) path = seg.tokens[i + 1]
        else if (t.startsWith('>') && t.length > 1 && !t.startsWith('>&')) path = t.replace(/^>{1,2}/, '')
      }
      if (!path && seg.binary === 'tee') {
        path = seg.tokens.slice(1).find((t) => !t.startsWith('-'))
      }
      if (path) {
        // Only cat/tee pass their input through verbatim — for them the body
        // IS the file. Any other binary with a redirect certainly WROTE the
        // file, but its output is not the heredoc body: path-only.
        const verbatim = seg.binary === 'cat' || seg.binary === 'tee' || seg.binary === null
        out.push(verbatim ? { path, content: h.body } : { path })
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
    const args = seg.tokens.slice(seg.tokens.indexOf(seg.binary) + 1)
    if (!args.some((t) => /^-[a-zA-Z]*i/.test(t))) continue
    let scriptConsumed = seg.binary === 'perl' || args.some((t) => /^-\w*e$/.test(t) || /^-\w*e./.test(t))
    for (const t of args) {
      if (t.startsWith('-')) continue
      if (!scriptConsumed) {
        scriptConsumed = true // sed's inline script, not a file
        continue
      }
      if (looksLikeFile(t)) out.push(t)
    }
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
