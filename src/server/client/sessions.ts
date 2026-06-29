// Sessions tab: the filter bar (facet selects + artifact-search typeahead +
// free-text), the session table, the detail drawer, and view switching. The
// typeahead helpers (ac*) are module-private; filterByArtifact/setView are
// shared so the artifacts tab and drawer can jump into a filtered session list.
import { state, $, esc, renderMd, usd, num, dayOf, badge, get, post, outcomeRank, outcomeLabel } from './core'

// Close the transcript outline dropdown on an outside click — it's a custom
// dropdown with no native blur. One module-level listener (added once) that
// queries the live elements, so it works across drawer re-opens without leaking
// per-open handlers. mousedown (not click) so opening the dropdown via its own
// button doesn't immediately re-close it on the same interaction.
document.addEventListener('mousedown', function (e) {
  var panel = document.getElementById('tx-outline');
  if (!panel || !panel.classList.contains('on')) return;
  var btn = document.querySelector('#drawerBody .tx-ol-btn');
  var target = e.target as Node;
  if (panel.contains(target) || (btn && btn.contains(target))) return;
  panel.classList.remove('on');
  if (btn) btn.classList.remove('on');
});

// Close the outcome multi-select popover on an outside click (same pattern as
// the transcript outline above): one module-level listener over live elements.
document.addEventListener('mousedown', function (e) {
  var menu = document.getElementById('f-outcome-menu');
  if (!menu || !menu.classList.contains('on')) return;
  var wrap = document.getElementById('f-outcome-wrap');
  if (wrap && wrap.contains(e.target as Node)) return;
  menu.classList.remove('on');
});

var TIME_PRESETS = [
  { d: 7, l: '7d' }, { d: 30, l: '30d' }, { d: 90, l: '90d' }, { d: 'all', l: 'All' }, { d: 'custom', l: 'Custom' }
];

// Filter facets shown inline (in this order); every other filter-role facet —
// plus the artifact search — collapses behind "More filters" to keep the bar
// compact. Adding a facet to a processor still surfaces it (under "More").
var PRIMARY_FACETS = ['use_case', 'repo'];

export function buildFilters() {
  // Compact toolbar. The generic facet loop still drives everything (so a new
  // processor facet surfaces automatically) — PRIMARY_FACETS render inline,
  // the rest collapse behind "More filters" with the artifact search.
  function sel(f) {
    var d = state.dist[f.key] || [];
    var opts = '<option value="">' + esc(f.label || f.key) + ': all</option>';
    d.forEach(function (r) { if (r.value == null) return; opts += '<option value="' + esc(r.value) + '">' + esc(r.value) + '</option>'; });
    return '<select class="facet-filter" data-key="' + esc(f.key) + '">' + opts + '</select>';
  }
  function usable(f) { return (f.roles || []).indexOf('filter') >= 0 && (state.dist[f.key] || []).length > 0; }

  var primary = '';
  PRIMARY_FACETS.forEach(function (k) {
    var f = state.facets.filter(function (x) { return x.key === k; })[0];
    if (f && usable(f)) primary += sel(f);
  });
  var more = '';
  state.facets.forEach(function (f) {
    if (!usable(f) || PRIMARY_FACETS.indexOf(f.key) >= 0) return;
    more += sel(f);
  });

  var segBtns = TIME_PRESETS.map(function (p) {
    return '<button type="button" data-d="' + p.d + '"' +
      (String(p.d) === String(state.sessTime.preset) ? ' class="on"' : '') + '>' + p.l + '</button>';
  }).join('');

  $('#filters').innerHTML =
    '<div class="flt-row">' +
      '<span class="flt-grp"><span class="flt-lbl">Time</span>' +
        '<div class="seg flt-seg" id="f-time">' + segBtns + '</div>' +
        '<span class="flt-dates" id="f-dates"' + (state.sessTime.preset === 'custom' ? '' : ' hidden') + '>' +
          '<input type="date" id="f-from" value="' + esc(state.sessTime.from) + '" />' +
          '<span class="flt-dash">→</span>' +
          '<input type="date" id="f-to" value="' + esc(state.sessTime.to) + '" />' +
        '</span>' +
      '</span>' +
      '<input id="f-q" class="flt-search" placeholder="search title / intent" />' +
    '</div>' +
    '<div class="flt-row flt-row-facets">' + primary +
      '<span class="flt-pop" id="f-outcome-wrap">' +
        '<button type="button" class="flt-pop-btn" id="f-outcome-btn">Outcomes' +
          '<span class="flt-pop-cnt" id="f-outcome-cnt"></span><span class="flt-pop-car">▾</span></button>' +
        '<div class="flt-menu" id="f-outcome-menu"></div>' +
      '</span>' +
      '<span class="ac" id="f-artifact-ac">' +
        '<input id="f-artifact" placeholder="file path / PR # / feature" autocomplete="off" />' +
        '<div class="ac-menu" id="f-artifact-menu"></div>' +
      '</span>' +
      (more ? '<button type="button" class="flt-pop-btn flt-more-btn" id="f-more-btn">More filters<span class="flt-pop-cnt" id="f-more-cnt"></span><span class="flt-pop-car">▾</span></button>' : '') +
    '</div>' +
    (more ? '<div class="flt-row flt-more" id="f-more" hidden>' + more + '</div>' : '') +
    '<div class="flt-active" id="filter-active"></div>';

  Array.prototype.forEach.call(document.querySelectorAll('.facet-filter'), function (s) { s.onchange = applyFilters; });

  // Time segmented control (presets + custom range).
  Array.prototype.forEach.call(document.querySelectorAll('#f-time button'), function (b) {
    b.onclick = function () {
      var d = b.getAttribute('data-d');
      setTimePreset(d === 'all' || d === 'custom' ? d : parseInt(d, 10));
    };
  });
  $('#f-from').onchange = function () { state.sessTime.from = this.value; applyFilters(); };
  $('#f-to').onchange = function () { state.sessTime.to = this.value; applyFilters(); };

  // Outcome multi-select popover (built lazily; outcome types load async).
  $('#f-outcome-btn').onclick = function () { buildOutcomeMenu(); $('#f-outcome-menu').classList.toggle('on'); };

  // More-filters disclosure.
  var moreBtn = $('#f-more-btn');
  if (moreBtn) moreBtn.onclick = function () { var m = $('#f-more'); var open = m.hidden; m.hidden = !open; this.classList.toggle('on', open); };

  var t;
  $('#f-q').oninput = function () { clearTimeout(t); t = setTimeout(applyFilters, 250); };
  // Artifact search: typeahead suggestions + (debounced) live substring filter.
  // Typing manually clears the picked kind, so the search spans all kinds.
  var t2;
  $('#f-artifact').oninput = function () { this.dataset.kind = ''; clearTimeout(t2); t2 = setTimeout(function () { acFetch(); applyFilters(); }, 200); };
  $('#f-artifact').onkeydown = acKeydown;
  $('#f-artifact').onblur = function () { setTimeout(acClose, 150); }; // delay so a click registers

  // Apply current defaults (30d window) and render the active-chip row.
  applyFilters();
}

// Badge on the "More filters" button = how many collapsed filters are active.
function updateMoreCount() {
  var el = $('#f-more-cnt');
  if (!el) return;
  var f = state.filters || {};
  var n = 0;
  Object.keys(f.facets || {}).forEach(function (k) { if (PRIMARY_FACETS.indexOf(k) < 0) n++; });
  el.textContent = n ? String(n) : '';
}

// Clear every sessions filter, including the time window (→ all-time), and reload.
// buildFilters() rebuilds the bar empty, then applyFilters() reloads + empties the
// chip row (so the "Clear all" button itself disappears — nothing left to clear).
export function clearAllFilters() {
  state.sessTime = { preset: 'all', from: '', to: '' };
  buildFilters();
}

// Resolve the sessions-list window to ISO {from,to} for the request. Empty
// bounds mean "open" (the 'all' preset, or a half-filled custom range).
function sessWindow() {
  var st = state.sessTime;
  if (st.preset === 'all') return { from: '', to: '' };
  if (st.preset === 'custom') {
    return {
      from: st.from ? new Date(st.from + 'T00:00:00').toISOString() : '',
      to: st.to ? new Date(st.to + 'T23:59:59.999').toISOString() : '',
    };
  }
  var span = st.preset * 86400000, now = Date.now();
  return { from: new Date(now - span).toISOString(), to: new Date(now).toISOString() };
}

// Apply a time preset: update state + the segmented control + date visibility,
// then refresh. Shared by the seg buttons and the active-chip "clear".
function setTimePreset(preset) {
  state.sessTime.preset = preset;
  Array.prototype.forEach.call(document.querySelectorAll('#f-time button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-d') === String(preset));
  });
  var dates = $('#f-dates');
  if (dates) dates.hidden = preset !== 'custom';
  applyFilters();
}

function selectedOutcomes() {
  var out = [];
  Array.prototype.forEach.call(document.querySelectorAll('#f-outcome-menu input:checked'), function (cb) { out.push(cb.value); });
  return out;
}

// Populate the outcome checklist on first open (state.outcomeTypes loads async,
// so build lazily and only mark built once it actually has items).
function buildOutcomeMenu() {
  var menu = $('#f-outcome-menu');
  if (!menu || menu.getAttribute('data-built')) return;
  var types = state.outcomeTypes || [];
  if (!types.length) { menu.innerHTML = '<div class="flt-menu-empty">No outcomes recorded yet.</div>'; return; }
  menu.innerHTML = types.map(function (t) {
    return '<label class="flt-menu-item"><input type="checkbox" value="' + esc(t.type) + '" />' +
      '<span class="flt-menu-tx">' + esc(outcomeLabel(t.type)) + '</span>' +
      '<span class="flt-menu-n">' + num(t.sessions || 0) + '</span></label>';
  }).join('');
  menu.setAttribute('data-built', '1');
  Array.prototype.forEach.call(menu.querySelectorAll('input'), function (cb) { cb.onchange = applyFilters; });
}

function updateOutcomeCount(n) {
  var el = $('#f-outcome-cnt');
  if (el) el.textContent = n ? String(n) : '';
  var btn = $('#f-outcome-btn');
  if (btn) btn.classList.toggle('on', n > 0);
}

// One active-filter chip with a per-filter clear (×).
function chipHtml(cat, key, label, val) {
  return '<span class="flt-chip"><span class="flt-chip-k">' + esc(label) + '</span>' +
    '<span class="flt-chip-v">' + esc(val) + '</span>' +
    '<button class="flt-chip-x" type="button" data-c="' + esc(cat) + '" data-k="' + esc(key) + '" aria-label="Remove filter">×</button></span>';
}

// Clear one filter (from its chip ×) and re-apply.
function clearChip(cat, key) {
  if (cat === 'time') { setTimePreset('all'); return; }
  if (cat === 'facet') {
    var sel = document.querySelector('.facet-filter[data-key="' + key + '"]') as any;
    if (sel) sel.value = '';
  } else if (cat === 'outcome') {
    Array.prototype.forEach.call(document.querySelectorAll('#f-outcome-menu input'), function (cb) { if (cb.value === key) cb.checked = false; });
  } else if (cat === 'artifact') {
    var af = $('#f-artifact') as any; if (af) { af.value = ''; af.dataset.kind = ''; }
  } else if (cat === 'q') {
    var q = $('#f-q') as any; if (q) q.value = '';
  }
  applyFilters();
}

