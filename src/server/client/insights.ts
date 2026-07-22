// The Insights tab — the detector ledger, as a filterable/sortable TABLE (mirrors
// the Sessions tab for a consistent product feel). Each ROW shows severity+title,
// recurrence (occurrences · sessions), last seen, an inline Copy-fix button, and
// lifecycle state. Clicking a row opens the insight DETAIL in the right drawer: the
// fix payload plus every occurrence (with its one-line note). Clicking an occurrence
// swaps the drawer to that session's transcript, scrolled to the exact turn, with a
// "← Insights" back button. Mutations: Copy fix (→ fix_issued) and Dismiss.
//
// Insights are few (a handful to a few dozen), so unlike Sessions we fetch once and
// filter/search/sort entirely client-side — no per-filter API round-trips.
import { $, esc, get, post, num, dayOf, renderMd } from './core';
import { openDetail, closeDrawer } from './sessions';

// A repo of '*' (or empty) means the pattern spans repos — "global". Most insights
// are global, so the row only shows a repo tag when it's genuinely repo-scoped.
function isGlobal(repo) { return !repo || repo === '*'; }
function repoLabel(repo) { return isGlobal(repo) ? 'global' : repo; }

function sevDot(s) { return '<span class="ins-dot sev-' + esc(s) + '" title="' + esc(s) + ' severity"></span>'; }
function stateBadge(s) { return '<span class="ins-state st-' + esc(s) + '">' + esc(String(s).replace(/_/g, ' ')) + '</span>'; }

// fix.type → rendering, per the detector contract: prose for a behavioral nudge,
// a code block for the paste/run payload types (config-snippet | install | fix-prompt).
function fixBody(fix) {
  if (fix.type === 'behavioral-nudge') return '<div class="ins-fix-prose">' + renderMd(fix.content) + '</div>';
  return '<pre class="md-code"><code>' + esc(fix.content) + '</code></pre>';
}

// Session ids are `<source>:<uuid>` — a short uuid prefix labels an occurrence
// when the session has no title.
function shortSession(id) {
  var parts = String(id).split(':');
  return (parts[parts.length - 1] || id).slice(0, 8);
}

// True session span for the recurrence column: the server's uncapped sessionCount.
// Falls back to distinct sessions in the capped evidence (a floor) only for older
// payloads that predate the field.
function sessionSpan(r) {
  if (typeof r.sessionCount === 'number') return r.sessionCount;
  var seen = {};
  (r.evidence || []).forEach(function (e) { seen[e.sessionId] = 1; });
  return Object.keys(seen).length;
}

// ---- detail (rendered into the drawer) --------------------------------------

function detailHtml(r, occ) {
  var head = '<div class="drawer-head ins-detail-head"><div class="drawer-head-top">' +
    '<h2>' + sevDot(r.severity) + esc(r.title) + '</h2>' +
    '<button class="x" type="button" id="drawerCloseBtn">close</button></div>' +
    '<div class="ins-detail-meta">' + stateBadge(r.state) +
      '<span class="tag">' + esc(repoLabel(r.repo)) + '</span> · ' +
      num(r.count) + ' occurrences · last seen ' + esc(dayOf(r.lastSeenAt)) + '</div>' +
    '</div>';

  var desc = '<div class="ins-desc">' + renderMd(r.description) + '</div>';

  var fix = r.fix && r.fix.content
    ? '<div class="ins-fix"><div class="ins-fix-head">' +
        '<span class="ins-fix-label">' + esc(r.fix.label || 'Suggested fix') + '</span>' +
        '<button type="button" class="ins-btn ins-copy">Copy fix</button></div>' +
        fixBody(r.fix) + '</div>'
    : '';

  // Evidence: one row per stored occurrence pointer, each opening the transcript at
  // the exact message. This is a capped sample of moments to drill into (one session
  // may appear more than once), NOT the recurrence count — that's r.count in the header.
  var occRows = (occ || []).map(function (e, j) {
    var title = e.sessionTitle ? esc(e.sessionTitle) : esc(shortSession(e.sessionId));
    var note = e.note ? '<div class="ins-occ-note">' + esc(e.note) + '</div>' : '';
    return '<button type="button" class="ins-occ" data-j="' + j + '" title="Open transcript at this message">' +
      note +
      '<div class="ins-occ-src"><span class="ins-occ-arrow">↳</span>' +
        '<span class="ins-occ-title">' + title + '</span>' +
        (e.turnIdx != null ? '<span class="ins-occ-turn">open ↗</span>' : '') +
      '</div></button>';
  }).join('');
  var occSection = '<div class="ins-occ-list"><div class="ins-section-label">Evidence (' +
    ((occ && occ.length) || 0) + ')</div>' +
    (occRows || '<div class="empty">No stored occurrences.</div>') + '</div>';

  var dismiss = '<div class="ins-detail-actions">' +
    '<button type="button" class="ins-btn ins-dismiss">Dismiss insight</button></div>';

  return head + '<div class="ins-detail-body">' + desc + fix + occSection + dismiss + '</div>';
}

