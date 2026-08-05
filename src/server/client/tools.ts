// MCP / Agent tools tab: two rosters — MCP servers and built-in tools (with shell
// binaries promoted to their own rows) — each opening a full per-entity DETAIL
// PAGE routed at #/tools/<kind>/<name>.
//
// This tab is organized around ERRORS and what to do about them. Deferred tool
// loading means an unused MCP server costs little context, so unused/scope-down
// are quiet hygiene chips; the pills that earn attention are `high-error` and
// `degrading`. It deliberately makes no per-call cost claim (tokens aren't
// attributable to a tool call — see src/server/tool-health.ts).
//
// All DOM classes are `th-`-prefixed or borrowed from the shared health tokens
// (`sk-`, see health-ui.ts), and every handler is wired by querying WITHIN this
// tab's container — never a global querySelectorAll — so the Sessions tab's
// global handlers can't clobber them (and vice-versa).
import { state, $, esc, num, get, dayOf } from './core';
import { syncHash } from './router';
import { openDetail, startErrorWalk } from './sessions';
import {
  fact, pageTile, rateChart, sectHead, sourceLabel, sparkline, TIME_PRESETS,
  trendChart, trendGranLabel, wireTrendTooltip, windowPhrase,
} from './health-ui';
import { filterRows, isToolSelected, rollupTail } from './tools-roster';

// Cached roster, keyed on the window+source it was fetched for. A window change
// refetches; an unchanged window repaints from cache.
var tlReport = null;
var tlReportKey = null;
// Roster controls (client-side, over the cached rows):
//   tlStatus '' = the kind's default view | 'all' | a status | a flag key
//   tlSearch = case-insensitive substring on the entity name
var tlStatus = '';
var tlSearch = '';
// The built-in roster rolls its shell long-tail into one row; this expands it.
var tlShowAllShell = false;
// The open detail page's payload, keyed `<kind> <name>` so a stale response for a
// page the user has already left is ignored.
var tlDetail = null;
var tlDetailKey = null;

// The two sub-rosters. `mcp` has an install side (status + hygiene chips); `builtin`
// has none — there is nothing to install or remove, so it carries error pills only.
var KINDS = [
  { k: 'mcp', l: 'MCP servers', full: 'MCP servers the agent called, and any installed but unused' },
  { k: 'builtin', l: 'Built-in tools', full: 'Built-in tools and the shell binaries they ran' }
];

// Status presentation for MCP rows. Unused is GREY, not red: with deferred tool
// loading an unused server is a hygiene note, not a failure — the red is reserved
// for the error pills, which are what this tab is for.
var STATUS = {
  used: { label: 'Used', color: 'var(--emerald)', tip: 'Called at least once in the window.' },
  unused: { label: 'Unused', color: 'var(--gray)', tip: 'Installed but not called in the window.' }
};

// Flags: the hero pills first, then the quiet hygiene chips.
var FLAGS = {
  'high-error': { label: 'High error', color: 'var(--red)', hero: true, tip: 'At least a fifth of its calls failed, over enough calls to be a pattern.' },
  degrading: { label: 'Degrading', color: 'var(--amber)', hero: true, tip: 'Its error rate is materially worse in the recent half of this window than the earlier half.' },
  unused: { label: 'Unused', color: 'var(--gray)', tip: 'Installed but never called in this window.' },
  'scope-down': { label: 'Scope down', color: 'var(--amber)', tip: 'Global, but used in only a few repos — a candidate to move into just those.' },
  'not-in-config': { label: 'Not in config', color: '#3b6ea5', tip: 'Seen running, but not in any current config snapshot.' }
};
function hasFlag(r, f) { return (r.flags || []).indexOf(f) >= 0; }

// The chip tooltip for one flag on one row — the error pills carry their own
// evidence (the actual rates), so the pill is never a bare assertion.
function flagTip(r, f) {
  var fl = FLAGS[f];
  if (f === 'high-error' && r.calls) {
    var base = pct(r.errorCalls / r.calls) + ' of ' + num(r.calls) + ' calls failed';
    return r.dominantErrorCategory
      ? base + ', ' + (r.dominantErrorShare >= 0.5 ? 'mostly ' : 'most often ') + r.dominantErrorCategory + '.'
      : base + '.';
  }
  if (f === 'degrading' && r.recentErrorRate != null) {
    return 'Error rate went from ' + pct(r.priorErrorRate || 0) + ' to ' + pct(r.recentErrorRate) + ' across this window.';
  }
  if (f === 'scope-down' && r.scopeToRepos && r.scopeToRepos.length) {
    return 'Only used in: ' + r.scopeToRepos.join(', ') + '. Consider scoping it there so the rest stop loading it.';
  }
  return fl ? fl.tip : '';
}

function pct(x) { return Math.round((x || 0) * 100) + '%'; }

// The API query fragment for the current window (+ source, when one is chosen).
function tlWinQuery() {
  var q = (state.toolWin === 'custom' && state.toolFrom && state.toolTo)
    ? 'from=' + encodeURIComponent(new Date(state.toolFrom).toISOString()) +
      '&to=' + encodeURIComponent(new Date(state.toolTo + 'T23:59:59').toISOString())
    : 'days=' + encodeURIComponent(state.toolWin === 'all' ? 'all' : String(state.toolWin));
  if (state.toolSource) q += '&source=' + encodeURIComponent(state.toolSource);
  return q;
}

function winPhrase(presetPrefix, allTime) {
  return windowPhrase(tlReport && tlReport.windowDays, presetPrefix, allTime, state.toolFrom, state.toolTo);
}

// A signature that changes whenever the fetched data would differ — the cache key.
function tlWinKey() {
  var win = state.toolWin === 'custom' ? 'custom:' + state.toolFrom + ':' + state.toolTo : String(state.toolWin);
  return win + '|' + (state.toolSource || '');
}

// The tools screen's URL query slice: the window (30d default, omitted) + source.
export function getToolParams(): Record<string, string> {
  var q: Record<string, string> = {};
  if (state.toolWin === 'custom') {
    if (state.toolFrom) q.from = state.toolFrom;
    if (state.toolTo) q.to = state.toolTo;
  } else if (state.toolWin === 'all') q.win = 'all';
  else if (state.toolWin !== 30) q.win = String(state.toolWin);
  if (state.toolSource) q.source = state.toolSource;
  // Only meaningful on an open entity page; on the roster it would be stale state.
  if (state.tool && state.toolFilter) q.tool = state.toolFilter;
  return q;
}

