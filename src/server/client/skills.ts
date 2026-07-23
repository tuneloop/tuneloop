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

// Cached report (one fetch; re-render is cheap). Refetched only if the store changes.
var skReport = null;
// Active roster filter: '' = all, or a verdict key.
var skFilter = '';

// Verdict presentation: label + dot color + one-line meaning for the legend/tooltip.
var VERDICTS = {
  active: { label: 'Active', color: 'var(--emerald)', tip: 'Installed and invoked in the window.' },
  scope: { label: 'Scope down', color: 'var(--amber)', tip: 'Global, but used in only a few repos — candidate to move into just those.' },
  dead: { label: 'Unused', color: 'var(--red)', tip: 'Installed but never invoked, with enough sessions observed to trust that.' },
  idle: { label: 'Too little data', color: 'var(--gray)', tip: 'Installed and unused, but too few sessions to judge — we abstain.' },
  unregistered: { label: 'Not in config', color: '#3b6ea5', tip: 'Seen running, but not in any current config snapshot (a plugin, or removed/relocated since it ran).' }
};

// Called once from main.ts to pre-render the tab (fetch + paint). Safe to call
// again; it repaints from cache without refetching.
export function renderSkills() {
  var box = $('#skills-health');
  if (!box) return;
  if (skReport) { paintSkills(); return; }
  box.innerHTML = '<div class="sk-empty">Loading skill health…</div>';
  get('/api/skill-health').then(function (d) {
    skReport = d || { rows: [] };
    paintSkills();
  }).catch(function () {
    box.innerHTML = '<div class="sk-empty">Could not load skill health.</div>';
  });
}

// Open a skill's detail page (or return to the roster when name is null). Mirrors
// openMetric: set state, sync the URL, repaint. Called by the router on navigation
// and by row/back clicks.
export function openSkill(name) {
  state.skill = name || null;
  syncHash(); // mirror #/skills/<name> into the URL (no-op while a route is applying)
  // Detail pages start at the top; the roster keeps its scroll.
  if (state.skill) window.scrollTo(0, 0);
  if (skReport) paintSkills();
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
  var rows = d.rows || [];
  var caption = 'Per-skill health over the last ' + esc(String(d.windowDays)) + ' days, from your real sessions. ' +
    'Frequency and errors are measured; the friction proxy is adjacency, not a quality verdict. No per-skill cost is shown — tokens aren\'t attributable to a single tool call.';

  box.innerHTML =
    '<div class="metric-head"><h2>Skill Health</h2></div>' +
    '<div class="sk-caption">' + caption + '</div>' +
    skTiles(d) +
    '<div class="sk-filterbar" id="sk-filterbar"></div>' +
    '<div class="sk-roster" id="sk-roster"></div>';

  renderSkFilterbar();
  renderSkRoster(rows);
}

// Summary tiles — the at-a-glance counts. Each (except Installed) is a clickable
// filter into the roster.
function skTiles(d) {
  var tile = function (key, label, value, sub) {
    var clickable = key ? ' sk-tile-click" data-filter="' + esc(key) : '';
    return '<div class="sk-tile' + clickable + '">' +
      '<div class="sk-tile-v">' + num(value) + '</div>' +
      '<div class="sk-tile-l">' + esc(label) + '</div>' +
      (sub ? '<div class="sk-tile-s">' + esc(sub) + '</div>' : '') +
      '</div>';
  };
  return '<div class="sk-tiles">' +
    tile('', 'Installed', d.totalInstalled, 'skills on disk') +
    tile('active', 'Active', d.totalActive, 'used in window') +
    tile('scope', 'Scope down', d.totalScope, 'used in few repos') +
    tile('dead', 'Unused', d.totalDead, 'never invoked') +
    tile('idle', 'Too little data', d.totalIdle, 'unused, thin data') +
    tile('unregistered', 'Not in config', d.totalUnregistered, 'ran, not installed') +
    '</div>';
}

function renderSkFilterbar() {
  var bar = $('#sk-filterbar');
  if (!bar) return;
  var chips = [['', 'All']].concat(Object.keys(VERDICTS).map(function (k) { return [k, VERDICTS[k].label]; }));
  bar.innerHTML = '<span class="sr-lbl">Show</span><span class="seg" id="sk-seg">' +
    chips.map(function (c) {
      return '<button class="' + (c[0] === skFilter ? 'on' : '') + '" data-filter="' + esc(c[0]) + '">' + esc(c[1]) + '</button>';
    }).join('') + '</span>';
  Array.prototype.forEach.call(bar.querySelectorAll('#sk-seg button'), function (b) {
    b.onclick = function () { skFilter = this.getAttribute('data-filter'); paintSkills(); };
  });
  // Tiles also filter (they carry data-filter). Scoped to this tab's container.
  var host = $('#skills-health');
  if (host) Array.prototype.forEach.call(host.querySelectorAll('.sk-tile-click'), function (t) {
    t.onclick = function () { skFilter = this.getAttribute('data-filter'); paintSkills(); };
  });
}

