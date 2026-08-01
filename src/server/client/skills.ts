// Skill Health tab: a per-skill roster. Clicking a row opens a
// full per-skill DETAIL PAGE (routed at #/skills/<name>, back-button aware), which
// shows the skill's SKILL.md description and the honest metric grid. Deliberately
// makes NO per-skill cost claim (tokens aren't attributable to a tool call — see
// src/server/skill-health.ts).
//
// All DOM classes are `sk-`-prefixed and all handlers are wired by querying
// WITHIN this tab's container, never a global querySelectorAll — so the Sessions
// tab's global .facet-filter/.srow handlers can't clobber them (and vice-versa)
import { state, $, esc, num, get } from './core';
import { syncHash } from './router';
import { filterBySkill, openDetail } from './sessions';

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
  unused: { label: 'Unused', color: 'var(--red)', tip: 'Installed but not invoked in the window.' }
};
// Flag presentation (refinements shown as chips on a used skill).
var FLAGS = {
  'scope-down': { label: 'Scope down', color: 'var(--amber)', tip: 'Global, but used in only a few repos — candidate to move into just those.' },
  'not-in-config': { label: 'Not in config', color: '#3b6ea5', tip: 'Seen running, but not in any current config snapshot (removed/relocated since it ran, or a CLI-bundled skill we can\'t see on disk).' },
  'often-bypassed': { label: 'Often bypassed', color: 'var(--red)', tip: 'The agent bypassed or reworked this skill\'s output in at least half of its judged invocations.' }
};
function hasFlag(r, f) { return (r.flags || []).indexOf(f) >= 0; }

// The chip tooltip for one flag on one row — often-bypassed gets the row's actual
// judged/bypassed counts instead of the generic phrasing, so the pill carries its evidence.
function flagTip(r, f) {
  var fl = FLAGS[f];
  if (f === 'often-bypassed' && r.judgedCalls) {
    return 'The agent bypassed or reworked its output in ' + num(r.bypassedCalls || 0) + ' of ' +
      num(r.judgedCalls) + ' judged invocations. See Activation outcomes on the detail page for the evidence.';
  }
  return fl.tip;
}

// Display names for the harness sources (the source chooser + any source-scoped copy).
var SOURCE_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
function sourceLabel(s) { return SOURCE_LABELS[s] || s; }

// The API query fragment for the current window (+ source, when one is chosen). Custom →
// from/to; else days=. An explicit source is appended so every skill endpoint reports the
// same harness the roster resolved to.
function skWinQuery() {
  var q = (state.skillWin === 'custom' && state.skillFrom && state.skillTo)
    ? 'from=' + encodeURIComponent(new Date(state.skillFrom).toISOString()) +
      '&to=' + encodeURIComponent(new Date(state.skillTo + 'T23:59:59').toISOString())
    : 'days=' + encodeURIComponent(state.skillWin === 'all' ? 'all' : String(state.skillWin));
  if (state.skillSource) q += '&source=' + encodeURIComponent(state.skillSource);
  return q;
}

// The human window phrase for a subtitle/caption. `windowDays` is the report's echo:
// null = all-time, -1 = a custom from/to range (show the dates, per resolveWindow's
// sentinel), else the preset day count. `presetPrefix` leads the preset/custom form
// ("in the last "/"over the last "); `allTime` is the standalone all-time phrase.
function winPhrase(presetPrefix, allTime) {
  var wd = skReport && skReport.windowDays;
  if (wd == null) return allTime;
  if (wd < 0) {
    // Custom range: the day count is a sentinel, so show the actual dates instead — a
    // self-contained phrase, since "in the last 2026-01-01 → …" doesn't read.
    if (state.skillFrom && state.skillTo) return 'from ' + state.skillFrom + ' to ' + state.skillTo;
    return 'over a custom range';
  }
  return presetPrefix + num(wd) + (wd === 1 ? ' day' : ' days');
}

// A signature that changes whenever the fetched data would differ — the cache key.
// Source is part of it: switching harness must refetch (different rows entirely).
function skWinKey() {
  var win = state.skillWin === 'custom' ? 'custom:' + state.skillFrom + ':' + state.skillTo : String(state.skillWin);
  return win + '|' + (state.skillSource || '');
}

