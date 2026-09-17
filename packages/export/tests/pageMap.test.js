/**
 * Page maps. Every assertion here is a way the map silently fails in its strictest
 * destination — Power BI's image URL column — rather than a matter of taste.
 */

import { describe, it, expect } from 'vitest';
import { pageMapDataUri, attachPageMaps } from '../src/pageMap.js';

const visual = (id, x, y, width, height, extra = {}) => ({ id, page: 'p1', position: { x, y, width, height }, ...extra });
const svgOf = (uri) => decodeURIComponent(uri.replace('data:image/svg+xml;utf8,', ''));

describe('pageMapDataUri', () => {
  const page = { id: 'p1', width: 1280, height: 720 };
  const card = visual('card', 640, 360, 320, 180);
  const others = [card, visual('table', 0, 0, 640, 720), visual('copy', 0, 0, 640, 720)];

  it('never contains a raw # or a double quote', () => {
    const uri = pageMapDataUri(page, others, card);
    expect(uri.startsWith('data:image/svg+xml;utf8,<svg ')).toBe(true);
    expect(uri).not.toContain('#');
    expect(uri).not.toContain('"');
    expect(svgOf(uri)).toMatch(/fill='rgb\(230,81,0\)'/);
  });

  it('scales to the page it is on, not to 1280 × 720', () => {
    const wide = pageMapDataUri({ width: 1920, height: 1080 }, [visual('v', 960, 540, 480, 270)], visual('v', 960, 540, 480, 270));
    expect(svgOf(wide)).toContain("width='320' height='180'");
    expect(svgOf(wide)).toContain("<rect x='160' y='90' width='80' height='45'/>");
  });

  it('draws identical rectangles once, and shares paint on a group', () => {
    const svg = svgOf(pageMapDataUri(page, others, card));
    expect(svg.match(/<rect x='0' y='0' width='160' height='180'\/>/g)).toHaveLength(1);
    expect(svg.match(/fill=/g)).toHaveLength(3);
  });

  it('keeps the highlighted visual and drops the rest when over the length cap', () => {
    const crowd = Array.from({ length: 400 }, (_, i) => visual(`v${i}`, i * 3, i, 10 + i, 10));
    const uri = pageMapDataUri(page, [...crowd, card], card, { maxLength: 1000 });
    expect(uri.length).toBeLessThanOrEqual(1000);
    expect(svgOf(uri)).toContain("<rect x='160' y='90' width='80' height='45'/>");
  });

  it('leaves hidden visuals and those without a position off the map', () => {
    const svg = svgOf(pageMapDataUri(page, [card, visual('hidden', 0, 0, 100, 100, { isHidden: true }), { id: 'x' }], card));
    expect(svg).not.toContain("width='25' height='25'");
    expect(pageMapDataUri(page, [], { id: 'nowhere' })).toBeNull();
  });

  it('attaches one to every visual in a model', () => {
    const model = { pages: [page], visuals: [card, visual('other', 0, 0, 10, 10)] };
    attachPageMaps(model);
    expect(model.visuals.every((v) => v.pageMap?.startsWith('data:image/svg+xml'))).toBe(true);
  });
});
