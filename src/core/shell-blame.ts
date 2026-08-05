import type { SegmentSep, ShellSegment } from './shell-binaries'

/**
 * Which binary in a compound shell command actually failed?
 *
 * A chained command is attributed to every binary it involved, because the parser
 * can't know which segment broke. For `&&` chains that isn't merely imprecise, it
 * is wrong: `ls missing && tsc` fails at `ls`, so `tsc` NEVER RAN — yet it would
 * carry the error, and on a corpus that gave binaries like `psql` a failure rate
 * built entirely out of commands they never executed.
 *
 * Unix tools almost always prefix their own name onto the failure ("ls: …: No
 * such file or directory"), so the output usually names the culprit. This reads
 * that prefix — and ONLY that. It is deliberately high-precision and low-recall:
 * a wrong blame silently moves a failure onto an innocent tool, whereas no blame
 * just falls back to the honest multi-label. When it returns null, nothing about
 * the existing behaviour changes.
 *
 * Pure and deterministic: it runs at ingest for every failed shell call, and the
 * result must be stable across re-ingest (it drives an error rate).
 */

/** Blame lines live at the top of the output; a name far below is prose, not a prefix. */
const MAX_SCAN_LINES = 60

/** `sh: line 3: pytest: command not found` — the wrapper reports, the inner name failed. */
const SHELL_WRAPPER = /^(?:[\w./-]*\b(?:ba|z|k|da)?sh):\s+(?:line\s+\d+:\s+)?(\S+):\s/

/** `ls: …` / `psql: error: …` — a tool prefixing its own name onto the failure. */
const SELF_PREFIX = /^([\w.@+/-]+):\s/

/** `Usage:  gh gist delete …` — a CLI printing its own usage after a bad invocation. */
const USAGE_LINE = /^Usage:\s+(\S+)/i

/**
 * zsh puts the name AFTER the message — `(eval):1: command not found: jq` — where
 * bash puts it before. Both shells appear in these transcripts, so both forms have
 * to be read or the more common one silently never matches.
 */
const ZSH_NOT_FOUND = /(?:command not found|no such file or directory):\s*(\S+)/i

/** `(eval):cd:1: …` — zsh naming the builtin/command that raised the error. */
const ZSH_EVAL_CMD = /^\(eval\):([\w.-]+):\d+:/

/**
 * The shell failing to RESOLVE a word: `(eval):1: == not found`, which is zsh's
 * equals expansion (`===` parses as `=` plus a lookup for a command named `==`).
 * The word is not a binary and never will be, so it can't be matched against the
 * call's binaries — but it appears verbatim in the command, which is how
 * `blameByToken` finds the segment that held it.
 *
 * Only this class. A glob no-match (`no matches found: docs/*.swp`) looks similar
 * and is NOT the same failure: measured under zsh, an unresolvable word ABORTS the
 * whole list and sets the exit code regardless of separator, while a glob no-match
 * merely skips its own command — in a `;` list the run continues and exits 0, so
 * the call's error came from somewhere else entirely and blaming the glob's
 * segment would be wrong. It only propagates inside an `&&` chain, which needs
 * separator awareness to tell apart (see the `;`-list rule in the design doc).
 */
const ABORT_TOKEN = [/^(?:\(eval\)|z?sh):(?:\d+:)?\s*(\S+) not found/i]

/**
 * A word the shell couldn't resolve that only SKIPS its own command rather than
 * abandoning the list: a glob matching nothing. Measured under zsh,
 * `grep --include=*.x; echo B` prints B and exits 0 — so this segment's failure
 * reaches the exit code only when nothing ran after it, or when the next join is
 * an `&&` that stops the chain. Hence `failurePropagates`.
 */
const SKIP_TOKEN = [/^(?:\(eval\)|z?sh):(?:\d+:)?\s*no matches found:\s*(\S+)/i]

/**
 * Joins that ALWAYS proceed to the next command. The shell's exit status is the
 * last command that ran, so if a chain is built only from these, its final segment
 * is guaranteed to have run and its status IS the call's — verified identical in
 * bash and zsh (`true; false` → 1, `false; true` → 0, `true | false` → 1,
 * `false | true` → 0).
 *
 * One `&&` or `||` ANYWHERE breaks the guarantee, not just immediately before the
 * last segment: in `A && B | C` the pipe says C follows B, but if A failed the
 * whole pipeline was skipped. Checking only the final join blamed `sed` for
 * commands whose earlier link never succeeded.
 */
const UNCONDITIONAL_JOINS = new Set<SegmentSep>([';', '\n', '|', '(', ')'])

/**
 * The call didn't fail on its own terms, so its exit code says nothing about which
 * segment is at fault: the user declined it (nothing ran), or the harness killed
 * it partway (the status is the kill, not a command's verdict). A decline in
 * particular KEEPS its multi-label by decision — it is signal about the call the
 * user didn't want, not noise to reassign.
 */
const NOT_THE_COMMANDS_VERDICT = /user rejected|doesn'?t want to proceed|tool use was rejected|rejected by user|command timed out|timed out after|\binterrupted\b/i

