// Session Outcome Rate detail (headline metric #1): outcome-set picker, bucket
// selector, and a session-count chart whose filled portion is the outcome rate —
// a single stacked bar per bucket, or grouped bars (one per value) when broken
// down. The headline % lives on the KPI tile; the expanded view shows the counts
// behind it.
import { state, $, esc, usd, num, SR_PALETTE, get, saveSrPrefs, autoBucket, windowQs, outcomeRank, outcomeLabel, comboLabel } from '../core'
import { loadKpis } from '../kpis'
import { barChart, groupedBarChart } from '../charts'
import { srBreakdownFacets, filterRowHtml, wireFacetFilters, facetFilterQs } from '../facets'

// In-memory legend show/hide for the breakdown chart, keyed by series label.
// Reset on every new query (loadSuccessRate); preserved across legend clicks,
// which only re-paint. Not persisted — composite labels are data-dependent.
var srHidden = {};

export function renderSuccessRate() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Session Outcome Rate</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="sr-controls"></div>' +
      '<div class="chart-title">Count of Sessions with Outcomes</div>' +
      '<div id="sr-chart"></div>' +
      '<div class="sr-legend" id="sr-legend"></div>' +
      '<div class="card-note" id="sr-note"></div>' +
    '</div>' +
    // Cost-vs-outcome table. Only meaningful as a cross-value comparison, so it's
    // shown only when a breakdown is active (renderRateChart toggles the panel).
    '<div class="panel" id="sr-tbl-panel" style="display:none">' +
      '<div class="chart-title" id="sr-tbl-title">Outcome and Spend</div>' +
      '<div id="sr-tbl"></div>' +
      '<div class="card-note" id="sr-tbl-note"></div>' +
    '</div>';
  renderSrControls();
  loadSuccessRate();
}

