// Operational metrics detail: three independent time-series graphs — skill
// usage, tool-call counts, and tool error rate — sharing one bucket control.
// Skill usage sits on top: it's the more outcome-relevant signal. Each graph can
// break down by tool/skill name on its own and pick a Bars (grouped) or Lines
// renderer for the breakdown. Error rate defaults to a line (rates read better
// as lines); the count views default to grouped bars.
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs, modeSegHtml, legItem } from '../core'
import { lineChart, valueLineChart, stackChart, groupedBarChart } from '../charts'
import { wireChartPick } from '../chartHover'
import { filterByFacet } from '../sessions'

var OPS_VIEWS = [
  { key: 'skill_usage', title: 'Skill Usage Count' },
  { key: 'tool_calls', title: 'Tool Call Counts' },
  { key: 'error_rate', title: 'Tool error rate' }
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
        '<span class="sr-lbl" style="margin-left:14px">View</span>' + modeSegHtml(state.ops.mode[v.key] || 'grouped', 'ops-mode-' + v.key) +
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
    var modeSeg = $('#ops-mode-' + v.key);
    if (modeSeg) Array.prototype.forEach.call(modeSeg.children, function (btn) {
      btn.onclick = function () { state.ops.mode[v.key] = btn.getAttribute('data-m') as 'grouped' | 'line'; loadOps(v.key); };
    });
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

export function loadOps(view) {
  var by = state.ops.by[view];
  var qs = 'view=' + encodeURIComponent(view) + '&bucket=' + encodeURIComponent(autoBucket(state.ops.bucket)) + (by ? '&by=name' : '') + windowQs();
  get('/api/ops-over-time?' + qs).then(function (d) {
    if (!d || d.error) { $('#ops-chart-' + view).innerHTML = '<div class="empty">No data.</div>'; return; }
    renderOpsChart(view, d);
  });
}

export function renderOpsChart(view, d) {
  var ov = d.overall || { total: null, points: [] };
  var legend = '', note = '';
  var mode = state.ops.mode[view] || 'grouped';
  var hidden = state.ops.hidden[view] || (state.ops.hidden[view] = {});
  var visSeries = (d.series || []).filter(function (s) { return !hidden[s.key]; });
  var allSeries = d.series || [];
  if (d.format === 'pct') {
    // Error rate → percent axis. Breakdown honors the per-view mode (line by
    // default); overall is a single rate line.
    if (allSeries.length) {
      if (mode === 'line') {
        var rlines = visSeries.map(function (s, i) {
          return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], rate: s.total,
            points: s.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }) };
        });
        $('#ops-chart-' + view).innerHTML = lineChart(d.buckets || [], rlines, { adaptive: true });
      } else {
        var rseries = visSeries.map(function (s, i) {
          return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], rate: s.total,
            points: s.points.map(function (p) { return { bucket: p.bucket, v: p.value, sub: p.errors + '/' + p.calls }; }) };
        });
        $('#ops-chart-' + view).innerHTML = groupedBarChart(d.buckets || [], rseries, 'pct', { adaptive: true });
      }
      legend = allSeries.map(function (s, i) {
        return legItem(s.key, SR_PALETTE[i % SR_PALETTE.length], s.total != null ? ' <span class="sr-cnt">' + Math.round(s.total * 100) + '%</span>' : '', !!hidden[s.key]);
      }).join('');
    } else {
      var rline = [{ label: 'error rate', color: SR_PALETTE[2],
        points: ov.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }), rate: ov.total }];
      $('#ops-chart-' + view).innerHTML = lineChart(d.buckets || [], rline, { adaptive: true });
    }
    note = 'Error rate = errored tool calls / all tool calls, dated at session start.';
  } else {
    // Counts → int bars (overall) / grouped bars or int lines (breakdown).
    if (allSeries.length) {
      if (mode === 'line') {
        var clines = visSeries.map(function (s, i) {
          return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
            points: s.points.map(function (p) { return { bucket: p.bucket, y: p.value }; }) };
        });
        $('#ops-chart-' + view).innerHTML = valueLineChart(d.buckets || [], clines, 'int');
      } else {
        var cseries = visSeries.map(function (s, i) {
          return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
            points: s.points.map(function (p) { return { bucket: p.bucket, v: p.value }; }) };
        });
        $('#ops-chart-' + view).innerHTML = groupedBarChart(d.buckets || [], cseries, 'int');
      }
      legend = allSeries.map(function (s, i) {
        return legItem(s.key, SR_PALETTE[i % SR_PALETTE.length], ' <span class="sr-cnt">' + num(s.total) + '</span>', !!hidden[s.key]);
      }).join('');
    } else {
      var barPts = ov.points.map(function (p) { return { bucket: p.bucket, total: p.value, filled: p.value }; });
      $('#ops-chart-' + view).innerHTML = stackChart(d.buckets || [], barPts, 'int');
    }
    note = (d.view === 'skill_usage' ? 'Skill invocations' : 'Tool calls') + ' per bucket, dated at session start.';
  }
  if (d.truncated) note = 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by call volume. ' + note;
  $('#ops-legend-' + view).innerHTML = legend;
  $('#ops-note-' + view).innerHTML = esc(note);
  wireOpsLegend(view, d);
  wireOpsPick(view);
}

// Legend toggle per ops graph (re-renders that graph from its cached payload).
function wireOpsLegend(view, d) {
  Array.prototype.forEach.call($('#ops-legend-' + view).querySelectorAll('.leg[data-leg]'), function (el) {
    el.onclick = function () {
      var hidden = state.ops.hidden[view] || (state.ops.hidden[view] = {});
      var label = el.getAttribute('data-leg');
      hidden[label] = !hidden[label];
      renderOpsChart(view, d);
    };
  });
}

// Click a bucket → sessions in that bucket (ops "by name" isn't a session facet,
// so the drill is date-only).
function wireOpsPick(view) {
  wireChartPick($('#ops-chart-' + view), function (pick) {
    filterByFacet(null, null, autoBucket(state.ops.bucket), pick.bucket);
  });
}
