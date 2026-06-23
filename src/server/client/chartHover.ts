// Shared chart hover: one delegated mousemove listener over the document handles
// every <svg class="chart">. Each chart carries a `data-chart` JSON blob (geometry
// + per-bucket series values) emitted by charts.ts; this snaps the pointer to the
// nearest bucket, moves a crosshair line, drops a highlight dot on each line
// series, and shows a single styled tooltip with every series' value at that
// bucket. Delegation means newly-rendered charts (innerHTML swaps) need no wiring.
import { esc, fmtVal } from './core'

var tip: HTMLDivElement | null = null
var activeSvg: SVGElement | null = null

function ensureTip() {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'chart-tip'
  tip.style.display = 'none'
  document.body.appendChild(tip)
  return tip
}

function readData(svg: SVGElement) {
  // Cache the parsed blob on the element so a flurry of mousemove events doesn't
  // re-parse JSON each time.
  var anySvg = svg as unknown as { _chartData?: any }
  if (anySvg._chartData) return anySvg._chartData
  var raw = svg.getAttribute('data-chart') || ''
  try { anySvg._chartData = JSON.parse(raw) } catch (e) { anySvg._chartData = null }
  return anySvg._chartData
}

// Pointer clientX → the SVG's viewBox-x coordinate (the geometry in data-chart is
// in viewBox units, so the crosshair/dots are placed in those same units).
function toViewBoxX(svg: SVGElement, clientX: number) {
  var rect = svg.getBoundingClientRect()
  var vb = (svg as SVGSVGElement).viewBox.baseVal
  var w = vb && vb.width ? vb.width : rect.width
  return (clientX - rect.left) * (w / rect.width)
}

function toViewBoxY(svg: SVGElement, clientY: number) {
  var rect = svg.getBoundingClientRect()
  var vb = (svg as SVGSVGElement).viewBox.baseVal
  var h = vb && vb.height ? vb.height : rect.height
  return (clientY - rect.top) * (h / rect.height)
}

function nearestBucket(d: any, x: number) {
  var n = d.n, padL = d.padL, plotW = d.plotW
  if (d.xmode === 'point') {
    if (n === 1) return 0
    var i = Math.round((x - padL) / plotW * (n - 1))
    return Math.max(0, Math.min(n - 1, i))
  }
  // band: floor into the bucket whose band contains x
  var bw = plotW / n
  var j = Math.floor((x - padL) / bw)
  return Math.max(0, Math.min(n - 1, j))
}

function bucketCenterX(d: any, i: number) {
  if (d.xmode === 'point') return d.n === 1 ? d.padL + d.plotW / 2 : d.padL + (i / (d.n - 1)) * d.plotW
  var bw = d.plotW / d.n
  return d.padL + i * bw + bw / 2
}

function hide() {
  if (tip) tip.style.display = 'none'
  if (activeSvg) {
    var cross = activeSvg.querySelector('.chart-cross') as SVGLineElement | null
    if (cross) cross.style.display = 'none'
    var dots = activeSvg.querySelector('.chart-dots') as SVGGElement | null
    if (dots) dots.innerHTML = ''
    activeSvg = null
  }
}

