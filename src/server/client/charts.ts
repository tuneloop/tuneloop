// Hand-rolled HTML/SVG chart renderers. Every function is pure: it takes data
// and returns a markup string, so callers just drop the result into innerHTML.
import { esc, usd, num, fmtVal } from './core'

// An x-axis tick label that won't clip at the SVG edges. A centered label near
// the left/right plot bound would spill past the viewBox and get cut off (e.g.
// a final week label like "2026-W25" losing its number); flipping to start/end
// anchoring at the bound keeps the whole label inside.
function xTick(x, y, text, leftEdge, rightEdge) {
  var s = String(text);
  var half = s.length * 3; // ≈ half the rendered width at 10px
  var anchor = 'middle', tx = x;
  if (x - half < leftEdge) { anchor = 'start'; tx = leftEdge; }
  else if (x + half > rightEdge) { anchor = 'end'; tx = rightEdge; }
  return '<text x="' + tx.toFixed(1) + '" y="' + y + '" text-anchor="' + anchor + '">' + esc(s) + '</text>';
}

// Round a rate (0–1) up to a tidy axis top whose quarters land on clean
// percentages (e.g. 0.037 → 0.04, giving 1/2/3/4% gridlines). Capped at 100%.
function niceCeilRate(v) {
  if (!(v > 0)) return 0.04; // no data / all-zero: a small honest 0–4% axis
  var quarter = v / 4;
  var pow = Math.pow(10, Math.floor(Math.log10(quarter)));
  var n = quarter / pow;
  var nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.min(nice * pow * 4, 1);
}