// ---- state ------------------------------------------------------------------

var rows: any[] = [];       // all fetched insights (unfiltered)
var occCache: any = {};     // insightId → occurrences (fetched lazily on detail open)

// Client-side view controls (insights are few — filter/sort in the browser).
// `time` is a preset (7/14/30/90), 'all', or 'custom' (then from/to bound it).
var flt = { time: 'all', from: '', to: '', q: '', status: '', severity: '', repo: '' };
var sort = { key: 'default', dir: 'desc' }; // 'default' = API order (severity → recurrence → recency)

var SEV_RANK = { high: 0, medium: 1, low: 2 };
var TIME_PRESETS = [{ d: 7, l: '7d' }, { d: 14, l: '14d' }, { d: 30, l: '30d' }, { d: 90, l: '90d' }, { d: 'all', l: 'All' }, { d: 'custom', l: 'Custom' }];

export function renderInsights() {
  get('/api/insights').then(function (d) {
    rows = d || [];
    buildFilters();
    paint();
  });
}

// ---- filter bar (mirrors the Sessions .flt-* bar) ---------------------------

function distinct(key) {
  var seen = {}; var out: string[] = [];
  rows.forEach(function (r) { var v = r[key]; if (v != null && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

function buildFilters() {
  var host = $('#insights-filters');
  if (!host) return;

  var segBtns = TIME_PRESETS.map(function (p) {
    return '<button type="button" data-d="' + p.d + '"' +
      (String(p.d) === String(flt.time) ? ' class="on"' : '') + '>' + p.l + '</button>';
  }).join('');

  var statusOpts = ['surfaced', 'fix_issued', 'adopted', 'resolved'];
  // NOTE: use our OWN select class (`ins-facet`), NOT the sessions tab's
  // `facet-filter` — sessions.ts wires `document.querySelectorAll('.facet-filter')`
  // globally to its applyFilters(), which would clobber our onchange handlers.
  var statusSel = '<select class="ins-facet" id="ins-f-status"><option value="">Status: all</option>' +
    statusOpts.map(function (s) {
      return '<option value="' + esc(s) + '"' + (flt.status === s ? ' selected' : '') + '>' + esc(s.replace(/_/g, ' ')) + '</option>';
    }).join('') + '</select>';

  var sevOpts = ['high', 'medium', 'low'];
  var sevSel = '<select class="ins-facet" id="ins-f-sev"><option value="">Severity: all</option>' +
    sevOpts.map(function (s) {
      return '<option value="' + esc(s) + '"' + (flt.severity === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('') + '</select>';

  // Repo dropdown: only meaningful when some insight is repo-scoped; most are global.
  var repos = distinct('repo').filter(function (v) { return !isGlobal(v); });
  var repoSel = repos.length
    ? '<select class="ins-facet" id="ins-f-repo"><option value="">Repo: all</option>' +
        repos.map(function (v) {
          return '<option value="' + esc(v) + '"' + (flt.repo === v ? ' selected' : '') + '>' + esc(v) + '</option>';
        }).join('') + '</select>'
    : '';

  host.innerHTML =
    '<div class="flt-row">' +
      '<span class="flt-grp"><span class="flt-lbl">Time</span>' +
        '<div class="seg flt-seg" id="ins-f-time">' + segBtns + '</div>' +
        '<span class="flt-dates" id="ins-f-dates"' + (flt.time === 'custom' ? '' : ' hidden') + '>' +
          '<input type="date" id="ins-f-from" value="' + esc(flt.from) + '" />' +
          '<span class="flt-dash">→</span>' +
          '<input type="date" id="ins-f-to" value="' + esc(flt.to) + '" />' +
        '</span>' +
      '</span>' +
      '<input id="ins-f-q" class="flt-search" placeholder="search insight / description" value="' + esc(flt.q) + '" />' +
    '</div>' +
    '<div class="flt-row flt-row-facets">' + statusSel + sevSel + repoSel + '</div>';

  Array.prototype.forEach.call(host.querySelectorAll('#ins-f-time button'), function (b) {
    b.onclick = function () {
      flt.time = b.getAttribute('data-d');
      Array.prototype.forEach.call(host.querySelectorAll('#ins-f-time button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var dates = $('#ins-f-dates');
      if (dates) dates.hidden = flt.time !== 'custom';
      paint();
    };
  });
  var from = $('#ins-f-from'); if (from) from.onchange = function () { flt.from = this.value; paint(); };
  var to = $('#ins-f-to'); if (to) to.onchange = function () { flt.to = this.value; paint(); };
  var q = $('#ins-f-q');
  if (q) { var t; q.oninput = function () { clearTimeout(t); t = setTimeout(function () { flt.q = q.value.trim().toLowerCase(); paint(); }, 200); }; }
  var st = $('#ins-f-status'); if (st) st.onchange = function () { flt.status = st.value; paint(); };
  var sv = $('#ins-f-sev'); if (sv) sv.onchange = function () { flt.severity = sv.value; paint(); };
  var rp = $('#ins-f-repo'); if (rp) rp.onchange = function () { flt.repo = rp.value; paint(); };
}

// ---- filter + sort ----------------------------------------------------------

function withinTime(r) {
  if (flt.time === 'all') return true;
  var last = r.lastSeenAt ? Date.parse(r.lastSeenAt) : 0;
  if (!last) return true; // never hide an insight with no date on us
  if (flt.time === 'custom') {
    // Bound by last-seen. from = start of that day; to = end of that day (inclusive).
    if (flt.from && last < Date.parse(flt.from + 'T00:00:00')) return false;
    if (flt.to && last > Date.parse(flt.to + 'T23:59:59.999')) return false;
    return true;
  }
  var days = parseInt(flt.time, 10);
  if (!days) return true;
  return (Date.now() - last) <= days * 864e5;
}

function matchesQ(r) {
  if (!flt.q) return true;
  return (String(r.title || '') + ' ' + String(r.description || '')).toLowerCase().indexOf(flt.q) !== -1;
}

function visibleRows() {
  var out = rows.filter(function (r) {
    return withinTime(r) && matchesQ(r) &&
      (!flt.status || r.state === flt.status) &&
      (!flt.severity || r.severity === flt.severity) &&
      (!flt.repo || r.repo === flt.repo);
  });
  var dir = sort.dir === 'asc' ? 1 : -1;
  // Missing/invalid dates → 0, so a null last-seen sorts as oldest rather than
  // yielding a NaN comparator (unstable ordering).
  var ms = function (s) { var t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
  if (sort.key === 'occ') out.sort(function (a, b) { return (a.count - b.count) * dir; });
  else if (sort.key === 'lastSeen') out.sort(function (a, b) { return (ms(a.lastSeenAt) - ms(b.lastSeenAt)) * dir; });
  // 'default' keeps the API order (severity → recurrence → last-seen desc) — most valuable first
  return out;
}

// ---- table render -----------------------------------------------------------

function arrow(key) {
  if (sort.key !== key) return '<span class="ins-sort">↕</span>';
  return '<span class="ins-sort on">' + (sort.dir === 'asc' ? '▴' : '▾') + '</span>';
}

function row(r, i) {
  var span = sessionSpan(r);
  var rec = num(r.count) + ' occ' + (span >= 1 ? ' · ' + num(span) + (span === 1 ? ' session' : ' sessions') : '');
  var repoTag = isGlobal(r.repo) ? '' : '<span class="tag ins-row-repo" title="' + esc(r.repo) + '">' + esc(r.repo) + '</span>';
  // NOTE: our OWN row class only — NOT the sessions tab's `srow`. sessions.ts binds
  // `document.querySelectorAll('.srow')` GLOBALLY to its openDetail(), which would
  // hijack every insight row's click (→ fetch a session by an insight id → dead drawer).
  // The fix is read + copied from the row's detail drawer, not inline.
  return '<tr class="ins-row" data-i="' + i + '" data-id="' + esc(r.id) + '">' +
    '<td><span class="ins-row-title-wrap">' + sevDot(r.severity) +
      '<span class="s-title ins-row-title" title="' + esc(r.title) + '">' + esc(r.title) + '</span>' + repoTag + '</span></td>' +
    '<td class="num nowrap ins-row-rec">' + esc(rec) + '</td>' +
    '<td class="num nowrap">' + esc(dayOf(r.lastSeenAt)) + '</td>' +
    '<td>' + stateBadge(r.state) + '</td></tr>';
}

function paint() {
  var el = $('#insights');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="empty">No insights yet. Detectors run during <code>tuneloop analyze</code> and surface improvement opportunities here.</div>';
    return;
  }
  var vis = visibleRows();
  if (!vis.length) { el.innerHTML = '<div class="empty">No insights match.</div>'; return; }

  var head = '<tr>' +
    '<th>Insight</th>' +
    '<th class="ins-th-sort" data-sort="occ">Recurrence ' + arrow('occ') + '</th>' +
    '<th class="ins-th-sort" data-sort="lastSeen">Last seen ' + arrow('lastSeen') + '</th>' +
    '<th>Status</th></tr>';
  el.innerHTML = '<table>' + head + vis.map(function (r) { return row(r, rows.indexOf(r)); }).join('') + '</table>';

  // Sortable headers: click toggles asc/desc; a third click on the same key returns
  // to the default (severity → recency) order.
  Array.prototype.forEach.call(el.querySelectorAll('.ins-th-sort'), function (th) {
    th.onclick = function () {
      var key = th.getAttribute('data-sort');
      if (sort.key !== key) { sort.key = key; sort.dir = 'desc'; }
      else if (sort.dir === 'desc') sort.dir = 'asc';
      else { sort.key = 'default'; sort.dir = 'desc'; }
      paint();
    };
  });

  // Row click opens the insight detail drawer (where the fix is read + copied).
  Array.prototype.forEach.call(el.querySelectorAll('.ins-row'), function (tr) {
    tr.onclick = function () {
      var r = rows[parseInt(tr.getAttribute('data-i'), 10)];
      if (r) { selectRow(tr); openInsight(r); }
    };
  });
}

// Mark the open insight's row selected, clearing any prior selection. Also cleared
// when the drawer closes.
function selectRow(tr) {
  Array.prototype.forEach.call(document.querySelectorAll('.ins-row.on'), function (c) { c.classList.remove('on'); });
  if (tr) tr.classList.add('on');
}

export function clearCellSelection() {
  Array.prototype.forEach.call(document.querySelectorAll('.ins-row.on'), function (c) { c.classList.remove('on'); });
}

// ---- copy-fix (shared by the row button and the drawer) ---------------------

// Copy the fix to the clipboard and record issuance (→ fix_issued). `btn` is the
// clicked control (row or drawer); its label flips to a transient confirmation.
function copyFix(r, btn) {
  navigator.clipboard.writeText(r.fix.content).then(function () {
    var orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(function () { btn.textContent = orig; }, 1500);
    post('/api/insights/fix-issued', { id: r.id }).then(function (res) {
      if (!res || !res.ok) return;
      r.state = 'fix_issued';
      // Reflect the new state wherever it shows: the drawer meta badge + the table.
      var st = document.querySelector('#drawerBody .ins-detail-meta .ins-state');
      if (st) st.outerHTML = stateBadge('fix_issued');
      paint();
    });
  }, function () {
    var orig = btn.textContent;
    btn.textContent = 'Copy failed';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  });
}

// ---- detail drawer ----------------------------------------------------------

function openInsight(r) {
  var render = function (occ) {
    var body = $('#drawerBody');
    if (!body) return;
    body.innerHTML = detailHtml(r, occ);
    $('#drawer').classList.add('on');
    $('#overlay').classList.add('on');
    wireDetail(r, occ);
  };
  if (occCache[r.id]) { render(occCache[r.id]); return; }
  // Render immediately (fix is the priority payload); fill occurrences when they arrive.
  render(null);
  get('/api/insight/evidence?id=' + encodeURIComponent(r.id)).then(function (occ) {
    occCache[r.id] = occ || [];
    // Only re-render if this insight's detail is still the one on screen.
    var open = document.querySelector('#drawerBody .ins-detail-body');
    if (open) render(occCache[r.id]);
  });
}

function wireDetail(r, occ) {
  var close = $('#drawerCloseBtn');
  if (close) close.onclick = closeDrawer;

  var copy = $('#drawerBody .ins-copy');
  if (copy) copy.onclick = function () { copyFix(r, copy); };

  var dismiss = $('#drawerBody .ins-dismiss');
  if (dismiss) dismiss.onclick = function () {
    if (!window.confirm('Dismiss "' + r.title + '"? It will not resurface, even if the pattern recurs.')) return;
    post('/api/insights/dismiss', { id: r.id }).then(function () { closeDrawer(); renderInsights(); });
  };

  // Each occurrence opens its session's transcript, scrolled to the turn. A back
  // button in the transcript header returns to this insight (see openDetail).
  Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .ins-occ'), function (b) {
    b.onclick = function () {
      var e = (occ || [])[parseInt(b.getAttribute('data-j'), 10)];
      if (!e) return;
      openDetail(e.sessionId, {
        turnSeq: e.turnIdx == null ? undefined : e.turnIdx,
        backToInsight: r.id,
      });
    };
  });
}

// Re-open an insight's detail by id — the transcript's "← Insights" back button.
export function reopenInsight(id) {
  var r = rows.filter(function (x) { return x.id === id; })[0];
  if (r) {
    selectRow(document.querySelector('.ins-row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'));
    openInsight(r);
  }
}
