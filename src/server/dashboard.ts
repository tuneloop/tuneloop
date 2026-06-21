/**
 * The dashboard SPA, inlined as a string so it bundles into dist with no asset
 * paths and no build step. Vanilla JS + CSS + hand-rolled SVG charts; it reads
 * the JSON API (see http.ts). Client JS deliberately avoids template literals so
 * it can live inside this template literal without escaping.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>aivue</title>
<style>
  :root {
    --bg: #f5f3ee; --paper: #fffdf9; --ink: #1b1a17; --muted: #79746b;
    --line: #e6e1d6; --track: #ece7dc; --emerald: #0f7a55;
    --amber: #b8860b; --red: #b4452f; --gray: #9a958b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; }
  a { color: var(--emerald); }
  .top {
    background: var(--ink); color: #f3efe6; padding: 14px 28px;
    display: flex; align-items: center; gap: 14px;
  }
  .top .brand { font-family: Georgia, serif; font-size: 22px; font-weight: 600; letter-spacing: .2px; }
  .top .tag { color: #b8b2a4; font-size: 13px; font-style: italic; }
  .top .meta { margin-left: auto; text-align: right; color: #b8b2a4; font-size: 12px; }
  .tabnav { border-bottom: 1px solid var(--line); background: var(--paper); }
  .tabnav .inner { max-width: 1180px; margin: 0 auto; padding: 0 28px; display: flex; gap: 2px; }
  .tab { border: 0; background: transparent; padding: 14px 18px; font-family: Georgia, serif; font-size: 15px; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--ink); }
  .tab.on { color: var(--ink); border-bottom-color: var(--emerald); }
  .view { display: none; }
  .view.on { display: block; }
  main { max-width: 1180px; margin: 0 auto; padding: 28px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
  .tile { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .tile .label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .tile .value { font-family: ui-monospace, Menlo, monospace; font-size: 26px; margin-top: 6px; }
  .tile .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin-top: 22px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .panel-head h2 { margin: 0; font-size: 18px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: var(--paper); padding: 5px 12px; cursor: pointer; font-size: 13px; color: var(--muted); }
  .seg button.on { background: var(--ink); color: #f3efe6; }
  .dist-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 22px; }
  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .card h3 { margin: 0 0 12px; font-size: 14px; }
  .bar-row { display: grid; grid-template-columns: 130px 1fr 42px; align-items: center; gap: 10px; margin: 7px 0; font-size: 13px; }
  .bar-row .name { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: var(--track); border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill { display: block; background: var(--emerald); height: 100%; }
  .bar-row .n { text-align: right; color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .empty { color: var(--muted); font-size: 13px; font-style: italic; }
  .btn { border: 1px solid var(--line); background: var(--paper); color: var(--ink); border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .btn:hover { border-color: var(--emerald); color: var(--emerald); }
  .btn.danger:hover { border-color: var(--red); color: var(--red); }
  .feat-new { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .feat-new input { flex: 1; min-width: 220px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; background: var(--paper); color: var(--ink); }
  .feat-new select { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; background: var(--paper); color: var(--ink); }
  .feat-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .feat-name { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
  .feat-name .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .feat-name .nm:hover { color: var(--emerald); }
  .feat-twig { color: var(--muted); }
  .feat-meta { color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: nowrap; }
  .feat-actions { display: flex; align-items: center; gap: 6px; }
  .feat-actions select { border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font-size: 11px; background: var(--paper); color: var(--ink); max-width: 150px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .filters select, .filters input {
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; background: var(--paper); color: var(--ink);
  }
  .filters input { flex: 1; min-width: 180px; }
  .ex-ctrl { display: inline-flex; align-items: center; gap: 8px; }
  .ex-ctrl select { border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; font-size: 13px; background: var(--paper); color: var(--ink); }
  .ex-ctrl .by { color: var(--muted); font-size: 13px; }
  .card-note { color: var(--muted); font-size: 11px; font-style: italic; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr.srow:hover { background: #fbf8f1; cursor: pointer; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .b-success { background: #e2f0e8; color: var(--emerald); }
  .b-partial { background: #f6ecd2; color: var(--amber); }
  .b-failure { background: #f4ddd6; color: var(--red); }
  .b-unknown, .b-null { background: #ece9e1; color: var(--gray); }
  .tag { display: inline-block; background: var(--track); color: var(--muted); border-radius: 4px; padding: 1px 6px; font-size: 11px; margin: 1px 3px 1px 0; }
  .tag.click { cursor: pointer; }
  .tag.click:hover { background: #dfe9e0; color: var(--emerald); }
  .num { font-family: ui-monospace, Menlo, monospace; }
  svg text { font-family: ui-monospace, Menlo, monospace; font-size: 10px; fill: var(--muted); }
  .overlay { position: fixed; inset: 0; background: rgba(20,18,15,.4); opacity: 0; pointer-events: none; transition: opacity .15s; }
  .overlay.on { opacity: 1; pointer-events: auto; }
  .drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(640px, 94vw); background: var(--bg); border-left: 1px solid var(--line); transform: translateX(100%); transition: transform .18s ease; overflow-y: auto; z-index: 10; }
  .drawer.on { transform: translateX(0); }
  .drawer-inner { padding: 22px 24px 60px; }
  .drawer h2 { margin: 0 8px 4px 0; font-size: 19px; }
  .x { float: right; border: 1px solid var(--line); background: var(--paper); border-radius: 8px; padding: 4px 10px; cursor: pointer; color: var(--muted); }
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; font-size: 13px; margin: 14px 0; }
  .kv .k { color: var(--muted); }
  .turn { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--paper); }
  .turn .role { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 5px; }
  .turn.user .role { color: var(--emerald); }
  .turn .text { white-space: pre-wrap; font-size: 13px; }
  .turn .tools { margin-top: 8px; }
  .tool-chip { display: inline-block; font-family: ui-monospace, Menlo, monospace; font-size: 11px; background: var(--track); border-radius: 5px; padding: 1px 7px; margin: 2px 4px 2px 0; }
  .tool-chip.err { background: #f4ddd6; color: var(--red); }
  .sect-h { font-family: Georgia, serif; font-size: 14px; margin: 18px 0 6px; }
</style>
</head>
<body>
<header class="top">
  <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M 23.5 11 A 8.5 8.5 0 1 0 24.5 16" fill="none" stroke="#10b981" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M 24.5 8.5 L 24.5 12.5 L 20.5 12.5" fill="none" stroke="#10b981" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <span class="brand">aivue</span>
  <span class="tag">outcomes, not tokens</span>
  <span class="meta" id="meta"></span>
</header>
<nav class="tabnav"><div class="inner">
  <button class="tab on" data-view="dashboard">Dashboard</button>
  <button class="tab" data-view="artifacts">Artifacts</button>
  <button class="tab" data-view="sessions">Sessions</button>
</div></nav>
<main>
  <section id="view-dashboard" class="view on">
    <section id="kpis" class="tiles"></section>
    <section id="tiles" class="tiles"></section>
    <section class="panel">
      <div class="panel-head"><h2>Spend over time</h2><div class="seg" id="bucketSeg"></div></div>
      <div id="chart"></div>
    </section>
    <section id="measure-cards" class="dist-grid"></section>
    <section class="panel">
      <div class="panel-head"><h2>Breakdown explorer</h2>
        <div class="ex-ctrl">
          <select id="ex-measure"></select><span class="by">by</span><select id="ex-by"></select>
        </div>
      </div>
      <div id="explorer"></div>
    </section>
    <section id="dists" class="dist-grid"></section>
  </section>
  <section id="view-artifacts" class="view">
    <section class="panel">
      <div class="panel-head"><h2>Artifacts</h2><div class="seg" id="artKindSeg"></div></div>
      <div id="artifacts"></div>
      <div class="empty" style="margin-top:10px">Cost is the fully-loaded cost of every session linked to each artifact. A session that contributed to several artifacts is counted under each, so this column can exceed total spend.</div>
    </section>
  </section>
  <section id="view-sessions" class="view">
    <section class="panel">
      <div class="panel-head"><h2>Sessions</h2></div>
      <div id="filters" class="filters"></div>
      <div id="sessions"></div>
    </section>
  </section>
</main>
<div class="overlay" id="overlay"></div>
<div class="drawer" id="drawer"><div class="drawer-inner"><button class="x" id="drawerClose">close</button><div id="drawerBody"></div></div></div>
<script>
var state = { bucket: 'week', artKind: 'pr', overview: null, filters: {}, facets: [], dist: {}, measures: [] };

function $(s) { return document.querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function usd(n) { return '$' + (Number(n) || 0).toFixed(2); }
function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
function get(url) { return fetch(url).then(function (r) { return r.json(); }); }
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
}
function dayOf(s) { return s ? String(s).slice(0, 10) : ''; }

function badge(v) {
  var c = v === 'success' ? 'b-success' : v === 'partial' ? 'b-partial' : v === 'failure' ? 'b-failure' : v ? 'b-unknown' : 'b-null';
  return '<span class="badge ' + c + '">' + esc(v || '—') + '</span>';
}

function bars(rows, keyName) {
  if (!rows || !rows.length) return '<div class="empty">No data yet.</div>';
  var max = 0;
  rows.forEach(function (r) { if (r.count > max) max = r.count; });
  return rows.map(function (r) {
    var pct = max ? Math.round((r.count / max) * 100) : 0;
    var label = r[keyName] == null ? '—' : r[keyName];
    return '<div class="bar-row"><span class="name" title="' + esc(label) + '">' + esc(label) +
      '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="n">' + r.count + '</span></div>';
  }).join('');
}

function renderTiles(o) {
  var range = o.firstAt && o.lastAt ? dayOf(o.firstAt) + ' → ' + dayOf(o.lastAt) : '';
  // Cost-per-shipped-artifact lives in the headline KPI row (#kpis); these are operational stats.
  var tiles = [
    { label: 'Sessions', value: num(o.sessions), sub: range },
    { label: 'Total spend', value: usd(o.costUsd), sub: '' },
    { label: 'Tokens', value: num(o.tokens), sub: '' },
    { label: 'Analysis spend', value: usd(o.analysisCostUsd), sub: 'enrichment' }
  ];
  $('#tiles').innerHTML = tiles.map(function (t) {
    return '<div class="tile"><div class="label">' + esc(t.label) + '</div><div class="value">' +
      t.value + '</div><div class="sub">' + esc(t.sub) + '</div></div>';
  }).join('');
}

// Fetch the facet registry + a distribution for every chart/filter facet, so
// dist cards and filters are driven by the registry, not a hardcoded list.
function loadFacets() {
  return get('/api/facets').then(function (facets) {
    state.facets = facets || [];
    var need = {};
    state.facets.forEach(function (f) {
      var roles = f.roles || [];
      if (roles.indexOf('chart') >= 0 || roles.indexOf('filter') >= 0) need[f.key] = 1;
    });
    state.dist = {};
    return Promise.all(Object.keys(need).map(function (k) {
      return get('/api/distribution?facet=' + encodeURIComponent(k)).then(function (d) { state.dist[k] = d || []; });
    }));
  });
}

function renderDists(o) {
  var cards = [];
  state.facets.forEach(function (f) {
    if ((f.roles || []).indexOf('chart') < 0) return;
    var d = state.dist[f.key] || [];
    if (!d.length) return; // skip empty facets (e.g. repo before it resolves)
    cards.push('<div class="card"><h3>' + esc(f.label || f.key) + '</h3>' + bars(d.slice(0, 15), 'value') + '</div>');
  });
  // Non-facet cards (events / tool calls) still come from the overview.
  if (o.outcomes && o.outcomes.length) cards.push('<div class="card"><h3>Outcomes</h3>' + bars(o.outcomes, 'type') + '</div>');
  var tools = (o.topTools || []).map(function (t) { return { value: t.name, count: t.calls }; });
  if (tools.length) cards.push('<div class="card"><h3>Top tools</h3>' + bars(tools, 'value') + '</div>');
  $('#dists').innerHTML = cards.join('');
}

// ---- measures: default cards (Stage B) + explorer (Stage C) + headline KPIs ----

var MEASURE_CARDS = [
  { measure: 'cost', by: 'model' },
  { measure: 'cost', by: 'repo' },
  { measure: 'cost', by: 'use_case', note: 'Sessions can span multiple use cases, so buckets sum to more than total spend.' },
  { measure: 'success_rate', by: 'complexity' }
];

function grainOfSrc(src) { return src === 'usage' ? 'usage' : src === 'tool-call' ? 'tool_call' : 'session'; }

function fmtVal(v, format) {
  if (v == null) return '—';
  if (format === 'usd') return usd(v);
  if (format === 'pct') return Math.round(v * 100) + '%';
  return num(Math.round(v));
}

// Bars for a breakdown ({bucket,value}), value formatted per the measure.
// Rates (pct) draw on a fixed 0-100% scale (the value is already a fraction);
// magnitudes draw relative to the largest bucket (sum/share-of-total doesn't
// generalize — multi-valued facets overlap, so buckets don't sum to a whole).
function measureBars(rows, format) {
  if (!rows || !rows.length) return '<div class="empty">No data.</div>';
  var absolute = format === 'pct';
  var max = 0;
  if (!absolute) rows.forEach(function (r) { var v = Math.abs(r.value || 0); if (v > max) max = v; });
  return rows.map(function (r) {
    var v = Math.abs(r.value || 0);
    var pct = absolute ? Math.min(100, Math.round(v * 100)) : (max ? Math.round((v / max) * 100) : 0);
    var label = r.bucket == null ? '—' : r.bucket;
    return '<div class="bar-row"><span class="name" title="' + esc(label) + '">' + esc(label) +
      '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="n">' + esc(fmtVal(r.value, format)) + '</span></div>';
  }).join('');
}

function measureBy(key) { for (var i = 0; i < state.measures.length; i++) if (state.measures[i].key === key) return state.measures[i]; return null; }
function facetByKey(key) { for (var i = 0; i < state.facets.length; i++) if (state.facets[i].key === key) return state.facets[i]; return null; }

function loadMeasures() {
  return get('/api/measures').then(function (m) {
    state.measures = m || [];
    renderMeasureCards();
    buildExplorer();
  });
}

function renderMeasureCards() {
  Promise.all(MEASURE_CARDS.map(function (c) {
    return get('/api/breakdown?measure=' + encodeURIComponent(c.measure) + '&by=' + encodeURIComponent(c.by))
      .then(function (d) { return { c: c, d: d }; });
  })).then(function (results) {
    $('#measure-cards').innerHTML = results.map(function (rr) {
      var c = rr.c, d = rr.d;
      if (!d || d.error || !d.rows || !d.rows.length) return '';
      var mm = measureBy(c.measure), ff = facetByKey(c.by);
      var title = (mm ? (mm.label || mm.key) : c.measure) + ' by ' + (ff ? (ff.label || ff.key) : c.by);
      var note = c.note ? '<div class="card-note">' + esc(c.note) + '</div>' : '';
      return '<div class="card"><h3>' + esc(title) + '</h3>' + measureBars(d.rows.slice(0, 15), mm ? mm.format : null) + note + '</div>';
    }).join('');
  });
}

// Facets valid to break the selected measure by (grain guard: same grain or session).
function explorerFacets() {
  var m = measureBy($('#ex-measure').value);
  if (!m) return [];
  var gm = grainOfSrc(m.source);
  return state.facets.filter(function (f) {
    var roles = f.roles || [];
    if (roles.indexOf('chart') < 0 && roles.indexOf('filter') < 0) return false;
    var gf = grainOfSrc(f.source);
    return gf === gm || gf === 'session';
  });
}

function buildExplorer() {
  var ms = $('#ex-measure');
  ms.innerHTML = state.measures.map(function (m) {
    return '<option value="' + esc(m.key) + '">' + esc(m.label || m.key) + '</option>';
  }).join('');
  ms.onchange = function () { syncExplorerBy(); runExplorer(); };
  syncExplorerBy();
  $('#ex-by').onchange = runExplorer;
  runExplorer();
}

function syncExplorerBy() {
  var opts = '<option value="">total</option>';
  explorerFacets().forEach(function (f) { opts += '<option value="' + esc(f.key) + '">' + esc(f.label || f.key) + '</option>'; });
  $('#ex-by').innerHTML = opts;
}

function runExplorer() {
  var mk = $('#ex-measure').value, by = $('#ex-by').value, m = measureBy(mk);
  var url = '/api/breakdown?measure=' + encodeURIComponent(mk) + (by ? '&by=' + encodeURIComponent(by) : '');
  get(url).then(function (d) {
    var box = $('#explorer');
    if (!d || d.error) { box.innerHTML = '<div class="empty">' + esc(d && d.error ? d.error : 'No data.') + '</div>'; return; }
    var fmt = m ? m.format : null;
    if (!by) {
      box.innerHTML = '<div class="tile" style="max-width:260px"><div class="label">' +
        esc(m ? (m.label || m.key) : mk) + '</div><div class="value">' + esc(fmtVal(d.total, fmt)) + '</div></div>';
    } else {
      box.innerHTML = measureBars((d.rows || []).slice(0, 20), fmt);
    }
  });
}

function kpiVal(k) { return k && k.costPerUnit != null ? usd(k.costPerUnit) : '—'; }
function kpiSub(k, noun) { return k ? (k.count + ' ' + noun + ' shipped') : ''; }

function loadKpis() {
  Promise.all([get('/api/kpi'), get('/api/breakdown?measure=success_rate')]).then(function (res) {
    var kpi = res[0] || {}, sr = res[1] || {};
    var rate = (sr.rows && sr.rows[0]) ? sr.rows[0].value : null;
    var tiles = [
      { label: 'Session success rate', value: fmtVal(rate, 'pct'), sub: 'judged outcome' },
      { label: 'Cost / shipped feature', value: kpiVal(kpi.feature), sub: kpiSub(kpi.feature, 'features') },
      { label: 'Cost / merged PR', value: kpiVal(kpi.pr), sub: kpiSub(kpi.pr, 'PRs') }
    ];
    $('#kpis').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="label">' + esc(t.label) + '</div><div class="value">' +
        esc(t.value) + '</div><div class="sub">' + esc(t.sub) + '</div></div>';
    }).join('');
  });
}

function renderChart(points) {
  var box = $('#chart');
  if (!points || !points.length) { box.innerHTML = '<div class="empty">No sessions in range.</div>'; return; }
  var W = 920, H = 200, pad = 28;
  var maxSpend = 0;
  points.forEach(function (p) { if (p.spend > maxSpend) maxSpend = p.spend; });
  maxSpend = maxSpend || 1;
  var bw = (W - 2 * pad) / points.length;
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  svg += '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" stroke="#e6e1d6"/>';
  svg += '<text x="' + pad + '" y="14">' + usd(maxSpend) + '</text>';
  var step = Math.ceil(points.length / 9);
  points.forEach(function (p, i) {
    var x = pad + i * bw;
    var h = (p.spend / maxSpend) * (H - 2 * pad);
    var y = H - pad - h;
    var w = Math.max(2, bw - 4);
    var tip = p.bucket + ': ' + usd(p.spend) + ', ' + p.sessions + ' sessions' + (p.shipped ? ', ' + p.shipped + ' shipped' : '');
    svg += '<rect x="' + (x + 2) + '" y="' + y + '" width="' + w + '" height="' + Math.max(0, h) + '" rx="2" fill="#0f7a55"><title>' + esc(tip) + '</title></rect>';
    if (p.shipped) svg += '<circle cx="' + (x + bw / 2) + '" cy="' + (y - 6) + '" r="3" fill="#b8860b"><title>' + esc(p.shipped + ' shipped') + '</title></circle>';
    if (i % step === 0) svg += '<text x="' + (x + bw / 2) + '" y="' + (H - pad + 13) + '" text-anchor="middle">' + esc(p.bucket) + '</text>';
  });
  svg += '</svg>';
  box.innerHTML = svg;
}

function renderBucketSeg() {
  var opts = ['day', 'week', 'month'];
  $('#bucketSeg').innerHTML = opts.map(function (b) {
    return '<button class="' + (b === state.bucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  Array.prototype.forEach.call($('#bucketSeg').children, function (btn) {
    btn.onclick = function () { state.bucket = btn.getAttribute('data-b'); renderBucketSeg(); loadChart(); };
  });
}

function buildFilters() {
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
    '<input id="f-artifact" placeholder="file path / PR # / feature" />' +
    '<input id="f-q" placeholder="search title / intent" />';
  $('#filters').innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('.facet-filter'), function (s) { s.onchange = applyFilters; });
  $('#f-artKind').onchange = applyFilters;
  var t;
  $('#f-q').oninput = function () { clearTimeout(t); t = setTimeout(applyFilters, 250); };
  var t2;
  $('#f-artifact').oninput = function () { clearTimeout(t2); t2 = setTimeout(applyFilters, 250); };
}

function applyFilters() {
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

function renderSessions(rows) {
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

function openDetail(id) {
  get('/api/session?id=' + encodeURIComponent(id)).then(function (d) {
    if (!d || d.error) return;
    var s = d.session, a = d.annotations || {};
    var uc = Array.isArray(a.use_case) ? a.use_case.join(', ') : '';
    var html = '<h2>' + esc(s.title || '(untitled)') + '</h2>';
    html += '<div class="kv">';
    html += '<span class="k">when</span><span class="num">' + esc(dayOf(s.startedAt)) + '</span>';
    if (s.repo) html += '<span class="k">repo</span><span>' + esc(s.repo) + '</span>';
    html += '<span class="k">cost</span><span class="num">' + usd(s.costUsd) + '</span>';
    html += '<span class="k">models</span><span>' + esc((s.models || []).join(', ')) + '</span>';
    html += '<span class="k">success</span><span>' + badge(a.success) + '</span>';
    html += '<span class="k">complexity</span><span>' + esc(a.complexity || '—') + '</span>';
    html += '<span class="k">autonomy</span><span>' + esc(a.autonomy || '—') + '</span>';
    if (uc) html += '<span class="k">use case</span><span>' + esc(uc) + '</span>';
    html += '</div>';
    if (a.intent_summary) html += '<div class="sect-h">Intent</div><div>' + esc(a.intent_summary) + '</div>';

    var arts = d.artifacts || [];
    var feats = arts.filter(function (x) { return x.kind === 'feature'; });
    if (feats.length) {
      html += '<div class="sect-h">Features</div>';
      html += feats.map(function (f) {
        return '<span class="tag click" data-art="' + esc(f.title) + '" data-kind="feature">' +
          esc(f.title) + (f.source === 'derived' ? ' (proposed)' : '') + '</span>';
      }).join('');
    }
    var prs = arts.filter(function (x) { return x.kind === 'pr'; });
    if (prs.length) {
      html += '<div class="sect-h">Pull requests</div>';
      html += prs.map(function (p) {
        var label = (p.repo ? esc(p.repo) + ' ' : '') + '#' + esc(p.ident) + (p.status ? ' (' + esc(p.status) + ')' : '');
        return '<span class="tag click" data-art="' + esc(p.externalId || p.ident) + '" data-kind="pr">' + label + '</span>';
      }).join('');
    }
    var files = arts.filter(function (x) { return x.kind === 'file'; });
    if (files.length) {
      html += '<div class="sect-h">Files touched (' + files.length + ')</div>';
      html += files.slice(0, 12).map(function (f) {
        return '<span class="tag click" data-art="' + esc(f.ident) + '" data-kind="file">' + esc(f.ident) + '</span>';
      }).join('');
      if (files.length > 12) html += '<span class="tag">+' + (files.length - 12) + ' more</span>';
    }
    var outs = d.outcomes || [];
    if (outs.length) {
      html += '<div class="sect-h">Outcomes</div>';
      html += outs.map(function (o) { return '<span class="tag">' + esc(o.type) + '</span>'; }).join('');
    }

    html += '<div class="sect-h">Transcript</div>';
    html += (d.transcript || []).map(function (t) {
      var tools = (t.tools || []).map(function (tl) {
        return '<span class="tool-chip ' + (tl.ok ? '' : 'err') + '">' + esc(tl.name) + (tl.target ? ' ' + esc(tl.target) : '') + '</span>';
      }).join('');
      return '<div class="turn ' + esc(t.role) + '"><div class="role">' + esc(t.role) + (t.sidechain ? ' · subagent' : '') + '</div>' +
        (t.text ? '<div class="text">' + esc(t.text) + '</div>' : '') +
        (tools ? '<div class="tools">' + tools + '</div>' : '') + '</div>';
    }).join('') || '<div class="empty">No transcript stored.</div>';

    $('#drawerBody').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('#drawerBody .tag.click'), function (el) {
      el.onclick = function () { filterByArtifact(el.getAttribute('data-art'), el.getAttribute('data-kind')); };
    });
    $('#drawer').classList.add('on');
    $('#overlay').classList.add('on');
  });
}

function filterByArtifact(text, kind) {
  closeDrawer();
  setView('sessions');
  var ak = $('#f-artKind'), af = $('#f-artifact');
  if (ak) ak.value = kind || '';
  if (af) af.value = text || '';
  applyFilters();
}

function closeDrawer() { $('#drawer').classList.remove('on'); $('#overlay').classList.remove('on'); }

function setView(name) {
  ['dashboard', 'artifacts', 'sessions'].forEach(function (v) {
    document.getElementById('view-' + v).classList.toggle('on', v === name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-view') === name);
  });
}

function loadChart() { get('/api/timeseries?bucket=' + state.bucket).then(renderChart); }
function loadSessions() {
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

function renderArtKindSeg() {
  var opts = [['pr', 'PRs'], ['feature', 'Features']];
  $('#artKindSeg').innerHTML = opts.map(function (o) {
    return '<button class="' + (o[0] === state.artKind ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call($('#artKindSeg').children, function (btn) {
    btn.onclick = function () { state.artKind = btn.getAttribute('data-k'); renderArtKindSeg(); loadArtifacts(); };
  });
}

function renderArtifacts(rows, kind) {
  if (kind === 'feature') { renderFeatureManager(rows || []); return; }
  if (!rows || !rows.length) {
    $('#artifacts').innerHTML = '<div class="empty">No PRs linked yet. A session that runs gh pr create / merge (or a GitHub MCP PR tool) will show here.</div>';
    return;
  }
  var head = '<tr><th>Pull request</th><th>Status</th><th>Sessions</th><th>Cost</th><th>Merged</th></tr>';
  var body = rows.map(function (r) {
    var label = (r.repo ? esc(r.repo) + ' ' : '') + '#' + esc(r.ident);
    var key = r.externalId || r.ident;
    return '<tr class="arow" data-art="' + esc(key) + '" data-kind="pr">' +
      '<td>' + label + '</td>' +
      '<td>' + (r.status ? esc(r.status) : '—') + '</td>' +
      '<td class="num">' + r.sessions + '</td>' +
      '<td class="num">' + usd(r.costUsd) + '</td>' +
      '<td class="num">' + esc(dayOf(r.completedAt)) + '</td></tr>';
  }).join('');
  $('#artifacts').innerHTML = '<table>' + head + body + '</table>';
  Array.prototype.forEach.call(document.querySelectorAll('.arow'), function (tr) {
    tr.onclick = function () { filterByArtifact(tr.getAttribute('data-art'), tr.getAttribute('data-kind')); };
  });
}

function renderFeatureManager(rows) {
  var html = '<div class="feat-new">' +
    '<input id="nf-title" placeholder="New feature title" />' +
    '<select id="nf-parent">' + featureParentOptions(rows, '', '', null) + '</select>' +
    '<button class="btn" id="nf-add">Add feature</button></div>';
  if (!rows.length) {
    html += '<div class="empty">No features yet. Add one above, or enrich sessions to propose features.</div>';
  } else {
    flattenFeatures(rows).forEach(function (e) {
      var r = e.node, pad = 8 + e.depth * 22;
      var twig = e.depth ? '<span class="feat-twig">&#8627;</span> ' : '';
      var shipped = !!r.completedAt;
      var statusHtml = shipped
        ? '<span class="badge b-success">shipped ' + esc(dayOf(r.completedAt)) + '</span>'
        : '<span class="badge b-null">open</span>';
      var proposed = r.source === 'derived' ? '<span class="tag">proposed</span>' : '';
      html += '<div class="feat-row" style="padding-left:' + pad + 'px">' +
        '<div class="feat-name">' + twig +
          '<span class="nm" data-art="' + esc(r.title || '') + '" data-kind="feature" title="' + esc(r.title || '') + '">' +
          esc(r.title || '(untitled)') + '</span> ' + proposed + ' ' + statusHtml + '</div>' +
        '<span class="feat-meta">' + r.sessions + ' sess &middot; ' + usd(r.costUsd) + '</span>' +
        '<div class="feat-actions">' +
          '<button class="btn" data-act="toggle" data-id="' + esc(r.id) + '" data-completed="' + (shipped ? '1' : '0') + '">' +
          (shipped ? 'reopen' : 'mark shipped') + '</button>' +
          '<select class="feat-move" data-id="' + esc(r.id) + '">' +
          featureParentOptions(rows, r.parentId || '', r.id, descendantsOf(rows, r.id)) + '</select>' +
          '<button class="btn danger" data-act="delete" data-id="' + esc(r.id) + '" data-title="' + esc(r.title || '') + '">delete</button>' +
        '</div></div>';
    });
  }
  $('#artifacts').innerHTML = html;
  wireFeatureManager();
}

function featureParentOptions(rows, selectedId, excludeId, excludeSet) {
  var opts = '<option value=""' + (selectedId ? '' : ' selected') + '>(top level)</option>';
  rows.forEach(function (r) {
    if (r.id === excludeId) return;
    if (excludeSet && excludeSet[r.id]) return;
    opts += '<option value="' + esc(r.id) + '"' + (r.id === selectedId ? ' selected' : '') + '>' + esc(r.title || r.id) + '</option>';
  });
  return opts;
}

function descendantsOf(rows, id) {
  var children = {};
  rows.forEach(function (r) { var p = r.parentId || ''; (children[p] = children[p] || []).push(r.id); });
  var out = {}, stack = (children[id] || []).slice();
  while (stack.length) { var x = stack.pop(); if (out[x]) continue; out[x] = true; (children[x] || []).forEach(function (c) { stack.push(c); }); }
  return out;
}

function flattenFeatures(rows) {
  var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
  var children = {};
  rows.forEach(function (r) {
    var p = r.parentId && byId[r.parentId] ? r.parentId : '';
    (children[p] = children[p] || []).push(r);
  });
  var out = [], visited = {};
  (function walk(key, depth) {
    (children[key] || []).forEach(function (r) {
      if (visited[r.id]) return; visited[r.id] = true;
      out.push({ node: r, depth: depth });
      walk(r.id, depth + 1);
    });
  })('', 0);
  rows.forEach(function (r) { if (!visited[r.id]) { visited[r.id] = true; out.push({ node: r, depth: 0 }); } });
  return out;
}

function wireFeatureManager() {
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  var add = $('#nf-add');
  if (add) add.onclick = function () {
    var title = $('#nf-title').value.trim();
    if (!title) return;
    post('/api/features', { title: title, parentId: $('#nf-parent').value || undefined }).then(loadArtifacts);
  };
  each('#artifacts [data-act="toggle"]', function (b) {
    b.onclick = function () {
      post('/api/features/update', { id: b.getAttribute('data-id'), completed: b.getAttribute('data-completed') !== '1' }).then(loadArtifacts);
    };
  });
  each('#artifacts [data-act="delete"]', function (b) {
    b.onclick = function () {
      if (!window.confirm('Delete feature "' + (b.getAttribute('data-title') || '') + '"? Any sub-features move up to its parent.')) return;
      post('/api/features/delete', { id: b.getAttribute('data-id') }).then(loadArtifacts);
    };
  });
  each('#artifacts .feat-move', function (sel) {
    sel.onchange = function () {
      post('/api/features/update', { id: sel.getAttribute('data-id'), parentId: sel.value || null }).then(loadArtifacts);
    };
  });
  each('#artifacts .nm', function (el) {
    el.onclick = function () { filterByArtifact(el.getAttribute('data-art'), el.getAttribute('data-kind')); };
  });
}

function loadArtifacts() {
  get('/api/artifacts?kind=' + encodeURIComponent(state.artKind)).then(function (rows) {
    renderArtifacts(rows, state.artKind);
  });
}

function init() {
  $('#drawerClose').onclick = closeDrawer;
  $('#overlay').onclick = closeDrawer;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { setView(b.getAttribute('data-view')); };
  });
  renderArtKindSeg();
  renderBucketSeg();
  get('/api/overview').then(function (o) {
    state.overview = o;
    $('#meta').innerHTML = esc(o.dbPath || '');
    renderTiles(o);
    loadFacets().then(function () { renderDists(o); buildFilters(); loadMeasures(); });
  });
  loadKpis();
  loadChart();
  loadSessions();
  loadArtifacts();
}
init();
</script>
</body>
</html>
`
