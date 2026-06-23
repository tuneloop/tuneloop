// Total spend detail (the burn / spend-breakdown view): spend over time, with
// an optional split into one usage/session-grain cohort line per facet value.
import { state, $, esc, usd, SR_PALETTE, get, autoBucket, windowQs, modeSegHtml, legItem } from '../core'
import { valueLineChart, stackChart, groupedBarChart } from '../charts'
import { spendBreakdownFacets } from '../facets'
import { wireChartPick } from '../chartHover'
import { filterByFacet } from '../sessions'

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
      '<select class="sr-by" id="sp-by">' + byOpts + '</select>' +
      '<span class="sr-lbl" style="margin-left:18px">View</span>' + modeSegHtml(state.spend.mode, 'sp-mode') + '</div>';
  Array.prototype.forEach.call($('#sp-bucket').children, function (btn) {
    btn.onclick = function () { state.spend.bucket = btn.getAttribute('data-b'); renderSpendControls(); loadTotalSpend(); };
  });
  $('#sp-by').onchange = function () { state.spend.by = this.value; loadTotalSpend(); };
  Array.prototype.forEach.call($('#sp-mode').children, function (btn) {
    btn.onclick = function () { state.spend.mode = btn.getAttribute('data-m') as 'grouped' | 'line'; renderSpendControls(); loadTotalSpend(); };
  });
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
  if (d.series && d.series.length) {
    var all = d.series.map(function (s, i) {
      return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total, raw: s };
    });
    var series = all.filter(function (s) { return !state.spend.hidden[s.label]; }).map(function (s) {
      return { label: s.label, color: s.color, total: s.total,
        points: s.raw.points.map(function (p) { return { bucket: p.bucket, v: p.spend }; }) };
    });
    if (state.spend.mode === 'line') {
      var lines = series.map(function (s) { return { label: s.label, color: s.color, total: s.total, points: s.points.map(function (p) { return { bucket: p.bucket, y: p.v }; }) }; });
      $('#sp-chart').innerHTML = valueLineChart(d.buckets || [], lines, 'usd');
    } else {
      $('#sp-chart').innerHTML = groupedBarChart(d.buckets || [], series, 'usd');
    }
    $('#sp-legend').innerHTML = all.map(function (l) {
      return legItem(l.label, l.color, ' <span class="sr-cnt">' + usd(l.total) + '</span>', !!state.spend.hidden[l.label]);
    }).join('');
    wireSpendLegend(d);
    var note = d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by spend. ' : '';
    note += state.spend.mode === 'line' ? 'Each line is one cohort. Click a point for that bucket’s sessions.'
      : 'Each bar cluster is one cohort. Click a bar for that bucket’s sessions.';
    if (d.presenceInflated) note += ' Sessions can carry several values here, so the series sum to more than total spend.';
    $('#sp-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.spend, filled: p.spend }; });
    $('#sp-chart').innerHTML = stackChart(d.buckets || [], barPts, 'usd');
    $('#sp-legend').innerHTML = '';
    $('#sp-note').innerHTML = esc('Spend per ' + autoBucket(state.spend.bucket) + ', dated at session start. Click a bar for its sessions, or break down by a dimension to split it.');
  }
  wireSpendPick(d);
}

function wireSpendLegend(d) {
  Array.prototype.forEach.call($('#sp-legend').querySelectorAll('.leg[data-leg]'), function (el) {
    el.onclick = function () {
      var label = el.getAttribute('data-leg');
      state.spend.hidden[label] = !state.spend.hidden[label];
      renderSpend(d);
    };
  });
}

function wireSpendPick(d) {
  wireChartPick($('#sp-chart'), function (pick) {
    var bucket = autoBucket(state.spend.bucket);
    var by = state.spend.by;
    filterByFacet(by || null, by ? pick.seriesLabel : null, bucket, pick.bucket);
  });
}
