/**
 * Dual-name state — the vocabulary the whole viewer is currently speaking.
 *
 * The BI developer says `Sales[Net Amount]`. The data engineer says
 * `SalesDW.dbo.FactSales.amt_net_usd`. Both are the same column, and neither should have
 * to translate in their head. One switch re-reads every name on screen.
 */

import { h } from './dom.js';

/** Which vocabulary names are rendered in. */
export const VOCAB = Object.freeze({
  MODEL: 'model',
  SOURCE: 'source',
});

/**
 * Observable vocabulary state. Views subscribe and re-render their names.
 */
export class NameState {
  constructor(initial = VOCAB.MODEL) {
    this.vocab = initial;
    this._listeners = new Set();
  }

  /** @param {(vocab: string) => void} fn @returns {() => void} unsubscribe */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  set(vocab) {
    if (vocab === this.vocab) return;
    this.vocab = vocab;
    for (const fn of this._listeners) fn(vocab);
  }

  toggle() {
    this.set(this.vocab === VOCAB.MODEL ? VOCAB.SOURCE : VOCAB.MODEL);
  }

  get isSource() {
    return this.vocab === VOCAB.SOURCE;
  }
}

/**
 * The vocabulary switch.
 * @param {NameState} state
 * @returns {HTMLElement}
 */
export function nameToggle(state) {
  const model = h('button', {
    type: 'button',
    'aria-pressed': String(state.vocab === VOCAB.MODEL),
    title: 'Show Power BI model names (Alt+N)',
  }, 'model');

  const source = h('button', {
    type: 'button',
    'aria-pressed': String(state.vocab === VOCAB.SOURCE),
    title: 'Show physical source-system names (Alt+N)',
  }, 'source');

  const root = h('div.name-toggle', {
    role: 'group',
    'aria-label': 'Name vocabulary',
  }, model, source);

  const sync = () => {
    const isSource = state.isSource;
    model.setAttribute('aria-pressed', String(!isSource));
    source.setAttribute('aria-pressed', String(isSource));
    root.style.setProperty('--toggle-x', isSource ? '100%' : '0');
  };

  model.addEventListener('click', () => state.set(VOCAB.MODEL));
  source.addEventListener('click', () => state.set(VOCAB.SOURCE));
  state.subscribe(sync);
  sync();

  return root;
}

/**
 * Bind Alt+N to flip the vocabulary.
 * @returns {() => void} unbind
 */
export function bindToggleShortcut(state, target = document) {
  const onKey = (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      state.toggle();
    }
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

/**
 * Render a column's name in the active vocabulary.
 *
 * When a column has no physical origin the source side shows the reason marker rather
 * than falling back to the model name — a silent fallback would make an unresolved
 * column look resolved, which is the one thing this tool must never do.
 *
 * @param {object} column - Viewer-model column.
 * @param {string} vocab
 * @returns {HTMLElement}
 */
export function columnName(column, vocab) {
  if (vocab === VOCAB.SOURCE) {
    return column.physicalPath
      ? physicalPath(column.physicalPath)
      : h('span.n-none', { title: column.reason || 'No physical source resolved' }, unresolvedLabel(column));
  }
  return h('span.n-model', column.modelRef ?? column.ref?.replace(/^column:/, '') ?? column.name);
}

/** Short marker for a column with no physical origin. */
function unresolvedLabel(column) {
  switch (column.origin) {
    case 'computed-dax': return '— calculated in DAX';
    case 'computed-pq': return '— added in Power Query';
    default: return '— unresolved';
  }
}

/**
 * Render a dotted physical path with the qualifiers de-emphasised, so the eye lands on
 * the column rather than re-reading the project and dataset on every row.
 * @param {string} path
 */
export function physicalPath(path) {
  const parts = String(path).split('.');
  const leaf = parts.pop();
  const el = h('span.n-source');
  if (parts.length) el.append(h('span.path-q', `${parts.join('.')}.`));
  el.append(h('span.path-leaf', leaf));
  return el;
}

/**
 * Re-render an element's names with the sweep animation.
 * @param {HTMLElement} el
 * @param {number} [index] - Position, used to stagger the sweep.
 */
export function animateSwap(el, index = 0) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.remove('swap');
  // Force reflow so the animation restarts on a repeated toggle.
  void el.offsetWidth;
  el.style.animationDelay = `${Math.min(index, 24) * 8}ms`;
  el.classList.add('swap');
}
