// AI-written share detail: the added-line-weighted fraction of merged-PR code the
// agent authored (content-matched), as a trend over completion buckets plus a
// distribution histogram (does the agent write a little of many PRs, or most of a
// few?). The % is a lower bound: best single session per PR, and shell-side edits
// (sed/perl, generators) are invisible to content matching.
import { state, $, esc, get, fmtVal, num, dayOf, autoBucket, windowQs } from '../core'
import { valueLineChart } from '../charts'

export function renderAiAttribution() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>AI-written share</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="ai-controls"></div>' +
      '<div class="chart-title">AI-written share of merged-PR code</div>' +
      '<div id="ai-chart"></div>' +
      '<div class="sr-legend" id="ai-legend"></div>' +
      '<div class="card-note" id="ai-note"></div>' +
      '<div class="card-note" id="ai-unshipped"></div>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="chart-title">PRs by AI-written share</div>' +
      '<div class="errcat" id="ai-hist"></div>' +
      '<div class="card-note" id="ai-hist-note"></div>' +
    '</div>';
  renderAiControls();
  loadAiAttribution();
}

function renderAiControls() {
  var activeBucket = autoBucket(state.ai.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  $('#ai-controls').innerHTML =
    '<div class="sr-ctrl-row">' +
      '<span class="sr-by-ctrl"><span class="sr-lbl">Bucket</span><span class="seg" id="ai-bucket">' + bucketBtns + '</span></span></div>';
  Array.prototype.forEach.call($('#ai-bucket').children, function (btn) {
    btn.onclick = function () { state.ai.bucket = btn.getAttribute('data-b'); renderAiControls(); loadAiAttribution(); };
  });
}

function loadAiAttribution() {
  var qs = 'bucket=' + encodeURIComponent(autoBucket(state.ai.bucket));
  get('/api/ai-attribution?' + qs + windowQs()).then(function (d) {
    if (!d || d.error) { $('#ai-chart').innerHTML = '<div class="empty">' + esc(d && d.error ? d.error : 'No data.') + '</div>'; return; }
    renderAi(d);
  });
}

function renderAi(d) {
  var kpi = d.kpi || {};
  if (!d.trend || !d.trend.length) {
    $('#ai-chart').innerHTML = '<div class="empty">No content-matched merged PRs in this window yet - the share appears once analyzed sessions match a merged PR’s diff.</div>';
    $('#ai-legend').innerHTML = '';
    $('#ai-note').innerHTML = '';
    $('#ai-unshipped').innerHTML = '';
    $('#ai-hist').innerHTML = '<div class="empty">No data yet.</div>';
    $('#ai-hist-note').innerHTML = '';
    return;
  }
  // One line, values as whole percents (the shared charts round to integers).
  var line = {
    label: 'AI-written', color: '#4a7c59', total: null,
    points: d.trend.map(function (t) { return { bucket: t.bucket, y: Math.round(t.pct * 100) }; })
  };
  $('#ai-chart').innerHTML = valueLineChart(d.buckets || [], [line], '', '% of added lines');
  $('#ai-legend').innerHTML = '<span class="leg-overall">Window: ' +
    (kpi.pct != null ? esc(fmtVal(kpi.pct, 'pct')) : '—') + ' of ' + esc(String(kpi.addedLines || 0)) +
    ' added lines across ' + esc(String(kpi.prCount || 0)) + ' measured PR' + (kpi.prCount === 1 ? '' : 's') + '</span>';
  $('#ai-note').innerHTML = esc('Added-line-weighted, dated at PR merge. A lower bound: shell-command edits aren’t counted.');
  renderUnshipped(d.unshipped);
  renderHistogram(d);
  $('#ai-hist-note').innerHTML = esc('Each merged PR falls into a band by how much of its code the agent wrote');
}

// Closed-without-merge / still-open counterpart to the merged-PR figure above: a compact
// footnote counting agent-matched PRs that didn't (yet) ship. Counts, not a chart — at
// typical volumes (a handful of PRs) a bucketed trend would be noise. Dated at PR open.
// Narrow by construction: only PRs that reached GitHub and passed content-matching are
// counted; work abandoned before ever becoming a PR isn't visible here.
function renderUnshipped(un) {
  un = un || { closed: { count: 0 }, open: { count: 0 } };
  var lines = [];
  if (un.closed.count > 0) {
    lines.push(un.closed.count + ' PR' + (un.closed.count === 1 ? '' : 's') + ' opened this window closed without merging.');
  }
  if (un.open.count > 0) {
    lines.push(un.open.count + ' PR' + (un.open.count === 1 ? '' : 's') + ' opened this window still open.');
  }
  if (!lines.length) { $('#ai-unshipped').innerHTML = ''; return; }
  $('#ai-unshipped').innerHTML = lines.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('');
}

// Accordion histogram (mirrors ops' errors-by-category): each band expands to the
// merged PRs inside it; a PR row opens the PR on GitHub. All data arrives with the
// detail payload, so panels are built up front — no lazy fetch.
function renderHistogram(d) {
  var hist = d.histogram || [];
  var byBand = hist.map(function () { return []; });
  (d.prs || []).forEach(function (p) {
    // Must mirror the store's banding: truncate aiPct·5, top band closed.
    byBand[Math.min(hist.length - 1, Math.floor(p.aiPct * 5))].push(p);
  });
  var max = 0;
  hist.forEach(function (h) { if (h.count > max) max = h.count; });
  $('#ai-hist').innerHTML = hist.map(function (h, i) {
    var pct = max ? Math.round((h.count / max) * 100) : 0;
    var rows = byBand[i].map(function (p) {
      return '<div class="aihist-pr-row"' + (p.externalId ? ' data-url="' + esc(p.externalId) + '"' : '') + '>' +
        '<span class="aihist-ident">#' + esc(p.ident) + '</span>' +
        '<span class="aihist-repo"' + (p.repo ? ' title="' + esc(p.repo) + '"' : '') + '>' + esc(p.repo || '') + '</span>' +
        '<span class="occ-sess">' + esc(p.title || '(untitled)') + '</span>' +
        '<span class="occ-date">' + esc(fmtVal(p.aiPct, 'pct')) + '</span>' +
        '<span class="occ-date">' + esc(num(p.addedLines)) + ' lines</span>' +
        '<span class="occ-date">' + esc(dayOf(p.completedAt)) + '</span>' +
        '<span class="aihist-link">' + (p.externalId ? '↗' : '') + '</span></div>';
    }).join('');
    // A counted band must never expand to a blank panel (e.g. a server still running
    // pre-`prs` code): show an explicit empty row instead of an invisible click.
    if (!rows && h.count) rows = '<div class="occ-empty">PR details unavailable — restart `tuneloop serve` if this persists.</div>';
    return '<div class="errcat-item">' +
      '<div class="bar-row' + (h.count ? ' errcat-row' : '') + '" data-band="' + i + '">' +
        '<span class="name">' + esc(h.band) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="n"><span class="cnt">' + h.count + '</span></span></div>' +
      (h.count ? '<div class="errcat-occ" hidden><div class="occ-list">' + rows + '</div></div>' : '') + '</div>';
  }).join('');
  // Single-open accordion, scoped to this widget.
  Array.prototype.forEach.call(document.querySelectorAll('#ai-hist .errcat-row'), function (el) {
    el.onclick = function () {
      var panel = el.parentNode.querySelector('.errcat-occ');
      if (!panel) return;
      var wasOpen = !panel.hidden;
      Array.prototype.forEach.call(document.querySelectorAll('#ai-hist .errcat-occ'), function (p) {
        p.hidden = true;
        var row = p.parentNode.querySelector('.bar-row');
        if (row) row.classList.remove('open');
      });
      if (wasOpen) return;
      panel.hidden = false;
      el.classList.add('open');
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('#ai-hist .aihist-pr-row[data-url]'), function (el) {
    el.onclick = function () { window.open(el.getAttribute('data-url'), '_blank', 'noopener'); };
  });
}
