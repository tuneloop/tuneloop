// Skill Health tab: a per-skill roster built from real sessions — trigger
// frequency (with a sparkline), a used/dead/idle/scope verdict, own-call error
// rate, and a clearly-LABELLED friction-adjacency proxy. Clicking a row opens a
// full per-skill DETAIL PAGE (routed at #/skills/<name>, back-button aware), which
// shows the skill's SKILL.md description and the honest metric grid. Deliberately
// makes NO per-skill cost claim (tokens aren't attributable to a tool call — see
// src/server/skill-health.ts).
//
// All DOM classes are `sk-`-prefixed and all handlers are wired by querying
// WITHIN this tab's container, never a global querySelectorAll — so the Sessions
// tab's global .facet-filter/.srow handlers can't clobber them (and vice-versa).
import { state, $, esc, num, get } from './core';
import { syncHash } from './router';
import { filterBySkill } from './sessions';

// Usage-window presets for the Skills tab (mirrors the Sessions time bar). The
// installed inventory is always current — only the invocation side windows.
var SK_TIME_PRESETS = [
  { d: 7, l: '7d' }, { d: 14, l: '14d' }, { d: 30, l: '30d' }, { d: 90, l: '90d' }, { d: 'all', l: 'All' }, { d: 'custom', l: 'Custom' }
];

// Cached report, keyed on the window it was fetched for. A window change refetches
// (the numbers are window-dependent); an unchanged window repaints from cache.
var skReport = null;
var skReportKey = null; // the window signature the cache was fetched for
var skLoading = false;
// Roster controls (client-side, applied over the cached rows):
//   skStatus '' = default (used only) | 'all' | a status key | a flag key
//   skSearch = case-insensitive substring on the skill name
var skStatus = '';
var skSearch = '';

// Status presentation (the mutually-exclusive usage axis): dot color + meaning.
var STATUS = {
  used: { label: 'Used', color: 'var(--emerald)', tip: 'Invoked at least once in the window.' },
  unused: { label: 'Unused', color: 'var(--red)', tip: 'Installed but never invoked, with enough sessions observed to trust that.' },
  'too-little-data': { label: 'Too little data', color: 'var(--gray)', tip: 'Installed and unused, but too few sessions in this window to judge — we abstain. Widen the window.' }
};
// Flag presentation (refinements shown as chips on a used skill).
var FLAGS = {
  'scope-down': { label: 'Scope down', color: 'var(--amber)', tip: 'Global, but used in only a few repos — candidate to move into just those.' },
  'not-in-config': { label: 'Not in config', color: '#3b6ea5', tip: 'Seen running, but not in any current config snapshot (removed/relocated since it ran, or a CLI-bundled skill we can\'t see on disk).' }
};
function hasFlag(r, f) { return (r.flags || []).indexOf(f) >= 0; }

// The API query fragment for the current window. Custom → from/to; else days=.
function skWinQuery() {
  if (state.skillWin === 'custom' && state.skillFrom && state.skillTo) {
    return 'from=' + encodeURIComponent(new Date(state.skillFrom).toISOString()) +
      '&to=' + encodeURIComponent(new Date(state.skillTo + 'T23:59:59').toISOString());
  }
  return 'days=' + encodeURIComponent(state.skillWin === 'all' ? 'all' : String(state.skillWin));
}

// A signature that changes whenever the fetched data would differ — the cache key.
function skWinKey() {
  return state.skillWin === 'custom' ? 'custom:' + state.skillFrom + ':' + state.skillTo : String(state.skillWin);
}

// The skills screen's URL query slice: the usage window (30d is the default, omitted).
export function getSkillParams(): Record<string, string> {
  var q: Record<string, string> = {};
  if (state.skillWin === 'custom') {
    if (state.skillFrom) q.from = state.skillFrom;
    if (state.skillTo) q.to = state.skillTo;
  } else if (state.skillWin === 'all') q.win = 'all';
  else if (state.skillWin !== 30) q.win = String(state.skillWin);
  return q;
}

