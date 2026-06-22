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

export function openDetail(id) {
  get('/api/session?id=' + encodeURIComponent(id)).then(function (d) {
    if (!d || d.error) return;
    var s = d.session, a = d.annotations || {};

    // Sticky-header pieces (title+close, tab subnav, transcript nav) are assembled
    // into one .drawer-head at the end, so they pin together as you scroll.
    var headTop = '<div class="drawer-head-top"><h2>' + esc(s.title || '(untitled)') + '</h2>' +
      '<button class="x" type="button" id="drawerCloseBtn">close</button></div>';
    var tabs = '<div class="drawer-tabs">' +
      '<button class="dtab on" type="button" data-dtab="summary">Summary</button>' +
      '<button class="dtab" type="button" data-dtab="transcript">Transcript</button>' +
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

    var arts = d.artifacts || [];
    var feats = arts.filter(function (x) { return x.kind === 'feature'; });
    if (feats.length) {
      sum += '<div class="sect-h">Features (' + feats.length + ')</div>';
      sum += chipList(feats, 6, function (f) {
        return '<span class="tag click" data-art="' + esc(f.title) + '" data-kind="feature">' +
          esc(f.title) + (f.source === 'derived' ? ' (proposed)' : '') + '</span>';
      });
    }
    var prs = arts.filter(function (x) { return x.kind === 'pr'; });
    if (prs.length) {
      sum += '<div class="sect-h">Pull requests (' + prs.length + ')</div>';
      sum += chipList(prs, 8, function (p) {
        var label = (p.repo ? esc(p.repo) + ' ' : '') + '#' + esc(p.ident) + (p.status ? ' (' + esc(p.status) + ')' : '');
        return '<span class="tag click" data-art="' + esc(p.externalId || p.ident) + '" data-kind="pr">' + label + '</span>';
      });
    }
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
    sum += '<div class="see-tx-wrap"><button class="see-tx" type="button">See transcript →</button></div>';

    // ---- Transcript pane: distinct user/assistant turns, truncated tool runs,
    // inline error panels, and a turn + error navigator. --------------------
    // Claude Code emits each tool call as its OWN tool-only assistant message, so
    // "a long series of tool calls" is a RUN of consecutive such turns. We keep
    // assistant *text* turns separate (the reasoning) but coalesce each run of
    // tool-only turns into one collapsible block: first few chips + "+N more".
    var TOOLCAP = 4;
    var errSeq = 0;        // running id per failed tool call → error-panel anchor
    var userTurns = [];    // {i, text} powering the outline + scroll-spy
    // A tool's target (command/path), previewed to one line with a ⋯ expand
    // toggle when it's longer — so a long `node -e '…'` is fully inspectable.
    var TGT_PREVIEW = 90;
    function tgtHtml(target) {
      if (!target) return '';
      var t = String(target);
      if (t.length <= TGT_PREVIEW) return ' <span class="tgt">' + esc(t) + '</span>';
      return ' <span class="tgt"><span class="tgt-prev">' + esc(clipLine(t, TGT_PREVIEW)) + '</span>' +
        '<span class="tgt-full">' + esc(t) + '</span>' +
        '<button class="tgt-more" type="button" title="Show full command">⋯</button></span>';
    }
    function chipHtml(tl) {
      return '<span class="tool-chip' + (tl.ok ? '' : ' err') + '">' + esc(tl.name) + tgtHtml(tl.target) + '</span>';
    }
    // Failed calls get an always-visible detail panel (the error stepper's jump
    // target): the full command (wrapped/scrollable, no truncation) above the
    // error output, so the user sees both WHAT ran and WHY it failed.
    function errPanelHtml(x) {
      return '<div class="tx-error" id="txerr-' + (errSeq++) + '">' +
        '<div class="tx-error-h">⚠ ' + esc(x.name) + '</div>' +
        (x.target ? '<div class="tx-error-cmd">' + esc(x.target) + '</div>' : '') +
        (x.error
          ? '<div class="tx-error-b">' + esc(x.error) + '</div>'
          : '<div class="tx-error-b muted">(no error detail captured)</div>') + '</div>';
    }
    function toolsHtml(tools) {
      var head = tools.slice(0, TOOLCAP).map(chipHtml).join('');
      var restArr = tools.slice(TOOLCAP);
      var rest = restArr.length
        ? '<span class="tool-rest">' + restArr.map(chipHtml).join('') + '</span>' +
          '<button class="tool-more" type="button" data-n="' + restArr.length + '">+ ' + restArr.length +
          ' more tool call' + (restArr.length > 1 ? 's' : '') + '</button>'
        : '';
      var panels = tools.filter(function (x) { return !x.ok; }).map(errPanelHtml).join('');
      return '<div class="tools">' + head + rest + '</div>' + panels;
    }
    // Message text, collapsed to a preview with a Show more/less toggle when long
    // (assistant/user text is capped at 20k server-side; this keeps walls of text
    // from dominating the scroll while still letting you read the whole thing).
    var MSG_PREVIEW = 1200;
    function textBlock(text) {
      var t = String(text || '');
      if (!t) return '';
      if (t.length <= 2000) return '<div class="text">' + esc(t) + '</div>';
      return '<div class="text msg"><span class="msg-prev">' + esc(t.slice(0, MSG_PREVIEW)) + ' …</span>' +
        '<span class="msg-full">' + esc(t) + '</span></div>' +
        '<button class="msg-more" type="button">Show more ↓</button>';
    }

    var blocks = [];
    var run = null;        // tools accumulated from consecutive tool-only turns
    function flushRun() {
      if (run && run.length) {
        blocks.push('<div class="turn asst toolrun"><div class="role">Tool calls · ' + run.length + '</div>' +
          toolsHtml(run) + '</div>');
      }
      run = null;
    }
    (d.transcript || []).forEach(function (t, i) {
      var tools = t.tools || [];
      if (t.role === 'user') {
        flushRun();
        userTurns.push({ i: i, text: t.text });
        blocks.push('<div class="turn user" id="txt-' + i + '"><div class="role">You<span class="tnum">#' +
          userTurns.length + '</span></div>' + textBlock(t.text) + '</div>');
      } else if (t.text) {
        flushRun();
        var label = t.sidechain ? 'Subagent' : 'Assistant';
        blocks.push('<div class="turn asst' + (t.sidechain ? ' side' : '') + '" id="txt-' + i + '">' +
          '<div class="role">' + esc(label) + '</div>' + textBlock(t.text) +
          (tools.length ? toolsHtml(tools) : '') + '</div>');
      } else if (tools.length) {
        run = (run || []).concat(tools);   // tool-only message → fold into the run
      }
    });
    flushRun();
    var turnsHtml = blocks.join('');
    var errCount = errSeq;

    var outlineItems = userTurns.length
      ? userTurns.map(function (u, k) {
          return '<button class="tx-ol-item" type="button" data-k="' + k + '" data-goto="txt-' + u.i + '">' +
            '<span class="tx-ol-n">' + (k + 1) + '</span><span class="tx-ol-tx">' + esc(clipLine(u.text, 90)) + '</span></button>';
        }).join('')
      : '<div class="empty">No user turns.</div>';
    var nav = '<div class="tx-nav">' +
      '<div class="tx-nav-row">' +
        '<div class="tx-grp">' +
          '<span class="tx-grp-lbl">Turn</span>' +
          '<button class="btn tx-turn-prev" type="button" title="Previous user turn">‹</button>' +
          '<span class="tx-pos"><b class="tx-turn-pos">' + (userTurns.length ? 1 : 0) + '</b>/' + userTurns.length + '</span>' +
          '<button class="btn tx-turn-next" type="button" title="Next user turn">›</button>' +
          '<div class="tx-ol-wrap"><button class="tx-ol-btn" type="button" title="Jump to a turn">▾</button>' +
            '<div class="tx-outline" id="tx-outline">' + outlineItems + '</div></div>' +
        '</div>' +
        (errCount
          ? '<div class="tx-grp tx-errs"><span class="tx-grp-lbl">⚠ Errors</span>' +
            '<button class="btn tx-err-prev" type="button">‹</button>' +
            '<span class="tx-pos"><b class="tx-err-pos">—</b>/' + errCount + '</span>' +
            '<button class="btn tx-err-next" type="button">›</button></div>'
          : '<span class="tx-grp none">no tool errors</span>') +
      '</div>' +
      '<div class="tx-now" id="tx-now"></div>' +
      '</div>';
    var hasTx = (d.transcript || []).length > 0;
    var txBody = turnsHtml || '<div class="empty">No transcript stored.</div>';
    // One sticky header (title + tabs + transcript nav) over the two panes.
    $('#drawerBody').innerHTML =
      '<div class="drawer-head">' + headTop + tabs + (hasTx ? nav : '') + '</div>' +
      '<div class="dpane on" id="dpane-summary">' + sum + '</div>' +
      '<div class="dpane" id="dpane-transcript">' + txBody + '</div>';

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
    // The transcript nav lives in the shared header but only shows on that tab.
    function showTab(name) {
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dtab'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-dtab') === name);
      });
      Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dpane'), function (p) {
        p.classList.toggle('on', p.id === 'dpane-' + name);
      });
      var navEl = $('#drawerBody .tx-nav');
      if (navEl) navEl.classList.toggle('on', name === 'transcript');
      $('#drawer').scrollTop = 0;
      syncHeadH();
      if (name === 'transcript') requestAnimationFrame(function () { spy(); scrollErrPanels(); });
    }
    var closeBtn = $('#drawerCloseBtn');
    if (closeBtn) closeBtn.onclick = closeDrawer;
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .dtab'), function (b) {
      b.onclick = function () { showTab(b.getAttribute('data-dtab')); };
    });
    var seeTx = $('#drawerBody .see-tx');
    if (seeTx) seeTx.onclick = function () { showTab('transcript'); };

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
    // Expand a chip's truncated command in place (the chip becomes a full-width block).
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tgt-more'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var on = b.parentNode.classList.toggle('on');
        var chip = b.closest('.tool-chip');
        if (chip) chip.classList.toggle('exp', on);
        b.textContent = on ? '⌃' : '⋯';
        b.title = on ? 'Collapse' : 'Show full command';
      };
    });
    // Expand a long message's preview to its full text.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .msg-more'), function (b) {
      b.onclick = function () {
        var on = b.previousElementSibling.classList.toggle('on');
        b.textContent = on ? 'Show less ↑' : 'Show more ↓';
      };
    });

    // Artifact chips pivot to a filtered session list.
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tag.click'), function (el) {
      el.onclick = function () { filterByArtifact(el.getAttribute('data-art'), el.getAttribute('data-kind')); };
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
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tx-ol-item'), function (it) {
      it.onclick = function () {
        if (olPanel) olPanel.classList.remove('on');
        if (olBtn) olBtn.classList.remove('on');
        jumpToTurn(parseInt(it.getAttribute('data-k'), 10));
      };
    });
    if (userTurns.length) updateIndicator(0);

    // Error stepper: ‹ / › cycle through the inline error panels, flashing each.
    var errIdx = -1;
    function gotoErr(next) {
      if (!errCount) return;
      errIdx = ((next % errCount) + errCount) % errCount;
      var pos = $('#drawerBody .tx-err-pos');
      if (pos) pos.textContent = String(errIdx + 1);
      var el = document.getElementById('txerr-' + errIdx);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); flashEl(el); }
    }
    var ep = $('#drawerBody .tx-err-prev'), en = $('#drawerBody .tx-err-next');
    if (ep) ep.onclick = function () { gotoErr(errIdx - 1); };
    if (en) en.onclick = function () { gotoErr(errIdx + 1); };

    syncHeadH();
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
