// Dashboard entry point. Wires the static chrome (tabs, drawer), restores the
// view/metric/open-session from the URL hash, then kicks off the async loads.
// Lands on the Highlights tab by default (when the hash is empty); an explicit
// deep link to any other view wins. Bundled by tsup into dist/client/app.js and
// loaded by index.html.
import { state, $, esc, get, dayOf } from './core'
import { initRouter, withoutSync, buildHash } from './router'
import { loadFacets } from './facets'
import { loadKpis, renderWindow, renderOpenMetric } from './kpis'
import { renderSrControls, loadSuccessRate } from './metrics/successRate'
import { renderHighlights, goHighlights } from './home'
import { clearAsked } from './askbanner'
import { buildFilters, closeDrawer, setView, openDetail, applySessionParams } from './sessions'
import { renderArtKindSeg, loadArtifacts } from './artifacts'

function init() {
  // Attach Back/Forward + hash-edit listeners and read where the URL says to land.
  var route = initRouter();

  // The drawer's close button is rendered per-open inside the sticky header
  // (wired in openDetail); the overlay click still closes from anywhere.
  $('#overlay').onclick = closeDrawer;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    // Manual tab nav drops any question-grounding banner.
    b.onclick = function () { clearAsked(); setView(b.getAttribute('data-view')); };
  });

  // Highlights is the landing tab: an empty/partial hash lands there, while a deep
  // link to any other view (e.g. a shared #/dashboard/ops or #/sessions?…) wins.
  var hash = window.location.hash;
  var landHighlights = !hash || hash === '#' || hash === '#/';

  // Initial paint driven by the URL. Wrapped in withoutSync so none of these nav
  // calls mint history entries; the single replaceState below normalizes the URL
  // (so an empty or partial hash becomes its canonical form).
  withoutSync(function () {
    state.artKind = route.artKind;
    state.metric = route.metric; // the KPI tile that's expanded (default success_rate)
    // Restore the artifacts table's search/sort only when we're landing there
    // (the query params are scoped to the active view).
    if (route.view === 'artifacts') {
      state.art = { q: route.query.q || '', sort: route.query.sort || 'created', dir: route.query.dir === 'asc' ? 'asc' : 'desc' };
    }
    renderArtKindSeg();
    renderOpenMetric(); // pre-render the chosen dashboard metric's detail
    renderHighlights(); // pre-render the Highlights tab so it's ready whether we land there or tab in later
    setView(landHighlights ? 'highlights' : route.view);
    if (route.session) openDetail(route.session); // deep-linked drawer
  });

  // The brand logo returns to Highlights from anywhere.
  var brand = document.querySelector('.brand') as HTMLElement | null;
  if (brand) { brand.style.cursor = 'pointer'; brand.onclick = goHighlights; }


  get('/api/overview').then(function (o) {
    state.overview = o;
    var range = o.firstAt && o.lastAt ? dayOf(o.firstAt) + ' → ' + dayOf(o.lastAt) : '';
    $('#meta').innerHTML = (range ? esc(range) + '<br>' : '') + esc(o.dbPath || '');
    loadFacets().then(function () {
      // Build the sessions filter bar. If we landed on the sessions view, restore
      // its filter from the URL (facets are needed to populate the selects, so this
      // waits for them); otherwise build the default bar.
      if (route.view === 'sessions') applySessionParams(route.query);
      else buildFilters();
      // Facets drive the breakdown dropdown AND the per-value table's facet-named
      // title/labels. Success-rate has dedicated facet-aware controls; every other
      // metric just re-renders now that facets are in (its first paint fired before
      // they arrived).
      if (state.metric === 'success_rate') { renderSrControls(); loadSuccessRate(); }
      else renderOpenMetric();
    });
  });
  renderWindow();
  loadKpis();
  // Sessions load via buildFilters() → applyFilters() once facets resolve, so the
  // list arrives already windowed to the default (30d) with its active chips.
  loadArtifacts();
  get('/api/outcome-types').then(function (t) {
    state.outcomeTypes = t || [];
    if (state.metric === 'success_rate') renderSrControls();
  });

  // Collapse the (possibly empty / partial) initial hash to its canonical form,
  // in place — no extra history entry beyond the page load itself.
  window.history.replaceState(null, '', buildHash());
}
init();
