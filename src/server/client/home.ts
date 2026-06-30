// The Highlights digest — the Dashboard's default view. A few computed insights
// about your recent AI work (over a fixed window, see HL_DAYS below),
// each a sentence with the real numbers + a "See the data →" drill-in into the
// surface behind it (with a grounding banner, see askbanner.ts). Rendered into
// #metric-detail when state.metric === 'highlights' (the landing default).
import { state, $, esc, usd, num, get } from './core'
import { openMetric, renderWindow, loadKpis } from './kpis'
import { filterByArtifact, setView } from './sessions'
import { openArtifactSearch } from './artifacts'
import { renderAskBanner, clearAsked } from './askbanner'
import { storeStatus, noticeHtml } from './notice'

// Highlights runs over a fixed window — wider than the Dashboard's 7d default so
// short-lived signals still surface, but capped at 14 so the prior-period
// comparison (this 14d vs the 14d before it = 28d back) stays inside Claude
// Code's ~30-day session retention and still has data to compare against. 30d
// would reach 60 days back and the comparison would be empty. Change it here and
// the copy, the drill window, and the API call all follow.
var HL_DAYS = 14;
var HL_WIN = 'the last ' + HL_DAYS + ' days';
var HL_PREV = 'the previous ' + HL_DAYS + ' days';

function base(p) { var a = String(p || '').split('/'); return a[a.length - 1] || p; }
function pct(n) { return Math.round(n) + '%'; }
function ratePct(r) { return Math.round((r || 0) * 100) + '%'; }
function signed(n) { return (Number(n) >= 0 ? '+' : '') + n + '%'; }
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ''); }

// The change clause for a relative trend (spend, sessions). A big INCREASE (≥2×)
// switches from an unreadable percentage ("+2169%") to a multiple with the prior
// value for context ("≈23× the previous 14 days ($63.57)"); everything else (and
// any decrease, which is naturally bounded at −100%) stays a signed percentage.
// `fmt` formats the prior absolute value (usd for spend, num for counts).
function relChange(cur, prev, pctNum, fmt) {
  if (pctNum >= 100 && prev > 0) {
    var mult = cur / prev;
    var multStr = mult >= 10 ? String(Math.round(mult)) : String(Math.round(mult * 10) / 10);
    return '<b>≈' + multStr + '×</b> ' + HL_PREV + ' (' + esc(fmt(prev)) + ')';
  }
  return '<b>' + signed(pctNum) + '</b> vs ' + HL_PREV;
}

// A highlight that drills into the Dashboard pins its window to the Highlights
// window first, so the chart matches the statement the user just clicked (the
// Dashboard otherwise keeps whatever window it was last left on). This is why 14d
// has to be a selectable Dashboard window — the drill lands the user on it.
function dashHl() {
  state.days = HL_DAYS;
  setView('dashboard');
  renderWindow();
  loadKpis();
}

// Friendly noun for a walked facet, used in the orientation line + the tag labels.
var FACET_NOUN = { use_case: 'work type', repo: 'repo', model: 'model', harness: 'agent', complexity: 'complexity', autonomy: 'autonomy' };

// Per-tag-key plain-language hover tooltip, surfaced via the tag's title=.
var TAG_INFO = {
  file: { tip: 'A file your AI changed.' },
  PR: { tip: 'A pull request your AI opened or merged.' },
  feature: { tip: 'A unit of work your sessions are linked to.' },
  repo: { tip: 'The repository the work was in.' },
  model: { tip: 'The LLM model used.' },
  agent: { tip: 'The agent/harness used (Claude Code, Codex…).' },
  complexity: { tip: 'How hard the task was (LLM-judged).' },
  autonomy: { tip: 'How much the AI worked unaided (LLM-judged).' },
  'work type': { tip: 'The kind of work — implement, debug, research… (LLM-judged).' },
};