// The "Active" row: one chip per applied filter; chips double as per-filter clears.
function renderActiveChips() {
  var host = $('#filter-active');
  if (!host) return;
  var f = state.filters || {};
  var labels = {};
  (state.facets || []).forEach(function (x) { labels[x.key] = x.label || x.key; });
  // Note: the time window is conveyed by the segmented control, so it isn't
  // repeated as a chip — only narrowing filters appear here.
  var chips = [];
  Object.keys(f.facets || {}).forEach(function (k) { chips.push(chipHtml('facet', k, labels[k] || k, f.facets[k])); });
  (f.outcomes || []).forEach(function (o) { chips.push(chipHtml('outcome', o, 'Outcome', outcomeLabel(o))); });
  if (f.artifact) chips.push(chipHtml('artifact', '', 'Artifact', f.artifact));
  if (f.q) chips.push(chipHtml('q', '', 'Search', f.q));

  if (!chips.length) { host.innerHTML = ''; return; }
  host.innerHTML = '<span class="flt-active-lbl">Active</span>' + chips.join('') +
    '<button class="flt-clear-all" type="button">Clear all</button>';
  Array.prototype.forEach.call(host.querySelectorAll('.flt-chip-x'), function (b) {
    b.onclick = function () { clearChip(b.getAttribute('data-c'), b.getAttribute('data-k')); };
  });
  var ca = host.querySelector('.flt-clear-all') as any;
  if (ca) ca.onclick = clearAllFilters;
}

// ---- artifact-search typeahead (session-list filter) -----------------------

function acFetch() {
  var inp = $('#f-artifact');
  if (!inp) return;
  var q = inp.value.trim();
  var kind = inp.dataset.kind || '';
  if (q.length < 1) { acClose(); return; }
  get('/api/artifact-suggest?q=' + encodeURIComponent(q) + (kind ? '&kind=' + encodeURIComponent(kind) : '')).then(function (items) {
    state.ac = { items: items || [], sel: -1 };
    acRender();
  });
}

function acItemHtml(it, idx, sel) {
  var label;
  if (it.kind === 'file') {
    var parts = String(it.value).split('/');
    var base = parts.pop();
    var dir = parts.length ? '…/' + parts.slice(-2).join('/') : '';
    label = esc(base) + (dir ? ' <span class="ac-dir">' + esc(dir) + '</span>' : '');
  } else {
    label = esc(it.label);
  }
  return '<div class="ac-item' + (sel ? ' sel' : '') + '" data-i="' + idx + '">' +
    '<span class="ac-kind">' + esc(it.kind) + '</span><span class="ac-label">' + label + '</span></div>';
}

function acRender() {
  var menu = $('#f-artifact-menu');
  if (!menu) return;
  var items = state.ac.items || [];
  if (!items.length) { acClose(); return; }
  menu.innerHTML = items.map(function (it, i) { return acItemHtml(it, i, i === state.ac.sel); }).join('');
  menu.classList.add('on');
  Array.prototype.forEach.call(menu.children, function (el) {
    // mousedown (not click) + preventDefault so the input's blur doesn't fire first
    el.onmousedown = function (e) { e.preventDefault(); acPick(parseInt(el.getAttribute('data-i'), 10)); };
  });
}

function acPick(i) {
  var it = (state.ac.items || [])[i];
  if (!it) return;
  var af = $('#f-artifact');
  af.value = it.value;
  af.dataset.kind = it.kind || ''; // narrow the filter to the picked kind
  acClose();
  applyFilters();
}

function acClose() {
  state.ac = { items: [], sel: -1 };
  var m = $('#f-artifact-menu');
  if (m) m.classList.remove('on');
}

function acKeydown(e) {
  var menu = $('#f-artifact-menu');
  if (!menu || !menu.classList.contains('on')) return;
  var items = state.ac.items || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); state.ac.sel = Math.min(items.length - 1, state.ac.sel + 1); acRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.ac.sel = Math.max(0, state.ac.sel - 1); acRender(); }
  else if (e.key === 'Enter') { if (state.ac.sel >= 0) { e.preventDefault(); acPick(state.ac.sel); } }
  else if (e.key === 'Escape') { acClose(); }
}

export function applyFilters() {
  var facets = {};
  Array.prototype.forEach.call(document.querySelectorAll('.facet-filter'), function (s) {
    if (s.value) facets[s.getAttribute('data-key')] = s.value;
  });
  var af = $('#f-artifact');
  var win = sessWindow();
  var outcomes = selectedOutcomes();
  updateOutcomeCount(outcomes.length);
  state.filters = {
    facets: facets,
    q: $('#f-q') ? $('#f-q').value : '',
    artifact: af ? af.value : '',
    artifactKind: af && af.dataset.kind ? af.dataset.kind : '',
    outcomes: outcomes,
    from: win.from,
    to: win.to
  };
  updateMoreCount();
  renderActiveChips();
  loadSessions();
}

export function renderSessions(rows) {
  if (!rows || !rows.length) { $('#sessions').innerHTML = '<div class="empty">No sessions match.</div>'; return; }
  var head = '<tr><th>Session</th><th>Date</th><th>Cost</th><th>Outcomes</th><th>Complexity</th><th>Work type</th></tr>';
  var body = rows.map(function (r) {
    // Outcomes in the canonical order (pr_merged first … session_success last).
    var outs = (r.outcomes || []).slice().sort(function (a, b) { return outcomeRank(a) - outcomeRank(b); });
    return '<tr class="srow" data-id="' + esc(r.id) + '">' +
      '<td><span class="s-title" title="' + esc(r.title) + '">' + esc(r.title) + '</span></td>' +
      '<td class="num nowrap">' + esc(dayOf(r.startedAt)) + '</td>' +
      '<td class="num nowrap">' + usd(r.costUsd) + '</td>' +
      '<td class="cell-tags">' + tagCell(outs) + '</td>' +
      '<td>' + esc(r.complexity || '—') + '</td>' +
      '<td class="cell-tags">' + tagCell(r.useCase) + '</td></tr>';
  }).join('');
  $('#sessions').innerHTML = '<table>' + head + body + '</table>';
  Array.prototype.forEach.call(document.querySelectorAll('.srow'), function (tr) {
    tr.onclick = function () {
      var f = state.filters || {};
      // Carry the active artifact filter (from "See sessions") into the drawer so
      // the transcript opens focused on that feature / PR.
      openDetail(tr.getAttribute('data-id'), f.artifact ? { kind: f.artifactKind, val: f.artifact } : null);
    };
  });
  // "+N" reveals the rest of a capped tag cell in place (without opening the row).
  Array.prototype.forEach.call(document.querySelectorAll('#sessions .tag-more'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var rest = b.previousElementSibling;
      if (rest) rest.classList.add('on');
      b.style.display = 'none';
    };
  });
}

// A table cell of tags, capped at 2 with a "+N" that reveals the rest in place,
// keeping rows to a single line by default.
function tagCell(items) {
  items = items || [];
  if (!items.length) return '—';
  function t(x) { return '<span class="tag">' + esc(x) + '</span>'; }
  var head = items.slice(0, 2).map(t).join('');
  if (items.length <= 2) return head;
  return head + '<span class="tag-rest">' + items.slice(2).map(t).join('') + '</span>' +
    '<button class="tag-more" type="button">+' + (items.length - 2) + '</button>';
}

// Render a list of chips with a default cap; the overflow is rendered up front
// but hidden behind a "show all N" toggle that expands in place (no re-fetch),
// keeping long file/feature lists from bloating the summary.
function chipList(items, cap, render) {
  if (!items.length) return '';
  var head = items.slice(0, cap).map(render).join('');
  if (items.length <= cap) return head;
  var rest = '<span class="chip-rest">' + items.slice(cap).map(render).join('') + '</span>';
  var more = '<button class="chip-more" type="button" data-n="' + items.length + '">show all ' + items.length + ' ›</button>';
  return head + rest + more;
}

