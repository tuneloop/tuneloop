import { describe, it, expect } from 'vitest'
import { DEFAULT_METRIC, parseHash, serializeRoute, parseQuery, serializeQuery } from './router-url'
import type { NavState } from './router-url'

describe('parseHash', () => {
  it('defaults an empty hash to the dashboard cost-per-artifact view', () => {
    expect(parseHash('')).toMatchObject({ view: 'dashboard', metric: 'cost_artifact', artKind: 'feature', session: null })
    expect(parseHash('#/')).toMatchObject({ view: 'dashboard', metric: 'cost_artifact' })
  })

  it('parses each view + sub-selection', () => {
    expect(parseHash('#/highlights')).toMatchObject({ view: 'highlights' })
    expect(parseHash('#/recommendations')).toMatchObject({ view: 'insights' })
    expect(parseHash('#/insights')).toMatchObject({ view: 'insights' }) // legacy slug still resolves
    expect(parseHash('#/dashboard/cost_artifact')).toMatchObject({ view: 'dashboard', metric: 'cost_artifact' })
    expect(parseHash('#/artifacts/pr')).toMatchObject({ view: 'artifacts', artKind: 'pr' })
    expect(parseHash('#/sessions')).toMatchObject({ view: 'sessions' })
  })

  it('parses the skills roster and a per-skill page', () => {
    expect(parseHash('#/skills')).toMatchObject({ view: 'skills', skill: null })
    expect(parseHash('#/skills/ship')).toMatchObject({ view: 'skills', skill: 'ship' })
    // A plugin-namespaced skill name is URL-encoded (':' → %3A).
    expect(parseHash('#/skills/' + encodeURIComponent('frontend-design:frontend-design'))).toMatchObject({
      view: 'skills',
      skill: 'frontend-design:frontend-design',
    })
    // A skill segment only applies on the skills view.
    expect(parseHash('#/sessions/ship')).toMatchObject({ view: 'sessions', skill: null })
  })

  it('parses the tools roster, its sub-tab, and an entity page', () => {
    expect(parseHash('#/tools')).toMatchObject({ view: 'tools', toolKind: 'mcp', tool: null })
    expect(parseHash('#/tools/builtin')).toMatchObject({ view: 'tools', toolKind: 'builtin', tool: null })
    expect(parseHash('#/tools/mcp/sentry')).toMatchObject({ view: 'tools', toolKind: 'mcp', tool: 'sentry' })
    // A shell binary can be a path; its slashes are encoded so it stays one segment.
    expect(parseHash('#/tools/builtin/' + encodeURIComponent('./deploy.sh'))).toMatchObject({
      view: 'tools',
      toolKind: 'builtin',
      tool: './deploy.sh',
    })
    // An unknown sub-tab falls back rather than erroring.
    expect(parseHash('#/tools/nonsense')).toMatchObject({ view: 'tools', toolKind: 'mcp' })
    // The segments only apply on the tools view.
    expect(parseHash('#/skills/ship')).toMatchObject({ view: 'skills', tool: null })
  })

  it('parses an open session drawer on any view', () => {
    expect(parseHash('#/sessions?session=opencode:abc')).toMatchObject({ view: 'sessions', session: 'opencode:abc' })
    expect(parseHash('#/dashboard/sessions?session=x1')).toMatchObject({ view: 'dashboard', metric: 'sessions', session: 'x1' })
  })

  /** A bookmark from before the Tool error rate KPI was removed still opens the tab. */
  it('falls back to the default metric for a retired one', () => {
    expect(parseHash('#/dashboard/ops')).toMatchObject({ view: 'dashboard', metric: DEFAULT_METRIC })
  })

  it('exposes the full decoded query map (filtered-list state)', () => {
    const r = parseHash('#/sessions?win=all&q=retry&outcomes=pr_merged,pr_reviewed&f.use_case=review&f.repo=tuneloop')
    expect(r.query).toEqual({
      win: 'all',
      q: 'retry',
      outcomes: 'pr_merged,pr_reviewed',
      'f.use_case': 'review',
      'f.repo': 'tuneloop',
    })
  })

  it('decodes encoded values (slashes, spaces, colons)', () => {
    expect(parseHash('#/sessions?session=' + encodeURIComponent('cc:a/b c')).session).toBe('cc:a/b c')
    expect(parseHash('#/sessions?artifact=' + encodeURIComponent('pr:o/r:22')).query.artifact).toBe('pr:o/r:22')
  })

  it('falls back to defaults for unknown view / metric / kind', () => {
    expect(parseHash('#/bogus')).toMatchObject({ view: 'dashboard', metric: 'cost_artifact' })
    expect(parseHash('#/dashboard/not_a_metric')).toMatchObject({ metric: 'cost_artifact' })
    expect(parseHash('#/artifacts/nope')).toMatchObject({ artKind: 'feature' })
  })

  it('ignores a metric segment on a non-dashboard view', () => {
    expect(parseHash('#/sessions/success_rate')).toMatchObject({ view: 'sessions', metric: 'cost_artifact' })
  })

  it('tolerates a malformed query', () => {
    expect(parseHash('#/sessions?session')).toMatchObject({ session: null })
    expect(parseHash('#/sessions?q=%')).toMatchObject({ query: {} }) // bad escape dropped
  })
})