// Restore the window from a URL query (router → state).
export function applyToolWin(query: Record<string, string>) {
  var win = query && query.win;
  if (query && (query.from || query.to)) {
    state.toolWin = 'custom';
    state.toolFrom = query.from || '';
    state.toolTo = query.to || '';
  } else if (win === 'all') state.toolWin = 'all';
  else if (win === '7' || win === '14' || win === '90') state.toolWin = parseInt(win, 10);
  else state.toolWin = 30;
  state.toolSource = (query && query.source) || '';
  state.toolFilter = (query && query.tool) || '';
}

// Called once from main.ts to pre-render the tab. Safe to call again; repaints
// from cache when the window is unchanged.
export function renderTools() {
  var box = $('#tool-health');
  if (!box) return;
  if (tlReport && tlReportKey === tlWinKey()) { paintTools(); return; }
  loadTools();
}

function loadTools() {
  var box = $('#tool-health');
  if (!box) return;
  var want = tlWinKey();
  box.innerHTML = '<div class="sk-empty">Loading tool health…</div>';
  get('/api/tool-health?' + tlWinQuery()).then(function (d) {
    if (tlWinKey() !== want) return; // window changed while in flight
    tlReport = d || { mcp: { rows: [] }, builtin: { rows: [] } };
    tlReportKey = want;
    paintTools();
  }).catch(function () {
    if (tlWinKey() !== want) return;
    box.innerHTML = '<div class="sk-empty">Could not load tool health.</div>';
  });
}

/**
 * Open an entity's detail page, or return to a roster when `name` is null.
 * `kind` picks the sub-roster. Called by the router and by row/back/sub-tab clicks.
 */
export function openTool(kind, name, query?) {
  if (query) applyToolWin(query);
  var nextKind = kind === 'builtin' ? 'builtin' : 'mcp';
  if (nextKind !== state.toolKind) { tlStatus = ''; tlShowAllShell = false; } // each roster has its own default view
  // A tool filter belongs to one server's page; carrying it to another entity (or
  // back to the roster) would silently narrow a page that never asked for it.
  if (!query && name !== state.tool) state.toolFilter = '';
  state.toolKind = nextKind;
  state.tool = name || null;
  syncHash();
  if (state.tool) window.scrollTo(0, 0);
  if (!tlReport || tlReportKey !== tlWinKey()) loadTools();
  else paintTools();
}

function setToolWin(win) {
  state.toolWin = win;
  syncHash();
  if (win === 'custom' && (!state.toolFrom || !state.toolTo)) { paintTools(); return; }
  loadTools();
}

// Switch the harness. Refetches — a different source is an entirely different
// roster, so an open detail page for an entity that source never used is dropped.
function setToolSource(source) {
  state.toolSource = source;
  state.tool = null;
  syncHash();
  loadTools();
}

function section(d) { return (d && d[state.toolKind]) || { rows: [] }; }

function paintTools() {
  var box = $('#tool-health');
  if (!box || !tlReport) return;
  var d = tlReport;

  var anyRows = (d.mcp && d.mcp.rows.length) || (d.builtin && d.builtin.rows.length);
  if (!anyRows) {
    box.innerHTML =
      '<div class="panel sk-panel"><div class="panel-head"><h2>MCP/Tools</h2></div>' +
      '<div class="sk-empty">No tool calls in this window. Widen the time filter, or run <code>tuneloop analyze</code> to ingest more sessions.</div></div>';
    return;
  }

  if (state.tool) { paintToolPage(box, state.tool); return; }
  paintRoster(box, d);
}

/**
 * The two rosters are one dataset seen two ways, so they get the segmented control
 * the Artifacts tab already uses for section scoping — not a tab row.
 *
 * Earlier passes made this a corner control (missable), then the heading (read as a
 * title with badges), then sub-tabs — but sub-tabs repeated the top nav's own
 * language a row below it, leaving no cue which level you were on. A filled pill
 * group shares no shape with a tab, so the emerald underline stays unambiguously
 * "which page", and this stays "which half of the page".
 */
function kindSeg() {
  return '<div class="seg seg-primary th-kinds">' + KINDS.map(function (k) {
    var on = k.k === state.toolKind;
    return '<button type="button"' + (on ? ' class="on"' : '') + ' data-k="' + k.k + '"' +
      ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(k.full) + '">' +
      esc(k.l) + '</button>';
  }).join('') + '</div>';
}

function paintRoster(box, d) {
  box.innerHTML =
    '<div class="panel sk-panel">' +
      kindSeg() +
      '<div class="sk-overview" id="th-overview"></div>' +
      '<div class="th-overall" id="th-overall"></div>' +
      '<div class="filters sk-filters" id="th-filters"></div>' +
      '<div class="sk-roster" id="th-roster"></div>' +
      '<div class="th-roster-note" id="th-roster-note"></div>' +
    '</div>';

  Array.prototype.forEach.call(box.querySelectorAll('.th-kinds button'), function (b) {
    b.onclick = function () { openTool(this.getAttribute('data-k'), null); };
  });

  renderOverview(d);
  renderOverallTrend(d);
  renderFilters(d);
  renderRoster(section(d).rows || []);
  renderRosterNote(d);
}

// Summary strip: the window's totals, each a one-click filter (kept in sync with
// the Status dropdown via the shared tlStatus). Error pills lead — they're the
// point of the tab — and the exceptional states appear only when non-zero.
function renderOverview(d) {
  var bar = $('#th-overview');
  if (!bar) return;
  var s = section(d);
  var mcp = state.toolKind === 'mcp';
  var stats = mcp
    ? [{ k: 'all', v: s.rows.length, l: 'Servers', tip: 'MCP servers installed or seen running in this window.' },
       { k: '', v: s.totalUsed, l: 'Used', tip: STATUS.used.tip },
       { k: 'unused', v: s.totalUnused, l: 'Unused', tip: STATUS.unused.tip }]
    : [{ k: '', v: s.rows.length, l: 'Tools', tip: 'Built-in tools and shell binaries called in this window.' }];
  stats.push({ k: 'high-error', v: s.totalHighError, l: 'High error', tip: FLAGS['high-error'].tip });
  if (s.totalDegrading > 0) stats.push({ k: 'degrading', v: s.totalDegrading, l: 'Degrading', tip: FLAGS.degrading.tip });

  bar.innerHTML = stats.map(function (x) {
    var on = x.k === tlStatus;
    // The error pills read in their own colour so a non-zero count is visible
    // before you read the label — the roster's whole reason to exist.
    var hero = x.k === 'high-error' || x.k === 'degrading';
    return '<button type="button" class="sk-stat' + (on ? ' on' : '') + (hero && x.v > 0 ? ' th-stat-hero' : '') +
      '" data-k="' + esc(x.k) + '" title="' + esc(x.tip) + '">' +
      '<span class="sk-stat-v">' + num(x.v || 0) + '</span>' +
      '<span class="sk-stat-l">' + esc(x.l) + '</span>' +
      '</button>';
  }).join('');

  Array.prototype.forEach.call(bar.querySelectorAll('.sk-stat'), function (el) {
    el.onclick = function () { tlStatus = this.getAttribute('data-k'); paintTools(); };
  });
}

