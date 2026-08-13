/**
 * Model lens — the shape of the data model, one table at a time.
 *
 * The question this answers is "what am I looking at?", which a relationship list cannot
 * answer. 87 rows of `fact.date_fk -> Time Period.date_sk` is a fact about the file; "16
 * facts around 24 dimensions, and this one joins to nine of them" is a fact about the
 * model.
 *
 * Selection-first, for the reason the page lens is: drawing 61 tables and 87 edges at once
 * produces a hairball, and the honest fix is to draw less rather than to hide some. The
 * list holds everything — including the 20 tables in no relationship at all, which are
 * where field parameters and measure holders live and are exactly what a newcomer cannot
 * find. The canvas draws one neighbourhood.
 */

import { h, svg, replace, debounce, copyText } from './dom.js';
import { describeModelShape, neighbourhood, describeRole, TABLE_ROLE, ROLE_ORDER } from './modelShape.js';
import { physicalPath } from './names.js';

/**
 * Build the model lens.
 *
 * @param {object} options
 * @param {object} options.model - Viewer model.
 * @param {(ref: string) => string} [options.linkFor]
 * @param {(ref: string) => void} [options.onOpenColumn] - Jump to a column in the source map.
 * @returns {{el: HTMLElement, select: (ref: string) => void, destroy: () => void}}
 */
