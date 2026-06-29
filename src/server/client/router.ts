// Hash-based router. The URL hash mirrors the navigational slice of `state`: the
// path is which screen (tab + dashboard metric / artifacts kind), and the query
// string is that screen's filtered-list state (so a filtered list — and a future
// graph drill-down into one — is a shareable, reload-survivable URL). Two
// directions:
//
//   state → URL   syncHash(): a nav/filter handler mutates state, then asks the
//                 router to write the hash. Uses history.pushState/replaceState,
//                 which do NOT fire popstate/hashchange — so writing never loops.
//   URL → state   applyFromUrl(): on Back/Forward (popstate), a manual hash edit
//                 (hashchange), or first load, parse the hash and drive the same
//                 nav/filter functions a click would.
//
// Hash routing (not History API) is deliberate: the dev server only serves
// index.html for `/`, so clean paths like /sessions/abc would 404 on reload.
// Everything after `#` is never sent to the server, so deep links just work.
// The pure parse/serialize lives in router-url.ts (DOM-free, unit-tested).
import { state } from './core'
import { parseHash, serializeRoute } from './router-url'
import type { Route } from './router-url'
import { setView, openDetail, closeDrawer, getSessionParams, applySessionParams } from './sessions'
import { openMetric } from './kpis'
import { getArtifactParams, applyArtifactParams } from './artifacts'

export type { Route } from './router-url'

// True while applyRoute()/withoutSync() drive the nav functions, so their
// syncHash() calls no-op — otherwise replaying a Back navigation (or the initial
// paint) would push a fresh history entry.
var applying = false

/** The query map for the current screen: the active list's filter state, plus
 * the open drawer (orthogonal to the list). */
function currentQuery(): Record<string, string> {
  var q: Record<string, string> = {}
  if (state.view === 'sessions') q = getSessionParams()
  else if (state.view === 'artifacts') q = getArtifactParams()
  if (state.open) q.session = state.open
  return q
}

/** Serialize the current state into its canonical hash string. */
export function buildHash(): string {
  return serializeRoute(state, currentQuery())
}

/**
 * Write the current state into the URL. No-ops while a route is being applied
 * (so Back/Forward never spawns new entries) and when the hash is unchanged.
 * Discrete navigations push (Back retraces them); `replace` is for in-place
 * tweaks that shouldn't add history (filter edits, closing a drawer, the initial
 * normalize).
 */
export function syncHash(opts?: { replace?: boolean }): void {
  if (applying) return
  var next = buildHash()
  if (next === window.location.hash) return
  if (opts && opts.replace) window.history.replaceState(null, '', next)
  else window.history.pushState(null, '', next)
}

/** Drive the nav functions to match a Route. Idempotent, so a double-fired
 * popstate+hashchange (Back/Forward fires both for hash entries) is harmless. */
function applyRoute(r: Route): void {
  applying = true
  try {
    setView(r.view)
    if (r.view === 'dashboard') openMetric(r.metric)
    else if (r.view === 'artifacts') applyArtifactParams(r.artKind, r.query)
    else if (r.view === 'sessions') applySessionParams(r.query)
    if (r.session && r.session !== state.open) openDetail(r.session)
    else if (!r.session && state.open) closeDrawer()
  } finally {
    applying = false
  }
}

function applyFromUrl(): void {
  applyRoute(parseHash(window.location.hash))
}

/**
 * Run `fn` with hash-writing suppressed — for the initial paint, where main.ts
 * drives the nav functions itself and a single replaceState(buildHash()) at the
 * end normalizes the URL, so no per-call pushState mints a stray history entry.
 */
export function withoutSync(fn: () => void): void {
  applying = true
  try {
    fn()
  } finally {
    applying = false
  }
}

/**
 * Boot the router: attach the Back/Forward + manual-hash-edit listeners and
 * return the initial Route parsed from the URL. main.ts owns the first render
 * (it controls the async load order), wrapping it in withoutSync() and finishing
 * with replaceState(buildHash()) to normalize the URL.
 */
export function initRouter(): Route {
  window.addEventListener('popstate', applyFromUrl)
  window.addEventListener('hashchange', applyFromUrl)
  return parseHash(window.location.hash)
}