// Restore the window from a URL query (router → state). A from/to pair → custom range;
// else the win preset. Kept separate from openSkill so the router applies it atomically.
function applySkillWin(query: Record<string, string>) {
  var win = query && query.win;
  if (query && (query.from || query.to)) {
    state.skillWin = 'custom';
    state.skillFrom = query.from || '';
    state.skillTo = query.to || '';
  } else if (win === 'all') state.skillWin = 'all';
  else if (win === '7' || win === '14' || win === '90') state.skillWin = parseInt(win, 10);
  else state.skillWin = 30; // default (win=30 or absent)
}

// Called once from main.ts to pre-render the tab (fetch + paint). Safe to call
// again; it repaints from cache without refetching when the window is unchanged.
export function renderSkills() {
  var box = $('#skills-health');
  if (!box) return;
  // Cache hit for the current window → repaint, no fetch.
  if (skReport && skReportKey === skWinKey()) { paintSkills(); return; }
  loadSkills();
}

// Fetch the report for the current window and repaint. Guards against overlapping
// fetches (a fast preset click) by tracking the in-flight window signature.
function loadSkills() {
  var box = $('#skills-health');
  if (!box) return;
  var want = skWinKey();
  skLoading = true;
  box.innerHTML = '<div class="sk-empty">Loading skill health…</div>';
  get('/api/skill-health?' + skWinQuery()).then(function (d) {
    // Ignore a stale response if the window changed while this was in flight.
    if (skWinKey() !== want) return;
    skReport = d || { rows: [] };
    skReportKey = want;
    skLoading = false;
    paintSkills();
  }).catch(function () {
    if (skWinKey() !== want) return;
    skLoading = false;
    box.innerHTML = '<div class="sk-empty">Could not load skill health.</div>';
  });
}

// Open a skill's detail page (or return to the roster when name is null). `query`
// (optional) carries the URL window on a router-driven navigation. Mirrors openMetric:
// set state, sync the URL, repaint. Called by the router and by row/back clicks.
export function openSkill(name, query?) {
  if (query) applySkillWin(query);
  state.skill = name || null;
  syncHash(); // mirror #/skills/<name>?win= into the URL (no-op while a route is applying)
  // Detail pages start at the top; the roster keeps its scroll.
  if (state.skill) window.scrollTo(0, 0);
  // Fetch if the window changed (or first load); else repaint from cache.
  if (!skReport || skReportKey !== skWinKey()) loadSkills();
  else paintSkills();
}

// Change the usage window: update state, sync the URL, refetch. Wired to the time bar.
// A custom range only fetches once both dates are set.
function setSkillWin(win) {
  state.skillWin = win;
  syncHash();
  if (win === 'custom' && (!state.skillFrom || !state.skillTo)) {
    paintSkills(); // reveal the date inputs; don't fetch until both are filled
    return;
  }
  loadSkills();
}

// Find a row by name (the URL may carry a stale/unknown skill after a re-analyze).
function skFind(name) {
  var rows = (skReport && skReport.rows) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].name === name) return rows[i];
  return null;
}

function paintSkills() {
  var box = $('#skills-health');
  if (!box || !skReport) return;
  var d = skReport;

  if (d.noConfig) {
    box.innerHTML =
      '<div class="metric-head"><h2>Skill Health</h2></div>' +
      '<div class="sk-empty">No skill config captured yet. Run <code>tuneloop analyze</code> so the installed-skill inventory is read from your <code>SKILL.md</code> files.</div>';
    return;
  }

  // A skill is selected → render its full detail page instead of the roster.
  if (state.skill) {
    var row = skFind(state.skill);
    if (row) { paintSkillPage(box, row); return; }
    // Unknown skill (stale link) — fall through to the roster rather than error.
    state.skill = null;
  }

  paintRoster(box, d);
}

function paintRoster(box, d) {
  box.innerHTML =
    '<div class="panel-head"><h2>Skill Health</h2></div>' +
    '<div class="filters sk-filters" id="sk-filters"></div>' +
    '<div class="sk-roster" id="sk-roster"></div>';

  renderSkFilters(d);
  renderSkRoster(d.rows || []);
}

