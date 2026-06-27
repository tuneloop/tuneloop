// The Highlights digest — the Dashboard's default view. A few computed insights
// about your recent AI work (windowed by the shared 7d/30d/90d/All selector),
// each a sentence with the real numbers + a "See the data →" drill-in into the
// surface behind it (with a grounding banner, see askbanner.ts). Rendered into
// #metric-detail when state.metric === 'highlights' (the landing default).
import { state, $, esc, usd, num, get } from './core'
import { openMetric } from './kpis'
import { filterByArtifact, setView } from './sessions'
import { openArtifactSearch } from './artifacts'
import { renderAskBanner, clearAsked } from './askbanner'

function base(p) { var a = String(p || '').split('/'); return a[a.length - 1] || p; }
function pct(n) { return Math.round(n) + '%'; }
function ratePct(r) { return Math.round((r || 0) * 100) + '%'; }
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ''); }

// Friendly noun for a walked facet, used in the orientation line + the tag labels.
var FACET_NOUN = { use_case: 'work type', repo: 'repo', model: 'model', harness: 'agent', complexity: 'complexity', autonomy: 'autonomy' };

// Per-tag-key metadata: `cat` drives the background tint (artifacts — the concrete
// things the AI produced — get a faint emerald; facets — the dimensions aivue
// slices by — stay neutral), and `tip` is a plain-language hover tooltip.
var TAG_INFO = {
  file: { cat: 'artifact', tip: 'A file your AI changed.' },
  PR: { cat: 'artifact', tip: 'A pull request your AI opened or merged.' },
  feature: { cat: 'artifact', tip: 'A unit of work your sessions are linked to.' },
  repo: { cat: 'facet', tip: 'The repository the work was in.' },
  model: { cat: 'facet', tip: 'The LLM model used.' },
  agent: { cat: 'facet', tip: 'The agent/harness used (Claude Code, Codex…).' },
  complexity: { cat: 'facet', tip: 'How hard the task was (LLM-judged).' },
  autonomy: { cat: 'facet', tip: 'How much the AI worked unaided (LLM-judged).' },
  'work type': { cat: 'facet', tip: 'The kind of work — implement, debug, research… (LLM-judged).' },
};

// A facet/artifact mention styled as a labeled tag — "complexity: routine",
// "feature: <name>" — so a bare value isn't mistaken for prose. Numbers stay bold
// (<b>); these get the tag treatment + a tooltip explaining what the thing is.
function tag(key, value) {
  var info = TAG_INFO[key] || { tip: '' };
  return '<span class="hl-tag"' + (info.tip ? ' title="' + esc(info.tip) + '"' : '') +
    '><span class="hl-tag-k">' + esc(key) + ':</span> ' + esc(value) + '</span>';
}

