// Dashboard entry point. Wires the static chrome (tabs, drawer), restores the
// view/metric/open-session from the URL hash, then kicks off the async loads.
// Lands on the Highlights tab by default (when the hash is empty); an explicit
// deep link to any other view wins. Bundled by tsup into dist/client/app.js and
// loaded by index.html.
import { state, $, esc, get, dayOf } from './core'
import { initRouter, withoutSync, buildHash } from './router'
import { loadFacets } from './facets'
import { loadKpis, paintKpis, renderWindow, renderOpenMetric } from './kpis'
import { renderSrControls, loadSuccessRate } from './metrics/successRate'
import { renderHighlights, paintHighlights, goHighlights } from './home'
import { renderNotices } from './notice'
import { clearAsked } from './askbanner'
import { buildFilters, closeDrawer, setView, openDetail, applySessionParams } from './sessions'
import { renderArtKindSeg, loadArtifacts } from './artifacts'
import { loadFriction } from './friction'

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
    // Tilde the home dir so screenshots don't leak the username.
    var tilde = function (p) { return (p || '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\//, '~/'); };
    var dbPath = tilde(o.dbPath || '');
    // The header shows just the store location; the session range, last-analyzed
    // time, and per-directory scan history live in an info popover beside it.
    var roots = o.analyzedRoots || [];
    var info = '';
    if (range || o.lastAnalyzedAt || roots.length) {
      var head =
        (range ? '<div class="mi-head">Sessions ' + esc(range) + '</div>' : '') +
        (o.lastAnalyzedAt ? '<div class="mi-head">Last analyzed ' + esc(dayOf(o.lastAnalyzedAt)) + '</div>' : '');
      var rows = roots.length
        ? roots.map(function (r) {
            return '<div class="mi-row"><span class="mi-path">' + esc(tilde(r.path)) + '</span>' +
              '<span class="mi-when">' + esc(r.lastAnalyzedAt ? dayOf(r.lastAnalyzedAt) : '—') + '</span></div>';
          }).join('')
        : '<div class="mi-empty">No directory scan history yet — run <code>tuneloop analyze</code>.</div>';
      info = '<span class="meta-info-wrap">' +
        '<button type="button" class="meta-info-btn" id="metaInfoBtn" title="Store details" aria-label="Store details">&#9432;</button>' +
        '<div class="meta-info-pop" id="metaInfoPop">' + head +
          '<div class="mi-title">Analyzed directories</div>' + rows + '</div></span>';
    }
    $('#meta').innerHTML =
      '<span class="meta-top">' +
        (dbPath ? '<span class="meta-path">' + esc(dbPath) + '</span>' : '') + info +
      '</span>';
    var miBtn = document.getElementById('metaInfoBtn');
    if (miBtn) {
      miBtn.onclick = function (e) {
        e.stopPropagation();
        var pop = document.getElementById('metaInfoPop');
        if (pop) pop.classList.toggle('on');
      };
      // Close on an outside click (same pattern as the outcome popover).
      document.addEventListener('mousedown', function (e) {
        var pop = document.getElementById('metaInfoPop');
        if (!pop || !pop.classList.contains('on')) return;
        var wrap = document.querySelector('.meta-info-wrap');
        if (wrap && wrap.contains(e.target as Node)) return;
        pop.classList.remove('on');
      });
    }
    // The overview is what classifies the store (empty / un-enriched / ok) and
    // whether any outcomes exist, so surface the nudges + correct the outcome-rate
    // tile now that it's known (these paint from cached payloads — no refetch).
    renderNotices();
    paintKpis();
    paintHighlights();
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
  loadArtifacts()
  loadFriction();
  get('/api/outcome-types').then(function (t) {
    state.outcomeTypes = t || [];
    if (state.metric === 'success_rate') renderSrControls();
  });

  // Collapse the (possibly empty / partial) initial hash to its canonical form,
  // in place — no extra history entry beyond the page load itself.
  window.history.replaceState(null, '', buildHash());
}
init();