/** `./node_modules/.bin/tsc` and `tsc` are the same tool; compare on the last path segment. */
function base(name: string): string {
  const trimmed = name.replace(/[:,.]+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * The binary the error text blames, or null when the output doesn't say so
 * unambiguously — no match, a name that isn't one of this call's binaries, or two
 * different binaries each claiming a failure.
 *
 * `binaries` is the call's parsed list (core/shell-binaries.ts); the return value
 * is the matching entry from it, verbatim, so it joins straight back to the row.
 */
export function blameBinary(text: string, segments: ShellSegment[]): string | null {
  if (!text || !segments.length) return null
  const byBase = new Map<string, string>()
  for (const seg of segments) {
    if (seg.binary && !byBase.has(base(seg.binary))) byBase.set(base(seg.binary), seg.binary)
  }

  // Tool self-prefixes are only trusted near the top (a name deep in a payload is
  // prose, not a failure line). The SHELL's own markers are trusted anywhere: they
  // are distinctive, and they arrive on stderr interleaved wherever the shell got
  // to — a command that dumps 60 lines of a file before aborting was pushing its
  // abort line past this cap, letting the exit-position rule fire on a list that
  // never reached its end.
  // Navigation builtins are blameable but never rostered: `cd docs && cat f` that
  // dies on a missing `docs` should be charged to `cd`, not left to smear across
  // `cat`. Since no tool_call_commands row is ever named `cd`, a blame of `cd`
  // matches no binary and the error simply counts against none of them — which is
  // right, because none of them ran.
  for (const seg of segments) {
    if (seg.builtin && !byBase.has(base(seg.builtin))) byBase.set(base(seg.builtin), seg.builtin)
  }

  const found = new Set<string>()
  const allLines = text.split('\n')
  const lines = allLines.slice(0, MAX_SCAN_LINES)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // The wrapper form first: in `sh: line 1: tsc: not found` the SELF_PREFIX rule
    // would otherwise blame the shell, which isn't the tool that failed.
    const named =
      SHELL_WRAPPER.exec(line)?.[1] ??
      ZSH_EVAL_CMD.exec(line)?.[1] ??
      ZSH_NOT_FOUND.exec(line)?.[1] ??
      USAGE_LINE.exec(line)?.[1] ??
      SELF_PREFIX.exec(line)?.[1]
    if (!named) continue
    const hit = byBase.get(base(named))
    if (hit) found.add(hit)
    // Two tools each reporting a failure: we can't rank them, so say nothing.
    if (found.size > 1) return null
  }
  if (found.size === 1) return [...found][0]!

  const byToken = blameByToken(allLines, segments)
  if (byToken) return byToken
  // An abort means the list never reached its end, so the exit-position rule's
  // premise — that the last segment ran — is false.
  const aborted = allLines.some((l) => ABORT_TOKEN.some((re) => re.test(l.trim())))
  if (aborted || NOT_THE_COMMANDS_VERDICT.test(text)) return null
  return blameByExitPosition(segments)
}

/** Could this segment's failure have reached the exit code? */
function failurePropagates(i: number, segments: ShellSegment[]): boolean {
  const next = segments[i + 1]
  // Nothing ran after it, so its status is the command's. Or the next join is an
  // `&&`, which stops on failure. (`||` does NOT: it runs its alternative, and
  // that alternative's status is what survives.)
  return !next || next.sep === '&&'
}

/**
 * When the chain's last segment is guaranteed to have run, the call's exit code is
 * that segment's — so it is the one that failed.
 *
 * This needs no error text at all, which is the point: agent commands routinely
 * end in an existence probe with stderr discarded (`ls a b 2>/dev/null`), leaving
 * nothing to parse while still setting a non-zero status. Reading the exit code's
 * provenance from the chain's shape gets there anyway.
 *
 * Deliberately silent after `&&`/`||`: the status could belong to any segment the
 * chain stopped at, and guessing the last one would be wrong precisely when a
 * chain fails early — the case that motivated blame in the first place.
 */
function blameByExitPosition(segments: ShellSegment[]): string | null {
  const last = segments[segments.length - 1]
  if (!last?.binary || !last.sep) return null
  // Every join must be unconditional, or some earlier link may have skipped the rest.
  if (!segments.every((seg) => !seg.sep || UNCONDITIONAL_JOINS.has(seg.sep))) return null
  return last.binary
}

/**
 * The shell rejected a WORD, so blame whichever segment contained that word.
 *
 * `echo ===` dies under zsh because `===` parses as `=` plus a lookup for a
 * command named `==`; the shell reports `== not found` and ABANDONS THE REST OF
 * THE LIST — which is what makes this blame sound: the aborting segment is
 * necessarily the one that set the exit code. Nothing in that message names a
 * binary, so the name-matching rules above abstain and the failure spreads across
 * every binary in the chain — including the ones that never ran.
 *
 * But this IS a real failure, and an agent one: the command wasn't portable across
 * shells. The offending word appears verbatim in the command, so the segment
 * holding it is the segment at fault. The FIRST such segment wins, because the
 * shell stops at the first thing it can't resolve.
 */
function blameByToken(lines: string[], segments: ShellSegment[]): string | null {
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const abort = firstMatch(ABORT_TOKEN, line)
    const skip = abort ? undefined : firstMatch(SKIP_TOKEN, line)
    const token = abort ?? skip
    // A one-character word is too weak to locate: it would match almost any
    // segment, and a confident wrong blame is worse than none.
    if (!token || token.length < 2) continue
    const i = segments.findIndex((seg) => seg.binary && seg.tokens.some((t) => t.includes(token)))
    if (i < 0) continue
    // An abort takes the whole list down, so its segment is necessarily the one
    // that set the status. A mere skip has to be shown to reach the exit code.
    if (abort || failurePropagates(i, segments)) return segments[i]!.binary
  }
  return null
}

function firstMatch(patterns: RegExp[], line: string): string | undefined {
  for (const re of patterns) {
    const m = re.exec(line)?.[1]
    if (m) return m
  }
  return undefined
}
