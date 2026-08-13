/**
 * Page canvas — where a visual sits on its page.
 *
 * Drawing a whole page at once is what made the old layout view unreadable: a real page
 * carries 72 visuals whose rectangles overlap 476 times, so everything covers everything.
 * The overlap is a symptom of simultaneity, not of the data. Draw the page as faint
 * context and emphasise exactly one rectangle, and the problem cannot occur — which also
 * means nothing has to be filtered out to compensate.
 */

import { svg, h } from './dom.js';

/**
 * Render a page with one visual highlighted.
 *
 * @param {object} options
 * @param {object} options.page - Viewer-model page, carrying `width`/`height`.
 * @param {Array<object>} options.visuals - Every visual on the page.
 * @param {string} [options.selected] - Ref of the visual to emphasise.
 * @param {number} [options.width=320] - Rendered width in CSS pixels.
 * @param {(ref: string) => void} [options.onSelect]
 * @param {boolean} [options.interactive=true]
 * @returns {SVGElement}
 */
export function pageCanvas({ page, visuals, selected, width = 320, onSelect, interactive = true }) {
  // Power BI's default canvas, used when a page does not state its own size.
  const pageWidth = page?.width || 1280;
  const pageHeight = page?.height || 720;

  const root = svg('svg', {
    viewBox: `0 0 ${pageWidth} ${pageHeight}`,
    width,
    height: Math.round((width * pageHeight) / pageWidth),
    class: 'page-canvas',
    role: 'img',
    'aria-label': `Layout of ${page?.name || 'page'}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  root.append(svg('rect', { class: 'pc-bg', x: 0, y: 0, width: pageWidth, height: pageHeight }));

  const selectedVisual = visuals.find((v) => v.ref === selected);

  // Context first, so the emphasised rectangle is never painted over.
  for (const visual of visuals) {
    const box = visual.position;
    if (!box || visual.ref === selected) continue;

    // A container's rectangle is the union of its children; drawing it adds a large
    // box that hides them without adding information.
    if (visual.role === 'container') continue;

    const rect = svg('rect', {
      class: `pc-ghost${visual.isHidden ? ' pc-hidden' : ''}`,
      x: box.x, y: box.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1),
      rx: 2,
    });

    if (interactive && onSelect) {
      rect.classList.add('pc-clickable');
      rect.addEventListener('click', () => onSelect(visual.ref));
      rect.append(svg('title', {}, describe(visual)));
    }
    root.append(rect);
  }

  if (selectedVisual?.position) {
    const box = selectedVisual.position;
    const w = Math.max(box.width, 1);
    const hgt = Math.max(box.height, 1);

    root.append(svg('rect', {
      class: 'pc-selected',
      x: box.x, y: box.y, width: w, height: hgt, rx: 2,
    }));

    // Crosshair rules out to the canvas edge: on a dense page the highlight alone is
    // easy to lose, and the rules say where it sits without needing a legend.
    const cx = box.x + w / 2;
    const cy = box.y + hgt / 2;
    root.append(svg('line', { class: 'pc-crosshair', x1: 0, y1: cy, x2: pageWidth, y2: cy }));
    root.append(svg('line', { class: 'pc-crosshair', x1: cx, y1: 0, x2: cx, y2: pageHeight }));
    root.append(svg('title', {}, describe(selectedVisual)));
  }

  return root;
}

/** Human label for a visual, falling back through title, type, then id. */
export function describe(visual) {
  const name = visual.title || visual.type || visual.id;
  return visual.isHidden ? `${name} (hidden)` : name;
}

/**
 * A locator card: the page thumbnail, the page name, and the visual's name.
 * Used wherever a visual is referenced — the "shown in" list, and the handoff file,
 * where it answers "where is this measure actually shown?" without Power BI.
 *
 * @param {object} options
 * @param {object} options.page
 * @param {Array<object>} options.visuals - Every visual on that page.
 * @param {object} options.visual - The one to locate.
 * @param {(ref: string) => void} [options.onSelect]
 * @returns {HTMLElement}
 */
export function locatorCard({ page, visuals, visual, via, onSelect }) {
  const card = h('div.locator', {
    role: onSelect ? 'button' : null,
    tabindex: onSelect ? '0' : null,
  },
    pageCanvas({ page, visuals, selected: visual.ref, width: 168, interactive: false }),
    h('div.locator-meta',
      h('div.locator-name', describe(visual)),
      h('div.label', page?.name || visual.page),
      visual.type ? h('div.locator-type', visual.type) : null,
      viaNote(via),
      visibilityNote(visual)));

  if (onSelect) {
    card.addEventListener('click', () => onSelect(visual.ref));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(visual.ref);
      }
    });
  }

  return card;
}

/**
 * How a visual reaches the field, in a reader's words rather than a JSON path.
 *
 * A count cannot answer this. Seven visuals showing a measure is seven different
 * situations: four charts plotting it, a text box printing it as a dynamic value, a
 * button whose caption changes with it. Someone asked to check a number needs to know
 * which one they are looking at before they open the report.
 */
const VIA_TEXT = {
  query: null, // plotted — the default reading, so saying it adds nothing
  value: ['dynamic value', 'A measure placed in the text box’s Values well'],
  parameter: ['field parameter', 'Not shown by default — a field parameter slicer selects it'],
  title: ['dynamic title', 'Displayed in the title, not plotted'],
  filter: ['filter', 'Filters this visual'],
  action: ['link', 'Builds the navigation target, never displayed'],
  format: ['conditional formatting', 'Drives colour, labels or size — the value itself is not shown'],
};

/** Short name for a route, or null when the field is simply plotted. */
export function viaLabel(via) {
  return VIA_TEXT[via]?.[0] ?? null;
}

/** Position in the most-direct-first order. Unknown routes sort last. */
export function viaRank(via) {
  const order = Object.keys(VIA_TEXT).indexOf(via);
  return order === -1 ? Number.MAX_SAFE_INTEGER : order;
}

/** One-line explanation of a route, for a tooltip. */
export function viaTitle(via) {
  return VIA_TEXT[via]?.[1] ?? null;
}

/** Badge naming the route, or null when the field is simply plotted. */
export function viaNote(via) {
  const label = viaLabel(via);
  return label ? h('div.vis-note', { title: viaTitle(via) }, label) : null;
}

/**
 * State line for a hidden visual.
 *
 * "Hidden" on its own is misleading — most hidden visuals are revealed by a button, and
 * a reader who sees only "hidden" concludes the content is gone.
 *
 * @param {object} visual
 * @returns {HTMLElement|null}
 */
export function visibilityNote(visual) {
  if (!visual.isHidden) return null;

  if (visual.neverShown) {
    return h('div.vis-note.vis-dead', { title: 'No bookmark in this report reveals it' },
      'hidden · never shown');
  }

  const first = visual.revealedBy[0];
  const extra = visual.revealedBy.length - 1;
  return h('div.vis-note.vis-revealed', {
    title: `Revealed by: ${visual.revealedBy.join(', ')}`,
  }, `shown by “${first}”${extra > 0 ? ` +${extra}` : ''}`);
}