// The skills screen's URL query slice: the usage window (30d is the default, omitted).
export function getSkillParams(): Record<string, string> {
  var q: Record<string, string> = {};
  if (state.skillWin === 'custom') {
    if (state.skillFrom) q.from = state.skillFrom;
    if (state.skillTo) q.to = state.skillTo;
  } else if (state.skillWin === 'all') q.win = 'all';
  else if (state.skillWin !== 30) q.win = String(state.skillWin);
  if (state.skillSource) q.source = state.skillSource;
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
  state.skillSource = (query && query.source) || ''; // '' → server picks the default
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

// Switch the harness whose skills are shown. Refetches — a different source is an entirely
// different roster. Returning to the roster first avoids stranding a detail page for a skill
// that doesn't exist under the newly-selected source.
function setSkillSource(source) {
  state.skillSource = source;
  state.skill = null; // a skill name isn't shared across harnesses; drop the open detail
  syncHash();
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
  // Matches the other tabs: one white panel wraps the whole tab (heading, overview,
  // filters, and the hairline-separated roster) — see Sessions/Recommendations/Artifacts.
  box.innerHTML =
    '<div class="panel sk-panel">' +
      '<div class="panel-head"><h2>Skill Health</h2></div>' +
      '<div class="sk-overview" id="sk-overview"></div>' +
      '<div class="filters sk-filters" id="sk-filters"></div>' +
      '<div class="sk-roster" id="sk-roster"></div>' +
    '</div>';

  renderSkOverview(d);
  renderSkFilters(d);
  renderSkRoster(d.rows || []);
}

// Summary strip under the heading: the window's inventory totals, each a one-click
// status filter (kept in sync with the Status dropdown via the shared skStatus). The
// active stat — the filter currently applied — is highlighted. "Not in config" only
// appears when there is at least one, since it's an exceptional state, not a baseline.
function renderSkOverview(d) {
  var bar = $('#sk-overview');
  if (!bar) return;
  var stats = [
    { k: 'all', v: d.totalInstalled, l: 'Installed', tip: 'Skills present in a config snapshot in this window.' },
    { k: '', v: d.totalUsed, l: 'Used', tip: STATUS.used.tip },
    { k: 'unused', v: d.totalUnused, l: 'Unused', tip: STATUS.unused.tip },
    { k: 'scope-down', v: d.totalScopeDown, l: 'Scope down', tip: FLAGS['scope-down'].tip }
  ];
  if (d.totalNotInConfig > 0) stats.push({ k: 'not-in-config', v: d.totalNotInConfig, l: 'Not in config', tip: FLAGS['not-in-config'].tip });
  // Like not-in-config: an exceptional state, shown only when at least one skill carries it.
  if (d.totalOftenBypassed > 0) stats.push({ k: 'often-bypassed', v: d.totalOftenBypassed, l: 'Often bypassed', tip: FLAGS['often-bypassed'].tip });

  bar.innerHTML = stats.map(function (s) {
    return '<button type="button" class="sk-stat' + (s.k === skStatus ? ' on' : '') + '" data-k="' + esc(s.k) + '" title="' + esc(s.tip) + '">' +
      '<span class="sk-stat-v">' + num(s.v || 0) + '</span>' +
      '<span class="sk-stat-l">' + esc(s.l) + '</span>' +
      '</button>';
  }).join('');

  Array.prototype.forEach.call(bar.querySelectorAll('.sk-stat'), function (el) {
    el.onclick = function () { skStatus = this.getAttribute('data-k'); paintSkills(); };
  });
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
    ['scope-down', 'Scope down'], ['not-in-config', 'Not in config'], ['often-bypassed', 'Often bypassed']]
    .map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === skStatus ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');

  // Source chooser — only when more than one harness has skill data (a single-agent user
  // sees no extra control). The selected value is the report's RESOLVED source (d.source),
  // not state.skillSource, since '' means "let the server pick" and we want the real one.
  var sources = (d && d.availableSources) || [];
  var sourceGrp = '';
  if (sources.length > 1) {
    var sourceOpts = sources.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === d.source ? ' selected' : '') + '>' + esc(sourceLabel(s)) + '</option>';
    }).join('');
    sourceGrp = '<span class="flt-grp"><span class="flt-lbl">Agent</span>' +
      '<select id="sk-source">' + sourceOpts + '</select></span>';
  }

  // Single row — Skills has only four controls (Time, search, Status, Agent), so they
  // fit on one line and wrap gracefully on narrow viewports (flt-row already wraps).
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
      '<span class="flt-grp"><span class="flt-lbl">Status</span>' +
        '<select id="sk-status">' + statusOpts + '</select></span>' +
      sourceGrp +
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

  // Source (agent) chooser, present only when >1 source has skill data.
  var srcSel = $('#sk-source');
  if (srcSel) srcSel.onchange = function () { setSkillSource(this.value); };

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
  else if (skStatus === 'scope-down' || skStatus === 'not-in-config' || skStatus === 'often-bypassed') out = out.filter(function (r) { return hasFlag(r, skStatus); });
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
  var s = STATUS[r.status] || STATUS.unused;
  // Flag chips (scope-down / not-in-config / often-bypassed) shown after the status label.
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(flagTip(r, f)) + '">' + esc(fl.label) + '</span>' : '';
  }).join('');
  return '<div class="sk-row">' +
    '<div class="sk-row-head" data-name="' + esc(r.name) + '" title="' + esc(s.tip) + '">' +
      '<span class="sk-dot" style="background:' + s.color + '"></span>' +
      '<span class="sk-name">' + esc(r.name) + '</span>' +
      '<span class="sk-flags">' + chips + '</span>' +
      '<span class="sk-spark">' + sparkline(r.spark) + '</span>' +
      '<span class="sk-metric"' + (r.subagentCalls > 0 ? ' title="' + esc(num(r.subagentCalls) + ' of ' + num(r.calls) + ' via subagents') + '"' : '') + '><span class="sk-mv">' + num(r.calls) + '</span><span class="sk-ml">calls</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.sessions) + '</span><span class="sk-ml">sessions</span></span>' +
      '<span class="sk-caret">›</span>' +
    '</div>' +
    '</div>';
}

// ---- Per-skill detail page --------------------------------------------------

