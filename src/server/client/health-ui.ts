// Shared presentation for the health tabs (Skills, Tools): the sparkline, the
// calendar trend charts, the stat tiles, and the small text bits around them.
// Both tabs are roster → detail pages over the same shaped report (rows with a
// `spark` aligned to `report.sparkBuckets`), so the chart code lives here once
// rather than being cloned per tab — a second copy would drift, and two tabs
// drawing the same window differently is exactly what this feature set is
// trying to stop.
//
// NOTE ON CLASS NAMES: the CSS tokens are `sk-`-prefixed for historical reasons
// (Skills shipped first) and are shared by both tabs. They are design tokens for
// "health tab", not a claim about which tab is rendering. Tab-specific chrome
// uses its own prefix (`th-` for Tools).
import { esc, num } from './core'

/** Window presets for the health tabs' time bar (mirrors the Sessions bar). */
export var TIME_PRESETS = [
  { d: 7, l: '7d' }, { d: 14, l: '14d' }, { d: 30, l: '30d' }, { d: 90, l: '90d' }, { d: 'all', l: 'All' }, { d: 'custom', l: 'Custom' }
];

/** Display names for the harness sources (the source chooser + source-scoped copy). */
export var SOURCE_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
export function sourceLabel(s) { return SOURCE_LABELS[s] || s; }

/**
 * The human window phrase for a subtitle/caption. `windowDays` is the report's echo:
 * null = all-time, -1 = a custom from/to range (show the dates, per resolveWindow's
 * sentinel), else the preset day count. `presetPrefix` leads the preset form ("in the
 * last "/"over the last "); `allTime` is the standalone all-time phrase.
 */
export function windowPhrase(windowDays, presetPrefix, allTime, from?, to?) {
  if (windowDays == null) return allTime;
  if (windowDays < 0) {
    if (from && to) return 'from ' + from + ' to ' + to;
    return 'over a custom range';
  }
  return presetPrefix + num(windowDays) + (windowDays === 1 ? ' day' : ' days');
}

/** A headline stat tile (matches the product's KPI tiles). */
export function pageTile(value, label, sub) {
  return '<div class="sk-tile">' +
    '<div class="sk-tile-v">' + value + '</div>' +
    '<div class="sk-tile-l">' + esc(label) + '</div>' +
    (sub ? '<div class="sk-tile-s">' + esc(sub) + '</div>' : '') +
    '</div>';
}

/** One label/value row in a details grid. */
export function fact(label, value, tag?, tip?) {
  return '<div class="sk-fact"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
    '<div class="sk-fact-l">' + esc(label) + (tag ? ' <span class="sk-tag">' + esc(tag) + '</span>' : '') + '</div>' +
    '<div class="sk-fact-v">' + esc(value) + '</div></div>';
}

/**
 * A section header with a small "?" info affordance carrying the explanation as a
 * hover tooltip — keeps the page uncluttered vs a paragraph of prose per section.
 */
export function sectHead(label, tip?) {
  return '<div class="sk-sect-h">' + esc(label) +
    (tip ? ' <span class="sk-info" title="' + esc(tip) + '">?</span>' : '') + '</div>';
}

/**
 * Tiny inline SVG sparkline of per-bucket counts. Flat baseline when there's no
 * usage. Bars (not a line) read clearly at this size. Width/height/colour are
 * parameterized so the roster (small) and the detail page (larger) share it.
 */
