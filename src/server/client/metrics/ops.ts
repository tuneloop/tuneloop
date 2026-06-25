// Operational metrics detail: three independent time-series graphs — tool-call
// counts, tool error rate, and skill-usage counts — sharing one bucket control.
// Each graph can break down by tool/skill name on its own (same "Break down by"
// dropdown the other metric graphs use). Error rate reuses the percent line
// chart; counts use int bars (overall) or int lines (breakdown).
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs } from '../core'
import { lineChart, valueLineChart, stackChart } from '../charts'

var OPS_VIEWS = [
  { key: 'tool_calls', title: 'Tool Call Counts' },
  { key: 'error_rate', title: 'Tool error rate' },
  { key: 'skill_usage', title: 'Skill Usage Count' }
];

function opsByLabel(view) { return view === 'skill_usage' ? 'skill name' : 'tool name'; }

export function renderOps() {
  var panels = OPS_VIEWS.map(function (v) {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>' + esc(v.title) + '</h2>' +
        '<span class="sr-by-ctrl"><span class="sr-lbl">Break down by</span>' +
        '<select class="sr-by" id="ops-by-' + v.key + '">' +
          '<option value="">none</option>' +
          '<option value="name"' + (state.ops.by[v.key] ? ' selected' : '') + '>' + esc(opsByLabel(v.key)) + '</option>' +
        '</select></span>' +
      '</div>' +
      '<div id="ops-chart-' + v.key + '"></div>' +
      '<div class="sr-legend" id="ops-legend-' + v.key + '"></div>' +
      '<div class="card-note" id="ops-note-' + v.key + '"></div>' +
    '</div>';
  }).join('');
  $('#metric-detail').innerHTML =
    '<div class="metric-head"><h2>Operational Metrics</h2></div>' +
    '<div class="ops-controls" id="ops-controls"></div>' +
    panels;
  renderOpsControls();
  OPS_VIEWS.forEach(function (v) {
    var sel = $('#ops-by-' + v.key);
    if (sel) sel.onchange = function () { state.ops.by[v.key] = this.value === 'name'; loadOps(v.key); };
    loadOps(v.key);
  });
}

export function renderOpsControls() {
  var activeBucket = autoBucket(state.ops.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  $('#ops-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="ops-bucket">' + bucketBtns + '</span></div>';
  Array.prototype.forEach.call($('#ops-bucket').children, function (btn) {
    btn.onclick = function () {
      state.ops.bucket = btn.getAttribute('data-b');
      renderOpsControls();
      OPS_VIEWS.forEach(function (v) { loadOps(v.key); }); // bucket is shared — reload all three
    };
  });
}

export function loadOps(view, topK?) {
  var by = state.ops.by[view];
  var qs = 'view=' + encodeURIComponent(view) + '&bucket=' + encodeURIComponent(autoBucket(state.ops.bucket)) + (by ? '&by=name' : '') + windowQs();
  if (topK) qs += '&topK=' + topK;
  get('/api/ops-over-time?' + qs).then(function (d) {
    if (!d || d.error) { $('#ops-chart-' + view).innerHTML = '<div class="empty">No data.</div>'; return; }
    renderOpsChart(view, d);
  });
}

export function renderOpsChart(view, d) {
  var ov = d.overall || { total: null, points: [] };
  var legend = '', note = '';
  if (d.format === 'pct') {
    // Error rate → percent line chart (reusing the success-rate renderer).
    var rlines;
    if (d.series && d.series.length) {
      rlines = d.series.map(function (s, i) {
        return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], rate: s.total,
          points: s.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }) };
      });
    } else {
      rlines = [{ label: 'error rate', color: SR_PALETTE[2],
        points: ov.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }), rate: ov.total }];
    }
    $('#ops-chart-' + view).innerHTML = lineChart(d.buckets || [], rlines, { adaptive: true });
    legend = rlines.map(function (l) {
      return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
        (l.rate != null ? ' <span class="sr-cnt">' + Math.round(l.rate * 100) + '%</span>' : '') + '</span>';
    }).join('');
    note = 'Error rate = errored tool calls / all tool calls, dated at session start.';
  } else {
    // Counts → int bars (overall) / int lines (breakdown).
    if (d.series && d.series.length) {
      var clines = d.series.map(function (s, i) {
        return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
          points: s.points.map(function (p) { return { bucket: p.bucket, y: p.value }; }) };
      });
      $('#ops-chart-' + view).innerHTML = valueLineChart(d.buckets || [], clines, 'int');
      legend = clines.map(function (l) {
        return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
          ' <span class="sr-cnt">' + num(l.total) + '</span></span>';
      }).join('');
    } else {
      var barPts = ov.points.map(function (p) { return { bucket: p.bucket, total: p.value, filled: p.value }; });
      $('#ops-chart-' + view).innerHTML = stackChart(d.buckets || [], barPts, 'int');
    }
    note = (d.view === 'skill_usage' ? 'Skill invocations' : 'Tool calls') + ' per bucket, dated at session start.';
  }
  if (d.truncated) {
    note = 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by call volume. ' + note;
    legend += ' <a class="show-all-link" data-view="' + view + '" data-total="' + d.truncated.total + '">Show all ' + d.truncated.total + '</a>';
  }
  $('#ops-legend-' + view).innerHTML = legend;
  $('#ops-note-' + view).innerHTML = esc(note);
  var showAll = $('#ops-legend-' + view + ' .show-all-link');
  if (showAll) showAll.onclick = function () { loadOps(this.getAttribute('data-view'), this.getAttribute('data-total')); };
}
