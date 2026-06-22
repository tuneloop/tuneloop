// Facet registry loading + the distribution cards, plus the per-metric helpers
// that decide which facets may split a given chart (grain guards live here so
// the metric modules don't each re-derive them).
import { state, $, esc, get, grainOfSrc } from './core'
import { bars } from './charts'

// Fetch the facet registry + a distribution for every chart/filter facet, so
// dist cards and filters are driven by the registry, not a hardcoded list.
export function loadFacets() {
  return get('/api/facets').then(function (facets) {
    state.facets = facets || [];
    var need = {};
    state.facets.forEach(function (f) {
      var roles = f.roles || [];
      if (roles.indexOf('chart') >= 0 || roles.indexOf('filter') >= 0) need[f.key] = 1;
    });
    state.dist = {};
    return Promise.all(Object.keys(need).map(function (k) {
      return get('/api/distribution?facet=' + encodeURIComponent(k)).then(function (d) { state.dist[k] = d || []; });
    }));
  });
}

export function renderDists(o) {
  var cards = [];
  state.facets.forEach(function (f) {
    if ((f.roles || []).indexOf('chart') < 0) return;
    var d = state.dist[f.key] || [];
    if (!d.length) return; // skip empty facets (e.g. repo before it resolves)
    cards.push('<div class="card"><h3>' + esc(f.label || f.key) + '</h3>' + bars(d.slice(0, 15), 'value') + '</div>');
  });
  // Non-facet cards (events / tool calls) still come from the overview.
  if (o.outcomes && o.outcomes.length) cards.push('<div class="card"><h3>Outcomes</h3>' + bars(o.outcomes, 'type') + '</div>');
  var tools = (o.topTools || []).map(function (t) { return { value: t.name, count: t.calls }; });
  if (tools.length) cards.push('<div class="card"><h3>Top tools</h3>' + bars(tools, 'value') + '</div>');
  var box = $('#sm-dists'); // distribution cards live under the Sessions tile
  if (box) box.innerHTML = cards.join('');
}

// Facets that can split a session-grain rate/count into series — any
// session-scoped chart/filter dimension (we compile each value to a session
// predicate, so counts explode safely). Shared by success-rate + sessions.
export function srBreakdownFacets() {
  return state.facets.filter(function (f) {
    var r = f.roles || [];
    return r.indexOf('chart') >= 0 || r.indexOf('filter') >= 0;
  });
}

// Cost is usage-grain, so only usage/session-grain facets split it honestly
// (model, repo, use_case, complexity…); tool-call facets (skill) are excluded.
export function spendBreakdownFacets() {
  return state.facets.filter(function (f) {
    var r = f.roles || [];
    if (r.indexOf('chart') < 0 && r.indexOf('filter') < 0) return false;
    return grainOfSrc(f.source) !== 'tool_call';
  });
}