// The overall error-rate trend above the roster — the one surviving job of the
// old Metrics → Ops tool charts, now on tool-run time like everything else here.
function renderOverallTrend(d) {
  var host = $('#th-overall');
  if (!host) return;
  var calls = d.overallCallSpark || [];
  var total = calls.reduce(function (a, b) { return a + b; }, 0);
  if (!total) { host.innerHTML = ''; return; }
  var errs = (d.overallErrorSpark || []).reduce(function (a, b) { return a + b; }, 0);
  host.innerHTML =
    '<div class="sk-card th-overall-card">' +
      sectHead('Error rate over time', 'Every tool call this harness made, bucketed by when the call ran. Each bar is that bucket\'s failed calls over its total calls.') +
      '<div class="sk-trend" id="th-overall-trend">' + rateChart(d.overallErrorSpark, calls, d.sparkBuckets) + '</div>' +
      '<div class="sk-sect-note">' + num(errs) + ' of ' + num(total) + ' calls failed ' +
        esc(winPhrase('in the last ', 'across your full history')) + ' (' + pct(total ? errs / total : 0) + ' overall), per ' +
        trendGranLabel(d.sparkBuckets) + '. Hover a bar for its exact split.</div>' +
    '</div>';
  wireTrendTooltip($('#th-overall-trend'));
}

function renderFilters(d) {
  var bar = $('#th-filters');
  if (!bar) return;
  var mcp = state.toolKind === 'mcp';

  var segBtns = TIME_PRESETS.map(function (p) {
    return '<button type="button" data-d="' + p.d + '"' +
      (String(p.d) === String(state.toolWin) ? ' class="on"' : '') + '>' + p.l + '</button>';
  }).join('');

  // MCP defaults to Used (an unused server is hygiene, not today's problem);
  // built-ins have no unused state, so their default is simply everything.
  var opts = mcp
    ? [['', 'Used (default)'], ['all', 'All statuses'], ['unused', 'Unused'], ['high-error', 'High error'],
       ['degrading', 'Degrading'], ['scope-down', 'Scope down'], ['not-in-config', 'Not in config']]
    : [['', 'All tools'], ['high-error', 'High error'], ['degrading', 'Degrading']];
  var statusOpts = opts.map(function (o) {
    return '<option value="' + esc(o[0]) + '"' + (o[0] === tlStatus ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
  }).join('');

  var sources = (d && d.availableSources) || [];
  var sourceGrp = '';
  if (sources.length > 1) {
    var sourceOpts = sources.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === d.source ? ' selected' : '') + '>' + esc(sourceLabel(s)) + '</option>';
    }).join('');
    sourceGrp = '<span class="flt-grp"><span class="flt-lbl">Agent</span><select id="th-source">' + sourceOpts + '</select></span>';
  }

  bar.innerHTML =
    '<div class="flt-row">' +
      '<span class="flt-grp"><span class="flt-lbl">Time</span>' +
        '<div class="seg flt-seg" id="th-time">' + segBtns + '</div>' +
        '<span class="flt-dates" id="th-dates"' + (state.toolWin === 'custom' ? '' : ' hidden') + '>' +
          '<input type="date" id="th-from" value="' + esc(state.toolFrom) + '" />' +
          '<span class="flt-dash">→</span>' +
          '<input type="date" id="th-to" value="' + esc(state.toolTo) + '" />' +
        '</span>' +
      '</span>' +
      '<input id="th-search" class="flt-search" placeholder="' + (mcp ? 'search server name' : 'search tool or binary') + '" value="' + esc(tlSearch) + '" />' +
      '<span class="flt-grp"><span class="flt-lbl">Status</span><select id="th-status">' + statusOpts + '</select></span>' +
      sourceGrp +
    '</div>';

  Array.prototype.forEach.call(bar.querySelectorAll('#th-time button'), function (b) {
    b.onclick = function () {
      var v = this.getAttribute('data-d');
      setToolWin(v === 'all' || v === 'custom' ? v : parseInt(v, 10));
    };
  });
  var from = $('#th-from'), to = $('#th-to');
  if (from) from.onchange = function () { state.toolFrom = this.value; setToolWin('custom'); };
  if (to) to.onchange = function () { state.toolTo = this.value; setToolWin('custom'); };
  $('#th-status').onchange = function () { tlStatus = this.value; paintTools(); };
  var srcSel = $('#th-source');
  if (srcSel) srcSel.onchange = function () { setToolSource(this.value); };

  var t;
  $('#th-search').oninput = function () {
    var v = this.value;
    clearTimeout(t);
    t = setTimeout(function () { tlSearch = v; renderRoster(section(tlReport).rows || []); }, 150);
  };
}

function renderRoster(rows) {
  var host = $('#th-roster');
  if (!host) return;
  var shown = filterRows(rows, state.toolKind, tlStatus, tlSearch);
  if (!shown.length) {
    var msg = tlStatus === '' && !tlSearch
      ? (state.toolKind === 'mcp'
          ? 'No MCP servers were called in this window. Widen the window, or pick a status above to see installed-but-unused servers.'
          : 'No built-in tools were called in this window.')
      : 'Nothing matches this view.';
    host.innerHTML = '<div class="sk-empty">' + msg + '</div>';
    return;
  }
  // The shell long tail folds into one row so the tools that matter stay visible.
  // Only in the default view: once you've filtered or searched, you asked for
  // exactly these rows and hiding some of them would be a lie about the result.
  var tail = [];
  if (state.toolKind === 'builtin' && !tlSearch && !tlStatus && !tlShowAllShell) {
    tail = rollupTail(shown);
    if (tail.length) {
      var rolled = {};
      tail.forEach(function (r) { rolled[r.name] = 1; });
      shown = shown.filter(function (r) { return !rolled[r.name]; });
    }
  }

  host.innerHTML = shown.map(toolRow).join('') + (tail.length ? rollupRow(tail) : '') +
    (tlShowAllShell ? '<div class="th-rollup-back"><a id="th-collapse">collapse the shell long tail</a></div>' : '');

  Array.prototype.forEach.call(host.querySelectorAll('.sk-row-head'), function (el) {
    el.onclick = function () { openTool(state.toolKind, this.getAttribute('data-name')); };
  });
  var roll = host.querySelector('#th-rollup');
  if (roll) roll.onclick = function () { tlShowAllShell = true; paintTools(); };
  var collapse = host.querySelector('#th-collapse');
  if (collapse) collapse.onclick = function () { tlShowAllShell = false; paintTools(); };
}

