// Shared state singleton + the small primitives every module leans on: DOM
// lookup, escaping, formatting, fetch helpers, and the KPI delta badge. Kept in
// the same vanilla style as the rest of the client so the extraction stays a
// structural move, not a rewrite.

// The client is a small SPA with a single shared mutable state object. API
// payloads stay `any` (the server owns those shapes); the control state that the
// UI reassigns is typed so the wider value ranges (e.g. days: number | 'all')
// are explicit and property typos are caught.
export interface SessionFilters {
  facets: Record<string, string>
  q: string
  artifact: string
  artifactKind: string
  outcomes: string[]
  // Resolved window for the request (ISO); '' when the window is 'all'.
  from: string
  to: string
}

// Sessions-list time window. `preset` drives from/to; 'custom' reads the date
// inputs; 'all' means no bound. Independent of the dashboard KPI window.
export interface SessTime {
  preset: 7 | 30 | 90 | 'all' | 'custom'
  from: string // ISO date (yyyy-mm-dd) for custom range
  to: string
}

export interface ClientState {
  artKind: string
  overview: any
  filters: Partial<SessionFilters> // starts {}, filled in by applyFilters()
  facets: any[]
  dist: Record<string, any[]>
  measures: any[]
  metric: string | null // which headline KPI's detail view is open (null = overview)
  outcomeTypes: any[]
  days: number | 'all' // top-level KPI window (drives the whole headline row + cost-artifact curves)
  sr: { outcomes: string[]; bucket: string; by: string } // success-rate detail controls
  // cost-per-artifact detail controls. `kind` follows defaultKind until the user
  // toggles it (userPicked), after which it sticks and the headline tile mirrors
  // it. `bucket` is the curve granularity: '' = auto-derived from the window;
  // a manual pick overrides until the window changes.
  ca: { kind: string; defaultKind: string; userPicked: boolean; bucket: string }
  spend: { bucket: string; by: string } // total-spend detail controls
  sm: { bucket: string; by: string } // sessions detail controls
  // operational detail: one shared bucket, plus a per-graph "break down by name"
  // flag (the three graphs — tool calls, error rate, skill usage — each toggle independently)
  ops: { bucket: string; by: Record<string, boolean> }
  ac: { items: any[]; sel: number } // artifact-search typeahead state
  sessTime: SessTime // sessions-list time window (default 30d)
}

export var state: ClientState = {
  artKind: 'feature', overview: null, filters: {}, facets: [], dist: {}, measures: [],
  metric: null,
  outcomeTypes: [],
  days: 7,
  // bucket '' = auto-derive from the window (bucketForWindow); a manual pick
  // overrides until the window changes. Uniform across every expansion.
  sr: { outcomes: ['session_success'], bucket: '', by: '' },
  ca: { kind: 'feature', defaultKind: 'feature', userPicked: false, bucket: '' },
  spend: { bucket: '', by: '' },
  sm: { bucket: '', by: '' },
  ops: { bucket: '', by: { tool_calls: true, error_rate: true, skill_usage: true } },
  ac: { items: [], sel: -1 },
  sessTime: { preset: 30, from: '', to: '' }
};

