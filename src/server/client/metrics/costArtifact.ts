// Cost per shipped artifact detail (headline metric #2). Three stacked panels:
//   1. AI spend converted vs unconverted — the ONLY graph scoped by the Feature/PR
//      toggle (which also drives the headline tile + unit-cost note).
//   2. Feature cost breakdown — the interactive treemap (features are the hierarchy;
//      always shown regardless of the toggle).
//   3. PRs shipped/reviewed — one throughput graph with a shipped|reviewed toggle
//      (default shipped); always PR-scoped (review only exists for PRs).
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

// Segmented-control button markup.
function kindButtons() {
  return [['feature', 'Feature'], ['pr', 'PR']].map(function (o) {
    return '<button class="' + (o[0] === state.ca.kind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
}
function flowButtons() {
  return [['shipped', 'Shipped'], ['reviewed', 'Reviewed']].map(function (o) {
    return '<button class="' + (o[0] === state.ca.flow ? 'on' : '') + '" data-f="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
}

export function renderCostArtifact() {
  var shipNoun = state.ca.kind === 'pr' ? 'PR' : 'feature';
  var shipVerb = state.ca.kind === 'pr' ? 'merged' : 'shipped';
  var win = esc(caWinLabel());
  $('#metric-detail').innerHTML =
    '<div class="metric-head"><h2>' + esc(caTitle()) + '</h2></div>' +
    '<div class="ca-controls" id="ca-controls"></div>' +
    // 1. AI spend — the only graph the Feature/PR toggle scopes.
    '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>AI spend: converted vs unconverted <span class="metric-sub">' + win + ' &middot; dated at session start time</span></h2>' +
        '<span class="seg" id="ca-kind">' + kindButtons() + '</span>' +
      '</div>' +
      '<div id="ca-burn"></div>' +
      '<div class="sr-legend">' +
        '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>converted (linked to a ' + esc(shipVerb) + ' ' + esc(shipNoun) + ')</span>' +
        '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>unconverted &mdash; in-flight or never ' + esc(shipVerb) + '</span>' +
      '</div>' +
    '</div>' +
    // 2. Feature cost breakdown — interactive treemap, always (features are nested).
    '<div class="panel">' +
      '<div class="panel-head"><h2>Feature cost breakdown <span class="metric-sub">all time &middot; total spend per feature &amp; sub-features</span></h2></div>' +
      '<div id="ca-feat"></div>' +
      '<div class="sr-legend" id="ca-feat-legend"></div>' +
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
  wireKind();
  wireFlow();
  loadFeatureCosts();
  loadCostArtifact();
}

// Feature/PR toggle (scoped to the AI-spend graph, but also mirrors the headline
// tile + unit-cost framing, so a flip re-renders the whole section + reloads KPIs).
function wireKind() {
  var seg = $('#ca-kind');
  if (!seg) return;
  Array.prototype.forEach.call(seg.children, function (btn) {
    btn.onclick = function () {
      state.ca.kind = btn.getAttribute('data-k');
      state.ca.userPicked = true; // stick to this choice; the headline tile mirrors it
      renderCostArtifact();
      loadKpis();
    };
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

export function renderCaControls() {
  var active = caBucket();
  var bk = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === active ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var el = $('#ca-controls');
  if (!el) return;
  el.innerHTML = '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="ca-bucket">' + bk + '</span></div>';
  Array.prototype.forEach.call($('#ca-bucket').children, function (btn) {
    btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
  });
}

// Feature-cost nodes are all-time (window/bucket-independent), so fetch once and cache.
var caFeatNodes: any[] | null = null;

export function loadFeatureCosts() {
  if (caFeatNodes) { renderFeatViz(); return; }
  get('/api/feature-costs').then(function (d) {
    caFeatNodes = (d && d.nodes) || [];
    renderFeatViz();
  });
}

function renderFeatViz() {
  var el = $('#ca-feat');
  if (!el) return;
  if (!caFeatNodes) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  renderFeatTreemap(el, caFeatNodes);
  var leg = $('#ca-feat-legend');
  if (leg) {
    leg.innerHTML = '<span class="leg">Area &prop; subtree cost &middot; each top-level feature has its own color, sub-features are lighter tints. ' +
      'Click a tile to drill in (striped = the feature’s own/direct work); use the slider to roll up the long tail.</span>';
  }
}

// PR curves for the shipped/reviewed panel — always kind=pr, independent of the
// Feature/PR toggle. Cached per load so the flow toggle re-renders without a refetch.
var caPrCurves: any = null;

export function loadCostArtifact() {
  var bucket = encodeURIComponent(caBucket());
  var days = encodeURIComponent(String(state.days));
  // Panel 1 burn: the toggled kind.
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
