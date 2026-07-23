// Pure URL <-> Route serialization for the hash router. No DOM / state imports,
// so it's unit-testable under Node and reusable by router.ts. The grammar:
//
//   #/highlights                    the landing digest (empty hash also lands here)
//   #/insights                      the detector insight ledger
//   #/skills[/<name>]               the skill roster, or one skill's detail page
//   #/dashboard/<metric>            e.g. #/dashboard/cost_artifact
//   #/artifacts/<kind>[?q=&sort=&dir=]
//   #/sessions[?win=&q=&outcomes=&artifact=&artifactKind=&f.<facet>=…]
//   ...any of the above + ?session=<id>   (the open detail drawer, orthogonal)
//
// The path picks the screen; the query string carries that screen's filtered-list
// state, so a filtered list (and a future graph drill-down into one) is a plain
// URL. Facet filters are namespaced `f.<key>` so a dynamic facet name can't
// collide with a reserved param. Unknown views/metrics/kinds fall back to
// defaults rather than erroring, so a stale or hand-mangled hash always resolves.

export interface Route {
  view: 'highlights' | 'insights' | 'skills' | 'dashboard' | 'artifacts' | 'sessions'
  metric: string // dashboard sub-selection (which KPI is expanded)
  artKind: string // artifacts sub-selection (feature | pr)
  skill: string | null // skills sub-selection: the open per-skill page, or null (roster)
  session: string | null // open drawer target, or null (mirror of query.session)
  query: Record<string, string> // full decoded query string (filtered-list state)
}

/** The path-level slice of client state that maps to the URL path. */
export interface NavState {
  view: 'highlights' | 'insights' | 'skills' | 'dashboard' | 'artifacts' | 'sessions'
  metric: string | null
  artKind: string
  skill: string | null
}

// 'highlights' is routable (so the landing tab is shareable / reload-survivable),
// but it is NOT the parse fallback — an empty or unknown hash still resolves to
// 'dashboard' (see parseHash). main.ts decides to LAND on highlights when the hash
// is empty; an explicit deep link to any other view wins.
export const VIEWS = ['highlights', 'insights', 'skills', 'dashboard', 'artifacts', 'sessions']
export const METRICS = ['success_rate', 'cost_artifact', 'total_spend', 'sessions', 'ops']
export const ART_KINDS = ['feature', 'pr']
export const DEFAULT_METRIC = 'success_rate'
export const DEFAULT_ARTKIND = 'feature'

/** Decode a `a=1&b=2` query string into a map (tolerant of junk / bad encoding). */
export function parseQuery(str: string): Record<string, string> {
  const out: Record<string, string> = {}
  ;(str || '').split('&').forEach((kv) => {
    if (!kv) return
    const eq = kv.indexOf('=')
    const k = eq < 0 ? kv : kv.slice(0, eq)
    const v = eq < 0 ? '' : kv.slice(eq + 1)
    if (!k) return
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v)
    } catch {
      /* drop a malformed pair rather than throw */
    }
  })
  return out
}

/** Encode a map into a stable (key-sorted) query string; empty values dropped. */
export function serializeQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .filter((k) => query[k] != null && query[k] !== '')
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
    .join('&')
}

/** Parse a location.hash string into a fully-defaulted Route (never throws). */
export function parseHash(hash: string): Route {
  // '#/dashboard/cost_artifact?session=abc' → path 'dashboard/cost_artifact', query 'session=abc'
  const raw = (hash || '').replace(/^#\/?/, '')
  const qIdx = raw.indexOf('?')
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const query = parseQuery(qIdx >= 0 ? raw.slice(qIdx + 1) : '')
  const parts = path.split('/').filter(Boolean)

  const view = (VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : 'dashboard') as Route['view']
  const metric = view === 'dashboard' && METRICS.indexOf(parts[1]) >= 0 ? parts[1] : DEFAULT_METRIC
  const artKind = view === 'artifacts' && ART_KINDS.indexOf(parts[1]) >= 0 ? parts[1] : DEFAULT_ARTKIND
  // A skill name is a free-form path segment (may be plugin-namespaced with ':'),
  // decoded from its encoded form; absent → the roster.
  let skill: string | null = null
  if (view === 'skills' && parts[1]) {
    try {
      skill = decodeURIComponent(parts[1])
    } catch {
      skill = parts[1] // keep the raw segment if it's not valid encoding
    }
  }

  return { view, metric, artKind, skill, session: query.session || null, query }
}

/** Serialize a path slice + a query map into a canonical hash string. */
export function serializeRoute(nav: NavState, query: Record<string, string>): string {
  const base =
    nav.view === 'highlights'
      ? '#/highlights'
      : nav.view === 'insights'
        ? '#/insights'
        : nav.view === 'skills'
          ? '#/skills' + (nav.skill ? '/' + encodeURIComponent(nav.skill) : '')
          : nav.view === 'artifacts'
          ? '#/artifacts/' + (nav.artKind || DEFAULT_ARTKIND)
          : nav.view === 'sessions'
            ? '#/sessions'
            : '#/dashboard/' + (nav.metric || DEFAULT_METRIC)
  const qs = serializeQuery(query)
  return qs ? base + '?' + qs : base
}
