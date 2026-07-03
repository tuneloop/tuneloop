// Cost per shipped artifact detail (headline metric #2). A top-level Feature/PR
// toggle scopes the section, with a Complexity filter beside it; below them, three
// stacked panels:
//   1. Cost breakdown treemap — feature (hierarchical) or PR (flat) per the toggle.
//   2. AI spend converted vs unconverted — burn for the toggled kind.
//   3. Throughput — one graph: "Features shipped" or "PRs merged". For PRs it counts
//      every merged PR you contributed to (authored OR reviewed), matching the KPI.
// The window comes from the top-level selector (state.days); the curve bucket is
// derived from it (short windows get fine buckets) unless the user picks one.
import { state, $, esc, get, autoBucket, CX_LABELS, cxLabelList } from '../core'
import { loadKpis, paintKpis, setCaKpiOverride } from '../kpis'
import { stackChart } from '../charts'
import { renderFeatTreemap } from '../featTreemap'

var caReqId = 0;
function caNoun() { return state.ca.kind === 'pr' ? 'PRs' : 'features'; }
function caWinLabel() { return state.days === 'all' ? 'all time' : 'last ' + state.days + ' days'; }
function caBucket() { return autoBucket(state.ca.bucket); }

export function renderCostArtifact() {
  var pr = state.ca.kind === 'pr';
  var shipNoun = pr ? 'PR' : 'feature';
  var shipVerb = pr ? 'merged' : 'shipped';
  var win = esc(caWinLabel());
  var tmTitle = pr ? 'PR cost breakdown' : 'Feature cost breakdown';
  var tmSub = esc(caWinLabel()) + (pr ? ' &middot; total spend per merged PR' : ' &middot; total spend per feature &amp; sub-features');
  $('#metric-detail').innerHTML =
    '<div class="ca-controls" id="ca-controls"></div>' +
    // 1. Cost breakdown treemap (feature or PR, per the top-level toggle).
    '<div class="panel">' +
      '<div class="panel-head"><h2>' + tmTitle + ' <span class="metric-sub">' + tmSub + '</span></h2></div>' +
      '<div id="ca-feat"></div>' +
      '<div class="sr-legend" id="ca-feat-legend"></div>' +
    '</div>' +
    // 2. AI spend converted/unconverted (burn for the toggled kind). The Bucket
    //    control lives here (top-right) since it only affects this and the
    //    throughput chart below — not the all-time treemap above.
    '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>AI spend: converted vs unconverted <span class="metric-sub">' + win + ' &middot; dated at session start time</span></h2>' +
        '<span style="display:inline-flex;align-items:center;gap:8px"><span class="sr-lbl">Bucket</span><span class="seg" id="ca-bucket"></span></span>' +
      '</div>' +
      '<div id="ca-burn"></div>' +
      '<div class="sr-legend">' +
        '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>converted (linked to a ' + esc(shipVerb) + ' ' + esc(shipNoun) + ')</span>' +
        '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>unconverted &mdash; in-flight or never ' + esc(shipVerb) + '</span>' +
      '</div>' +
      '<div class="card-note" id="ca-burn-note"></div>' +
    '</div>' +
    // 3. Throughput — one graph: "Features shipped" or "PRs merged" (all PRs you
    //    contributed to, authored or reviewed). No toggle.
    '<div class="panel">' +
      '<div class="panel-head"><h2 id="ca-flow-title"></h2></div>' +
      '<div id="ca-flow-chart"></div>' +
      (pr ? '<div class="card-note">Includes every merged PR you contributed to &mdash; authored or reviewed.</div>' : '') +
    '</div>' +
    '<div class="card-note" id="ca-note"></div>';
  renderCaControls();
  loadTreemap();
  loadCostArtifact();
}

