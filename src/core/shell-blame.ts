import type { ShellSegment } from './shell-binaries'

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
const SHELL_TOKEN = [/^(?:\(eval\)|z?sh):(?:\d+:)?\s*(\S+) not found/i]

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

  const found = new Set<string>()
  const lines = text.split('\n', MAX_SCAN_LINES)
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
  return blameByToken(lines, segments)
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
    let token: string | undefined
    for (const re of SHELL_TOKEN) {
      token = re.exec(line)?.[1]
      if (token) break
    }
    // A one-character word is too weak to locate: it would match almost any
    // segment, and a confident wrong blame is worse than none.
    if (!token || token.length < 2) continue
    for (const seg of segments) {
      if (seg.binary && seg.tokens.some((t) => t.includes(token!))) return seg.binary
    }
  }
  return null
}