function renderSkRoster(rows) {
  var host = $('#sk-roster');
  if (!host) return;
  var shown = skFilter ? rows.filter(function (r) { return r.verdict === skFilter; }) : rows;
  if (!shown.length) {
    host.innerHTML = '<div class="sk-empty">No skills in this view.</div>';
    return;
  }
  host.innerHTML = shown.map(skRow).join('');

  // Row click → open the skill's detail page. Scoped to this host.
  Array.prototype.forEach.call(host.querySelectorAll('.sk-row-head'), function (el) {
    el.onclick = function () { openSkill(this.getAttribute('data-name')); };
  });
}

function skRow(r) {
  var v = VERDICTS[r.verdict] || VERDICTS.idle;
  return '<div class="sk-row">' +
    '<div class="sk-row-head" data-name="' + esc(r.name) + '" title="' + esc(v.tip) + '">' +
      '<span class="sk-dot" style="background:' + v.color + '"></span>' +
      '<span class="sk-name">' + esc(r.name) + '</span>' +
      '<span class="sk-verdict" style="color:' + v.color + '">' + esc(v.label) + '</span>' +
      '<span class="sk-spark">' + sparkline(r.spark) + '</span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.calls) + '</span><span class="sk-ml">calls</span></span>' +
      '<span class="sk-metric"><span class="sk-mv">' + num(r.sessions) + '</span><span class="sk-ml">sessions</span></span>' +
      '<span class="sk-caret">›</span>' +
    '</div>' +
    '</div>';
}

// ---- Per-skill detail page --------------------------------------------------

function paintSkillPage(box, r) {
  var v = VERDICTS[r.verdict] || VERDICTS.idle;
  var errRate = r.calls > 0 ? Math.round((r.errorCalls / r.calls) * 100) : 0;
  var fricRate = r.calls > 0 ? Math.round((r.frictionAdjacent / r.calls) * 100) : 0;

  var html = '';
  // Back link + heading with the verdict dot.
  html += '<div class="sk-page-head">' +
    '<button class="sk-back" id="sk-back">← All skills</button>' +
    '</div>';
  html += '<div class="sk-page-title">' +
    '<span class="sk-dot sk-dot-lg" style="background:' + v.color + '"></span>' +
    '<h2 class="sk-page-name">' + esc(r.name) + '</h2>' +
    '<span class="sk-verdict sk-verdict-lg" style="color:' + v.color + '" title="' + esc(v.tip) + '">' + esc(v.label) + '</span>' +
    '</div>';

  // Description (or its absence).
  if (r.description) html += '<div class="sk-desc">' + esc(r.description) + '</div>';
  else html += '<div class="sk-desc sk-desc-none">No description in SKILL.md frontmatter.</div>';

  // Headline metrics as full-size stat tiles (matches the product's KPI tiles).
  html += '<div class="sk-page-tiles">' +
    pageTile(num(r.calls), 'Invocations', 'in the last ' + num(skReport.windowDays) + ' days') +
    pageTile(num(r.sessions), 'Sessions', 'distinct sessions it ran in') +
    pageTile(r.calls > 0 ? errRate + '%' : '—', 'Own-call error rate', r.calls > 0 ? num(r.errorCalls) + ' of ' + num(r.calls) + ' calls errored' : 'no calls to measure') +
    pageTile(r.calls > 0 ? fricRate + '%' : '—', 'Friction-adjacent · PROXY', r.calls > 0 ? num(r.frictionAdjacent) + ' calls followed by an error' : 'no calls to measure') +
    '</div>';

  // Trend sparkline (larger than the roster's inline one).
  html += '<div class="sk-page-sect">' +
    '<div class="sk-sect-h">Usage trend</div>' +
    '<div class="sk-page-spark">' + sparkline(r.spark, 260, 44) + '</div>' +
    '<div class="sk-sect-note">Invocations bucketed across the ' + num(skReport.windowDays) + '-day window, oldest → newest.</div>' +
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

// The one actionable sentence per verdict.
function advice(r) {
  switch (r.verdict) {
    case 'dead':
      return 'Never invoked in the window. Consider removing it to trim startup overhead — or, if you expected it to fire, its description may not be matching your prompts.';
    case 'idle':
      return 'Installed but unused — too few sessions here to say whether that\'s disuse or just quiet. Revisit once you\'ve worked more in these repos.';
    case 'scope':
      return r.scopeToRepos && r.scopeToRepos.length
        ? 'Used in only: ' + r.scopeToRepos.join(', ') + '. Consider scoping it to those repos so the rest stop loading it.'
        : 'Used in only a few of your repos — consider scoping it down.';
    case 'unregistered':
      return 'Seen running but not found in your current config — likely a plugin-provided skill, or one removed/relocated since it last ran.';
    default:
      return 'Actively used. Frequency and error rate above are measured from real sessions.';
  }
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
