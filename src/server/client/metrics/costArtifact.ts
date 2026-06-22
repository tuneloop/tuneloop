// Cost per shipped artifact detail (headline metric #2): the windowed unit-cost
// KPI with a feature/PR toggle and window selector, plus the two decomposition
// curves (burn dated at session, throughput dated at completion).
import { state, $, esc, usd, num, get, kpiDelta } from '../core'
import { stackChart } from '../charts'

function caNoun() { return state.ca.kind === 'pr' ? 'PRs' : 'features'; }
function caTitle() { return state.ca.kind === 'pr' ? 'Cost per merged PR' : 'Cost per shipped feature'; }

export function renderCostArtifact() {
  var shipNoun = state.ca.kind === 'pr' ? 'PR' : 'feature';
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>' + esc(caTitle()) + '</h2>' +
      '<div class="metric-big" id="ca-big">—</div>' +
    '</div>' +
    '<div class="ca-controls" id="ca-controls"></div>' +
    '<div class="panel">' +
      '<div class="panel-head"><h2>AI spend over time <span class="metric-sub">all time, dated at session</span></h2></div>' +
      '<div id="ca-burn"></div>' +
      '<div class="sr-legend">' +
        '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>converted (linked to a shipped ' + esc(shipNoun) + ')</span>' +
        '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>pending / not yet shipped</span>' +
      '</div>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="panel-head"><h2>' + esc(caNoun().charAt(0).toUpperCase() + caNoun().slice(1)) + ' shipped over time <span class="metric-sub">all time, dated at completion</span></h2></div>' +
      '<div id="ca-throughput"></div>' +
    '</div>' +
    '<div class="card-note" id="ca-note"></div>';
  renderCaControls();
  loadCostArtifact();
}

export function renderCaControls() {
  var ca = state.ca;
  var type = [['feature', 'Feature'], ['pr', 'PR']].map(function (o) {
    return '<button class="' + (o[0] === ca.kind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  var win = [['7', '7d'], ['30', '30d'], ['90', '90d'], ['all', 'All']].map(function (o) {
    return '<button class="' + (String(ca.days) === o[0] ? 'on' : '') + '" data-d="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  var bk = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === ca.bucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  $('#ca-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Artifact</span><span class="seg" id="ca-type">' + type + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Window</span><span class="seg" id="ca-win">' + win + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Curve bucket</span><span class="seg" id="ca-bucket">' + bk + '</span></div>';
  Array.prototype.forEach.call($('#ca-type').children, function (btn) {
    btn.onclick = function () {
      state.ca.kind = btn.getAttribute('data-k');
      renderCostArtifact(); // the single 'cost_artifact' tile stays active across the toggle
    };
  });
  Array.prototype.forEach.call($('#ca-win').children, function (btn) {
    btn.onclick = function () {
      var d = btn.getAttribute('data-d');
      state.ca.days = d === 'all' ? 'all' : parseInt(d, 10);
      renderCaControls();
      loadCostArtifact();
    };
  });
  Array.prototype.forEach.call($('#ca-bucket').children, function (btn) {
    btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
  });
}

export function loadCostArtifact() {
  var ca = state.ca;
  var qs = ['kind=' + encodeURIComponent(ca.kind), 'days=' + encodeURIComponent(String(ca.days)), 'bucket=' + encodeURIComponent(ca.bucket)];
  get('/api/cost-artifact?' + qs.join('&')).then(function (d) {
    if (!d || d.error) { $('#ca-burn').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderCa(d);
  });
}

export function renderCa(d) {
  var cur = d.kpi && d.kpi.current, prev = d.kpi && d.kpi.previous;
  var winLabel = d.days === 'all' ? 'all time' : 'last ' + d.days + ' days';
  var val = cur && cur.costPerUnit != null ? usd(cur.costPerUnit) : '—';
  var delta = prev ? kpiDelta(cur ? cur.costPerUnit : null, prev.costPerUnit, 'rel', 'down') : '';
  var big = $('#ca-big');
  if (big) big.innerHTML = esc(val) + delta +
    ' <span class="metric-sub">' + esc(winLabel) + ' &middot; ' + (cur ? cur.count : 0) + ' ' + esc(caNoun()) + ' shipped</span>';
  var burnPts = (d.burn || []).map(function (r) { return { bucket: r.bucket, total: r.spend, filled: r.shippedSpend }; });
  $('#ca-burn').innerHTML = stackChart(d.buckets || [], burnPts, 'usd');
  var thPts = (d.throughput || []).map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
  var anyShip = thPts.some(function (p) { return p.total > 0; });
  $('#ca-throughput').innerHTML = anyShip
    ? stackChart(d.buckets || [], thPts, 'int')
    : '<div class="empty">No ' + esc(caNoun()) + ' completed yet — mark one shipped in the Features tab (or merge a PR) to populate this and the unit cost above.</div>';
  var note = 'Unit cost includes every session that built these ' + caNoun() +
    ', even spend from before the window — so it will not equal spend within the window.';
  if (d.period && d.period.throughput > 0) {
    note += ' Burn efficiency, a different question (spend in window ÷ ' + caNoun() + ' shipped in window) = ' +
      usd(d.period.efficiency) + '.';
  }
  $('#ca-note').innerHTML = esc(note);
}
