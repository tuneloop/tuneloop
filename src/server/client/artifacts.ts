// Artifacts tab: the Features/PRs sub-nav, the PR table, and the feature manager
// (hierarchical list with ship-toggle, nest-under, move-to-top, delete). Feature
// mutations POST to /api/features* and reload.
import { state, $, esc, usd, dayOf, get, post } from './core'
import { syncHash } from './router'
import { filterByArtifact, setView } from './sessions'

export function renderArtKindSeg() {
  var opts = [['feature', 'Features'], ['pr', 'PRs']];
  $('#artKindSeg').innerHTML = opts.map(function (o) {
    return '<button class="' + (o[0] === state.artKind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call($('#artKindSeg').children, function (btn) {
    btn.onclick = function () { setArtKind(btn.getAttribute('data-k')); };
  });
}

// Switch the Artifacts sub-tab (Features | PRs) from the segment buttons, and
// mirror it into the URL. Switching kind resets the table's search/sort (each kind
// gets a fresh list). No-op when already on that kind.
export function setArtKind(kind) {
  state.view = 'artifacts';
  if (state.artKind === kind) { syncHash(); return; }
  state.artKind = kind;
  state.art = { q: '', sort: 'created', dir: 'desc' };
  renderArtKindSeg();
  loadArtifacts();
  syncHash();
}

// ---- URL <-> artifacts-list bridge (used by the router) ----------------------

// The current artifacts-table state as URL query params: free-text search (q) and,
// for the PR table, the column sort. Defaults (created/desc) are omitted.
export function getArtifactParams(): Record<string, string> {
  var q: Record<string, string> = {};
  if (state.art.q) q.q = state.art.q;
  if (state.artKind === 'pr') {
    if (state.art.sort && state.art.sort !== 'created') q.sort = state.art.sort;
    if (state.art.dir === 'asc') q.dir = 'asc';
  }
  return q;
}

// Restore the artifacts kind + table search/sort from the URL, then reload. Used
// by the router on Back/Forward and deep links (inverse of getArtifactParams).
export function applyArtifactParams(kind, query) {
  state.view = 'artifacts';
  state.artKind = kind === 'pr' || kind === 'feature' ? kind : 'feature';
  state.art = {
    q: query.q || '',
    sort: query.sort || 'created',
    dir: query.dir === 'asc' ? 'asc' : 'desc',
  };
  renderArtKindSeg();
  loadArtifacts();
}

function renderArtifacts(rows, kind) {
  if (kind === 'feature') { renderFeatureManager(rows || []); return; }
  renderPrTab(rows || []);
}

// The PR sub-tab: a search box (by title or identifier) over a sortable table.
// Rows are held in module state so search + column sort re-render only the table
// body, leaving the (outside) search input focused.
var prRows = [];
// Column sort lives in state.art (state.art.sort / .dir) so it round-trips through
// the URL; the search box value lives in state.art.q.
// [key, label, numeric?] — numeric columns right-align and default to descending.
var PR_COLS = [['pr', 'Pull request', 0], ['status', 'Status', 0], ['sessions', 'Sessions', 1],
  ['cost', 'Cost', 1], ['created', 'Created', 1], ['merged', 'Merged', 1]];

function renderPrTab(rows) {
  prRows = rows;
  if (!rows.length) {
    $('#artifacts').innerHTML = '<div class="empty">No PRs linked yet. A session that runs gh pr create / merge (or a GitHub MCP PR tool) will show here.</div>';
    return;
  }
  $('#artifacts').innerHTML =
    '<input id="pr-search" class="feat-search" type="search" placeholder="Search PRs by title or #identifier…" autocomplete="off" />' +
    '<div id="pr-table-wrap"></div>';
  var srch = $('#pr-search');
  srch.value = state.art.q || ''; // restore a URL-driven search
  srch.oninput = function () { state.art.q = srch.value; syncHash({ replace: true }); renderPrTable(); };
  renderPrTable();
}

// Sort key for a column; `created` falls back to merge time (mirrors the server COALESCE).
function prVal(r, col) {
  if (col === 'pr') return Number(r.ident) || 0;
  if (col === 'status') return (r.status || '').toLowerCase();
  if (col === 'sessions') return r.sessions || 0;
  if (col === 'cost') return r.costUsd || 0;
  if (col === 'created') return r.createdAt || r.completedAt || '';
  if (col === 'merged') return r.completedAt || '';
  return '';
}

function renderPrTable() {
  var search = $('#pr-search');
  var q = (search && search.value || '').trim().toLowerCase();
  var rows = prRows.filter(function (r) {
    if (!q) return true;
    var hay = ((r.title || '') + ' #' + (r.ident || '') + ' ' + (r.repo || '') + ' ' + (r.externalId || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  });
  var dir = state.art.dir === 'asc' ? 1 : -1;
  rows.sort(function (a, b) {
    var x = prVal(a, state.art.sort), y = prVal(b, state.art.sort);
    return x < y ? -dir : x > y ? dir : 0;
  });

  var head = '<tr>' + PR_COLS.map(function (c) {
    var arrow = c[0] === state.art.sort ? (state.art.dir === 'asc' ? ' &#9652;' : ' &#9662;') : '';
    return '<th class="pr-th' + (c[2] ? ' num' : '') + '" data-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
  }).join('') + '<th></th></tr>';
  var body = rows.map(function (r) {
    var key = r.externalId || r.ident;
    var idLabel = (r.repo ? esc(r.repo) + ' ' : '') + '#' + esc(r.ident);
    var idHtml = r.externalId
      ? '<a class="pr-link" href="' + esc(r.externalId) + '" target="_blank" rel="noopener">' + idLabel + '</a>'
      : idLabel;
    var titleHtml = r.title ? '<div class="pr-title">' + esc(r.title) + '</div>' : '';
    return '<tr class="arow" data-art="' + esc(key) + '" data-kind="pr">' +
      '<td>' + idHtml + titleHtml + '</td>' +
      '<td>' + (r.status ? esc(r.status) : '—') + '</td>' +
      '<td class="num">' + r.sessions + '</td>' +
      '<td class="num">' + usd(r.costUsd) + '</td>' +
      '<td class="num">' + (esc(dayOf(r.createdAt)) || '—') + '</td>' +
      '<td class="num">' + (esc(dayOf(r.completedAt)) || '—') + '</td>' +
      '<td><button class="btn sess-btn" data-art="' + esc(key) + '">Sessions &rarr;</button></td></tr>';
  }).join('');
  var note = rows.length ? '' : '<div class="empty">No PRs match your search.</div>';
  $('#pr-table-wrap').innerHTML = '<table>' + head + body + '</table>' + note;

  Array.prototype.forEach.call(document.querySelectorAll('#pr-table-wrap .pr-th'), function (th) {
    th.onclick = function () {
      var col = th.getAttribute('data-sort');
      if (state.art.sort === col) state.art.dir = state.art.dir === 'asc' ? 'desc' : 'asc';
      else { state.art.sort = col; state.art.dir = (col === 'pr' || col === 'status') ? 'asc' : 'desc'; }
      syncHash({ replace: true });
      renderPrTable();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('#pr-table-wrap .sess-btn'), function (btn) {
    btn.onclick = function () { filterByArtifact(btn.getAttribute('data-art'), 'pr'); };
  });
}

function renderFeatureManager(rows) {
  var html = '';
  if (!rows.length) {
    html += '<div class="empty">No features yet. Add one below, or enrich sessions to propose features.</div>';
  } else {
    html += '<input id="feat-search" class="feat-search" type="search" placeholder="Search features…" autocomplete="off" />';
    html += '<div class="feat-list">' +
      '<div class="feat-head"><span>Feature</span><span>Repos</span><span>Last session</span><span class="fh-num">Sessions</span><span class="fh-num">Cost</span><span></span></div>';
    flattenFeatures(rows).forEach(function (e) {
      var r = e.node, indent = e.depth * 22;
      var twig = e.depth ? '<span class="feat-twig">&#8627;</span> ' : '';
      var shipped = !!r.completedAt;
      var statusHtml = shipped
        ? '<span class="badge b-success">shipped ' + esc(dayOf(r.completedAt)) + '</span>'
        : '<span class="badge b-null">open</span>';
      var proposed = r.source === 'derived' ? '<span class="tag">proposed</span>' : '';
      var repos = (r.repos && r.repos.length) ? r.repos.join(', ') : '—';
      var last = r.lastSessionAt ? dayOf(r.lastSessionAt) : '—';
      // Secondary actions (ship toggle · nest-under · move-to-top · delete) collapse
      // into a per-row hamburger; only the indent shifts, so columns stay aligned.
      var nest = '<select class="feat-nest" data-id="' + esc(r.id) + '">' +
        nestUnderOptions(rows, r.id, descendantsOf(rows, r.id)) + '</select>';
      var cxVal = r.complexity ? String(r.complexity) : '';
      var cxSelect = '<select class="feat-cx" data-id="' + esc(r.id) + '">' +
        '<option value=""' + (cxVal === '' ? ' selected' : '') + '>Not tagged</option>' +
        '<option value="1"' + (cxVal === '1' ? ' selected' : '') + '>Trivial</option>' +
        '<option value="2"' + (cxVal === '2' ? ' selected' : '') + '>Simple</option>' +
        '<option value="3"' + (cxVal === '3' ? ' selected' : '') + '>Moderate</option>' +
        '<option value="4"' + (cxVal === '4' ? ' selected' : '') + '>Complex</option>' +
        '<option value="5"' + (cxVal === '5' ? ' selected' : '') + '>Highly Complex</option></select>';
      var toTop = r.parentId
        ? '<button class="menu-item" data-act="totop" data-id="' + esc(r.id) + '">Move to top level</button>'
        : '';
      html += '<div class="feat-row" data-name="' + esc((r.title || '').toLowerCase()) +
        '" data-id="' + esc(r.id) + '" data-parent="' + esc(r.parentId || '') + '">' +
        '<div class="feat-name" style="padding-left:' + indent + 'px">' + twig +
          '<span class="nm" title="' + esc(r.title || '') + '">' +
          esc(r.title || '(untitled)') + '</span> ' + proposed + ' ' + statusHtml + '</div>' +
        '<span class="feat-repos" title="' + esc(repos) + '">' + esc(repos) + '</span>' +
        '<span class="feat-last" title="' + esc(r.lastSessionAt || '') + '">' + esc(last) + '</span>' +
        '<span class="feat-num">' + r.sessions + '</span>' +
        '<span class="feat-num">' + usd(r.costUsd) + '</span>' +
        '<div class="feat-actions">' +
          '<button class="btn sess-btn" data-art="' + esc(r.title || '') + '" data-kind="feature">Sessions &rarr;</button>' +
          '<div class="feat-menu-wrap">' +
            '<button class="feat-menu-btn" aria-label="More actions">&#8943;</button>' +
            '<div class="feat-menu">' +
              '<button class="menu-item" data-act="toggle" data-id="' + esc(r.id) + '" data-completed="' + (shipped ? '1' : '0') + '">' +
                (shipped ? 'Reopen' : 'Mark shipped') + '</button>' +
              '<div class="menu-nest"><label>Nest under</label>' + nest + '</div>' +
              '<div class="menu-nest"><label>Complexity</label>' + cxSelect + '</div>' +
              toTop +
              '<div class="menu-sep"></div>' +
              '<button class="menu-item danger" data-act="delete" data-id="' + esc(r.id) + '" data-title="' + esc(r.title || '') + '">Delete</button>' +
            '</div>' +
          '</div>' +
        '</div></div>';
    });
    html += '</div>';
  }
  // New-feature form lives at the bottom, collapsed behind an "Add feature" button
  // to keep the list uncluttered.
  html += '<div class="feat-add">' +
    '<button class="btn" id="nf-toggle">+ Add feature</button>' +
    '<div class="feat-new" id="nf-form" hidden>' +
      '<input id="nf-title" placeholder="New feature title" />' +
      '<select id="nf-parent">' + featureParentOptions(rows, '', '', null) + '</select>' +
      '<select id="nf-complexity"><option value="">Complexity (optional)</option>' +
        '<option value="1">Trivial</option><option value="2">Simple</option><option value="3">Moderate</option>' +
        '<option value="4">Complex</option><option value="5">Highly Complex</option></select>' +
      '<button class="btn" id="nf-add">Add</button>' +
      '<button class="btn" id="nf-cancel">Cancel</button>' +
    '</div></div>';
  $('#artifacts').innerHTML = html;
  wireFeatureManager();
}

// Options for the per-row "Nest under…" action — candidate parents only (no
// "(top level)" option; that is its own explicit button). Excludes self + any
// descendants (would create a cycle).
function nestUnderOptions(rows, id, excludeSet) {
  var opts = '<option value="" disabled selected>Nest under…</option>';
  rows.forEach(function (r) {
    if (r.id === id) return;
    if (excludeSet && excludeSet[r.id]) return;
    opts += '<option value="' + esc(r.id) + '">' + esc(r.title || r.id) + '</option>';
  });
  return opts;
}

function featureParentOptions(rows, selectedId, excludeId, excludeSet) {
  var opts = '<option value=""' + (selectedId ? '' : ' selected') + '>(top level)</option>';
  rows.forEach(function (r) {
    if (r.id === excludeId) return;
    if (excludeSet && excludeSet[r.id]) return;
    opts += '<option value="' + esc(r.id) + '"' + (r.id === selectedId ? ' selected' : '') + '>' + esc(r.title || r.id) + '</option>';
  });
  return opts;
}

function descendantsOf(rows, id) {
  var children = {};
  rows.forEach(function (r) { var p = r.parentId || ''; (children[p] = children[p] || []).push(r.id); });
  var out = {}, stack = (children[id] || []).slice();
  while (stack.length) { var x = stack.pop(); if (out[x]) continue; out[x] = true; (children[x] || []).forEach(function (c) { stack.push(c); }); }
  return out;
}

function flattenFeatures(rows) {
  // Most-recent-activity first: order roots and each sibling group by last session
  // time descending (undated sorts last). Hierarchy is preserved — a parent still
  // renders before its children; only the order among siblings changes.
  function recency(a, b) { return String(b.lastSessionAt || '').localeCompare(String(a.lastSessionAt || '')); }
  var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
  var children = {};
  rows.forEach(function (r) {
    var p = r.parentId && byId[r.parentId] ? r.parentId : '';
    (children[p] = children[p] || []).push(r);
  });
  Object.keys(children).forEach(function (k) { children[k].sort(recency); });
  var out = [], visited = {};
  (function walk(key, depth) {
    (children[key] || []).forEach(function (r) {
      if (visited[r.id]) return; visited[r.id] = true;
      out.push({ node: r, depth: depth });
      walk(r.id, depth + 1);
    });
  })('', 0);
  rows.slice().sort(recency).forEach(function (r) { if (!visited[r.id]) { visited[r.id] = true; out.push({ node: r, depth: 0 }); } });
  return out;
}

function wireFeatureManager() {
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  // Add-feature: a collapsed button that expands into the full form on click.
  var nfToggle = $('#nf-toggle'), nfForm = $('#nf-form'), nfTitle = $('#nf-title');
  if (nfToggle) nfToggle.onclick = function () {
    nfForm.hidden = false; nfToggle.hidden = true;
    if (nfTitle) nfTitle.focus();
  };
  var nfCancel = $('#nf-cancel');
  if (nfCancel) nfCancel.onclick = function () {
    nfForm.hidden = true; nfToggle.hidden = false;
    if (nfTitle) nfTitle.value = '';
  };
  var add = $('#nf-add');
  if (add) add.onclick = function () {
    var title = nfTitle.value.trim();
    if (!title) return;
    var cx = $('#nf-complexity').value || undefined;
    post('/api/features', { title: title, parentId: $('#nf-parent').value || undefined, complexity: cx ? Number(cx) : undefined }).then(loadArtifacts);
  };
  if (nfTitle) nfTitle.onkeydown = function (ev) { if (ev.key === 'Enter' && add) add.onclick(); };

  // Hamburger menus: fixed-positioned (so the scroll container's overflow can't
  // clip them) and only one open at a time. Clicks inside a menu don't bubble to
  // the document closer, keeping the nest <select> usable.
  each('#artifacts .feat-menu-btn', function (btn) {
    btn.onclick = function (ev) {
      ev.stopPropagation();
      var menu = btn.parentNode.querySelector('.feat-menu');
      var wasOpen = menu.classList.contains('on');
      closeFeatMenus();
      if (wasOpen) return;
      menu.classList.add('on');
      var rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.left = (rect.right - menu.offsetWidth) + 'px';
    };
  });
  each('#artifacts .feat-menu', function (m) { m.onclick = function (ev) { ev.stopPropagation(); }; });
  var list = $('#artifacts .feat-list');
  if (list) list.onscroll = closeFeatMenus; // fixed menus don't track the scrolled button

  each('#artifacts .sess-btn', function (b) {
    b.onclick = function () { filterByArtifact(b.getAttribute('data-art'), b.getAttribute('data-kind')); };
  });
  each('#artifacts [data-act="toggle"]', function (b) {
    b.onclick = function () {
      post('/api/features/update', { id: b.getAttribute('data-id'), completed: b.getAttribute('data-completed') !== '1' }).then(loadArtifacts);
    };
  });
  each('#artifacts [data-act="delete"]', function (b) {
    b.onclick = function () {
      if (!window.confirm('Delete feature "' + (b.getAttribute('data-title') || '') + '"? Any sub-features move up to its parent.')) return;
      post('/api/features/delete', { id: b.getAttribute('data-id') }).then(loadArtifacts);
    };
  });
  each('#artifacts .feat-nest', function (sel) {
    sel.onchange = function () {
      if (!sel.value) return;
      post('/api/features/update', { id: sel.getAttribute('data-id'), parentId: sel.value }).then(loadArtifacts);
    };
  });
  each('#artifacts .feat-cx', function (sel) {
    sel.onchange = function () {
      var val = sel.value ? Number(sel.value) : null;
      post('/api/features/update', { id: sel.getAttribute('data-id'), complexity: val }).then(loadArtifacts);
    };
  });
  each('#artifacts [data-act="totop"]', function (b) {
    b.onclick = function () {
      post('/api/features/update', { id: b.getAttribute('data-id'), parentId: null }).then(loadArtifacts);
    };
  });

  // Local name filter. A match reveals its WHOLE subtree (so searching an epic
  // shows everything under it) plus its ancestors (so the match keeps its place
  // in the tree). Pure show/hide in place — no refetch, keeps input focus.
  function filterFeatRows(qRaw) {
    var q = (qRaw || '').trim().toLowerCase();
    var rows = Array.prototype.slice.call(document.querySelectorAll('#artifacts .feat-row'));
    if (!q) { rows.forEach(function (r) { r.style.display = ''; }); return; }
    var childrenOf = {}, parentOf = {};
    rows.forEach(function (r) {
      var id = r.getAttribute('data-id'), p = r.getAttribute('data-parent') || '';
      parentOf[id] = p;
      (childrenOf[p] = childrenOf[p] || []).push(id);
    });
    var visible = {};
    function revealSubtree(id) {
      if (visible[id]) return;
      visible[id] = true;
      (childrenOf[id] || []).forEach(revealSubtree);
    }
    function revealAncestors(id) {
      var p = parentOf[id];
      while (p) { visible[p] = true; p = parentOf[p]; }
    }
    rows.forEach(function (r) {
      if ((r.getAttribute('data-name') || '').indexOf(q) !== -1) {
        var id = r.getAttribute('data-id');
        revealSubtree(id);
        revealAncestors(id);
      }
    });
    rows.forEach(function (r) { r.style.display = visible[r.getAttribute('data-id')] ? '' : 'none'; });
  }
  var search = $('#feat-search');
  if (search) {
    search.value = state.art.q || ''; // restore a URL-driven search
    search.oninput = function () { state.art.q = search.value; syncHash({ replace: true }); filterFeatRows(search.value); };
    if (search.value) filterFeatRows(search.value);
  }

  // One-time global closers: outside click and Escape dismiss any open menu.
  // Idempotent across reloads — they query the live DOM each time.
  if (!featMenusWired) {
    featMenusWired = true;
    document.addEventListener('click', closeFeatMenus);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeFeatMenus(); });
  }
}

// Module-level so the global listeners are attached only once. closeFeatMenus is
// hoisted out of wireFeatureManager so those one-time listeners don't capture a
// stale closure from the first render.
var featMenusWired = false;
function closeFeatMenus() {
  Array.prototype.forEach.call(document.querySelectorAll('#artifacts .feat-menu.on'), function (m) { m.classList.remove('on'); });
}

// When a deep-link (Explore Q1) lands here, pre-fill that sub-tab's search so the
// list narrows to the one artifact instead of dropping the user into a full list.
var pendingArtSearch = '';
function applyArtSearch() {
  if (!pendingArtSearch) return;
  var input = document.getElementById(state.artKind === 'pr' ? 'pr-search' : 'feat-search') as any;
  if (input) { input.value = pendingArtSearch; if (input.oninput) input.oninput(); }
  pendingArtSearch = '';
}

export function loadArtifacts() {
  get('/api/artifacts?kind=' + encodeURIComponent(state.artKind)).then(function (rows) {
    renderArtifacts(rows, state.artKind);
    applyArtSearch();
  });
}

// Open the Artifacts tab at a sub-kind (feature/pr) with its search pre-filled to
// `query` — the list ends up narrowed to that artifact (showing its cost).
export function openArtifactSearch(kind, query) {
  setView('artifacts');
  state.artKind = kind;
  pendingArtSearch = query || '';
  renderArtKindSeg();
  loadArtifacts();
}
