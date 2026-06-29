// Cost per shipped artifact detail (headline metric #2). A top-level Feature/PR
// toggle scopes the section; below it, three stacked panels:
//   1. Cost breakdown treemap — feature (hierarchical) or PR (flat) per the toggle.
//   2. AI spend converted vs unconverted — burn for the toggled kind.
//   3. PRs shipped/reviewed — one graph with a shipped|reviewed toggle (default
//      shipped); always PR-scoped (review only exists for PRs).
// The window comes from the top-level selector (state.days); the curve bucket is
// derived from it (short windows get fine buckets) unless the user picks one.
import { state, $, esc, usd, get, autoBucket } from '../core'
import { loadKpis } from '../kpis'
import { stackChart } from '../charts'
import { renderFeatTreemap } from '../featTreemap'

function caNoun() { return state.ca.kind === 'pr' ? 'PRs' : 'features'; }
function caTitle() { return state.ca.kind === 'pr' ? 'Cost per merged PR' : 'Cost per shipped feature'; }
function caWinLabel() { return state.days === 'all' ? 'all time' : 'last ' + state.days + ' days'; }
function caBucket() { return autoBucket(state.ca.bucket); }

function flowButtons() {
  return [['shipped', 'Shipped'], ['reviewed', 'Reviewed']].map(function (o) {
    return '<button class="' + (o[0] === state.ca.flow ? 'on' : '') + '" data-f="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
}

export function renderCostArtifact() {
  var pr = state.ca.kind === 'pr';
  var shipNoun = pr ? 'PR' : 'feature';
  var shipVerb = pr ? 'merged' : 'shipped';
  var win = esc(caWinLabel());
  var tmTitle = pr ? 'PR cost breakdown' : 'Feature cost breakdown';
  var tmSub = pr ? 'all time &middot; total spend per merged PR' : 'all time &middot; total spend per feature &amp; sub-features';
  $('#metric-detail').innerHTML =
    '<div class="metric-head"><h2>' + esc(caTitle()) + '</h2></div>' +
    '<div class="ca-controls" id="ca-controls"></div>' +
    // 1. Cost breakdown treemap (feature or PR, per the top-level toggle).
    '<div class="panel">' +
      '<div class="panel-head"><h2>' + tmTitle + ' <span class="metric-sub">' + tmSub + '</span></h2></div>' +
      '<div id="ca-feat"></div>' +
      '<div class="sr-legend" id="ca-feat-legend"></div>' +
    '</div>' +
    // 2. AI spend converted/unconverted (burn for the toggled kind).
    '<div class="panel">' +
      '<div class="panel-head"><h2>AI spend: converted vs unconverted <span class="metric-sub">' + win + ' &middot; dated at session start time</span></h2></div>' +
      '<div id="ca-burn"></div>' +
      '<div class="sr-legend">' +
        '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>converted (linked to a ' + esc(shipVerb) + ' ' + esc(shipNoun) + ')</span>' +
        '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>unconverted &mdash; in-flight or never ' + esc(shipVerb) + '</span>' +
      '</div>' +
    '</div>' +
    // 3. PRs shipped/reviewed — one graph, toggle, default shipped. Always PRs.
    '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2 id="ca-flow-title"></h2>' +
        '<span class="seg" id="ca-flow">' + flowButtons() + '</span>' +
      '</div>' +
      '<div id="ca-flow-chart"></div>' +
    '</div>' +
    '<div class="card-note" id="ca-note"></div>';
  renderCaControls();
  wireFlow();
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
  el.innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Artifact</span><span class="seg" id="ca-type">' + type + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Bucket</span><span class="seg" id="ca-bucket">' + bk + '</span></div>';
  Array.prototype.forEach.call($('#ca-type').children, function (btn) {
    btn.onclick = function () {
      state.ca.kind = btn.getAttribute('data-k');
      state.ca.userPicked = true; // stick to this choice; the headline tile mirrors it
      renderCostArtifact();
      loadKpis();
    };
  });
  Array.prototype.forEach.call($('#ca-bucket').children, function (btn) {
    // Bucket only affects the time-series panels; the treemap is all-time.
    btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
  });
}

// Shipped/reviewed toggle for the bottom PR graph — re-renders from cached PR
// curves (no refetch; both series come from one response).
function wireFlow() {
  var seg = $('#ca-flow');
  if (!seg) return;
  Array.prototype.forEach.call(seg.children, function (btn) {
    btn.onclick = function () {
      state.ca.flow = btn.getAttribute('data-f');
      Array.prototype.forEach.call(seg.children, function (b) {
        b.className = b.getAttribute('data-f') === state.ca.flow ? 'on' : '';
      });
      renderFlow();
    };
  });
}

// Treemap cost nodes are all-time (window/bucket-independent), so fetch once per
// kind and cache. Features come hierarchical from /api/feature-costs; PRs are a
// flat set mapped from /api/artifacts (each PR a tile sized by its all-time cost).
var caFeatNodes: any[] | null = null;
var caPrNodes: any[] | null = null;

export function loadTreemap() {
  if (state.ca.kind === 'pr') {
    if (caPrNodes) { renderTreemap(); return; }
    get('/api/artifacts?kind=pr').then(function (rows) {
      caPrNodes = (Array.isArray(rows) ? rows : []).map(function (r) {
        return { id: r.id, title: r.title || r.ident || r.externalId || r.id, parentId: null, ownCost: r.costUsd || 0, subtreeCost: r.costUsd || 0 };
      });
      renderTreemap();
    });
  } else {
    if (caFeatNodes) { renderTreemap(); return; }
    get('/api/feature-costs').then(function (d) {
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
  if (!nodes) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (!nodes.length) {
    el.innerHTML = '<div class="empty">No ' + (pr ? 'PR' : 'feature') + ' costs yet — ' +
      (pr ? 'merge a PR with linked sessions' : 'link sessions to features in the Features tab') + '.</div>';
    var leg0 = $('#ca-feat-legend'); if (leg0) leg0.innerHTML = '';
    return;
  }
  renderFeatTreemap(el, nodes, pr ? 'All PRs' : 'All features');
  var leg = $('#ca-feat-legend');
  if (leg) {
    leg.innerHTML = pr
      ? '<span class="leg">Area &prop; cost &middot; each tile is a merged PR (no hierarchy). Use the slider to roll up the long tail into “Other”.</span>'
      : '<span class="leg">Area &prop; subtree cost &middot; each top-level feature has its own color, sub-features are lighter tints. ' +
        'Click a tile to drill in (striped = the feature’s own/direct work); use the slider to roll up the long tail.</span>';
  }
}

// PR curves for the shipped/reviewed panel — always kind=pr, independent of the
// Feature/PR toggle. Cached per load so the flow toggle re-renders without a refetch.
var caPrCurves: any = null;

export function loadCostArtifact() {
  var bucket = encodeURIComponent(caBucket());
  var days = encodeURIComponent(String(state.days));
  // Panel 2 burn: the toggled kind.
  get('/api/cost-artifact?kind=' + encodeURIComponent(state.ca.kind) + '&days=' + days + '&bucket=' + bucket).then(function (d) {
    if (!d || d.error) { var b = $('#ca-burn'); if (b) b.innerHTML = '<div class="empty">No data.</div>'; return; }
    renderBurn(d);
    if (state.ca.kind === 'pr') { caPrCurves = d; renderFlow(); } // reuse the same response
  });
  // Panel 3 shipped/reviewed: always PRs (skip the duplicate fetch when kind is pr).
  if (state.ca.kind !== 'pr') {
    caPrCurves = null;
    renderFlow();
    get('/api/cost-artifact?kind=pr&days=' + days + '&bucket=' + bucket).then(function (d) {
      caPrCurves = (d && !d.error) ? d : null;
      renderFlow();
    });
  }
}

function renderBurn(d) {
  var burnPts = (d.burn || []).map(function (r) { return { bucket: r.bucket, total: r.spend, filled: r.shippedSpend }; });
  var el = $('#ca-burn');
  if (el) el.innerHTML = stackChart(d.buckets || [], burnPts, 'usd');
  var note = 'Unit cost includes every session that built these ' + caNoun() +
    ', even spend from before the window — so it will not equal spend within the window.';
  if (d.period && d.period.throughput > 0) {
    note += ' Burn efficiency, a different question (spend in window ÷ ' + caNoun() + ' shipped in window) = ' +
      usd(d.period.efficiency) + '.';
  }
  var n = $('#ca-note');
  if (n) n.innerHTML = esc(note);
}

function renderFlow() {
  var el = $('#ca-flow-chart');
  if (!el) return;
  var reviewed = state.ca.flow === 'reviewed';
  var titleEl = $('#ca-flow-title');
  if (titleEl) {
    titleEl.innerHTML = (reviewed ? 'PRs reviewed' : 'PRs shipped') +
      ' <span class="metric-sub">' + esc(caWinLabel()) + ' &middot; dated at ' + (reviewed ? 'review' : 'completion') + ' time</span>';
  }
  var d = caPrCurves;
  if (!d) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  var rows = reviewed ? (d.reviewed || []) : (d.throughput || []);
  var pts = rows.map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
  el.innerHTML = pts.some(function (p) { return p.total > 0; })
    ? stackChart(d.buckets || [], pts, 'int')
    : '<div class="empty">No PRs ' + (reviewed ? 'reviewed' : 'merged') + ' in this window — ' +
        (reviewed ? 'a session that reviews a PR (reads its diff) shows here' : 'merge a PR, or widen the window above') + '.</div>';
}
