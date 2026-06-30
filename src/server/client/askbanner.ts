// The grounding message shown when the user drills in from a highlight's "See the
// data". It renders INTO a slot directly above the destination chart/table (not at
// the page top, where it went unread) and scrolls that slot into view, so the
// orientation sits next to the thing it describes. Two parts: a slim breadcrumb
// (the insight + a "← Back to Highlights" link) and a one-time-per-section
// orientation (what you're looking at), dismissable and remembered in localStorage.
import { state, esc } from './core'
import { goHighlights } from './home'

// Which view's slot a destination renders into (keyed by the insight's `section`).
var SECTION_SLOT = {
  success_rate: 'ask-dashboard',
  cost_artifact: 'ask-dashboard',
  total_spend: 'ask-dashboard',
  sessions_metric: 'ask-dashboard',
  artifacts: 'ask-artifacts',
  sessions: 'ask-sessions',
};
var ALL_SLOTS = ['ask-dashboard', 'ask-artifacts', 'ask-sessions'];

function seenKey(section) { return 'tuneloop.seen.' + section; }
function seen(section) { try { return !!localStorage.getItem(seenKey(section)); } catch (e) { return false; } }
function markSeen(section) { try { localStorage.setItem(seenKey(section), '1'); } catch (e) { /* private mode */ } }

// `scroll` = bring the slot into view (true only on a fresh drill — not on a dismiss
// re-render, which would yank the page).
export function renderAskBanner(scroll?) {
  ALL_SLOTS.forEach(function (id) { var s = document.getElementById(id); if (s) { s.className = 'ask-slot'; s.innerHTML = ''; } });
  var a = state.asked;
  if (!a) return;
  var slot = document.getElementById(SECTION_SLOT[a.section] || 'ask-dashboard');
  if (!slot) return;

  var showOrient = (a.answer || a.about) && !seen(a.section);
  var html =
    '<div class="ask-banner on"><div class="ask-bc"><span class="ask-q">' + esc(a.q) + '</span>' +
    '<a class="ask-back" id="ask-back">← Back to Highlights</a></div>';
  if (showOrient) {
    html +=
      '<div class="ask-orient">' +
      (a.answer ? '<span class="ask-ans">' + esc(a.answer) + '</span> ' : '') +
      (a.about ? '<span class="ask-about">' + esc(a.about) + '</span>' : '') +
      '<button class="ask-x" id="ask-x" title="Got it — don’t show this again">✕</button></div>';
  }
  html += '</div>';
  slot.className = 'ask-slot on';
  slot.innerHTML = html;

  var back = slot.querySelector('.ask-back') as any; if (back) back.onclick = goHighlights;
  var x = slot.querySelector('.ask-x') as any; if (x) x.onclick = function () { markSeen(a.section); renderAskBanner(); };

  if (scroll) slot.scrollIntoView({ block: 'start' });
}

// Drop the grounding context (manual nav away from a highlight) and clear the slots.
export function clearAsked() {
  state.asked = null;
  renderAskBanner();
}
