// Operational metrics detail: three independent time-series graphs — tool-call
// counts, tool error rate, and skill-usage counts — sharing one bucket control.
// Each graph can break down by tool/skill name on its own (same "Break down by"
// dropdown the other metric graphs use). Error rate reuses the percent line
// chart; counts use int bars (overall) or int lines (breakdown).
import { state, $, esc, num, SR_PALETTE, get, autoBucket, windowQs } from '../core'
import { lineChart, valueLineChart } from '../charts'
import { filterByErrorCategory } from '../sessions'

// Per-view, in-memory line show/hide (keyed by tool/skill name), like the
// outcome chart's legend. Reset on every load (new query); preserved across
// legend clicks, which only re-paint. Each of the three graphs hides its own.
var opsHidden = { tool_calls: {}, error_rate: {}, skill_usage: {} };

var OPS_VIEWS = [
  { key: 'tool_calls', title: 'Tool Call Counts' },
  { key: 'error_rate', title: 'Tool error rate' },
  { key: 'skill_usage', title: 'Skill Usage Count' }
];

function opsByLabel(view) { return view === 'skill_usage' ? 'skill name' : 'tool name'; }

// Y-axis caption per graph: a percent error axis, or a count axis named for what
// it counts.
function opsYLabel(view, fmt) {
  return fmt === 'pct' ? 'Error rate' : view === 'skill_usage' ? 'Skill invocations' : 'Tool calls';
}

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
    panels +
    '<div class="panel"><div class="panel-head"><h2>Errors by category</h2></div>' +
      '<div class="errcat" id="ops-errcat"></div>' +
      '<div class="card-note">Count of failed tool calls per category (share of all errors), over the selected window. Hover a category for what it means.</div>' +
    '</div>';
  renderOpsControls();
  OPS_VIEWS.forEach(function (v) {
    var sel = $('#ops-by-' + v.key);
    if (sel) sel.onchange = function () { state.ops.by[v.key] = this.value === 'name'; loadOps(v.key); };
    loadOps(v.key);
  });
  loadErrorCats();
}

// Cached taxonomy metadata (key -> {label, description}) for the category tooltips.
var errorCatTips = null;

// Dedicated widget: error COUNT per category (a rate-by-category has no honest
// denominator — categories exist only on failed rows), scoped to the window.
export function loadErrorCats() {
  var box = $('#ops-errcat');
  if (!box) return;
  var tipsP = errorCatTips
    ? Promise.resolve(errorCatTips)
    : get('/api/error-categories').then(function (cats) {
        errorCatTips = {};
        (cats || []).forEach(function (c) { errorCatTips[c.key] = c; });
        return errorCatTips;
      });
  Promise.all([tipsP, get('/api/breakdown?measure=error_count&by=error_category' + windowQs())]).then(function (r) {
    var tips = r[0] || {}, d = r[1] || {};
    if (d.error) { box.innerHTML = '<div class="empty">Could not load error categories.</div>'; return; }
    var rows = d.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="empty">No tool-call errors.</div>'; return; }
    var total = d.total || 0;
    var max = rows[0].value || 1; // rows arrive sorted by value DESC
    box.innerHTML = rows.map(function (row) {
      var key = row.bucket == null ? 'other' : row.bucket;
      var meta = tips[key] || { label: key, description: '' };
      var pct = max ? Math.round((row.value / max) * 100) : 0;
      var share = total ? Math.round((row.value / total) * 100) : 0;
      return '<div class="bar-row errcat-row" data-cat="' + esc(key) + '"><span class="name" title="' + esc(meta.description) + '">' + esc(meta.label) +
        '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="n"><span class="cnt">' + num(row.value) + '</span><span class="pct">' + share + '%</span></span></div>';
    }).join('');
    // Click a row → Sessions list filtered to that category, in the current window.
    Array.prototype.forEach.call(box.querySelectorAll('.errcat-row'), function (el) {
      el.onclick = function () { filterByErrorCategory(this.getAttribute('data-cat')); };
    });
  }).catch(function () { box.innerHTML = '<div class="empty">Could not load error categories.</div>'; });
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
  opsHidden[view] = {}; // a new query may have a different set of lines — start all-visible
  var qs = 'view=' + encodeURIComponent(view) + '&bucket=' + encodeURIComponent(autoBucket(state.ops.bucket)) + (by ? '&by=name' : '') + windowQs();
  if (topK) qs += '&topK=' + topK;
  get('/api/ops-over-time?' + qs).then(function (d) {
    if (!d || d.error) { $('#ops-chart-' + view).innerHTML = '<div class="empty">No data.</div>'; return; }
    renderOpsChart(view, d);
  });
}

