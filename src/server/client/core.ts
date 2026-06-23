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
  sr: { outcomes: string[]; bucket: string; by: string } // success-rate detail controls
  ca: { kind: string; days: number | 'all'; bucket: string; defaultKind: string } // cost-per-artifact detail controls
  spend: { bucket: string; by: string } // total-spend detail controls
  sm: { bucket: string; by: string } // sessions detail controls
  ops: { view: string; bucket: string; by: boolean } // operational detail controls
  ac: { items: any[]; sel: number } // artifact-search typeahead state
}

export var state: ClientState = {
  artKind: 'feature', overview: null, filters: {}, facets: [], dist: {}, measures: [],
  metric: null,
  outcomeTypes: [],
  sr: { outcomes: ['session_success'], bucket: 'week', by: '' },
  ca: { kind: 'feature', days: 7, bucket: 'week', defaultKind: 'feature' },
  spend: { bucket: 'week', by: '' },
  sm: { bucket: 'week', by: '' },
  ops: { view: 'error_rate', bucket: 'week', by: false },
  ac: { items: [], sel: -1 }
};

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

export function grainOfSrc(src) { return src === 'usage' ? 'usage' : src === 'tool-call' ? 'tool_call' : 'session'; }

export function fmtVal(v, format) {
  if (v == null) return '—';
  if (format === 'usd') return usd(v);
  if (format === 'pct') return Math.round(v * 100) + '%';
  return num(Math.round(v));
}

export var SR_PALETTE = ['#0f7a55', '#b8860b', '#b4452f', '#3b6ea5', '#7d5ba6', '#1b8a8a', '#a65c2e', '#6b8e23'];

// A delta badge comparing this window's value to the prior window's. mode:
// 'points' for rates (absolute percentage-point change), 'rel' for everything
// else (relative % change). good = which direction is favorable ('up'|'down'),
// or null for neutral metrics (spend/sessions) which show the change uncolored.
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
  var cls = good == null ? 'flat' : (dir === good ? 'good' : 'bad');
  var arrow = diff > 0 ? '▲' : '▼';
  return '<span class="delta ' + cls + '">' + arrow + ' ' + esc(text) + '</span>';
}