// One-line, whitespace-collapsed preview for the transcript outline entries.
function clipLine(s, n) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Restart a CSS flash animation on an element (remove → reflow → re-add) so a
// repeated jump to the same anchor re-triggers the highlight.
function flashEl(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// Flash when the element ARRIVES in view (center reaches the viewport's central
// band), not after the smooth-scroll's easing tail. Falls back to scroll-stopped /
// a frame cap so it always fires.
function flashOnSettle(el) {
  if (!el) return;
  var last = null, stable = 0, frames = 0;
  function tick() {
    frames++;
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    var center = r.top + r.height / 2;
    var inView = center > vh * 0.25 && center < vh * 0.75;
    if (last !== null && Math.abs(r.top - last) < 0.5) stable++; else stable = 0;
    last = r.top;
    if (inView || stable >= 2 || frames > 90) { flashEl(el); return; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- Files-changed view -----------------------------------------------------

// Minimal line-level diff (LCS backtrace) → rows tagged ' ' (context), '-', '+'.
// Hunks are small (capped server-side), so O(n·m) is fine.
function diffLines(a, b) {
  var A = a ? a.split('\n') : [], B = b ? b.split('\n') : [];
  var n = A.length, m = B.length, i, j;
  var dp = [];
  for (i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (i = n - 1; i >= 0; i--)
    for (j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  var rows = []; i = 0; j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: '-', s: A[i] }); i++; }
    else { rows.push({ t: '+', s: B[j] }); j++; }
  }
  while (i < n) { rows.push({ t: '-', s: A[i] }); i++; }
  while (j < m) { rows.push({ t: '+', s: B[j] }); j++; }
  return rows;
}

var DIFF_ROW_CAP = 60;

// Apply an Edit (old→new, first occurrence) to running content, so a later Write
// to the same file can be diffed against its actual prior state.
function applyEdit(s, oldStr, newStr) {
  if (!oldStr) return s;
  var i = s.indexOf(oldStr);
  return i < 0 ? s : s.slice(0, i) + newStr + s.slice(i + oldStr.length);
}

// Diff rows for one edit given the file's running content `prev`. A Write is
// diffed against the previous content (so repeated rewrites show their DELTA,
// not the whole file each time); an Edit is its own old→new hunk(s). Returns the
// rows and the updated running content.
function editRows(e, prev) {
  if (e.op === 'write') {
    var content = (e.hunks[0] && e.hunks[0].ins) || '';
    return { rows: diffLines(prev, content), next: content };
  }
  var rows = [], next = prev;
  (e.hunks || []).forEach(function (h, hi) {
    if (hi) rows.push({ t: '~', s: '' });        // separator between MultiEdit hunks
    rows = rows.concat(diffLines(h.del, h.ins));
    if (next) next = applyEdit(next, h.del, h.ins);
  });
  return { rows: rows, next: next };
}

function rowHtml(r) {
  if (r.t === '~') return '<div class="dl sep">⋯</div>';
  var cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
  var gut = r.t === '+' ? '+' : r.t === '-' ? '−' : ' ';
  return '<div class="dl ' + cls + '"><span class="dg">' + gut + '</span><span class="dt">' + esc(r.s) + '</span></div>';
}

// Show just the tail of a long absolute path (last 2 dirs + filename), bolding
// the basename; the full path stays available on hover (title).
function shortPathHtml(p) {
  var parts = String(p || '').split('/').filter(Boolean);
  var base = parts.length ? parts.pop() : String(p || '');
  var dirs = parts.slice(-2);
  var prefix = (parts.length > dirs.length ? '…/' : '') + (dirs.length ? dirs.join('/') + '/' : '');
  return (prefix ? '<span class="fc-dir">' + esc(prefix) + '</span>' : '') +
    '<span class="fc-base">' + esc(base) + '</span>';
}

// Compute each edit's diff rows ONCE, in chronological order, maintaining a
// per-file running content so consecutive Writes diff against the prior state.
// Also attach the agent's nearest narration (its "why" at the edit's altitude).
function prepEdits(edits, transcript) {
  var prevByFile = {};
  edits.forEach(function (e) {
    e._first = !prevByFile[e.path];
    var r = editRows(e, prevByFile[e.path] || '');
    e._rows = r.rows;
    prevByFile[e.path] = r.next;
    e._add = 0; e._del = 0;
    e._rows.forEach(function (x) { if (x.t === '+') e._add++; else if (x.t === '-') e._del++; });
    e._narr = narrationFor(e, transcript);
  });
}

// Nearest assistant text turn AT or before the edit's turn, but not before the
// prompting user turn — the agent's local rationale for this specific change.
function narrationFor(e, transcript) {
  var lo = e.userTurn >= 0 ? e.userTurn + 1 : 0;
  for (var k = Math.min(e.turn, transcript.length - 1); k >= lo; k--) {
    var t = transcript[k];
    if (t && t.role === 'assistant' && t.text) return t.text;
  }
  return '';
}

// Stable grouping that preserves first-seen order of keys.
function groupBy(items, keyFn) {
  var order = [], map = {};
  items.forEach(function (it) {
    var k = keyFn(it);
    if (!(k in map)) { map[k] = []; order.push(k); }
    map[k].push(it);
  });
  return order.map(function (k) { return { key: k, items: map[k] }; });
}

function sumAddDel(edits) {
  var add = 0, del = 0;
  edits.forEach(function (e) { add += e._add; del += e._del; });
  return { add: add, del: del };
}

// One edit's diff block. showNarr gates the agent narration caption (deduped
// against the previous edit by the caller). The jump-to-intent lives on the
// enclosing prompt/note header, not per edit.
function editHtml(e, showNarr) {
  var rows = e._rows || [];
  var head = rows.slice(0, DIFF_ROW_CAP).map(rowHtml).join('');
  var rest = rows.length > DIFF_ROW_CAP
    ? '<div class="dl-rest">' + rows.slice(DIFF_ROW_CAP).map(rowHtml).join('') + '</div>' +
      '<button class="fc-rows-more" type="button">+ ' + (rows.length - DIFF_ROW_CAP) + ' more lines</button>'
    : '';
  var verb = e.op === 'write' ? (e._first ? 'Created' : 'Rewrote') : e.op === 'multiedit' ? 'Edited · ' + e.hunks.length + ' hunks' : 'Edited';
  var stat = ' (+' + e._add + (e._del ? ' −' + e._del : '') + ')';
  var narr = showNarr && e._narr ? '<div class="fc-narr" title="' + esc(clipLine(e._narr, 600)) + '">▸ ' + esc(clipLine(e._narr, 240)) + '</div>' : '';
  var diff = rows.length ? '<div class="fc-diff">' + head + rest + '</div>'
    : '<div class="fc-noop">no textual change (or beyond the captured window)</div>';
  return '<div class="fc-edit">' + narr +
    '<div class="fc-edit-h"><span class="fc-op">' + esc(verb) + stat + '</span></div>' + diff + '</div>';
}

// A collapsible (collapsed by default) per-file card: header with path + stats,
// body supplied by the caller (plain diffs under a note, or prompt-grouped in the
// by-file view).
function fileCardHtml(path, edits, bodyHtml) {
  var c = sumAddDel(edits);
  return '<div class="fc-file collapsed" data-path="' + esc(path) + '"><button class="fc-head" type="button">' +
    '<span class="fc-caret">▾</span><span class="fc-path" title="' + esc(path) + '">' + shortPathHtml(path) + '</span>' +
    '<span class="fc-stat"><span class="fc-add">+' + c.add + '</span> <span class="fc-del">−' + c.del + '</span> · ' +
    edits.length + ' edit' + (edits.length > 1 ? 's' : '') + '</span></button>' +
    '<div class="fc-body">' + bodyHtml + '</div></div>';
}

// User-message header (truncated preview + expand, reusing the .msg show-more).
function msgPreviewHtml(msg) {
  var t = String(msg || '');
  if (!t) return '<span class="fc-pseg-empty">(work before the first prompt)</span>';
  if (t.length <= 200) return esc(t);
  return '<span class="msg"><span class="msg-prev">' + esc(t.slice(0, 200)) + ' …</span>' +
    '<span class="msg-full">' + esc(t) + '</span></span><button class="msg-more" type="button">Show more ↓</button>';
}

// Within a file, group edits by the prompt that drove them and head each run with
// the user message (+ → transcript); note captions add finer per-edit context.
function promptSegmentsHtml(edits, transcript) {
  return groupBy(edits, function (e) { return String(e.userTurn); }).map(function (g) {
    var ut = parseInt(g.key, 10);
    var msg = ut >= 0 && transcript[ut] ? transcript[ut].text : '';
    var jump = ut >= 0 ? '<button class="fc-jump" type="button" data-u="' + ut + '" title="Open this prompt in the transcript">→ transcript</button>' : '';
    var lastNarr = '';
    var body = g.items.map(function (e) {
      var show = e._narr && e._narr !== lastNarr;
      if (e._narr) lastNarr = e._narr;
      return editHtml(e, show);
    }).join('');
    return '<div class="fc-pseg"><div class="fc-pseg-h"><div class="fc-pseg-msg">' + msgPreviewHtml(msg) + '</div>' + jump + '</div>' + body + '</div>';
  }).join('');
}

function filesHtml(edits, transcript) {
  if (!edits || !edits.length) return '<div class="empty">No file changes in this session.</div>';
  return groupBy(edits, function (e) { return e.path; })
    .map(function (g) { return fileCardHtml(g.key, g.items, promptSegmentsHtml(g.items, transcript)); }).join('');
}

var _activeTab = 'transcript';
var _activeSessionId: string | null = null;

export function openDetail(id, focus?: any) {
  get('/api/session?id=' + encodeURIComponent(id)).then(function (d) {
    if (!d || d.error) return;
    var s = d.session, a = d.annotations || {};

    // Sticky-header pieces (title+close, tab subnav, transcript nav) are assembled
    // into one .drawer-head at the end, so they pin together as you scroll.
    var headTop = '<div class="drawer-head-top"><h2>' + esc(s.title || '(untitled)') + '</h2>' +
      '<button class="x" type="button" id="drawerCloseBtn">close</button></div>';
    var fileCount = (d.artifacts || []).filter(function (x) { return x.kind === 'file'; }).length;
    var tabs = '<div class="drawer-tabs">' +
      '<button class="dtab on" type="button" data-dtab="transcript">Transcript</button>' +
      (fileCount ? '<button class="dtab" type="button" data-dtab="files">Files (' + fileCount + ')</button>' : '') +
      '<button class="dtab" type="button" data-dtab="summary">Summary</button>' +
      '</div>';

    // ---- Summary pane: vitals, registry-driven dimensions, intent, artifacts --
    // `when` and `cost` are intrinsic (a timestamp and a measure), not facets, so
    // they stay fixed; every categorical dimension below comes from the facet
    // registry (roles include 'detail'), so a new processor facet shows up here
    // with no edits. enum values render as badges; everything else as text.
    var sum = '<div class="kv">';
    sum += '<span class="k">when</span><span class="num">' + esc(dayOf(s.startedAt)) + '</span>';
    sum += '<span class="k">cost</span><span class="num">' + usd(s.costUsd) + '</span>';
    (d.facets || []).forEach(function (f) {
      var vals = Array.isArray(f.value) ? f.value : (f.value == null || f.value === '' ? [] : [f.value]);
      var disp = !vals.length ? '—'
        : f.type === 'enum' ? vals.map(function (v) { return badge(v); }).join(' ')
        : vals.map(esc).join(', ');
      sum += '<span class="k">' + esc(f.label) + '</span><span>' + disp + '</span>';
    });
    sum += '</div>';
    if (a.intent_summary) sum += '<div class="sect-h">Intent</div><div>' + esc(a.intent_summary) + '</div>';
    var decisions = Array.isArray(a.decisions) ? a.decisions : [];
    if (decisions.length) {
      sum += '<div class="sect-h">Key decisions (' + decisions.length + ')</div>';
      sum += '<ul class="decisions">' +
        decisions.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') +
        '</ul>';
    }

    var arts = d.artifacts || [];
    var sessionId = s.id;
    var feats = arts.filter(function (x) { return x.kind === 'feature'; });
    sum += '<div class="sect-h">Features (' + feats.length + ') <button class="link-add-btn" type="button" data-link-kind="feature" data-session-id="' + esc(sessionId) + '" title="Link feature">+</button></div>';
    if (feats.length) {
      sum += chipList(feats, 6, function (f) {
        var xBtn = '<button class="link-remove-btn" type="button" data-artifact-id="' + esc(f.id) + '" data-session-id="' + esc(sessionId) + '" title="Unlink">&times;</button>';
        return '<span class="tag click" data-art="' + esc(f.title) + '" data-kind="feature">' +
          esc(f.title) + (f.source === 'derived' ? ' (proposed)' : '') + xBtn + '</span>';
      });
    }
    sum += '<div class="link-add-area" data-link-kind="feature" data-session-id="' + esc(sessionId) + '"></div>';
    var prs = arts.filter(function (x) { return x.kind === 'pr'; });
    sum += '<div class="sect-h">Pull requests (' + prs.length + ') <button class="link-add-btn" type="button" data-link-kind="pr" data-session-id="' + esc(sessionId) + '" title="Link PR">+</button></div>';
    if (prs.length) {
      sum += chipList(prs, 8, function (p) {
        var xBtn = p.source === 'user' ? '<button class="link-remove-btn" type="button" data-artifact-id="' + esc(p.id) + '" data-session-id="' + esc(sessionId) + '" title="Unlink">&times;</button>' : '';
        var label = (p.repo ? esc(p.repo) + ' ' : '') + '#' + esc(p.ident) + (p.status ? ' (' + esc(p.status) + ')' : '');
        return '<span class="tag click" data-art="' + esc(p.externalId || p.ident) + '" data-kind="pr">' + label + xBtn + '</span>';
      });
    }
    sum += '<div class="link-add-area" data-link-kind="pr" data-session-id="' + esc(sessionId) + '"></div>';
    var files = arts.filter(function (x) { return x.kind === 'file'; });
    if (files.length) {
      sum += '<div class="sect-h">Files touched (' + files.length + ')</div>';
      sum += chipList(files, 10, function (f) {
        return '<span class="tag click" data-art="' + esc(f.ident) + '" data-kind="file">' + esc(f.ident) + '</span>';
      });
    }
    var outs = d.outcomes || [];
    if (outs.length) {
      sum += '<div class="sect-h">Outcomes</div>';
      sum += chipList(outs, 10, function (o) { return '<span class="tag">' + esc(o.type) + '</span>'; });
    }
    if (fileCount) sum += '<div class="see-tx-wrap"><button class="see-tx" type="button" data-tab="files">See files changed →</button></div>';

    // ---- Transcript pane: the main thread + one tab per subagent. ----------
    // Claude Code writes each subagent (Task/Agent spawn) to its own sidechain
    // transcript; turns carry an `agentId` so we split them out of the main
    // thread into per-subagent scopes. The main thread's spawning call links to
    // its subagent's scope; the subagent links back to the call.
    // Within a scope, Claude Code emits each tool call as its OWN tool-only
    // assistant message, so "a long series of tool calls" is a RUN of consecutive
    // such turns — we keep text turns separate but coalesce each tool-only run
    // into one collapsible block (first few chips + "+N more").
    var TX = d.transcript || { turns: [], subagents: [], blocks: [] };
    var allTurns = TX.turns || [];
    var subMeta = {};      // agentId -> {agentType, description, toolUseId}
    (TX.subagents || []).forEach(function (sa) { subMeta[sa.agentId] = sa; });

    // ---- Block filter: focus the transcript on one PR / feature / use-case. ----
    // Each main-thread turn carries its block (server) and blocks carry labels.
    // A "View by" dimension is offered only when it has ≥2 distinct values;
    // picking a value hides the rest behind a named "··· N turns ···" gap.
    var TXB = TX.blocks || [];
    function blkVal(bi, dim) {
      var b = TXB[bi]; if (!b) return null;
      return dim === 'pr' ? (b.pr ? b.pr.ident : null) : dim === 'feature' ? (b.feature ? b.feature.id : null) : (b.useCase || null);
    }
    function blkLabel(bi, dim) {
      var b = TXB[bi]; if (!b) return null;
      return dim === 'pr' ? (b.pr ? '#' + b.pr.ident : null) : dim === 'feature' ? (b.feature ? (b.feature.title || 'feature') : null) : (b.useCase || null);
    }
    // Per-block size (any main turn, incl. each tool call) → the proportional
    // segment bar showing where in the session each value's stretches fall.
    var sizePerBlock = {}, totalSize = 0;
    allTurns.forEach(function (t) {
      if (t.sidechain || t.blockIdx == null) return;
      sizePerBlock[t.blockIdx] = (sizePerBlock[t.blockIdx] || 0) + 1; totalSize++;
    });
    // A mini sparkline of the whole session with this value's blocks lit — position
    // + fragmentation at a glance (the count already gives magnitude).
    function segBar(dim, key) {
      if (!TXB.length || !totalSize) return '';
      var W = 46, H = 8, x = 0, rects = '';
      TXB.forEach(function (b) {
        var w = (sizePerBlock[b.idx] || 0) / totalSize * W;
        if (w <= 0) return;
        var lit = blkVal(b.idx, dim) === key;
        rects += '<rect class="' + (lit ? 'lit' : 'trk') + '" x="' + x.toFixed(1) + '" y="0" width="' + Math.max(0.7, w).toFixed(1) + '" height="' + H + '" rx="1"></rect>';
        x += w;
      });
      return '<svg class="tx-fbar" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="none">' + rects + '</svg>';
    }
    var DIM_DEFS = [{ dim: 'pr', label: 'PRs' }, { dim: 'feature', label: 'Features' }, { dim: 'use_case', label: 'Work type' }];
    var dimsAvail = DIM_DEFS.map(function (def) {
      var byKey = {}, vals = [];
      TXB.forEach(function (b) {
        var k = blkVal(b.idx, def.dim);
        if (k == null || byKey[k]) return;
        byKey[k] = 1; vals.push({ key: k, label: blkLabel(b.idx, def.dim) });
      });
      return { dim: def.dim, label: def.label, values: vals };
    }).filter(function (d) { return d.values.length >= 2; });
    var fDim = dimsAvail.length ? dimsAvail[0].dim : null;
    var fVal = null; // null = All
    // Match a summary artifact chip (or an arrival focus) to a View-by dimension
    // VALUE — feature by title, PR by number. Null when that dimension isn't
    // filterable (≤1 value) or there's no match.
    function resolveDimValue(kind, val) {
      if ((kind !== 'feature' && kind !== 'pr') || val == null) return null;
      var fd = dimsAvail.filter(function (d) { return d.dim === kind; })[0];
      if (!fd) return null;
      var fv0 = String(val), digs = (fv0.match(/(\d+)\s*$/) || [])[1];
      var hit = fd.values.filter(function (v) {
        return v.key === fv0 || v.label === fv0 || '#' + v.key === fv0 || (kind === 'pr' && digs && v.key === digs);
      })[0];
      return hit ? hit.key : null;
    }
    // Focus the transcript on a dimension value (a summary chip → the transcript).
    // When the value isn't filterable (only one of its kind), just open the
    // transcript unfiltered — a single feature/PR ≈ the whole session.
    function focusDim(dim, key) {
      if (activeScope !== 'main') switchScope('main');
      if (key != null && dimsAvail.filter(function (d) { return d.dim === dim; })[0]) { fDim = dim; fVal = key; }
      else fVal = null;
      renderFilterBar();
      showTab('transcript');
      applyTxFilter(true);
    }
    // Arrived via an artifact drill ("See sessions") → pre-select that value.
    if (focus && focus.val) {
      var fk = resolveDimValue(focus.kind, focus.val);
      if (fk != null) { fDim = focus.kind; fVal = fk; }
    }
    function filterBarHtml() {
      if (!dimsAvail.length) return '';
      var dd = dimsAvail.filter(function (d) { return d.dim === fDim; })[0] || dimsAvail[0];
      var sw = dimsAvail.length > 1
        ? '<select class="tx-fdim">' + dimsAvail.map(function (d) { return '<option value="' + d.dim + '"' + (d.dim === fDim ? ' selected' : '') + '>' + esc(d.label) + '</option>'; }).join('') + '</select>'
        : '<span class="tx-fdim-lbl">' + esc(dd.label) + '</span>';
      var chips = '<button class="tx-fchip' + (fVal == null ? ' on' : '') + '" type="button" data-v="">All</button>' +
        dd.values.map(function (v) {
          return '<button class="tx-fchip' + (fVal === v.key ? ' on' : '') + '" type="button" data-v="' + esc(v.key) + '">' +
            esc(v.label) + segBar(dd.dim, v.key) + '</button>';
        }).join('');
      return '<span class="tx-grp-lbl">View by</span>' + sw + '<span class="tx-fchips">' + chips + '</span>';
    }

    var TOOLCAP = 4;
    var errSeq = 0;        // running id per failed tool call → error-panel anchor (unique across scopes)
    var errSink = null;    // the scope currently rendering: its error-id list (errPanelHtml pushes here)
    var CMD_COLLAPSE_LINES = 2;  // commands > this many lines get a collapse toggle

    function toolBlockHtml(tl) {
      var agent = tl.agentId && subMeta[tl.agentId];
      var go = agent ? '<span class="tool-chip-go">view →</span>' : '';
      var attr = agent ? ' data-agent="' + esc(tl.agentId) + '"' : '';
      var errBadge = tl.ok ? '' : '<span class="tool-badge err">error</span>';
      // Command/input — sits inline next to the tool name; collapsible if >2 lines
      var cmd = '';
      if (tl.command) {
        var lines = tl.command.split('\n');
        if (lines.length > CMD_COLLAPSE_LINES) {
          var preview = lines.slice(0, CMD_COLLAPSE_LINES).join('\n');
          cmd = '<div class="tool-block-cmd collapsible">' +
            '<pre class="tool-cmd-pre">' + esc(preview) + '</pre>' +
            '<pre class="tool-cmd-full">' + esc(tl.command) + '</pre>' +
            '<button class="tool-cmd-toggle" type="button">' +
            '<span class="tool-cmd-arrow" style="transform:rotate(90deg)">&#9654;</span> expand</button></div>';
        } else {
          cmd = '<div class="tool-block-cmd"><pre class="tool-cmd-pre">' + esc(tl.command) + '</pre></div>';
        }
      }
      // Body: tool-specific output, collapsed by default behind an inline toggle
      var body = '';
      var toggle = '';
      if (tl.hunks && tl.hunks.length) {
        // Edit/Write: render as inline diff (same style as Files tab)
        var diffRows = [];
        tl.hunks.forEach(function (h, hi) {
          if (hi) diffRows.push({ t: '~', s: '' });
          diffRows = diffRows.concat(diffLines(h.del, h.ins));
        });
        var diffHead = diffRows.slice(0, DIFF_ROW_CAP).map(rowHtml).join('');
        var diffRest = diffRows.length > DIFF_ROW_CAP
          ? '<div class="dl-rest">' + diffRows.slice(DIFF_ROW_CAP).map(rowHtml).join('') + '</div>' +
            '<button class="fc-rows-more" type="button">+ ' + (diffRows.length - DIFF_ROW_CAP) + ' more lines</button>'
          : '';
        body = '<div class="tool-block-body"><div class="fc-diff">' + diffHead + diffRest + '</div></div>';
        toggle = '<button class="tool-out-toggle" type="button">diff</button>';
      } else if (tl.output && tl.ok) {
        // Generic tool output. Failed calls already surface their result in the error
        // panel below, so an output toggle here would just duplicate it — skip it.
        body = '<div class="tool-block-body"><pre class="tool-output-pre">' + esc(tl.output) + '</pre></div>';
        toggle = '<button class="tool-out-toggle" type="button">output</button>';
      }
      // Single inline row: name · command · (output toggle / agent link) — replaces
      // the old dedicated header row to keep each tool call compact.
      var row = '<div class="tool-block-row"' + attr + '>' +
        '<span class="tool-block-name">' + esc(tl.name) + '</span>' +
        errBadge + cmd + go + toggle + '</div>';
      // Error panel for failed calls (stepper jump target)
      var errPanel = '';
      if (!tl.ok && tl.error) {
        errSeq++;                                            // count total errors (errCount)
        var anchor = tl.idx != null ? tl.idx : 's' + errSeq;  // stable per-call anchor for deep-links
        if (errSink) errSink.push(anchor);
        errPanel = '<div class="tx-error" id="txerr-' + anchor + '">' +
          '<div class="tx-error-h">⚠ ' + esc(tl.name) + '</div>' +
          '<div class="tx-error-b">' + esc(tl.error) + '</div></div>';
      }
      return '<div class="tool-block' + (tl.ok ? '' : ' err') + (agent ? ' agent' : '') + '">' +
        row + body + errPanel + '</div>';
    }

    function toolsHtml(tools) {
      var head = tools.slice(0, TOOLCAP).map(toolBlockHtml).join('');
      var restArr = tools.slice(TOOLCAP);
      var rest = restArr.length
        ? '<div class="tool-rest">' + restArr.map(toolBlockHtml).join('') + '</div>' +
          '<button class="tool-more" type="button" data-n="' + restArr.length + '">+ ' + restArr.length +
          ' more tool call' + (restArr.length > 1 ? 's' : '') + '</button>'
        : '';
      return '<div class="tools">' + head + rest + '</div>';
    }
    // A prominent, clickable banner standing in for a subagent-spawning call, so
    // the link into the subagent's scope is easy to find (and a stable anchor for
    // the subagent's "back" link).
    function spawnBlockHtml(sp, blk) {
      var m = subMeta[sp.agentId] || {};
      var lbl = (m.agentType || 'subagent') + (m.description ? ' · ' + m.description : '');
      var ba = blk != null ? ' data-blk="' + blk + '"' : '';
      return '<button class="tx-spawn" type="button" id="txspawn-' + esc(sp.agentId) + '" data-agent="' + esc(sp.agentId) + '"' + ba + '>' +
        '<span class="tx-spawn-ico">🤖</span><span class="tx-spawn-lbl">Spawned subagent · ' + esc(lbl) + '</span>' +
        '<span class="tx-spawn-go">view transcript →</span></button>';
    }
    // Message text, collapsed to a preview with a Show more/less toggle when long
    // (assistant/user text is capped at 20k server-side; this keeps walls of text
    // from dominating the scroll while still letting you read the whole thing).
    var MSG_PREVIEW = 1200;
    // `md` renders the text as Markdown (assistant/subagent responses); user
    // prompts stay plain-escaped so their literal formatting is preserved.
    function textBlock(text, md?) {
      var t = String(text || '');
      if (!t) return '';
      var render = md ? renderMd : esc;
      var cls = 'text' + (md ? ' md' : '');
      if (t.length <= 2000) return '<div class="' + cls + '">' + render(t) + '</div>';
      return '<div class="' + cls + ' msg"><span class="msg-prev">' + render(t.slice(0, MSG_PREVIEW)) + ' …</span>' +
        '<span class="msg-full">' + render(t) + '</span></div>' +
        '<button class="msg-more" type="button">Show more ↓</button>';
    }

    // Partition turns into scopes (main thread first, then each subagent in
    // first-seen order), keeping every turn's GLOBAL index for its txt-<i> anchor
    // (the Files view links there, so indices must stay stable across scopes).
    var scopeOrder = ['main'];
    var scopeItems = { main: [] };
    var scopeOfTurn = {};  // global turn index -> scope key
    allTurns.forEach(function (t, i) {
      var key = t.agentId || 'main';
      if (!(key in scopeItems)) { scopeItems[key] = []; scopeOrder.push(key); }
      scopeItems[key].push({ gi: i, t: t });
      scopeOfTurn[i] = key;
    });

    // Render one scope's turns to HTML, collecting its user turns (for the nav)
    // and pushing its error-panel ids into the scope's errIds via errSink.
    function renderScopeBlocks(items, isSub) {
      var blocks = [];
      var run = null;      // tools from consecutive tool-only turns (within one block)
      var runBlk = null;   // block idx of the current run (runs don't cross blocks, so a filter hides cleanly)
      var userTurns = [];  // {i (global), text} powering the outline + scroll-spy
      function flushRun() {
        if (run && run.length) {
          var a = runBlk != null ? ' data-blk="' + runBlk + '"' : '';
          blocks.push('<div class="turn asst toolrun"' + a + '><div class="role">Tool calls · ' + run.length + '</div>' +
            toolsHtml(run) + '</div>');
        }
        run = null; runBlk = null;
      }
      items.forEach(function (it) {
        var i = it.gi, t = it.t, tools = t.tools || [];
        var blk = t.blockIdx;
        var ba = blk != null ? ' data-blk="' + blk + '"' : '';
        if (t.role === 'user') {
          flushRun();
          userTurns.push({ i: i, text: t.text });
          blocks.push('<div class="turn user" id="txt-' + i + '"' + ba + '><div class="role">' + (isSub ? 'Prompt' : 'You') +
            '<span class="tnum">#' + userTurns.length + '</span></div>' + textBlock(t.text) + '</div>');
        } else if (t.text) {
          flushRun();
          blocks.push('<div class="turn asst" id="txt-' + i + '"' + ba + '><div class="role">' + (isSub ? 'Subagent' : 'Assistant') +
            '</div>' + textBlock(t.text, true) + (tools.length ? toolsHtml(tools) : '') + '</div>');
        } else if (tools.length) {
          // Surface spawning calls as their own banner; fold the rest into the run.
          // Flush when the block changes so a run stays within one block.
          var spawns = tools.filter(function (x) { return x.agentId && subMeta[x.agentId]; });
          if (spawns.length) {
            flushRun();
            spawns.forEach(function (sp) { blocks.push(spawnBlockHtml(sp, blk)); });
            var keep = tools.filter(function (x) { return !(x.agentId && subMeta[x.agentId]); });
            if (keep.length) { if (run && blk !== runBlk) flushRun(); runBlk = blk; run = (run || []).concat(keep); }
          } else {
            if (run && blk !== runBlk) flushRun();
            runBlk = blk; run = (run || []).concat(tools);
          }
        }
      });
      flushRun();
      return { blocksHtml: blocks.join(''), userTurns: userTurns };
    }

    var scopes = scopeOrder.map(function (key) {
      var errIds = [];
      errSink = errIds;
      var r = renderScopeBlocks(scopeItems[key], key !== 'main');
      var m = key === 'main' ? {} : (subMeta[key] || {});
      return {
        key: key, agentType: m.agentType, description: m.description, toolUseId: m.toolUseId,
        blocksHtml: r.blocksHtml, userTurns: r.userTurns, errIds: errIds
      };
    });
    errSink = null;
    var scopeByKey: any = {};
    scopes.forEach(function (sc) { scopeByKey[sc.key] = sc; });
    var hasSub = scopeOrder.length > 1;
    var errCount = errSeq;     // total tool errors across all scopes

    // The scope's active state is reassigned by switchScope; the nav reads these.
    var activeScope = 'main';
    var userTurns = scopeByKey.main.userTurns;
    var errIds = scopeByKey.main.errIds;

    function scopeBtnHtml(sc) {
      var lbl, ico = '', title = '';
      if (sc.key === 'main') lbl = 'Main thread';
      else {
        ico = '🤖 ';
        lbl = (sc.agentType || 'subagent') + (sc.description ? ' · ' + clipLine(sc.description, 36) : '');
        title = (sc.agentType || 'subagent') + (sc.description ? ': ' + sc.description : '');
      }
      var err = sc.errIds.length ? '<span class="tx-scope-err">⚠' + sc.errIds.length + '</span>' : '';
      return '<button class="tx-scope-btn' + (sc.key === 'main' ? ' on' : '') + '" type="button" data-scope="' +
        esc(sc.key) + '" title="' + esc(title) + '">' + ico + esc(lbl) + err + '</button>';
    }
    var scopeBar = hasSub
      ? '<div class="tx-scopes">' + scopes.map(scopeBtnHtml).join('') + '</div>'
      : '';

    function outlineHtml(uts) {
      return uts.length
        ? uts.map(function (u, k) {
            return '<button class="tx-ol-item" type="button" data-k="' + k + '" data-goto="txt-' + u.i + '">' +
              '<span class="tx-ol-n">' + (k + 1) + '</span><span class="tx-ol-tx">' + esc(clipLine(u.text, 90)) + '</span></button>';
          }).join('')
        : '<div class="empty">No turns.</div>';
    }
    var nav = '<div class="tx-nav">' +
      '<div class="tx-filter-wrap"></div>' +
      '<div class="tx-nav-row">' +
        '<div class="tx-grp">' +
          '<span class="tx-grp-lbl">Turn</span>' +
          '<button class="btn tx-turn-prev" type="button" title="Previous turn">‹</button>' +
          '<span class="tx-pos"><b class="tx-turn-pos">' + (userTurns.length ? 1 : 0) + '</b>/<span class="tx-turn-total">' + userTurns.length + '</span></span>' +
          '<button class="btn tx-turn-next" type="button" title="Next turn">›</button>' +
          '<div class="tx-ol-wrap"><button class="tx-ol-btn" type="button" title="Jump to a turn">▾</button>' +
            '<div class="tx-outline" id="tx-outline">' + outlineHtml(userTurns) + '</div></div>' +
        '</div>' +
        '<div class="tx-grp tx-search">' +
          '<input class="tx-search-input" type="text" placeholder="Search — press Enter" />' +
          '<div class="tx-search-results">' +
            '<button class="btn tx-search-prev" type="button" title="Previous match">‹</button>' +
            '<span class="tx-pos"><b class="tx-search-pos">0</b>/<span class="tx-search-total">0</span></span>' +
            '<button class="btn tx-search-next" type="button" title="Next match">›</button>' +
            '<button class="btn tx-search-x" type="button" title="Clear">×</button>' +
          '</div>' +
        '</div>' +
        (errCount
          ? '<div class="tx-grp tx-errs"><span class="tx-grp-lbl">⚠ Errors</span>' +
            '<button class="btn tx-err-prev" type="button">‹</button>' +
            '<span class="tx-pos"><b class="tx-err-pos">—</b>/<span class="tx-err-total">' + errIds.length + '</span></span>' +
            '<button class="btn tx-err-next" type="button">›</button></div>'
          : '<span class="tx-grp none">no tool errors</span>') +
      '</div>' +
      '<div class="tx-now" id="tx-now"></div>' +
      '</div>';

    // Subagent scopes get a header (type/description + a link back to the call).
    function subPaneHeader(sc) {
      if (sc.key === 'main') return '';
      var back = sc.toolUseId
        ? '<button class="tx-sub-back" type="button" data-agent="' + esc(sc.key) + '">↩ back to spawning call</button>'
        : '';
      return '<div class="tx-sub-head"><span class="tx-spawn-ico">🤖</span> <b>' + esc(sc.agentType || 'subagent') + '</b>' +
        (sc.description ? ' <span class="tx-sub-desc">' + esc(sc.description) + '</span>' : '') + back + '</div>';
    }
    var panesHtml = scopes.map(function (sc) {
      return '<div class="tx-scope-pane' + (sc.key === 'main' ? ' on' : '') + '" data-scope="' + esc(sc.key) + '">' +
        subPaneHeader(sc) + (sc.blocksHtml || '<div class="empty">No turns.</div>') + '</div>';
    }).join('');

    var hasTx = allTurns.length > 0;
    var txBody = hasTx ? panesHtml : '<div class="empty">No transcript stored.</div>';
    // One sticky header (title + tabs + scope bar + transcript nav) over the panes.
    $('#drawerBody').innerHTML =
      '<div class="drawer-head">' + headTop + tabs + (hasTx ? scopeBar : '') + (hasTx ? nav : '') + '</div>' +
      '<div class="dpane" id="dpane-summary">' + sum + '</div>' +
      (fileCount ? '<div class="dpane" id="dpane-files"><div class="empty">Loading file changes…</div></div>' : '') +
      '<div class="dpane on" id="dpane-transcript">' + txBody + '</div>';

    // Keep --head-h (used for sticky-aware scroll-margin) in step with the header,
    // whose height changes when the transcript nav shows/hides between tabs.
    function syncHeadH() {
      var h = $('#drawerBody .drawer-head');
      if (h) $('#drawer').style.setProperty('--head-h', h.offsetHeight + 'px');
    }
    // Error bodies are scrollable; the failure usually sits at the end, so park
    // each at its bottom. Run once the pane is visible (hidden → scrollHeight 0).
    function scrollErrPanels() {
      Array.prototype.forEach.call(document.querySelectorAll('#dpane-transcript .tx-error-b'), function (el) {
        el.scrollTop = el.scrollHeight;
      });
    }

    // Tab switching — shared by the top tabs and the summary "See transcript".
    // The transcript nav lives in the shared header but only shows on that tab;
    // the Files diffs are fetched lazily the first time that tab is opened.
    var filesLoaded = false, filesRendered = false, pendingFile = null;
    function expandFile(path) {
      var pane = $('#dpane-files'); if (!pane) return;
      var card = null;
      Array.prototype.forEach.call(pane.querySelectorAll('.fc-file'), function (c) { if (c.getAttribute('data-path') === path) card = c; });
      if (card) { card.classList.remove('collapsed'); card.scrollIntoView({ block: 'start' }); flashEl(card); }
    }
    // A summary file chip → the Files tab with that file expanded (after lazy load).
    function openFile(path) {
      pendingFile = path;
      showTab('files');
      if (filesRendered) { expandFile(path); pendingFile = null; }
    }
    function showTab(name) {
      _activeTab = name;
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dtab'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-dtab') === name);
      });
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dpane'), function (p) {
        p.classList.toggle('on', p.id === 'dpane-' + name);
      });
      var navEl = $('#drawerBody .tx-nav');
      if (navEl) navEl.classList.toggle('on', name === 'transcript');
      var sbEl = $('#drawerBody .tx-scopes');
      if (sbEl) sbEl.classList.toggle('on', name === 'transcript');
      $('#drawer').scrollTop = 0;
      syncHeadH();
      if (name === 'files' && !filesLoaded) { filesLoaded = true; loadFiles(); }
      if (name === 'transcript') requestAnimationFrame(function () { spy(); scrollErrPanels(); });
    }
    function loadFiles() {
      get('/api/session-files?id=' + encodeURIComponent(id)).then(function (res) {
        var edits = (res && res.edits) || [];
        var txTurns = (d.transcript && d.transcript.turns) || [];
        prepEdits(edits, txTurns);
        var pane = $('#dpane-files');
        if (!pane) return;
        pane.innerHTML =
          '<div class="fc-hint">Grouped by file · click a file to see its diff, where edits are headed by the prompt that drove them (▸ is the agent’s note) · → opens the transcript.</div>' +
          filesHtml(edits, txTurns);
        Array.prototype.forEach.call(pane.querySelectorAll('.fc-head'), function (b) {
          b.onclick = function () { b.parentNode.classList.toggle('collapsed'); };
        });
        Array.prototype.forEach.call(pane.querySelectorAll('.fc-rows-more'), function (b) {
          b.onclick = function () { b.previousElementSibling.classList.add('on'); b.style.display = 'none'; };
        });
        Array.prototype.forEach.call(pane.querySelectorAll('.fc-jump'), function (b) {
          b.onclick = function () { jumpToIntent(parseInt(b.getAttribute('data-u'), 10), -1); };
        });
        Array.prototype.forEach.call(pane.querySelectorAll('.msg-more'), function (b) {
          b.onclick = function () { var on = b.previousElementSibling.classList.toggle('on'); b.textContent = on ? 'Show less ↑' : 'Show more ↓'; };
        });
        filesRendered = true;
        if (pendingFile) { expandFile(pendingFile); pendingFile = null; }
      });
    }
    // From a file edit, jump to the user message that prompted it (the intent),
    // falling back to the edit's own turn. Switch to the scope that owns the
    // target turn first (a subagent's edit lives in its tab); the spy re-syncs.
    function jumpToIntent(u, t) {
      showTab('transcript');
      var gi = u >= 0 ? u : (t >= 0 ? t : -1);
      if (gi < 0) return;
      switchScope(scopeOfTurn[gi] || 'main');
      requestAnimationFrame(function () {
        var el = document.getElementById('txt-' + gi);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flashEl(el); }
      });
    }
    var closeBtn = $('#drawerCloseBtn');
    if (closeBtn) closeBtn.onclick = closeDrawer;
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dtab'), function (b) {
      b.onclick = function () { showTab(b.getAttribute('data-dtab')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .see-tx'), function (b) {
      b.onclick = function () { showTab(b.getAttribute('data-tab')); };
    });

    // Truncation toggles: summary chip lists (files/features) + per-turn tool runs.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .chip-more'), function (b) {
      b.onclick = function () {
        var open = b.previousElementSibling.classList.toggle('on');
        b.textContent = open ? 'show fewer ‹' : 'show all ' + b.getAttribute('data-n') + ' ›';
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tool-more'), function (b) {
      b.onclick = function () {
        var open = b.previousElementSibling.classList.toggle('on');
        var n = b.getAttribute('data-n');
        b.textContent = open ? '– show fewer' : '+ ' + n + ' more tool call' + (n > 1 ? 's' : '');
      };
    });
    // Expand/collapse a tool's command section (>2 lines collapsed by default).
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tool-cmd-toggle'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var wrap = b.closest('.tool-block-cmd');
        var on = wrap.classList.toggle('on');
        b.innerHTML = on
          ? '<span class="tool-cmd-arrow" style="transform:rotate(-90deg)">&#9654;</span> collapse'
          : '<span class="tool-cmd-arrow" style="transform:rotate(90deg)">&#9654;</span> expand';
        refreshSearch();
      };
    });
    // Expand overflow diff rows in tool blocks.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tool-block-body .fc-rows-more'), function (b) {
      b.onclick = function () { b.previousElementSibling.classList.add('on'); b.style.display = 'none'; };
    });
    // Toggle a tool call's output/diff body (collapsed by default).
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tool-out-toggle'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var body = b.closest('.tool-block').querySelector('.tool-block-body');
        if (body) b.classList.toggle('on', body.classList.toggle('on'));
      };
    });
    // Expand a long message's preview to its full text.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .msg-more'), function (b) {
      b.onclick = function () {
        var on = b.previousElementSibling.classList.toggle('on');
        b.textContent = on ? 'Show less ↑' : 'Show more ↓';
        refreshSearch();
      };
    });

    // Artifact chips pivot to a filtered session list.
    var sumChips = document.querySelectorAll('#drawerBody .tag.click');
    // A feature/PR chip is clickable only when there are ≥2 of THAT kind in the
    // summary (focus the transcript on it); a lone one has nothing to filter, so
    // disable it. Gate on what's actually shown — the transcript's block-level
    // feature dim can be sparser than the session's linked features.
    var kindCount = {};
    Array.prototype.forEach.call(sumChips, function (el) { var k = el.getAttribute('data-kind'); kindCount[k] = (kindCount[k] || 0) + 1; });
    Array.prototype.forEach.call(sumChips, function (el) {
      var kind = el.getAttribute('data-kind'), art = el.getAttribute('data-art');
      if (kind === 'feature' || kind === 'pr') {
        if ((kindCount[kind] || 0) >= 2) el.onclick = function () { focusDim(kind, resolveDimValue(kind, art)); };
        else el.classList.remove('click');
      } else if (kind === 'file') {
        el.onclick = function () { openFile(art); };
      } else {
        el.onclick = function () { filterByArtifact(art, kind); };
      }
    });

    // ----- Link-add buttons: "+" opens inline typeahead to link artifacts ------
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .link-add-btn'), function (btn) {
      btn.onclick = function () {
        var kind = btn.getAttribute('data-link-kind');
        var sid = btn.getAttribute('data-session-id');
        var area = document.querySelector('#drawerBody .link-add-area[data-link-kind="' + kind + '"][data-session-id="' + sid + '"]') as HTMLElement;
        if (!area) return;
        if (area.classList.contains('on')) { area.classList.remove('on'); area.innerHTML = ''; return; }
        area.classList.add('on');
        area.innerHTML =
          '<div class="link-ac">' +
            '<input class="link-ac-input" placeholder="' + (kind === 'feature' ? 'Search features or type a name to create…' : kind === 'pr' ? 'Paste URL or type owner/repo#123…' : 'Search…') + '" />' +
            '<div class="link-ac-menu"></div>' +
          '</div>';
        var inp = area.querySelector('.link-ac-input') as HTMLInputElement;
        var menu = area.querySelector('.link-ac-menu') as HTMLElement;
        var debounce: any = null;
        inp.focus();
        inp.oninput = function () {
          var err = area.querySelector('.link-ac-error');
          if (err) err.remove();
          clearTimeout(debounce);
          debounce = setTimeout(function () { linkAcFetch(inp, menu, sid, kind); }, 200);
        };
        inp.onkeydown = function (e) {
          if (e.key === 'Escape') { area.classList.remove('on'); area.innerHTML = ''; }
          if (e.key === 'Enter') { linkAcSelect(inp, menu, sid, kind, -1); }
        };
      };
    });

    // ----- Link-remove buttons: "✕" on feature chips rejects the link ----------
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .link-remove-btn'), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var sid = btn.getAttribute('data-session-id');
        var aid = btn.getAttribute('data-artifact-id');
        if (!sid || !aid) return;
        post('/api/session-links/remove', { sessionId: sid, artifactId: aid }).then(function (res) {
          if (res && res.ok) openDetail(sid);
        }).catch(function () {});
      };
    });

    // ----- Transcript navigation: turn stepper + scroll-spy + error stepper ----
    var curTurn = 0;
    // A programmatic jump sets the indicator explicitly AND triggers a smooth
    // scroll, whose scroll events would otherwise make spy() recompute a stale
    // mid-animation value and clobber it. Mute spy for the scroll's duration.
    var spyMuted = false, muteTimer = 0;
    function muteSpy() {
      spyMuted = true;
      clearTimeout(muteTimer);
      muteTimer = setTimeout(function () { spyMuted = false; }, 700);
    }
    function updateIndicator(k) {
      if (!userTurns.length) return;
      curTurn = k;
      var pos = $('#drawerBody .tx-turn-pos'); if (pos) pos.textContent = String(k + 1);
      var now = $('#tx-now'); if (now) now.textContent = '#' + (k + 1) + ' · ' + clipLine(userTurns[k].text, 130);
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-ol-item'), function (it) {
        it.classList.toggle('cur', it.getAttribute('data-k') === String(k));
      });
    }
    function jumpToTurn(k) {
      if (!userTurns.length) return;
      k = Math.max(0, Math.min(userTurns.length - 1, k));
      updateIndicator(k);
      muteSpy();
      var el = document.getElementById('txt-' + userTurns[k].i);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flashEl(el); }
    }
    // Which user-turn section the scroll position is currently in (the last user
    // turn whose top has passed below the sticky header). The line sits BELOW a
    // jumped-to turn's resting top (scroll-margin ≈ head+10) so the jump target
    // counts as current; a bottom guard catches the last turn (can't reach top).
    function spy() {
      if (spyMuted) return;
      var pane = $('#dpane-transcript');
      if (!pane || !pane.classList.contains('on') || !userTurns.length) return;
      var headEl = $('#drawerBody .drawer-head');
      var line = (headEl ? headEl.getBoundingClientRect().bottom : 0) + 20;
      var cur = 0;
      for (var k = 0; k < userTurns.length; k++) {
        var el = document.getElementById('txt-' + userTurns[k].i);
        if (el && el.getBoundingClientRect().top <= line) cur = k; else break;
      }
      var dr = $('#drawer');
      if (dr && dr.scrollTop + dr.clientHeight >= dr.scrollHeight - 2) cur = userTurns.length - 1;
      if (cur !== curTurn) updateIndicator(cur);
    }
    var spyRAF = 0;
    $('#drawer').onscroll = function () {
      if (!spyRAF) spyRAF = requestAnimationFrame(function () { spyRAF = 0; spy(); });
    };
    var tp = $('#drawerBody .tx-turn-prev'), tn = $('#drawerBody .tx-turn-next');
    if (tp) tp.onclick = function () { jumpToTurn(curTurn - 1); };
    if (tn) tn.onclick = function () { jumpToTurn(curTurn + 1); };

    // Outline dropdown: open/close + jump to a specific turn (highlights current).
    var olBtn = $('#drawerBody .tx-ol-btn'), olPanel = $('#tx-outline');
    if (olBtn) olBtn.onclick = function () { olPanel.classList.toggle('on'); olBtn.classList.toggle('on'); };
    // (Re)wire the outline items to jump within the active scope. Called on open
    // and whenever switchScope swaps the outline's contents.
    function wireOutline() {
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-ol-item'), function (it) {
        it.onclick = function () {
          if (olPanel) olPanel.classList.remove('on');
          if (olBtn) olBtn.classList.remove('on');
          jumpToTurn(parseInt(it.getAttribute('data-k'), 10));
        };
      });
    }
    wireOutline();
    if (userTurns.length) updateIndicator(0);

    // Error stepper: ‹ / › cycle through the ACTIVE scope's error panels (errIds
    // are global panel ids, so the anchors resolve even with all scopes in the DOM).
    // Scroll to an error panel, FIRST revealing it: a call beyond the per-turn cap
    // sits in a collapsed ".tool-rest" group (display:none), where scrollIntoView is
    // a no-op. Expand that group (and hide its "+N more" button), then scroll+flash.
    function revealErr(anchor) {
      var el = document.getElementById('txerr-' + anchor);
      if (!el) return;
      var rest = el.closest && el.closest('.tool-rest');
      if (rest && !rest.classList.contains('on')) {
        rest.classList.add('on');
        var mb = rest.nextElementSibling as any;
        if (mb && mb.classList.contains('tool-more')) mb.style.display = 'none';
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashOnSettle(el);
    }
    var errIdx = -1;
    function gotoErr(next) {
      if (!errIds.length) return;
      errIdx = ((next % errIds.length) + errIds.length) % errIds.length;
      var pos = $('#drawerBody .tx-err-pos');
      if (pos) pos.textContent = String(errIdx + 1);
      revealErr(errIds[errIdx]);
    }
    var ep = $('#drawerBody .tx-err-prev'), en = $('#drawerBody .tx-err-next');
    if (ep) ep.onclick = function () { gotoErr(errIdx - 1); };
    if (en) en.onclick = function () { gotoErr(errIdx + 1); };

    // Search runs on explicit Enter, not per keystroke: a full-transcript DOM walk
    // that wraps a <mark> around every hit is far too expensive to run live on big
    // sessions (a short prefix like "a" would mutate thousands of nodes and hang
    // the page). First Enter searches the term; pressing Enter again with the same
    // term steps to the next match, Shift+Enter to the previous.
    var searchInput = $('#drawerBody .tx-search-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.oninput = function () {
        // Only the cheap "box emptied" case acts live (clears highlights); a term
        // change waits for Enter rather than re-running the expensive pass.
        if (!searchInput.value.trim()) transcriptSearch('');
      };
      searchInput.onkeydown = function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var q = searchInput.value.trim();
          if (q !== lastSearched) transcriptSearch(q);
          else if (searchMatches.length) jumpToSearchMatch(searchIdx + (e.shiftKey ? -1 : 1));
        }
        if (e.key === 'Escape') { searchInput.value = ''; transcriptSearch(''); searchInput.blur(); }
      };
    }
    var spBtn = $('#drawerBody .tx-search-prev'), snBtn = $('#drawerBody .tx-search-next'), sxBtn = $('#drawerBody .tx-search-x');
    if (spBtn) spBtn.onclick = function () { jumpToSearchMatch(searchIdx - 1); };
    if (snBtn) snBtn.onclick = function () { jumpToSearchMatch(searchIdx + 1); };
    if (sxBtn) sxBtn.onclick = function () { if (searchInput) { searchInput.value = ''; } transcriptSearch(''); };

    // ----- Block filter: focus the main thread on one PR / feature / use-case --
    function mainPaneEl() { return document.querySelector('#drawerBody .tx-scope-pane[data-scope="main"]'); }
    function renderFilterBar() {
      var c = $('#drawerBody .tx-filter-wrap'); if (!c) return;
      c.innerHTML = filterBarHtml();
      var sel = c.querySelector('.tx-fdim');
      if (sel) sel.onchange = function () { fDim = this.value; fVal = null; renderFilterBar(); applyTxFilter(true); refreshSearch(); };
      Array.prototype.forEach.call(c.querySelectorAll('.tx-fchip'), function (b) {
        b.onclick = function () { var v = b.getAttribute('data-v'); fVal = v === '' ? null : v; renderFilterBar(); applyTxFilter(true); refreshSearch(); };
      });
    }
    // `scroll` (a user chip/switcher click) lands at the top of the newly-focused
    // view — otherwise switching focus after scrolling leaves you mid-transcript.
    function applyTxFilter(scroll?: boolean) {
      var pane = mainPaneEl(); if (!pane) return;
      Array.prototype.forEach.call(pane.querySelectorAll('.tx-gap'), function (g) { if (g.parentNode) g.parentNode.removeChild(g); });
      var els = Array.prototype.filter.call(pane.children, function (el) { return el.hasAttribute('data-blk'); });
      if (fVal == null || fDim == null) {
        els.forEach(function (el) { el.classList.remove('tx-hidden'); });
      } else {
        var run = [];
        var flush = function () {
          if (!run.length) return;
          var labels = {};
          run.forEach(function (el) { var l = blkLabel(parseInt(el.getAttribute('data-blk'), 10), fDim); if (l) labels[l] = 1; });
          var ks = Object.keys(labels);
          var n = run.filter(function (el) { return el.classList.contains('turn'); }).length || run.length;
          var g = document.createElement('div'); g.className = 'tx-gap';
          g.textContent = '··· ' + n + ' turn' + (n > 1 ? 's' : '') + (ks.length === 1 ? ' on ' + ks[0] : ' elsewhere') + ' ···';
          pane.insertBefore(g, run[0]); run = [];
        };
        els.forEach(function (el) {
          if (blkVal(parseInt(el.getAttribute('data-blk'), 10), fDim) === fVal) { flush(); el.classList.remove('tx-hidden'); }
          else { el.classList.add('tx-hidden'); run.push(el); }
        });
        flush();
      }
      recountTurns();
      if (scroll) {
        var first = pane.querySelector('[data-blk]:not(.tx-hidden)');
        if (first) { muteSpy(); first.scrollIntoView({ block: 'start' }); flashEl(first); }
      }
    }
    // Re-point the turn AND error steppers + the outline at the currently-VISIBLE
    // main-thread content, so every nav control walks only what you can see.
    function recountTurns() {
      if (activeScope !== 'main') return;
      var full = scopeByKey.main.userTurns;
      var vis = full.filter(function (u) { var el = document.getElementById('txt-' + u.i); return el && !el.classList.contains('tx-hidden'); });
      userTurns = vis;
      var tt = $('#drawerBody .tx-turn-total'); if (tt) tt.textContent = String(vis.length);
      var ol = $('#tx-outline'); if (ol) ol.innerHTML = outlineHtml(vis);
      wireOutline();
      curTurn = 0;
      if (vis.length) updateIndicator(0);
      else { var pos = $('#drawerBody .tx-turn-pos'); if (pos) pos.textContent = '0'; var now = $('#tx-now'); if (now) now.textContent = ''; }
      // Error stepper: cycle only errors whose block is still visible (a panel
      // lives inside a turn/toolrun, so check that ancestor's tx-hidden).
      errIds = scopeByKey.main.errIds.filter(function (eid) {
        var el = document.getElementById('txerr-' + eid);
        return el && !el.closest('.tx-hidden');
      });
      errIdx = -1;
      var et = $('#drawerBody .tx-err-total'); if (et) et.textContent = String(errIds.length);
      var epos = $('#drawerBody .tx-err-pos'); if (epos) epos.textContent = '—';
      syncHeadH();
    }
    renderFilterBar();
    if (dimsAvail.length) applyTxFilter();

    // ----- Transcript search: highlight + step through matches in active scope ---
    var SEARCH_MIN = 2;     // ignore terms shorter than this (kills 'a'/'e' noise)
    var SEARCH_CAP = 100;   // stop wrapping after this many hits — a page-freeze
                            // backstop; a common term shows "100+", a cue to refine.
    var searchMatches = [];
    var searchIdx = -1;
    var searchCapped = false;
    var lastSearched = null;  // term of the last executed search (null = none yet)

    function updateSearchUI(pos, total) {
      var p = $('#drawerBody .tx-search-pos'); if (p) p.textContent = String(pos);
      var t = $('#drawerBody .tx-search-total'); if (t) t.textContent = total + (searchCapped ? '+' : '');
    }

    function clearHighlights() {
      var marks = document.querySelectorAll('#dpane-transcript .tx-hl');
      Array.prototype.forEach.call(marks, function (m) {
        var parent = m.parentNode;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      searchMatches = [];
      searchIdx = -1;
      searchCapped = false;
    }

    function expandAncestors(el) {
      var body = el.closest('.tool-block-body');
      if (body && !body.classList.contains('on')) {
        body.classList.add('on');
        var tog = body.parentElement.querySelector('.tool-out-toggle');
        if (tog) tog.classList.add('on');
      }
      var msg = el.closest('.msg');
      if (msg && !msg.classList.contains('on')) msg.classList.add('on');
      var rest = el.closest('.tool-rest');
      if (rest && !rest.classList.contains('on')) rest.classList.add('on');
      var dlr = el.closest('.dl-rest');
      if (dlr && !dlr.classList.contains('on')) dlr.classList.add('on');
      var cmd = el.closest('.tool-block-cmd.collapsible');
      if (cmd && !cmd.classList.contains('on')) cmd.classList.add('on');
    }

    function jumpToSearchMatch(idx) {
      if (!searchMatches.length) return;
      if (searchIdx >= 0 && searchMatches[searchIdx]) searchMatches[searchIdx].classList.remove('active');
      searchIdx = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
      var mark = searchMatches[searchIdx];
      mark.classList.add('active');
      expandAncestors(mark);
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateSearchUI(searchIdx + 1, searchMatches.length);
    }

    function transcriptSearch(query) {
      clearHighlights();
      lastSearched = query;
      // Below the minimum, treat it as no active search: clear and collapse the
      // stepper rather than wrap thousands of noise hits.
      var sg = $('#drawerBody .tx-search');
      if (query.length < SEARCH_MIN) { if (sg) sg.classList.remove('on'); updateSearchUI(0, 0); return; }
      if (sg) sg.classList.add('on');
      var pane = document.querySelector('#dpane-transcript .tx-scope-pane.on');
      if (!pane) return;
      var lowerQ = query.toLowerCase();
      var qLen = query.length;
      var walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var el = n.parentElement;
          if (!el) return NodeFilter.FILTER_ACCEPT;
          // Messages have .msg-prev (truncated) + .msg-full (complete). Always
          // search the full version so matches beyond the preview are found;
          // skip the preview to avoid duplicates. expandAncestors reveals .msg-full.
          if (el.closest('.tx-hidden')) return NodeFilter.FILTER_REJECT;
          if (el.closest('.msg-prev')) return NodeFilter.FILTER_REJECT;
          // Commands have .tool-cmd-pre (first 2 lines) + .tool-cmd-full (complete).
          // Same logic: search the full, skip the preview.
          if (el.closest('.tool-cmd-pre')) {
            var cmdWrap = el.closest('.tool-block-cmd.collapsible');
            if (cmdWrap && cmdWrap.querySelector('.tool-cmd-full')) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (var ni = 0; ni < textNodes.length && searchMatches.length < SEARCH_CAP; ni++) {
        var node = textNodes[ni];
        var text = node.textContent;
        var lower = text.toLowerCase();
        var offsets = [];
        var idx = lower.indexOf(lowerQ);
        while (idx !== -1) { offsets.push(idx); idx = lower.indexOf(lowerQ, idx + qLen); }
        var nodeMarks = [];
        for (var k = offsets.length - 1; k >= 0; k--) {
          var range = document.createRange();
          range.setStart(node, offsets[k]);
          range.setEnd(node, offsets[k] + qLen);
          var mark = document.createElement('mark');
          mark.className = 'tx-hl';
          range.surroundContents(mark);
          nodeMarks.unshift(mark);
        }
        searchMatches = searchMatches.concat(nodeMarks);
      }
      searchCapped = searchMatches.length >= SEARCH_CAP;
      updateSearchUI(searchMatches.length ? 1 : 0, searchMatches.length);
      if (searchMatches.length) jumpToSearchMatch(0);
    }

    function refreshSearch() {
      var q = searchInput && searchInput.value.trim();
      if (q) transcriptSearch(q);
    }

    // ----- Subagent scopes: switch tab, link from spawn calls, link back -------
    // Point the nav (turn stepper, outline, error stepper, scroll-spy) at a scope
    // and show its pane. Indices are global, so the steppers/anchors carry over.
    function switchScope(key) {
      if (!scopeByKey[key]) key = 'main';
      if (key === activeScope) return;
      activeScope = key;
      userTurns = scopeByKey[key].userTurns;
      errIds = scopeByKey[key].errIds;
      errIdx = -1;
      curTurn = 0;
      if (searchInput) { searchInput.value = ''; }
      clearHighlights();
      updateSearchUI(0, 0);
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-scope-btn'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-scope') === key);
      });
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-scope-pane'), function (p) {
        p.classList.toggle('on', p.getAttribute('data-scope') === key);
      });
      var tt = $('#drawerBody .tx-turn-total'); if (tt) tt.textContent = String(userTurns.length);
      var et = $('#drawerBody .tx-err-total'); if (et) et.textContent = String(errIds.length);
      var ep2 = $('#drawerBody .tx-err-pos'); if (ep2) ep2.textContent = '—';
      var ol = $('#tx-outline'); if (ol) ol.innerHTML = outlineHtml(userTurns);
      wireOutline();
      $('#drawer').scrollTop = 0;
      if (userTurns.length) { updateIndicator(0); }
      else {
        var pos = $('#drawerBody .tx-turn-pos'); if (pos) pos.textContent = '0';
        var now = $('#tx-now'); if (now) now.textContent = '';
      }
      // The block filter applies to the main thread only; re-apply it on return.
      var fw = $('#drawerBody .tx-filter-wrap'); if (fw) fw.style.display = key === 'main' ? '' : 'none';
      if (key === 'main' && dimsAvail.length) applyTxFilter();
      syncHeadH();
    }
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-scope-btn'), function (b) {
      b.onclick = function () { switchScope(b.getAttribute('data-scope')); };
    });
    // A spawning call (banner or chip) opens its subagent's scope.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-spawn, #drawerBody .tool-block.agent .tool-block-row'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); switchScope(b.getAttribute('data-agent')); };
    });
    // A subagent's "back" link returns to the main thread and flashes the call.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-sub-back'), function (b) {
      b.onclick = function () {
        switchScope('main');
        requestAnimationFrame(function () {
          var el = document.getElementById('txspawn-' + b.getAttribute('data-agent'));
          if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); flashEl(el); }
        });
      };
    });

    // Land on Transcript by default; restore previous tab only when re-opening the same session.
    var restoreTab = (_activeSessionId === id ? _activeTab : null) || 'transcript';
    if (restoreTab === 'files' && !fileCount) restoreTab = 'transcript';
    if (restoreTab === 'transcript' && !hasTx) restoreTab = 'summary';
    _activeSessionId = id;
    showTab(restoreTab);
    $('#drawer').classList.add('on');
    $('#overlay').classList.add('on');

    // Reveal a failed tool call inside THIS drawer: switch to its scope if needed,
    // then revealErr. Published to activeReveal so the pager reuses it same-session.
    function revealErrorTarget(target) {
      var sc = 'main';
      scopeOrder.forEach(function (k) { if (scopeByKey[k].errIds.indexOf(target) >= 0) sc = k; });
      if (sc !== activeScope) switchScope(sc);
      requestAnimationFrame(function () { revealErr(target); });
    }
    activeReveal = revealErrorTarget;
    if (focus && focus.errTarget != null) revealErrorTarget(focus.errTarget);
  });
}

