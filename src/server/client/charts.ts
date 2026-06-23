// Hand-rolled HTML/SVG chart renderers. Every function is pure: it takes data
// and returns a markup string, so callers just drop the result into innerHTML.
//
// Interactivity (hover tooltip + crosshair) is delegated: each <svg> carries a
// `data-chart` JSON blob (geometry + per-bucket series values) plus a transparent
// overlay rect that captures pointer events. A single handler in chartHover.ts
// (wired once at init) reads that blob, snaps to the nearest bucket, shows a
// shared styled tooltip, and moves a crosshair. So renderers stay pure strings.
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

// Serialize the hover blob onto the <svg> opening tag. esc() makes it
// attribute-safe (quotes, angle brackets).
function chartAttr(data) {
  return ' class="chart" data-chart="' + esc(JSON.stringify(data)) + '"';
}

// The transparent overlay (captures pointer events over the plot area), the
// crosshair line (moved by the hover handler), and — for line charts — an empty
// dots group the handler fills with a highlight dot per series. Emitted last so
// they sit above the marks; marks themselves carry pointer-events:none (CSS).
function interact(geo, dots) {
  var s = '<rect class="chart-overlay" x="' + geo.padL + '" y="' + geo.padT +
    '" width="' + geo.plotW + '" height="' + geo.plotH + '"></rect>' +
    '<line class="chart-cross" x1="0" y1="' + geo.padT + '" x2="0" y2="' + geo.base + '"></line>';
  if (dots) s += '<g class="chart-dots"></g>';
  return s;
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

// Overall mode: one stacked bar per bucket — full height = sessions started
// (denominator), filled portion = sessions with a success outcome (numerator).
// The rate reads off as the green fraction; the bar's height shows volume.
export function barChart(buckets, points) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  var W = 920, H = 240, padL = 36, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var byBucket = {};
  points.forEach(function (p) { byBucket[p.bucket] = p; });
  var maxD = 0;
  points.forEach(function (p) { if (p.denom > maxD) maxD = p.denom; });
  maxD = maxD || 1;
  var yOf = function (v) { return padT + (1 - v / maxD) * plotH; };
  var base = yOf(0), bw = plotW / n;
  var svg = '<svg' + chartAttr({ xmode: 'band', n: n, padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, fmt: 'pct',
    buckets: buckets, series: [{ label: 'success', color: '#0f7a55',
      points: buckets.map(function (b) { var p = byBucket[b]; return p && p.denom > 0 ? { bucket: b, v: p.rate, sub: p.num + '/' + p.denom + ' succeeded' } : { bucket: b, v: null }; }) }] }) +
    ' viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = Math.round(maxD * g), y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
  });
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var x = padL + i * bw + 2, w = Math.max(2, bw - 4), p = byBucket[b];
    if (p && p.denom > 0) {
      var totalTop = yOf(p.denom), succTop = yOf(p.num);
      svg += '<rect x="' + x + '" y="' + totalTop + '" width="' + w + '" height="' + (base - totalTop) + '" rx="2" fill="#ece7dc"/>';
      svg += '<rect x="' + x + '" y="' + succTop + '" width="' + w + '" height="' + (base - succTop) + '" rx="2" fill="#0f7a55"/>';
    }
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += interact({ padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, n: n }, false);
  svg += '</svg>';
  return svg;
}

