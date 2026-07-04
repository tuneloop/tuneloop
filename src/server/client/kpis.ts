// The headline KPI tile row + the tile-as-nav behaviour: clicking a tile opens
// that metric's full-width detail section, and exactly one section is always
// expanded (default success_rate, set in main.ts).
import { state, $, esc, usd, num, get, fmtVal, kpiDelta, cxLabelList } from './core'
import { syncHash } from './router'
import { clearAsked } from './askbanner'
import { successDefinable } from './notice'
import { renderSuccessRate } from './metrics/successRate'
import { renderCostArtifact } from './metrics/costArtifact'
import { renderTotalSpend } from './metrics/totalSpend'
import { renderSessionsMetric } from './metrics/sessionsMetric'
import { renderOps } from './metrics/ops'
import { renderAiAttribution } from './metrics/aiAttribution'

// The top-level window selector + caption. Sets the window every headline tile
// AND every expansion's charts are computed over. Lives where the caption used
// to, so "Last N days" is now an adjustable control, not just a label.
var WINDOWS = [['7', '7d'], ['14', '14d'], ['30', '30d'], ['90', '90d'], ['all', 'All']];
export function renderWindow() {
  var cap = $('#kpi-caption');
  if (!cap) return;
  var btns = WINDOWS.map(function (o) {
    return '<button class="' + (String(state.days) === o[0] ? 'on' : '') + '" data-d="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  var caption = state.days === 'all'
    ? 'All time'
    : 'Last ' + state.days + ' days &middot; ▲▼ vs. previous ' + state.days + ' days';
  cap.innerHTML = '<span class="win-seg seg" id="win-seg">' + btns + '</span>' +
    '<span class="win-cap">' + caption + '</span>';
  Array.prototype.forEach.call($('#win-seg').children, function (btn) {
    btn.onclick = function () {
      var d = btn.getAttribute('data-d');
      state.days = d === 'all' ? 'all' : parseInt(d, 10);
      renderWindow();
      loadKpis();
      // Every expansion's charts track the same window. Re-default each curve
      // bucket for the new span (clear manual picks), then re-render whichever
      // detail is open so its charts + labels follow N.
      state.sr.bucket = ''; state.ca.bucket = ''; state.spend.bucket = ''; state.sm.bucket = ''; state.ops.bucket = ''; state.ai.bucket = '';
      renderOpenMetric();
    };
  });
}

// Re-render the currently expanded metric's detail (shared by openMetric and the
// window selector). No-op when no detail is open.
export function renderOpenMetric() {
  var m = state.metric;
  if (m === 'success_rate') renderSuccessRate();
  else if (m === 'cost_artifact') renderCostArtifact();
  else if (m === 'total_spend') renderTotalSpend();
  else if (m === 'sessions') renderSessionsMetric();
  else if (m === 'ops') renderOps();
  else if (m === 'ai_attribution') renderAiAttribution();
}

// The most recent /api/kpis payload, kept so the tile row can repaint without a
// refetch when the overview lands (which decides whether any outcomes exist at
// all — see paintKpis' Session Outcome Rate handling).
var lastKpis: any = null;

// The complexity-filtered cost-per-artifact figure, published by the Cost-by-
// Artifact detail (renderBurn) so the headline tile can mirror the active filter.
// Tagged with its kind/window/complexity so a stale filter never paints.
var caKpiOverride: any = null;
export function setCaKpiOverride(o: any) { caKpiOverride = o; }

export function loadKpis() {
  // The headline success-rate tile counts success the same way the detail view
  // does (outcomes), and the whole row honors the top-level window (days).
  var outcomes = (state.sr.outcomes || []).join(',');
  var qs = 'outcomes=' + encodeURIComponent(outcomes) + '&days=' + encodeURIComponent(String(state.days));
  get('/api/kpis?' + qs).then(function (k) {
    lastKpis = k;
    paintKpis();
  });
}

// Render the headline tile row from the last fetched payload + current store
// state. Separated from the fetch so an overview load can trigger a repaint (the
// "any outcomes recorded?" check below depends on it).
export function paintKpis() {
  var k = lastKpis;
  if (!k || k.error) { $('#kpis').innerHTML = ''; return; }
  var cur = k.current || {}, prev = k.previous || {};
  var cpf = cur.costPerFeature || {}, ppf = prev.costPerFeature || {};
  var cpr = cur.costPerPr || {}, ppr = prev.costPerPr || {};
  var defaultKind = (cpf.count === 0 && (cpr.count || 0) > 0) ? 'pr' : 'feature';
  state.ca.defaultKind = defaultKind;
  // The tile mirrors the kind the user picked in the detail; until then, the
  // smart default. Keep state.ca.kind synced so the detail opens on it too.
  if (!state.ca.userPicked) state.ca.kind = defaultKind;
  var caData = state.ca.kind === 'pr'
    ? { cur: cpr, prev: ppr, label: 'per merged PR', noun: 'PR', nounPl: 'PRs', verb: 'merged' }
    : { cur: cpf, prev: ppf, label: 'per shipped feature', noun: 'feature', nounPl: 'features', verb: 'shipped' };
  // When a complexity filter is active, the tile mirrors the filtered figure the
  // Cost-by-Artifact endpoint computed — but only if the override still matches the
  // current kind/window/complexity (guards against a stale filter after a switch).
  var caCx = state.ca.complexity;
  var useCaFilter = !!caCx && caKpiOverride && caKpiOverride.kind === state.ca.kind &&
    caKpiOverride.days === state.days && caKpiOverride.complexity === caCx;
  if (useCaFilter) {
    caData.cur = caKpiOverride.kpi.current || {};
    caData.prev = caKpiOverride.kpi.previous || {};
  }
  var cnt = caData.cur.count || 0;
  var caSub = useCaFilter
    ? caData.label + ' · counting ' + cnt + ' ' + (cnt === 1 ? caData.noun : caData.nounPl) + ' of complexity: ' + cxLabelList(caCx)
    : caData.label + ' · ' + cnt + ' ' + (cnt === 1 ? caData.noun : caData.nounPl) + ' ' + caData.verb;
  // A "0%" outcome rate only means something once the selected success definition
  // can actually be satisfied; when none of its outcome types exist (e.g. the
  // default `session_success` before LLM enrichment has run), the rate is a
  // structural 0, so show "—" (and no delta) rather than a misleadingly bad number.
  // successDefinable reads the overview, so this corrects once that lands (see the
  // paintKpis callers in main.ts) and the enrichment nudge explains why.
  var srKnown = successDefinable();
  var ai = cur.aiAttribution || {}, aiPrev = prev.aiAttribution || {};
  var tiles = [
    { label: 'Session Outcome Rate', value: srKnown ? fmtVal(cur.successRate, 'pct') : '—',
      delta: srKnown ? kpiDelta(cur.successRate, prev.successRate, 'points', 'up') : '',
      sub: srKnown ? 'of sessions in window' : 'no matching outcomes yet', metric: 'success_rate' },
    { label: 'Cost per shipped artifact', value: caData.cur.costPerUnit != null ? usd(caData.cur.costPerUnit) : '—',
      delta: kpiDelta(caData.cur.costPerUnit, caData.prev.costPerUnit, 'rel', 'down'), sub: caSub,
      metric: 'cost_artifact' },
    { label: 'Total spend', value: usd(cur.totalSpend),
      delta: kpiDelta(cur.totalSpend, prev.totalSpend, 'rel', null), sub: '', metric: 'total_spend' },
    { label: 'Sessions', value: num(cur.sessions),
      delta: kpiDelta(cur.sessions, prev.sessions, 'rel', null), sub: '', metric: 'sessions' },
    { label: 'Tool error rate', value: fmtVal(cur.errorRate, 'pct'),
      delta: kpiDelta(cur.errorRate, prev.errorRate, 'points', 'down'), sub: 'of tool calls', metric: 'ops' },
    // Added-line-weighted share of merged-PR code the agent authored (a lower
    // bound — see the detail view's note). No good/bad direction: more AI code
    // isn't inherently either, so the delta is neutral
    { label: 'AI-written share', value: ai.pct != null ? fmtVal(ai.pct, 'pct') : '—',
      delta: ai.pct != null && aiPrev.pct != null ? kpiDelta(ai.pct, aiPrev.pct, 'points', null) : '',
      sub: ai.pct != null ? 'of added lines · ' + (ai.prCount || 0) + ' measured PR' + (ai.prCount === 1 ? '' : 's') : 'no content-matched PRs yet',
      metric: 'ai_attribution' }
  ];
  $('#kpis').innerHTML = tiles.map(function (t) {
    // Tiles with a metric key are clickable nav into that metric's detail view.
    var cls = 'tile' + (t.metric ? ' clickable' : '') + (t.metric && t.metric === state.metric ? ' on' : '');
    var attr = t.metric ? ' data-metric="' + t.metric + '"' : '';
    return '<div class="' + cls + '"' + attr + '><div class="label">' + esc(t.label) + '</div><div class="value"><span class="num">' +
      esc(t.value) + '</span>' + (t.delta || '') + '</div><div class="sub">' + esc(t.sub) + '</div></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#kpis .tile[data-metric]'), function (el) {
    el.onclick = function () { clearAsked(); openMetric(el.getAttribute('data-metric')); };
  });
}

// Tiles act as nav: one section is always expanded; clicking a tile switches to it.
export function openMetric(m, force?) {
  if (state.metric === m && !force) return; // already expanded (unless forced)
  state.metric = m;
  state.view = 'dashboard';
  syncKpiActive();
  renderOpenMetric();
  syncHash(); // mirror the metric into the URL (no-op while a route is applying)
}

export function syncKpiActive() {
  Array.prototype.forEach.call(document.querySelectorAll('#kpis .tile[data-metric]'), function (el) {
    el.classList.toggle('on', el.getAttribute('data-metric') === state.metric);
  });
}