function onMove(e: MouseEvent) {
  var target = e.target as Element | null
  var svg = target ? (target.closest('svg.chart') as SVGElement | null) : null
  if (!svg) { hide(); return }
  var d = readData(svg)
  if (!d) { hide(); return }
  activeSvg = svg
  var x = toViewBoxX(svg, e.clientX)
  var i = nearestBucket(d, x)
  var bucket = (d.buckets || [])[i]
  var cx = bucketCenterX(d, i)

  var cross = svg.querySelector('.chart-cross') as SVGLineElement | null
  if (cross) { cross.setAttribute('x1', String(cx)); cross.setAttribute('x2', String(cx)); cross.style.display = 'block' }

  // Highlight dot on each line series at the snapped bucket (point charts only).
  var dots = svg.querySelector('.chart-dots') as SVGGElement | null
  if (dots) {
    var inner = ''
    ;(d.series || []).forEach(function (l: any) {
      var p = (l.points || [])[i]
      if (p && p.v != null && d.yMax) {
        var y = d.padT + (1 - p.v / d.yMax) * d.plotH
        inner += '<circle cx="' + cx.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.4" fill="' + l.color + '"></circle>'
      }
    })
    dots.innerHTML = inner
  }

  // Tooltip: bucket header + one line per series that has a value at this bucket.
  var t = ensureTip()
  var rows = ''
  ;(d.series || []).forEach(function (l: any) {
    var p = (l.points || [])[i]
    if (!p || p.v == null) return
    rows += '<div class="ct-s"><span class="ct-sw" style="background:' + l.color + '"></span>' +
      '<span class="ct-l">' + esc(l.label) + '</span>' +
      '<span class="ct-v">' + esc(fmtVal(p.v, d.fmt)) + '</span>' +
      (p.sub ? '<span class="ct-sub">' + esc(p.sub) + '</span>' : '') + '</div>'
  })
  if (!rows) { hide(); return }
  t.innerHTML = '<div class="ct-b">' + esc(bucket == null ? '—' : bucket) + '</div>' + rows
  // Position near the cursor, clamped to the viewport so it never clips.
  var pad = 14, w = tip!.offsetWidth || 180, h = tip!.offsetHeight || 60
  var left = e.clientX + pad
  if (left + w > window.innerWidth) left = e.clientX - pad - w
  var top = e.clientY + pad
  if (top + h > window.innerHeight) top = e.clientY - pad - h
  t.style.left = Math.max(8, left) + 'px'
  t.style.top = Math.max(8, top) + 'px'
  t.style.display = 'block'
}

// Click-to-drill: a delegated click over <svg.chart> snaps to the nearest bucket
// and resolves which series was clicked, then calls the chart's per-render
// `_onPick` callback (set by the metric module) with {bucketIndex, bucket,
// seriesIndex, seriesLabel}. The metric decides what filter that becomes.
function onDown(e: MouseEvent) {
  if (e.button !== 0) return
  var target = e.target as Element | null
  var svg = target ? (target.closest('svg.chart') as SVGElement | null) : null
  if (!svg) return
  var anySvg = svg as unknown as { _onPick?: (p: any) => void }
  if (!anySvg._onPick) return
  var d = readData(svg)
  if (!d) return
  var x = toViewBoxX(svg, e.clientX)
  var i = nearestBucket(d, x)
  var ns = (d.series || []).length
  var si = -1
  if (ns > 0) {
    if (d.xmode === 'point') {
      // line: the series whose value at this bucket is nearest the click y
      var y = toViewBoxY(svg, e.clientY)
      var best = Infinity
      ;(d.series || []).forEach(function (l: any, idx: number) {
        var p = (l.points || [])[i]
        if (p && p.v != null && d.yMax) {
          var py = d.padT + (1 - p.v / d.yMax) * d.plotH
          var dist = Math.abs(py - y)
          if (dist < best) { best = dist; si = idx }
        }
      })
    } else {
      // band: which slot within the bucket cluster was clicked
      var bw = d.plotW / d.n
      var bandStart = d.padL + i * bw + 3
      var slot = (bw - 6) / ns
      si = Math.max(0, Math.min(ns - 1, Math.floor((x - bandStart) / slot)))
    }
  }
  var seriesLabel = si >= 0 ? (d.series[si] && d.series[si].label) : null
  anySvg._onPick({ bucketIndex: i, bucket: (d.buckets || [])[i], seriesIndex: si, seriesLabel: seriesLabel })
}

var wired = false
export function initChartHover() {
  if (wired) return
  wired = true
  document.addEventListener('mousemove', onMove)
  document.addEventListener('click', onDown)
  // Hide when the pointer leaves the window entirely.
  document.addEventListener('mouseleave', hide)
}

// Attach a per-chart drill callback to the most recent <svg.chart> under a
// container. Called by metric modules after they set the chart's innerHTML.
export function wireChartPick(container: HTMLElement | null, onPick: (p: any) => void) {
  if (!container) return
  var svg = container.querySelector('svg.chart') as (SVGElement & { _onPick?: (p: any) => void }) | null
  if (svg) svg._onPick = onPick
}