export function sparkline(spark, w?, h?, color?) {
  var width = w || 90, height = h || 20, fill = color || 'var(--emerald)';
  var vals = spark || [];
  var max = 0;
  for (var i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
  var base = height - 1;
  if (!max) return '<svg class="sk-spark-svg" width="' + width + '" height="' + height + '" aria-hidden="true"><line x1="0" y1="' + base + '" x2="' + width + '" y2="' + base + '" stroke="var(--line)" stroke-width="1"/></svg>';
  var n = vals.length, bw = width / n, bars = '';
  for (var j = 0; j < n; j++) {
    var bh = vals[j] ? Math.max(2, Math.round((vals[j] / max) * (height - 2))) : 0;
    if (!bh) continue;
    bars += '<rect x="' + (j * bw).toFixed(1) + '" y="' + (base - bh) + '" width="' + Math.max(1, bw - 1).toFixed(1) +
      '" height="' + bh + '" fill="' + fill + '"></rect>';
  }
  return '<svg class="sk-spark-svg" width="' + width + '" height="' + height + '" aria-hidden="true">' + bars + '</svg>';
}

/** The trend granularity word for a caption, inferred from the bucket width. */
export function trendGranLabel(buckets) {
  if (!buckets || buckets.length < 1) return 'period';
  var days = (buckets[0].endMs - buckets[0].startMs) / 86400000;
  return days <= 1.5 ? 'day' : days <= 8 ? 'week' : 'month';
}

/** A bucket's full date-range label for the tooltip: "Jul 8" (day) or "Jul 8 – Jul 14". */
export function bucketRange(b) {
  var fmt = function (ms) { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  var days = (b.endMs - b.startMs) / 86400000;
  return days <= 1.5 ? fmt(b.startMs) : fmt(b.startMs) + ' – ' + fmt(b.endMs - 86400000);
}

// [0..max] inclusive, integers — the small-range Y tick set.
function range0(max) { var a = []; for (var i = 0; i <= max; i++) a.push(i); return a; }

/**
 * A count bar chart over the report's calendar buckets. Bars align 1:1 with the
 * buckets; every bar carries data-* so wireTrendTooltip() can show an exact
 * "date: N <unit>" on hover. A count Y-axis (0/mid/max) + evenly-spaced date
 * x-ticks make it readable — a real chart, not the roster's bare sparkline.
 */
export function trendChart(spark, buckets, opts?) {
  var o = opts || {};
  var unit = o.unit || 'invocation';
  var color = o.color || 'var(--emerald)';
  var vals = spark || [];
  var n = buckets && buckets.length ? buckets.length : vals.length;
  var max = 0;
  for (var i = 0; i < n; i++) if ((vals[i] || 0) > max) max = vals[i];
  max = max || 1;
  var yTicks = max <= 4 ? range0(max) : [0, Math.round(max / 2), max];
  return chartFrame(n, buckets, max, yTicks, function (v) { return String(v); }, function (b) {
    var c = vals[b] || 0;
    return { value: c, tip: num(c) + ' ' + unit + (c === 1 ? '' : 's'), color: color };
  });
}

/**
 * An error-RATE bar chart: each bar is the bucket's errors ÷ calls, and the
 * tooltip carries the fraction behind it. A rate chart (not a count chart)
 * because "3 errors" means nothing without the calls it came from — a bucket
 * with 3 of 4 failing and one with 3 of 300 must not draw the same bar.
 * Buckets with no calls draw nothing (no calls = no rate, not a zero rate).
 */
export function rateChart(nums, denoms, buckets, opts?) {
  var o = opts || {};
  var color = o.color || 'var(--red)';
  var ns = nums || [], ds = denoms || [];
  var n = buckets && buckets.length ? buckets.length : ns.length;
  var max = 0;
  for (var i = 0; i < n; i++) {
    var d = ds[i] || 0;
    if (d > 0) { var r = (ns[i] || 0) / d; if (r > max) max = r; }
  }
  max = max || 1;
  // Round the axis top up to a readable step so the tick labels stay whole percents.
  var step = max <= 0.1 ? 0.05 : max <= 0.25 ? 0.1 : max <= 0.5 ? 0.25 : 0.5;
  max = Math.min(1, Math.ceil(max / step) * step);
  var ticks = [0, max / 2, max];
  return chartFrame(n, buckets, max, ticks, function (v) { return Math.round(v * 100) + '%'; }, function (b) {
    var den = ds[b] || 0;
    if (!den) return { value: 0, tip: 'no calls', color: color };
    var errs = ns[b] || 0;
    return {
      value: errs / den,
      tip: Math.round((errs / den) * 100) + '% — ' + num(errs) + ' of ' + num(den) + (den === 1 ? ' call' : ' calls'),
      color: color,
    };
  });
}

/**
 * The shared chart body: axes, gridlines, date ticks, and one bar per bucket with
 * a full-height transparent hit zone (so hovering the empty space above a short
 * bar still works). `barAt(i)` supplies each bucket's value, tooltip and colour.
 */
function chartFrame(n, buckets, max, yTicks, fmtTick, barAt) {
  var W = 860, H = 220, padL = 38, padR = 12, padT = 14, padB = 34;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var base = padT + plotH, bw = plotW / n;
  var yOf = function (v) { return padT + (1 - v / max) * plotH; };
  var svg = '<svg class="sk-trend-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';

  yTicks.forEach(function (v) {
    var y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--line)"/>';
    svg += '<text class="sk-trend-ax" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmtTick(v)) + '</text>';
  });

  var xStep = Math.max(1, Math.ceil(n / 8)); // ~8 x-labels max
  for (var b = 0; b < n; b++) {
    var x = padL + b * bw, w = Math.max(2, bw - 3), bx = x + (bw - w) / 2;
    var bk = buckets && buckets[b];
    var cell = barAt(b);
    svg += '<rect class="sk-trend-hit" x="' + x.toFixed(1) + '" y="' + padT + '" width="' + bw.toFixed(1) + '" height="' + plotH +
      '" fill="transparent" data-range="' + esc(bk ? bucketRange(bk) : '') + '" data-count="' + esc(cell.tip) + '"></rect>';
    if (cell.value > 0) {
      var top = yOf(cell.value);
      svg += '<rect class="sk-trend-bar" x="' + bx.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + Math.max(1, base - top).toFixed(1) + '" rx="2" fill="' + cell.color + '"></rect>';
    }
    if (bk && (b % xStep === 0 || b === n - 1)) {
      var lbl = new Date(bk.startMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      var anchor = b === 0 ? 'start' : b === n - 1 ? 'end' : 'middle';
      var tx = anchor === 'start' ? padL : anchor === 'end' ? W - padR : x + bw / 2;
      svg += '<text class="sk-trend-ax" x="' + tx.toFixed(1) + '" y="' + (H - 12) + '" text-anchor="' + anchor + '">' + esc(lbl) + '</text>';
    }
  }
  return svg + '</svg>';
}

/**
 * Wire a trend chart's floating tooltip: hovering any bucket hit-zone shows a
 * positioned box with the date range + the bucket's value. `host` is the chart's
 * container element (not an id) so several charts can coexist on one page.
 */
export function wireTrendTooltip(host) {
  if (!host) return;
  var tip = document.createElement('div');
  tip.className = 'sk-trend-tip';
  tip.style.display = 'none';
  host.appendChild(tip);
  Array.prototype.forEach.call(host.querySelectorAll('.sk-trend-hit'), function (hit) {
    hit.onmousemove = function (e) {
      tip.innerHTML = '<b>' + esc(hit.getAttribute('data-range')) + '</b><br>' + esc(hit.getAttribute('data-count'));
      tip.style.display = 'block';
      var wr = host.getBoundingClientRect();
      tip.style.left = (e.clientX - wr.left + 12) + 'px';
      tip.style.top = (e.clientY - wr.top + 12) + 'px';
    };
    hit.onmouseleave = function () { tip.style.display = 'none'; };
  });
}