// A facet/artifact mention styled as a labeled tag — a small muted uppercase key
// ("PR", "FILE", "REPO") then the value with a faint underline — so a bare value
// isn't mistaken for prose. Numbers stay bold (<b>); the label + tooltip explain it.
function tag(key, value) {
  var info = TAG_INFO[key] || { tip: '' };
  return '<span class="hl-tag"' + (info.tip ? ' title="' + esc(info.tip) + '"' : '') +
    '><span class="hl-tag-k">' + esc(key) + '</span><span class="hl-tag-v">' + esc(value) + '</span></span>';
}

// Map an insight payload -> { html sentence, destination label, grounding `about`,
// the localStorage `section` its orientation is gated on, and run() = the drill-in }.
function present(h) {
  switch (h.kind) {
    case 'biggest_shipped': {
      var t = h.artifactKind === 'pr'
        ? tag('PR', h.repo && h.ident ? h.repo + '#' + h.ident + ' (' + h.title + ')' : h.title)
        : tag('feature', h.title);
      return {
        html: 'Most AI spend on shipped work: ' + t + ' — <b>' + esc(usd(h.cost)) + '</b>.',
        to: h.artifactKind === 'pr' ? 'Artifacts · PRs' : 'Artifacts · Features', section: 'artifacts',
        about: 'The Artifacts view lists every PR and feature your AI touched, with its block-attributed cost.',
        run: function () { openArtifactSearch(h.artifactKind, h.title); },
      };
    }
    case 'trend': {
      if (h.metric === 'rate') {
        var moved = (h.pp || 0) >= 0 ? 'rose' : 'fell';
        return {
          html: 'Your success rate ' + moved + ' from <b>' + ratePct(h.prev) + '</b> to <b>' + ratePct(h.cur) + '</b> vs ' + HL_PREV + '.',
          to: 'Session Outcome Rate', section: 'success_rate',
          about: 'The outcome rate over time — the same signal as the headline tile, here over ' + HL_WIN + '.',
          run: function () { dashHl(); state.sr.by = ''; openMetric('success_rate', true); },
        };
      }
      if (h.metric === 'sessions') {
        return {
          html: 'You ran <b>' + num(h.cur) + ' sessions</b> — ' + relChange(h.cur, h.prev, h.pct, num) + '.',
          to: 'Sessions over time', section: 'sessions_metric',
          about: 'Session count over time — the same signal as the headline tile, here over ' + HL_WIN + '.',
          run: function () { dashHl(); state.sm.by = ''; state.sm.bucket = ''; openMetric('sessions', true); },
        };
      }
      return {
        html: 'You spent <b>' + esc(usd(h.cur)) + '</b> — ' + relChange(h.cur, h.prev, h.pct, usd) + '.',
        to: 'Total spend', section: 'total_spend',
        about: 'Spend over time — the same signal as the headline tile, here over ' + HL_WIN + '.',
        run: function () { dashHl(); state.spend.by = ''; openMetric('total_spend', true); },
      };
    }
    case 'stalled_spend': {
      var st = h.artifactKind === 'pr'
        ? tag('PR', h.repo && h.ident ? h.repo + '#' + h.ident + ' (' + h.title + ')' : h.title)
        : tag('feature', h.title);
      return {
        html: 'Most AI spend not yet shipped: ' + st + ' — <b>' + esc(usd(h.cost)) + '</b>.',
        to: h.artifactKind === 'pr' ? 'Artifacts · PRs' : 'Artifacts · Features', section: 'artifacts',
        about: 'The Artifacts view shows each PR and feature with its block-attributed cost and whether it has shipped yet.',
        run: function () { openArtifactSearch(h.artifactKind, h.title); },
      };
    }
    case 'converted_spend':
      return {
        html: '<b>' + pct(h.pct) + '</b> of your AI spend (<b>' + esc(usd(h.shipped)) + '</b> of ' + esc(usd(h.total)) + ') turned into shipped work.',
        to: 'Cost per shipped artifact', section: 'cost_artifact',
        about: 'The burn curve shades how much of each period’s spend converted into shipped work versus what’s still in flight.',
        run: function () { dashHl(); state.ca.kind = 'pr'; state.ca.userPicked = true; openMetric('cost_artifact', true); },
      };
    case 'active_file':
      return {
        html: 'You touched ' + tag('file', base(h.path)) + ' in <b>' + num(h.sessions) + ' sessions</b> — more than any other.',
        to: 'Sessions · Files', section: 'sessions',
        about: 'This is your session list filtered to one file; open a session’s Files tab to see exactly what changed.',
        run: function () { filterByArtifact(h.path, 'file', HL_DAYS); },
      };
    case 'spend_concentration':
      return {
        html: '<b>' + pct(h.pct) + '</b> of your spend went to ' + tag(FACET_NOUN[h.facet] || h.facet, h.value) + '.',
        to: 'Total spend', section: 'total_spend',
        about: 'Spend over time, split by ' + (FACET_NOUN[h.facet] || h.facet) + ' — change the breakdown or filter to dig in.',
        run: function () { dashHl(); state.spend.by = h.facet; openMetric('total_spend', true); },
      };
    case 'success_spread': {
      var k = FACET_NOUN[h.facet] || h.facet;
      return {
        html: 'Your success rate is <b>' + ratePct(h.best.rate) + '</b> for ' + tag(k, h.best.value) + ' (' + num(h.best.n) +
          ' sessions) but <b>' + ratePct(h.worst.rate) + '</b> for ' + tag(k, h.worst.value) + ' (' + num(h.worst.n) + ').',
        to: 'Session Outcome Rate', section: 'success_rate',
        about: 'The outcome rate broken down by ' + k + ', so you can see where your AI does well.',
        run: function () { dashHl(); state.sr.by = h.facet; openMetric('success_rate', true); },
      };
    }
    case 'autonomy_complex': {
      var d = h.delta;
      var deltaStr = (d != null && d !== 0) ? ' — <b>' + (d > 0 ? 'up ' + d : 'down ' + Math.abs(d)) + '%</b> vs the prior ' + HL_DAYS + ' days' : '';
      return {
        html: '<b>' + num(h.count) + ' of your sessions</b> ran autonomously on complex tasks' + deltaStr + '.',
        to: 'Sessions over time', section: 'sessions_metric',
        about: 'Session count over time, filtered to complex tasks and broken down by autonomy — how much your agent takes on unaided.',
        run: function () {
          dashHl();
          state.sm.by = 'autonomy';
          state.sm.bucket = 'week';
          state.sm.filters = { complexity: ['substantial', 'open-ended'] };
          openMetric('sessions', true);
        },
      };
    }
    default:
      return null;
  }
}