// Map an insight payload -> { html sentence, destination label, grounding `about`,
// the localStorage `section` its orientation is gated on, and run() = the drill-in }.
function present(h) {
  switch (h.kind) {
    case 'biggest_shipped': {
      var verb = h.verb === 'shipping' ? 'shipped' : 'worked on';
      var t = h.artifactKind === 'pr'
        ? tag('PR', h.repo && h.ident ? h.repo + '#' + h.ident + ' (' + h.title + ')' : h.title)
        : tag('feature', h.title);
      return {
        html: 'The biggest thing you ' + verb + ': ' + t + ' — <b>' + esc(usd(h.cost)) + '</b> in AI spend.',
        to: h.artifactKind === 'pr' ? 'Artifacts · PRs' : 'Artifacts · Features', section: 'artifacts',
        about: 'The Artifacts view lists every PR and feature your AI touched, with its block-attributed cost.',
        run: function () { openArtifactSearch(h.artifactKind, h.title); },
      };
    }
    case 'converted_spend':
      return {
        html: '<b>' + pct(h.pct) + '</b> of your AI spend (<b>' + esc(usd(h.shipped)) + '</b> of ' + esc(usd(h.total)) + ') turned into shipped work.',
        to: 'Cost per shipped artifact', section: 'cost_artifact',
        about: 'The burn curve shades how much of each period’s spend converted into shipped work versus what’s still in flight.',
        run: function () { setView('dashboard'); state.ca.kind = 'pr'; state.ca.userPicked = true; openMetric('cost_artifact'); },
      };
    case 'active_file':
      return {
        html: 'You touched ' + tag('file', base(h.path)) + ' in <b>' + num(h.sessions) + ' sessions</b> — more than any other.',
        to: 'Sessions · Files', section: 'sessions',
        about: 'This is your session list filtered to one file; open a session’s Files tab to see exactly what changed.',
        run: function () { filterByArtifact(h.path, 'file'); },
      };
    case 'feature_focus':
      return {
        html: 'You’ve put <b>' + num(h.sessions) + ' sessions</b> into ' + tag('feature', h.title) + '.',
        to: 'Sessions', section: 'sessions',
        about: 'This is your session list filtered to one feature; click a row to open its transcript and summary.',
        run: function () { filterByArtifact(h.title, 'feature'); },
      };
    case 'spend_concentration':
      return {
        html: '<b>' + pct(h.pct) + '</b> of your spend went to ' + tag(FACET_NOUN[h.facet] || h.facet, h.value) + '.',
        to: 'Total spend', section: 'total_spend',
        about: 'Spend over time, split by ' + (FACET_NOUN[h.facet] || h.facet) + ' — change the breakdown or filter to dig in.',
        run: function () { setView('dashboard'); state.spend.by = h.facet; openMetric('total_spend'); },
      };
    case 'success_spread': {
      var k = FACET_NOUN[h.facet] || h.facet;
      return {
        html: 'Your success rate is <b>' + ratePct(h.best.rate) + '</b> for ' + tag(k, h.best.value) + ' (' + num(h.best.n) +
          ' sessions) but <b>' + ratePct(h.worst.rate) + '</b> for ' + tag(k, h.worst.value) + ' (' + num(h.worst.n) + ').',
        to: 'Session Outcome Rate', section: 'success_rate',
        about: 'The outcome rate broken down by ' + k + ', so you can see where your AI does well.',
        run: function () { setView('dashboard'); state.sr.by = h.facet; openMetric('success_rate'); },
      };
    }
    case 'autonomy_complex': {
      var d = h.delta;
      var deltaStr = (d != null && d !== 0) ? ' — <b>' + (d > 0 ? 'up ' + d : 'down ' + Math.abs(d)) + '%</b> vs the prior 7 days' : '';
      return {
        html: '<b>' + num(h.count) + ' of your sessions</b> ran autonomously on complex tasks' + deltaStr + '.',
        to: 'Sessions over time', section: 'sessions_metric',
        about: 'Session count over time, filtered to complex tasks and broken down by autonomy — how much your agent takes on unaided.',
        run: function () {
          setView('dashboard');
          state.sm.by = 'autonomy';
          state.sm.bucket = 'week';
          state.sm.filters = { complexity: ['substantial', 'open-ended'] };
          openMetric('sessions');
        },
      };
    }
    default:
      return null;
  }
}

// Highlights is its own tab, fixed to the last 7 days (no window selector).
export function renderHighlights() {
  var winLabel = 'the last 7 days';
  get('/api/highlights?days=7').then(function (d) {
    var items = (d && d.highlights) || [];
    var rows = items.map(function (h, i) {
      var p = present(h);
      if (!p) return '';
      return '<div class="hrow">' +
        '<span class="hrow-q">' + p.html + '</span>' +
        '<button type="button" class="hrow-to" data-i="' + i + '">See the data <i>→</i></button></div>';
    }).join('');
    if (!rows) rows = '<div class="empty">Nothing notable in ' + esc(winLabel) + ' yet — widen the window, or run more sessions.</div>';
    var dbPath = (state.overview && state.overview.dbPath) || '~/.aivue/aivue.sqlite';
    $('#highlights').innerHTML =
      '<div class="hl">' +
      '<div class="hl-head">Notable in ' + esc(winLabel) + '</div>' +
      '<div class="hlist">' + rows + '</div>' +
      // Order mirrors the top tabs (Dashboard, Artifacts, Sessions).
      '<div class="see-tx-wrap">' +
        '<button class="see-tx" type="button" data-view="dashboard">Headline metrics →</button>' +
        '<button class="see-tx" type="button" data-view="artifacts">Artifacts →</button>' +
        '<button class="see-tx" type="button" data-view="sessions">Your sessions →</button>' +
      '</div>' +
      '<div class="home-ask">Want to do a deep dive into the data? Everything lives in a local SQLite store at ' +
      '<code>' + esc(dbPath) + '</code> — point your coding agent at it. ' +
      '<span class="muted">(Guided agent querying coming soon.)</span></div></div>';
    Array.prototype.forEach.call(document.querySelectorAll('#highlights .see-tx[data-view]'), function (b) {
      b.onclick = function () { clearAsked(); setView(b.getAttribute('data-view')); window.scrollTo(0, 0); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#highlights .hrow-to'), function (el) {
      el.onclick = function () {
        var h = items[parseInt(el.getAttribute('data-i'), 10)];
        var p = present(h);
        if (!p) return;
        // Reuse the grounding banner: the insight IS the answer, so only the
        // orientation (`about`) shows — once per destination section.
        state.asked = { q: stripTags(p.html), answer: '', about: p.about, section: p.section };
        p.run();
        renderAskBanner(true); // renders the message in the slot above the chart + scrolls there
      };
    });
  });
}

// Return to the Highlights tab (wired to the brand logo + the banner's back link).
export function goHighlights() {
  clearAsked();
  setView('highlights');
  renderHighlights();
}
