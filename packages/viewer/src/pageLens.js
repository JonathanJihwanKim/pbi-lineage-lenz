/**
 * Page lens — what is on a report page, and where.
 *
 * Selection-first by design. The list is the browsing surface, because a list cannot
 * overlap; the canvas locates whatever the list selects. The previous layout view drew
 * every rectangle at once and became unreadable — 72 visuals overlapping 476 times on one
 * page — and the tempting fix, filtering out "chrome", turned out to be the wrong move:
 * 85 visuals in this report display measures through titles, conditional formats and
 * button links alone. Filtering would have hidden exactly the field-parameter and
 * calculation-group surfaces a reader is looking for.
 *
 * So nothing is ever filtered here. Everything is listed; one thing is drawn.
 */

import { h, replace, debounce, copyText } from './dom.js';
import { pageCanvas, describe, visibilityNote, viaLabel, viaTitle, viaRank } from './locator.js';

/** Reading order: top-to-bottom, then left-to-right, in coarse rows. */
function readingOrder(a, b) {
  const ay = a.position?.y ?? 0;
  const by = b.position?.y ?? 0;
  // A 40px band counts as the same row, so a slightly misaligned visual does not
  // jump the order.
  if (Math.abs(ay - by) > 40) return ay - by;
  return (a.position?.x ?? 0) - (b.position?.x ?? 0);
}

/**
 * Build the page lens.
 *
 * @param {object} options
 * @param {object} options.model - Viewer model.
 * @param {object} options.index - buildIndex() output.
 * @param {(ref: string) => string} [options.linkFor]
 * @param {(ref: string) => void} [options.onOpenMeasure]
 * @returns {{el: HTMLElement, select: (ref: string) => void, destroy: () => void}}
 */