// The most recent /api/highlights payload, kept so the tab can repaint (e.g. to
// add the store-state nudge) once the overview lands, without a refetch.
var lastHl: any = null;

// Highlights is its own tab, fixed to HL_DAYS (no window selector).
export function renderHighlights() {
  get('/api/highlights?days=' + HL_DAYS).then(function (d) {
    lastHl = d;
    paintHighlights();
  });
}

// Paint the digest from the last fetched payload. Separated from the fetch so the
// overview load can trigger a repaint that folds in the store-state nudge (a fresh
// store replaces the digest with a first-run prompt; an un-enriched one prepends
// the enrichment nudge). No-op until the first fetch resolves.
export function paintHighlights() {
  if (!lastHl) return;
  var winLabel = HL_WIN;
  // Fresh store (nothing analyzed): the digest would just say "nothing notable",
  // which reads as recent inactivity rather than an empty store — show the
  // first-run nudge alone instead.
  if (storeStatus() === 'empty') { $('#highlights').innerHTML = noticeHtml(); return; }
  var items = (lastHl && lastHl.highlights) || [];
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
    noticeHtml() + // enrichment nudge when un-enriched; '' once enrichment has run
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
}

// Return to the Highlights tab (wired to the brand logo + the banner's back link).
export function goHighlights() {
  clearAsked();
  setView('highlights');
  renderHighlights();
}
