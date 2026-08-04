// The pure row-selection rules for the Tools rosters: which rows a view shows,
// and which shell binaries fold into the "other shell" rollup. DOM-free and
// state-free (the caller passes the kind + controls), so the rules that decide
// what a user can and can't see are unit-testable rather than only observable by
// scrolling the page.

/**
 * Only the fields these rules read. Declared structurally rather than importing
 * the server's ToolHealthRow: the client compiles as a DOM project, and pulling a
 * Node-side module into it drags Node's lib in with it (which quietly re-types
 * things like setTimeout across the whole client).
 */
export interface RosterRow {
  name: string
  status?: string
  shell?: boolean
  flags?: string[]
}

/**
 * How many shell binaries the built-in roster shows by volume before rolling the
 * rest away. Real sessions run a long tail of one-off binaries (`sips`, `xxd`,
 * `mdls`); listing every one buries the tools that matter.
 */
export var SHELL_TOP_N = 15

/**
 * Apply the status filter + name search. The empty status is each roster's
 * DEFAULT view: MCP hides installed-but-unused servers (hygiene, not today's
 * problem), while built-ins have no unused state to hide, so they show everything.
 */
export function filterRows<T extends RosterRow>(rows: T[], kind: string, status: string, search: string): T[] {
  var out = rows
  if (status === '' && kind === 'mcp') out = out.filter((r) => r.status === 'used')
  else if (status === 'unused') out = out.filter((r) => r.status === 'unused')
  else if (status && status !== 'all') out = out.filter((r) => (r.flags || []).indexOf(status) >= 0)
  if (search) {
    var q = search.toLowerCase()
    out = out.filter((r) => r.name.toLowerCase().indexOf(q) >= 0)
  }
  return out
}

/**
 * Which shell rows fold into the rollup: everything past the top N by volume —
 * EXCEPT any row wearing an error pill, which is never hidden at any rank.
 *
 * Volume alone ranks plumbing above signal. On a real corpus the top of the list
 * is `echo`/`grep`/`head`/`sed`, while the binaries actually worth acting on sit
 * far below: `curl` at rank 22 (degrading) and `mkdir` at rank 29 (high-error)
 * both landed inside the tail. Rolling those up would hide exactly what this tab
 * exists to show, so rank cannot be the only rule.
 *
 * `rows` must be in the report's order (calls descending).
 */
export function rollupTail<T extends RosterRow>(rows: T[]): T[] {
  var shell = rows.filter((r) => r.shell)
  if (shell.length <= SHELL_TOP_N) return []
  return shell.slice(SHELL_TOP_N).filter((r) => !(r.flags || []).length)
}
