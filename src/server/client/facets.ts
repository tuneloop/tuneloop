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

// --- Per-metric filter slicers (success-rate / total-spend / sessions) ---------
// A filter is a session-level predicate (compiled server-side by facetPredicate),
// so the filterable set is BROADER than a measure's *breakdown* set: it includes
// tool-call facets like `skill` even for cost (you can filter spend to "sessions
// that used skill X" though you can't honestly *split* usage-grain cost by skill).
// We offer every filter-role facet with a non-empty distribution; chart-only
// facets (free-text `topics`) are excluded — bad as a dropdown.
export function metricFilterFacets() {
  return state.facets.filter(function (f) {
    return (f.roles || []).indexOf('filter') >= 0 && (state.dist[f.key] || []).length > 0;
  });
}

// Inline filter group for the control row (sits between Bucket and Break-down,
// mirroring "apply filters, then group by"). Each active clause renders as a
// fixed field LABEL + the selected values as removable chips (OR within a field)
// + a small "+" to add another value of that field. A trailing "+ filter"
// <select> lists only fields not yet used (so each field is one clause → the
// `current` {field: values[]} map stays 1:1) and, once a field is picked, reveals
// a value <select> that commits the first value of a new clause.
// `current` is the section's own {facetKey: value[]} map (per-section, not shared).
export function filterRowHtml(idp, current) {
  var label = {};
  state.facets.forEach(function (f) { label[f.key] = f.label || f.key; });
  var clauses = Object.keys(current).filter(function (k) { return (current[k] || []).length; }).map(function (k) {
    var sel = current[k];
    var chips = sel.map(function (v) {
      return '<span class="mfl-v">' + esc(v) +
        '<button class="mfl-vx" type="button" data-key="' + esc(k) + '" data-val="' + esc(v) + '" title="Remove value">×</button></span>';
    }).join('');
    // "+ value" select: values of this field not already selected.
    var rest = (state.dist[k] || []).filter(function (r) { return r.value != null && sel.indexOf(String(r.value)) < 0; });
    var addv = '';
    if (rest.length) {
      var o = '<option value="">+</option>';
      rest.forEach(function (r) { o += '<option value="' + esc(r.value) + '">' + esc(r.value) + '</option>'; });
      addv = '<select class="sr-by mfl-addv" data-key="' + esc(k) + '" title="Add value">' + o + '</select>';
    }
    return '<span class="mfl-clause"><span class="mfl-k">' + esc(label[k] || k) + '</span>' + chips + addv + '</span>';
  }).join('');
  var avail = metricFilterFacets().filter(function (f) { return !(current[f.key] || []).length; });
  var addOpts = '<option value="">+ filter</option>';
  avail.forEach(function (f) { addOpts += '<option value="' + esc(f.key) + '">' + esc(f.label || f.key) + '</option>'; });
  var add = '<select class="sr-by mfl-field" id="' + idp + '-fl-field"' + (avail.length ? '' : ' disabled') + '>' + addOpts + '</select>' +
    '<select class="sr-by mfl-addval" id="' + idp + '-fl-val" hidden></select>';
  return '<span class="sr-lbl" style="margin-left:18px">Filter</span>' + clauses + add;
}

// Wire one section's filter group: per-value removes (✕) + per-field "+ value"
// adds + the "+ filter" add widget (field → first value → commit). `rerender`
// rebuilds the section's controls (refreshing chips + the unused field/value
// lists); `onChange` reloads the chart. Removing a field's last value drops the
// clause. Scoped to `box` so it can't collide with the Sessions-list handlers.
export function wireFacetFilters(idp, box, current, rerender, onChange) {
  if (box) {
    Array.prototype.forEach.call(box.querySelectorAll('.mfl-vx'), function (b) {
      b.onclick = function () {
        var k = this.getAttribute('data-key'), v = this.getAttribute('data-val');
        current[k] = (current[k] || []).filter(function (x) { return x !== v; });
        if (!current[k].length) delete current[k];
        rerender(); onChange();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.mfl-addv'), function (s) {
      s.onchange = function () {
        if (!this.value) return;
        var k = this.getAttribute('data-key');
        (current[k] = current[k] || []).push(this.value);
        rerender(); onChange();
      };
    });
  }
  var field = document.getElementById(idp + '-fl-field') as any;
  var val = document.getElementById(idp + '-fl-val') as any;
  if (field && val) {
    field.onchange = function () {
      if (!this.value) { val.hidden = true; return; }
      var o = '<option value="">value…</option>';
      (state.dist[this.value] || []).forEach(function (r) {
        if (r.value == null) return;
        o += '<option value="' + esc(r.value) + '">' + esc(r.value) + '</option>';
      });
      val.innerHTML = o; val.hidden = false; val.focus();
    };
    val.onchange = function () {
      if (!field.value || !this.value) return;
      current[field.value] = [this.value];
      rerender(); onChange();
    };
  }
}

// Serialize a section's filter map to query-string params (each leading '&'):
// one repeated param per selected value (?model=a&model=b), matching the
// array-collecting convention the three over-time endpoints use.
export function facetFilterQs(current) {
  var qs = '';
  Object.keys(current || {}).forEach(function (k) {
    (current[k] || []).forEach(function (v) {
      qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
    });
  });
  return qs;
}
