// Store-state banners. A fresh store (nothing analyzed yet) and an un-enriched
// store (sessions exist but LLM enrichment never ran) both deserve a nudge rather
// than a wall of zeros / a misleading 0% outcome rate. One classifier off the
// /api/overview summary drives every surface — the dashboard banner above the KPI
// row and the Highlights tab — so the copy stays consistent.
import { state, $ } from './core'

export type StoreStatus = 'loading' | 'empty' | 'unenriched' | 'stale' | 'ok'

// The store is "stale" (worth a re-analyze nudge) once this many days have passed
// since the last `analyze` run — aligned with the dashboard's default 7-day window.
var STALE_DAYS = 7;

// Whole days since the last `analyze` run, or null when unknown (older stores that
// predate the recorded timestamp — don't nag those).
export function daysSinceAnalyze(): number | null {
  var o = state.overview;
  var ts = o && o.lastAnalyzedAt;
  if (!ts) return null;
  var t = Date.parse(ts);
  if (!t) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Classify the store from the overview summary, most-urgent first. 'loading' until
// /api/overview resolves; 'empty' = nothing analyzed; 'unenriched' = sessions exist
// but LLM enrichment never ran; 'stale' = enriched/healthy but not analyzed in a
// while; otherwise 'ok'. `enrichmentRan` is sourced from processor_runs (an
// LLM-backed processor recorded a model) — a durable signal that doesn't depend on
// which annotation dimensions the enricher emits, and that works for free local
// providers too (where enrichment spend is $0). The precedence keeps at most one
// nudge on screen at a time.
export function storeStatus(): StoreStatus {
  var o = state.overview;
  if (!o) return 'loading';
  if (!o.sessions) return 'empty';
  if (!o.enrichmentRan) return 'unenriched';
  var d = daysSinceAnalyze();
  if (d != null && d >= STALE_DAYS) return 'stale';
  return 'ok';
}

// Whether the active "count as success" definition is even computable — i.e. at
// least one of the currently-selected success outcome types actually occurs in the
// store. When none can, the Session Outcome Rate is a structural 0 (no possible
// numerator), so the headline tile shows "—" rather than a misleadingly bad "0%".
// This is stricter than "any outcome exists": an un-enriched store can have git
// outcomes (pr_merged…) yet still can't satisfy the default `session_success`
// definition, which only LLM enrichment produces. Returns false until the overview
// lands, so "—" is the safe placeholder rather than a possibly-misleading 0%.
export function successDefinable(): boolean {
  var o = state.overview;
  if (!o) return false;
  var present: Record<string, boolean> = {};
  (o.outcomes || []).forEach(function (x) { present[x.type] = true; });
  // Empty selection → the server falls back to session_success (see Store.kpis).
  var sel = (state.sr && state.sr.outcomes && state.sr.outcomes.length) ? state.sr.outcomes : ['session_success'];
  return sel.some(function (t) { return present[t]; });
}

function notice(cls, head, body) {
  return '<div class="notice ' + cls + '"><div class="notice-h">' + head + '</div><div class="notice-b">' + body + '</div></div>';
}

// Banner HTML for the current store state — '' when ok or still loading (so the
// caller can drop it straight into a slot). Static, author-controlled markup; no
// user data is interpolated, so no escaping is needed.
export function noticeHtml(): string {
  var st = storeStatus();
  if (st === 'empty') {
    // The dashboard is only reachable once a store exists, so landing here means
    // `analyze` ran but ingested nothing (no AI-coding history yet, or a wrong
    // directory / --source) — not that analyze was never run. Word it accordingly.
    return notice('first-run',
      'No sessions found',
      '<code>tuneloop analyze</code> scanned your Claude Code, Codex, opencode, and Pi history but found nothing. ' +
        'Point it at a directory — <code>tuneloop analyze &lt;dir&gt;</code> — or check <code>--source</code>.');
  }
  if (st === 'unenriched') {
    return notice('enrich',
      'LLM enrichment hasn’t run',
      'Outcomes, complexity, work type, and the Session Outcome Rate all need it. Re-run analysis with a provider key — e.g. ' +
        '<code>export TUNELOOP_LLM_PROVIDER=openrouter</code> and <code>export OPENROUTER_API_KEY=…</code>, then <code>tuneloop analyze</code>.');
  }
  if (st === 'stale') {
    var d = daysSinceAnalyze();
    var ago = d != null ? d + ' day' + (d === 1 ? '' : 's') + ' ago' : 'a while ago';
    return notice('stale',
      'Your dashboard may be out of date',
      'Last analyzed ' + ago + '. Run <code>tuneloop analyze</code> to pull in sessions since then.');
  }
  return '';
}

// Mount the banner into every full-width tab slot (Dashboard / Sessions /
// Artifacts); Highlights injects it inline in the digest instead. Called once the
// overview lands — the slots are static, so a tab switch (a visibility toggle)
// leaves them intact, no per-tab re-render needed.
export function renderNotices(): void {
  var html = noticeHtml();
  ['#dash-notice', '#sessions-notice', '#art-notice'].forEach(function (id) {
    var el = $(id);
    if (el) el.innerHTML = html;
  });
}
