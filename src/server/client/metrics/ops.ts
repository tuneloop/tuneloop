// Operational metrics detail: three independent time-series graphs — tool-call
// counts, tool error rate, and skill-usage counts — sharing one bucket control,
// split across two tabs. The Tools tab shows error rate, the errors-by-category
// breakdown, then tool-call counts; the Skills tab shows skill-usage counts.
// Each graph can break down by tool/skill name on its own (same "Break down by"
// dropdown the other metric graphs use). Error rate reuses the percent line
// chart; counts use int bars (overall) or int lines (breakdown).
import { state, $, esc, num, dayOf, SR_PALETTE, get, autoBucket, windowQs } from '../core'
import { lineChart, valueLineChart } from '../charts'
import { filterByErrorCategory, startErrorWalk } from '../sessions'

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

function opsView(key) {
  for (var i = 0; i < OPS_VIEWS.length; i++) if (OPS_VIEWS[i].key === key) return OPS_VIEWS[i];
  return { key: key, title: key };
}

// One metric panel (chart + its own "break down by name" control + legend/note).
function opsPanel(v) {
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
}

function opsErrcatPanel() {
  return '<div class="panel"><div class="panel-head"><h2>Errors by category</h2></div>' +
    '<div class="errcat" id="ops-errcat"></div>' +
    '<div class="card-note">Count of failed tool calls per category (share of all errors), over the selected window. Hover a category for what it means.</div>' +
  '</div>';
}

export function renderOps() {
  var tab = state.ops.tab || 'tools';
  // Tools tab: error rate + category breakdown first, then tool-call counts.
  var toolsPane = opsPanel(opsView('error_rate')) + opsErrcatPanel() + opsPanel(opsView('tool_calls'));
  // Skills tab: skill-usage counts.
  var skillsPane = opsPanel(opsView('skill_usage'));
  $('#metric-detail').innerHTML =
    '<div class="metric-head"><h2>Operational Metrics</h2></div>' +
    '<div class="ops-controls" id="ops-controls"></div>' +
    '<div class="ops-tabpane" id="ops-tab-tools"' + (tab === 'tools' ? '' : ' hidden') + '>' + toolsPane + '</div>' +
    '<div class="ops-tabpane" id="ops-tab-skills"' + (tab === 'skills' ? '' : ' hidden') + '>' + skillsPane + '</div>';
  renderOpsControls();
  // All views live in the DOM regardless of active tab (cheap; tab switch just
  // toggles visibility), so wire + load every one up front.
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
      // Each category is an accordion: the bar + a collapsible occurrence list.
      // data-total is the true count (occurrences are capped → drives "+N more").
      return '<div class="errcat-item" data-cat="' + esc(key) + '" data-total="' + (row.value || 0) + '">' +
        '<div class="bar-row errcat-row" data-cat="' + esc(key) + '"><span class="name" title="' + esc(meta.description) + '">' + esc(meta.label) +
        '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="n"><span class="cnt">' + num(row.value) + '</span><span class="pct">' + share + '%</span></span></div>' +
        '<div class="errcat-occ" hidden></div></div>';
    }).join('');
    // Click a category → expand its actual failed tool calls (the occurrence list).
    Array.prototype.forEach.call(box.querySelectorAll('.errcat-row'), function (el) {
      el.onclick = function () { toggleOcc(el.parentNode, el.getAttribute('data-cat'), tips); };
    });
  }).catch(function () { box.innerHTML = '<div class="empty">Could not load error categories.</div>'; });
}

