/**
 * Lineage graph — a layered DAG from physical source to report visual.
 *
 * Hand-rolled rather than D3: the layout is a fixed five-lane flow, which is a fraction
 * of what a force simulation costs, and D3 would add ~270 KB to every handoff file that
 * ever gets forwarded. The lanes also encode meaning that a force layout would scramble —
 * data always travels left to right, source to screen.
 */

import { svg, h } from './dom.js';
import { VOCAB } from './names.js';

/** Left-to-right lanes. The order is the direction data actually flows. */
const LANES = ['source', 'table', 'column', 'measure', 'visual'];
const LANE_LABELS = {
  source: 'source system',
  table: 'model table',
  column: 'column',
  measure: 'measure',
  visual: 'visual',
};

const NODE_W = 190;
const NODE_H = 34;
const LANE_GAP = 66;
const ROW_GAP = 12;
const PAD = { top: 34, right: 24, bottom: 20, left: 24 };

/**
 * Build the trace graph for one measure: everything it depends on, and where it is shown.
 *
 * @param {string} measureRef
 * @param {object} model - Viewer model.
 * @param {object} index - buildIndex() output.
 * @returns {{nodes: Array, edges: Array}}
 */
export function buildTraceGraph(measureRef, model, index) {
  const nodes = new Map();
  const edges = [];
  const seen = new Set();

  const add = (id, lane, label, sublabel, ref) => {
    if (!nodes.has(id)) nodes.set(id, { id, lane, label, sublabel, ref });
    return id;
  };
  const link = (from, to) => {
    if (from && to) edges.push({ from, to });
  };

  const walkMeasure = (ref, depth) => {
    if (seen.has(ref) || depth > 16) return null;
    seen.add(ref);

    const measure = index.byRef.get(ref);
    if (!measure || measure.kind !== 'measures') return null;

    const measureId = add(ref, 'measure', measure.name, measure.table, ref);

    for (const columnRef of measure.dependsOn.columns) {
      const column = index.byRef.get(`column:${columnRef}`);
      if (!column) continue;

      const columnId = add(column.ref, 'column', column.name, column.table, column.ref);
      link(columnId, measureId);

      const tableId = add(`table:${column.table}`, 'table', column.table, null, `table:${column.table}`);
      link(tableId, columnId);

      // The source lane only appears when a physical origin was actually resolved;
      // an invented node here would imply lineage the model never proved.
      const table = model.tables.find((t) => t.name === column.table);
      if (table?.physical?.table) {
        const sourceId = add(
          `phys:${table.physicalPath}`,
          'source',
          table.physical.table,
          [table.physical.project, table.physical.schema].filter(Boolean).join('.') || table.physical.system,
          null
        );
        link(sourceId, tableId);
      }
    }

    for (const childName of measure.dependsOn.measures) {
      const direct = `measure:${childName}`;
      const childRef = index.byRef.has(direct)
        ? direct
        : model.measures.find((m) => m.name === childName.replace(/^.*\[|\]$/g, ''))?.ref;
      const childId = childRef ? walkMeasure(childRef, depth + 1) : null;
      link(childId, measureId);
    }

    return measureId;
  };

  const rootId = walkMeasure(measureRef, 0);

  for (const visualRef of index.byRef.get(measureRef)?.usedByVisuals || []) {
    const visual = index.byRef.get(visualRef);
    if (!visual) continue;
    const page = model.pages.find((p) => p.id === visual.page);
    const visualId = add(visualRef, 'visual', visual.title || visual.id, page?.name || visual.page, visualRef);
    link(rootId, visualId);
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Lay out and render a graph.
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {object} options
 * @param {import('./names.js').NameState} options.names
 * @param {(ref: string) => void} [options.onSelect]
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function graphView(graph, { names, onSelect } = {}) {
  const wrap = h('div.graph-wrap');
  let unsubscribe = () => {};

  function render() {
    const byLane = new Map(LANES.map((lane) => [lane, []]));
    for (const node of graph.nodes) byLane.get(node.lane)?.push(node);

    const activeLanes = LANES.filter((lane) => byLane.get(lane).length > 0);
    const rows = Math.max(1, ...activeLanes.map((lane) => byLane.get(lane).length));

    const width = PAD.left + PAD.right + activeLanes.length * NODE_W + Math.max(0, activeLanes.length - 1) * LANE_GAP;
    const height = PAD.top + PAD.bottom + rows * (NODE_H + ROW_GAP);

    const position = new Map();
    activeLanes.forEach((lane, laneIndex) => {
      const items = byLane.get(lane);
      const laneHeight = items.length * (NODE_H + ROW_GAP) - ROW_GAP;
      const top = PAD.top + (height - PAD.top - PAD.bottom - laneHeight) / 2;
      items.forEach((node, rowIndex) => {
        position.set(node.id, {
          x: PAD.left + laneIndex * (NODE_W + LANE_GAP),
          y: top + rowIndex * (NODE_H + ROW_GAP),
        });
      });
    });

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': 'Lineage graph',
      style: `max-width:100%;height:auto;min-height:${Math.min(height, 520)}px`,
    });

    // Lane guides and captions.
    activeLanes.forEach((lane, i) => {
      const x = PAD.left + i * (NODE_W + LANE_GAP);
      root.append(svg('text', { class: 'g-lane', x: x + 1, y: 16 }, LANE_LABELS[lane]));
      root.append(svg('line', { class: 'g-lane-rule', x1: x, y1: 24, x2: x + NODE_W, y2: 24 }));
    });

    // Edges first so nodes sit on top.
    const edgeEls = new Map();
    for (const edge of graph.edges) {
      const from = position.get(edge.from);
      const to = position.get(edge.to);
      if (!from || !to) continue;

      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;

      const path = svg('path', {
        class: 'g-edge',
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      });
      root.append(path);
      edgeEls.set(`${edge.from}->${edge.to}`, path);
    }

    const nodeEls = new Map();
    for (const node of graph.nodes) {
      const pos = position.get(node.id);
      if (!pos) continue;

      const group = svg('g', {
        class: 'g-node',
        'data-kind': node.lane,
        transform: `translate(${pos.x},${pos.y})`,
        tabindex: '0',
        role: 'button',
      });

      // In source vocabulary the physical name leads wherever one exists.
      const useSource = names?.vocab === VOCAB.SOURCE;
      const primary = useSource && node.lane === 'source' ? node.label : node.label;
      const secondary = node.sublabel;

      group.append(svg('rect', { width: NODE_W, height: NODE_H, rx: 3 }));
      group.append(svg('text', { class: 'g-kind', x: 10, y: 11 }, truncate(secondary || node.lane, 30)));
      group.append(svg('text', { x: 10, y: 23 }, truncate(primary, 26)));

      const highlight = (on) => {
        for (const [key, path] of edgeEls) {
          const touches = key.startsWith(`${node.id}->`) || key.endsWith(`->${node.id}`);
          path.classList.toggle('lit', on && touches);
        }
        group.classList.toggle('lit', on);
      };

      group.addEventListener('mouseenter', () => highlight(true));
      group.addEventListener('mouseleave', () => highlight(false));
      group.addEventListener('focus', () => highlight(true));
      group.addEventListener('blur', () => highlight(false));
      if (node.ref) {
        group.addEventListener('click', () => onSelect?.(node.ref));
        group.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(node.ref); }
        });
      }

      group.append(svg('title', {}, [secondary, primary].filter(Boolean).join(' · ')));
      root.append(group);
      nodeEls.set(node.id, group);
    }

    wrap.replaceChildren(root);
    enablePanZoom(root, width, height);
  }

  if (names) unsubscribe = names.subscribe(render);
  render();

  return { el: wrap, destroy: () => unsubscribe() };
}

/** Drag to pan, wheel to zoom, both driven through the viewBox. */
function enablePanZoom(root, width, height) {
  const view = { x: 0, y: 0, w: width, h: height };
  let dragging = null;

  const apply = () => root.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);

  root.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    root.setPointerCapture(event.pointerId);
  });
  root.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const scale = view.w / root.clientWidth;
    view.x = dragging.vx - (event.clientX - dragging.x) * scale;
    view.y = dragging.vy - (event.clientY - dragging.y) * scale;
    apply();
  });
  const end = (event) => {
    dragging = null;
    try { root.releasePointerCapture(event.pointerId); } catch { /* pointer already gone */ }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  root.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
    const rect = root.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    const nw = Math.min(width * 4, Math.max(width * 0.25, view.w * factor));
    const nh = nw * (height / width);
    view.x += (view.w - nw) * fx;
    view.y += (view.h - nh) * fy;
    view.w = nw;
    view.h = nh;
    apply();
  }, { passive: false });
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
