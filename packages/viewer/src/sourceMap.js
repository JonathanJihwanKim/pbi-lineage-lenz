/**
 * Source map — every model column beside the physical column it came from.
 *
 * This is the table a data engineer and a BI developer read together. It is deliberately
 * dense and sortable rather than pretty: the job is to find one row fast and trust what
 * it says, and the confidence column is what makes trusting it possible.
 */

import { h, replace, debounce, copyText } from './dom.js';
import { columnName, physicalPath, animateSwap, VOCAB } from './names.js';

const CONFIDENCE_ORDER = { exact: 0, inferred: 1, unknown: 2 };

/** Confidence pill. */
export function confidenceBadge(confidence) {
  return h(`span.conf.conf-${confidence || 'unknown'}`, confidence || 'unknown');
}

/**
 * Proportional confidence bar.
 * @param {{exact: number, inferred: number, unknown: number, total: number}} stats
 */
export function confidenceBar(stats) {
  const total = Math.max(stats?.total || 0, 1);
  const pct = (n) => `${((n / total) * 100).toFixed(2)}%`;
  return h('div.conf-bar', {
    title: `${stats?.exact || 0} exact · ${stats?.inferred || 0} inferred · ${stats?.unknown || 0} unknown`,
  },
    h('span.s-exact', { style: { width: pct(stats?.exact || 0) } }),
    h('span.s-inferred', { style: { width: pct(stats?.inferred || 0) } }),
    h('span.s-unknown', { style: { width: pct(stats?.unknown || 0) } }));
}

/**
 * Build the source-map lens.
 *
 * @param {object} options
 * @param {object} options.model - Viewer model.
 * @param {import('./names.js').NameState} options.names
 * @param {(ref: string) => void} [options.onSelect]
 * @param {(ref: string) => string} [options.linkFor] - Deep link for a ref.
 * @returns {{el: HTMLElement, select: (ref: string) => void, destroy: () => void}}
 */