export function renderCaControls() {
  var type = [['feature', 'Feature'], ['pr', 'PR']].map(function (o) {
    return '<button class="' + (o[0] === state.ca.kind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  var active = caBucket();
  var bk = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === active ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var el = $('#ca-controls');
  if (!el) return;
  var L = CX_LABELS;
  // No window subtitle for features (the ordinal buckets have no line range).
  // Default is every bucket checked (empty state.ca.complexity ⇒ no filter ⇒ all
  // boxes on); a partial selection stores just the checked keys.
  var cxOpts = state.ca.kind === 'pr'
    ? [['trivial', L.trivial, '1–10 lines'], ['small', L.small, '11–100'], ['medium', L.medium, '101–500'], ['large', L.large, '501–1.5k'], ['xl', L.xl, '1.5k+']]
    : [['trivial', L.trivial, ''], ['small', L.small, ''], ['medium', L.medium, ''], ['large', L.large, ''], ['xl', L.xl, ''], ['none', L.none, '']];
  var cxSel = state.ca.complexity ? state.ca.complexity.split(',') : null; // null ⇒ all selected
  var cx = cxOpts.map(function (o) {
    var on = cxSel ? cxSel.indexOf(o[0]) !== -1 : true;
    return '<label class="sr-check"><input type="checkbox" class="ca-cx" value="' + o[0] + '"' + (on ? ' checked' : '') + '/> ' +
      esc(o[1]) + (o[2] ? ' <span class="sr-cnt">' + esc(o[2]) + '</span>' : '') + '</label>';
  }).join('');
  // Artifact (the section-scoping toggle, prominent seg-primary) + Complexity both
  // scope the KPI tile and every chart below. Bucket renders into the AI-spend panel
  // header (#ca-bucket) since it only affects the time-series charts, not the treemap.
  el.innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Artifact</span><span class="seg seg-primary" id="ca-type">' + type + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Complexity</span>' +
      '<span class="sr-checks" id="ca-complexity">' + cx + '</span></div>';
  Array.prototype.forEach.call($('#ca-type').children, function (btn) {
    btn.onclick = function () {
      state.ca.kind = btn.getAttribute('data-k');
      state.ca.userPicked = true; // stick to this choice; the headline tile mirrors it
      state.ca.complexity = '';
      renderCostArtifact();
      loadKpis();
    };
  });
  var bktEl = $('#ca-bucket');
  if (bktEl) {
    bktEl.innerHTML = bk;
    Array.prototype.forEach.call(bktEl.children, function (btn) {
      btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
    });
  }
  var cxEl = $('#ca-complexity');
  if (cxEl) Array.prototype.forEach.call(cxEl.querySelectorAll('.ca-cx'), function (cb) {
    cb.onchange = function () {
      var boxes = cxEl.querySelectorAll('.ca-cx');
      var set = [];
      Array.prototype.forEach.call(boxes, function (x) { if (x.checked) set.push(x.value); });
      if (!set.length) { cb.checked = true; return; } // keep at least one bucket selected
      // Every box checked ⇒ clear the filter (also re-includes untagged artifacts);
      // a partial selection stores just those buckets.
      state.ca.complexity = set.length === boxes.length ? '' : set.join(',');
      loadTreemap(); // treemap is complexity-scoped too (cache keyed by the filter)
      loadCostArtifact();
    };
  });
}

// Treemap nodes scope to the top-level window (artifacts completed in it) and the
// complexity filter — both applied server-side — while each tile stays sized by the
// artifact's all-time build cost, so the treemap decomposes the cost-per-artifact
// KPI. Cached per (kind, complexity, window); a change to either invalidates both
// kinds' caches (caTreeKey). Features come hierarchical from /api/feature-costs; PRs
// are a flat set from /api/artifacts (each PR a tile sized by its all-time cost).
var caFeatNodes: any[] | null = null;
var caPrNodes: any[] | null = null;
var caTreeKey = '';
var caTreeReqId = 0;

export function loadTreemap() {
  var key = state.ca.complexity + '|' + state.days;
  if (caTreeKey !== key) { caFeatNodes = null; caPrNodes = null; caTreeKey = key; }
  var cx = state.ca.complexity ? '&complexity=' + encodeURIComponent(state.ca.complexity) : '';
  var days = '&days=' + encodeURIComponent(String(state.days));
  var myReq = ++caTreeReqId; // ignore an out-of-order response from a superseded filter/window
  if (state.ca.kind === 'pr') {
    if (caPrNodes) { renderTreemap(); return; }
    get('/api/artifacts?kind=pr&shipped=1' + days + cx).then(function (rows) {
      if (myReq !== caTreeReqId) return;
      caPrNodes = (Array.isArray(rows) ? rows : []).map(function (r) {
        return { id: r.id, title: r.title || r.ident || r.externalId || r.id, parentId: null, ownCost: r.costUsd || 0, subtreeCost: r.costUsd || 0 };
      });
      renderTreemap();
    });
  } else {
    if (caFeatNodes) { renderTreemap(); return; }
    get('/api/feature-costs?days=' + encodeURIComponent(String(state.days)) + cx).then(function (d) {
      if (myReq !== caTreeReqId) return;
      caFeatNodes = (d && d.nodes) || [];
      renderTreemap();
    });
  }
}

function renderTreemap() {
  var el = $('#ca-feat');
  if (!el) return;
  var pr = state.ca.kind === 'pr';
  var nodes = pr ? caPrNodes : caFeatNodes;
  var cxNote = state.ca.complexity ? ' <span class="metric-sub">complexity: ' + esc(cxLabelList(state.ca.complexity)) + '</span>' : '';
  if (!nodes) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (!nodes.length) {
    var emptyMsg = state.ca.complexity
      ? 'No ' + (pr ? 'PRs' : 'features') + ' match this complexity filter — widen the Complexity selection above.'
      : state.days !== 'all'
        ? 'No ' + (pr ? 'PRs merged' : 'features shipped') + ' in this window — widen the window above.'
        : 'No ' + (pr ? 'merged PR' : 'shipped feature') + ' costs yet — ' +
          (pr ? 'merge a PR with linked sessions' : 'ship a feature with linked sessions in the Features tab') + '.';
    el.innerHTML = '<div class="empty">' + emptyMsg + '</div>';
    var leg0 = $('#ca-feat-legend'); if (leg0) leg0.innerHTML = '';
    return;
  }
  renderFeatTreemap(el, nodes, pr ? 'All PRs' : 'All features');
  var leg = $('#ca-feat-legend');
  if (leg) {
    leg.innerHTML = (pr
      ? '<span class="leg">Area &prop; cost &middot; each tile is a merged PR. Use the slider to roll up the long tail into “Other”.</span>'
      : '<span class="leg">Area &prop; subtree cost &middot; Click a tile to drill in; use the slider to roll up the long tail.</span>') + cxNote;
  }
}

// Curves for the toggled kind (one response feeds both the burn panel and the
// throughput panel: d.burn, d.throughput = "shipped", d.reviewed = PR-only).
var caCurves: any = null;

export function loadCostArtifact() {
  var qs = ['kind=' + encodeURIComponent(state.ca.kind), 'days=' + encodeURIComponent(String(state.days)), 'bucket=' + encodeURIComponent(caBucket())];
  if (state.ca.complexity) qs.push('complexity=' + encodeURIComponent(state.ca.complexity));
  var myReq = ++caReqId;
  caCurves = null;
  renderFlow(); // show a loading state in the throughput panel
  get('/api/cost-artifact?' + qs.join('&')).then(function (d) {
    if (myReq !== caReqId) return;
    if (!d || d.error) { var b = $('#ca-burn'); if (b) b.innerHTML = '<div class="empty">No data.</div>'; return; }
    caCurves = d;
    renderBurn(d);
    renderFlow();
  });
}

function renderBurn(d) {
  // Mirror the complexity-filtered unit cost into the headline tile. The tile is
  // sourced from /api/kpis (unfiltered), so when a filter is active we hand it the
  // figure this endpoint already computed for the same kind/window/complexity.
  setCaKpiOverride(
    state.ca.complexity
      ? { kind: state.ca.kind, days: state.days, complexity: state.ca.complexity, kpi: d.kpi }
      : null,
  );
  paintKpis();
  var burnPts = (d.burn || []).map(function (r) { return { bucket: r.bucket, total: r.spend, filled: r.shippedSpend }; });
  var el = $('#ca-burn');
  if (el) el.innerHTML = stackChart(d.buckets || [], burnPts, 'usd');
  // The complexity filter narrows only the converted line — total AI spend can't be
  // attributed to an artifact, so it stays whole. Flag that so the "unconverted"
  // band isn't read as "never shipped" when it also holds other-complexity spend.
  var burnNote = $('#ca-burn-note');
  if (burnNote) burnNote.innerHTML = state.ca.complexity
    ? esc('With a complexity filter on, only the converted line is filtered: it counts spend linked to a ' +
        (state.ca.kind === 'pr' ? 'merged PR' : 'shipped feature') + ' of the selected complexity. Total spend is unchanged, ' +
        'so spend on ' + (state.ca.kind === 'pr' ? 'PRs' : 'features') + ' of other complexity falls into the unconverted band.')
    : '';
  var note = 'Unit cost includes every session that contributed to these ' + caNoun() +
    ', even spend from before the window — so it will not equal spend within the window.';
  if (state.ca.kind === 'pr') {
    note += ' Every merged PR you contributed to counts — authored or reviewed via gh in a' +
      ' captured session; PRs merged outside a captured session aren\'t counted (yet).';
  }
  var n = $('#ca-note');
  if (n) n.innerHTML = esc(note);
}

function renderFlow() {
  var el = $('#ca-flow-chart');
  if (!el) return;
  var pr = state.ca.kind === 'pr';
  var noun = pr ? 'PRs' : 'Features';
  var verb = pr ? 'merged' : 'shipped';
  var titleEl = $('#ca-flow-title');
  if (titleEl) {
    titleEl.innerHTML = noun + ' ' + verb +
      ' <span class="metric-sub">' + esc(caWinLabel()) + ' &middot; dated at ' + (pr ? 'merge' : 'completion') + ' time</span>';
  }
  var d = caCurves;
  if (!d) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  var pts = (d.throughput || []).map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
  if (pts.some(function (p) { return p.total > 0; })) {
    el.innerHTML = stackChart(d.buckets || [], pts, 'int');
    return;
  }
  var hint = pr ? 'author or review a PR that merges' : 'mark a feature shipped in the Features tab';
  el.innerHTML = '<div class="empty">No ' + noun.toLowerCase() + ' ' + verb +
    ' in this window — ' + hint + ', or widen the window above.</div>';
}