describe('serializeRoute', () => {
  const nav = (o: Partial<NavState>): NavState => ({ view: 'dashboard', metric: 'success_rate', artKind: 'feature', skill: null, toolKind: 'mcp', tool: null, ...o })

  it('serializes each view path', () => {
    expect(serializeRoute(nav({ view: 'highlights' }), {})).toBe('#/highlights')
    expect(serializeRoute(nav({ view: 'insights' }), {})).toBe('#/recommendations')
    expect(serializeRoute(nav({ view: 'dashboard', metric: 'total_spend' }), {})).toBe('#/dashboard/total_spend')
    expect(serializeRoute(nav({ view: 'artifacts', artKind: 'pr' }), {})).toBe('#/artifacts/pr')
    expect(serializeRoute(nav({ view: 'sessions' }), {})).toBe('#/sessions')
    expect(serializeRoute(nav({ view: 'tools' }), {})).toBe('#/tools/mcp')
    expect(serializeRoute(nav({ view: 'tools', toolKind: 'builtin' }), {})).toBe('#/tools/builtin')
    expect(serializeRoute(nav({ view: 'tools', toolKind: 'mcp', tool: 'sentry' }), {})).toBe('#/tools/mcp/sentry')
  })

  it('round-trips a tools entity whose name is a path', () => {
    const hash = serializeRoute(nav({ view: 'tools', toolKind: 'builtin', tool: './deploy.sh' }), {})
    expect(parseHash(hash)).toMatchObject({ view: 'tools', toolKind: 'builtin', tool: './deploy.sh' })
  })

  it('serializes the skills roster and a per-skill page', () => {
    expect(serializeRoute(nav({ view: 'skills' }), {})).toBe('#/skills')
    expect(serializeRoute(nav({ view: 'skills', skill: 'ship' }), {})).toBe('#/skills/ship')
    expect(serializeRoute(nav({ view: 'skills', skill: 'frontend-design:frontend-design' }), {})).toBe(
      '#/skills/frontend-design%3Afrontend-design',
    )
  })

  it('appends a key-sorted query and encodes values', () => {
    expect(serializeRoute(nav({ view: 'sessions' }), { win: 'all', 'f.repo': 'a/b', q: 'x' })).toBe(
      '#/sessions?f.repo=a%2Fb&q=x&win=all',
    )
  })

  it('drops empty query values', () => {
    expect(serializeRoute(nav({ view: 'sessions' }), { q: '', win: 'all' })).toBe('#/sessions?win=all')
  })

  it('appends an open session', () => {
    expect(serializeRoute(nav({ view: 'sessions' }), { session: 'cc:a/b' })).toBe('#/sessions?session=cc%3Aa%2Fb')
  })
})

describe('parseQuery / serializeQuery round-trip', () => {
  it('round-trips a filter map', () => {
    const q = { win: 'all', q: 'retry flake', 'f.use_case': 'review', outcomes: 'a,b', session: 'cc:1/2' }
    expect(parseQuery(serializeQuery(q))).toEqual(q)
  })
})

describe('route round-trip', () => {
  const cases: Array<{ nav: NavState; query: Record<string, string> }> = [
    { nav: { view: 'highlights', metric: 'success_rate', artKind: 'feature', skill: null }, query: {} },
    { nav: { view: 'insights', metric: 'success_rate', artKind: 'feature', skill: null }, query: { session: 'cc:evidence-1' } },
    { nav: { view: 'dashboard', metric: 'cost_artifact', artKind: 'feature', skill: null }, query: { session: 'opencode:xyz' } },
    { nav: { view: 'artifacts', metric: 'success_rate', artKind: 'pr', skill: null }, query: { q: 'fix', sort: 'cost', dir: 'asc' } },
    { nav: { view: 'sessions', metric: 'success_rate', artKind: 'feature', skill: null }, query: { win: 'all', 'f.repo': 'a/b', q: 'x' } },
    { nav: { view: 'skills', metric: 'success_rate', artKind: 'feature', skill: null }, query: {} },
    { nav: { view: 'skills', metric: 'success_rate', artKind: 'feature', skill: 'frontend-design:frontend-design' }, query: {} },
  ]
  it('parseHash(serializeRoute(x)) preserves path + query', () => {
    for (const c of cases) {
      const r = parseHash(serializeRoute(c.nav, c.query))
      expect(r.view).toBe(c.nav.view)
      if (c.nav.view === 'dashboard') expect(r.metric).toBe(c.nav.metric)
      if (c.nav.view === 'artifacts') expect(r.artKind).toBe(c.nav.artKind)
      if (c.nav.view === 'skills') expect(r.skill).toBe(c.nav.skill)
      expect(r.query).toEqual(c.query)
    }
  })
})
