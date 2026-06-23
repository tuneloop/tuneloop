// Total spend detail (the burn / spend-breakdown view): spend over time, with
// an optional split into one usage/session-grain cohort line per facet value.
import { state, $, esc, usd, SR_PALETTE, get, autoBucket, windowQs, legendHtml, wireLegend } from '../core'
import { groupedBarChart, stackChart } from '../charts'
import { spendBreakdownFacets } from '../facets'

export function renderTotalSpend() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Total spend</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="sp-controls"></div>' +
      '<div id="sp-chart"></div>' +
      '<div class="sr-legend" id="sp-legend"></div>' +
      '<div class="card-note" id="sp-note"></div>' +
    '</div>';
  renderSpendControls();
  loadTotalSpend();
}

export function renderSpendControls() {
  var sp = state.spend;
  var activeBucket = autoBucket(sp.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var byOpts = '<option value="">none</option>';
  spendBreakdownFacets().forEach(function (f) {
    byOpts += '<option value="' + esc(f.key) + '"' + (f.key === sp.by ? ' selected' : '') + '>' + esc(f.label || f.key) + '</option>';
  });
  $('#sp-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="sp-bucket">' + bucketBtns + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Break down by</span>' +
      '<select class="sr-by" id="sp-by">' + byOpts + '</select></div>';
  Array.prototype.forEach.call($('#sp-bucket').children, function (btn) {
    btn.onclick = function () { state.spend.bucket = btn.getAttribute('data-b'); renderSpendControls(); loadTotalSpend(); };
  });
  $('#sp-by').onchange = function () { state.spend.by = this.value; loadTotalSpend(); };
}

export function loadTotalSpend() {
  var sp = state.spend;
  var qs = ['bucket=' + encodeURIComponent(autoBucket(sp.bucket))];
  if (sp.by) qs.push('by=' + encodeURIComponent(sp.by));
  get('/api/spend-over-time?' + qs.join('&') + windowQs()).then(function (d) {
    if (!d || d.error) { $('#sp-chart').innerHTML = '<div class="empty">' + esc(d && d.error ? d.error : 'No data.') + '</div>'; return; }
    renderSpend(d);
  });
}

export function renderSpend(d) {
  var ov = d.overall || { total: 0, points: [] };
  var hidden = state.spend.hidden;
  var chart = $('#sp-chart');
  chart.setAttribute('data-drillbucket', autoBucket(state.spend.bucket));
  chart.setAttribute('data-drillby', state.spend.by || '');
  if (d.series && d.series.length) {
    var lines = d.series.map(function (s, i) {
      return {
        label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
        points: s.points.map(function (p) { return { bucket: p.bucket, y: p.spend }; })
      };
    });
    var shown = lines.filter(function (l) { return !hidden[l.label]; });
    chart.innerHTML = groupedBarChart(d.buckets || [], shown, 'usd');
    $('#sp-legend').innerHTML = legendHtml(lines, hidden, function (l) { return l.label; }, function (l) { return usd(l.total); });
    wireLegend('#sp-legend', hidden, loadTotalSpend);
    var note = d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by spend. ' : '';
    note += 'Each bar is one cohort. Click a bar to see its sessions.';
    if (d.presenceInflated) note += ' Sessions can carry several values here, so the bars sum to more than total spend.';
    $('#sp-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.spend, filled: p.spend }; });
    chart.innerHTML = stackChart(d.buckets || [], barPts, 'usd');
    $('#sp-legend').innerHTML = '';
    $('#sp-note').innerHTML = esc('Spend per ' + autoBucket(state.spend.bucket) + ', dated at session start. Click a bar to see its sessions, or break down by a dimension to split it.');
  }
}