// The "other shell" row: the tail's totals, expandable. Not a link to a detail
// page — it isn't an entity, it's a count of the ones we folded away, so it names
// them in its tooltip rather than pretending to be one thing.
function rollupRow(tail) {
  var calls = 0, errors = 0;
  tail.forEach(function (r) { calls += r.calls; errors += r.errorCalls; });
  var shownNames = tail.slice(0, 12).map(function (r) { return r.name; }).join(', ');
  var names = tail.length > 12 ? shownNames + ', +' + num(tail.length - 12) + ' more' : shownNames;
  return '<div class="sk-row">' +
    '<div class="sk-row-head th-rollup" id="th-rollup" title="' + esc(names) + '">' +
      '<span class="sk-dot th-dot-none"></span>' +
      '<span class="sk-name th-rollup-name">' + num(tail.length) + ' more shell binaries</span>' +
      '<span class="sk-flags"></span>' +
      '<span class="sk-spark"></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(calls) + '</span><span class="sk-ml">calls</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">—</span><span class="sk-ml">sessions</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + (calls ? pct(errors / calls) : '—') + '</span><span class="sk-ml">errors</span></span>' +
      '<span class="sk-caret">+</span>' +
    '</div>' +
    '</div>';
}

/**
 * The note under the built-in roster. It states the two things about these
 * numbers that would otherwise mislead: a compound command counts toward every
 * binary it involved (so the rows don't sum), and shell calls that named no
 * binary belong to no row at all.
 */
function renderRosterNote(d) {
  var host = $('#th-roster-note');
  if (!host) return;
  if (state.toolKind !== 'builtin') { host.innerHTML = ''; return; }
  var s = section(d);
  var note = 'Shell binaries are counted per call that <em>involved</em> them — <code>npm ci &amp;&amp; npm test | tee log</code> ' +
    'counts toward <code>npm</code> and <code>tee</code>, so these rows deliberately don\'t sum to your total shell calls.';
  if (s.unlabeledShellCalls > 0) {
    note += ' A further ' + num(s.unlabeledShellCalls) + ' shell ' + (s.unlabeledShellCalls === 1 ? 'call' : 'calls') +
      ' ran no binary of their own (<code>cd</code>, a bare redirect) and appear in no row.';
  }
  host.innerHTML = note;
}

/**
 * The calls-metric tooltip. For a shell binary the number is "calls that INVOLVED
 * this binary", not "calls of it" — a compound command counts toward each binary
 * in its chain, so the label has to say so or the roster reads as double-counting.
 */
function callsTip(r) {
  var base = r.shell
    ? num(r.calls) + ' shell ' + (r.calls === 1 ? 'call' : 'calls') + ' involved ' + r.name
    : num(r.calls) + ' ' + (r.calls === 1 ? 'call' : 'calls');
  return r.sidechainCalls > 0 ? base + ' · ' + num(r.sidechainCalls) + ' via subagents' : base;
}

function toolRow(r) {
  var s = r.status ? (STATUS[r.status] || STATUS.unused) : null;
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(flagTip(r, f)) + '">' + esc(fl.label) + '</span>' : '';
  }).join('');
  var errRate = r.calls > 0 ? pct(r.errorCalls / r.calls) : '—';
  return '<div class="sk-row">' +
    '<div class="sk-row-head" data-name="' + esc(r.name) + '"' + (s ? ' title="' + esc(s.tip) + '"' : '') + '>' +
      (s ? '<span class="sk-dot" style="background:' + s.color + '"></span>' : '<span class="sk-dot th-dot-none"></span>') +
      '<span class="sk-name">' + esc(r.name) + '</span>' +
      (r.shell ? '<span class="th-kind-chip" title="A binary run through the shell, promoted out of Bash commands.">shell</span>' : '') +
      (r.repoLocal ? '<span class="th-kind-chip" title="Invoked by repo-relative path — this project\'s own script.">repo script</span>' : '') +
      '<span class="sk-flags">' + chips + '</span>' +
      '<span class="sk-spark">' + sparkline(r.spark) + '</span>' +
      '<span class="sk-metric" title="' + esc(callsTip(r)) + '">' +
        '<span class="sk-mv">' + num(r.calls) + '</span><span class="sk-ml">' + (r.shell ? 'involving' : 'calls') + '</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.sessions) + '</span><span class="sk-ml">sessions</span></span>' +
      '<span class="sk-metric' + (hasFlag(r, 'high-error') ? ' th-metric-bad' : '') + '"><span class="sk-mv">' + errRate + '</span><span class="sk-ml">errors</span></span>' +
      '<span class="sk-caret">›</span>' +
    '</div>' +
    '</div>';
}

// ---- Per-entity detail page -------------------------------------------------

// The detail page is served whole by /api/tool-health-detail (its headline row is
// literally the roster's row, so the two can't disagree). Paints a loading frame,
// then the page; a response for a page we've navigated away from is dropped.
function paintToolPage(box, name) {
  var key = state.toolKind + ' ' + name + ' ' + (state.toolFilter || '');
  if (tlDetail && tlDetailKey === key + '|' + tlWinKey()) { renderToolPage(box, tlDetail); return; }
  box.innerHTML = '<div class="sk-page-head"><button class="sk-back" id="th-back">← All tools</button></div>' +
    '<div class="sk-empty">Loading ' + esc(name) + '…</div>';
  var back = box.querySelector('#th-back');
  if (back) back.onclick = function () { openTool(state.toolKind, null); };

  get('/api/tool-health-detail?kind=' + encodeURIComponent(state.toolKind) + '&name=' + encodeURIComponent(name) +
      (state.toolFilter ? '&tool=' + encodeURIComponent(state.toolFilter) : '') + '&' + tlWinQuery())
    .then(function (d) {
      if (state.tool !== name) return;
      if (!d) { // the entity has nothing in this window (a stale link, or a narrowed window)
        state.tool = null;
        syncHash({ replace: true });
        paintTools();
        return;
      }
      // The server may have declined the filter (a tool it never called); trust its
      // answer so the control and the numbers agree.
      state.toolFilter = d.tool || '';
      tlDetail = d;
      tlDetailKey = state.toolKind + ' ' + name + ' ' + (state.toolFilter || '') + '|' + tlWinKey();
      renderToolPage($('#tool-health'), d);
    })
    .catch(function () {
      var b = $('#tool-health');
      if (b) b.innerHTML = '<div class="sk-empty">Could not load this tool.</div>';
    });
}

