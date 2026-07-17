// The Insights tab — the detector ledger, as a responsive grid of compact cells.
// A cell shows severity, title, scope, recurrence (occurrences / sessions), and
// lifecycle state. Clicking a cell opens the insight DETAIL in the right drawer:
// the fix payload plus every occurrence (with its one-line note). Clicking an
// occurrence swaps the drawer to that session's transcript, scrolled to the exact
// turn, with a "← Insights" back button. Mutations: Copy fix (→ fix_issued) and
// Dismiss (permanent).
import { $, esc, get, post, num, dayOf, renderMd } from './core';
import { openDetail, closeDrawer } from './sessions';

// A repo of '*' means the pattern spans repos — show it as "global", not a glyph.
function repoLabel(repo) { return !repo || repo === '*' ? 'global' : repo; }

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

// ---- grid cell (compact) ----------------------------------------------------

// Distinct sessions among the (capped) evidence — a floor on how many sessions
// the pattern spans, for the cell's sub line.
function sessionSpan(r) {
  var seen = {};
  (r.evidence || []).forEach(function (e) { seen[e.sessionId] = 1; });
  return Object.keys(seen).length;
}

function cell(r, i) {
  var span = sessionSpan(r);
  var sub = num(r.count) + (r.count === 1 ? ' occurrence' : ' occurrences') +
    (span > 1 ? ' · ' + num(span) + ' sessions' : '');
  return '<button type="button" class="ins-cell" data-i="' + i + '" data-id="' + esc(r.id) + '">' +
    '<div class="ins-cell-label">' + sevDot(r.severity) +
      '<span class="tag">' + esc(repoLabel(r.repo)) + '</span>' +
      '<span class="ins-state st-' + esc(r.state) + '">' + esc(String(r.state).replace(/_/g, ' ')) + '</span>' +
    '</div>' +
    '<div class="ins-cell-title">' + esc(r.title) + '</div>' +
    '<div class="ins-cell-sub">' + esc(sub) + '</div>' +
    '</button>';
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

  // Occurrences: one row per stored event, each opening the transcript at the exact
  // message. (We don't label a number: the stored seq is the message index, not the
  // transcript's user-turn count)
  var occRows = (occ || []).map(function (e, j) {
    var title = e.sessionTitle ? esc(e.sessionTitle) : esc(shortSession(e.sessionId));
    var note = e.note ? '<div class="ins-occ-note">' + esc(e.note) + '</div>' : '';
    return '<button type="button" class="ins-occ" data-j="' + j + '" title="Open transcript at this message">' +
      note +
      '<div class="ins-occ-src"><span class="ins-occ-arrow">↳</span>' + title +
        (e.turnIdx != null ? '<span class="ins-occ-turn">open ↗</span>' : '') +
      '</div></button>';
  }).join('');
  var occSection = '<div class="ins-occ-list"><div class="ins-section-label">Occurrences (' +
    ((occ && occ.length) || 0) + ')</div>' +
    (occRows || '<div class="empty">No stored occurrences.</div>') + '</div>';

  var dismiss = '<div class="ins-detail-actions">' +
    '<button type="button" class="ins-btn ins-dismiss">Dismiss insight</button></div>';

  return head + '<div class="ins-detail-body">' + desc + fix + occSection + dismiss + '</div>';
}

// ---- state ------------------------------------------------------------------

var rows: any[] = [];       // last fetched insights
var occCache: any = {};     // insightId → occurrences (fetched lazily on detail open)

export function renderInsights() {
  get('/api/insights').then(function (d) {
    rows = d || [];
    paint();
  });
}

function paint() {
  var el = $('#insights');
  if (!el) return;
  el.innerHTML = rows.length
    ? '<div class="ins-grid">' + rows.map(cell).join('') + '</div>'
    : '<div class="empty">No insights yet. Detectors run during <code>tuneloop analyze</code> and surface improvement opportunities here.</div>';

  Array.prototype.forEach.call(el.querySelectorAll('.ins-cell'), function (b) {
    b.onclick = function () {
      var r = rows[parseInt(b.getAttribute('data-i'), 10)];
      if (r) openInsight(r);
    };
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
  if (copy) copy.onclick = function () {
    navigator.clipboard.writeText(r.fix.content).then(function () {
      copy.textContent = 'Copied ✓';
      setTimeout(function () { copy.textContent = 'Copy fix'; }, 1500);
      // Copying is fix issuance. Update the local row + badge on a real transition.
      post('/api/insights/fix-issued', { id: r.id }).then(function (res) {
        if (!res || !res.ok) return;
        r.state = 'fix_issued';
        var cur = rows.filter(function (x) { return x.id === r.id; })[0];
        if (cur) cur.state = 'fix_issued';
        var st = document.querySelector('#drawerBody .ins-detail-meta .ins-state');
        if (st) st.outerHTML = stateBadge('fix_issued');
        paint(); // reflect the new state on the grid cell behind the drawer
      });
    }, function () {
      copy.textContent = 'Copy failed';
      setTimeout(function () { copy.textContent = 'Copy fix'; }, 1500);
    });
  };

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
  if (r) openInsight(r);
}