export function sourceMapLens({ model, names, onSelect, linkFor }) {
  const state = { query: '', filter: 'all', sort: 'table', selected: null };

  const tbody = h('tbody');
  const countLabel = h('span.label');
  const detail = h('div.panel.detail', h('div.panel-head', h('h2', 'Column detail')), h('div.panel-body'));

  const search = h('input', {
    type: 'search',
    name: 'column-search',
    placeholder: 'Search either vocabulary — "Net Amount" or "amt_net_usd"',
    'aria-label': 'Search columns',
  });
  search.addEventListener('input', debounce(() => {
    state.query = search.value.trim().toLowerCase();
    render();
  }, 100));

  const filters = ['all', 'exact', 'inferred', 'unknown'].map((key) =>
    h('button.chip', {
      type: 'button',
      'aria-pressed': String(state.filter === key),
      onClick: () => {
        state.filter = key;
        for (const chip of filters) chip.setAttribute('aria-pressed', String(chip.dataset.key === key));
        render();
      },
      'data-key': key,
    }, key));

  const headRow = h('tr');
  const table = h('table.tbl', h('thead', headRow), tbody);

  const el = h('div',
    h('div.stat-rail',
      stat(model.columns.length, 'columns'),
      stat(model.stats?.confidence?.exact ?? 0, 'exact'),
      stat(model.stats?.confidence?.inferred ?? 0, 'inferred'),
      stat(model.stats?.confidence?.unknown ?? 0, 'unknown'),
      // Coverage counts only columns that read from a source. A DAX calculated column
      // has none by definition, and counting it as traced made the headline disagree
      // with the rows underneath it.
      h('div.stat', {
        title: `${model.stats?.confidence?.sourced ?? 0} of `
          + `${(model.stats?.confidence?.sourced ?? 0) + (model.stats?.confidence?.unresolved ?? 0)} `
          + 'columns that read from a source; '
          + `${model.stats?.confidence?.computed ?? 0} more are computed and have none`,
      },
        h('span.v', `${Math.round((model.stats?.confidence?.coverage ?? 0) * 100)}%`),
        h('span.k', 'traced'),
        confidenceBar(model.stats?.confidence))),
    h('div.split',
      h('div.panel',
        h('div.panel-head',
          h('h2', 'Source map'),
          h('div.field', { style: { flex: '1' } }, h('span.label', 'find'), search),
          ...filters),
        h('div.tbl-wrap', table),
        h('div.panel-body', { style: { borderTop: '1px solid var(--rule)', padding: '9px 14px' } }, countLabel)),
      detail));

  function visibleRows() {
    let rows = model.columns;

    if (state.filter !== 'all') rows = rows.filter((c) => (c.confidence || 'unknown') === state.filter);

    if (state.query) {
      const q = state.query;
      // Search spans both vocabularies at once: whichever name you know, it finds the row.
      rows = rows.filter((c) =>
        c.name.toLowerCase().includes(q)
        || c.table.toLowerCase().includes(q)
        || (c.physicalPath || '').toLowerCase().includes(q)
        || (c.pqName || '').toLowerCase().includes(q));
    }

    const sorted = [...rows];
    sorted.sort((a, b) => {
      if (state.sort === 'physical') {
        return (a.physicalPath || '￿').localeCompare(b.physicalPath || '￿');
      }
      if (state.sort === 'confidence') {
        const d = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
        return d !== 0 ? d : a.table.localeCompare(b.table);
      }
      return a.table.localeCompare(b.table) || a.name.localeCompare(b.name);
    });
    return sorted;
  }

  function render() {
    const rows = visibleRows();
    const sourceFirst = names.vocab === VOCAB.SOURCE;

    // The active vocabulary takes the leading column. Dimming alone would not carry it:
    // people scan the first column, so the side you think in has to be the side you read
    // first. Flipping the switch physically rearranges the table.
    replace(headRow,
      sourceFirst
        ? [sortableHeader('Physical column', 'physical', state, render),
           h('th', ''),
           sortableHeader('Model column', 'table', state, render)]
        : [sortableHeader('Model column', 'table', state, render),
           h('th', ''),
           sortableHeader('Physical column', 'physical', state, render)],
      sortableHeader('Confidence', 'confidence', state, render),
      h('th', ''));

    replace(tbody, rows.map((column, i) => {
      const modelCell = h('td', h('span.n-model', `${column.table}[${column.name}]`));
      const alsoFrom = column.alsoFrom ?? [];
      const physicalCell = h('td.col-physical', {
        title: alsoFrom.length > 0
          ? [column.physicalPath, ...alsoFrom].join('\n')
          : column.physicalPath || column.reason || '',
      },
        column.physicalPath
          ? physicalPath(column.physicalPath)
          : h('span.n-none', unresolvedText(column)),
        // One path shown where there are several is not wrong, but it reads as complete.
        // Saying how many more there are is the difference between a row you can act on
        // and a row that quietly misleads.
        alsoFrom.length > 0
          ? h('span.step', { style: { marginLeft: '7px' } }, `+${alsoFrom.length} more`)
          : null);

      const [lead, trail] = sourceFirst ? [physicalCell, modelCell] : [modelCell, physicalCell];
      trail.style.opacity = '0.55';
      animateSwap(lead, i);

      const copy = h('button.copy-link', {
        type: 'button',
        title: 'Copy a link to this column',
        onClick: async (event) => {
          event.stopPropagation();
          const ok = await copyText(linkFor ? linkFor(column.ref) : column.ref);
          if (!ok) return;
          copy.textContent = 'copied';
          copy.classList.add('done');
          setTimeout(() => { copy.textContent = 'link'; copy.classList.remove('done'); }, 1400);
        },
      }, 'link');

      const row = h('tr', {
        'data-ref': column.ref,
        'aria-selected': String(state.selected === column.ref),
        onClick: () => select(column.ref),
      }, lead, h('td.arrow', '→'), trail, h('td', confidenceBadge(column.confidence)), h('td', copy));

      return row;
    }));

    countLabel.textContent = rows.length === model.columns.length
      ? `${rows.length} columns`
      : `${rows.length} of ${model.columns.length} columns`;

    if (rows.length === 0) {
      replace(tbody, h('tr', h('td', { colspan: '5' },
        h('div.empty', h('b', 'No columns match'), 'Try the other vocabulary, or clear the filter.'))));
    }
  }

  function select(ref) {
    state.selected = ref;
    for (const row of tbody.querySelectorAll('tr[data-ref]')) {
      row.setAttribute('aria-selected', String(row.dataset.ref === ref));
    }
    renderDetail(model.columns.find((c) => c.ref === ref));
    onSelect?.(ref);
  }

  function renderDetail(column) {
    const body = detail.querySelector('.panel-body');
    if (!column) {
      replace(body, h('div.empty', h('b', 'Nothing selected'), 'Pick a column to see how it was resolved.'));
      return;
    }

    const table = model.tables.find((t) => t.name === column.table);

    replace(body,
      h('dl',
        h('dt', 'model'), h('dd', h('span.n-model', `${column.table}[${column.name}]`)),
        column.pqName && column.pqName !== column.name ? [h('dt', 'power query'), h('dd', h('span.mono', column.pqName))] : null,
        h('dt', 'physical'), h('dd', column.physicalPath ? physicalPath(column.physicalPath) : h('span.n-none', '—')),
        column.physical?.system ? [h('dt', 'system'), h('dd', column.physical.system)] : null,
        column.dataType ? [h('dt', 'type'), h('dd', column.dataType)] : null,
        h('dt', 'origin'), h('dd', column.origin || '—'),
        h('dt', 'trust'), h('dd', confidenceBadge(column.confidence))),
      // The reason is the whole point of the confidence tier: it says why, in words.
      column.reason ? h('div.reason', column.reason) : null,
      table?.steps?.length
        ? h('div', { style: { marginTop: '14px' } },
            h('div.label', { style: { marginBottom: '7px' } }, 'power query pipeline'),
            h('div.steps', table.steps.flatMap((step, i) => [
              i > 0 ? h('span.sep', '›') : null,
              h('span.step', { 'data-kind': step.kind, title: step.kind }, step.name),
            ])))
        : null,
      table?.physical?.nativeQuery
        ? h('div', { style: { marginTop: '14px' } },
            h('div.label', { style: { marginBottom: '7px' } },
              table.physical.nativeQueryComplete === false ? 'native sql (partly resolved)' : 'native sql'),
            h('pre.code', table.physical.nativeQuery))
        : null);
  }

  const unsubscribe = names.subscribe(render);
  render();
  renderDetail(null);

  return {
    el,
    select,
    destroy: () => unsubscribe(),
  };
}

/**
 * Why a row has no physical column.
 *
 * Only one of these is a gap. "Unresolved" said about a field parameter's column is not a
 * softer way of saying the same thing — it is wrong, and it is the difference between a
 * reader scrolling past a row and a reader going to look for something that was never
 * lost.
 */
function unresolvedText(column) {
  switch (column.origin) {
    case 'computed-dax': return 'calculated in DAX';
    case 'computed-pq': return 'added in Power Query';
    case 'model-defined': return 'model metadata — no source';
    default: return 'unresolved';
  }
}

function stat(value, key) {
  return h('div.stat', h('span.v', String(value)), h('span.k', key));
}

function sortableHeader(text, key, state, render) {
  const th = h('th', {
    role: 'button',
    tabindex: '0',
    style: { cursor: 'pointer' },
    title: `Sort by ${text.toLowerCase()}`,
  }, text, state.sort === key ? ' ▾' : '');

  const activate = () => {
    state.sort = key;
    for (const sibling of th.parentElement.children) {
      sibling.textContent = sibling.textContent.replace(' ▾', '');
    }
    th.append(' ▾');
    render();
  };
  th.addEventListener('click', activate);
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  });
  return th;
}