// Multi-series line chart on a percent y-axis (0–100% by default, or scaled to
// the data with opts.adaptive). buckets = x-axis labels;
// lines = [{label,color,points:[{bucket,rate,num,denom}]}]. Each line aligns to
// the global bucket axis; buckets a line has no data for become gaps. Sample
// size per point lives in the hover tooltip (successes/total) — it can't share
// this percent axis.
export function lineChart(buckets, lines, opts?) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  var W = 920, H = 240, padL = 36, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  // Y-axis top: full 100% by default (an honest absolute scale for success rate);
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
  var base = padT + plotH;
  var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
  var yOf = function (r) { return padT + (1 - r / maxRate) * plotH; };
  var svg = '<svg' + chartAttr({ xmode: 'point', n: n, padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, fmt: 'pct', yMax: maxRate,
    buckets: buckets, series: lines.map(function (l) {
      var byB = {}; (l.points || []).forEach(function (p) { byB[p.bucket] = p; });
      return { label: l.label, color: l.color, points: buckets.map(function (b) {
        var p = byB[b];
        return p && p.rate != null && p.denom > 0 ? { bucket: b, v: p.rate, sub: p.num + '/' + p.denom } : { bucket: b, v: null };
      }) };
    }) }) + ' viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.25, 0.5, 0.75, 1].forEach(function (g) {
    var val = g * maxRate, y = yOf(val), pct = val * 100;
    // One decimal on a small adaptive axis so the quarter ticks don't all round
    // to the same integer percent; whole numbers otherwise.
    var lbl = (maxRate < 0.04 ? pct.toFixed(1) : String(Math.round(pct))) + '%';
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + lbl + '</text>';
  });
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += xTick(xOf(i), H - padB + 14, b, padL, W - padR);
  });
  lines.forEach(function (l) {
    var byBucket = {};
    (l.points || []).forEach(function (p) { byBucket[p.bucket] = p; });
    var path = '', run = 0;
    buckets.forEach(function (b, i) {
      var p = byBucket[b];
      if (p && p.rate != null && p.denom > 0) {
        var x = xOf(i), y = yOf(p.rate);
        path += (run ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
        run++;
      } else {
        run = 0; // gap: next plotted point starts a fresh subpath
      }
    });
    if (path) svg += '<path d="' + path.trim() + '" fill="none" stroke="' + l.color + '" stroke-width="2"/>';
  });
  svg += interact({ padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, n: n }, true);
  svg += '</svg>';
  return svg;
}

// Stacked bar per bucket: track = total, emerald = filled (filled ≤ total).
// format controls the y-axis + hover (usd or int). For throughput, filled=total
// so the bar is fully emerald.
export function stackChart(buckets, points, format) {
  if (!buckets || !buckets.length) return '<div class="empty">No data in range.</div>';
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
  var svg = '<svg' + chartAttr({ xmode: 'band', n: n, padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, fmt: format,
    buckets: buckets, series: [{ label: format === 'usd' ? 'spend' : 'count', color: '#0f7a55',
      points: buckets.map(function (b) { var p = byB[b]; return p && p.total > 0 ? { bucket: b, v: p.total, sub: format === 'usd' ? usd(p.filled) + ' converted of ' + usd(p.total) : '' } : { bucket: b, v: null }; }) }] }) + ' viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = maxV * g, y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  });
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    var x = padL + i * bw + 2, w = Math.max(2, bw - 4), p = byB[b];
    if (p && p.total > 0) {
      var top = yOf(p.total), ftop = yOf(Math.min(p.filled, p.total));
      svg += '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + (base - top) + '" rx="2" fill="#ece7dc"/>';
      if (p.filled > 0) svg += '<rect x="' + x + '" y="' + ftop + '" width="' + w + '" height="' + (base - ftop) + '" rx="2" fill="#0f7a55"/>';
    }
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += interact({ padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, n: n }, false);
  svg += '</svg>';
  return svg;
}

