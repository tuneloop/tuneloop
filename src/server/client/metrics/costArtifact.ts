// Cost per shipped artifact detail (headline metric #2): a feature/PR toggle
// plus the two decomposition curves (burn dated at session, throughput dated at
// completion). The window comes from the top-level selector (state.days), and
// the curve bucket is derived from it — short windows get fine buckets.
import { state, $, esc, get, autoBucket, CX_LABELS } from '../core'
import { loadKpis, paintKpis, setCaKpiOverride } from '../kpis'
import { stackChart } from '../charts'

var caReqId = 0;
function caNoun() { return state.ca.kind === 'pr' ? 'PRs' : 'features'; }
function caTitle() { return state.ca.kind === 'pr' ? 'Cost per merged PR' : 'Cost per shipped feature'; }
function caWinLabel() { return state.days === 'all' ? 'all time' : 'last ' + state.days + ' days'; }

// The active curve bucket: the user's manual pick, else the window default
// (autoBucket). A manual pick is cleared when the window changes (renderWindow).
function caBucket() { return autoBucket(state.ca.bucket); }

export function renderCostArtifact() {
  var shipNoun = state.ca.kind === 'pr' ? 'PR' : 'feature';
  var shipVerb = state.ca.kind === 'pr' ? 'merged' : 'shipped';
  var win = esc(caWinLabel());
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>' + esc(caTitle()) + '</h2>' +
    '</div>' +
    '<div class="ca-controls" id="ca-controls"></div>' +
    '<div class="panel">' +
      '<div class="panel-head"><h2>AI spend: converted vs unconverted <span class="metric-sub">' + win + ' &middot; dated at session start time</span></h2></div>' +
      '<div id="ca-burn"></div>' +
      '<div class="sr-legend">' +
        '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>converted (linked to a ' + esc(shipVerb) + ' ' + esc(shipNoun) + ')</span>' +
        '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>unconverted &mdash; in-flight or never ' + esc(shipVerb) + '</span>' +
      '</div>' +
      '<div class="card-note" id="ca-burn-note"></div>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="panel-head"><h2>' + esc(caNoun().charAt(0).toUpperCase() + caNoun().slice(1)) + ' shipped <span class="metric-sub">' + win + ' &middot; dated at completion time</span></h2></div>' +
      '<div id="ca-throughput"></div>' +
    '</div>' +
    // PRs reviewed sits directly under PRs shipped — a parallel throughput line for
    // review work, dated when you reviewed (not when the PR merged). PRs only.
    (state.ca.kind === 'pr'
      ? '<div class="panel">' +
          '<div class="panel-head"><h2>PRs reviewed <span class="metric-sub">' + win + ' &middot; dated at review time</span></h2></div>' +
          '<div id="ca-reviewed"></div>' +
        '</div>'
      : '') +
    '<div class="card-note" id="ca-note"></div>';
  renderCaControls();
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
  // Row 1 — Artifact + Complexity both scope the KPI tile and every chart below.
  // Row 2 — Bucket only sets the time-series curve granularity (charts, not the KPI).
  $('#ca-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Artifact</span><span class="seg" id="ca-type">' + type + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Complexity</span>' +
      '<span class="sr-checks" id="ca-complexity">' + cx + '</span></div>' +
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="ca-bucket">' + bk + '</span></div>';
  Array.prototype.forEach.call($('#ca-type').children, function (btn) {
    btn.onclick = function () {
      state.ca.kind = btn.getAttribute('data-k');
      state.ca.userPicked = true; // stick to this choice; the headline tile mirrors it
      state.ca.complexity = '';
      renderCostArtifact();
      loadKpis();
    };
  });
  Array.prototype.forEach.call($('#ca-bucket').children, function (btn) {
    btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
  });
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
      loadCostArtifact();
    };
  });
}

export function loadCostArtifact() {
  var qs = ['kind=' + encodeURIComponent(state.ca.kind), 'days=' + encodeURIComponent(String(state.days)), 'bucket=' + encodeURIComponent(caBucket())];
  if (state.ca.complexity) qs.push('complexity=' + encodeURIComponent(state.ca.complexity));
  var myReq = ++caReqId;
  get('/api/cost-artifact?' + qs.join('&')).then(function (d) {
    if (myReq !== caReqId) return;
    if (!d || d.error) { $('#ca-burn').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderCa(d);
  });
}

export function renderCa(d) {
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
  $('#ca-burn').innerHTML = stackChart(d.buckets || [], burnPts, 'usd');
  // The complexity filter narrows only the converted line — total AI spend can't be
  // attributed to an artifact, so it stays whole. Flag that so the "unconverted"
  // band isn't read as "never shipped" when it also holds other-complexity spend.
  var burnNote = $('#ca-burn-note');
  if (burnNote) burnNote.innerHTML = state.ca.complexity
    ? esc('With a complexity filter on, only the converted line is filtered: it counts spend linked to a ' +
        (state.ca.kind === 'pr' ? 'merged PR' : 'shipped feature') + ' of the selected complexity. Total spend is unchanged, ' +
        'so spend on ' + (state.ca.kind === 'pr' ? 'PRs' : 'features') + ' of other complexity falls into the unconverted band.')
    : '';
  var thPts = (d.throughput || []).map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
  var anyShip = thPts.some(function (p) { return p.total > 0; });
  $('#ca-throughput').innerHTML = anyShip
    ? stackChart(d.buckets || [], thPts, 'int')
    : '<div class="empty">No ' + esc(caNoun()) + ' completed in this window — mark one shipped in the Features tab (or merge a PR), or widen the window above.</div>';
  // PRs reviewed curve (PRs only; the panel exists only when kind === 'pr').
  var rvEl = $('#ca-reviewed');
  if (rvEl) {
    var rvPts = (d.reviewed || []).map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
    rvEl.innerHTML = rvPts.some(function (p) { return p.total > 0; })
      ? stackChart(d.buckets || [], rvPts, 'int')
      : '<div class="empty">No PRs reviewed in this window — a session that reviews a PR (reads its diff during review work) shows here.</div>';
  }
  var note = 'Unit cost includes every session that built these ' + caNoun() +
    ', even spend from before the window — so it will not equal spend within the window.';
  if (state.ca.kind === 'pr') {
    note += ' Only PRs a session created or merged (via gh or a GitHub MCP tool) are linked' +
      ' — PRs opened or merged outside a captured session aren\'t counted (yet).';
  }
  $('#ca-note').innerHTML = esc(note);
}
