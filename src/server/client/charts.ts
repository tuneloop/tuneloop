// Hand-rolled HTML/SVG chart renderers. Every function is pure: it takes data
// and returns a markup string, so callers just drop the result into innerHTML.
import { esc, usd, num, fmtVal } from './core'

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
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
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
      var tip = b + ': ' + p.num + '/' + p.denom + ' succeeded (' + (p.rate != null ? Math.round(p.rate * 100) : 0) + '%)';
      svg += '<rect x="' + x + '" y="' + totalTop + '" width="' + w + '" height="' + (base - totalTop) + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    if (i % step === 0) svg += '<text x="' + (padL + i * bw + bw / 2) + '" y="' + (H - padB + 14) + '" text-anchor="middle">' + esc(b) + '</text>';
  });
  svg += '</svg>';
  return svg;
}

// Multi-series line chart on a fixed 0–100% y-axis. buckets = x-axis labels;
// lines = [{label,color,points:[{bucket,rate,num,denom}]}]. Each line aligns to
// the global bucket axis; buckets a line has no data for become gaps. Sample
// size per point lives in the hover tooltip (successes/total) — it can't share
// this percent axis.
export function lineChart(buckets, lines) {
  if (!buckets || !buckets.length) return '<div class="empty">No sessions in range.</div>';
  var W = 920, H = 240, padL = 36, padR = 12, padT = 16, padB = 28;
  var plotW = W - padL - padR, plotH = H - padT - padB, n = buckets.length;
  var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
  var yOf = function (r) { return padT + (1 - r) * plotH; };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
  [0, 0.25, 0.5, 0.75, 1].forEach(function (g) {
    var y = yOf(g);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ece7dc"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(g * 100) + '%</text>';
  });
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += '<text x="' + xOf(i) + '" y="' + (H - padB + 14) + '" text-anchor="middle">' + esc(b) + '</text>';
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
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">';
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
      var tip = format === 'usd'
        ? b + ': ' + usd(p.filled) + ' converted of ' + usd(p.total) + ' spent'
        : b + ': ' + num(p.total);
      svg += '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + (base - top) + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    if (i % step === 0) svg += '<text x="' + (padL + i * bw + bw / 2) + '" y="' + (H - padB + 14) + '" text-anchor="middle">' + esc(b) + '</text>';
  });
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
  var step = Math.ceil(n / 9);
  buckets.forEach(function (b, i) {
    if (i % step === 0) svg += '<text x="' + xOf(i) + '" y="' + (H - padB + 14) + '" text-anchor="middle">' + esc(b) + '</text>';
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