// Draw (or re-draw) a breakdown graph + legend from opsHidden[view]. Hidden
// lines drop out of the chart (the y-axis rescales to what's left) and grey out
// in the legend. fmt selects the line renderer + legend value (pct rate vs int
// count). Each `line` carries {key,label,color,points,total/rate}.
function paintOps(view, d, lines, fmt) {
  var hidden = opsHidden[view];
  var visible = lines.filter(function (l) { return !hidden[l.key]; });
  var yLabel = opsYLabel(view, fmt);
  $('#ops-chart-' + view).innerHTML = fmt === 'pct'
    ? lineChart(d.buckets || [], visible, { adaptive: true }, yLabel)
    : valueLineChart(d.buckets || [], visible, 'int', yLabel);
  var anyHidden = lines.some(function (l) { return hidden[l.key]; });
  var legend = lines.map(function (l) {
    var val = fmt === 'pct'
      ? (l.rate != null ? ' <span class="sr-cnt">' + Math.round(l.rate * 100) + '%</span>' : '')
      : ' <span class="sr-cnt">' + num(l.total) + '</span>';
    return '<span class="leg' + (hidden[l.key] ? ' off' : '') + '" data-key="' + esc(l.key) + '" title="' + esc(l.label) + '">' +
      '<span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) + val + '</span>';
  }).join('');
  // Master toggle (de-select all / restore) — only worth showing with many lines.
  if (lines.length > 5) {
    legend += ' <a class="leg-toggle-all" data-act="' + (anyHidden ? 'show' : 'hide') + '">' +
      (anyHidden ? 'Show all' : 'Hide all') + '</a>';
  }
  if (d.truncated) {
    legend += ' <a class="show-all-link" data-view="' + view + '" data-total="' + d.truncated.total + '">Show all ' +
      d.truncated.total + '</a>';
  }
  $('#ops-legend-' + view).innerHTML = legend;
  Array.prototype.forEach.call(document.querySelectorAll('#ops-legend-' + view + ' .leg'), function (el) {
    el.onclick = function () {
      var k = this.getAttribute('data-key');
      if (hidden[k]) delete hidden[k]; else hidden[k] = 1;
      paintOps(view, d, lines, fmt);
    };
  });
  var allBtn = $('#ops-legend-' + view + ' .leg-toggle-all');
  if (allBtn) allBtn.onclick = function () {
    if (this.getAttribute('data-act') === 'hide') lines.forEach(function (l) { hidden[l.key] = 1; });
    else opsHidden[view] = {};
    paintOps(view, d, lines, fmt);
  };
  var showAll = $('#ops-legend-' + view + ' .show-all-link');
  if (showAll) showAll.onclick = function () { loadOps(this.getAttribute('data-view'), this.getAttribute('data-total')); };
}

export function renderOpsChart(view, d) {
  var ov = d.overall || { total: null, points: [] };
  var note = '';
  var hasBreakdown = d.series && d.series.length;
  if (d.format === 'pct') {
    // Error rate → percent line chart (reusing the success-rate renderer).
    if (hasBreakdown) {
      var rlines = d.series.map(function (s, i) {
        return { key: s.key, label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], rate: s.total,
          points: s.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }) };
      });
      paintOps(view, d, rlines, 'pct'); // interactive legend (hide/show lines)
    } else {
      var oline = [{ label: 'error rate', color: SR_PALETTE[2],
        points: ov.points.map(function (p) { return { bucket: p.bucket, rate: p.value, num: p.errors, denom: p.calls }; }), rate: ov.total }];
      $('#ops-chart-' + view).innerHTML = lineChart(d.buckets || [], oline, { adaptive: true }, opsYLabel(view, 'pct'));
      $('#ops-legend-' + view).innerHTML = '<span class="leg"><span class="swatch" style="background:' + oline[0].color + '"></span>error rate' +
        (oline[0].rate != null ? ' <span class="sr-cnt">' + Math.round(oline[0].rate * 100) + '%</span>' : '') + '</span>';
    }
    note = 'Error rate = errored tool calls / all tool calls, dated at session start.';
  } else {
    // Counts → int bars (overall) / int lines (breakdown).
    if (hasBreakdown) {
      var clines = d.series.map(function (s, i) {
        return { key: s.key, label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], total: s.total,
          points: s.points.map(function (p) { return { bucket: p.bucket, y: p.value }; }) };
      });
      paintOps(view, d, clines, 'int'); // interactive legend (hide/show lines)
    } else {
      // A single line (not bars), to match the error-rate overall and the
      // breakdown lines — count graphs stay lines throughout.
      var lbl = d.view === 'skill_usage' ? 'skill invocations' : 'tool calls';
      var cline = [{ label: lbl, color: SR_PALETTE[0],
        points: ov.points.map(function (p) { return { bucket: p.bucket, y: p.value }; }) }];
      $('#ops-chart-' + view).innerHTML = valueLineChart(d.buckets || [], cline, 'int', opsYLabel(view, 'int'));
      $('#ops-legend-' + view).innerHTML = '<span class="leg"><span class="swatch" style="background:' + SR_PALETTE[0] +
        '"></span>' + esc(lbl) + ' <span class="sr-cnt">' + num(ov.total) + '</span></span>';
    }
    note = (d.view === 'skill_usage' ? 'Skill invocations' : 'Tool calls') + ' per bucket, dated at session start.';
  }
  if (d.truncated) note = 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' by call volume. ' + note;
  $('#ops-note-' + view).innerHTML = esc(note);
}