function renderToolPage(box, d) {
  if (!box) return;
  var r = d.row;
  var mcp = d.kind === 'mcp';
  var s = r.status ? (STATUS[r.status] || STATUS.unused) : null;
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag sk-flag-lg" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(flagTip(r, f)) + '">' + esc(fl.label) + '</span>' : '';
  }).join('');
  var accent = hasFlag(r, 'high-error') ? 'var(--red)' : hasFlag(r, 'degrading') ? 'var(--amber)' : s ? s.color : 'var(--emerald)';

  var html = '<div class="sk-page-head"><button class="sk-back" id="th-back">← All tools</button></div>';
  html += '<div class="sk-page-title">' +
    (s ? '<span class="sk-dot sk-dot-lg" style="background:' + s.color + '"></span>' : '') +
    '<h2 class="sk-page-name">' + esc(r.name) + '</h2>' +
    (s ? '<span class="sk-verdict sk-verdict-lg" style="color:' + s.color + '" title="' + esc(s.tip) + '">' + esc(s.label) + '</span>' : '') +
    (r.shell ? '<span class="th-kind-chip">shell</span>' : '') +
    (r.repoLocal ? '<span class="th-kind-chip" title="Invoked by repo-relative path — this project\'s own script.">repo script</span>' : '') +
    chips +
    '</div>';

  // The scope control goes above the numbers it scopes.
  html += toolChips(d);

  // And it still says so in words next to them — a scoped page that looks unscoped
  // is how you end up quoting a tool's error rate as a server's. The All chip is
  // the way back, so this no longer carries a clear button of its own.
  if (d.tool) {
    html += '<div class="th-scoped">Every number below is <strong>' + esc(toolLabelOf(d, d.tool)) +
      '</strong> only, not all of ' + esc(r.name) + '.</div>';
  }

  // Headline stats. Empty-result rate is its OWN tile, never folded into the error
  // rate: a call that succeeds and returns nothing is a different problem.
  var winSub = winPhrase('in the last ', 'over all time');
  var callsSub = (r.shell ? 'shell calls involving ' + r.name + ', ' : '') + winSub;
  if (r.sidechainCalls > 0) callsSub += ' · ' + num(r.sidechainCalls) + ' via subagents';
  html += '<div class="sk-page-tiles">' +
    pageTile(num(r.calls), r.shell ? 'Calls involving it' : 'Calls', callsSub) +
    pageTile(num(r.sessions), 'Sessions', 'distinct sessions it ran in') +
    pageTile(r.calls > 0 ? pct(r.errorCalls / r.calls) : '—', 'Error rate',
      r.calls > 0 ? num(r.errorCalls) + ' of ' + num(r.calls) + ' calls failed' : 'no calls to measure') +
    pageTile(r.emptyEligibleCalls > 0 ? pct(r.emptyCalls / r.emptyEligibleCalls) : '—', 'Empty results',
      r.emptyEligibleCalls > 0
        ? num(r.emptyCalls) + ' of ' + num(r.emptyEligibleCalls) + ' successful calls returned nothing'
        : 'not a retrieval tool — empty output is success here') +
    '</div>';

  html += '<div class="sk-advice" style="border-left-color:' + accent + '">' + esc(d.advice) + '</div>';

  // The LLM "Suggested fix" card. Only high-error entities ever get one, and only
  // when an LLM provider was configured for the analyze run, so the section stays
  // hidden until we know one exists rather than showing an empty promise.
  html += '<div class="sk-card th-fix-card" id="th-fix" style="display:none"></div>';

  // Error-rate trend, then the categories behind it.
  if (r.calls > 0) {
    html += '<div class="sk-card">' +
      sectHead('Error rate over time', 'Each bar is that bucket\'s failed calls over its total calls, dated by when the call ran.') +
      '<div class="sk-trend" id="th-trend">' + rateChart(r.errorSpark, r.spark, d.sparkBuckets) + '</div>' +
      '<div class="sk-sect-note">Per ' + trendGranLabel(d.sparkBuckets) + ', ' +
        esc(winPhrase('over the last ', 'across your full history')) + '. Hover a bar for the calls behind it.</div>' +
      '</div>';
  }

  if (d.errorCategories && d.errorCategories.length) {
    html += '<div class="sk-card">' +
      sectHead('Errors by category', 'What its failures were, fingerprinted into a shared taxonomy. Open one to see the actual failed calls and step through them in the transcripts.') +
      // `errcat` is load-bearing, not decorative: the widget's column widths,
      // the count/share separation, and the row's pointer + hover states are all
      // scoped under it. Without it the count and the share collide ("5" + "42%"
      // reads as "542%").
      '<div class="errcat" id="th-errcat"></div>' +
      '</div>';
  }

  if (d.perRepo && d.perRepo.length) {
    html += '<div class="sk-card">' +
      '<div class="sk-sect-h">Where it\'s used</div>' + repoBreakdown(d.perRepo, accent) + '</div>';
  }

  // Details grid.
  html += '<div class="sk-card"><div class="sk-sect-h">Details</div><div class="sk-facts">';
  if (mcp) {
    html += fact('Install scope', r.installed ? (d.details.scope === 'global' ? 'Global' : 'Project') : 'Not installed (seen running)');
    if (d.details.sourceFiles && d.details.sourceFiles.length) html += fact('Declared in', d.details.sourceFiles.join(', '));
    if (d.details.installedRepos && d.details.installedRepos.length) html += fact('Installed in', d.details.installedRepos.join(', '));
    if (d.details.type) html += fact('Transport', d.details.type);
    if (d.details.url) html += fact('URL', d.details.url);
  } else {
    html += fact('Kind', r.shell ? 'Shell binary' : 'Built-in tool');
  }
  if (r.calls > 0) {
    html += fact('First used', r.firstUsedAt ? String(r.firstUsedAt).slice(0, 10) : '—');
    html += fact('Last used', r.lastUsedAt ? String(r.lastUsedAt).slice(0, 10) : '—');
  }
  html += '</div></div>';

  if (d.sessions && d.sessions.length) {
    var listed = d.sessions.reduce(function (a, g) { return a + g.calls; }, 0);
    // One ordering rule, stated once and applied at both levels.
    var note = 'Sessions where it failed come first, then most recent — and the same inside each ' +
      'session. Click a session to see its calls; each one opens the transcript at that call.';
    if (d.sessions.length < r.sessions) {
      note += ' Showing ' + num(d.sessions.length) + ' of ' + num(r.sessions) + ' sessions (' +
        num(listed) + ' of ' + num(r.calls) + ' calls).';
    }
    html += '<div class="sk-card">' +
      '<div class="sk-sect-h">Calls</div>' +
      '<div class="sk-sect-note">' + esc(note) + '</div>' +
      '<div class="th-calls" id="th-calls">' + d.sessions.map(sessionGroupRow).join('') + '</div>' +
      '</div>';
  }

  box.innerHTML = html;

  var back = box.querySelector('#th-back');
  if (back) back.onclick = function () { openTool(state.toolKind, null); };
  if (r.calls > 0) wireTrendTooltip(box.querySelector('#th-trend'));
  // The suggested-fix card is written about the SERVER's failures, so its numbers
  // would contradict a narrowed page. Show it only unnarrowed.
  if (!d.tool) loadFixCard(d);
  wireCallGroups(box);
  if (d.errorCategories && d.errorCategories.length) renderErrorCats(box, d);

  // The chips are the page's only tool filter; All carries the empty name.
  Array.prototype.forEach.call(box.querySelectorAll('.th-chip'), function (el) {
    el.onclick = function () { setToolFilter(this.getAttribute('data-raw')); };
  });

  // Restore after layout rather than inline: the page has just been rebuilt, and a
  // scroll set against a not-yet-laid-out document gets clamped to whatever height
  // the browser thinks it has at that instant.
  if (keepScroll != null) {
    var y = keepScroll;
    keepScroll = null;
    requestAnimationFrame(function () { window.scrollTo(0, y); });
  }
}

