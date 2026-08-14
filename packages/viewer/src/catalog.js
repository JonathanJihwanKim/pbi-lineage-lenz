/**
 * Measure catalog — every measure, its DAX, what it reads, and where it is shown.
 *
 * "Where is this used?" is the question that decides whether a change is safe, so usage
 * is a first-class column rather than something to go hunting for.
 */

import { h, replace, debounce, copyText } from './dom.js';
import { physicalPath } from './names.js';
import { buildTraceGraph, graphView } from './graph.js';
import { confidenceBadge } from './sourceMap.js';
import { locatorCard } from './locator.js';

const DAX_KEYWORDS = new Set([
  'VAR', 'RETURN', 'EVALUATE', 'DEFINE', 'MEASURE', 'ORDER', 'BY', 'START', 'AT',
  'IF', 'SWITCH', 'TRUE', 'FALSE', 'BLANK', 'NOT', 'IN', 'AND', 'OR',
]);

/**
 * One pass over the source, in precedence order: comments, strings, column and measure
 * references, function calls, bare words, numbers.
 *
 * The obvious two-pass scheme — park tokens in numbered placeholders, restore them at the
 * end — is quietly broken: the later number rule matches the placeholder indices
 * themselves and rewrites them, so nothing is ever restored and no token is ever
 * highlighted. One pass has no intermediate state to corrupt.
 */
const DAX_TOKEN = new RegExp([
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/,             // 1 comment
  /("(?:[^"]|"")*")/,                          // 2 string
  /('(?:[^']|'')*'\[[^\]]*\]|\[[^\]]*\])/,     // 3 'Table'[Column] or [Measure]
  /([A-Za-z_][A-Za-z0-9_.]*)(?=\s*\()/,        // 4 function call
  /([A-Za-z_][A-Za-z0-9_]*)/,                  // 5 bare word
  /(\d+(?:\.\d+)?)/,                           // 6 number
].map((r) => r.source).join('|'), 'g');