export function filterByArtifact(text, kind) {
  closeDrawer();
  setView('sessions');
  var af = $('#f-artifact');
  if (af) { af.value = text || ''; af.dataset.kind = kind || ''; } // kind rides along on the input (no visible kind dropdown)
  // Drilling into one artifact should show its FULL history, not just the default
  // window — widen to all-time. setTimePreset() re-applies the filters.
  setTimePreset('all');
}

// Drill-in from the dashboard's "Errors by category" widget: jump to the Sessions
// list filtered to one error category, over the SAME window the user clicked from
export function filterByErrorCategory(category) {
  setView('sessions');
  buildFilters();
  Array.prototype.forEach.call(document.querySelectorAll('.facet-filter[data-key="error_category"]'), function (s) {
    s.value = category || '';
  });
  setTimePreset(state.days === 'all' ? 'all' : state.days);
}

export function closeDrawer() {
  $('#drawer').classList.remove('on'); $('#overlay').classList.remove('on');
  activeReveal = null;
  errWalk = null; renderErrWalkBar(); // closing the drawer ends any error walk
}

// The open drawer publishes its error-reveal fn here so the pager can reveal the
// next error in place without re-opening the session. Null when no drawer is open.
var activeReveal: ((idx: number) => void) | null = null;

// ---- Cross-session error walk -------------------------------------------------
// "Step through every occurrence of one error category." The dashboard widget
// hands us the occurrence list; we open each occurrence's transcript at its exact
// error block (txerr-<idx>) and show a floating pager that walks ACROSS sessions.
// The pager lives outside #drawerBody so it survives the drawer re-rendering as we
// move between sessions.
var errWalk = null; // { label, occ:[{sessionId,idx,name,title,...}], i, openId }

