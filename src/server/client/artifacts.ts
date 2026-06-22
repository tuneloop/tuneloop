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

function renderArtifacts(rows, kind) {
  if (kind === 'feature') { renderFeatureManager(rows || []); return; }
  if (!rows || !rows.length) {
    $('#artifacts').innerHTML = '<div class="empty">No PRs linked yet. A session that runs gh pr create / merge (or a GitHub MCP PR tool) will show here.</div>';
    return;
  }
  var head = '<tr><th>Pull request</th><th>Status</th><th>Sessions</th><th>Cost</th><th>Merged</th></tr>';
  var body = rows.map(function (r) {
    var label = (r.repo ? esc(r.repo) + ' ' : '') + '#' + esc(r.ident);
    var key = r.externalId || r.ident;
    return '<tr class="arow" data-art="' + esc(key) + '" data-kind="pr">' +
      '<td>' + label + '</td>' +
      '<td>' + (r.status ? esc(r.status) : '—') + '</td>' +
      '<td class="num">' + r.sessions + '</td>' +
      '<td class="num">' + usd(r.costUsd) + '</td>' +
      '<td class="num">' + esc(dayOf(r.completedAt)) + '</td></tr>';
  }).join('');
  $('#artifacts').innerHTML = '<table>' + head + body + '</table>';
  Array.prototype.forEach.call(document.querySelectorAll('.arow'), function (tr) {
    tr.onclick = function () { filterByArtifact(tr.getAttribute('data-art'), tr.getAttribute('data-kind')); };
  });
}

function renderFeatureManager(rows) {
  var html = '<div class="feat-new">' +
    '<input id="nf-title" placeholder="New feature title" />' +
    '<select id="nf-parent">' + featureParentOptions(rows, '', '', null) + '</select>' +
    '<button class="btn" id="nf-add">Add feature</button></div>';
  if (!rows.length) {
    html += '<div class="empty">No features yet. Add one above, or enrich sessions to propose features.</div>';
  } else {
    flattenFeatures(rows).forEach(function (e) {
      var r = e.node, pad = 8 + e.depth * 22;
      var twig = e.depth ? '<span class="feat-twig">&#8627;</span> ' : '';
      var shipped = !!r.completedAt;
      var statusHtml = shipped
        ? '<span class="badge b-success">shipped ' + esc(dayOf(r.completedAt)) + '</span>'
        : '<span class="badge b-null">open</span>';
      var proposed = r.source === 'derived' ? '<span class="tag">proposed</span>' : '';
      // Actions: ship toggle · nest-under (a parent picker, no "(top level)" noise) ·
      // move-to-top (only when nested) · delete.
      var nest = '<select class="feat-nest" data-id="' + esc(r.id) + '">' +
        nestUnderOptions(rows, r.id, descendantsOf(rows, r.id)) + '</select>';
      var toTop = r.parentId
        ? '<button class="btn" data-act="totop" data-id="' + esc(r.id) + '">Move to top level</button>'
        : '';
      html += '<div class="feat-row" style="padding-left:' + pad + 'px">' +
        '<div class="feat-name">' + twig +
          '<span class="nm" data-art="' + esc(r.title || '') + '" data-kind="feature" title="' + esc(r.title || '') + '">' +
          esc(r.title || '(untitled)') + '</span> ' + proposed + ' ' + statusHtml + '</div>' +
        '<span class="feat-meta">' + r.sessions + ' sess &middot; ' + usd(r.costUsd) + '</span>' +
        '<div class="feat-actions">' +
          '<button class="btn" data-act="toggle" data-id="' + esc(r.id) + '" data-completed="' + (shipped ? '1' : '0') + '">' +
          (shipped ? 'reopen' : 'mark shipped') + '</button>' +
          nest + toTop +
          '<button class="btn danger" data-act="delete" data-id="' + esc(r.id) + '" data-title="' + esc(r.title || '') + '">delete</button>' +
        '</div></div>';
    });
  }
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
  var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
  var children = {};
  rows.forEach(function (r) {
    var p = r.parentId && byId[r.parentId] ? r.parentId : '';
    (children[p] = children[p] || []).push(r);
  });
  var out = [], visited = {};
  (function walk(key, depth) {
    (children[key] || []).forEach(function (r) {
      if (visited[r.id]) return; visited[r.id] = true;
      out.push({ node: r, depth: depth });
      walk(r.id, depth + 1);
    });
  })('', 0);
  rows.forEach(function (r) { if (!visited[r.id]) { visited[r.id] = true; out.push({ node: r, depth: 0 }); } });
  return out;
}

function wireFeatureManager() {
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  var add = $('#nf-add');
  if (add) add.onclick = function () {
    var title = $('#nf-title').value.trim();
    if (!title) return;
    post('/api/features', { title: title, parentId: $('#nf-parent').value || undefined }).then(loadArtifacts);
  };
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
  each('#artifacts .nm', function (el) {
    el.onclick = function () { filterByArtifact(el.getAttribute('data-art'), el.getAttribute('data-kind')); };
  });
}

export function loadArtifacts() {
  get('/api/artifacts?kind=' + encodeURIComponent(state.artKind)).then(function (rows) {
    renderArtifacts(rows, state.artKind);
  });
}