function paintSkillPage(box, r) {
  var s = STATUS[r.status] || STATUS.unused;
  var errRate = r.calls > 0 ? Math.round((r.errorCalls / r.calls) * 100) : 0;
  var chips = (r.flags || []).map(function (f) {
    var fl = FLAGS[f];
    return fl ? '<span class="sk-flag sk-flag-lg" style="color:' + fl.color + ';border-color:' + fl.color + '" title="' + esc(flagTip(r, f)) + '">' + esc(fl.label) + '</span>' : '';
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
  var winSub = winPhrase('in the last ', 'over all time');
  var callsSub = r.subagentCalls > 0 ? winSub + ' · ' + num(r.subagentCalls) + ' via subagents' : winSub;
  html += '<div class="sk-page-tiles">' +
    pageTile(num(r.calls), 'Invocations', callsSub) +
    pageTile(num(r.sessions), 'Sessions', 'distinct sessions it ran in') +
    pageTile(r.calls > 0 ? errRate + '%' : '—', 'Own-call error rate', r.calls > 0 ? num(r.errorCalls) + ' of ' + num(r.calls) + ' calls errored' : 'no calls to measure') +
    '</div>';

  // One-line actionable takeaway, high up. A thin status-coloured rule, not a filled box.
  html += '<div class="sk-advice" style="border-left-color:' + s.color + '">' + esc(advice(r)) + '</div>';

  // --- Signals (lead the page): Usage trend → Activation outcomes → Version drift. ---

  // Usage trend — a labeled bar chart (count axis + real calendar date ticks + a JS
  // hover tooltip). Only meaningful when it was actually used.
  if (r.calls > 0) {
    html += '<div class="sk-card">' +
      '<div class="sk-sect-h">Usage trend</div>' +
      '<div class="sk-trend" id="sk-trend">' + trendChart(r.spark, skReport.sparkBuckets) + '</div>' +
      '<div class="sk-sect-note">Invocations per ' + trendGranLabel(skReport.sparkBuckets) + ', ' +
        winPhrase('over the last ', 'across your full history') + '. Hover a bar for its exact count.</div>' +
      '</div>';
  }

  // Activation outcomes — windowed; hidden unless the classifier has produced verdicts
  // for this skill in the window.
  if (r.calls > 0) {
    html += '<div class="sk-card" id="sk-oc-sect" style="display:none">' +
      sectHead('Activation outcomes', 'A cheap LLM read of the turns around each invocation: did the agent follow, rework, or bypass the skill’s output. Derived from main-thread invocations only — subagent invocations count toward usage but are not judged. Observational — what happened after the skill ran, not a verdict that it succeeded or failed, and never a cost.') +
      '<div id="sk-oc"></div>' +
      '</div>';
  }

  // Skill drift & version comparison. Edit-anchored, so it ignores the time filter —
  // loaded async, stays hidden until there's a multi-version history to show (most skills
  // have one version → no noise).
  html += '<div class="sk-card" id="sk-drift-sect" style="display:none">' +
    '<div class="sk-sect-h">Version drift</div>' +
    '<div id="sk-drift"></div>' +
    '</div>';

  // --- Reach: where it fires + what it composes with. ---

  // Per-repo usage breakdown — the evidence behind a scope-down flag. Shows where the
  // skill actually fires, so "used in only these repos" is self-evident, not on faith.
  if (r.calls > 0 && r.perRepo && r.perRepo.length) {
    html += '<div class="sk-card">' +
      '<div class="sk-sect-h">Where it\'s used</div>' +
      repoBreakdown(r) +
      '<div class="sk-sect-note">' + repoBreakdownNote(r) + '</div>' +
      '</div>';
  }

  // Co-occurrence — other skills that fire in the same sessions (add/compose signal).
  // Windowed like usage; hidden until we find at least one co-occurring skill.
  if (r.calls > 0) {
    html += '<div class="sk-card" id="sk-cooc-sect" style="display:none">' +
      sectHead('Frequently used with', 'Share = the fraction of this skill’s sessions that also ran the other skill. “often first” marks skills that tended to fire before it — a pattern to eyeball, not a dependency. A high share is a candidate to compose into one workflow.') +
      '<div id="sk-cooc"></div>' +
      '</div>';
  }

  // --- Reference: the facts, then every invocation. ---

  // Facts grid: install/usage locations + timeline.
  html += '<div class="sk-card">' +
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

  // Invocations list — every call, each opening the session scrolled to that call.
  if (r.calls > 0) {
    html += '<div class="sk-card">' +
      '<div class="sk-sect-h">Invocations</div>' +
      '<div class="sk-sect-note">Each row opens the session and scrolls to where the skill was invoked.' +
        (r.calls > 100 ? ' Showing the 100 most recent of ' + num(r.calls) + '.' : '') + '</div>' +
      '<div class="sk-invocations" id="sk-invocations"><div class="sk-empty">Loading invocations…</div></div>' +
      '<div class="sk-actions"><a class="sk-view-sessions" data-name="' + esc(r.name) + '">Open these in the Sessions tab →</a></div>' +
      '</div>';
  }

  box.innerHTML = html;

  // Wire the (container-scoped) handlers.
  var back = box.querySelector('#sk-back');
  if (back) back.onclick = function () { openSkill(null); };
  var vs = box.querySelector('.sk-view-sessions');
  if (vs) vs.onclick = function () { filterBySkill(this.getAttribute('data-name')); };

  if (r.calls > 0) {
    wireTrendTooltip();
    // Load the invocations list + co-occurrence + outcomes async (page paints instantly).
    loadInvocations(r.name);
    loadCoOccurrence(r.name);
    loadOutcomes(r.name);
  }
  // Drift loads regardless of window (edit-anchored) — even an unused-in-window skill
  // may have a meaningful version history worth showing.
  loadDrift(r.name);
}

// Fetch + render the co-occurrence list (windowed). Hidden unless another skill shares
// a session. Each row is a compose candidate, framed as a pattern not a dependency.
function loadCoOccurrence(name) {
  get('/api/skill-cooccurrence?name=' + encodeURIComponent(name) + '&' + skWinQuery()).then(function (d) {
    if (state.skill !== name) return;
    var sect = $('#sk-cooc-sect');
    var host = $('#sk-cooc');
    if (!sect || !host) return;
    if (!d || !d.items || !d.items.length) return;
    host.innerHTML = d.items.map(function (it) { return cooccRow(it, name); }).join('');
    sect.style.display = '';
    // Clicking a co-occurring skill navigates to its own detail page (keeps the window).
    Array.prototype.forEach.call(host.querySelectorAll('.sk-cooc'), function (el) {
      el.onclick = function () { openSkill(this.getAttribute('data-name')); };
    });
  }).catch(function () { /* leave hidden on error */ });
}

// Fetch + render the LLM-classified activation outcomes (windowed). Hidden unless the
// classifier produced verdicts. Framed observationally, never as a causal verdict.
function loadOutcomes(name) {
  get('/api/skill-outcomes?name=' + encodeURIComponent(name) + '&' + skWinQuery()).then(function (d) {
    if (state.skill !== name) return;
    var sect = $('#sk-oc-sect');
    var host = $('#sk-oc');
    if (!sect || !host) return;
    if (!d || !d.classified) return; // classifier hasn't covered this skill → stay hidden
    host.innerHTML = outcomesHtml(d);
    sect.style.display = '';
    // "Show N more" toggle for the bypassed/reworked evidence beyond the top 3.
    var moreBtn = host.querySelector('.sk-oc-more');
    if (moreBtn) moreBtn.onclick = function () {
      var rest = host.querySelector('.sk-oc-rest');
      if (rest) rest.classList.add('on');
      this.remove();
    };
    // Each linked example opens the session transcript at the judged tool call.
    Array.prototype.forEach.call(host.querySelectorAll('.sk-oc-ex[data-session]'), function (el) {
      el.onclick = function () {
        openDetail(this.getAttribute('data-session'), { toolTarget: parseInt(this.getAttribute('data-idx'), 10) });
      };
    });
  }).catch(function () { /* leave hidden on error */ });
}

var OUTCOME_META = {
  used: { label: 'Followed', color: 'var(--emerald)' },
  reworked: { label: 'Reworked', color: 'var(--amber)' },
  ignored: { label: 'Bypassed', color: 'var(--red)' },
  unclear: { label: 'Unclear', color: 'var(--gray)' }
};

function outcomesHtml(d) {
  var total = d.classified || 1;
  var bypassed = d.bypassed || 0;
  var bypassPct = Math.round((bypassed / total) * 100);

  // Headline (C): does the skill pull its weight? Lead with the bypass rate — the one
  // actionable number — instead of a mostly-"used" bar.
  var verdict, vClass;
  if (bypassPct >= 50) { verdict = 'Often bypassed'; vClass = 'sk-w-bad'; }
  else if (bypassPct >= 20) { verdict = 'Sometimes reworked'; vClass = 'sk-w-warn'; }
  else { verdict = 'Mostly followed'; vClass = 'sk-w-ok'; }
  var html = '<div class="sk-weight ' + vClass + '">' +
    '<span class="sk-weight-v">' + esc(verdict) + '</span>' +
    '<span class="sk-weight-d">The agent bypassed or reworked its output in <b>' + num(bypassed) + ' of ' + num(total) +
      '</b> judged invocation' + (total === 1 ? '' : 's') + ' (' + bypassPct + '%).</span>' +
    '</div>';

  // The full breakdown, still a stacked proportion bar + legend, but secondary now.
  var order = ['used', 'reworked', 'ignored', 'unclear'];
  var seg = order.map(function (k) {
    var n = d[k] || 0;
    if (!n) return '';
    var pct = (n / total) * 100;
    var m = OUTCOME_META[k];
    return '<span class="sk-oc-seg" style="width:' + pct + '%;background:' + m.color + '" title="' + esc(m.label) + ': ' + num(n) + '"></span>';
  }).join('');
  var legend = order.filter(function (k) { return (d[k] || 0) > 0; }).map(function (k) {
    var n = d[k] || 0;
    var m = OUTCOME_META[k];
    return '<span class="sk-oc-leg"><span class="sk-oc-dot" style="background:' + m.color + '"></span>' +
      esc(m.label) + ' ' + Math.round((n / total) * 100) + '% <span class="sk-oc-legn">(' + num(n) + ')</span></span>';
  }).join('');
  html += '<div class="sk-oc-bar">' + seg + '</div>' +
    '<div class="sk-oc-legend">' + legend + '</div>';

  if (d.userCorrectionAdjacent > 0) {
    html += '<div class="sk-oc-corr">⚠ A user correction landed adjacent to ' +
      num(d.userCorrectionAdjacent) + ' of ' + num(d.classified) + ' invocations.</div>';
  }

  // Evidence — only the actionable cases (reworked / bypassed); top 3, with a "more" toggle
  // for the rest. Followed examples aren't actionable (the bar + legend cover that share).
  if (d.examples && d.examples.length) {
    var actionable = d.examples.filter(function (e) { return e.outcome === 'reworked' || e.outcome === 'ignored'; });
    if (actionable.length) {
      var exHtml = function (e) {
        var m = OUTCOME_META[e.outcome] || OUTCOME_META.unclear;
        // Clickable when the verdict carries its firing's location — opens the session
        // transcript scrolled to that tool call, same affordance as the invocations list.
        var linked = e.sessionId != null && e.idx != null;
        var tag = linked ? 'button type="button"' : 'div';
        return '<' + tag + ' class="sk-oc-ex"' +
          (linked ? ' data-session="' + esc(e.sessionId) + '" data-idx="' + esc(String(e.idx)) + '"' : '') + '>' +
          '<span class="sk-oc-ex-tag" style="color:' + m.color + '">' + esc(m.label) + '</span>' +
          '<span class="sk-oc-ex-txt">' + esc(e.evidence) + '</span>' +
          (linked ? '<span class="sk-oc-ex-go">open ↗</span>' : '') +
          '</' + (linked ? 'button' : 'div') + '>';
      };
      var HEAD = 3;
      var head = actionable.slice(0, HEAD).map(exHtml).join('');
      var rest = actionable.slice(HEAD).map(exHtml).join('');
      html += '<div class="sk-oc-examples">' + head +
        (rest ? '<div class="sk-oc-rest">' + rest + '</div>' +
          '<button type="button" class="sk-oc-more" aria-expanded="false">Show ' + num(actionable.length - HEAD) + ' more</button>' : '') +
        '</div>';
    }
  }

  html += '<div class="sk-sect-note">Judged ' + num(d.classified) + ' invocation' + (d.classified === 1 ? '' : 's') + ' in this window.' +
    (d.insufficientContext > 0
      ? ' ' + num(d.insufficientContext) + ' more had too little captured context to judge and ' +
        (d.insufficientContext === 1 ? 'was' : 'were') + ' excluded.'
      : '') +
    '</div>';
  return html;
}

function cooccRow(it, ownName) {
  var pct = Math.round((it.share || 0) * 100);
  var first = it.precededSessions > 0 && it.precededSessions >= it.sessions / 2
    ? '<span class="sk-cooc-first" title="Fired before ' + esc(ownName) + ' in ' + num(it.precededSessions) + ' of ' + num(it.sessions) + ' shared sessions">often first</span>'
    : '';
  return '<button class="sk-cooc" data-name="' + esc(it.name) + '">' +
    '<span class="sk-cooc-name mono">' + esc(it.name) + '</span>' +
    '<span class="sk-cooc-track"><span class="sk-cooc-bar" style="width:' + Math.max(2, pct) + '%"></span></span>' +
    '<span class="sk-cooc-meta">' + num(it.sessions) + (it.sessions === 1 ? ' session' : ' sessions') + ' · ' + pct + '%</span>' +
    first +
    '<span class="sk-cooc-go">view ↗</span>' +
    '</button>';
}

// Monotonic token so a slow earlier fetch can't clobber a newer location switch.
var skDriftReq = 0;

// Fetch + render the version-drift section at one install location (scopeKey; default = busiest
// with history). Shown when ANY location has a multi-version history — the chooser reaches it.
function loadDrift(name, scopeKey?) {
  var req = ++skDriftReq;
  var q = '/api/skill-drift?name=' + encodeURIComponent(name) + (scopeKey ? '&scopeKey=' + encodeURIComponent(scopeKey) : '');
  get(q).then(function (d) {
    if (state.skill !== name || req !== skDriftReq) return; // navigated away, or a newer request superseded this
    var sect = $('#sk-drift-sect');
    var host = $('#sk-drift');
    if (!sect || !host) return;
    // Show the section when any install location has an edit history worth comparing.
    var anyHistory = d && d.locations && d.locations.some(function (l) { return l.versionCount > 1; });
    if (!d || d.noHistory || !anyHistory) return;
    host.innerHTML = driftHtml(d);
    sect.style.display = '';
    // Wire the location chooser (only present when >1 location).
    var locSel = host.querySelector('#sk-drift-loc');
    if (locSel) locSel.onchange = function () { loadDrift(name, this.value); };
  }).catch(function () { /* leave the section hidden on error */ });
}

// The drift section: "Around the last edit" (what changed + current-vs-previous rates), then
// the version timeline. Correlation, never causation.
function driftHtml(d) {
  var html = '';
  var locs = (d && d.locations) || [];

  // Location chooser — same name in >1 install is >1 timeline; each option labelled version + calls.
  if (locs.length > 1) {
    var opts = locs.map(function (l) {
      var meta = l.versionCount + (l.versionCount === 1 ? ' version' : ' versions') + ' · ' + num(l.calls) + (l.calls === 1 ? ' call' : ' calls');
      return '<option value="' + esc(l.scopeKey) + '"' + (l.scopeKey === d.scopeKey ? ' selected' : '') + '>' + esc(l.label) + ' (' + meta + ')</option>';
    }).join('');
    html += '<div class="sk-drift-loc-row"><span class="flt-lbl">Installed in</span>' +
      '<select id="sk-drift-loc">' + opts + '</select></div>';
  }

  // Name the location so its numbers aren't read as the cross-repo roster counts.
  html += '<div class="sk-sect-note">' + (d.repo
    ? 'Version history for this skill in <b>' + esc(d.repo) + '</b>. A same-named skill in another repo is tracked separately' + (locs.length > 1 ? ' — switch above' : '') + '.'
    : 'Version history for this globally-installed skill (one shared body across repos).') + '</div>';

  var delta = d.delta;
  if (delta) {
    html += '<div class="sk-drift-delta">' +
      '<div class="sk-drift-delta-h">Around the last edit · ' + esc(String(delta.editIso).slice(0, 10)) + '</div>' +
      driftChangeHtml(delta);
    if (delta.enoughData) {
      html += '<div class="sk-drift-cmp">' +
          driftRate('Own-call errors', delta.before, delta.after, 'errorCalls') +
          driftRate('Bypassed by agent', delta.before, delta.after, 'bypassed') +
          driftTraction(delta.before, delta.after) +
        '</div>' +
        '<div class="sk-sect-note">Each version measured over its <b>own full lifetime</b>. Rates and per-week traction make the two comparable despite different ages. This is <b>correlation, not causation</b> — behaviour that changed <i>after</i> the edit, not proof the edit caused it.</div>';
    } else {
      html += '<div class="sk-sect-note">Not enough usage on both versions yet to compare rates (need ' + num(3) + '+ invocations each). The change is shown above; check back once the new version has been used more.</div>';
    }
    html += '</div>';
  }

  // Chosen location may be single-version while another has the history — point to the chooser.
  if (d.singleVersion && locs.length > 1) {
    html += '<div class="sk-sect-note">This install has just one version (never edited here). Switch location above to see where it was edited.</div>';
  }

  // Version timeline: one row per captured version, newest first, each annotated with what
  // it changed, its traction, and (when judged) its outcome rate.
  var vs = d.versions.slice().reverse();
  html += '<div class="sk-vers">';
  for (var i = 0; i < vs.length; i++) {
    var v = vs[i];
    var span = String(v.startIso).slice(0, 10) + ' → ' + (v.endIso ? String(v.endIso).slice(0, 10) : 'now');
    var label = v.current ? 'current' : 'v' + (vs.length - i);
    html += '<div class="sk-ver' + (v.current ? ' sk-ver-cur' : '') + '">' +
      '<div class="sk-ver-tag">' + esc(label) + '</div>' +
      '<div class="sk-ver-main">' +
        '<div class="sk-ver-span">' + esc(span) + changeBadge(v.change) + '</div>' +
        '<div class="sk-ver-stats">' + verStatsHtml(v) + '</div>' +
      '</div>' +
      '<div class="sk-ver-hash mono" title="body hash">' + esc(String(v.bodyHash).slice(0, 8) || '—') + '</div>' +
      '</div>';
  }
  html += '</div>';
  html += '<div class="sk-sect-note">Versions come from config snapshots, so history is only as fine-grained as your analyze cadence — edits between two runs collapse into one.</div>';
  return html;
}

// The "what changed" block: description before→after when reworded, then the body diff inline
// (reusing the Sessions file-changes view). Summary states the +N/−M counts.
function driftChangeHtml(delta) {
  var html = '';

  // Description reword — shown as its own before→after, since a description change alone
  // starts a new version (it steers the agent) and wouldn't show up in the body diff.
  if ((delta.descBefore || '') !== (delta.descAfter || '')) {
    html += '<div class="sk-chg-block"><div class="sk-chg-lbl">Description</div>' +
      '<div class="fc-diff">' +
        diffRowHtml('-', delta.descBefore || '(none)') +
        diffRowHtml('+', delta.descAfter || '(none)') +
      '</div></div>';
  }

  // Body diff summary + inline diff. Counts come from the server (exact, over the full diff);
  // we never recount the rows — those may include collapsed '@' gaps and omit nothing anyway.
  var add = delta.diffAdded || 0, del = delta.diffRemoved || 0;
  var parts = [];
  if (add) parts.push('<span class="sk-diff-add">+' + num(add) + '</span>');
  if (del) parts.push('<span class="sk-diff-del">−' + num(del) + '</span>');
  var summary = parts.length ? parts.join(' ') + ' lines' : (delta.diffSkipped ? 'body changed (too large to diff)' : 'body unchanged');

  html += '<div class="sk-chg-block"><div class="sk-chg-lbl">Body <span class="sk-diff-sum">' + summary + '</span></div>';
  // Only render the diff box when the body actually changed — an unchanged body would just
  // dump the whole file as gray context (noise); the "body unchanged" summary says enough.
  if ((add || del) && delta.diff && delta.diff.length) {
    var rowsHtml = '';
    for (var i = 0; i < delta.diff.length; i++) rowsHtml += diffRowHtml(delta.diff[i].t, delta.diff[i].s);
    html += '<div class="fc-diff">' + rowsHtml + '</div>';
  }
  html += '</div>';
  return html;
}

// One diff row in the shared file-changes style (matches sessions' rowHtml): gutter sign + line
// text, the row background carrying the add/del highlight. A '@' row is a collapsed-context separator.
function diffRowHtml(t, s) {
  if (t === '@') return '<div class="dl sep">⋯ ' + esc(s == null ? '' : s) + '</div>';
  var cls = t === '+' ? 'add' : t === '-' ? 'del' : 'ctx';
  var gut = t === '+' ? '+' : t === '-' ? '−' : ' ';
  return '<div class="dl ' + cls + '"><span class="dg">' + gut + '</span><span class="dt">' + esc(s == null ? '' : s) + '</span></div>';
}

// A per-invocation rate cell (before → after), lower is better. Both error and bypass rates use
// the version's own `calls` as denominator, so the `enoughData` gate (calls >= MIN_DRIFT_CALLS)
// covers both. A version with no outcome data at all shows '—' (a real 0% would be fabricated).
function driftRate(label, before, after, key) {
  var rate = function (u) {
    if (key === 'errorCalls') return u.calls ? Math.round((u.errorCalls / u.calls) * 100) : 0;
    // Bypass over ALL calls; null only when the classifier produced no verdict for this version.
    var oc = u.outcomes;
    if (!oc) return null;
    return u.calls ? Math.round((oc.bypassed / u.calls) * 100) : 0;
  };
  var bp = rate(before), ap = rate(after);
  // Bypass rate can be null (no judged outcomes on a side) — say so rather than show a fake 0%.
  if (bp == null || ap == null) {
    return driftCell(label, bp == null ? '—' : bp + '%', ap == null ? '—' : ap + '%', '');
  }
  var dir = ap > bp ? ' sk-drift-worse' : ap < bp ? ' sk-drift-better' : '';
  return driftCell(label, bp + '%', ap + '%', dir);
}

// The traction cell: invocations per week, before → after. Higher is neutral-good (more use),
// so we colour an increase green and a drop amber-ish via the same worse/better classes.
function driftTraction(before, after) {
  var fmt = function (n) { return (Math.round((n || 0) * 10) / 10) + '/wk'; };
  var b = before.callsPerWeek || 0, a = after.callsPerWeek || 0;
  var dir = a > b ? ' sk-drift-better' : a < b ? ' sk-drift-worse' : '';
  return driftCell('Traction', fmt(b), fmt(a), dir);
}

function driftCell(label, bs, as, dir) {
  return '<div class="sk-drift-metric">' +
    '<div class="sk-drift-metric-l">' + esc(label) + '</div>' +
    '<div class="sk-drift-metric-v">' + esc(bs) + ' <span class="sk-drift-arrow' + dir + '">→</span> <b class="' + dir.trim() + '">' + esc(as) + '</b></div>' +
    '</div>';
}

// A compact "what this version changed" badge for a timeline row (null for the first version).
function changeBadge(change) {
  if (!change) return '';
  var bits = [];
  if (change.added) bits.push('<span class="sk-diff-add">+' + num(change.added) + '</span>');
  if (change.removed) bits.push('<span class="sk-diff-del">−' + num(change.removed) + '</span>');
  if (change.descChanged) bits.push('<span class="sk-chg-desc">description</span>');
  if (!bits.length) return '';
  return ' <span class="sk-ver-chg" title="what changed from the previous version">' + bits.join(' ') + '</span>';
}

// A version row's stats line: traction, outcome (bypass) rate, own-call error rate — each
// omitted when there isn't enough data to state it honestly.
function verStatsHtml(v) {
  var bits = [];
  bits.push(num(v.usage.calls) + ' call' + (v.usage.calls === 1 ? '' : 's'));
  if (v.usage.calls) bits.push((Math.round((v.callsPerWeek || 0) * 10) / 10) + '/wk');
  if (v.enoughData) {
    bits.push(Math.round((v.usage.errorCalls / Math.max(1, v.usage.calls)) * 100) + '% errored');
    // Bypass over ALL calls (same denominator as errored + the headline), when judged at all.
    if (v.outcomes) {
      bits.push(Math.round((v.outcomes.bypassed / Math.max(1, v.usage.calls)) * 100) + '% bypassed');
    }
  } else {
    bits.push('too few to rate');
  }
  return esc(bits.join(' · '));
}

// Fetch + render the invocations list for a skill, in the current window. Each row
// opens the session drawer scrolled to that skill's tool call (txtool-<idx>).
function loadInvocations(name) {
  var host = $('#sk-invocations');
  if (!host) return;
  get('/api/skill-invocations?name=' + encodeURIComponent(name) + '&' + skWinQuery()).then(function (list) {
    // The page may have navigated away (or to another skill) while this was in flight.
    if (state.skill !== name) return;
    host = $('#sk-invocations');
    if (!host) return;
    var rows = list || [];
    if (!rows.length) { host.innerHTML = '<div class="sk-empty">No invocations in this window.</div>'; return; }
    host.innerHTML = rows.map(invocationRow).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.sk-inv'), function (el) {
      el.onclick = function () {
        openDetail(this.getAttribute('data-session'), { toolTarget: parseInt(this.getAttribute('data-idx'), 10) });
      };
    });
  }).catch(function () {
    var h = $('#sk-invocations');
    if (h) h.innerHTML = '<div class="sk-empty">Could not load invocations.</div>';
  });
}

