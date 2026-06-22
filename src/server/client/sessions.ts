// Sessions tab: the filter bar (facet selects + artifact-search typeahead +
// free-text), the session table, the detail drawer, and view switching. The
// typeahead helpers (ac*) are module-private; filterByArtifact/setView are
// shared so the artifacts tab and drawer can jump into a filtered session list.
import { state, $, esc, usd, num, dayOf, badge, get } from './core'

export function buildFilters() {
  var html = '';
  state.facets.forEach(function (f) {
    if ((f.roles || []).indexOf('filter') < 0) return;
    var d = state.dist[f.key] || [];
    if (!d.length) return;
    var opts = '<option value="">' + esc(f.label || f.key) + ': all</option>';
    d.forEach(function (r) {
      if (r.value == null) return;
      opts += '<option value="' + esc(r.value) + '">' + esc(r.value) + '</option>';
    });
    html += '<select class="facet-filter" data-key="' + esc(f.key) + '">' + opts + '</select>';
  });
  html += '<select id="f-artKind"><option value="">artifact: any</option><option value="file">file</option><option value="pr">PR</option><option value="feature">feature</option></select>' +
    '<span class="ac" id="f-artifact-ac">' +
      '<input id="f-artifact" placeholder="file path / PR # / feature" autocomplete="off" />' +
      '<div class="ac-menu" id="f-artifact-menu"></div>' +
    '</span>' +
    '<input id="f-q" placeholder="search title / intent" />';
  $('#filters').innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('.facet-filter'), function (s) { s.onchange = applyFilters; });
  $('#f-artKind').onchange = applyFilters;
  var t;
  $('#f-q').oninput = function () { clearTimeout(t); t = setTimeout(applyFilters, 250); };
  // Artifact search: typeahead suggestions + (debounced) live substring filter.
  var t2;
  $('#f-artifact').oninput = function () { clearTimeout(t2); t2 = setTimeout(function () { acFetch(); applyFilters(); }, 200); };
  $('#f-artifact').onkeydown = acKeydown;
  $('#f-artifact').onblur = function () { setTimeout(acClose, 150); }; // delay so a click registers
}

// ---- artifact-search typeahead (session-list filter) -----------------------

function acFetch() {
  var inp = $('#f-artifact');
  if (!inp) return;
  var q = inp.value.trim();
  var kind = $('#f-artKind') ? $('#f-artKind').value : '';
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
  $('#f-artifact').value = it.value;
  if ($('#f-artKind')) $('#f-artKind').value = it.kind; // narrow the filter to the picked kind
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
  state.filters = {
    facets: facets,
    q: $('#f-q') ? $('#f-q').value : '',
    artifact: $('#f-artifact') ? $('#f-artifact').value : '',
    artifactKind: $('#f-artKind') ? $('#f-artKind').value : ''
  };
  loadSessions();
}

export function renderSessions(rows) {
  if (!rows || !rows.length) { $('#sessions').innerHTML = '<div class="empty">No sessions match.</div>'; return; }
  var head = '<tr><th>Session</th><th>Date</th><th>Cost</th><th>Success</th><th>Complexity</th><th>Use case</th><th></th></tr>';
  var body = rows.map(function (r) {
    var tags = (r.useCase || []).slice(0, 3).map(function (u) { return '<span class="tag">' + esc(u) + '</span>'; }).join('');
    var merged = r.prMerged ? '<span class="badge b-success">PR merged</span>' : '';
    return '<tr class="srow" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.title) + '</td>' +
      '<td class="num">' + esc(dayOf(r.startedAt)) + '</td>' +
      '<td class="num">' + usd(r.costUsd) + '</td>' +
      '<td>' + badge(r.success) + '</td>' +
      '<td>' + esc(r.complexity || '—') + '</td>' +
      '<td>' + tags + '</td>' +
      '<td>' + merged + '</td></tr>';
  }).join('');
  $('#sessions').innerHTML = '<table>' + head + body + '</table>';
  Array.prototype.forEach.call(document.querySelectorAll('.srow'), function (tr) {
    tr.onclick = function () { openDetail(tr.getAttribute('data-id')); };
  });
}