function esc(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlight a DAX expression.
 * @param {string} expression
 * @returns {string} HTML; every fragment is escaped.
 */
export function highlightDax(expression) {
  if (!expression) return '';

  const source = String(expression);
  let out = '';
  let last = 0;

  DAX_TOKEN.lastIndex = 0;
  let match;
  while ((match = DAX_TOKEN.exec(source)) !== null) {
    out += esc(source.slice(last, match.index));
    last = match.index + match[0].length;

    const [, comment, string, ref, fn, word, num] = match;
    if (comment) out += `<span class="cmt">${esc(comment)}</span>`;
    else if (string) out += `<span class="str">${esc(string)}</span>`;
    else if (ref) out += `<span class="ref">${esc(ref)}</span>`;
    else if (fn) {
      out += DAX_KEYWORDS.has(fn.toUpperCase())
        ? `<span class="kw">${esc(fn)}</span>`
        : `<span class="fn">${esc(fn)}</span>`;
    } else if (word) {
      out += DAX_KEYWORDS.has(word.toUpperCase())
        ? `<span class="kw">${esc(word)}</span>`
        : esc(word);
    } else if (num) out += `<span class="num">${esc(num)}</span>`;
  }

  return out + esc(source.slice(last));
}

/**
 * Build the catalog lens.
 *
 * @param {object} options
 * @param {object} options.model
 * @param {object} options.index
 * @param {import('./names.js').NameState} options.names
 * @param {(ref: string) => string} [options.linkFor]
 * @returns {{el: HTMLElement, select: (ref: string) => void, destroy: () => void}}
 */
export function catalogLens({ model, index, names, linkFor, onOpenVisual }) {
  const state = { query: '', onlyUnused: false, selected: null };
  let currentGraph = null;

  const list = h('tbody');
  const detail = h('div.panel', h('div.panel-head', h('h2', 'Measure detail')), h('div.panel-body'));

  const search = h('input', {
    type: 'search',
    name: 'measure-search',
    placeholder: 'Search measures and DAX',
    'aria-label': 'Search measures',
  });
  search.addEventListener('input', debounce(() => {
    state.query = search.value.trim().toLowerCase();
    render();
  }, 100));

  const unusedChip = h('button.chip', {
    type: 'button',
    'aria-pressed': 'false',
    title: 'Measures no visual references',
    onClick: () => {
      state.onlyUnused = !state.onlyUnused;
      unusedChip.setAttribute('aria-pressed', String(state.onlyUnused));
      render();
    },
  }, 'unused only');

  const graphPanel = h('div.panel', { style: { marginBottom: 'var(--gap)', display: 'none' } },
    h('div.panel-head', h('h2', 'Lineage'), h('span.label', 'source system → model table → column → measure → visual')),
    h('div.panel-body'));

  const el = h('div',
    graphPanel,
    h('div.split',
      h('div.panel',
        h('div.panel-head',
          h('h2', 'Measures'),
          h('div.field', { style: { flex: '1' } }, h('span.label', 'find'), search),
          unusedChip),
        h('div.tbl-wrap',
          h('table.tbl',
            h('thead', h('tr', h('th', 'Measure'), h('th', 'Table'), h('th', 'Used by'), h('th', ''))),
            list))),
      detail));

  function render() {
    let measures = model.measures;
    if (state.onlyUnused) measures = measures.filter((m) => m.usedByVisuals.length === 0);
    if (state.query) {
      const q = state.query;
      measures = measures.filter((m) =>
        m.name.toLowerCase().includes(q)
        || m.table.toLowerCase().includes(q)
        || (m.expression || '').toLowerCase().includes(q));
    }

    replace(list, measures.map((measure) => h('tr', {
      'data-ref': measure.ref,
      'aria-selected': String(state.selected === measure.ref),
      onClick: () => select(measure.ref),
    },
      h('td',
        h('span.n-model', measure.name),
        measure.badge ? h('span.step', { style: { marginLeft: '7px' } }, measure.badge) : null),
      h('td', { style: { color: 'var(--ink-3)' } }, measure.table),
      h('td', measure.usedByVisuals.length > 0
        ? h('span.mono', { style: { color: 'var(--ink-2)' } }, `${measure.usedByVisuals.length} visual${measure.usedByVisuals.length === 1 ? '' : 's'}`)
        : h('span.conf.conf-unknown', 'unused')),
      h('td'))));

    if (measures.length === 0) {
      replace(list, h('tr', h('td', { colspan: '4' },
        h('div.empty', h('b', 'No measures match'), 'Clear the filter or search for something else.'))));
    }
  }

  function select(ref) {
    state.selected = ref;
    for (const row of list.querySelectorAll('tr[data-ref]')) {
      const isSelected = row.dataset.ref === ref;
      row.setAttribute('aria-selected', String(isSelected));
      if (isSelected) row.scrollIntoView({ block: 'nearest' });
    }
    renderDetail(model.measures.find((m) => m.ref === ref));
  }

  function renderDetail(measure) {
    currentGraph?.destroy();
    currentGraph = null;

    const body = detail.querySelector('.panel-body');
    if (!measure) {
      graphPanel.style.display = 'none';
      replace(body, h('div.empty', h('b', 'Nothing selected'), 'Pick a measure to trace it to its source columns.'));
      return;
    }

    const { columns, unresolved } = traceColumns(measure.ref, model, index);
    const graph = buildTraceGraph(measure.ref, model, index);
    currentGraph = graphView(graph, { names, onSelect: () => {} });
    graphPanel.style.display = '';
    replace(graphPanel.querySelector('.panel-body'), currentGraph.el);

    const copy = h('button.btn', {
      type: 'button',
      onClick: async () => {
        const ok = await copyText(linkFor ? linkFor(measure.ref) : measure.ref);
        if (ok) {
          copy.textContent = 'link copied';
          setTimeout(() => { copy.textContent = 'copy link'; }, 1400);
        }
      },
    }, 'copy link');

    replace(body,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
        h('span.n-model', { style: { fontSize: '13px' } }, `${measure.table}[${measure.name}]`),
        h('span', { style: { flex: '1' } }),
        copy),

      measure.expression ? h('pre.code', { html: highlightDax(measure.expression) }) : null,

      // The DAX above is not the whole story where a calculation group is in play: the
      // group's item wraps `SELECTEDMEASURE()` around it, so the number on the page is not
      // the number this expression computes. Nothing in the measure says so, which is
      // exactly why it has to be said here — someone editing this measure and checking
      // that visual would otherwise conclude their change had no effect.
      ...calculationGroupNote(measure, model),

      h('div.label', { style: { margin: '16px 0 7px' } },
        `physical columns (${columns.length})`),
      columns.length > 0
        ? h('div', columns.map((column) => h('div', {
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0', flexWrap: 'wrap' },
          },
            physicalPath(column.physicalPath),
            confidenceBadge(column.confidence))))
        : h('div.empty', { style: { padding: '14px' } }, 'No physical columns resolved.'),

      // Unresolved inputs are shown, never omitted: an absent row would read as
      // "nothing upstream", which is the opposite of the truth.
      unresolved.length > 0
        ? h('div',
            h('div.label', { style: { margin: '16px 0 7px' } }, `unresolved inputs (${unresolved.length})`),
            unresolved.map((column) => h('div', {
              style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
            },
              h('span.n-model', `${column.table}[${column.name}]`),
              confidenceBadge(column.confidence))))
        : null,

      // "Where is this actually shown?" — the question a reader with no Power BI asks.
      // Each entry locates the visual on its page instead of naming it and stopping.
      measure.usedByVisuals.length > 0
        ? h('div',
            h('div.label', { style: { margin: '16px 0 7px' } }, `shown in (${measure.usedByVisuals.length})`),
            measure.usedByVisuals.map((ref) => {
              const visual = index.byRef.get(ref);
              if (!visual) return null;
              const page = model.pages.find((p) => p.id === visual.page);
              return locatorCard({
                page,
                visuals: index.visualsByPage.get(visual.page) || [],
                visual,
                via: visual.fields.find((f) => f.ref === measure.ref)?.via ?? null,
                onSelect: onOpenVisual,
              });
            }))
        : null);
  }

  render();
  renderDetail(null);

  return { el, select, destroy: () => currentGraph?.destroy() };
}