function invocationRow(o) {
  var when = o.ts ? String(o.ts).slice(0, 10) : '—';
  var tags = '';
  if (o.sidechain) tags += '<span class="sk-inv-tag sk-inv-sub" title="Fired inside a subagent, not the main conversation.">subagent</span>';
  if (o.isError) tags += '<span class="sk-inv-tag sk-inv-err">errored</span>';
  return '<button class="sk-inv" data-session="' + esc(o.sessionId) + '" data-idx="' + esc(String(o.idx)) + '">' +
    '<span class="sk-inv-title">' + esc(o.title || o.sessionId) + '</span>' +
    '<span class="sk-inv-tags">' + tags + '</span>' +
    (o.repo ? '<span class="sk-inv-repo">' + esc(o.repo) + '</span>' : '') +
    '<span class="sk-inv-date">' + esc(when) + '</span>' +
    '<span class="sk-inv-go">open ↗</span>' +
    '</button>';
}

// A horizontal bar per repo (invocation count), widest = most-used. The scope-down
// colour is used when the skill carries that flag, so the evidence and the verdict
// read as one. The null-repo (unattributed) bucket is labelled explicitly.
function repoBreakdown(r) {
  var rows = r.perRepo || [];
  var max = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].calls > max) max = rows[i].calls;
  if (max <= 0) max = 1;
  var scoped = hasFlag(r, 'scope-down');
  var barColor = scoped ? (FLAGS['scope-down'] && FLAGS['scope-down'].color) || 'var(--amber)' : 'var(--emerald)';
  return '<div class="sk-repos">' + rows.map(function (p) {
    var label = p.repo == null ? 'unattributed' : p.repo;
    var pct = Math.max(2, Math.round((p.calls / max) * 100));
    var sub = num(p.calls) + (p.calls === 1 ? ' call' : ' calls') + ' · ' + num(p.sessions) + (p.sessions === 1 ? ' session' : ' sessions');
    return '<div class="sk-repo' + (p.repo == null ? ' sk-repo-null' : '') + '">' +
      '<div class="sk-repo-name" title="' + esc(label) + '">' + esc(label) + '</div>' +
      '<div class="sk-repo-track"><div class="sk-repo-bar" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
      '<div class="sk-repo-n">' + esc(sub) + '</div>' +
      '</div>';
  }).join('') + '</div>';
}