// The success-rate detail controls persist across reloads: the user's "what
// counts as success" (and the breakdown) becomes their default until they change
// it again. Stored client-side, so the windowed KPI passes the same outcomes to
// the server to stay consistent (see loadKpis). Bucket is intentionally NOT
// persisted — it auto-derives from the window.
var SR_PREFS_KEY = 'aivue.sr';
function loadSrPrefs() {
  try {
    var saved = JSON.parse(localStorage.getItem(SR_PREFS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (Array.isArray(saved.outcomes)) state.sr.outcomes = saved.outcomes.filter(function (x) { return typeof x === 'string'; });
    if (typeof saved.by === 'string') state.sr.by = saved.by;
  } catch (e) { /* malformed or unavailable storage → keep defaults */ }
}
export function saveSrPrefs() {
  try { localStorage.setItem(SR_PREFS_KEY, JSON.stringify({ outcomes: state.sr.outcomes, by: state.sr.by })); } catch (e) { /* ignore */ }
}
loadSrPrefs();

export function $(s) { return document.querySelector(s); }
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
export function usd(n) { return '$' + (Number(n) || 0).toFixed(2); }
export function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
export function get(url) { return fetch(url).then(function (r) { return r.json(); }); }
export function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
}
export function dayOf(s) { return s ? String(s).slice(0, 10) : ''; }

export function badge(v) {
  var c = v === 'success' ? 'b-success' : v === 'partial' ? 'b-partial' : v === 'failure' ? 'b-failure' : v ? 'b-unknown' : 'b-null';
  return '<span class="badge ' + c + '">' + esc(v || '—') + '</span>';
}

export function grainOfSrc(src) { return src === 'usage' ? 'usage' : src === 'tool-call' ? 'tool_call' : src === 'block' ? 'block' : 'session'; }

export function fmtVal(v, format) {
  if (v == null) return '—';
  if (format === 'usd') return usd(v);
  if (format === 'pct') return Math.round(v * 100) + '%';
  return num(Math.round(v));
}

// Format a composite breakdown key (a ", "-joined value set) for display: a
// multi-value set is truncated to the first few members + "+N", with the full
// set kept for the title/tooltip. Single values and the synthetic
// "(none)"/"Other" labels pass through unchanged. Shared by the outcome and
// session-count breakdown charts.
export function comboLabel(key) {
  if (key === '(none)' || key === 'Other') return { text: key, full: key };
  var parts = String(key).split(', ');
  if (parts.length <= 1) return { text: key, full: key };
  var MAX = 3, shown = parts.slice(0, MAX).join(', ');
  if (parts.length > MAX) shown += ' +' + (parts.length - MAX);
  return { text: shown, full: parts.join(', ') };
}

export var SR_PALETTE = ['#0f7a55', '#b8860b', '#b4452f', '#3b6ea5', '#7d5ba6', '#1b8a8a', '#a65c2e', '#6b8e23'];

// Canonical outcome display order: concrete shipped artifacts first, softening
// down to the LLM-judged catch-all. Shared by the success-rate "Count as success"
// picker and the sessions Outcomes column so they read consistently. Types not
// listed sort to the end (preserving their relative order).
export var OUTCOME_ORDER = ['pr_merged', 'pr_created', 'commit_pushed', 'file_written', 'session_success'];
export function outcomeRank(type) { var i = OUTCOME_ORDER.indexOf(type); return i < 0 ? OUTCOME_ORDER.length : i; }

// Friendly display for an outcome type in selection UIs (success-rate picker,
// the sessions Outcome filter, active chips). The LLM-judged signal keeps its
// snake_case token (consistent with git-derived outcomes like pr_merged) and
// adds a "(LLM Judged)" cue; every other type shows its raw token unchanged.
export function outcomeLabel(type) {
  return type === 'session_success' ? 'session_success (LLM Judged)' : type;
}

// A delta badge comparing this window's value to the prior window's. mode:
// 'points' for rates (absolute percentage-point change), 'rel' for everything
// else (relative % change). good = which direction is favorable ('up'|'down'):
// the change is green when favorable, red when not. good=null marks a neutral
// metric (spend/sessions) with no better/worse direction — its change shows in
// the brand green (the accent) rather than greyed out, to match the other tiles.
export function kpiDelta(cur, prev, mode, good) {
  if (cur == null || prev == null) return '';
  var diff;
  var text;
  if (mode === 'points') {
    diff = (cur - prev) * 100;
    if (Math.abs(diff) < 0.05) return '<span class="delta flat">±0pp</span>';
    text = (diff > 0 ? '+' : '') + diff.toFixed(1) + 'pp';
  } else {
    if (!prev) return ''; // no baseline to divide by
    diff = ((cur - prev) / Math.abs(prev)) * 100;
    if (Math.abs(diff) < 0.5) return '<span class="delta flat">±0%</span>';
    text = (diff > 0 ? '+' : '') + Math.round(diff) + '%';
  }
  var dir = diff > 0 ? 'up' : 'down';
  var cls = good == null ? 'good' : (dir === good ? 'good' : 'bad');
  var arrow = diff > 0 ? '▲' : '▼';
  return '<span class="delta ' + cls + '">' + arrow + ' ' + esc(text) + '</span>';
}

// ---- window + bucket helpers (shared by every KPI expansion) ----------------

// An appropriate curve granularity for the selected window: fine buckets for
// short spans, coarse for long ones, so charts stay readable.
export function bucketForWindow(days) {
  if (days === 'all') return 'month';
  if (days <= 31) return 'day';
  if (days <= 180) return 'week';
  return 'month';
}

// The effective bucket for an expansion: the user's manual pick ('' = none), or
// the window-derived default. Manual picks are cleared on window change.
export function autoBucket(b) { return b || bucketForWindow(state.days); }

// Query fragment ('&from=…&to=…') pinning an expansion's data to the selected
// window; '' for the all-time window. Appended to an already-non-empty query.
export function windowQs() {
  if (state.days === 'all') return '';
  var span = state.days * 86400000, now = Date.now();
  return '&from=' + encodeURIComponent(new Date(now - span).toISOString()) +
    '&to=' + encodeURIComponent(new Date(now).toISOString());
}