export function renderSrControls() {
  var oc = (state.outcomeTypes || []).slice().sort(function (a, b) { return outcomeRank(a.type) - outcomeRank(b.type); });
  var checks = oc.map(function (o) {
    var on = state.sr.outcomes.indexOf(o.type) >= 0;
    var label = esc(outcomeLabel(o.type));
    return '<label class="sr-check"><input type="checkbox" class="sr-oc" value="' + esc(o.type) + '"' +
      (on ? ' checked' : '') + '/> ' + label + ' <span class="sr-cnt">' + o.sessions + '</span></label>';
  }).join('');
  var activeBucket = autoBucket(state.sr.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var byOpts = '<option value="">none</option>';
  srBreakdownFacets().forEach(function (f) {
    byOpts += '<option value="' + esc(f.key) + '"' + (f.key === state.sr.by ? ' selected' : '') + '>' +
      esc(f.label || f.key) + '</option>';
  });
  $('#sr-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Count as success</span>' +
      '<span class="sr-checks">' + (checks || '<span class="empty">no outcomes yet</span>') + '</span></div>' +
    '<div class="sr-ctrl-row">' +
      '<span class="sr-by-ctrl"><span class="sr-lbl">Bucket</span><span class="seg" id="sr-bucket">' + bucketBtns + '</span></span>' +
      filterRowHtml('sr', state.sr.filters) +
      '<span class="sr-by-ctrl" style="margin-left:18px"><span class="sr-lbl">Break down by</span>' +
      '<select class="sr-by" id="sr-by">' + byOpts + '</select></span></div>';
  wireFacetFilters('sr', $('#sr-controls'), state.sr.filters, renderSrControls, loadSuccessRate);
  Array.prototype.forEach.call(document.querySelectorAll('.sr-oc'), function (c) {
    c.onchange = function () {
      var set = [];
      Array.prototype.forEach.call(document.querySelectorAll('.sr-oc'), function (x) { if (x.checked) set.push(x.value); });
      state.sr.outcomes = set;
      saveSrPrefs();
      loadSuccessRate();
      loadKpis(); // the windowed KPI tile counts success the same way — keep it in sync
    };
  });
  Array.prototype.forEach.call($('#sr-bucket').children, function (btn) {
    btn.onclick = function () { state.sr.bucket = btn.getAttribute('data-b'); renderSrControls(); loadSuccessRate(); };
  });
  $('#sr-by').onchange = function () { state.sr.by = this.value; saveSrPrefs(); loadSuccessRate(); };
}

export function loadSuccessRate(topK?) {
  var sr = state.sr;
  srHidden = {}; // a new query may have a different set of labels — start all-visible
  var qs = ['outcomes=' + encodeURIComponent((sr.outcomes || []).join(',')), 'bucket=' + encodeURIComponent(autoBucket(sr.bucket))];
  if (sr.by) qs.push('by=' + encodeURIComponent(sr.by));
  if (topK) qs.push('topK=' + topK);
  get('/api/success-rate?' + qs.join('&') + windowQs() + facetFilterQs(sr.filters)).then(function (d) {
    if (!d || d.error) { $('#sr-chart').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderRateChart(d);
  });
}

// Per-value outcome-and-cost table (cost-at-equal-rate comparison). One row per
// series, greyed when hidden in the legend above. The four columns are honest
// primitives — two counts (sessions, with-outcome) and total spend, plus the one
// normalized cost cue ($/session = spend ÷ sessions). Cost-per-outcome is left
// to the eye (total spend vs the adjacent with-outcome count), deliberately not
// printed, so nothing competes with the cost-per-shipped-artifact KPI.
// `rows` are series-shaped: {key,text,color,num,denom,spend}.
function tableRow(s) {
  var perSess = s.denom ? esc(usd(s.spend / s.denom)) : '—';
  return '<tr' + (srHidden[s.key] ? ' class="off"' : '') + '>' +
    '<td><span class="swatch" style="background:' + s.color + '"></span>' + esc(s.text) + '</td>' +
    '<td class="num">' + num(s.denom) + '</td>' +
    '<td class="num">' + num(s.num) + '</td>' +
    '<td class="num">' + esc(usd(s.spend)) + '</td>' +
    '<td class="num">' + perSess + '</td>' +
  '</tr>';
}
function paintTable(rows) {
  $('#sr-tbl').innerHTML =
    '<table class="sr-tbl"><thead><tr>' +
      '<th>Value</th><th class="num">Sessions</th><th class="num">Sessions with outcome</th>' +
      '<th class="num">Total spend</th><th class="num">$ / session</th>' +
    '</tr></thead><tbody>' + rows.map(tableRow).join('') + '</tbody></table>';
}

// Draw (or re-draw) the breakdown chart + legend + table from srHidden. Hidden
// series drop out of the chart (the y-axis rescales to what's left) and grey out
// in the legend and table. Called on load and on every legend interaction.
// `series` carries the full set (key/label/full/color/points/rate/num/denom/spend).
function paintRate(d, series) {
  var visible = series.filter(function (s) { return !srHidden[s.key]; });
  $('#sr-chart').innerHTML = groupedBarChart(d.buckets || [], visible, 'Sessions');
  paintTable(series); // table keeps every row but greys the hidden ones
  var anyHidden = series.some(function (s) { return srHidden[s.key]; });
  var legend = series.map(function (l) {
    // Two-tone swatch mirrors the bar: solid (with outcome) over faded (none).
    var sw = 'linear-gradient(to top,' + l.color + ' 0 50%,' + l.color + '47 50% 100%)';
    var rate = l.rate != null ? Math.round(l.rate * 100) + '%' : 'n/a';
    return '<span class="leg' + (srHidden[l.key] ? ' off' : '') + '" data-key="' + esc(l.key) +
      '" title="' + esc(l.full + (l.rate != null ? ' · ' + rate : '')) + '">' +
      '<span class="swatch" style="background:' + sw + '"></span>' + esc(l.text) +
      ' <span class="sr-cnt">' + rate + '</span></span>';
  }).join('');
  // Master toggle (de-select all / restore) — only worth showing with many series.
  if (series.length > 5) {
    legend += ' <a class="leg-toggle-all" data-act="' + (anyHidden ? 'show' : 'hide') + '">' +
      (anyHidden ? 'Show all' : 'Hide all') + '</a>';
  }
  if (d.truncated) {
    legend += ' <a class="show-all-link" data-total="' + d.truncated.total + '">Show all ' +
      d.truncated.total + ' combinations</a>';
  }
  $('#sr-legend').innerHTML = legend;
  Array.prototype.forEach.call(document.querySelectorAll('#sr-legend .leg'), function (el) {
    el.onclick = function () {
      var k = this.getAttribute('data-key');
      if (srHidden[k]) delete srHidden[k]; else srHidden[k] = 1;
      paintRate(d, series);
    };
  });
  var allBtn = $('#sr-legend .leg-toggle-all');
  if (allBtn) allBtn.onclick = function () {
    if (this.getAttribute('data-act') === 'hide') series.forEach(function (s) { srHidden[s.key] = 1; });
    else srHidden = {};
    paintRate(d, series);
  };
  var srLink = $('#sr-legend .show-all-link');
  if (srLink) srLink.onclick = function () { loadSuccessRate(this.getAttribute('data-total')); };
}

export function renderRateChart(d) {
  var ov = d.overall || { rate: null, num: 0, denom: 0 };
  // Both modes are count charts (Y-axis = sessions), with the outcome rate read
  // off as the colored fill — overall is one stacked bar per bucket; breakdown is
  // one bar per composite label per bucket (grouped). Keeps the volume cue.
  var note = '';
  if (d.series && d.series.length) {
    var series = d.series.map(function (s, i) {
      var lab = comboLabel(s.key);
      // groupedBarChart reads `label` (its bar tooltip) — give it the full set.
      // num/denom/spend ride along for the cost table ($/session = spend/denom).
      return { key: s.key, label: lab.full, text: lab.text, full: lab.full,
               color: SR_PALETTE[i % SR_PALETTE.length], points: s.points,
               rate: s.rate, num: s.num, denom: s.denom, spend: s.spend };
    });
    paintRate(d, series);
    $('#sr-tbl-panel').style.display = '';
    note = d.truncated
      ? 'Showing the top ' + d.truncated.shown + ' of ' + d.truncated.total +
        ' value combinations by session volume; the rest are grouped as “... other values”. '
      : '';
    note += 'Each session is grouped by the set of values it used, so the bars partition sessions (no double-counting). ' +
      'The solid lower portion of each bar produced a selected outcome, the faded upper portion did not. ' +
      'Click a legend item to show or hide it.';
  } else {
    $('#sr-chart').innerHTML = barChart(d.buckets || [], ov.points || [], 'Sessions');
    $('#sr-legend').innerHTML =
      '<span class="leg-overall">Overall ' + (ov.rate != null ? Math.round(ov.rate * 100) + '%' : 'n/a') +
        ' · ' + num(ov.num) + ' of ' + num(ov.denom) + ' sessions with a selected outcome</span>';
    note = 'Bar height is sessions started in the bucket; the filled portion produced a selected outcome.';
    // No breakdown → nothing to compare; hide the per-value cost table.
    $('#sr-tbl-panel').style.display = 'none';
  }
  if ((d.outcomes || []).indexOf('pr_merged') >= 0) {
    note += ' Recent buckets may rise as PRs merge — those outcomes backfill after the session.';
  }
  $('#sr-note').innerHTML = esc(note);
  if (d.series && d.series.length) {
    // Default to the raw facet key (state.sr.by), upgraded to the friendly label
    // once facets are loaded — so an early render (facets still in flight) shows
    // "…by model", never "…by value".
    var byLabel = state.sr.by || 'value';
    srBreakdownFacets().forEach(function (f) { if (f.key === state.sr.by) byLabel = f.label || f.key; });
    $('#sr-tbl-title').textContent = 'Outcome and Spend by ' + byLabel;
    $('#sr-tbl-note').innerHTML = esc('One row per ' + byLabel + ', sorted by session volume. ' +
      '$ / session = total spend ÷ sessions. Rows hidden in the legend above are greyed.');
  }
}
