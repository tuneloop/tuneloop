// Total spend detail (the burn / spend-breakdown view): spend over time, with
// an optional split into one usage/session-grain cohort line per facet value.
import { state, $, esc, usd, SR_PALETTE, get } from '../core'
import { valueLineChart, stackChart } from '../charts'
import { spendBreakdownFacets } from '../facets'

export function renderTotalSpend() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Total spend</h2>' +
      '<div class="metric-big" id="sp-big">—</div>' +
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
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === sp.bucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
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
  var qs = ['bucket=' + encodeURIComponent(sp.bucket)];
  if (sp.by) qs.push('by=' + encodeURIComponent(sp.by));
  get('/api/spend-over-time?' + qs.join('&')).then(function (d) {
    if (!d || d.error) { $('#sp-chart').innerHTML = '<div class="empty">' + esc(d && d.error ? d.error : 'No data.') + '</div>'; return; }
    renderSpend(d);
  });
}

export function renderSpend(d) {
  var ov = d.overall || { total: 0, points: [] };
  var analysis = (state.overview && state.overview.analysisCostUsd) || 0;
  var big = $('#sp-big');
  if (big) big.innerHTML = usd(ov.total) +
    ' <span class="metric-sub">all time' + (analysis > 0 ? ' &middot; ' + usd(analysis) + ' analysis (enrichment)' : '') + '</span>';
  if (d.series && d.series.length) {
    var lines = d.series.map(function (s, i) {
      return {
        label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
        points: s.points.map(function (p) { return { bucket: p.bucket, y: p.spend }; })
      };
    });
    $('#sp-chart').innerHTML = valueLineChart(d.buckets || [], lines, 'usd');
    $('#sp-legend').innerHTML = lines.map(function (l) {
      return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
        ' <span class="sr-cnt">' + usd(l.total) + '</span></span>';
    }).join('');
    var note = d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by spend. ' : '';
    note += 'Each line is one cohort. Hover a point for that bucket spend.';
    if (d.presenceInflated) note += ' Sessions can carry several values here, so the lines sum to more than total spend.';
    $('#sp-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.spend, filled: p.spend }; });
    $('#sp-chart').innerHTML = stackChart(d.buckets || [], barPts, 'usd');
    $('#sp-legend').innerHTML = '';
    $('#sp-note').innerHTML = esc('Spend per ' + state.spend.bucket + ', dated at session start. Break down by a dimension to split it.');
  }
}