export function pageLens({ model, index, linkFor, onOpenMeasure }) {
  const pages = [...(model.pages || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const state = {
    pageId: pages[0]?.id ?? null,
    selected: null,
    query: '',
  };

  const list = h('tbody');
  const canvasHost = h('div.canvas-host');
  const detailBody = h('div.panel-body');
  const countLabel = h('span.label');

  const search = h('input', {
    type: 'search',
    name: 'visual-search',
    placeholder: 'Search visuals and the fields they show',
    'aria-label': 'Search visuals on this page',
  });
  search.addEventListener('input', debounce(() => {
    state.query = search.value.trim().toLowerCase();
    render();
  }, 100));

  const pageTabs = h('div.page-tabs', { role: 'tablist' });

  const el = h('div',
    pageTabs,
    h('div.split',
      h('div.panel',
        h('div.panel-head',
          h('h2', 'Visuals'),
          h('div.field', { style: { flex: '1' } }, h('span.label', 'find'), search)),
        h('div.tbl-wrap',
          h('table.tbl',
            h('thead', h('tr', h('th', 'Visual'), h('th', 'Shows'), h('th', 'State'))),
            list)),
        h('div.panel-body', { style: { borderTop: '1px solid var(--rule)', padding: '9px 14px' } }, countLabel)),
      h('div',
        h('div.panel', { style: { marginBottom: 'var(--gap)' } },
          h('div.panel-head', h('h2', 'Location')),
          h('div.panel-body', canvasHost)),
        h('div.panel', h('div.panel-head', h('h2', 'Visual detail')), detailBody))));

  function currentPage() {
    return pages.find((p) => p.id === state.pageId) ?? pages[0] ?? null;
  }

  function pageVisuals() {
    return (index.visualsByPage.get(state.pageId) || []).slice().sort(readingOrder);
  }

  function renderTabs() {
    replace(pageTabs, pages.map((page) => h('button.page-tab', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(page.id === state.pageId),
      onClick: () => {
        state.pageId = page.id;
        state.selected = null;
        render();
      },
    }, page.name, h('span.count', String(page.visualCount)))));
  }

  function render() {
    renderTabs();

    const all = pageVisuals();
    const rows = state.query
      ? all.filter((v) =>
          describe(v).toLowerCase().includes(state.query)
          || (v.type || '').toLowerCase().includes(state.query)
          || v.fields.some((f) => (f.name || '').toLowerCase().includes(state.query)))
      : all;

    replace(list, rows.map((visual) => {
      const shows = visual.fields.length > 0
        ? h('span', { style: { color: 'var(--ink-2)' } },
            visual.fields.slice(0, 2).map((f) => f.name).filter(Boolean).join(', '),
            visual.fields.length > 2 ? h('span', { style: { color: 'var(--ink-4)' } }, ` +${visual.fields.length - 2}`) : null)
        : h('span', { style: { color: 'var(--ink-4)' } }, '—');

      return h('tr', {
        'data-ref': visual.ref,
        'aria-selected': String(state.selected === visual.ref),
        onClick: () => select(visual.ref),
      },
        h('td',
          h('span.n-model', describe(visual)),
          // A visual that displays a measure without plotting it reads as decoration
          // until it is labelled, and those are the easiest ones to overlook. Naming the
          // feature beats the old blanket "display": a text box's Values well and a
          // button's colour rule both sit outside queryState and are nothing alike.
          nonQueryVia(visual)
            ? h('span.step', { style: { marginLeft: '7px' }, title: viaTitle(nonQueryVia(visual)) },
              viaLabel(nonQueryVia(visual)))
            : null),
        h('td', shows),
        h('td', visibilityNote(visual) ?? h('span', { style: { color: 'var(--ink-4)' } }, 'visible')));
    }));

    countLabel.textContent = rows.length === all.length
      ? `${all.length} visuals on this page`
      : `${rows.length} of ${all.length} visuals`;

    if (rows.length === 0) {
      replace(list, h('tr', h('td', { colspan: '3' },
        h('div.empty', h('b', 'No visuals match'), 'Clear the search to see the whole page.'))));
    }

    renderCanvas();
    renderDetail();
  }

  function renderCanvas() {
    const page = currentPage();
    if (!page) {
      replace(canvasHost, h('div.empty', 'This report has no pages.'));
      return;
    }
    replace(canvasHost, pageCanvas({
      page,
      visuals: pageVisuals(),
      selected: state.selected,
      width: 520,
      onSelect: select,
    }));

    if (!state.selected) {
      canvasHost.append(h('div.canvas-hint',
        'Every visual on the page is outlined. Pick one to light it up.'));
    }
  }

  function select(ref) {
    state.selected = ref;
    for (const row of list.querySelectorAll('tr[data-ref]')) {
      const isSelected = row.dataset.ref === ref;
      row.setAttribute('aria-selected', String(isSelected));
      if (isSelected) row.scrollIntoView({ block: 'nearest' });
    }
    renderCanvas();
    renderDetail();
  }

  function renderDetail() {
    const visual = pageVisuals().find((v) => v.ref === state.selected);
    if (!visual) {
      replace(detailBody, h('div.empty',
        h('b', 'Nothing selected'), 'Pick a visual to see what it shows.'));
      return;
    }

    // Visuals sharing this rectangle. Genuine stacking is the one thing worth knowing
    // about overlap, so it is reported rather than drawn.
    //
    // A group's rectangle is the union of its children, so everything inside it overlaps
    // it by definition — a page-spanning group would list all 60 of its neighbours and
    // say nothing. Containers get no neighbour list.
    const neighbours = visual.role === 'container' ? [] : pageVisuals().filter((other) =>
      other.ref !== visual.ref
      && other.role !== 'container'
      && overlaps(other.position, visual.position));

    const copy = h('button.btn', {
      type: 'button',
      onClick: async () => {
        const ok = await copyText(linkFor ? linkFor(visual.ref) : visual.ref);
        if (ok) {
          copy.textContent = 'link copied';
          setTimeout(() => { copy.textContent = 'copy link'; }, 1400);
        }
      },
    }, 'copy link');

    replace(detailBody,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
        h('span.n-model', describe(visual)), h('span', { style: { flex: '1' } }), copy),

      h('dl',
        h('dt', 'type'), h('dd', visual.type || '—'),
        h('dt', 'role'), h('dd', roleLabel(visual)),
        visual.position
          ? [h('dt', 'position'),
             h('dd', `${Math.round(visual.position.x)}, ${Math.round(visual.position.y)} · ${Math.round(visual.position.width)}×${Math.round(visual.position.height)}`)]
          : null,
        h('dt', 'state'), h('dd', visual.isHidden
          ? (visual.neverShown ? 'hidden — no bookmark reveals it' : `hidden — ${visual.revealedBy.join(', ')}`)
          : 'visible')),

      visual.fields.length > 0
        ? h('div',
            h('div.label', { style: { margin: '16px 0 7px' } }, `shows (${visual.fields.length})`),
            visual.fields.map((field) => h('div', {
              style: { padding: '3px 0', cursor: field.ref && onOpenMeasure ? 'pointer' : 'default' },
              onClick: field.ref && onOpenMeasure ? () => onOpenMeasure(field.ref) : null,
            }, h('span.n-model', `${field.table ?? ''}${field.name ? `[${field.name}]` : ''}`))))
        : h('div.reason', { style: { marginTop: '14px' } },
            'This visual references no model field — it is layout or navigation.'),

      neighbours.length > 0
        ? h('div',
            h('div.label', { style: { margin: '16px 0 7px' } }, `also in this area (${neighbours.length})`),
            neighbours.slice(0, 8).map((other) => h('div', {
              style: { padding: '3px 0', cursor: 'pointer' },
              onClick: () => select(other.ref),
            }, h('span', { style: { color: 'var(--ink-2)', fontSize: '12px' } }, describe(other)))))
        : null);
  }

  render();

  return {
    el,
    select(ref) {
      const visual = index.byRef.get(ref);
      if (visual?.page) state.pageId = visual.page;
      render();
      select(ref);
    },
    destroy() {},
  };
}

function roleLabel(visual) {
  if (visual.role === 'container') return 'group container';
  if (visual.role === 'decoration') return 'layout or navigation';
  if (visual.boundFields > 0) return 'plots data';
  const via = nonQueryVia(visual);
  return via ? `shows data as a ${viaLabel(via)}` : 'displays data in text';
}

/**
 * The route this visual uses for data it does not plot, or null when it plots everything.
 *
 * Most direct wins, since `fields` is already ordered that way — a text box carrying
 * three dynamic values and one conditional colour is a text box showing dynamic values.
 */
function nonQueryVia(visual) {
  if (visual.role !== 'data' || visual.boundFields > 0) return null;
  let best = null;
  for (const field of visual.fields || []) {
    if (viaLabel(field.via) && (best === null || viaRank(field.via) < viaRank(best))) {
      best = field.via;
    }
  }
  return best;
}

/** True when two rectangles cover more than half of the smaller one. */
function overlaps(a, b) {
  if (!a || !b) return false;
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const hgt = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = w * hgt;
  if (overlap <= 0) return false;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 && overlap / smaller > 0.5;
}