export function startErrorWalk(label, occ, i) {
  if (!occ || !occ.length) return;
  errWalk = { label: label, occ: occ, i: 0, openId: null };
  openWalkOcc(i || 0);
}

function openWalkOcc(i) {
  if (!errWalk) return;
  var n = errWalk.occ.length;
  errWalk.i = ((i % n) + n) % n; // wrap
  var o = errWalk.occ[errWalk.i];
  if (o.sessionId === errWalk.openId && activeReveal) {
    activeReveal(o.idx); // same session open → reveal in place
  } else {
    errWalk.openId = o.sessionId;
    openDetail(o.sessionId, { errTarget: o.idx });
  }
  renderErrWalkBar();
}

function renderErrWalkBar() {
  var bar = document.getElementById('errwalk');
  if (!errWalk) { if (bar) bar.parentNode.removeChild(bar); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'errwalk'; document.body.appendChild(bar); }
  var o = errWalk.occ[errWalk.i];
  bar.innerHTML =
    '<span class="ew-cat">⚠ ' + esc(errWalk.label) + '</span>' +
    '<button class="ew-btn" id="ew-prev" type="button">‹</button>' +
    '<span class="ew-pos">' + (errWalk.i + 1) + ' / ' + errWalk.occ.length + '</span>' +
    '<button class="ew-btn" id="ew-next" type="button">›</button>' +
    '<span class="ew-cur" title="' + esc(o.title || '') + '">' + esc(o.name) + '</span>' +
    '<button class="ew-btn ew-x" id="ew-close" type="button">✕</button>';
  $('#ew-prev').onclick = function () { openWalkOcc(errWalk.i - 1); };
  $('#ew-next').onclick = function () { openWalkOcc(errWalk.i + 1); };
  $('#ew-close').onclick = function () { errWalk = null; renderErrWalkBar(); };
}

