// Sessions detail: session count over time, optionally split into one cohort
// line per facet value.
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs, modeSegHtml, legItem } from '../core'
import { valueLineChart, stackChart, groupedBarChart } from '../charts'
import { srBreakdownFacets } from '../facets'
import { wireChartPick } from '../chartHover'
import { filterByFacet } from '../sessions'

export function renderSessionsMetric() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Sessions</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="sm-controls"></div>' +
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
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="sm-bucket">' + bucketBtns + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Break down by</span>' +
      '<select class="sr-by" id="sm-by">' + byOpts + '</select>' +
      '<span class="sr-lbl" style="margin-left:18px">View</span>' + modeSegHtml(state.sm.mode, 'sm-mode') + '</div>';
  Array.prototype.forEach.call($('#sm-bucket').children, function (btn) {
    btn.onclick = function () { state.sm.bucket = btn.getAttribute('data-b'); renderSmControls(); loadSessionsOverTime(); };
  });
  $('#sm-by').onchange = function () { state.sm.by = this.value; loadSessionsOverTime(); };
  Array.prototype.forEach.call($('#sm-mode').children, function (btn) {
    btn.onclick = function () { state.sm.mode = btn.getAttribute('data-m') as 'grouped' | 'line'; renderSmControls(); loadSessionsOverTime(); };
  });
}

export function loadSessionsOverTime() {
  var sm = state.sm;
  var qs = ['bucket=' + encodeURIComponent(autoBucket(sm.bucket))];
  if (sm.by) qs.push('by=' + encodeURIComponent(sm.by));
  get('/api/sessions-over-time?' + qs.join('&') + windowQs()).then(function (d) {
    if (!d || d.error) { $('#sm-chart').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderSm(d);
  });
}

export function renderSm(d) {
  var ov = d.overall || { total: 0, points: [] };
  if (d.series && d.series.length) {
    var all = d.series.map(function (s, i) {
      return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total, raw: s };
    });
    var series = all.filter(function (s) { return !state.sm.hidden[s.label]; }).map(function (s) {
      return { label: s.label, color: s.color, total: s.total,
        points: s.raw.points.map(function (p) { return { bucket: p.bucket, v: p.count }; }) };
    });
    if (state.sm.mode === 'line') {
      var lines = series.map(function (s) { return { label: s.label, color: s.color, total: s.total, points: s.points.map(function (p) { return { bucket: p.bucket, y: p.v }; }) }; });
      $('#sm-chart').innerHTML = valueLineChart(d.buckets || [], lines, 'int');
    } else {
      $('#sm-chart').innerHTML = groupedBarChart(d.buckets || [], series, 'int');
    }
    $('#sm-legend').innerHTML = all.map(function (l) {
      return legItem(l.label, l.color, ' <span class="sr-cnt">' + num(l.total) + '</span>', !!state.sm.hidden[l.label]);
    }).join('');
    wireSmLegend(d);
    var note = d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by session count. ' : '';
    note += state.sm.mode === 'line' ? 'Each line is one cohort. Click a point for that bucket’s sessions.'
      : 'Each bar cluster is one cohort. Click a bar for that bucket’s sessions.';
    if (d.presenceInflated) note += ' A session can fall under several values here, so the series sum to more than total sessions.';
    $('#sm-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.count, filled: p.count }; });
    $('#sm-chart').innerHTML = stackChart(d.buckets || [], barPts, 'int');
    $('#sm-legend').innerHTML = '';
    $('#sm-note').innerHTML = esc('Sessions started per ' + autoBucket(state.sm.bucket) + '. Click a bar for its sessions, or break down by a dimension to split it.');
  }
  wireSmPick(d);
}

function wireSmLegend(d) {
  Array.prototype.forEach.call($('#sm-legend').querySelectorAll('.leg[data-leg]'), function (el) {
    el.onclick = function () {
      var label = el.getAttribute('data-leg');
      state.sm.hidden[label] = !state.sm.hidden[label];
      renderSm(d);
    };
  });
}

function wireSmPick(d) {
  wireChartPick($('#sm-chart'), function (pick) {
    var bucket = autoBucket(state.sm.bucket);
    var by = state.sm.by;
    filterByFacet(by || null, by ? pick.seriesLabel : null, bucket, pick.bucket);
  });
}