export function openDetail(id) {
  get('/api/session?id=' + encodeURIComponent(id)).then(function (d) {
    if (!d || d.error) return;
    var s = d.session, a = d.annotations || {};
    var uc = Array.isArray(a.use_case) ? a.use_case.join(', ') : '';
    var html = '<h2>' + esc(s.title || '(untitled)') + '</h2>';
    html += '<div class="kv">';
    html += '<span class="k">when</span><span class="num">' + esc(dayOf(s.startedAt)) + '</span>';
    if (s.repo) html += '<span class="k">repo</span><span>' + esc(s.repo) + '</span>';
    html += '<span class="k">cost</span><span class="num">' + usd(s.costUsd) + '</span>';
    html += '<span class="k">models</span><span>' + esc((s.models || []).join(', ')) + '</span>';
    html += '<span class="k">success</span><span>' + badge(a.success) + '</span>';
    html += '<span class="k">complexity</span><span>' + esc(a.complexity || '—') + '</span>';
    html += '<span class="k">autonomy</span><span>' + esc(a.autonomy || '—') + '</span>';
    if (uc) html += '<span class="k">use case</span><span>' + esc(uc) + '</span>';
    html += '</div>';
    if (a.intent_summary) html += '<div class="sect-h">Intent</div><div>' + esc(a.intent_summary) + '</div>';

    var arts = d.artifacts || [];
    var feats = arts.filter(function (x) { return x.kind === 'feature'; });
    if (feats.length) {
      html += '<div class="sect-h">Features</div>';
      html += feats.map(function (f) {
        return '<span class="tag click" data-art="' + esc(f.title) + '" data-kind="feature">' +
          esc(f.title) + (f.source === 'derived' ? ' (proposed)' : '') + '</span>';
      }).join('');
    }
    var prs = arts.filter(function (x) { return x.kind === 'pr'; });
    if (prs.length) {
      html += '<div class="sect-h">Pull requests</div>';
      html += prs.map(function (p) {
        var label = (p.repo ? esc(p.repo) + ' ' : '') + '#' + esc(p.ident) + (p.status ? ' (' + esc(p.status) + ')' : '');
        return '<span class="tag click" data-art="' + esc(p.externalId || p.ident) + '" data-kind="pr">' + label + '</span>';
      }).join('');
    }
    var files = arts.filter(function (x) { return x.kind === 'file'; });
    if (files.length) {
      html += '<div class="sect-h">Files touched (' + files.length + ')</div>';
      html += files.slice(0, 12).map(function (f) {
        return '<span class="tag click" data-art="' + esc(f.ident) + '" data-kind="file">' + esc(f.ident) + '</span>';
      }).join('');
      if (files.length > 12) html += '<span class="tag">+' + (files.length - 12) + ' more</span>';
    }
    var outs = d.outcomes || [];
    if (outs.length) {
      html += '<div class="sect-h">Outcomes</div>';
      html += outs.map(function (o) { return '<span class="tag">' + esc(o.type) + '</span>'; }).join('');
    }

    html += '<div class="sect-h">Transcript</div>';
    html += (d.transcript || []).map(function (t) {
      var tools = (t.tools || []).map(function (tl) {
        return '<span class="tool-chip ' + (tl.ok ? '' : 'err') + '">' + esc(tl.name) + (tl.target ? ' ' + esc(tl.target) : '') + '</span>';
      }).join('');
      return '<div class="turn ' + esc(t.role) + '"><div class="role">' + esc(t.role) + (t.sidechain ? ' · subagent' : '') + '</div>' +
        (t.text ? '<div class="text">' + esc(t.text) + '</div>' : '') +
        (tools ? '<div class="tools">' + tools + '</div>' : '') + '</div>';
    }).join('') || '<div class="empty">No transcript stored.</div>';

    $('#drawerBody').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tag.click'), function (el) {
      el.onclick = function () { filterByArtifact(el.getAttribute('data-art'), el.getAttribute('data-kind')); };
    });
    $('#drawer').classList.add('on');
    $('#overlay').classList.add('on');
  });
}

export function filterByArtifact(text, kind) {
  closeDrawer();
  setView('sessions');
  var ak = $('#f-artKind'), af = $('#f-artifact');
  if (ak) ak.value = kind || '';
  if (af) af.value = text || '';
  applyFilters();
}

export function closeDrawer() { $('#drawer').classList.remove('on'); $('#overlay').classList.remove('on'); }

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
  get('/api/sessions' + (qs.length ? '?' + qs.join('&') : '')).then(renderSessions);
}