export function bars(rows, keyName) {
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

// Bars for a breakdown ({bucket,value}), value formatted per the measure.
// Rates (pct) draw on a fixed 0-100% scale (the value is already a fraction);
// magnitudes draw relative to the largest bucket (sum/share-of-total doesn't
// generalize — multi-valued facets overlap, so buckets don't sum to a whole).
export function measureBars(rows, format) {
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

// A rotated y-axis caption in the left margin. Shared by the count charts.
function yAxisLabel(text, padT, plotH) {
  if (!text) return '';
  var yc = padT + plotH / 2;
  return '<text x="11" y="' + yc.toFixed(1) + '" text-anchor="middle" transform="rotate(-90 11 ' +
    yc.toFixed(1) + ')">' + esc(text) + '</text>';
}

// Overall mode: one stacked bar per bucket — full height = sessions started
// (denominator), filled portion = sessions with a selected outcome (numerator).
// The rate reads off as the green fraction; the bar's height shows volume.
export function barChart(buckets, points, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  // fullAxis() fills every bucket in a windowed range even when nothing landed in
  // it, so a non-empty `buckets` doesn't imply data — guard on real points too, or
  // an empty window (e.g. no sessions in the last 7 days) draws a bare axis frame.
  if (!points || !points.some(function (p) { return p && p.denom > 0; })) return '<div class="empty">No sessions in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var byBucket = {};
  points.forEach(function (p) { byBucket[p.bucket] = p; });
  var maxD = 0;
  points.forEach(function (p) { if (p.denom > maxD) maxD = p.denom; });
  maxD = maxD || 1;
  var yOf = function (v) { return padT + (1 - v / maxD) * plotH; };
  var base = yOf(0), bw = plotW / n;
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = Math.round(maxD * g), y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var x = padL + i * bw + 2, w = Math.max(2, bw - 4), p = byBucket[b];
    if (p && p.denom > 0) {
      var totalTop = yOf(p.denom), succTop = yOf(p.num);
      svg += '<rect x="' + x + '" y="' + totalTop + '" width="' + w + '" height="' + (base - totalTop) + '" rx="2" fill="#ece7dc"/>';
      svg += '<rect x="' + x + '" y="' + succTop + '" width="' + w + '" height="' + (base - succTop) + '" rx="2" fill="#0f7a55"/>';
      var tip = b + ': ' + p.num + '/' + p.denom + ' with outcome (' + (p.rate != null ? Math.round(p.rate * 100) : 0) + '%)';
      svg += '<rect x="' + x + '" y="' + totalTop + '" width="' + w + '" height="' + (base - totalTop) + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += '</svg>';
  return svg;
}

// Breakdown mode: grouped count bars — per bucket, one bar PER series (facet
// value). Each bar is a single hue (the value's color) so color always means
// "which value"; outcome status is a separate channel — the SOLID lower portion
// produced a selected outcome, the FADED upper portion did not. The rate reads
// off as the solid fraction; bar heights show per-value volume.
// series = [{label,color,points:[{bucket,num,denom,rate}]}].
export function groupedBarChart(buckets, series, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  // See barChart: a windowed axis is always full, so check for real points.
  if (!series || !series.some(function (s) { return (s.points || []).some(function (p) { return p && p.denom > 0; }); })) return '<div class="empty">No sessions in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var idx = series.map(function (s) {
    var m = {};
    (s.points || []).forEach(function (p) { m[p.bucket] = p; });
    return m;
  });
  var maxD = 0;
  series.forEach(function (s) { (s.points || []).forEach(function (p) { if (p.denom > maxD) maxD = p.denom; }); });
  maxD = maxD || 1;
  var yOf = function (v) { return padT + (1 - v / maxD) * plotH; };
  var base = yOf(0), bw = plotW / n, k = series.length || 1;
  var gpad = Math.min(8, bw * 0.18), inner = bw - gpad, sw = Math.max(1.5, inner / k);
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = Math.round(maxD * g), y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var gx = padL + i * bw + gpad / 2;
    series.forEach(function (s, si) {
      var p = idx[si][b];
      if (!p || p.denom <= 0) return;
      var x = gx + si * sw, w = Math.max(1, sw - 0.6);
      var totalTop = yOf(p.denom), fillTop = yOf(p.num);
      // Faded full bar (total) + solid lower portion (with a selected outcome) —
      // both in the value's own hue, so color = value and shade = outcome status.
      svg += '<rect x="' + x.toFixed(1) + '" y="' + totalTop.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (base - totalTop).toFixed(1) + '" rx="1" fill="' + s.color + '" fill-opacity="0.28"/>';
      if (p.num > 0) svg += '<rect x="' + x.toFixed(1) + '" y="' + fillTop.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (base - fillTop).toFixed(1) + '" rx="1" fill="' + s.color + '"/>';
      var tip = b + ' · ' + s.label + ': ' + p.num + '/' + p.denom + (p.rate != null ? ' (' + Math.round(p.rate * 100) + '%)' : '');
      svg += '<rect x="' + x.toFixed(1) + '" y="' + totalTop.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (base - totalTop).toFixed(1) + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    });
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += '</svg>';
  return svg;
}

// Multi-series line chart on a percent y-axis (0–100% by default, or scaled to
// the data with opts.adaptive). buckets = x-axis labels;
// lines = [{label,color,points:[{bucket,rate,num,denom}]}]. Each line aligns to
// the global bucket axis; buckets a line has no data for become gaps. Sample
// size per point lives in the hover tooltip (successes/total) — it can't share
// this percent axis.
export function lineChart(buckets, lines, opts?, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  // See barChart: a windowed axis is always full, so check for real plottable points.
  if (!lines || !lines.some(function (l) { return (l.points || []).some(function (p) { return p && p.rate != null && p.denom > 0; }); })) return '<div class="empty">No sessions in range.</div>';
  // A rotated y-axis caption needs a wider left margin so it clears the % ticks.
  var W = 920, H = 240, padL = yLabel ? 48 : 36, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  // Y-axis top: full 100% by default (an honest absolute scale for the outcome rate);
  // opts.adaptive scales to the data so small rates (e.g. error rates of a few %)
  // fill the chart instead of hugging the bottom. The nice-rounded top keeps the
  // quartile gridlines on clean percentages.
  var maxRate = 1;
  if (opts && opts.adaptive) {
    var dmax = 0;
    lines.forEach(function (l) {
      (l.points || []).forEach(function (p) { if (p && p.rate != null && p.denom > 0 && p.rate > dmax) dmax = p.rate; });
    });
    maxRate = niceCeilRate(dmax);
  }
  var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
  var yOf = function (r) { return padT + (1 - r / maxRate) * plotH; };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.25, 0.5, 0.75, 1].forEach(function (g) {
    var val = g * maxRate, y = yOf(val), pct = val * 100;
    // One decimal on a small adaptive axis so the quarter ticks don't all round
    // to the same integer percent; whole numbers otherwise.
    var lbl = (maxRate < 0.04 ? pct.toFixed(1) : String(Math.round(pct))) + '%';
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + lbl + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += xTick(xOf(i), H - padB + 14, b, padL, W - padR);
  });
  lines.forEach(function (l) {
    var byBucket = {};
    (l.points || []).forEach(function (p) { byBucket[p.bucket] = p; });
    var path = '', run = 0, dots = '';
    buckets.forEach(function (b, i) {
      var p = byBucket[b];
      if (p && p.rate != null && p.denom > 0) {
        var x = xOf(i), y = yOf(p.rate);
        path += (run ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
        run++;
        var tip = b + ' · ' + l.label + ': ' + Math.round(p.rate * 100) + '% (' + p.num + '/' + p.denom + ')';
        dots += '<circle cx="' + x + '" cy="' + y + '" r="2.6" fill="' + l.color + '"><title>' + esc(tip) + '</title></circle>';
      } else {
        run = 0; // gap: next plotted point starts a fresh subpath
      }
    });
    if (path) svg += '<path d="' + path.trim() + '" fill="none" stroke="' + l.color + '" stroke-width="2"/>';
    svg += dots;
  });
  svg += '</svg>';
  return svg;
}

// Stacked bar per bucket: track = total, emerald = filled (filled ≤ total).
// format controls the y-axis + hover (usd or int). For throughput, filled=total
// so the bar is fully emerald.
export function stackChart(buckets, points, format, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No data in range.</div>';
  // See barChart: a windowed axis is always full, so check for real points.
  if (!points || !points.some(function (p) { return p && p.total > 0; })) return '<div class="empty">No data in range.</div>';
  var W = 920, H = 200, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var byB = {};
  points.forEach(function (p) { byB[p.bucket] = p; });
  var maxV = 0;
  points.forEach(function (p) { if (p.total > maxV) maxV = p.total; });
  maxV = maxV || 1;
  var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
  var base = yOf(0), bw = plotW / n;
  var fmt = function (v) { return format === 'usd' ? usd(v) : num(Math.round(v)); };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = maxV * g, y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var x = padL + i * bw + 2, w = Math.max(2, bw - 4), p = byB[b];
    if (p && p.total > 0) {
      var top = yOf(p.total), ftop = yOf(Math.min(p.filled, p.total));
      svg += '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + (base - top) + '" rx="2" fill="#ece7dc"/>';
      if (p.filled > 0) svg += '<rect x="' + x + '" y="' + ftop + '" width="' + w + '" height="' + (base - ftop) + '" rx="2" fill="#0f7a55"/>';
      var tip = format === 'usd'
        ? b + ': ' + usd(p.filled) + ' converted of ' + usd(p.total) + ' spent'
        : b + ': ' + num(p.total);
      svg += '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + (base - top) + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += '</svg>';
  return svg;
}

// Stacked component bars: per bucket, one segment per series, stacked to the
// bucket's total. series=[{label,color,points:[{bucket,y}]}]; format ('usd'|'int').
// For breakdowns whose components PARTITION the total (so segments sum honestly to
// the bar height) — e.g. spend by model/repo/use_case. Each segment carries its own
// hover tooltip. Series should be pre-sorted (biggest first → stacked at the bottom).
export function stackedBarChart(buckets, series, format, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No data in range.</div>';
  // See barChart: a windowed axis is always full, so check for real points.
  if (!series || !series.some(function (s) { return (s.points || []).some(function (p) { return (p.y || 0) > 0; }); })) return '<div class="empty">No data in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var idx = series.map(function (s) {
    var m = {};
    (s.points || []).forEach(function (p) { m[p.bucket] = p.y || 0; });
    return m;
  });
  var maxV = 0;
  buckets.forEach(function (b) {
    var t = 0;
    idx.forEach(function (m) { t += m[b] || 0; });
    if (t > maxV) maxV = t;
  });
  maxV = maxV || 1;
  var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
  var base = yOf(0), bw = plotW / n;
  var fmt = function (v) { return format === 'usd' ? usd(v) : num(Math.round(v)); };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = maxV * g, y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var x = padL + i * bw + 2, w = Math.max(2, bw - 4), acc = 0;
    series.forEach(function (s, si) {
      var v = idx[si][b] || 0;
      if (v > 0) {
        var yTop = yOf(acc + v), yBot = yOf(acc);
        svg += '<rect x="' + x + '" y="' + yTop.toFixed(1) + '" width="' + w + '" height="' + (yBot - yTop).toFixed(1) +
          '" fill="' + s.color + '"><title>' + esc(b + ' · ' + s.label + ': ' + fmt(v)) + '</title></rect>';
        acc += v;
      }
    });
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += '</svg>';
  return svg;
}

