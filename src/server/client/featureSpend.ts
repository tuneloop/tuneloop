// "Spend by feature" — a dashboard panel showing the top features by fully-loaded
// session spend, independent of the shipped flag (so feature cost is visible even
// before anything is marked shipped). Reuses /api/artifacts?kind=feature (the same
// per-feature cost the Features tab shows) and renders it as a ranked bar list.
// Clicking a feature jumps to that feature's sessions.
import { $, esc, usd, get } from './core'
import { filterByArtifact } from './sessions'

export function loadFeatureSpend() {
  var box = $('#feat-spend')
  if (!box) return
  get('/api/artifacts?kind=feature').then(function (rows) {
    renderFeatureSpend(rows || [])
  })
}

function renderFeatureSpend(rows) {
  var box = $('#feat-spend-body')
  if (!box) return
  var feats = rows.filter(function (r) { return r.kind === 'feature'; })
  if (!feats.length) {
    box.innerHTML = '<div class="empty">No features yet. Add one in the Artifacts tab, or enrich sessions to propose features.</div>'
    return
  }
  var sorted = feats.slice().sort(function (a, b) { return (b.costUsd || 0) - (a.costUsd || 0); })
  var top = sorted.slice(0, 10)
  var max = top.reduce(function (m, r) { return Math.max(m, r.costUsd || 0); }, 0) || 1
  var html = top.map(function (r) {
    var pct = Math.round(((r.costUsd || 0) / max) * 100)
    var shipped = r.completedAt ? ' <span class="badge b-success">shipped</span>' : ''
    return '<div class="bar-row fs-row" data-art="' + esc(r.title || '') + '">' +
      '<span class="name" title="' + esc(r.title || '') + '">' + esc(r.title || '(untitled)') + shipped + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="n">' + usd(r.costUsd || 0) + '</span></div>'
  }).join('')
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('.fs-row'), function (row) {
    row.onclick = function () { filterByArtifact(row.getAttribute('data-art'), 'feature'); }
  })
}
