// Breakdown explorer (Stage C). Currently dormant — the explorer panel is
// commented out in index.html and main.ts does not import this module, so the
// bundler tree-shakes it out. Kept intact so the explorer can be re-enabled by
// wiring loadMeasures()/buildExplorer() back into init().
import { state, $, esc, get, fmtVal, grainOfSrc } from './core'
import { measureBars } from './charts'

export function measureBy(key) { for (var i = 0; i < state.measures.length; i++) if (state.measures[i].key === key) return state.measures[i]; return null; }

export function loadMeasures() {
  return get('/api/measures').then(function (m) {
    state.measures = m || [];
    buildExplorer();
  });
}

// Facets valid to break the selected measure by (grain guard: same grain or session).
export function explorerFacets() {
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

export function buildExplorer() {
  var ms = $('#ex-measure');
  ms.innerHTML = state.measures.map(function (m) {
    return '<option value="' + esc(m.key) + '">' + esc(m.label || m.key) + '</option>';
  }).join('');
  ms.onchange = function () { syncExplorerBy(); runExplorer(); };
  syncExplorerBy();
  $('#ex-by').onchange = runExplorer;
  runExplorer();
}

export function syncExplorerBy() {
  var opts = '<option value="">total</option>';
  explorerFacets().forEach(function (f) { opts += '<option value="' + esc(f.key) + '">' + esc(f.label || f.key) + '</option>'; });
  $('#ex-by').innerHTML = opts;
}

export function runExplorer() {
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