/**
 * Fetch and reveal the LLM advice card. Stays hidden on null (no card drafted) or
 * on error — an empty "Suggested fix" heading would read as a broken feature
 * rather than as "nothing to say here".
 */
function loadFixCard(d) {
  get('/api/tool-error-advice?kind=' + encodeURIComponent(d.kind) + '&name=' + encodeURIComponent(d.name) + '&' + tlWinQuery())
    .then(function (a) {
      if (!a || state.tool !== d.name) return;
      var host = $('#th-fix');
      if (!host) return;
      var stamp = a.generatedAt ? ' · drafted ' + dayOf(a.generatedAt) : '';
      host.innerHTML =
        sectHead('Suggested fix', 'Written by reading the full error text of these failures — not the 200-character summaries stored for the roster. Check it before pasting: it is a draft from the evidence, not a verified fix.') +
        (a.diagnosis ? '<div class="th-fix-diag">' + esc(a.diagnosis) + '</div>' : '') +
        (a.snippet
          ? '<div class="th-fix-snip"><div class="th-fix-snip-head">' +
              '<span>Paste into your agent instructions (CLAUDE.md or equivalent)</span>' +
              '<button type="button" class="ins-btn th-fix-copy">Copy</button></div>' +
              '<pre class="th-fix-pre">' + esc(a.snippet) + '</pre></div>'
          : '<div class="sk-sect-note">No instruction would prevent these — see the diagnosis.</div>') +
        '<div class="sk-sect-note">' + esc((a.model || 'LLM') + stamp) + '</div>';
      host.style.display = '';
      var copy = host.querySelector('.th-fix-copy');
      if (copy) copy.onclick = function () { copySnippet(a.snippet, this); };
    })
    .catch(function () { /* leave hidden */ });
}

function copySnippet(text, btn) {
  navigator.clipboard.writeText(text).then(function () {
    var orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  }, function () {
    var orig = btn.textContent;
    btn.textContent = 'Copy failed';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  });
}

/**
 * The page's scope control: one chip per tool, plus All.
 *
 * It sits directly above the numbers it scopes, so the causality reads top-down and
 * a click doesn't move the page out from under you. It was the table below doing
 * this job, which put the control a screen away from everything it changed and made
 * filtering something you could only discover by clicking a row that looked inert.
 *
 * Always lists every tool, including while narrowed: a scope control has to keep
 * offering the options you are not currently looking at.
 *
 * This is also the only per-tool read-out on the page — the table that used to
 * repeat it was removed as redundant — so the chip carries calls and errors inline
 * and its tooltip carries the rest, recency included.
 */
function toolChips(d) {
  var rows = (d.perTool || []).filter(function (t) { return !!t.raw; });
  if (!rows.length) return '';
  var all = !d.tool;
  return '<div class="th-chips" role="group" aria-label="Show one tool only">' +
    '<button type="button" class="th-chip th-chip-all' + (all ? ' on' : '') + '" data-raw=""' +
    ' aria-pressed="' + (all ? 'true' : 'false') + '" title="Show every tool on this server">All</button>' +
    rows.map(function (t) {
      var on = isToolSelected(t.raw, d.tool);
      return '<button type="button" class="th-chip' + (on ? ' on' : '') + '" data-raw="' + esc(t.raw) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(chipTip(t, on)) + '">' +
        esc(t.name) + '<span class="th-chip-n">' + num(t.calls) + '</span>' +
        // Errors ride along because a failing tool is the one you'd most want to
        // scope to, and no column elsewhere reports them per tool any more. Labelled,
        // not just red: two bare numbers on one chip give no clue which is which, and
        // colour alone carries nothing for a colour-blind reader — or on the active
        // chip, where the emerald fill leaves the red barely red.
        (t.errorCalls > 0 ? '<span class="th-chip-e">' + num(t.errorCalls) + ' err</span>' : '') +
        '</button>';
    }).join('') +
    // The caveat outlived its section heading: without it, a short list reads as
    // "this server has 9 tools" when it means "9 were called".
    '<span class="sk-info th-chips-info" title="' + esc('Tools this agent actually called, and the page\'s filter — pick one to narrow every number below to it. Observed calls only: there is no inventory of a server\'s full tool list, so a tool never called simply isn\'t here. Hover a tool for its errors and when it was last used.') + '">?</span>' +
    '</div>';
}

