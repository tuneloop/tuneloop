// Interactive, zoomable treemap for the feature-cost breakdown. Unlike the static
// SVG charts in charts.ts, this one is DOM-based (absolutely-positioned divs) so it
// can do drill-down with a breadcrumb, a cursor-following tooltip, hover/focus
// states, and a live "roll up below $X" threshold. It's self-contained: it builds
// its own scaffold inside the host element and wires its own events.
import { esc } from './core'

interface TNode {
  name: string
  total: number
  own?: number
  children: TNode[]
  color?: string
  fill?: string
  direct?: boolean
  isOther?: boolean
  __decorated?: boolean
}

// One hue per top-level feature family; descendants are lighter shades of it.
var PALETTE = ['#0f7a55', '#b8860b', '#b4452f', '#3b6ea5', '#7d5ba6', '#1b8a8a', '#a65c2e', '#6b8e23',
  '#9c4f6e', '#5b7d3f', '#c08a3e', '#6a5acd', '#cc7a52', '#4e8d6e'];

// Lighten a hex color toward white by `amt` (0..1).
function shade(hex: string, amt: number): string {
  var n = parseInt(hex.slice(1), 16);
  var r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function fmt(v: number): string {
  return '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Build a tree from the flat API nodes ([{id,title,parentId,ownCost,subtreeCost}]),
// children sorted biggest-subtree-first. A parentId that doesn't resolve to a known
// feature is treated as a root (matches the server normalization).
function buildTree(nodes: any[], rootName: string): TNode {
  var byId: Record<string, TNode> = {};
  nodes.forEach(function (n) {
    byId[n.id] = { name: n.title || '(untitled)', total: n.subtreeCost || 0, own: n.ownCost || 0, children: [] };
  });
  var roots: TNode[] = [];
  nodes.forEach(function (n) {
    var node = byId[n.id];
    if (n.parentId && byId[n.parentId]) byId[n.parentId].children.push(node);
    else roots.push(node);
  });
  (function sortRec(list: TNode[]) {
    list.sort(function (a, b) { return b.total - a.total; });
    list.forEach(function (c) { sortRec(c.children); });
  })(roots);
  return { name: rootName, total: roots.reduce(function (s, c) { return s + c.total; }, 0), children: roots };
}

// Color each family by its root hue (lighter by depth) and add an explicit
// "(direct work)" own-cost leaf, so when you drill into a parent its children plus
// its direct spend partition the area honestly. Runs once at build time.
function decorate(node: TNode, base: string, depth: number): void {
  if (node.__decorated) return;
  node.__decorated = true;
  node.color = base;
  node.fill = shade(base, Math.min(0.55, depth * 0.16));
  if (node.children.length) {
    var childSum = node.children.reduce(function (s, c) { return s + c.total; }, 0);
    var own = node.own != null ? node.own : Math.max(0, node.total - childSum);
    if (own > 0.005) {
      node.children.unshift({ name: '(direct work)', total: own, children: [], direct: true });
    }
    node.children.forEach(function (c) { decorate(c, base, depth + 1); });
  }
}

// Squarified treemap (Bruls/Huizing/van Wijk): pack {node,value} into a rect with
// near-square tiles, area ∝ value.
function squarify(children: TNode[], x: number, y: number, w: number, h: number) {
  var out: Array<{ node: TNode; x: number; y: number; w: number; h: number }> = [];
  var items = children
    .map(function (c) { return { node: c, value: Math.max(c.total, 0), area: 0 }; })
    .filter(function (it) { return it.value > 0; })
    .sort(function (a, b) { return b.value - a.value; });
  var totalVal = items.reduce(function (s, it) { return s + it.value; }, 0);
  if (totalVal <= 0) return out;
  var scale = (w * h) / totalVal;
  items.forEach(function (it) { it.area = it.value * scale; });

  var rx = x, ry = y, rw = w, rh = h;
  var row: typeof items = [], i = 0;
  function worst(r: typeof items, side: number) {
    var sum = r.reduce(function (s, it) { return s + it.area; }, 0);
    var mx = Math.max.apply(null, r.map(function (it) { return it.area; }));
    var mn = Math.min.apply(null, r.map(function (it) { return it.area; }));
    var s2 = side * side;
    return Math.max((s2 * mx) / (sum * sum), (sum * sum) / (s2 * mn));
  }
  function layoutRow(r: typeof items, side: number, horizontal: boolean) {
    var sum = r.reduce(function (s, it) { return s + it.area; }, 0);
    var thick = sum / side;
    var pos = horizontal ? ry : rx;
    r.forEach(function (it) {
      var len = it.area / thick;
      if (horizontal) { out.push({ node: it.node, x: rx, y: pos, w: thick, h: len }); pos += len; }
      else { out.push({ node: it.node, x: pos, y: ry, w: len, h: thick }); pos += len; }
    });
    if (horizontal) { rx += thick; rw -= thick; } else { ry += thick; rh -= thick; }
  }
  while (i < items.length) {
    var horizontal = rw < rh; // lay the row along the shorter side
    var side = horizontal ? rh : rw;
    var next = items[i];
    if (row.length === 0 || worst(row.concat([next]), side) <= worst(row, side)) { row.push(next); i++; }
    else { layoutRow(row, side, horizontal); row = []; }
  }
  if (row.length) { var hz = rw < rh; layoutRow(row, hz ? rh : rw, hz); }
  return out;
}

// A drillable node = the synthetic "Other" bucket, or a real node with at least one
// non-direct child (so a leaf, or a node whose only extra tile is its own work, is
// terminal).
function drillable(n: TNode): boolean {
  return !!n.isOther || (!n.direct && !!n.children && n.children.some(function (c) { return !c.direct; }));
}

// ---- lifecycle: one live instance + a shared tooltip, so resize/teardown is clean.
var active: { chartEl: HTMLElement; render: () => void } | null = null;
var tipEl: HTMLElement | null = null;
var resizeBound = false;

function getTip(): HTMLElement {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tm-tip'; document.body.appendChild(tipEl); }
  return tipEl;
}
function onResize() { if (active && active.chartEl.isConnected) active.render(); else active = null; }

// Tear down the active treemap (called when switching to the icicle) so its resize
// handler stops firing and the tooltip hides.
export function disposeFeatTreemap(): void {
  active = null;
  if (tipEl) tipEl.style.display = 'none';
}

// Mount the interactive treemap into `host`, driven by the flat cost nodes
// ([{id,title,parentId,ownCost,subtreeCost}]). `rootName` labels the breadcrumb
// root (e.g. "All features" / "All PRs"). Flat node sets (no parentId) render as a
// plain treemap — no drill-down or "(direct work)" tiles, just the roll-up slider.
export function renderFeatTreemap(host: HTMLElement, nodes: any[], rootName: string): void {
  var root = buildTree(nodes, rootName || 'All features');
  root.children.forEach(function (c, i) { decorate(c, PALETTE[i % PALETTE.length], 0); });

  host.innerHTML =
    '<div class="tm">' +
      '<div class="tm-bar">' +
        '<div class="tm-crumb"></div>' +
        '<label class="tm-thr">Roll up below ' +
          '<input type="range" min="0" max="3" step="0.05" value="0.45">' +
          '<span class="tm-thrval"></span>' +
        '</label>' +
      '</div>' +
      '<div class="tm-chart"></div>' +
    '</div>';
  var chartEl = host.querySelector('.tm-chart') as HTMLElement;
  var crumbEl = host.querySelector('.tm-crumb') as HTMLElement;
  var slider = host.querySelector('.tm-thr input') as HTMLInputElement;
  var thrVal = host.querySelector('.tm-thrval') as HTMLElement;

  var stack: TNode[] = [root];
  var threshold = 1; // dollars; below this, siblings collapse into "Other"

  function render() {
    var node = stack[stack.length - 1];
    // breadcrumb (every level but the last is a clickable ancestor)
    crumbEl.innerHTML = stack.map(function (n, i) {
      return i === stack.length - 1
        ? '<span>' + esc(n.name) + ' &middot; ' + fmt(n.total) + '</span>'
        : '<a data-i="' + i + '">' + esc(n.name) + '</a>';
    }).join('<span class="sep">›</span>');
    Array.prototype.forEach.call(crumbEl.querySelectorAll('a'), function (a: HTMLElement) {
      a.onclick = function () { stack = stack.slice(0, Number(a.getAttribute('data-i')) + 1); render(); };
    });

    var W = chartEl.clientWidth, H = chartEl.clientHeight;
    chartEl.innerHTML = '';
    // The direct-work tile is always kept; only real sub-features roll up into "Other".
    var kids = (node.children || []).filter(function (c) { return c.total > 0; });
    var big: TNode[] = kids.filter(function (c) { return c.direct; });
    var small: TNode[] = [];
    kids.forEach(function (c) {
      if (c.direct) return;
      if (c.total >= threshold) big.push(c); else small.push(c);
    });
    if (small.length > 1) {
      big.push({
        name: 'Other (' + small.length + ')',
        total: small.reduce(function (s, c) { return s + c.total; }, 0),
        children: small, color: '#9a948a', fill: '#bdb6a8', isOther: true,
      });
    } else if (small.length === 1) big.push(small[0]);

    squarify(big, 0, 0, W, H).forEach(function (c) {
      var n = c.node;
      var el = document.createElement('div');
      var canDrill = drillable(n);
      el.className = 'tm-cell' + (n.direct ? ' direct' : '') + (canDrill ? ' haskids' : '') +
        (c.w < 46 || c.h < 26 ? ' tiny' : '');
      el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
      el.style.width = c.w + 'px'; el.style.height = c.h + 'px';
      // backgroundColor (not the `background` shorthand) so the .direct CSS stripe
      // background-image isn't wiped out by the inline style.
      el.style.backgroundColor = n.fill || n.color || '#888';
      el.tabIndex = 0;
      el.innerHTML = '<span class="l">' + esc(n.name) + '</span><span class="v">' + fmt(n.total) + '</span>';
      el.onmousemove = function (e) { showTip(e, n, node.total); };
      el.onmouseleave = function () { getTip().style.display = 'none'; };
      el.onclick = function () { if (canDrill) { stack.push(n); getTip().style.display = 'none'; render(); } };
      el.onkeydown = function (e) { if (e.key === 'Enter' && canDrill) { stack.push(n); render(); } };
      chartEl.appendChild(el);
    });
  }

  function showTip(e: MouseEvent, n: TNode, parentTotal: number) {
    var tip = getTip();
    var pct = parentTotal ? (n.total / parentTotal * 100) : 0;
    var subs = (n.children || []).filter(function (c) { return !c.direct; }).length;
    tip.innerHTML = '<b>' + esc(n.name) + '</b><br>' + fmt(n.total) +
      ' <span class="pct">(' + pct.toFixed(1) + '% of ' + esc(stack[stack.length - 1].name) + ')</span>' +
      (subs ? '<br>' + subs + ' sub-feature' + (subs > 1 ? 's' : '') + ' — click to open' : (n.direct ? '<br>spend on this feature itself' : ''));
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 290) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  }

  slider.oninput = function () {
    // slider 0..3 → $0..$50 on a soft curve, so the low end (where the long tail
    // lives) gets fine control.
    threshold = Math.max(0.01, Math.pow(Number(slider.value) / 3, 2) * 50);
    thrVal.textContent = fmt(threshold);
    render();
  };
  threshold = Math.max(0.01, Math.pow(Number(slider.value) / 3, 2) * 50);
  thrVal.textContent = fmt(threshold);

  active = { chartEl: chartEl, render: render };
  if (!resizeBound) { window.addEventListener('resize', onResize); resizeBound = true; }
  render();
}
