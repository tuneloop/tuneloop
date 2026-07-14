// The Insights tab — the detector ledger. One card per insight: severity,
// lifecycle state, quantified description, evidence links into the session
// drawer, and the fix payload. Two mutations: Copy fix (marks it fix_issued —
// the moment the fix leaves the tool) and Dismiss (a state change, permanent;
// re-detection never resurfaces a dismissed insight).
import { $, esc, get, post, num, dayOf, renderMd } from './core'
import { openDetail } from './sessions'

// fix.type → rendering, per the detector contract (core/detector.ts): prose for
// a behavioral nudge, a code block for the paste/run payload types
// (config-snippet | install-command | fix-prompt).
function fixBody(fix) {
  if (fix.type === 'behavioral-nudge') return '<div class="ins-fix-prose">' + renderMd(fix.content) + '</div>';
  return '<pre class="md-code"><code>' + esc(fix.content) + '</code></pre>';
}

function sevBadge(s) { return '<span class="badge sev-' + esc(s) + '">' + esc(s) + '</span>'; }
function stateBadge(s) { return '<span class="ins-state st-' + esc(s) + '">' + esc(String(s).replace(/_/g, ' ')) + '</span>'; }

// Session ids are `<source>:<uuid>` — the uuid prefix is enough for a chip label;
// the full id rides the tooltip and the drawer shows everything else.
function shortSession(id) {
  var parts = String(id).split(':');
  return (parts[parts.length - 1] || id).slice(0, 8);
}

function card(r, i) {
  var fix = r.fix && r.fix.content
    ? '<div class="ins-fix">' +
        '<div class="ins-fix-head"><span class="ins-fix-label">' + esc(r.fix.label || 'Suggested fix') + '</span>' +
        '<button type="button" class="ins-btn ins-copy" data-i="' + i + '">Copy fix</button></div>' +
        fixBody(r.fix) + '</div>'
    : '';
  var evidence = r.evidence && r.evidence.length
    ? '<div class="ins-evidence"><span class="ins-ev-label">Evidence</span>' +
        r.evidence.map(function (e, j) {
          return '<button type="button" class="ins-ev" data-i="' + i + '" data-j="' + j + '" title="' + esc(e.sessionId) + '">' +
            esc(shortSession(e.sessionId)) + '</button>';
        }).join('') + '</div>'
    : '';
  return '<div class="ins-card" data-id="' + esc(r.id) + '">' +
    '<div class="ins-head">' + sevBadge(r.severity) +
      '<span class="ins-title">' + esc(r.title) + '</span>' + stateBadge(r.state) +
      '<button type="button" class="ins-btn ins-dismiss" data-i="' + i + '">Dismiss</button></div>' +
    '<div class="ins-meta"><span class="tag">' + esc(r.repo) + '</span> · ' + num(r.count) + ' occurrences · last seen ' + esc(dayOf(r.lastSeenAt)) + '</div>' +
    '<div class="ins-desc">' + renderMd(r.description) + '</div>' +
    fix + evidence + '</div>';
}

// The last fetched payload, kept so handlers index into it by position.
var rows: any[] = [];

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
    ? rows.map(card).join('')
    : '<div class="empty">No insights yet. Detectors run during <code>tuneloop analyze</code> and surface improvement opportunities here.</div>';

  Array.prototype.forEach.call(el.querySelectorAll('.ins-ev'), function (b) {
    b.onclick = function () {
      var r = rows[parseInt(b.getAttribute('data-i'), 10)];
      var e = r && r.evidence[parseInt(b.getAttribute('data-j'), 10)];
      if (e) openDetail(e.sessionId);
    };
  });

  Array.prototype.forEach.call(el.querySelectorAll('.ins-copy'), function (b) {
    b.onclick = function () {
      var r = rows[parseInt(b.getAttribute('data-i'), 10)];
      if (!r) return;
      navigator.clipboard.writeText(r.fix.content).then(function () {
        b.textContent = 'Copied ✓';
        setTimeout(function () { b.textContent = 'Copy fix'; }, 1500);
        // Copying is fix issuance. Update the badge in place on a real
        // transition; {ok:false} = the state had already moved on. Re-select the
        // card by id at response time — a repaint may have replaced the DOM.
        post('/api/insights/fix-issued', { id: r.id }).then(function (res) {
          if (!res || !res.ok) return;
          var cur = rows.filter(function (x) { return x.id === r.id; })[0];
          if (cur) cur.state = 'fix_issued';
          var st = document.querySelector('#insights .ins-card[data-id="' + r.id + '"] .ins-state');
          if (st) st.outerHTML = stateBadge('fix_issued');
        });
      }, function () {
        b.textContent = 'Copy failed';
        setTimeout(function () { b.textContent = 'Copy fix'; }, 1500);
      });
    };
  });

  Array.prototype.forEach.call(el.querySelectorAll('.ins-dismiss'), function (b) {
    b.onclick = function () {
      var r = rows[parseInt(b.getAttribute('data-i'), 10)];
      if (!r) return;
      if (!window.confirm('Dismiss "' + r.title + '"? It will not resurface, even if the pattern recurs.')) return;
      post('/api/insights/dismiss', { id: r.id }).then(renderInsights);
    };
  });
}