// Value-axis multi-line chart. lines[i].points = [{bucket, y}]; format ('usd'|'int')
// drives the y-axis labels + hover. Missing buckets are 0-filled (a real zero, not
// a gap), so lines connect through quiet periods. Used by spend and sessions.
export function valueLineChart(buckets, lines, format) {
  if (!buckets || !buckets.length) return '<div class="empty">No data in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var base = padT + plotH;
  var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
  var maxV = 0;
  lines.forEach(function (l) { (l.points || []).forEach(function (p) { if (p.y > maxV) maxV = p.y; }); });
  maxV = maxV || 1;
  var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
  var fmt = function (v) { return format === 'usd' ? usd(v) : num(Math.round(v)); };
  var svg = '<svg' + chartAttr({ xmode: 'point', n: n, padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, fmt: format, yMax: maxV,
    buckets: buckets, series: lines.map(function (l) {
      var byB = {}; (l.points || []).forEach(function (p) { byB[p.bucket] = p; });
      return { label: l.label, color: l.color, points: buckets.map(function (b) { var p = byB[b]; return { bucket: b, v: p ? p.y : 0 }; }) };
    }) }) + ' viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (g) {
    var v = maxV * g, y = yOf(v);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  });
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += xTick(xOf(i), H - padB + 14, b, padL, W - padR);
  });
  lines.forEach(function (l) {
    var byB = {};
    (l.points || []).forEach(function (p) { byB[p.bucket] = p; });
    var path = '';
    buckets.forEach(function (b, i) {
      var v = byB[b] ? byB[b].y : 0;
      var x = xOf(i), y = yOf(v);
      path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    });
    svg += '<path d="' + path.trim() + '" fill="none" stroke="' + l.color + '" stroke-width="2"/>';
  });
  svg += interact({ padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, n: n }, true);
  svg += '</svg>';
  return svg;
}

// Grouped bars: one cluster per bucket, each series its own side-by-side bar.
// series = [{label,color,points:[{bucket,v,sub}]}]; format ('usd'|'int'|'pct')
// drives the y-axis + hover. pct uses a 0–100% axis (or adaptive when opts.adaptive).
// The default breakdown renderer — multi-series bars read cleaner than the
// spaghetti of N overlaid lines, and a click on a cluster can drill to sessions.
export function groupedBarChart(buckets, series, format, opts?) {
  if (!buckets || !buckets.length || !series || !series.length) return '<div class="empty">No data in range.</div>';
  var W = 920, H = 240, padL = 48, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var ns = series.length;
  var isPct = format === 'pct';
  var maxV = 0;
  series.forEach(function (l) { (l.points || []).forEach(function (p) { if (p && p.v != null && p.v > maxV) maxV = p.v; }); });
  if (isPct) maxV = (opts && opts.adaptive) ? niceCeilRate(maxV) : 1;
  maxV = maxV || 1;
  var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
  var base = yOf(0), bw = plotW / n;
  var fmt = function (v) { return format === 'usd' ? usd(v) : format === 'pct' ? Math.round(v * 100) + '%' : num(Math.round(v)); };
  // Index each series by bucket for the render loop (kept off the JSON blob).
  var seriesByB = series.map(function (l) {
    var byB = {}; (l.points || []).forEach(function (p) { if (p && p.bucket != null) byB[p.bucket] = p; });
    return byB;
  });
  var svg = '<svg' + chartAttr({ xmode: 'band', n: n, padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, fmt: format, yMax: maxV,
    buckets: buckets, series: series.map(function (l, si) {
      return { label: l.label, color: l.color, points: buckets.map(function (b) { var p = seriesByB[si][b]; return p && p.v != null ? { bucket: b, v: p.v, sub: p.sub } : { bucket: b, v: null }; }) };
    }) }) + ' viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  var ticks = isPct ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  ticks.forEach(function (g) {
    var v = maxV * g, y = yOf(v), lbl = isPct ? ((maxV < 0.04 ? (v * 100).toFixed(1) : String(Math.round(v * 100))) + '%') : esc(fmt(v));
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + lbl + '</text>';
  });
  var step = Math.ceil(n / 9);
  var slot = (bw - 6) / ns;
  var barW = Math.max(2, slot - 2);
  buckets.forEach(function (b, i) {
    var bx = padL + i * bw + 3;
    series.forEach(function (l, si) {
      var p = seriesByB[si][b];
      if (p && p.v != null) {
        var x = bx + si * slot + (slot - barW) / 2;
        var y = yOf(Math.max(0, p.v));
        var h = base - y;
        if (h > 0) svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1" fill="' + l.color + '"/>';
      }
    });
    if (i % step === 0) svg += xTick(padL + i * bw + bw / 2, H - padB + 14, b, padL, W - padR);
  });
  svg += interact({ padL: padL, plotW: plotW, padT: padT, plotH: plotH, base: base, n: n }, false);
  svg += '</svg>';
  return svg;
}