// The one-line takeaway under the bars: "used in N of M active repos", and — when
// scope-down — that the other repos load it but never use it.
function repoBreakdownNote(r) {
  var usedRepos = 0;
  var rows = r.perRepo || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].repo != null) usedRepos++;
  var total = skReport && skReport.totalActiveRepos ? skReport.totalActiveRepos : usedRepos;
  var base = 'Invoked in ' + num(usedRepos) + ' of ' + num(total) + ' repos active in this window.';
  if (hasFlag(r, 'scope-down') && r.scopeToRepos && r.scopeToRepos.length) {
    var others = Math.max(0, total - r.scopeToRepos.length);
    if (others > 0) base += ' The other ' + num(others) + ' load it globally but never invoke it — a candidate to scope down to ' + r.scopeToRepos.join(', ') + '.';
  }
  return base;
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

// The one actionable sentence — status first, then the most useful flag hint. For an
// unused skill the advice depends on enoughData: only recommend removal once enough
// sessions have been observed to trust the absence (else suggest widening the window).
function advice(r) {
  if (r.status === 'unused') {
    return r.enoughData
      ? 'Not invoked in this window. Consider removing it to trim startup overhead — or, if you expected it to fire, its description may not be matching your prompts.'
      : 'Not invoked in this window — but too few sessions here to say whether that\'s real disuse or just a quiet stretch. Widen the window before deciding to remove it.';
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
  return 'Actively used.';
}

// A section header with a small "?" info affordance carrying the explanation as a
// hover tooltip — keeps the page uncluttered vs a paragraph of prose under every section.
function sectHead(label, tip) {
  return '<div class="sk-sect-h">' + esc(label) +
    (tip ? ' <span class="sk-info" title="' + esc(tip) + '">?</span>' : '') + '</div>';
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

// The trend granularity word for the caption, inferred from the bucket width.
function trendGranLabel(buckets) {
  if (!buckets || buckets.length < 1) return 'period';
  var days = (buckets[0].endMs - buckets[0].startMs) / 86400000;
  return days <= 1.5 ? 'day' : days <= 8 ? 'week' : 'month';
}

// A bucket's full date-range label for the tooltip: "Jul 8" (day) or "Jul 8 – Jul 14".
function bucketRange(b) {
  var fmt = function (ms) { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  var days = (b.endMs - b.startMs) / 86400000;
  return days <= 1.5 ? fmt(b.startMs) : fmt(b.startMs) + ' – ' + fmt(b.endMs - 86400000);
}

// The Usage-trend bar chart. Bars align 1:1 with the report's calendar buckets; every
// bar carries data-* so wireTrendTooltip() can show an exact "date: N invocations" on
// hover. A count Y-axis (0/mid/max) + evenly-spaced date x-ticks make it readable — a
// real chart, not the roster's bare sparkline. Sized generously for the detail page.
function trendChart(spark, buckets) {
  var vals = spark || [];
  var n = buckets && buckets.length ? buckets.length : vals.length;
  var max = 0;
  for (var i = 0; i < n; i++) if ((vals[i] || 0) > max) max = vals[i];
  max = max || 1;
  var W = 860, H = 220, padL = 34, padR = 12, padT = 14, padB = 34;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var base = padT + plotH, bw = plotW / n;
  var yOf = function (v) { return padT + (1 - v / max) * plotH; };
  var svg = '<svg class="sk-trend-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';

  // Y gridlines + integer count labels. Cap the tick set so counts stay whole.
  var yTicks = max <= 4 ? range0(max) : [0, Math.round(max / 2), max];
  yTicks.forEach(function (v) {
    var y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--line)"/>';
    svg += '<text class="sk-trend-ax" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
  });

  // Bars — every bucket (0-height buckets just render nothing but hold their slot),
  // each an invisible full-height hit target + the visible bar, both carrying data-*.
  var xStep = Math.max(1, Math.ceil(n / 8)); // ~8 x-labels max
  for (var b = 0; b < n; b++) {
    var x = padL + b * bw, w = Math.max(2, bw - 3), bx = x + (bw - w) / 2;
    var c = vals[b] || 0;
    var bk = buckets[b];
    var range = bk ? bucketRange(bk) : '';
    var tipCount = c + ' invocation' + (c === 1 ? '' : 's');
    // Full-height transparent hover zone so hovering the empty space above a short bar still works.
    svg += '<rect class="sk-trend-hit" x="' + x.toFixed(1) + '" y="' + padT + '" width="' + bw.toFixed(1) + '" height="' + plotH +
      '" fill="transparent" data-range="' + esc(range) + '" data-count="' + esc(tipCount) + '"></rect>';
    if (c > 0) {
      var top = yOf(c);
      svg += '<rect class="sk-trend-bar" x="' + bx.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + (base - top).toFixed(1) + '" rx="2" fill="var(--emerald)"></rect>';
    }
    // Evenly-spaced date ticks along the x-axis.
    if (bk && (b % xStep === 0 || b === n - 1)) {
      var lbl = new Date(bk.startMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      var anchor = b === 0 ? 'start' : b === n - 1 ? 'end' : 'middle';
      var tx = anchor === 'start' ? padL : anchor === 'end' ? W - padR : x + bw / 2;
      svg += '<text class="sk-trend-ax" x="' + tx.toFixed(1) + '" y="' + (H - 12) + '" text-anchor="' + anchor + '">' + esc(lbl) + '</text>';
    }
  }
  svg += '</svg>';
  return svg;
}

// [0..max] inclusive, integers — the small-range Y tick set.
function range0(max) { var a = []; for (var i = 0; i <= max; i++) a.push(i); return a; }

// Wire the trend chart's floating tooltip: hovering any bucket hit-zone shows a
// positioned box with the date range + exact invocation count. One shared tooltip
// element, positioned at the cursor; hidden on mouseleave.
function wireTrendTooltip() {
  var wrap = $('#sk-trend');
  if (!wrap) return;
  var tip = document.createElement('div');
  tip.className = 'sk-trend-tip';
  tip.style.display = 'none';
  wrap.appendChild(tip);
  Array.prototype.forEach.call(wrap.querySelectorAll('.sk-trend-hit'), function (hit) {
    hit.onmousemove = function (e) {
      tip.innerHTML = '<b>' + esc(hit.getAttribute('data-range')) + '</b><br>' + esc(hit.getAttribute('data-count'));
      tip.style.display = 'block';
      var wr = wrap.getBoundingClientRect();
      tip.style.left = (e.clientX - wr.left + 12) + 'px';
      tip.style.top = (e.clientY - wr.top + 12) + 'px';
    };
    hit.onmouseleave = function () { tip.style.display = 'none'; };
  });
}