// Accordion: expand one category's occurrence list (single-open). Lazy-loads the
// failed tool calls on first open, then caches them on the panel.
function toggleOcc(item, cat, tips) {
  var panel = item.querySelector('.errcat-occ');
  if (!panel) return;
  var wasOpen = !panel.hidden;
  Array.prototype.forEach.call(document.querySelectorAll('#ops-errcat .errcat-occ'), function (p) {
    p.hidden = true; p.parentNode.querySelector('.errcat-row').classList.remove('open');
  });
  if (wasOpen) return; // toggle closed
  panel.hidden = false;
  item.querySelector('.errcat-row').classList.add('open');
  if (panel.getAttribute('data-loaded')) return;
  panel.innerHTML = '<div class="occ-loading">Loading…</div>';
  // True category total (the bar count); the occurrence list is capped, so renderOcc
  // shows a "+N more" note when total exceeds the fetched rows.
  var total = parseInt(item.getAttribute('data-total'), 10) || 0;
  get('/api/error-occurrences?category=' + encodeURIComponent(cat) + windowQs()).then(function (occ) {
    panel.setAttribute('data-loaded', '1');
    renderOcc(panel, cat, occ || [], tips, total);
  }).catch(function () {
    // Leave data-loaded unset so re-opening retries the fetch.
    panel.innerHTML = '<div class="occ-empty">Could not load occurrences.</div>';
  });
}

function renderOcc(panel, cat, occ, tips, total) {
  if (!occ.length) { panel.innerHTML = '<div class="occ-empty">No occurrences in this window.</div>'; return; }
  var label = (tips[cat] && tips[cat].label) || cat;
  var count = total || occ.length;             // the bar count is the true total; occ is capped
  var moreN = Math.max(0, count - occ.length); // occurrences beyond the fetched cap
  var head = '<div class="occ-head">' + count + ' occurrence' + (count > 1 ? 's' : '') +
    ' · <a class="occ-sessions" href="#">view sessions →</a></div>';
  var list = occ.map(function (o, i) {
    var cmd = o.command || o.targetPath || '';
    return '<div class="occ-row" data-i="' + i + '" title="click to open the transcript at this error">' +
      '<span class="occ-tool">' + esc(o.name) + '</span>' +
      '<span class="occ-cmd" title="' + esc(cmd) + '">' + esc(clip(cmd, 44)) + '</span>' +
      '<span class="occ-msg" title="' + esc(o.message || '') + '">' + esc(clip(o.message || '', 60)) + '</span>' +
      '<span class="occ-sess">' + esc(clip(o.title || '(untitled)', 22)) + '</span>' +
      '<span class="occ-date">' + esc(dayOf(o.startedAt || o.ts)) + '</span></div>';
  }).join('');
  var more = moreN ? '<div class="occ-more">+ ' + moreN + ' more (showing ' + occ.length + ')</div>' : '';
  panel.innerHTML = head + '<div class="occ-list">' + list + '</div>' + more;
  // Click an occurrence → open its transcript at that exact error + start the walk.
  Array.prototype.forEach.call(panel.querySelectorAll('.occ-row'), function (el) {
    el.onclick = function () { startErrorWalk(label, occ, parseInt(el.getAttribute('data-i'), 10)); };
  });
  var sl = panel.querySelector('.occ-sessions');
  if (sl) sl.onclick = function (e) { e.preventDefault(); filterByErrorCategory(cat); };
}

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function renderOpsControls() {
  var activeBucket = autoBucket(state.ops.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var activeTab = state.ops.tab || 'tools';
  var tabBtns = [['tools', 'Tools'], ['skills', 'Skills']].map(function (t) {
    return '<button class="' + (t[0] === activeTab ? 'on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>';
  }).join('');
  $('#ops-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="ops-bucket">' + bucketBtns + '</span>' +
    '<span class="sr-lbl">View</span><span class="seg" id="ops-tab">' + tabBtns + '</span></div>';
  Array.prototype.forEach.call($('#ops-bucket').children, function (btn) {
    btn.onclick = function () {
      state.ops.bucket = btn.getAttribute('data-b');
      renderOpsControls();
      OPS_VIEWS.forEach(function (v) { loadOps(v.key); }); // bucket is shared — reload all three
    };
  });
  // Tab switch only toggles pane visibility — every chart is already loaded.
  Array.prototype.forEach.call($('#ops-tab').children, function (btn) {
    btn.onclick = function () {
      state.ops.tab = btn.getAttribute('data-t');
      var isTools = state.ops.tab === 'tools';
      var tools = $('#ops-tab-tools'); if (tools) tools.hidden = !isTools;
      var skills = $('#ops-tab-skills'); if (skills) skills.hidden = isTools;
      renderOpsControls(); // refresh the 'on' highlight
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
