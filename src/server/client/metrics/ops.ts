// Operational metrics detail: tool-call counts, error rate, and skill usage over
// time, optionally split by tool/skill name. Error rate reuses the percent line
// chart; counts use int bars (overall) or int lines (breakdown).
import { state, $, esc, num, SR_PALETTE, get } from '../core'
import { lineChart, valueLineChart, stackChart } from '../charts'

export function renderOps() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Operational</h2>' +
      '<div class="metric-big" id="ops-big">—</div>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="ops-controls"></div>' +
      '<div id="ops-chart"></div>' +
      '<div class="sr-legend" id="ops-legend"></div>' +
      '<div class="card-note" id="ops-note"></div>' +
    '</div>';
  renderOpsControls();
  loadOps();
}

export function renderOpsControls() {
  var op = state.ops;
  var views = [['tool_calls', 'Tool calls'], ['error_rate', 'Error rate'], ['skill_usage', 'Skill usage']].map(function (o) {
    return '<button class="' + (o[0] === op.view ? 'on' : '') + '" data-v="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === op.bucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var byBtns = [['', 'Total'], ['name', 'By name']].map(function (o) {
    var on = (o[0] === 'name') === !!op.by;
    return '<button class="' + (on ? 'on' : '') + '" data-y="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  $('#ops-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">View</span><span class="seg" id="ops-view">' + views + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Bucket</span><span class="seg" id="ops-bucket">' + bucketBtns + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Breakdown</span><span class="seg" id="ops-by">' + byBtns + '</span></div>';
  Array.prototype.forEach.call($('#ops-view').children, function (btn) {
    btn.onclick = function () { state.ops.view = btn.getAttribute('data-v'); renderOpsControls(); loadOps(); };
  });
  Array.prototype.forEach.call($('#ops-bucket').children, function (btn) {
    btn.onclick = function () { state.ops.bucket = btn.getAttribute('data-b'); renderOpsControls(); loadOps(); };
  });
  Array.prototype.forEach.call($('#ops-by').children, function (btn) {
    btn.onclick = function () { state.ops.by = btn.getAttribute('data-y') === 'name'; renderOpsControls(); loadOps(); };
  });
}

export function loadOps() {
  var op = state.ops;
  var qs = 'view=' + encodeURIComponent(op.view) + '&bucket=' + encodeURIComponent(op.bucket) + (op.by ? '&by=name' : '');
  get('/api/ops-over-time?' + qs).then(function (d) {
    if (!d || d.error) { $('#ops-chart').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderOpsChart(d);
  });
}

export function renderOpsChart(d) {
  var ov = d.overall || { total: null, points: [] };
  var big = $('#ops-big');
  if (big) {
    var bv = d.format === 'pct' ? (ov.total != null ? Math.round(ov.total * 100) + '%' : '—') : num(ov.total || 0);
    var lbl = d.view === 'error_rate' ? 'tool-call error rate' : (d.view === 'skill_usage' ? 'skill calls' : 'tool calls');
    big.innerHTML = esc(bv) + ' <span class="metric-sub">' + esc(lbl) + ', all time</span>';
  }
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
    $('#ops-chart').innerHTML = lineChart(d.buckets || [], rlines);
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
      $('#ops-chart').innerHTML = valueLineChart(d.buckets || [], clines, 'int');
      legend = clines.map(function (l) {
        return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
          ' <span class="sr-cnt">' + num(l.total) + '</span></span>';
      }).join('');
    } else {
      var barPts = ov.points.map(function (p) { return { bucket: p.bucket, total: p.value, filled: p.value }; });
      $('#ops-chart').innerHTML = stackChart(d.buckets || [], barPts, 'int');
    }
    note = (d.view === 'skill_usage' ? 'Skill invocations' : 'Tool calls') + ' per bucket, dated at session start.';
  }
  if (d.truncated) note = 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by call volume. ' + note;
  $('#ops-legend').innerHTML = legend;
  $('#ops-note').innerHTML = esc(note);
}