// ---- Link-add typeahead helpers (session detail) ----------------------------

function linkAcFetch(inp: HTMLInputElement, menu: HTMLElement, sessionId: string, kind: string) {
  var q = inp.value.trim();
  if (!q) { menu.innerHTML = ''; return; }
  var url = '/api/session-links/suggest?sessionId=' + encodeURIComponent(sessionId) +
    '&q=' + encodeURIComponent(q) +
    (kind ? '&kind=' + encodeURIComponent(kind) : '');
  get(url).then(function (items) {
    var html = '';
    (items || []).forEach(function (it, i) {
      html += '<div class="link-ac-item" data-idx="' + i + '" data-id="' + esc(it.id) + '">' + esc(it.label) + '</div>';
    });
    if (kind === 'feature') {
      html += '<div class="link-ac-item link-ac-create" data-idx="-1">Create &ldquo;' + esc(q) + '&rdquo;</div>';
    }
    if (kind === 'pr' && (/^[^\s#]+#\d+$/.test(q) || /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(q))) {
      html += '<div class="link-ac-item link-ac-create" data-idx="-2">Link PR ' + esc(q) + '</div>';
    }
    menu.innerHTML = html;
    Array.prototype.forEach.call(menu.querySelectorAll('.link-ac-item'), function (el) {
      el.onclick = function () { linkAcSelect(inp, menu, sessionId, kind, parseInt(el.getAttribute('data-idx'))); };
    });
  });
}

function linkAcSelect(inp: HTMLInputElement, menu: HTMLElement, sessionId: string, kind: string, idx: number) {
  var q = inp.value.trim();
  if (!q) return;
  var item = idx >= 0 ? menu.querySelector('[data-idx="' + idx + '"]') : null;
  var promise: Promise<any>;
  if (item && item.getAttribute('data-id')) {
    promise = post('/api/session-links/add', { sessionId: sessionId, artifactId: item.getAttribute('data-id') });
  } else if (kind === 'feature') {
    promise = post('/api/session-links/create-feature', { sessionId: sessionId, title: q });
  } else if (kind === 'pr') {
    var m = q.match(/^([^\s#]+)#(\d+)$/) || q.match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) return;
    promise = post('/api/session-links/add-pr', { sessionId: sessionId, repo: m[1], prNumber: m[2] });
  } else {
    return;
  }
  var area = document.querySelector('#drawerBody .link-add-area[data-link-kind="' + kind + '"].on') as HTMLElement;
  if (area) {
    var existing = area.querySelector('.link-ac-error');
    if (existing) existing.remove();
    var spinner = document.createElement('div');
    spinner.className = 'link-ac-spinner';
    spinner.textContent = 'Validating…';
    area.querySelector('.link-ac').appendChild(spinner);
  }
  promise.then(function (res) {
    if (area) { var sp = area.querySelector('.link-ac-spinner'); if (sp) sp.remove(); }
    if (res && (res.ok || res.id)) {
      openDetail(sessionId);
    } else if (res && res.error) {
      if (area) {
        var err = area.querySelector('.link-ac-error');
        if (!err) { err = document.createElement('div'); err.className = 'link-ac-error'; area.querySelector('.link-ac').appendChild(err); }
        err.textContent = res.error;
      }
    }
  }).catch(function () {
    if (area) {
      var sp = area.querySelector('.link-ac-spinner'); if (sp) sp.remove();
      var err = area.querySelector('.link-ac-error');
      if (!err) { err = document.createElement('div'); err.className = 'link-ac-error'; area.querySelector('.link-ac').appendChild(err); }
      err.textContent = 'Request failed — check your connection';
    }
  });
}

export function setView(name) {
  ['dashboard', 'artifacts', 'sessions'].forEach(function (v) {
    document.getElementById('view-' + v).classList.toggle('on', v === name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-view') === name);
  });
}

export function loadSessions() {
  var f = state.filters || {}, qs = [];
  var facets = f.facets || {};
  Object.keys(facets).forEach(function (k) {
    if (facets[k]) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(facets[k]));
  });
  if (f.q) qs.push('q=' + encodeURIComponent(f.q));
  if (f.artifact) qs.push('artifact=' + encodeURIComponent(f.artifact));
  if (f.artifactKind) qs.push('artifact_kind=' + encodeURIComponent(f.artifactKind));
  if (f.from) qs.push('from=' + encodeURIComponent(f.from));
  if (f.to) qs.push('to=' + encodeURIComponent(f.to));
  if (f.outcomes && f.outcomes.length) qs.push('outcome_types=' + encodeURIComponent(f.outcomes.join(',')));
  get('/api/sessions' + (qs.length ? '?' + qs.join('&') : '')).then(renderSessions);
}