// Value-axis multi-line chart. lines[i].points = [{bucket, y}]; format ('usd'|'int')
// drives the y-axis labels + hover. Missing buckets are 0-filled (a real zero, not
// a gap), so lines connect through quiet periods. Used by spend and sessions.
export function valueLineChart(buckets, lines, format, yLabel?) {
  if (!buckets || !buckets.length) return '<div class="empty">No data in range.</div>';
  // See barChart: a windowed axis is always full and this chart 0-fills gaps, so a
  // bare frame would otherwise draw as a flat zero line — guard on a non-zero point.
  if (!lines || !lines.some(function (l) { return (l.points || []).some(function (p) { return (p.y || 0) !== 0; }); })) return '<div class="empty">No data in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
  var maxV = 0;
  lines.forEach(function (l) { (l.points || []).forEach(function (p) { if (p.y > maxV) maxV = p.y; }); });
  maxV = maxV || 1;
  var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
  var fmt = function (v) { return format === 'usd' ? usd(v) : num(Math.round(v)); };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = maxV * g, y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  });
  svg += yAxisLabel(yLabel, padT, plotH);
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += xTick(xOf(i), H - padB + 14, b, padL, W - padR);
  });
  lines.forEach(function (l) {
    var byB = {};
    (l.points || []).forEach(function (p) { byB[p.bucket] = p; });
    var path = '', dots = '';
    buckets.forEach(function (b, i) {
      var v = byB[b] ? byB[b].y : 0;
      var x = xOf(i), y = yOf(v);
      path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      var tip = b + ' · ' + l.label + ': ' + fmt(v);
      dots += '<circle cx="' + x + '" cy="' + y + '" r="2.4" fill="' + l.color + '"><title>' + esc(tip) + '</title></circle>';
    });
    svg += '<path d="' + path.trim() + '" fill="none" stroke="' + l.color + '" stroke-width="2"/>';
    svg += dots;
  });
  svg += '</svg>';
  return svg;
}
