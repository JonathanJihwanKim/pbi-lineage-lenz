/**
 * Viewer shell — lenses, vocabulary switch, and deep-link routing.
 *
 * Mounts against a viewer model and nothing else: no file access, no network. The web app
 * and the handoff file mount the identical component, which is what makes a handoff file
 * cheap to produce and identical to read.
 */

import { h, replace } from './dom.js';
import { NameState, nameToggle, bindToggleShortcut, VOCAB } from './names.js';
import { buildIndex } from './viewerModel.js';
import { sourceMapLens } from './sourceMap.js';
import { catalogLens } from './catalog.js';
import { pageLens } from './pageLens.js';
import { modelLens } from './modelLens.js';
import { overviewLens } from './overviewLens.js';

/**
 * Mount the viewer.
 *
 * @param {HTMLElement} root
 * @param {object} model - Viewer model from toViewerModel().
 * @param {object} [options]
 * @param {string} [options.subtitle] - Shown beside the wordmark.
 * @param {Array<HTMLElement>} [options.actions] - Extra header controls (the web app adds export).
 * @param {boolean} [options.routing=true] - Read and write `location.hash`.
 * @returns {{destroy: () => void, names: NameState, goto: (ref: string) => void}}
 */
export function mountViewer(root, model, options = {}) {
  const { subtitle, actions = [], routing = true } = options;

  const index = buildIndex(model);
  const names = new NameState(VOCAB.MODEL);

  const lenses = [
    // Overview first, and it is the only lens that is not a list. Someone opening a
    // handoff file has been sent a model they have never seen; four tabs of sorted rows
    // ask them to know what to look for before they have been told what this is.
    { key: 'overview', label: 'overview', count: null },
    // Then model: "what am I looking at?" comes before "where did this column come from?"
    { key: 'model', label: 'model', count: model.tables.length },
    { key: 'source-map', label: 'source map', count: model.columns.length },
    { key: 'measures', label: 'measures', count: model.measures.length },
    { key: 'pages', label: 'pages', count: model.pages.length },
  ];

  let active = null;
  const views = new Map();
  const stage = h('div.lenz-body');

  const tabs = lenses.map((lens) => h('button.lenz-lens', {
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
    'data-key': lens.key,
    onClick: () => show(lens.key),
  }, lens.label, lens.count === null ? null : h('span.count', String(lens.count))));

  const header = h('header.lenz-header',
    h('div.lenz-wordmark',
      h('span.lens'),
      h('b', 'PBI Lineage Lenz'),
      subtitle ? h('small', subtitle) : null),
    h('div.lenz-header-spacer'),
    ...actions,
    nameToggle(names));

  const app = h('div.lenz-app',
    header,
    h('nav.lenz-lenses', { role: 'tablist' }, tabs),
    stage);

  function viewFor(key) {
    if (views.has(key)) return views.get(key);

    const view = key === 'overview'
      ? overviewLens({ model, onOpen: (lens, ref) => show(lens, ref) })
      : key === 'measures'
        ? catalogLens({ model, index, names, linkFor, onOpenVisual: (ref) => show('pages', ref) })
        : key === 'pages'
          ? pageLens({ model, index, linkFor, onOpenMeasure: (ref) => show('measures', ref) })
          : key === 'model'
            ? modelLens({
                model,
                linkFor,
                onOpenColumn: (ref) => show('source-map', ref),
                onOpenMeasure: (ref) => show('measures', ref),
              })
            : sourceMapLens({ model, names, linkFor, onSelect: (ref) => writeHash(ref) });

    views.set(key, view);
    return view;
  }

  function show(key, ref) {
    active = key;
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.key === key));
    const view = viewFor(key);
    replace(stage, view.el);
    if (ref) view.select?.(ref);
  }

  /**
   * Deep link for a ref — the thing that gets pasted into a chat.
   *
   * `encodeURIComponent`, not `encodeURI`: Power BI measure names routinely contain `%`
   * (28 of 274 in one real model — `Orders On Time %`, `Deliveries On Schedule %`), and
   * `encodeURI` leaves a bare `%` in place. The result is a malformed escape that makes
   * `decodeURI` throw, which took the whole routing path down with it.
   */
  function linkFor(ref) {
    const base = location.href.split('#')[0];
    return `${base}#/${encodeURIComponent(ref)}`;
  }

  function writeHash(ref) {
    if (!routing) return;
    const next = `#/${encodeURIComponent(ref)}`;
    if (location.hash === next) return;
    try {
      history.replaceState(null, '', next);
    } catch {
      // A handoff file opened from disk is a unique origin; some browsers reject
      // history writes there. The fragment still works, so fall back to setting it.
      location.hash = next;
    }
  }

  /** Open whatever a `#/kind:name` fragment points at. */
  function goto(ref) {
    if (!ref) return;
    const kind = ref.split(':')[0];
    if (kind === 'measure') show('measures', ref);
    else if (kind === 'column') show('source-map', ref);
    else if (kind === 'visual' || kind === 'page') show('pages', ref);
    else if (kind === 'table') show('model', ref);
    else show(active || 'overview');
  }

  /**
   * Decode a fragment, tolerating one that was never encoded.
   *
   * A link generated by this app is always well formed, but a hand-typed or hand-edited
   * one may not be — `#/measure:Sales[Margin %]` contains a bare `%` that is not a valid
   * escape. Decoders throw on that. Falling back to the raw text lets the readable form
   * keep working, and guarantees a bad fragment can never take down the whole viewer.
   */
  function decodeRef(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function readHash() {
    const raw = decodeRef(location.hash.replace(/^#\/?/, ''));
    if (raw) goto(raw);
  }

  const unbindToggle = bindToggleShortcut(names);
  const onHash = () => readHash();
  if (routing) addEventListener('hashchange', onHash);

  root.classList.add('lenz');
  replace(root, app);

  show('overview');
  if (routing && location.hash) readHash();

  return {
    names,
    goto,
    destroy() {
      unbindToggle();
      if (routing) removeEventListener('hashchange', onHash);
      for (const view of views.values()) view.destroy?.();
      root.replaceChildren();
    },
  };
}