// Filter toolbar — mirrors the Sessions bar (same .filters / .flt-* / .seg tokens and
// two-row layout): row 1 is Time presets (+ custom range) and the search box; row 2 is
// the Status dropdown. Skill-relevant filters only — session-level facets (work-type,
// outcomes) don't map to a per-skill aggregate.
function renderSkFilters(d) {
  var bar = $('#sk-filters');
  if (!bar) return;

  var segBtns = SK_TIME_PRESETS.map(function (p) {
    return '<button type="button" data-d="' + p.d + '"' +
      (String(p.d) === String(state.skillWin) ? ' class="on"' : '') + '>' + p.l + '</button>';
  }).join('');

  var statusOpts = [['', 'Used (default)'], ['all', 'All statuses'], ['unused', 'Unused'],
    ['too-little-data', 'Too little data'], ['scope-down', 'Scope down'], ['not-in-config', 'Not in config']]
    .map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === skStatus ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');

  bar.innerHTML =
    '<div class="flt-row">' +
      '<span class="flt-grp"><span class="flt-lbl">Time</span>' +
        '<div class="seg flt-seg" id="sk-time">' + segBtns + '</div>' +
        '<span class="flt-dates" id="sk-dates"' + (state.skillWin === 'custom' ? '' : ' hidden') + '>' +
          '<input type="date" id="sk-from" value="' + esc(state.skillFrom) + '" />' +
          '<span class="flt-dash">→</span>' +
          '<input type="date" id="sk-to" value="' + esc(state.skillTo) + '" />' +
        '</span>' +
      '</span>' +
      '<input id="sk-search" class="flt-search" placeholder="search skill name" value="' + esc(skSearch) + '" />' +
    '</div>' +
    '<div class="flt-row flt-row-facets">' +
      '<span class="flt-grp"><span class="flt-lbl">Status</span>' +
        '<select id="sk-status">' + statusOpts + '</select></span>' +
    '</div>';

  // Time presets + custom-range dates.
  Array.prototype.forEach.call(bar.querySelectorAll('#sk-time button'), function (b) {
    b.onclick = function () {
      var v = this.getAttribute('data-d');
      setSkillWin(v === 'all' || v === 'custom' ? v : parseInt(v, 10));
    };
  });
  var from = $('#sk-from'), to = $('#sk-to');
  if (from) from.onchange = function () { state.skillFrom = this.value; setSkillWin('custom'); };
  if (to) to.onchange = function () { state.skillTo = this.value; setSkillWin('custom'); };

  // Status filter.
  $('#sk-status').onchange = function () { skStatus = this.value; paintSkills(); };

  // Name search (debounced, client-side over the cached rows).
  var t;
  $('#sk-search').oninput = function () {
    var v = this.value;
    clearTimeout(t);
    t = setTimeout(function () { skSearch = v; renderSkRoster((skReport && skReport.rows) || []); }, 150);
  };
}

// Apply the status filter + name search to the rows. Default (skStatus '') = used only.
function filterRows(rows) {
  var out = rows;
  if (skStatus === '') out = out.filter(function (r) { return r.status === 'used'; });
  else if (skStatus === 'scope-down' || skStatus === 'not-in-config') out = out.filter(function (r) { return hasFlag(r, skStatus); });
  else if (skStatus !== 'all') out = out.filter(function (r) { return r.status === skStatus; });
  if (skSearch) {
    var q = skSearch.toLowerCase();
    out = out.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; });
  }
  return out;
}

function renderSkRoster(rows) {
  var host = $('#sk-roster');
  if (!host) return;
  var shown = filterRows(rows);
  if (!shown.length) {
    var msg = skStatus === '' && !skSearch
      ? 'No skills were used in this window. Widen the window, or pick a status above to see installed-but-unused skills.'
      : 'No skills match this view.';
    host.innerHTML = '<div class="sk-empty">' + msg + '</div>';
    return;
  }
  host.innerHTML = shown.map(skRow).join('');

  // Row click → open the skill's detail page. Scoped to this host.
  Array.prototype.forEach.call(host.querySelectorAll('.sk-row-head'), function (el) {
    el.onclick = function () { openSkill(this.getAttribute('data-name')); };
  });
}