/** Everything the chip's tooltip has to carry now that no table repeats it. */
function chipTip(t, on) {
  return (on ? 'Showing ' + t.name + ' only — pick All to clear' : 'Show only ' + t.name) +
    '\n' + num(t.calls) + (t.calls === 1 ? ' call' : ' calls') +
    ', ' + num(t.errorCalls) + (t.errorCalls === 1 ? ' error' : ' errors') +
    ', last used ' + (t.lastUsedAt ? String(t.lastUsedAt).slice(0, 10) : 'never');
}

/** The short display name for a raw tool name, from the page's own tool list. */
function toolLabelOf(d, raw) {
  var hit = (d.perTool || []).filter(function (t) { return t.raw === raw; })[0];
  return hit ? hit.name : raw;
}

/**
 * Where to leave the viewport once the next detail render lands, or null to leave
 * scrolling alone.
 *
 * Filtering is driven from a table most of the way down the page, but it refetches
 * and replaces the whole page — which parks the user back at the top, far from the
 * row they just clicked and with no sense of what changed. Navigation (opening a
 * tool, going back) should still start at the top, so this is set only by the
 * filter and cleared as soon as it is honoured.
 */
var keepScroll = null;

/** Switch the page's tool filter (empty string clears it) and refetch. */
function setToolFilter(raw) {
  keepScroll = window.scrollY;
  state.toolFilter = raw || '';
  syncHash();
  paintTools();
}

// A horizontal bar per repo, widest = most-used. The null (unattributed) bucket is
// labelled explicitly rather than hidden.
function repoBreakdown(rows, color) {
  var max = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].calls > max) max = rows[i].calls;
  if (max <= 0) max = 1;
  return '<div class="sk-repos">' + rows.map(function (p) {
    var label = p.repo == null ? 'unattributed' : p.repo;
    var w = Math.max(2, Math.round((p.calls / max) * 100));
    var sub = num(p.calls) + (p.calls === 1 ? ' call' : ' calls') + ' · ' + num(p.sessions) + (p.sessions === 1 ? ' session' : ' sessions');
    return '<div class="sk-repo' + (p.repo == null ? ' sk-repo-null' : '') + '">' +
      '<div class="sk-repo-name" title="' + esc(label) + '">' + esc(label) + '</div>' +
      '<div class="sk-repo-track"><div class="sk-repo-bar" style="width:' + w + '%;background:' + color + '"></div></div>' +
      '<div class="sk-repo-n">' + esc(sub) + '</div>' +
      '</div>';
  }).join('') + '</div>';
}

/**
 * One session's calls, collapsed to a single row. A busy tool produces hundreds of
 * near-identical call rows, and the session is the unit a user actually navigates
 * to — so the session leads, and its calls are one click away.
 *
 * A single-call session opens its transcript directly: expanding to reveal one row
 * would be a click that buys nothing.
 */
function sessionGroupRow(g) {
  var single = g.calls === 1 && g.items.length === 1;
  var when = g.lastTs ? String(g.lastTs).slice(0, 10) : '—';
  var errs = g.errorCalls > 0
    ? '<span class="th-grp-errs" title="' + esc(num(g.errorCalls) + ' of these failed') + '">' + num(g.errorCalls) + ' errored</span>'
    : '';
  return '<div class="th-grp" data-session="' + esc(g.sessionId) + '">' +
    '<button type="button" class="th-grp-head" data-single="' + (single ? '1' : '') + '"' +
      ' data-idx="' + esc(String(single ? g.items[0].idx : '')) + '">' +
      '<span class="th-grp-caret">' + (single ? '' : '›') + '</span>' +
      '<span class="th-grp-title">' + esc(g.title || g.sessionId) + '</span>' +
      (g.repo ? '<span class="sk-inv-repo">' + esc(g.repo) + '</span>' : '') +
      errs +
      '<span class="th-grp-n">' + num(g.calls) + (g.calls === 1 ? ' call' : ' calls') + '</span>' +
      '<span class="sk-inv-date">' + esc(when) + '</span>' +
      '<span class="sk-inv-go">' + (single ? 'open ↗' : '') + '</span>' +
    '</button>' +
    '<div class="th-grp-items" hidden>' + g.items.map(invocationRow).join('') +
      (g.items.length < g.calls
        ? '<div class="sk-sect-note th-grp-more">Showing ' + num(g.items.length) + ' of ' + num(g.calls) +
          ' — failures first, then the most recent of the rest.</div>'
        : '') +
    '</div>' +
    '</div>';
}

/**
 * Session rows toggle their calls open (single-call sessions jump straight to the
 * transcript); call rows open the transcript at that exact call. Scoped to the
 * page container, never a global query.
 */
