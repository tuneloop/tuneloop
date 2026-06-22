// The headline KPI tile row + the tile-as-nav behaviour: clicking a tile opens
// that metric's full-width detail section, and exactly one section is always
// expanded (default success_rate, set in main.ts).
import { state, $, esc, usd, num, get, fmtVal, kpiDelta } from './core'
import { renderSuccessRate } from './metrics/successRate'
import { renderCostArtifact } from './metrics/costArtifact'
import { renderTotalSpend } from './metrics/totalSpend'
import { renderSessionsMetric } from './metrics/sessionsMetric'
import { renderOps } from './metrics/ops'

export function loadKpis() {
  get('/api/kpis').then(function (k) {
    if (!k || k.error) { $('#kpis').innerHTML = ''; return; }
    var cur = k.current || {}, prev = k.previous || {};
    var cpf = cur.costPerFeature || {}, ppf = prev.costPerFeature || {};
    var tiles = [
      { label: 'Session success rate', value: fmtVal(cur.successRate, 'pct'),
        delta: kpiDelta(cur.successRate, prev.successRate, 'points', 'up'), sub: 'of sessions in window',
        metric: 'success_rate' },
      { label: 'Cost per shipped artifact', value: cpf.costPerUnit != null ? usd(cpf.costPerUnit) : '—',
        delta: kpiDelta(cpf.costPerUnit, ppf.costPerUnit, 'rel', 'down'), sub: 'per shipped feature · ' + (cpf.count || 0),
        metric: 'cost_artifact' },
      { label: 'Total spend', value: usd(cur.totalSpend),
        delta: kpiDelta(cur.totalSpend, prev.totalSpend, 'rel', null), sub: '', metric: 'total_spend' },
      { label: 'Sessions', value: num(cur.sessions),
        delta: kpiDelta(cur.sessions, prev.sessions, 'rel', null), sub: '', metric: 'sessions' },
      { label: 'Tool error rate', value: fmtVal(cur.errorRate, 'pct'),
        delta: kpiDelta(cur.errorRate, prev.errorRate, 'points', 'down'), sub: 'of tool calls', metric: 'ops' }
    ];
    $('#kpis').innerHTML = tiles.map(function (t) {
      // Tiles with a metric key are clickable nav into that metric's detail view.
      var cls = 'tile' + (t.metric ? ' clickable' : '') + (t.metric && t.metric === state.metric ? ' on' : '');
      var attr = t.metric ? ' data-metric="' + t.metric + '"' : '';
      return '<div class="' + cls + '"' + attr + '><div class="label">' + esc(t.label) + '</div><div class="value">' +
        esc(t.value) + (t.delta || '') + '</div><div class="sub">' + esc(t.sub) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#kpis .tile[data-metric]'), function (el) {
      el.onclick = function () { openMetric(el.getAttribute('data-metric')); };
    });
    var days = k.days || 7;
    var cap = $('#kpi-caption');
    if (cap) cap.innerHTML = 'Last ' + days + ' days &middot; ▲▼ vs. previous ' + days + ' days';
  });
}

// Tiles act as nav: one section is always expanded; clicking a tile switches to it.
export function openMetric(m) {
  if (state.metric === m) return; // already expanded
  state.metric = m;
  syncKpiActive();
  if (m === 'success_rate') renderSuccessRate();
  else if (m === 'cost_artifact') {
    state.ca.kind = 'feature'; // feature_shipped is the default; toggle to PR inside
    renderCostArtifact();
  } else if (m === 'total_spend') renderTotalSpend();
  else if (m === 'sessions') renderSessionsMetric();
  else if (m === 'ops') renderOps();
}

export function syncKpiActive() {
  Array.prototype.forEach.call(document.querySelectorAll('#kpis .tile[data-metric]'), function (el) {
    el.classList.toggle('on', el.getAttribute('data-metric') === state.metric);
  });
}
