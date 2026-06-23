// Cost per shipped artifact detail (headline metric #2): a feature/PR toggle
// plus the two decomposition curves (burn dated at session, throughput dated at
// completion). The window comes from the top-level selector (state.days), and
// the curve bucket is derived from it — short windows get fine buckets.
import { state, $, esc, usd, get, autoBucket } from '../core'
import { loadKpis } from '../kpis'
import { stackChart } from '../charts'

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
    '</div>' +
    '<div class="panel">' +
      '<div class="panel-head"><h2>' + esc(caNoun().charAt(0).toUpperCase() + caNoun().slice(1)) + ' shipped <span class="metric-sub">' + win + ' &middot; dated at completion time</span></h2></div>' +
      '<div id="ca-throughput"></div>' +
    '</div>' +
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
  $('#ca-controls').innerHTML =
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
    btn.onclick = function () { state.ca.bucket = btn.getAttribute('data-b'); renderCaControls(); loadCostArtifact(); };
  });
}

export function loadCostArtifact() {
  var qs = ['kind=' + encodeURIComponent(state.ca.kind), 'days=' + encodeURIComponent(String(state.days)), 'bucket=' + encodeURIComponent(caBucket())];
  get('/api/cost-artifact?' + qs.join('&')).then(function (d) {
    if (!d || d.error) { $('#ca-burn').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderCa(d);
  });
}

export function renderCa(d) {
  var burnPts = (d.burn || []).map(function (r) { return { bucket: r.bucket, total: r.spend, filled: r.shippedSpend }; });
  $('#ca-burn').innerHTML = stackChart(d.buckets || [], burnPts, 'usd');
  var thPts = (d.throughput || []).map(function (r) { return { bucket: r.bucket, total: r.count, filled: r.count }; });
  var anyShip = thPts.some(function (p) { return p.total > 0; });
  $('#ca-throughput').innerHTML = anyShip
    ? stackChart(d.buckets || [], thPts, 'int')
    : '<div class="empty">No ' + esc(caNoun()) + ' completed in this window — mark one shipped in the Features tab (or merge a PR), or widen the window above.</div>';
  var note = 'Unit cost includes every session that built these ' + caNoun() +
    ', even spend from before the window — so it will not equal spend within the window.';
  if (d.period && d.period.throughput > 0) {
    note += ' Burn efficiency, a different question (spend in window ÷ ' + caNoun() + ' shipped in window) = ' +
      usd(d.period.efficiency) + '.';
  }
  $('#ca-note').innerHTML = esc(note);
}