export function modelLens({ model, linkFor, onOpenColumn }) {
  const shape = describeModelShape(model);
  const byName = new Map((model.tables || []).map((t) => [t.name, t]));

  const state = { query: '', role: 'all', selected: null };

  const list = h('tbody');
  const canvasHost = h('div.canvas-host');
  const detailBody = h('div.panel-body');
  const countLabel = h('span.label');

  const search = h('input', {
    type: 'search',
    name: 'table-search',
    placeholder: 'Search tables — model name or physical source',
    'aria-label': 'Search tables',
  });
  search.addEventListener('input', debounce(() => {
    state.query = search.value.trim().toLowerCase();
    render();
  }, 100));

  const roleTabs = h('div.page-tabs', { role: 'tablist' });

  const el = h('div',
    h('div.shape-summary', ...summaryChips(shape)),
    roleTabs,
    h('div.split',
      h('div.panel',
        h('div.panel-head',
          h('h2', 'Tables'),
          h('div.field', { style: { flex: '1' } }, h('span.label', 'find'), search)),
        h('div.tbl-wrap',
          h('table.tbl',
            h('thead', h('tr', h('th', 'Table'), h('th', 'Source'), h('th', 'Joins'))),
            list)),
        h('div.panel-body', { style: { borderTop: '1px solid var(--rule)', padding: '9px 14px' } }, countLabel)),
      h('div',
        h('div.panel', { style: { marginBottom: 'var(--gap)' } },
          h('div.panel-head', h('h2', 'Neighbourhood')),
          h('div.panel-body', canvasHost)),
        h('div.panel', h('div.panel-head', h('h2', 'Table detail')), detailBody))));

  function rows() {
    const all = [...shape.tables.values()].sort((a, b) => {
      const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
      return byRole !== 0 ? byRole : b.degree - a.degree || a.name.localeCompare(b.name);
    });

    return all.filter((entry) => {
      if (state.role !== 'all' && entry.role !== state.role) return false;
      if (!state.query) return true;
      const table = byName.get(entry.name);
      return entry.name.toLowerCase().includes(state.query)
        || (table?.physicalPath || '').toLowerCase().includes(state.query);
    });
  }

  function renderRoleTabs() {
    const options = [
      { key: 'all', label: 'all', count: shape.tables.size },
      ...ROLE_ORDER.map((role) => ({ key: role, label: role, count: shape.counts[role] })),
    ];
    replace(roleTabs, options.map((option) => h('button.page-tab', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(option.key === state.role),
      title: option.key === 'all' ? 'Every table' : describeRole(option.key),
      onClick: () => {
        state.role = option.key;
        render();
      },
    }, option.label, h('span.count', String(option.count)))));
  }

  function render() {
    renderRoleTabs();
    const visible = rows();

    replace(list, visible.map((entry) => {
      const table = byName.get(entry.name);
      return h('tr', {
        'data-name': entry.name,
        'aria-selected': String(state.selected === entry.name),
        onClick: () => select(entry.name),
      },
        h('td',
          h('span.n-model', entry.name),
          h('span.step', { style: { marginLeft: '7px' }, title: describeRole(entry.role) }, entry.role)),
        h('td', table?.physicalPath
          ? h('span.n-source', physicalPath(table.physicalPath))
          : h('span', { style: { color: 'var(--ink-4)' } }, '—')),
        h('td', entry.degree > 0
          ? h('span.mono', { style: { color: 'var(--ink-2)' } }, String(entry.degree))
          : h('span', { style: { color: 'var(--ink-4)' } }, '—')));
    }));

    countLabel.textContent = visible.length === shape.tables.size
      ? `${shape.tables.size} tables`
      : `${visible.length} of ${shape.tables.size} tables`;

    if (visible.length === 0) {
      replace(list, h('tr', h('td', { colspan: '3' },
        h('div.empty', h('b', 'No tables match'), 'Clear the search to see the whole model.'))));
    }

    renderCanvas();
    renderDetail();
  }

  function renderCanvas() {
    const near = state.selected ? neighbourhood(shape, state.selected) : null;
    if (!near) {
      replace(canvasHost, h('div.empty',
        h('b', 'Nothing selected'),
        'Pick a table to see what it joins to.'));
      return;
    }
    if (near.edges.length === 0) {
      replace(canvasHost, h('div.empty',
        h('b', `${near.name} joins to nothing`),
        describeRole(near.role)));
      return;
    }
    replace(canvasHost, joinDiagram(near, { onSelect: select }));
  }

  function renderDetail() {
    const near = state.selected ? neighbourhood(shape, state.selected) : null;
    if (!near) {
      replace(detailBody, h('div.empty',
        h('b', 'Nothing selected'), 'Pick a table to see its relationships.'));
      return;
    }

    const table = byName.get(near.name);
    const copy = h('button.btn', {
      type: 'button',
      onClick: async () => {
        const ok = await copyText(linkFor ? linkFor(`table:${near.name}`) : `table:${near.name}`);
        if (ok) {
          copy.textContent = 'link copied';
          setTimeout(() => { copy.textContent = 'copy link'; }, 1400);
        }
      },
    }, 'copy link');

    replace(detailBody,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
        h('span.n-model', near.name),
        h('span.step', { title: describeRole(near.role) }, near.role),
        h('span', { style: { flex: '1' } }),
        copy),
      table?.physicalPath
        ? h('div.n-source', { style: { marginBottom: '10px' } }, physicalPath(table.physicalPath))
        : null,
      h('div', { style: { color: 'var(--ink-3)', marginBottom: '12px' } }, describeRole(near.role)),

      near.edges.length > 0
        ? h('table.tbl',
            h('thead', h('tr',
              h('th', 'Direction'), h('th', 'Table'), h('th', 'On'), h('th', 'Cross-filter'))),
            h('tbody', near.edges.map((edge) => h('tr',
              h('td', h('span.step', edge.direction === 'out' ? 'joins to' : 'joined from')),
              h('td', h('a.n-model', {
                href: '#',
                onClick: (event) => {
                  event.preventDefault();
                  select(edge.other);
                },
              }, edge.other)),
              h('td', h('span.mono', {
                style: { color: 'var(--ink-2)', cursor: onOpenColumn ? 'pointer' : null },
                title: 'Open in the source map',
                onClick: () => onOpenColumn?.(columnRefFor(edge)),
              }, `${edge.fromColumn} → ${edge.toColumn}`)),
              h('td',
                edge.crossFilter === 'bothDirections'
                  ? h('span.conf.conf-inferred', { title: 'Filters travel both ways' }, 'both')
                  : h('span', { style: { color: 'var(--ink-4)' } }, 'single'),
                edge.isActive ? null : h('span.conf.conf-unknown', { style: { marginLeft: '6px' } }, 'inactive'))))))
        : null);
  }

  function columnRefFor(edge) {
    return edge.direction === 'out'
      ? `column:${state.selected}[${edge.fromColumn}]`
      : `column:${edge.other}[${edge.fromColumn}]`;
  }

  function select(name) {
    state.selected = name;
    for (const row of list.querySelectorAll('tr[data-name]')) {
      const isSelected = row.dataset.name === name;
      row.setAttribute('aria-selected', String(isSelected));
      if (isSelected) row.scrollIntoView({ block: 'nearest' });
    }
    renderCanvas();
    renderDetail();
  }

  render();

  return {
    el,
    select(ref) {
      const name = /^table:(.*)$/.exec(ref)?.[1] ?? ref;
      if (!shape.tables.has(name)) return;
      // A table filtered out of the list cannot be selected in it, so widen first.
      if (state.role !== 'all' && shape.tables.get(name).role !== state.role) {
        state.role = 'all';
        render();
      }
      select(name);
    },
    destroy() {},
  };
}

