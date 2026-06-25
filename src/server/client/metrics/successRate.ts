// Session success rate detail (headline metric #1): outcome-set picker, bucket
// selector, optional breakdown into per-cohort rate lines, and the overall
// stacked-volume bar when not broken down.
import { state, $, esc, SR_PALETTE, get, saveSrPrefs, autoBucket, windowQs, outcomeRank, outcomeLabel } from '../core'
import { loadKpis } from '../kpis'
import { lineChart, barChart } from '../charts'
import { srBreakdownFacets } from '../facets'

export function renderSuccessRate() {
  $('#metric-detail').innerHTML =
    '<div class="metric-head">' +
      '<h2>Session success rate</h2>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="sr-controls" id="sr-controls"></div>' +
      '<div id="sr-chart"></div>' +
      '<div class="sr-legend" id="sr-legend"></div>' +
      '<div class="card-note" id="sr-note"></div>' +
    '</div>';
  renderSrControls();
  loadSuccessRate();
}

export function renderSrControls() {
  var oc = (state.outcomeTypes || []).slice().sort(function (a, b) { return outcomeRank(a.type) - outcomeRank(b.type); });
  var checks = oc.map(function (o) {
    var on = state.sr.outcomes.indexOf(o.type) >= 0;
    var label = esc(outcomeLabel(o.type));
    return '<label class="sr-check"><input type="checkbox" class="sr-oc" value="' + esc(o.type) + '"' +
      (on ? ' checked' : '') + '/> ' + label + ' <span class="sr-cnt">' + o.sessions + '</span></label>';
  }).join('');
  var activeBucket = autoBucket(state.sr.bucket);
  var bucketBtns = ['day', 'week', 'month'].map(function (b) {
    return '<button class="' + (b === activeBucket ? 'on' : '') + '" data-b="' + b + '">' + b + '</button>';
  }).join('');
  var byOpts = '<option value="">none</option>';
  srBreakdownFacets().forEach(function (f) {
    byOpts += '<option value="' + esc(f.key) + '"' + (f.key === state.sr.by ? ' selected' : '') + '>' +
      esc(f.label || f.key) + '</option>';
  });
  $('#sr-controls').innerHTML =
    '<div class="sr-ctrl-row"><span class="sr-lbl">Count as success</span>' +
      '<span class="sr-checks">' + (checks || '<span class="empty">no outcomes yet</span>') + '</span></div>' +
    '<div class="sr-ctrl-row"><span class="sr-lbl">Bucket</span><span class="seg" id="sr-bucket">' + bucketBtns + '</span>' +
      '<span class="sr-lbl" style="margin-left:18px">Break down by</span>' +
      '<select class="sr-by" id="sr-by">' + byOpts + '</select></div>';
  Array.prototype.forEach.call(document.querySelectorAll('.sr-oc'), function (c) {
    c.onchange = function () {
      var set = [];
      Array.prototype.forEach.call(document.querySelectorAll('.sr-oc'), function (x) { if (x.checked) set.push(x.value); });
      state.sr.outcomes = set;
      saveSrPrefs();
      loadSuccessRate();
      loadKpis(); // the windowed KPI tile counts success the same way — keep it in sync
    };
  });
  Array.prototype.forEach.call($('#sr-bucket').children, function (btn) {
    btn.onclick = function () { state.sr.bucket = btn.getAttribute('data-b'); renderSrControls(); loadSuccessRate(); };
  });
  $('#sr-by').onchange = function () { state.sr.by = this.value; saveSrPrefs(); loadSuccessRate(); };
}

export function loadSuccessRate() {
  var sr = state.sr;
  var qs = ['outcomes=' + encodeURIComponent((sr.outcomes || []).join(',')), 'bucket=' + encodeURIComponent(autoBucket(sr.bucket))];
  if (sr.by) qs.push('by=' + encodeURIComponent(sr.by));
  get('/api/success-rate?' + qs.join('&') + windowQs()).then(function (d) {
    if (!d || d.error) { $('#sr-chart').innerHTML = '<div class="empty">No data.</div>'; return; }
    renderRateChart(d);
  });
}

export function renderRateChart(d) {
  var ov = d.overall || { rate: null, num: 0, denom: 0 };
  // Mark depends on mode: overall → a stacked count bar (volume + success in one
  // mark, honest about sample size); breakdown → rate lines (bars don't compose
  // across many series), with faint volume bars behind for that sample-size cue.
  var note = '';
  if (d.series && d.series.length) {
    var lines = d.series.map(function (s, i) {
      return { label: s.key, color: SR_PALETTE[i % SR_PALETTE.length], points: s.points, rate: s.rate };
    });
    $('#sr-chart').innerHTML = lineChart(d.buckets || [], lines);
    $('#sr-legend').innerHTML = lines.map(function (l) {
      return '<span class="leg"><span class="swatch" style="background:' + l.color + '"></span>' + esc(l.label) +
        (l.rate != null ? ' <span class="sr-cnt">' + Math.round(l.rate * 100) + '%</span>' : '') + '</span>';
    }).join('');
    note = d.truncated
      ? 'Showing top ' + d.truncated.shown + ' of ' + d.truncated.total + ' values by session volume. '
      : '';
    note += 'Each line is one cohort. Hover a point to see its sessions (successes / total).';
  } else {
    $('#sr-chart').innerHTML = barChart(d.buckets || [], ov.points || []);
    $('#sr-legend').innerHTML =
      '<span class="leg"><span class="swatch" style="background:#0f7a55"></span>successful</span>' +
      '<span class="leg"><span class="swatch" style="background:#ece7dc"></span>no success outcome</span>';
    note = 'Bar height is sessions started in the bucket; the filled portion produced a success outcome.';
  }
  if ((d.outcomes || []).indexOf('pr_merged') >= 0) {
    note += ' Recent buckets may rise as PRs merge — those outcomes backfill after the session.';
  }
  $('#sr-note').innerHTML = esc(note);
}
