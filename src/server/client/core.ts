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
  preset: 7 | 14 | 30 | 90 | 'all' | 'custom'
  from: string // ISO date (yyyy-mm-dd) for custom range
  to: string
}

export interface ClientState {
  // The top-level tab the app is showing. Mirrored into the URL hash by the
  // router; setView() keeps it in step with the DOM.
  view: 'highlights' | 'dashboard' | 'artifacts' | 'sessions'
  // The session whose detail drawer is open (null = drawer closed). Mirrored into
  // the URL as `?session=<id>` so a session is shareable / reload-survivable.
  open: string | null
  artKind: string
  overview: any
  home: any // Explore (question-led) stats; null until fetched
  asked: any // the question the user clicked through from, for the grounding banner (null = none)
  filters: Partial<SessionFilters> // starts {}, filled in by applyFilters()
  facets: any[]
  dist: Record<string, any[]>
  measures: any[]
  metric: string | null // which headline KPI's detail view is open (null = overview)
  outcomeTypes: any[]
  days: number | 'all' // top-level KPI window (drives the whole headline row + cost-artifact curves)
  sr: { outcomes: string[]; bucket: string; by: string; filters: Record<string, string[]> } // success-rate detail controls
  // cost-per-artifact detail controls. `kind` follows defaultKind until the user
  // toggles it (userPicked), after which it sticks and the headline tile mirrors
  // it. `bucket` is the curve granularity: '' = auto-derived from the window;
  // a manual pick overrides until the window changes.
  ca: { kind: string; defaultKind: string; userPicked: boolean; bucket: string; complexity: string }
  spend: { bucket: string; by: string; filters: Record<string, string[]> } // total-spend detail controls
  sm: { bucket: string; by: string; filters: Record<string, string[]> } // sessions detail controls
  // operational detail: one shared bucket, a per-graph "break down by" choice
  // ('' | 'name' | 'error_category'), and row-level scopes for the error-rate
  // chart (tool names + error categories — ops-specific, not the shared facets).
  ops: { bucket: string; tab: string; by: Record<string, string>; filters: { toolNames: string[]; errorCategories: string[] } }
  ac: { items: any[]; sel: number } // artifact-search typeahead state
  sessTime: SessTime // sessions-list time window (default 30d)
  // Artifacts tab list controls (PRs/Features table): free-text search + the PR
  // table's column sort. Mirrored into the URL so a filtered/sorted table is a
  // shareable, reload-survivable link. Reset when switching kind (feature ↔ pr).
  art: { q: string; sort: string; dir: string }
}

export var state: ClientState = {
  view: 'dashboard', open: null,
  artKind: 'feature', overview: null, home: null, asked: null, filters: {}, facets: [], dist: {}, measures: [],
  metric: null,
  outcomeTypes: [],
  days: 7,
  // bucket '' = auto-derive from the window (bucketForWindow); a manual pick
  // overrides until the window changes. Uniform across every expansion.
  sr: { outcomes: ['session_success'], bucket: '', by: '', filters: {} },
  ca: { kind: 'feature', defaultKind: 'feature', userPicked: false, bucket: '', complexity: '' },
  spend: { bucket: '', by: '', filters: {} },
  sm: { bucket: '', by: '', filters: {} },
  ops: { bucket: '', tab: 'tools', by: { tool_calls: 'name', error_rate: 'name', skill_usage: 'name' }, filters: { toolNames: [], errorCategories: [] } },
  ac: { items: [], sel: -1 },
  sessTime: { preset: 30, from: '', to: '' },
  art: { q: '', sort: 'created', dir: 'desc' }
};