function wireCallGroups(box) {
  Array.prototype.forEach.call(box.querySelectorAll('.th-grp-head'), function (head) {
    head.onclick = function () {
      if (this.getAttribute('data-single')) {
        openDetail(this.parentNode.getAttribute('data-session'), { toolTarget: parseInt(this.getAttribute('data-idx'), 10) });
        return;
      }
      var items = this.parentNode.querySelector('.th-grp-items');
      var opening = items.hidden;
      items.hidden = !opening;
      this.classList.toggle('open', opening);
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('.sk-inv'), function (el) {
    el.onclick = function () {
      openDetail(this.getAttribute('data-session'), { toolTarget: parseInt(this.getAttribute('data-idx'), 10) });
    };
  });
}

function invocationRow(o) {
  var when = o.ts ? String(o.ts).slice(0, 10) : '—';
  var tags = '';
  if (o.sidechain) tags += '<span class="sk-inv-tag sk-inv-sub" title="Ran inside a subagent, not the main conversation.">subagent</span>';
  if (o.compound) tags += COMPOUND_BADGE;
  // The call failed, but its output named a different binary in the chain — so say
  // that, rather than badging this tool with someone else's failure.
  if (o.isError && o.blamedElsewhere) {
    tags += '<span class="sk-inv-tag th-compound" title="This call failed, but its output named a different binary in the same command.">failed elsewhere</span>';
  } else if (o.isError) {
    tags += '<span class="sk-inv-tag sk-inv-err">errored</span>';
  }
  var what = o.command || o.name || '';
  return '<button class="sk-inv" data-session="' + esc(o.sessionId) + '" data-idx="' + esc(String(o.idx)) + '">' +
    '<span class="sk-inv-title">' + esc(o.title || o.sessionId) + '</span>' +
    '<span class="th-inv-what" title="' + esc(what) + '">' + esc(clip(what, 52)) + '</span>' +
    '<span class="sk-inv-tags">' + tags + '</span>' +
    (o.repo ? '<span class="sk-inv-repo">' + esc(o.repo) + '</span>' : '') +
    '<span class="sk-inv-date">' + esc(when) + '</span>' +
    '<span class="sk-inv-go">open ↗</span>' +
    '</button>';
}

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * Marks a call whose command ran several binaries AND whose output didn't name
 * the one that failed — so the failure is listed under each, and we deliberately
 * don't guess which segment broke. When the output does name it (see
 * core/shell-blame.ts) the failure is charged to that binary alone and the row
 * carries no badge, because there is nothing ambiguous left to warn about.
 */
var COMPOUND_BADGE = '<span class="sk-inv-tag th-compound" title="This command ran several binaries and its output didn\'t say which one failed, so the failure is listed under each. Open the transcript to see which part broke.">compound</span>';

// ---- Errors by category (ported from the Ops widget) ------------------------
// The accordion: a bar per category, expanding to lazily fetch that category's
// actual failed calls. Filter semantics are kept from the original: the ENTITY
// scope shrinks numerator and denominator together (it's this tool's error rate),
// while picking a category redefines only the numerator.

var catTips = null; // taxonomy metadata (label + description), fetched once

function renderErrorCats(box, d) {
  var host = box.querySelector('#th-errcat');
  if (!host) return;
  var rows = d.errorCategories;
  var total = rows.reduce(function (a, c) { return a + c.calls; }, 0);
  var max = rows[0] ? rows[0].calls : 1;

  var tipsP = catTips ? Promise.resolve(catTips) : get('/api/error-categories').then(function (cats) {
    catTips = {};
    (cats || []).forEach(function (c) { catTips[c.key] = c; });
    return catTips;
  }).catch(function () { return (catTips = {}); });

  tipsP.then(function (tips) {
    if (state.tool !== d.name) return;
    host.innerHTML = rows.map(function (row) {
      var meta = tips[row.category] || { label: row.category, description: '' };
      var w = max ? Math.round((row.calls / max) * 100) : 0;
      var share = total ? Math.round((row.calls / total) * 100) : 0;
      return '<div class="errcat-item" data-cat="' + esc(row.category) + '" data-total="' + row.calls + '">' +
        '<div class="bar-row errcat-row" data-cat="' + esc(row.category) + '">' +
          '<span class="name" title="' + esc(meta.description) + '">' + esc(meta.label) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + w + '%"></span></span>' +
          '<span class="n"><span class="cnt">' + num(row.calls) + '</span><span class="pct">' + share + '%</span></span>' +
        '</div>' +
        '<div class="errcat-occ" hidden></div></div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.errcat-row'), function (el) {
      el.onclick = function () { toggleOcc(host, el.parentNode, el.getAttribute('data-cat'), tips, d); };
    });
  });
}

// Single-open accordion, scoped to THIS host (never a global query, so the Ops
// widget's identical markup elsewhere on the page can't be closed by ours).
function toggleOcc(host, item, cat, tips, d) {
  var panel = item.querySelector('.errcat-occ');
  if (!panel) return;
  var wasOpen = !panel.hidden;
  Array.prototype.forEach.call(host.querySelectorAll('.errcat-occ'), function (p) {
    p.hidden = true;
    p.parentNode.querySelector('.errcat-row').classList.remove('open');
  });
  if (wasOpen) return;
  panel.hidden = false;
  item.querySelector('.errcat-row').classList.add('open');
  if (panel.getAttribute('data-loaded')) return;
  panel.innerHTML = '<div class="occ-loading">Loading…</div>';
  var total = parseInt(item.getAttribute('data-total'), 10) || 0;
  get('/api/error-occurrences?category=' + encodeURIComponent(cat) +
      '&kind=' + encodeURIComponent(d.kind) + '&name=' + encodeURIComponent(d.name) + '&' + tlWinQuery())
    .then(function (occ) {
      panel.setAttribute('data-loaded', '1');
      renderOcc(panel, cat, occ || [], tips, total);
    })
    .catch(function () {
      // Leave data-loaded unset so re-opening retries.
      panel.innerHTML = '<div class="occ-empty">Could not load occurrences.</div>';
    });
}

function renderOcc(panel, cat, occ, tips, total) {
  if (!occ.length) { panel.innerHTML = '<div class="occ-empty">No occurrences in this window.</div>'; return; }
  var label = (tips[cat] && tips[cat].label) || cat;
  var count = total || occ.length;
  var moreN = Math.max(0, count - occ.length);
  var list = occ.map(function (o, i) {
    var cmd = o.command || o.targetPath || '';
    return '<div class="occ-row" data-i="' + i + '" title="click to open the transcript at this error">' +
      '<span class="occ-tool">' + esc(o.name) + '</span>' +
      // The badge belongs with the COMMAND, not the tool name: it is a fact about
      // the command's shape, and the tool column is a fixed 92px that clips it.
      '<span class="occ-cmd" title="' + esc(cmd) + '">' +
        (o.binaryCount > 1 ? COMPOUND_BADGE : '') + esc(clip(cmd, 44)) + '</span>' +
      '<span class="occ-msg" title="' + esc(o.message || '') + '">' + esc(clip(o.message || '', 60)) + '</span>' +
      '<span class="occ-sess">' + esc(clip(o.title || '(untitled)', 22)) + '</span>' +
      '<span class="occ-date">' + esc(dayOf(o.ts || o.startedAt)) + '</span></div>';
  }).join('');
  panel.innerHTML = '<div class="occ-head">' + num(count) + ' occurrence' + (count > 1 ? 's' : '') + '</div>' +
    '<div class="occ-list">' + list + '</div>' +
    (moreN ? '<div class="occ-more">+ ' + num(moreN) + ' more (showing ' + occ.length + ')</div>' : '');
  Array.prototype.forEach.call(panel.querySelectorAll('.occ-row'), function (el) {
    el.onclick = function () { startErrorWalk(label, occ, parseInt(el.getAttribute('data-i'), 10)); };
  });
}
