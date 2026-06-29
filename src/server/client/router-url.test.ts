import { describe, it, expect } from 'vitest'
import { parseHash, serializeRoute, parseQuery, serializeQuery } from './router-url'
import type { NavState } from './router-url'

describe('parseHash', () => {
  it('defaults an empty hash to the dashboard success-rate view', () => {
    expect(parseHash('')).toMatchObject({ view: 'dashboard', metric: 'success_rate', artKind: 'feature', session: null })
    expect(parseHash('#/')).toMatchObject({ view: 'dashboard', metric: 'success_rate' })
  })

  it('parses each view + sub-selection', () => {
    expect(parseHash('#/highlights')).toMatchObject({ view: 'highlights' })
    expect(parseHash('#/dashboard/cost_artifact')).toMatchObject({ view: 'dashboard', metric: 'cost_artifact' })
    expect(parseHash('#/artifacts/pr')).toMatchObject({ view: 'artifacts', artKind: 'pr' })
    expect(parseHash('#/sessions')).toMatchObject({ view: 'sessions' })
  })

  it('parses an open session drawer on any view', () => {
    expect(parseHash('#/sessions?session=opencode:abc')).toMatchObject({ view: 'sessions', session: 'opencode:abc' })
    expect(parseHash('#/dashboard/ops?session=x1')).toMatchObject({ view: 'dashboard', metric: 'ops', session: 'x1' })
  })

  it('exposes the full decoded query map (filtered-list state)', () => {
    const r = parseHash('#/sessions?win=all&q=retry&outcomes=pr_merged,pr_reviewed&f.use_case=review&f.repo=aivue')
    expect(r.query).toEqual({
      win: 'all',
      q: 'retry',
      outcomes: 'pr_merged,pr_reviewed',
      'f.use_case': 'review',
      'f.repo': 'aivue',
    })
  })

  it('decodes encoded values (slashes, spaces, colons)', () => {
    expect(parseHash('#/sessions?session=' + encodeURIComponent('cc:a/b c')).session).toBe('cc:a/b c')
    expect(parseHash('#/sessions?artifact=' + encodeURIComponent('pr:o/r:22')).query.artifact).toBe('pr:o/r:22')
  })

  it('falls back to defaults for unknown view / metric / kind', () => {
    expect(parseHash('#/bogus')).toMatchObject({ view: 'dashboard', metric: 'success_rate' })
    expect(parseHash('#/dashboard/not_a_metric')).toMatchObject({ metric: 'success_rate' })
    expect(parseHash('#/artifacts/nope')).toMatchObject({ artKind: 'feature' })
  })

  it('ignores a metric segment on a non-dashboard view', () => {
    expect(parseHash('#/sessions/cost_artifact')).toMatchObject({ view: 'sessions', metric: 'success_rate' })
  })

  it('tolerates a malformed query', () => {
    expect(parseHash('#/sessions?session')).toMatchObject({ session: null })
    expect(parseHash('#/sessions?q=%')).toMatchObject({ query: {} }) // bad escape dropped
  })
})

describe('serializeRoute', () => {
  const nav = (o: Partial<NavState>): NavState => ({ view: 'dashboard', metric: 'success_rate', artKind: 'feature', ...o })

  it('serializes each view path', () => {
    expect(serializeRoute(nav({ view: 'highlights' }), {})).toBe('#/highlights')
    expect(serializeRoute(nav({ view: 'dashboard', metric: 'total_spend' }), {})).toBe('#/dashboard/total_spend')
    expect(serializeRoute(nav({ view: 'artifacts', artKind: 'pr' }), {})).toBe('#/artifacts/pr')
    expect(serializeRoute(nav({ view: 'sessions' }), {})).toBe('#/sessions')
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
    { nav: { view: 'highlights', metric: 'success_rate', artKind: 'feature' }, query: {} },
    { nav: { view: 'dashboard', metric: 'cost_artifact', artKind: 'feature' }, query: { session: 'opencode:xyz' } },
    { nav: { view: 'artifacts', metric: 'success_rate', artKind: 'pr' }, query: { q: 'fix', sort: 'cost', dir: 'asc' } },
    { nav: { view: 'sessions', metric: 'success_rate', artKind: 'feature' }, query: { win: 'all', 'f.repo': 'a/b', q: 'x' } },
  ]
  it('parseHash(serializeRoute(x)) preserves path + query', () => {
    for (const c of cases) {
      const r = parseHash(serializeRoute(c.nav, c.query))
      expect(r.view).toBe(c.nav.view)
      if (c.nav.view === 'dashboard') expect(r.metric).toBe(c.nav.metric)
      if (c.nav.view === 'artifacts') expect(r.artKind).toBe(c.nav.artKind)
      expect(r.query).toEqual(c.query)
    }
  })
})
