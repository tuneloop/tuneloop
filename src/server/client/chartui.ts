// One delegated hover+click layer for every chart, installed once. Charts emit
// `.chart-hit` marks carrying data-bucket / data-key / data-tip (see charts.ts);
// this reads them at event time, so re-rendering a chart's innerHTML needs no
// re-wiring. Hover shows a positioned tooltip div (no native <title> hover delay);
// click drills into the session list filtered to that bucket (+ series value).
import { $ } from './core'
import { drillToSessions } from './sessions'

var tipEl: HTMLElement | null = null;

function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = 'chart-tip';
  tipEl.className = 'chart-tip';
  document.body.appendChild(tipEl);
  return tipEl;
}

function showTip(text, x, y) {
  var el = ensureTip();
  el.textContent = text;
  el.classList.add('on');
  // Position above-right of the cursor, flipping near the right/top edges.
  var pad = 12, w = el.offsetWidth, h = el.offsetHeight;
  var left = x + pad, top = y - h - pad;
  if (left + w > window.innerWidth - 4) left = x - w - pad;
  if (top < 4) top = y + pad;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function hideTip() { if (tipEl) tipEl.classList.remove('on'); }

export function installChartInteractions() {
  // Hover: show/move the tooltip while over a hit mark; hide otherwise.
  document.addEventListener('mousemove', function (e) {
    var t = (e.target as HTMLElement);
    var hit = t && t.closest ? t.closest('.chart-hit') : null;
    if (!hit) { hideTip(); return; }
    var tip = hit.getAttribute('data-tip');
    if (!tip) { hideTip(); return; }
    showTip(tip, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
  });
  document.addEventListener('mouseleave', hideTip);

  // Click: drill into the filtered session list for this data point.
  document.addEventListener('click', function (e) {
    var t = (e.target as HTMLElement);
    var hit = t && t.closest ? t.closest('.chart-hit') : null;
    if (!hit) return;
    var box = hit.closest('[data-drillbucket]');
    if (!box) return; // chart didn't opt into drill-through
    var bucketKind = box.getAttribute('data-drillbucket') || 'day';
    var by = box.getAttribute('data-drillby') || '';
    var bucketVal = hit.getAttribute('data-bucket') || '';
    var key = hit.getAttribute('data-key') || '';
    hideTip();
    drillToSessions(by, key, bucketKind, bucketVal);
  });
}
