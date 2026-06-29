// Total spend detail (the burn / spend-breakdown view): spend over time, with
// an optional split into one usage/session-grain cohort line per facet value.
import { state, $, esc, usd, SR_PALETTE, get, autoBucket, windowQs } from '../core'
import { valueLineChart, stackChart, stackedBarChart } from '../charts'
import { spendBreakdownFacets, filterRowHtml, wireFacetFilters, facetFilterQs } from '../facets'

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
    '<div class="sr-ctrl-row">' +
      '<span class="sr-by-ctrl"><span class="sr-lbl">Bucket</span><span class="seg" id="sp-bucket">' + bucketBtns + '</span></span>' +
      filterRowHtml('sp', state.spend.filters) +
      '<span class="sr-by-ctrl" style="margin-left:18px"><span class="sr-lbl">Break down by</span>' +
      '<select class="sr-by" id="sp-by">' + byOpts + '</select></span></div>';
  wireFacetFilters('sp', $('#sp-controls'), state.spend.filters, renderSpendControls, loadTotalSpend);
  Array.prototype.forEach.call($('#sp-bucket').children, function (btn) {
    btn.onclick = function () { state.spend.bucket = btn.getAttribute('data-b'); renderSpendControls(); loadTotalSpend(); };
  });
  $('#sp-by').onchange = function () { state.spend.by = this.value; loadTotalSpend(); };
}

export function loadTotalSpend(topK?) {
  var sp = state.spend;
  var qs = ['bucket=' + encodeURIComponent(autoBucket(sp.bucket))];
  if (sp.by) qs.push('by=' + encodeURIComponent(sp.by));
  if (topK) qs.push('topK=' + topK);
  get('/api/spend-over-time?' + qs.join('&') + windowQs() + facetFilterQs(sp.filters)).then(function (d) {
    if (!d || d.error) { $('#sp-chart').innerHTML = '<div class="empty">' + esc(d && d.error ? d.error : 'No data.') + '</div>'; return; }
    renderSpend(d);
  });
}

export function renderSpend(d) {
  var ov = d.overall || { total: 0, points: [] };
  if (d.series && d.series.length) {
    var series = d.series.map(function (s, i) {
      return {
        label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
        points: s.points.map(function (p) { return { bucket: p.bucket, y: p.spend }; })
      };
    });
    if (d.presenceInflated) {
      // Multi-valued facet: a session's spend counts under several values, so the
      // components over-sum the total — stacking would lie. Keep cohort lines.
      $('#sp-chart').innerHTML = valueLineChart(d.buckets || [], series, 'usd');
      $('#sp-legend').innerHTML = spendLegend(series);
      var noteL = (d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by spend. ' : '') +
        'Each line is one cohort. Sessions can carry several values here, so the lines sum to more than total spend.';
      $('#sp-note').innerHTML = esc(noteL);
    } else {
      // Components partition the bucket's spend → stack them. Add a muted "other"
      // segment for any top-K tail so the bars still reach the true total.
      var ovByB = {};
      (ov.points || []).forEach(function (p) { ovByB[p.bucket] = p.spend; });
      var shownByB = {};
      series.forEach(function (s) { s.points.forEach(function (p) { shownByB[p.bucket] = (shownByB[p.bucket] || 0) + p.y; }); });
      var otherPts = (d.buckets || []).map(function (b) { return { bucket: b, y: Math.max(0, (ovByB[b] || 0) - (shownByB[b] || 0)) }; });
      var otherTotal = otherPts.reduce(function (a, p) { return a + p.y; }, 0);
      var chart = series.slice();
      if (otherTotal > 0.005) chart.push({ label: 'other', color: '#cfc8b8', total: otherTotal, points: otherPts });
      $('#sp-chart').innerHTML = stackedBarChart(d.buckets || [], chart, 'usd');
      $('#sp-legend').innerHTML = spendLegend(chart);
      var noteB = (d.truncated ? 'Top ' + d.truncated.shown + ' of ' + d.truncated.total + '; the rest are grouped as “other”. ' : '') +
        'Each bar splits the bucket’s spend into components — hover a segment for its value.';
      $('#sp-note').innerHTML = esc(noteB);
    }
    if (d.truncated) {
      $('#sp-legend').innerHTML += ' <a class="show-all-link" data-total="' + d.truncated.total + '">Show all ' + d.truncated.total + '</a>';
      var spLink = $('#sp-legend .show-all-link');
      if (spLink) spLink.onclick = function () { loadTotalSpend(this.getAttribute('data-total')); };
    }
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.spend, filled: p.spend }; });
    $('#sp-chart').innerHTML = stackChart(d.buckets || [], barPts, 'usd');
    $('#sp-legend').innerHTML = '<span class="leg-overall">Total ' + esc(usd(ov.total)) + '</span>';
    $('#sp-note').innerHTML = esc('Spend per ' + autoBucket(state.spend.bucket) + ', dated at session start. Break down by a dimension to split it.');
  }
}

function spendLegend(series) {
  return series.map(function (l) {
    return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
      ' <span class="sr-cnt">' + usd(l.total) + '</span></span>';
  }).join('');
}