// The success-rate detail controls persist across reloads: the user's "what
// counts as success" (and the breakdown) becomes their default until they change
// it again. Stored client-side, so the windowed KPI passes the same outcomes to
// the server to stay consistent (see loadKpis). Bucket is intentionally NOT
// persisted — it auto-derives from the window.
var SR_PREFS_KEY = 'tuneloop.sr';
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
// Minimal, safe Markdown → HTML for assistant message text. Escape-first by
// construction: fenced/inline code is pulled out to placeholders, everything
// else is HTML-escaped (so no raw HTML from the transcript is ever rendered),
// then a small set of block/inline rules are applied. Covers the common cases
// (headings, lists, blockquotes, bold/italic, inline + fenced code, links);
// imperfect on exotic nesting, which is fine for a transcript viewer.
export function renderMd(src) {
  var text = String(src == null ? '' : src);
  var codes = [], inls = [];
  // Private-use sentinel delimiting code placeholders. Never appears in real
  // text, survives esc(), and is stripped by restore(). (A literal char, not a
  // NUL byte, so the file stays text and diffs render.)
  var Z = String.fromCharCode(0xe000);
  // Fenced code blocks first, so their contents are never treated as markdown.
  text = text.replace(/```[ \t]*[\w+-]*\n?([\s\S]*?)```/g, function (_m, code) {
    codes.push('<pre class="md-code"><code>' + esc(code.replace(/\n+$/, '')) + '</code></pre>');
    return Z + 'C' + (codes.length - 1) + Z;
  });
  // Inline code next (single line), so emphasis rules don't touch it.
  text = text.replace(/`([^`\n]+)`/g, function (_m, code) {
    inls.push('<code>' + esc(code) + '</code>');
    return Z + 'I' + (inls.length - 1) + Z;
  });

  var inline = function (s) {
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // [text](url) — only http/https/relative/anchor hrefs (esc turned & into &amp;).
    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^\s)]+)\)/g, function (_m, label, href) {
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return s;
  };
  var restore = function (s) {
    return s
      .replace(new RegExp(Z + 'C(\\d+)' + Z, 'g'), function (_m, i) { return codes[Number(i)]; })
      .replace(new RegExp(Z + 'I(\\d+)' + Z, 'g'), function (_m, i) { return inls[Number(i)]; });
  };

  var lines = text.split('\n');
  var out = [], i = 0;
  var flushPara = function (buf) { if (buf.length) out.push('<p>' + buf.map(inline).join('<br>') + '</p>'); };
  while (i < lines.length) {
    var line = lines[i];
    var cb = line.trim().match(new RegExp('^' + Z + 'C(\\d+)' + Z + '$'));
    if (cb) { out.push(codes[Number(cb[1])]); i++; continue; }
    if (!line.trim()) { i++; continue; }
    var h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { var lvl = h[1].length; out.push('<div class="md-h md-h' + lvl + '">' + inline(h[2]) + '</div>'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      var q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      var ul = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; }
      out.push('<ul>' + ul.join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { ol.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; }
      out.push('<ol>' + ol.join('') + '</ol>');
      continue;
    }
    var para = [];
    while (i < lines.length && lines[i].trim() && !new RegExp('^' + Z + 'C\\d+' + Z + '$').test(lines[i].trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    flushPara(para);
  }
  return restore(out.join(''));
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
// set kept for the title/tooltip. Single values and the synthetic "(none)"
// placeholder pass through unchanged. The top-K rollup key "Other" is relabeled
// to "... other values" so it can't be mistaken for a real value named "other"
// (the legend's "Show all" link expands it). Shared by the outcome and
// session-count breakdown charts.
export function comboLabel(key) {
  if (key === '(none)') return { text: key, full: key };
  if (key === 'Other') return { text: '... other values', full: '... other values' };
  var parts = String(key).split(', ');
  if (parts.length <= 1) return { text: key, full: key };
  var MAX = 3, shown = parts.slice(0, MAX).join(', ');
  if (parts.length > MAX) shown += ' +' + (parts.length - MAX);
  return { text: shown, full: parts.join(', ') };
}

export var SR_PALETTE = ['#0f7a55', '#b8860b', '#b4452f', '#3b6ea5', '#7d5ba6', '#1b8a8a', '#a65c2e', '#6b8e23'];

// Complexity bucket → display label. One source of truth shared by the Cost-by-
// Artifact filter buttons and the headline KPI subtext, so they always agree.
export var CX_LABELS: Record<string, string> = {
  trivial: 'Trivial', small: 'Simple', medium: 'Moderate', large: 'Complex', xl: 'Highly Complex', none: 'Not tagged',
};
// Comma-joined bucket keys → "Trivial, Simple" (preserving selection order).
export function cxLabelList(keys: string) {
  return (keys || '').split(',').filter(Boolean).map(function (k) { return CX_LABELS[k] || k; }).join(', ');
}
// A single artifact's complexity → its bucket label. Features carry an ordinal
// (1–5, user-tagged); PRs carry a diff-size churn (line count) bucketed by the
// same ranges as the Cost-by-Artifact filter. Null/untagged → '' (no label).
var CX_ORDINAL = ['', 'trivial', 'small', 'medium', 'large', 'xl'];
export function complexityLabel(kind: string, complexity: number | null | undefined) {
  if (complexity == null) return '';
  if (kind === 'feature') return CX_LABELS[CX_ORDINAL[complexity]] || '';
  var n = Number(complexity);
  var key = n <= 10 ? 'trivial' : n <= 100 ? 'small' : n <= 500 ? 'medium' : n <= 1500 ? 'large' : 'xl';
  return CX_LABELS[key];
}

// Canonical outcome display order: concrete shipped artifacts first, softening
// down to the LLM-judged catch-all. Shared by the success-rate "Count as success"
// picker and the sessions Outcomes column so they read consistently. Types not
// listed sort to the end (preserving their relative order).
export var OUTCOME_ORDER = ['pr_merged', 'pr_created', 'pr_contributed', 'pr_approved', 'pr_changes_requested', 'pr_reviewed', 'commit_pushed', 'file_written', 'session_success'];
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
