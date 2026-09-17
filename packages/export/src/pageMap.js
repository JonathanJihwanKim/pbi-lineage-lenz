/**
 * A page map per visual: the page as grey rectangles, the visual filled in.
 *
 * "Where exactly is this visual" decides whether a change is safe, and answering it in
 * coordinates answers it in the one format a person cannot read — nobody has located a
 * visual from "x: 742, y: 118, 240 × 90". A thumbnail with the visual highlighted answers
 * in one glance whether a column feeds a headline figure at the top of page one or a
 * detail table nobody scrolls to.
 *
 * Emitted as a `data:` URI so it renders wherever the text goes — in a markdown file, in
 * the JSON a tool consumes, and in Power BI itself on a column marked as an image URL.
 * That last destination is the strictest, and every rule below exists because of it:
 *
 * - **No `#`.** Power BI reads `#` in an image URL as a fragment and silently renders a
 *   blank. Every colour is `rgb()`, and a stray `#` is percent-encoded regardless.
 * - **Single-quoted attributes.** The URI goes into JSON and from there into a DAX string
 *   literal; double quotes would need escaping at every level and break at one of them.
 * - **Shared paint on a `<g>`.** Repeating fill and stroke on sixty rectangles is most of
 *   the payload.
 * - **Duplicates dropped.** Grouped containers produce identical rectangles at identical
 *   coordinates; drawing both changes nothing and costs length.
 * - **A length cap.** Power BI truncates long values. Past the cap, the other visuals go
 *   and the page outline and the highlighted visual stay — the part that answers the
 *   question.
 * - **The page's own size.** Custom page sizes are common; assuming 1280 × 720 puts every
 *   rectangle in the wrong place.
 */

const PAINT = Object.freeze({
  page: { fill: 'rgb(250,250,250)', stroke: 'rgb(189,189,189)' },
  other: { fill: 'rgb(224,224,224)', stroke: 'rgb(176,176,176)' },
  highlight: { fill: 'rgb(230,81,0)', stroke: 'rgb(150,50,0)' },
});

export const PAGE_MAP_DEFAULTS = Object.freeze({ width: 320, maxLength: 30000 });

const PREFIX = 'data:image/svg+xml;utf8,';

/**
 * @param {object} page - A viewer-model page (`width`, `height`).
 * @param {Array<object>} visuals - The visuals on that page.
 * @param {object} highlight - The visual to fill in.
 * @param {{width?: number, maxLength?: number}} [options]
 * @returns {string|null} A `data:image/svg+xml` URI, or null when the visual has no position.
 */
export function pageMapDataUri(page, visuals, highlight, options = {}) {
  const { width, maxLength } = { ...PAGE_MAP_DEFAULTS, ...options };
  if (!highlight?.position) return null;

  const pageWidth = Number(page?.width) > 0 ? Number(page.width) : 1280;
  const pageHeight = Number(page?.height) > 0 ? Number(page.height) : 720;
  const scale = width / pageWidth;
  const height = Math.max(1, Math.round(pageHeight * scale));

  const rect = (position) => {
    const x = Math.round((Number(position.x) || 0) * scale);
    const y = Math.round((Number(position.y) || 0) * scale);
    const w = Math.max(1, Math.round((Number(position.width) || 0) * scale));
    const h = Math.max(1, Math.round((Number(position.height) || 0) * scale));
    return { x, y, w, h, text: `<rect x='${x}' y='${y}' width='${w}' height='${h}'/>` };
  };

  const target = rect(highlight.position);
  const seen = new Set([target.text]);
  const others = [];
  for (const visual of visuals || []) {
    if (visual === highlight || !visual.position || visual.isHidden) continue;
    const r = rect(visual.position);
    if (seen.has(r.text)) continue;
    seen.add(r.text);
    others.push(r.text);
  }

  const group = (paint, body) => (body
    ? `<g fill='${paint.fill}' stroke='${paint.stroke}' stroke-width='1'>${body}</g>`
    : '');
  const build = (otherRects) => [
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>`,
    group(PAINT.page, `<rect x='0' y='0' width='${width}' height='${height}'/>`),
    group(PAINT.other, otherRects.join('')),
    group(PAINT.highlight, target.text),
    '</svg>',
  ].join('');

  let uri = PREFIX + encode(build(others));
  if (uri.length > maxLength) uri = PREFIX + encode(build([]));
  return uri;
}

/** Percent-encode only what breaks a data URI: `%` itself and `#`. */
function encode(svg) {
  return svg.replace(/%/g, '%25').replace(/#/g, '%23');
}

/**
 * Put a `pageMap` on every visual in a viewer model. Opt-in — it is pure payload for
 * anyone not rendering it — so this runs only when asked.
 * @param {object} model - A viewer model, mutated.
 * @param {object} [options] - See pageMapDataUri().
 * @returns {object} The same model.
 */
export function attachPageMaps(model, options = {}) {
  const pages = new Map((model.pages || []).map((page) => [page.id, page]));
  const byPage = new Map();
  for (const visual of model.visuals || []) {
    if (!byPage.has(visual.page)) byPage.set(visual.page, []);
    byPage.get(visual.page).push(visual);
  }
  for (const visual of model.visuals || []) {
    visual.pageMap = pageMapDataUri(pages.get(visual.page), byPage.get(visual.page), visual, options);
  }
  return model;
}
