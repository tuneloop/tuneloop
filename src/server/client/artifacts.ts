// Artifacts tab: the Features/PRs sub-nav, the PR table, and the feature manager
// (hierarchical list with ship-toggle, nest-under, move-to-top, delete). Feature
// mutations POST to /api/features* and reload.
import { state, $, esc, usd, dayOf, get, post } from './core'
import { filterByArtifact } from './sessions'

export function renderArtKindSeg() {
  var opts = [['feature', 'Features'], ['pr', 'PRs']];
  $('#artKindSeg').innerHTML = opts.map(function (o) {
    return '<button class="' + (o[0] === state.artKind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call($('#artKindSeg').children, function (btn) {
    btn.onclick = function () { state.artKind = btn.getAttribute('data-k'); renderArtKindSeg(); loadArtifacts(); };
  });
}

// The last PR rows loaded from the server; client-side sort/filter re-renders
// from these without refetching.
var lastPrRows: any[] = []

function renderArtifacts(rows, kind) {
  if (kind === 'feature') { renderFeatureManager(rows || []); return; }
  lastPrRows = rows || [];
  renderPrTable(lastPrRows);
}

var PR_COLS: Array<{ key: string; label: string; num?: 1 }> = [
  { key: 'title', label: 'Pull request' },
  { key: 'status', label: 'Status' },
  { key: 'sessions', label: 'Sessions', num: 1 },
  { key: 'costUsd', label: 'Cost', num: 1 },
  { key: 'completedAt', label: 'Merged', num: 1 }
]

function prSortValue(r: any, key: string) {
  if (key === 'title') return (r.repo || '') + ' #' + (r.ident || '') + ' ' + (r.title || '')
  return r[key]
}

function renderPrTable(rows: any[]) {
  var p = state.pr
  // Filter: status exact-match + free-text over ident/title/repo.
  var statusSet: Record<string, 1> = {}
  rows.forEach(function (r) { if (r.status) statusSet[r.status] = 1 })
  var q = (p.q || '').trim().toLowerCase()
  var filtered = rows.filter(function (r) {
    if (p.status && r.status !== p.status) return false
    if (q) {
      var hay = ((r.repo || '') + ' #' + (r.ident || '') + ' ' + (r.title || '')).toLowerCase()
      if (hay.indexOf(q) < 0) return false
    }
    return true
  })
  // Sort: a manual sort column wins; otherwise the server's cost-desc order.
  if (p.sort) {
    filtered.sort(function (a, b) {
      var av = prSortValue(a, p.sort), bv = prSortValue(b, p.sort)
      var cmp
      if (p.sort === 'sessions' || p.sort === 'costUsd') cmp = (Number(av) || 0) - (Number(bv) || 0)
      else if (p.sort === 'completedAt') cmp = String(av || '').localeCompare(String(bv || ''))
      else cmp = String(av || '').localeCompare(String(bv || ''))
      return cmp * p.dir
    })
  }
  if (!filtered.length) {
    $('#artifacts').innerHTML = prFilterBar(statusSet) + '<div class="empty">No PRs match. A session that runs gh pr create / merge (or a GitHub MCP PR tool) will show here.</div>'
    wirePrControls(statusSet)
    return
  }
  var head = '<tr>' + PR_COLS.map(function (c) {
    var on = c.key === p.sort
    var arrow = on ? (p.dir < 0 ? ' ↓' : ' ↑') : ''
    return '<th><button class="th-sort' + (on ? ' on' : '') + '" data-sort="' + c.key + '" type="button">' + c.label + arrow + '</button></th>'
  }).join('') + '<th></th></tr>'
  var body = filtered.map(function (r) {
    var key = r.externalId || r.ident
    var idLabel = (r.repo ? esc(r.repo) + ' ' : '') + '#' + esc(r.ident)
    var idHtml = r.externalId
      ? '<a class="pr-link" href="' + esc(r.externalId) + '" target="_blank" rel="noopener">' + idLabel + '</a>'
      : idLabel
    var titleHtml = r.title ? '<div class="pr-title">' + esc(r.title) + '</div>' : ''
    return '<tr class="arow" data-art="' + esc(key) + '" data-kind="pr">' +
      '<td>' + idHtml + titleHtml + '</td>' +
      '<td>' + (r.status ? '<span class="badge ' + prStatusClass(r.status) + '">' + esc(r.status) + '</span>' : '—') + '</td>' +
      '<td class="num">' + r.sessions + '</td>' +
      '<td class="num">' + usd(r.costUsd) + '</td>' +
      '<td class="num">' + esc(dayOf(r.completedAt)) + '</td>' +
      '<td><button class="btn sess-btn" data-art="' + esc(key) + '">Sessions &rarr;</button></td></tr>'
  }).join('')
  $('#artifacts').innerHTML = prFilterBar(statusSet) + '<table>' + head + body + '</table>'
  wirePrControls(statusSet)
}

function prStatusClass(s: string) {
  if (s === 'merged') return 'b-success'
  if (s === 'open') return 'b-unknown'
  if (s === 'closed' || s === 'failed') return 'b-failure'
  return 'b-null'
}

function prFilterBar(statusSet: Record<string, 1>) {
  var p = state.pr
  var opts = '<option value="">status: any</option>'
  Object.keys(statusSet).sort().forEach(function (s) {
    opts += '<option value="' + esc(s) + '"' + (s === p.status ? ' selected' : '') + '>' + esc(s) + '</option>'
  })
  return '<div class="pr-filters">' +
    '<select id="pr-status">' + opts + '</select>' +
    '<input id="pr-q" type="search" placeholder="search PR # / title / repo" autocomplete="off" value="' + esc(p.q || '') + '" />' +
    '<button class="btn" id="pr-reset" type="button">Reset</button>' +
    '</div>'
}

function wirePrControls(statusSet: Record<string, 1>) {
  var st = $('#pr-status')
  if (st) st.onchange = function () { state.pr.status = st.value; renderPrTable(lastPrRows) }
  var q = $('#pr-q')
  if (q) q.oninput = function () { state.pr.q = q.value; renderPrTable(lastPrRows) }
  var rs = $('#pr-reset')
  if (rs) rs.onclick = function () { state.pr.status = ''; state.pr.q = ''; state.pr.sort = 'cost'; state.pr.dir = -1; renderPrTable(lastPrRows) }
  Array.prototype.forEach.call(document.querySelectorAll('#artifacts .th-sort'), function (b) {
    b.onclick = function () {
      var key = b.getAttribute('data-sort')
      if (state.pr.sort === key) state.pr.dir = (state.pr.dir === 1 ? -1 : 1) as 1 | -1
      else { state.pr.sort = key; state.pr.dir = key === 'sessions' || key === 'costUsd' ? -1 : 1 }
      renderPrTable(lastPrRows)
    }
  })
  Array.prototype.forEach.call(document.querySelectorAll('#artifacts .sess-btn'), function (btn) {
    btn.onclick = function () { filterByArtifact(btn.getAttribute('data-art'), 'pr') }
  })
}

function renderFeatureManager(rows) {
  var html = '';
  if (!rows.length) {
    html += '<div class="empty">No features yet. Add one below, or enrich sessions to propose features.</div>';
  } else {
    html += '<div class="feat-search-row"><input id="feat-search" class="feat-search" type="search" placeholder="Search features…" autocomplete="off" />' +
      '<button class="btn" id="feat-reset" type="button">Reset</button></div>';
    html += '<div class="feat-list">' +
      '<div class="feat-head"><span>Feature</span><span>Repos</span><span>Last session</span><span class="fh-num">Sessions</span><span class="fh-num">Cost</span><span></span></div>';
    flattenFeatures(rows).forEach(function (e) {
      var r = e.node, indent = e.depth * 22;
      var twig = e.depth ? '<span class="feat-twig">&#8627;</span> ' : '';
      var shipped = !!r.completedAt;
      var statusHtml = shipped
        ? '<span class="badge b-success">shipped ' + esc(dayOf(r.completedAt)) + '</span>'
        : '<span class="badge b-null">open</span>';
      // Nudge: a session under this feature merged a PR, but it isn't marked
      // shipped — offer the one-click ship right on the row.
      var nudge = !shipped && r.hasMergedPr
        ? ' <button class="btn nudge" data-act="toggle" data-id="' + esc(r.id) + '" data-completed="0" title="A session under this feature merged a PR">mark shipped</button>'
        : '';
      var proposed = r.source === 'derived' ? '<span class="tag">proposed</span>' : '';
      var repos = (r.repos && r.repos.length) ? r.repos.join(', ') : '—';
      var last = r.lastSessionAt ? dayOf(r.lastSessionAt) : '—';
      // Secondary actions (ship toggle · rename · nest-under · move-to-top · delete)
      // collapse into a per-row hamburger; only the indent shifts, so columns stay
      // aligned. The row is drag-source for drag-and-drop re-parenting (B2).
      var nest = '<select class="feat-nest" data-id="' + esc(r.id) + '">' +
        nestUnderOptions(rows, r.id, descendantsOf(rows, r.id)) + '</select>';
      var toTop = r.parentId
        ? '<button class="menu-item" data-act="totop" data-id="' + esc(r.id) + '">Move to top level</button>'
        : '';
      html += '<div class="feat-row" draggable="true" data-name="' + esc((r.title || '').toLowerCase()) +
        '" data-id="' + esc(r.id) + '" data-parent="' + esc(r.parentId || '') + '">' +
        '<div class="feat-name" style="padding-left:' + indent + 'px">' + twig +
          '<span class="nm" title="' + esc(r.title || '') + '">' +
          esc(r.title || '(untitled)') + '</span> ' + proposed + ' ' + statusHtml + nudge + '</div>' +
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
              '<button class="menu-item" data-act="rename" data-id="' + esc(r.id) + '">Rename</button>' +
              '<div class="menu-nest"><label>Nest under</label>' + nest + '</div>' +
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
  // Rename: turn the row's title into an inline editable. Enter/blur saves
  // (POST title); Escape cancels. Backend updateFeature already accepts a title.
  each('#artifacts [data-act="rename"]', function (b) {
    b.onclick = function () {
      closeFeatMenus();
      var row = b.closest('.feat-row');
      var nm = row ? row.querySelector('.nm') : null;
      if (!nm) return;
      var id = b.getAttribute('data-id');
      var original = nm.textContent || '';
      nm.setAttribute('contenteditable', 'true');
      nm.classList.add('editing');
      nm.focus();
      // Select all so typing replaces the old name.
      var sel = window.getSelection(); var range = document.createRange();
      range.selectNodeContents(nm); sel.removeAllRanges(); sel.addRange(range);
      var done = function (save) {
        nm.removeAttribute('contenteditable');
        nm.classList.remove('editing');
        if (save) {
          var title = (nm.textContent || '').trim();
          if (title && title !== original) post('/api/features/update', { id: id, title: title }).then(loadArtifacts);
          else nm.textContent = original;
        } else nm.textContent = original;
      };
      nm.onblur = function () { done(true); };
      nm.onkeydown = function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); nm.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); done(false); nm.blur(); }
      };
    };
  });
  // Drag-and-drop re-parenting: drop a row onto another to nest it under that
  // target (reuses the parentId path + the server's cycle guard).
  (function () {
    var dragId = null;
    each('#artifacts .feat-row', function (row) {
      row.addEventListener('dragstart', function (e) {
        dragId = row.getAttribute('data-id');
        row.classList.add('dragging');
        if ((e as any).dataTransfer) (e as any).dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        each('#artifacts .feat-row', function (r2) { r2.classList.remove('drop-target'); });
        dragId = null;
      });
      row.addEventListener('dragover', function (e) {
        var tid = row.getAttribute('data-id');
        if (tid && tid !== dragId) { e.preventDefault(); row.classList.add('drop-target'); }
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-target'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        row.classList.remove('drop-target');
        var tid = row.getAttribute('data-id');
        if (!dragId || !tid || tid === dragId) return;
        post('/api/features/update', { id: dragId, parentId: tid }).then(loadArtifacts);
      });
    });
  })();

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
  var featReset = $('#feat-reset');
  if (featReset && search) featReset.onclick = function () { search.value = ''; search.oninput(null); };

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

export function loadArtifacts() {
  get('/api/artifacts?kind=' + encodeURIComponent(state.artKind)).then(function (rows) {
    renderArtifacts(rows, state.artKind);
  });
}