/** Counts across the whole model, so the shape is legible before anything is selected. */
function summaryChips(shape) {
  const chips = ROLE_ORDER
    .filter((role) => shape.counts[role] > 0)
    .map((role) => h('span.shape-chip', { title: describeRole(role) },
      h('b', String(shape.counts[role])), ` ${role}${shape.counts[role] === 1 ? '' : 's'}`));

  // Both worth saying out loud: a bidirectional filter is the usual cause of an
  // ambiguous path, and an inactive relationship only fires inside USERELATIONSHIP.
  if (shape.bidirectional.length > 0) {
    chips.push(h('span.shape-chip.shape-warn', { title: 'Filters travel both ways — a common source of ambiguous paths' },
      h('b', String(shape.bidirectional.length)), ' bidirectional'));
  }
  if (shape.inactive.length > 0) {
    chips.push(h('span.shape-chip.shape-warn', { title: 'Only applies inside USERELATIONSHIP()' },
      h('b', String(shape.inactive.length)), ' inactive'));
  }
  if (shape.dangling.length > 0) {
    chips.push(h('span.shape-chip.shape-warn', { title: 'Names a table this model does not contain' },
      h('b', String(shape.dangling.length)), ' dangling'));
  }
  return chips;
}

/**
 * One table, and everything it joins to, as a vertical bracket.
 *
 * A star was the first attempt and it was wrong for the space: the detail panel is a tall
 * narrow column, so twelve neighbours ended up crushed against one edge with their names
 * truncated to nothing. Vertical is the axis there is room on, and a bracket also gives
 * every node the full panel width — which is what makes `_orders_item_dtl_agg_fct`
 * readable rather than `_orders_item_dt…`.
 *
 * Deterministic, not force-directed: the arrangement carries no information in a graph
 * one hop deep, and a fixed layout renders identically in the handoff file and the app.
 * Outgoing and incoming are separated and labelled, so which side of a join this table
 * sits on is readable without following an arrowhead.
 */
function joinDiagram(near, { onSelect } = {}) {
  const width = 360;
  const pad = 10;
  const nodeH = 26;
  const rowGap = 32;
  const railX = 26;
  const childX = railX + 16;
  const childW = width - childX - pad;

  const out = near.edges.filter((e) => e.direction === 'out');
  const incoming = near.edges.filter((e) => e.direction === 'in');

  const rows = [];
  let y = pad + nodeH + 18;
  for (const [label, group] of [['joins to', out], ['joined from', incoming]]) {
    if (group.length === 0) continue;
    rows.push({ heading: `${label} (${group.length})`, y });
    y += 16;
    for (const edge of group) {
      rows.push({ edge, y });
      y += rowGap;
    }
    y += 6;
  }
  const height = y + pad;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    role: 'img',
    'aria-label': `${near.name} and the ${near.edges.length} tables it joins to`,
    class: 'star',
  });

  // The rail runs from under the centre node to the last child it feeds.
  const lastRow = [...rows].reverse().find((r) => r.edge);
  if (lastRow) {
    root.append(svg('path', {
      d: `M ${railX} ${pad + nodeH} L ${railX} ${lastRow.y + nodeH / 2}`,
      class: 'star-edge',
    }));
  }

  for (const row of rows) {
    if (row.heading) {
      root.append(svg('text', { x: String(childX), y: String(row.y + 8), class: 'star-heading' }, row.heading));
      continue;
    }
    const { edge } = row;
    root.append(svg('path', {
      d: `M ${railX} ${row.y + nodeH / 2} L ${childX} ${row.y + nodeH / 2}`,
      class: `star-edge${edge.isActive ? '' : ' star-edge-inactive'}`
        + (edge.crossFilter === 'bothDirections' ? ' star-edge-both' : ''),
    }));
    root.append(nodeBox(childX, row.y, childW, nodeH, edge.other, 'star-node', onSelect));
  }

  root.append(nodeBox(pad, pad, width - pad * 2, nodeH, near.name, 'star-node star-centre'));
  return root;
}

/**
 * One labelled box. Clickable when a handler is given, so the diagram navigates.
 *
 * The label is left-aligned rather than centred: table names in a real model share long
 * prefixes (`_orders_agg_fct`, `_orders_item_dtl_agg_fct`, `_orders_agg_agg_fct`),
 * and centring puts the part that differs in a different place on every row.
 */
function nodeBox(x, y, w, hgt, label, className, onSelect) {
  const group = svg('g', {
    class: className,
    transform: `translate(${x} ${y})`,
    ...(onSelect ? { role: 'button', tabindex: '0', style: 'cursor:pointer' } : {}),
  },
    svg('rect', { width: String(w), height: String(hgt), rx: '4' }),
    svg('text', { x: '9', y: String(hgt / 2 + 4) }, truncate(label, 40)));

  if (onSelect) {
    group.addEventListener('click', () => onSelect(label));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(label);
      }
    });
  }
  // The full name, for anything the box had to truncate.
  group.append(svg('title', {}, label));
  return group;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
