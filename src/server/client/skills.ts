// Skill Health tab: a per-skill roster built from real sessions — trigger
// frequency (with a sparkline), a used/dead/idle/scope verdict, own-call error
// rate, and a clearly-LABELLED friction-adjacency proxy. Plus each skill's
// SKILL.md description. Deliberately makes NO per-skill cost claim (tokens aren't
// attributable to a tool call — see src/server/skill-health.ts).
//
// All DOM classes are `sk-`-prefixed and all handlers are wired by querying
// WITHIN this tab's container, never a global querySelectorAll — so the Sessions
// tab's global .facet-filter/.srow handlers can't clobber them (and vice-versa).
import { state, $, esc, num, get } from './core';
import { filterBySkill } from './sessions';

// Cached report (one fetch; re-render is cheap). Refetched only if the store changes.
var skReport = null;
// Active roster filter: '' = all, or a verdict key.
var skFilter = '';
// Expanded skill name (single-open accordion), or null.
var skOpen = null;

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

  // Row click → toggle the detail accordion (single-open). Scoped to this host.
  Array.prototype.forEach.call(host.querySelectorAll('.sk-row-head'), function (el) {
    el.onclick = function () {
      var name = this.getAttribute('data-name');
      skOpen = (skOpen === name) ? null : name;
      renderSkRoster(rows); // repaint to open/close; cheap
    };
  });
  // "View sessions →" inside an open detail → drill into the Sessions tab.
  Array.prototype.forEach.call(host.querySelectorAll('.sk-view-sessions'), function (el) {
    el.onclick = function (e) {
      e.stopPropagation();
      filterBySkill(this.getAttribute('data-name'));
    };
  });
}

function skRow(r) {
  var v = VERDICTS[r.verdict] || VERDICTS.idle;
  var isOpen = skOpen === r.name;
  var errRate = r.calls > 0 ? Math.round((r.errorCalls / r.calls) * 100) : 0;
  var fricRate = r.calls > 0 ? Math.round((r.frictionAdjacent / r.calls) * 100) : 0;

  var head = '<div class="sk-row-head" data-name="' + esc(r.name) + '" title="' + esc(v.tip) + '">' +
    '<span class="sk-dot" style="background:' + v.color + '"></span>' +
    '<span class="sk-name">' + esc(r.name) + '</span>' +
    '<span class="sk-verdict" style="color:' + v.color + '">' + esc(v.label) + '</span>' +
    '<span class="sk-spark">' + sparkline(r.spark) + '</span>' +
    '<span class="sk-metric"><span class="sk-mv">' + num(r.calls) + '</span><span class="sk-ml">calls</span></span>' +
    '<span class="sk-metric"><span class="sk-mv">' + num(r.sessions) + '</span><span class="sk-ml">sessions</span></span>' +
    '<span class="sk-caret">' + (isOpen ? '▾' : '▸') + '</span>' +
    '</div>';

  if (!isOpen) return '<div class="sk-row">' + head + '</div>';

  // Expanded detail: description, scope/install info, and the honest metric grid.
  var detail = '<div class="sk-detail">';
  if (r.description) detail += '<div class="sk-desc">' + esc(r.description) + '</div>';
  else detail += '<div class="sk-desc sk-desc-none">No description in SKILL.md frontmatter.</div>';

  detail += '<div class="sk-facts">';
  detail += fact('Install scope', r.installed ? (r.scope === 'global' ? 'Global' : 'Project') : 'Not installed');
  if (r.installedRepos && r.installedRepos.length) detail += fact('Installed in', r.installedRepos.join(', '));
  if (r.usedRepos && r.usedRepos.length) detail += fact('Used in', r.usedRepos.join(', '));
  if (r.calls > 0) {
    detail += fact('Own-call error rate', errRate + '% (' + num(r.errorCalls) + '/' + num(r.calls) + ')');
    detail += fact('Friction-adjacent', fricRate + '% (' + num(r.frictionAdjacent) + '/' + num(r.calls) + ')', 'proxy',
      'A skill invocation followed by an errored tool call within the same session. Adjacency only — NOT a judgment that the skill was wrong.');
    detail += fact('Last used', r.lastUsedAt ? String(r.lastUsedAt).slice(0, 10) : '—');
  }
  detail += '</div>';

  // Verdict-specific guidance (the actionable line).
  detail += '<div class="sk-advice">' + esc(advice(r)) + '</div>';

  if (r.calls > 0) {
    detail += '<div class="sk-actions"><a class="sk-view-sessions" data-name="' + esc(r.name) + '">View sessions that used it →</a></div>';
  }
  detail += '</div>';

  return '<div class="sk-row sk-row-open">' + head + detail + '</div>';
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
// there's no usage. Bars (not a line) read clearly at this size.
function sparkline(spark) {
  var vals = spark || [];
  var max = 0;
  for (var i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
  if (!max) return '<svg class="sk-spark-svg" width="90" height="20" aria-hidden="true"><line x1="0" y1="19" x2="90" y2="19" stroke="var(--line)" stroke-width="1"/></svg>';
  var n = vals.length, bw = 90 / n, bars = '';
  for (var j = 0; j < n; j++) {
    var h = vals[j] ? Math.max(2, Math.round((vals[j] / max) * 18)) : 0;
    if (!h) continue;
    bars += '<rect x="' + (j * bw).toFixed(1) + '" y="' + (19 - h) + '" width="' + Math.max(1, bw - 1).toFixed(1) +
      '" height="' + h + '" fill="var(--emerald)"></rect>';
  }
  return '<svg class="sk-spark-svg" width="90" height="20" aria-hidden="true">' + bars + '</svg>';
}