/**
 * "This measure is rewritten on N of the M visuals that show it."
 *
 * Empty for the overwhelming majority of measures, and that is the point: it appears
 * only where the answer to "does my DAX describe what is on the page?" is no.
 */
function calculationGroupNote(measure, model) {
  const groups = measure.underCalculationGroups || [];
  if (groups.length === 0) return [];

  const shown = measure.usedByVisuals.length;
  const affected = (model.visuals || []).filter((visual) =>
    visual.appliesCalculationGroups?.length > 0
    && visual.fields.some((f) => f.ref === measure.ref)).length;

  const names = groups.map((g) => `"${g}"`).join(' and ');
  return [h('div.note-calcgroup',
    h('b', 'Rewritten by a calculation group.'),
    ` ${affected} of the ${shown} visual${shown === 1 ? '' : 's'} showing this measure `
    + `also bind${affected === 1 ? 's' : ''} ${names}, so what they display is this `
    + 'expression wrapped in the selected calculation item — not this expression.')];
}

/** Columns a measure reads, split by whether their physical origin is known. */
function traceColumns(measureRef, model, index) {
  const seen = new Set();
  const refs = new Set();

  const walk = (ref, depth) => {
    if (seen.has(ref) || depth > 16) return;
    seen.add(ref);
    const measure = index.byRef.get(ref);
    if (!measure || measure.kind !== 'measures') return;

    for (const columnRef of measure.dependsOn.columns) refs.add(`column:${columnRef}`);
    for (const childName of measure.dependsOn.measures) {
      const direct = `measure:${childName}`;
      if (index.byRef.has(direct)) { walk(direct, depth + 1); continue; }
      const match = model.measures.find((m) => m.name === childName.replace(/^.*\[|\]$/g, ''));
      if (match) walk(match.ref, depth + 1);
    }
  };
  walk(measureRef, 0);

  const columns = [];
  const unresolved = [];
  for (const ref of refs) {
    const column = index.byRef.get(ref);
    if (!column) continue;
    (column.physicalPath ? columns : unresolved).push(column);
  }
  return { columns, unresolved };
}
