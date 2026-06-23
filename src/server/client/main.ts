// Dashboard entry point. Wires the static chrome (tabs, drawer), lands on the
// Session success rate detail, then kicks off the async loads. Bundled by tsup
// into dist/client/app.js and loaded by index.html.
import { state, $, esc, get, dayOf } from './core'
import { loadFacets } from './facets'
import { loadKpis, renderWindow } from './kpis'
import { renderSuccessRate, renderSrControls } from './metrics/successRate'
import { buildFilters, loadSessions, closeDrawer, setView } from './sessions'
import { renderArtKindSeg, loadArtifacts } from './artifacts'

function init() {
  // The drawer's close button is rendered per-open inside the sticky header
  // (wired in openDetail); the overlay click still closes from anywhere.
  $('#overlay').onclick = closeDrawer;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { setView(b.getAttribute('data-view')); };
  });
  renderArtKindSeg();
  // The KPI tiles are the nav; one section is always expanded. Land on the
  // Session success rate detail (its controls refresh once facets load below).
  state.metric = 'success_rate';
  renderSuccessRate();
  get('/api/overview').then(function (o) {
    state.overview = o;
    var range = o.firstAt && o.lastAt ? dayOf(o.firstAt) + ' → ' + dayOf(o.lastAt) : '';
    $('#meta').innerHTML = (range ? esc(range) + '<br>' : '') + esc(o.dbPath || '');
    loadFacets().then(function () {
      buildFilters();
      if (state.metric === 'success_rate') renderSrControls();
    });
  });
  renderWindow();
  loadKpis();
  loadSessions();
  loadArtifacts();
  get('/api/outcome-types').then(function (t) {
    state.outcomeTypes = t || [];
    if (state.metric === 'success_rate') renderSrControls();
  });
}
init();