function skRow(r) {
  var s = STATUS[r.status] || STATUS['too-little-data'];
  // Flag chips (scope-down / not-in-config) shown after the status label.
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(fl.tip) + '">' + esc(fl.label) + '</span>' : '';
  }).join('');
  return '<div class="sk-row">' +
    '<div class="sk-row-head" data-name="' + esc(r.name) + '" title="' + esc(s.tip) + '">' +
      '<span class="sk-dot" style="background:' + s.color + '"></span>' +
      '<span class="sk-name">' + esc(r.name) + '</span>' +
      '<span class="sk-flags">' + chips + '</span>' +
      '<span class="sk-spark">' + sparkline(r.spark) + '</span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.calls) + '</span><span class="sk-ml">calls</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.sessions) + '</span><span class="sk-ml">sessions</span></span>' +
      '<span class="sk-caret">›</span>' +
    '</div>' +
    '</div>';
}

// ---- Per-skill detail page --------------------------------------------------

function paintSkillPage(box, r) {
  var s = STATUS[r.status] || STATUS['too-little-data'];
  var errRate = r.calls > 0 ? Math.round((r.errorCalls / r.calls) * 100) : 0;
  var fricRate = r.calls > 0 ? Math.round((r.frictionAdjacent / r.calls) * 100) : 0;
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag sk-flag-lg" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(fl.tip) + '">' + esc(fl.label) + '</span>' : '';
  }).join('');

  var html = '';
  // Back link + heading with the status dot and any flag chips.
  html += '<div class="sk-page-head">' +
    '<button class="sk-back" id="sk-back">← All skills</button>' +
    '</div>';
  html += '<div class="sk-page-title">' +
    '<span class="sk-dot sk-dot-lg" style="background:' + s.color + '"></span>' +
    '<h2 class="sk-page-name">' + esc(r.name) + '</h2>' +
    '<span class="sk-verdict sk-verdict-lg" style="color:' + s.color + '" title="' + esc(s.tip) + '">' + esc(s.label) + '</span>' +
    chips +
    '</div>';

  // Description (or its absence).
  if (r.description) html += '<div class="sk-desc">' + esc(r.description) + '</div>';
  else html += '<div class="sk-desc sk-desc-none">No description in SKILL.md frontmatter.</div>';

  // Headline metrics as full-size stat tiles (matches the product's KPI tiles).
  var winSub = skReport.windowDays == null ? 'over all time' : 'in the last ' + num(skReport.windowDays) + ' days';
  html += '<div class="sk-page-tiles">' +
    pageTile(num(r.calls), 'Invocations', winSub) +
    pageTile(num(r.sessions), 'Sessions', 'distinct sessions it ran in') +
    pageTile(r.calls > 0 ? errRate + '%' : '—', 'Own-call error rate', r.calls > 0 ? num(r.errorCalls) + ' of ' + num(r.calls) + ' calls errored' : 'no calls to measure') +
    pageTile(r.calls > 0 ? fricRate + '%' : '—', 'Friction-adjacent · PROXY', r.calls > 0 ? num(r.frictionAdjacent) + ' calls followed by an error' : 'no calls to measure') +
    '</div>';

  // Trend sparkline (larger than the roster's inline one).
  html += '<div class="sk-page-sect">' +
    '<div class="sk-sect-h">Usage trend</div>' +
    '<div class="sk-page-spark">' + sparkline(r.spark, 260, 44) + '</div>' +
    '<div class="sk-sect-note">Invocations bucketed across the ' + (skReport.windowDays == null ? 'full history' : num(skReport.windowDays) + '-day window') + ', oldest → newest.</div>' +
    '</div>';

  // Facts grid: install/usage locations + timeline.
  html += '<div class="sk-page-sect">' +
    '<div class="sk-sect-h">Details</div>' +
    '<div class="sk-facts">';
  html += fact('Install scope', r.installed ? (r.scope === 'global' ? 'Global' : 'Project') : 'Not installed (seen running)');
  if (r.installedRepos && r.installedRepos.length) html += fact('Installed in', r.installedRepos.join(', '));
  if (r.usedRepos && r.usedRepos.length) html += fact('Used in', r.usedRepos.join(', '));
  if (r.calls > 0) {
    html += fact('First used', r.firstUsedAt ? String(r.firstUsedAt).slice(0, 10) : '—');
    html += fact('Last used', r.lastUsedAt ? String(r.lastUsedAt).slice(0, 10) : '—');
  }
  html += '</div></div>';

  // The friction proxy needs its honesty caveat spelled out on the page.
  if (r.calls > 0) {
    html += '<div class="sk-page-sect">' +
      '<div class="sk-sect-h">What “friction-adjacent” means</div>' +
      '<div class="sk-sect-note sk-sect-note-block">A skill invocation counts as friction-adjacent when an errored tool call followed it within the same session. ' +
      'This is <b>adjacency only</b> — not a judgment that the skill was wrong, and not a cost. It is a signal to go read the sessions, not a verdict.</div>' +
      '</div>';
  }

  // Verdict-specific guidance.
  html += '<div class="sk-advice">' + esc(advice(r)) + '</div>';

  // Drill into the sessions that used it.
  if (r.calls > 0) {
    html += '<div class="sk-actions"><a class="sk-view-sessions" data-name="' + esc(r.name) + '">View sessions that used it →</a></div>';
  }

  box.innerHTML = html;

  // Wire the (container-scoped) handlers.
  var back = box.querySelector('#sk-back');
  if (back) back.onclick = function () { openSkill(null); };
  var vs = box.querySelector('.sk-view-sessions');
  if (vs) vs.onclick = function () { filterBySkill(this.getAttribute('data-name')); };
}

