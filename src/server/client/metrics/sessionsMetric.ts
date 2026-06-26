// Sessions detail: session count over time, optionally split into one cohort
// line per facet value.
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs, comboLabel } from '../core'
import { stackChart, stackedBarChart } from '../charts'
import { srBreakdownFacets, filterRowHtml, wireFacetFilters, facetFilterQs } from '../facets'

export function renderSessionsMetric() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Sessions</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="sm-controls"></div>' +
      '<div class="chart-title">Session Count</div>' +
      '<div id="sm-chart"></div>' +
      '<div class="sr-legend" id="sm-legend"></div>' +
      '<div class="card-note" id="sm-note"></div>' +
    '</div>';
  renderSmControls();
  loadSessionsOverTime();
}

export function renderSmControls() {
  var sm = state.sm;
  var activeBucket = autoBucket(sm.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var byOpts = '<option value="">none</option>';
  srBreakdownFacets().forEach(function (f) { // any chart/filter facet (counts explode safely)
    byOpts += '<option value="' + esc(f.key) + '"' + (f.key === sm.by ? ' selected' : '') + '>' + esc(f.label || f.key) + '</option>';
  });
  $('#sm-controls').innerHTML =
    '<div class="sr-ctrl-row">' +
      '<span class="sr-by-ctrl"><span class="sr-lbl">Bucket</span><span class="seg" id="sm-bucket">' + bucketBtns + '</span></span>' +
      filterRowHtml('sm', state.sm.filters) +
      '<span class="sr-by-ctrl" style="margin-left:18px"><span class="sr-lbl">Break down by</span>' +
      '<select class="sr-by" id="sm-by">' + byOpts + '</select></span></div>';
  wireFacetFilters('sm', $('#sm-controls'), state.sm.filters, renderSmControls, loadSessionsOverTime);
  Array.prototype.forEach.call($('#sm-bucket').children, function (btn) {
    btn.onclick = function () { state.sm.bucket = btn.getAttribute('data-b'); renderSmControls(); loadSessionsOverTime(); };
  });
  $('#sm-by').onchange = function () { state.sm.by = this.value; loadSessionsOverTime(); };
}

export function loadSessionsOverTime(topK?) {
  var sm = state.sm;
  var qs = ['bucket=' + encodeURIComponent(autoBucket(sm.bucket))];
  if (sm.by) qs.push('by=' + encodeURIComponent(sm.by));
  if (topK) qs.push('topK=' + topK);
  get('/api/sessions-over-time?' + qs.join('&') + windowQs() + facetFilterQs(sm.filters)).then(function (d) {
    if (!d || d.error) { $('#sm-chart').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderSm(d);
  });
}

export function renderSm(d) {
  var ov = d.overall || { total: 0, points: [] };
  if (d.series && d.series.length) {
    // Composite labels partition the sessions, so the breakdown stacks honestly:
    // bar height = total session count, each segment = one value combination.
    // Series arrive biggest-first (Other last) → biggest stacked at the bottom.
    var series = d.series.map(function (s, i) {
      var lab = comboLabel(s.key);
      return {
        // stackedBarChart reads `label` for its bar tooltip — give it the full set.
        label: lab.full, text: lab.text, full: lab.full, total: s.total,
        color: SR_PALETTE[i % SR_PALETTE.length],
        points: s.points.map(function (p) { return { bucket: p.bucket, y: p.count }; })
      };
    });
    $('#sm-chart').innerHTML = stackedBarChart(d.buckets || [], series, 'int', 'Sessions');
    $('#sm-legend').innerHTML = series.map(function (l) {
      return '<span class="leg" title="' + esc(l.full) + '"><span class="swatch" style="background:' + l.color + '"></span>' +
        esc(l.text) + ' <span class="sr-cnt">' + num(l.total) + '</span></span>';
    }).join('');
    var note = d.truncated
      ? 'Showing the top ' + d.truncated.shown + ' of ' + d.truncated.total +
        ' value combinations by session count; the rest are grouped as “... other values”. '
      : '';
    note += 'Each session is grouped by the set of values it used, so the segments partition the bar — its height is the total session count.';
    if (d.truncated) {
      $('#sm-legend').innerHTML += ' <a class="show-all-link" data-total="' + d.truncated.total + '">Show all ' + d.truncated.total + ' combinations</a>';
      var smLink = $('#sm-legend .show-all-link');
      if (smLink) smLink.onclick = function () { loadSessionsOverTime(this.getAttribute('data-total')); };
    }
    $('#sm-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.count, filled: p.count }; });
    $('#sm-chart').innerHTML = stackChart(d.buckets || [], barPts, 'int', 'Sessions');
    $('#sm-legend').innerHTML = '<span class="leg-overall">Total ' + num(ov.total) + ' sessions</span>';
    $('#sm-note').innerHTML = esc('Sessions started per ' + autoBucket(state.sm.bucket) + '. Break down by a dimension to split it.');
  }
}
