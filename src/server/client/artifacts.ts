// Artifacts tab: the Features/PRs sub-nav, the PR table, and the feature manager
// (hierarchical list with ship-toggle, nest-under, move-to-top, delete). Feature
// mutations POST to /api/features* and reload.
import { state, $, esc, usd, dayOf, get, post } from './core'
import { filterByArtifact } from './sessions'

// PR table client-side sort + filter (the table is fully loaded, so this is pure
// in-memory). `lastPrRows` caches the fetched rows so header clicks / filter typing
// re-render without a refetch.
var prSort = { key: 'costUsd', dir: -1 };
var prFilter = '';
var lastPrRows: any[] = [];
var PR_COLS = [
  { key: 'ident', label: 'Pull request' },
  { key: 'status', label: 'Status' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'costUsd', label: 'Cost' },
  { key: 'completedAt', label: 'Merged' }
];
function prSortVal(r, key) {
  if (key === 'ident') return ((r.repo || '') + ' ' + (r.ident || '')).toLowerCase();
  if (key === 'status') return (r.status || '').toLowerCase();
  if (key === 'completedAt') return r.completedAt || '';
  return Number(r[key]) || 0; // sessions, costUsd
}

export function renderArtKindSeg() {
  var opts = [['feature', 'Features'], ['pr', 'PRs']];
  $('#artKindSeg').innerHTML = opts.map(function (o) {
    return '<button class="' + (o[0] === state.artKind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call($('#artKindSeg').children, function (btn) {
    btn.onclick = function () { state.artKind = btn.getAttribute('data-k'); renderArtKindSeg(); loadArtifacts(); };
  });
}

function renderArtifacts(rows, kind) {
  if (kind === 'feature') { renderFeatureManager(rows || []); return; }
  lastPrRows = rows || [];
  renderPrTable();
}

function renderPrTable() {
  if (!lastPrRows.length) {
    $('#artifacts').innerHTML = '<div class="empty">No PRs linked yet. A session that runs gh pr create / merge (or a GitHub MCP PR tool) will show here.</div>';
    return;
  }
  // Shell (filter input + table mount) rendered once; the body re-renders on
  // filter/sort so the input keeps focus and caret.
  $('#artifacts').innerHTML =
    '<div class="pr-controls"><input id="pr-filter" class="feat-search" type="search" placeholder="Filter PRs… (repo, #, title, status)" autocomplete="off" value="' + esc(prFilter) + '" />' +
      '<span class="pr-count" id="pr-count"></span></div>' +
    '<table id="pr-table"></table>';
  var filter = $('#pr-filter');
  if (filter) filter.oninput = function () { prFilter = filter.value; renderPrBody(); };
  renderPrBody();
}

function renderPrBody() {
  var q = prFilter.trim().toLowerCase();
  var rows = lastPrRows.filter(function (r) {
    if (!q) return true;
    return ((r.repo || '') + ' #' + (r.ident || '') + ' ' + (r.title || '') + ' ' + (r.status || '')).toLowerCase().indexOf(q) !== -1;
  });
  rows = rows.slice().sort(function (a, b) {
    var va = prSortVal(a, prSort.key), vb = prSortVal(b, prSort.key);
    if (va < vb) return -prSort.dir;
    if (va > vb) return prSort.dir;
    return 0;
  });
  var head = '<tr>' + PR_COLS.map(function (c) {
    var arrow = prSort.key === c.key ? (prSort.dir < 0 ? ' ▾' : ' ▴') : '';
    return '<th class="pr-sort" data-sort="' + c.key + '">' + esc(c.label) + arrow + '</th>';
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
      '<td class="num">' + esc(dayOf(r.completedAt)) + '</td>' +
      '<td><button class="btn sess-btn" data-art="' + esc(key) + '">Sessions &rarr;</button></td></tr>';
  }).join('');
  var table = $('#pr-table');
  if (table) table.innerHTML = head + body;
  var cnt = $('#pr-count');
  if (cnt) cnt.textContent = q ? rows.length + ' of ' + lastPrRows.length : '';
  Array.prototype.forEach.call(document.querySelectorAll('.pr-sort'), function (th) {
    th.onclick = function () {
      var k = th.getAttribute('data-sort');
      if (prSort.key === k) prSort.dir = -prSort.dir;
      else { prSort.key = k; prSort.dir = (k === 'ident' || k === 'status') ? 1 : -1; }
      renderPrBody();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.sess-btn'), function (btn) {
    btn.onclick = function () { filterByArtifact(btn.getAttribute('data-art'), 'pr'); };
  });
}

// A compact "cost by feature" bar chart above the list — spend by feature is the
// outcome the team cares about most, so it leads the Features view.
function featureCostChart(rows) {
  var withCost = rows.filter(function (r) { return (r.costUsd || 0) > 0; })
    .sort(function (a, b) { return (b.costUsd || 0) - (a.costUsd || 0); }).slice(0, 8);
  if (!withCost.length) return '';
  var max = withCost[0].costUsd || 1;
  var barsHtml = withCost.map(function (r) {
    var pct = Math.max(2, Math.round((r.costUsd / max) * 100));
    var title = r.title || '(untitled)';
    return '<div class="fcost-row"><span class="fcost-name" title="' + esc(title) + '">' + esc(title) + '</span>' +
      '<span class="fcost-track"><span class="fcost-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="fcost-val">' + usd(r.costUsd) + '</span></div>';
  }).join('');
  return '<div class="fcost"><div class="fcost-h">Cost by feature <span class="fcost-sub">top ' + withCost.length + ' by spend</span></div>' + barsHtml + '</div>';
}

function renderFeatureManager(rows) {
  var html = '';
  if (!rows.length) {
    html += '<div class="empty">No features yet. Add one below, or enrich sessions to propose features.</div>';
  } else {
    html += featureCostChart(rows);
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
      var toTop = r.parentId
        ? '<button class="menu-item" data-act="totop" data-id="' + esc(r.id) + '">Move to top level</button>'
        : '';
      // Prominent ship toggle in the row (the cost-per-shipped-feature KPI counts
      // only features marked shipped, so this needs to be one click away, not buried).
      var shipBtn = '<button class="btn ship-btn' + (shipped ? ' on' : '') + '" data-act="toggle" data-id="' + esc(r.id) +
        '" data-completed="' + (shipped ? '1' : '0') + '" title="' + (shipped ? 'Reopen (clears its completion date)' : 'Mark shipped (sets its completion date so cost-per-shipped-feature counts it)') + '">' +
        (shipped ? '✓ Shipped' : 'Mark shipped') + '</button>';
      html += '<div class="feat-row" draggable="true" data-name="' + esc((r.title || '').toLowerCase()) +
        '" data-id="' + esc(r.id) + '" data-parent="' + esc(r.parentId || '') + '">' +
        '<div class="feat-name" style="padding-left:' + indent + 'px">' + twig +
          '<span class="feat-grip" title="Drag to nest under another feature">⠿</span>' +
          '<span class="nm" data-id="' + esc(r.id) + '" title="' + esc(r.title || '') + '">' +
          esc(r.title || '(untitled)') + '</span> ' + proposed + ' ' + statusHtml + '</div>' +
        '<span class="feat-repos" title="' + esc(repos) + '">' + esc(repos) + '</span>' +
        '<span class="feat-last" title="' + esc(r.lastSessionAt || '') + '">' + esc(last) + '</span>' +
        '<span class="feat-num">' + r.sessions + '</span>' +
        '<span class="feat-num">' + usd(r.costUsd) + '</span>' +
        '<div class="feat-actions">' +
          shipBtn +
          '<button class="btn sess-btn" data-art="' + esc(r.title || '') + '" data-kind="feature">Sessions &rarr;</button>' +
          '<div class="feat-menu-wrap">' +
            '<button class="feat-menu-btn" aria-label="More actions">&#8943;</button>' +
            '<div class="feat-menu">' +
              '<button class="menu-item" data-act="rename" data-id="' + esc(r.id) + '">Rename…</button>' +
              '<div class="menu-nest"><label>Nest under</label>' + nest + '</div>' +
              toTop +
              '<div class="menu-sep"></div>' +
              '<button class="menu-item danger" data-act="delete" data-id="' + esc(r.id) + '" data-title="' + esc(r.title || '') + '">Delete</button>' +
            '</div>' +
          '</div>' +
        '</div></div>';
    });
    html += '</div>';
    html += '<div class="feat-hint">Drag a row by its ⠿ handle onto another to nest it. ' +
      '“Cost per shipped feature” counts only features you’ve marked <b>✓ Shipped</b> — until then it shows “nothing converted”.</div>';
  }
  // New-feature form lives at the bottom, collapsed behind an "Add feature" button
  // to keep the list uncluttered.
  html += '<div class="feat-add">' +
    '<button class="btn" id="nf-toggle">+ Add feature</button>' +
    '<div class="feat-new" id="nf-form" hidden>' +
      '<input id="nf-title" placeholder="New feature title" />' +
      '<select id="nf-parent">' + featureParentOptions(rows, '', '', null) + '</select>' +
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
    post('/api/features', { title: title, parentId: $('#nf-parent').value || undefined }).then(loadArtifacts);
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
  each('#artifacts [data-act="totop"]', function (b) {
    b.onclick = function () {
      post('/api/features/update', { id: b.getAttribute('data-id'), parentId: null }).then(loadArtifacts);
    };
  });
  // Inline rename: turn the title into an input; Enter / blur saves, Esc cancels.
  each('#artifacts [data-act="rename"]', function (b) {
    b.onclick = function () {
      closeFeatMenus();
      var row = b.closest('.feat-row');
      var nm = row && row.querySelector('.nm');
      if (nm) startRename(nm, b.getAttribute('data-id'));
    };
  });

  // Drag-drop nesting: drop one feature onto another to nest it under that parent.
  // The store rejects cycles (a parent dropped onto its own descendant).
  var dragId = null;
  each('#artifacts .feat-row', function (row) {
    row.ondragstart = function (e) {
      dragId = row.getAttribute('data-id');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (_) { /* ignore */ } }
      row.classList.add('dragging');
    };
    row.ondragend = function () {
      dragId = null;
      row.classList.remove('dragging');
      each('#artifacts .feat-row.drop-target', function (r) { r.classList.remove('drop-target'); });
    };
    row.ondragover = function (e) {
      if (dragId && row.getAttribute('data-id') !== dragId) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target'); }
    };
    row.ondragleave = function () { row.classList.remove('drop-target'); };
    row.ondrop = function (e) {
      e.preventDefault();
      row.classList.remove('drop-target');
      var target = row.getAttribute('data-id');
      var src = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      if (!src || src === target) return;
      post('/api/features/update', { id: src, parentId: target }).then(loadArtifacts);
    };
  });

  // Local name filter. A match reveals its WHOLE subtree (so searching an epic
  // shows everything under it) plus its ancestors (so the match keeps its place
  // in the tree). Pure show/hide in place — no refetch, keeps input focus.
  var search = $('#feat-search');
  if (search) search.oninput = function () {
    var q = search.value.trim().toLowerCase();
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
  };

  // One-time global closers: outside click and Escape dismiss any open menu.
  // Idempotent across reloads — they query the live DOM each time.
  if (!featMenusWired) {
    featMenusWired = true;
    document.addEventListener('click', closeFeatMenus);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeFeatMenus(); });
  }
}