function pageTile(value, label, sub) {
  return '<div class="sk-tile">' +
    '<div class="sk-tile-v">' + value + '</div>' +
    '<div class="sk-tile-l">' + esc(label) + '</div>' +
    (sub ? '<div class="sk-tile-s">' + esc(sub) + '</div>' : '') +
    '</div>';
}

function fact(label, value, tag?, tip?) {
  return '<div class="sk-fact"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
    '<div class="sk-fact-l">' + esc(label) + (tag ? ' <span class="sk-tag">' + esc(tag) + '</span>' : '') + '</div>' +
    '<div class="sk-fact-v">' + esc(value) + '</div></div>';
}

// The one actionable sentence — status first, then the most useful flag hint.
function advice(r) {
  if (r.status === 'unused') {
    return 'Never invoked in the window. Consider removing it to trim startup overhead — or, if you expected it to fire, its description may not be matching your prompts.';
  }
  if (r.status === 'too-little-data') {
    return 'Installed but unused — too few sessions here to say whether that\'s disuse or just quiet. Revisit once you\'ve worked more in these repos, or widen the window.';
  }
  // Used: lead with the actionable flag if present.
  if (hasFlag(r, 'scope-down')) {
    return r.scopeToRepos && r.scopeToRepos.length
      ? 'Used, but only in: ' + r.scopeToRepos.join(', ') + '. Consider scoping it to those repos so the rest stop loading it.'
      : 'Used in only a few of your repos — consider scoping it down.';
  }
  if (hasFlag(r, 'not-in-config')) {
    return 'Used, but not found in your current config — a skill removed/relocated since it last ran, or a CLI-bundled skill we can\'t see on disk.';
  }
  return 'Actively used. Frequency and error rate above are measured from real sessions.';
}

// Tiny inline SVG sparkline of per-bucket invocation counts. Flat baseline when
// there's no usage. Bars (not a line) read clearly at this size. Width/height are
// parameterized so the roster (small) and the detail page (larger) share it.
function sparkline(spark, w?, h?) {
  var width = w || 90, height = h || 20;
  var vals = spark || [];
  var max = 0;
  for (var i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
  var base = height - 1;
  if (!max) return '<svg class="sk-spark-svg" width="' + width + '" height="' + height + '" aria-hidden="true"><line x1="0" y1="' + base + '" x2="' + width + '" y2="' + base + '" stroke="var(--line)" stroke-width="1"/></svg>';
  var n = vals.length, bw = width / n, bars = '';
  for (var j = 0; j < n; j++) {
    var bh = vals[j] ? Math.max(2, Math.round((vals[j] / max) * (height - 2))) : 0;
    if (!bh) continue;
    bars += '<rect x="' + (j * bw).toFixed(1) + '" y="' + (base - bh) + '" width="' + Math.max(1, bw - 1).toFixed(1) +
      '" height="' + bh + '" fill="var(--emerald)"></rect>';
  }
  return '<svg class="sk-spark-svg" width="' + width + '" height="' + height + '" aria-hidden="true">' + bars + '</svg>';
}
