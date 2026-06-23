// Sessions detail: session count over time, optionally split into one cohort
// line per facet value.
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs } from '../core'
import { valueLineChart, stackChart } from '../charts'
import { srBreakdownFacets } from '../facets'

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
      '<select class="sr-by" id="sm-by">' + byOpts + '</select></div>';
  Array.prototype.forEach.call($('#sm-bucket').children, function (btn) {
    btn.onclick = function () { state.sm.bucket = btn.getAttribute('data-b'); renderSmControls(); loadSessionsOverTime(); };
  });
  $('#sm-by').onchange = function () { state.sm.by = this.value; loadSessionsOverTime(); };
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
    var lines = d.series.map(function (s, i) {
      return {
        label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
        points: s.points.map(function (p) { return { bucket: p.bucket, y: p.count }; })
      };
    });
    $('#sm-chart').innerHTML = valueLineChart(d.buckets || [], lines, 'int');
    $('#sm-legend').innerHTML = lines.map(function (l) {
      return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
        ' <span class="sr-cnt">' + num(l.total) + '</span></span>';
    }).join('');
    var note = d.truncated ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by session count. ' : '';
    note += 'Each line is one cohort. Hover a point for that bucket count.';
    if (d.presenceInflated) note += ' A session can fall under several values here, so the lines sum to more than total sessions.';
    $('#sm-note').innerHTML = esc(note);
  } else {
    var barPts = (ov.points || []).map(function (p) { return { bucket: p.bucket, total: p.count, filled: p.count }; });
    $('#sm-chart').innerHTML = stackChart(d.buckets || [], barPts, 'int');
    $('#sm-legend').innerHTML = '';
    $('#sm-note').innerHTML = esc('Sessions started per ' + autoBucket(state.sm.bucket) + '. Break down by a dimension to split it.');
  }
}