// Replace a feature title with an inline editor. Enter or blur commits a non-empty
// change (POST title); Escape or an unchanged value just reloads to restore.
function startRename(nm, id) {
  var cur = nm.textContent || '';
  var inp = document.createElement('input');
  inp.className = 'feat-rename-input';
  inp.value = cur;
  nm.replaceWith(inp);
  inp.focus();
  inp.select();
  var done = false;
  function commit(save) {
    if (done) return;
    done = true;
    var v = inp.value.trim();
    if (save && v && v !== cur.trim()) post('/api/features/update', { id: id, title: v }).then(loadArtifacts);
    else loadArtifacts(); // restore the row as-is
  }
  inp.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  inp.onblur = function () { commit(true); };
}

// Module-level so the global listeners are attached only once. closeFeatMenus is
// hoisted out of wireFeatureManager so those one-time listeners don't capture a
// stale closure from the first render.
var featMenusWired = false;
function closeFeatMenus() {
  Array.prototype.forEach.call(document.querySelectorAll('#artifacts .feat-menu.on'), function (m) { m.classList.remove('on'); });
}

export function loadArtifacts() {
  get('/api/artifacts?kind=' + encodeURIComponent(state.artKind)).then(function (rows) {
    renderArtifacts(rows, state.artKind);
  });
}
