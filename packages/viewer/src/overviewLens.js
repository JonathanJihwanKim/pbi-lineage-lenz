/**
 * Overview — what this model is, before anything has been clicked.
 *
 * Every other lens is a list. A list is the right shape once you know what you are looking
 * for, and the wrong one when you have just been handed a model you did not build: 61
 * tables sorted by role is a fact about the file, and "16 facts around 23 dimensions, and
 * 13 of the remaining tables are field parameters" is a fact about the model.
 *
 * The rule this screen lives under: **every sentence is arithmetic over the payload.**
 * No scores, no grades, no estimates. The tool's whole claim is that it does not guess,
 * and a summary screen is the easiest place in the product to quietly start guessing — a
 * "model health: B+" would undo the honesty the source map spends so much effort on. Each
 * observation instead says what was counted and links to the lens that shows the rows.
 */

import { h, replace } from './dom.js';
import { describeModelShape, ROLE_ORDER, TABLE_ROLE } from './modelShape.js';
import { confidenceBar } from './sourceMap.js';
import { TABLE_KIND } from './viewerModel.js';

/**
 * Build the overview lens.
 *
 * @param {object} options
 * @param {object} options.model - Viewer model.
 * @param {(lens: string, ref?: string) => void} [options.onOpen] - Jump to a lens.
 * @returns {{el: HTMLElement, select: () => void, destroy: () => void}}
 */
export function overviewLens({ model, onOpen }) {
  const shape = describeModelShape(model);
  const stats = model.stats?.confidence ?? null;

  const fieldParameters = (model.tables || []).filter((t) => t.kind === TABLE_KIND.FIELD_PARAMETER);
  const calcGroups = (model.tables || []).filter((t) => t.kind === TABLE_KIND.CALCULATION_GROUP);

  const el = h('div.overview',
    h('div.panel',
      h('div.panel-head', h('h2', 'What this model is')),
      h('div.panel-body',
        h('p.overview-lead', ...shapeSentence(shape, fieldParameters, calcGroups)),
        h('div.shape-summary', ...roleChips(shape)))),

    stats ? h('div.panel',
      h('div.panel-head', h('h2', 'How much of it is traced')),
      h('div.panel-body', ...coverage(stats, onOpen))) : null,

    h('div.panel',
      h('div.panel-head', h('h2', 'Worth a look')),
      h('div.panel-body', ...observations(model, shape, calcGroups, onOpen))));

  return { el, select() {}, destroy() {} };
}

/**
 * One sentence naming the shape of the model.
 *
 * Machinery is counted apart from the star deliberately. `standalone` lumps a field
 * parameter, a measure holder and a genuinely disconnected table into one bucket, and in a
 * real 61-table model that bucket held 21 tables — the single largest group, and the one
 * that told a newcomer least.
 */
function shapeSentence(shape, fieldParameters, calcGroups) {
  const parts = [];
  const say = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const facts = shape.counts[TABLE_ROLE.FACT];
  const dims = shape.counts[TABLE_ROLE.DIMENSION];

  if (facts > 0 && dims > 0) {
    parts.push(h('b', say(facts, 'fact', 'facts')), ' around ',
      h('b', say(dims, 'dimension', 'dimensions')));
  } else {
    parts.push(h('b', say(shape.tables.size, 'table', 'tables')));
  }

  const machinery = [];
  if (fieldParameters.length > 0) {
    machinery.push(say(fieldParameters.length, 'field parameter', 'field parameters'));
  }
  if (calcGroups.length > 0) {
    machinery.push(say(calcGroups.length, 'calculation group', 'calculation groups'));
  }
  if (machinery.length > 0) parts.push(`, plus ${machinery.join(' and ')}`);

  parts.push('.');
  return parts;
}

function roleChips(shape) {
  const chips = ROLE_ORDER
    .filter((role) => shape.counts[role] > 0)
    .map((role) => h('span.shape-chip',
      h('b', String(shape.counts[role])), ` ${role}${shape.counts[role] === 1 ? '' : 's'}`));

  if (shape.bidirectional.length > 0) {
    chips.push(h('span.shape-chip.shape-warn',
      h('b', String(shape.bidirectional.length)), ' bidirectional'));
  }
  if (shape.inactive.length > 0) {
    chips.push(h('span.shape-chip.shape-warn',
      h('b', String(shape.inactive.length)), ' inactive'));
  }
  return chips;
}

/**
 * Coverage, with the reason the number is not 100% stated beside it rather than implied.
 *
 * The count that used to be missing is `modelDefined`. A field parameter's columns cannot
 * have a physical source, and reporting them as untraced held a real model's genuine 96%
 * down to 82% — a number that made the tool look worse *and* sent the reader hunting for
 * 67 things that were never lost.
 */
function coverage(stats, onOpen) {
  const traceable = (stats.sourced ?? 0) + (stats.unresolved ?? 0);
  const pct = Math.round((stats.coverage ?? 0) * 100);

  const line = h('p.overview-lead',
    h('b', `${stats.sourced ?? 0} of ${traceable} columns`),
    ' that read from a source are traced to a physical column ',
    h('b', `(${pct}%)`), '.');

  const asides = [];
  if (stats.computed > 0) {
    asides.push(stats.computed === 1
      ? '1 more is computed in DAX or Power Query and has no source column'
      : `${stats.computed} more are computed in DAX or Power Query and have no source column`);
  }
  if (stats.modelDefined > 0) {
    asides.push(stats.modelDefined === 1
      ? '1 belongs to a field parameter or a calculation group, which are model metadata '
        + 'rather than data'
      : `${stats.modelDefined} belong to field parameters and calculation groups, which are `
        + 'model metadata rather than data');
  }

  return [
    line,
    asides.length > 0
      ? h('p', { style: { color: 'var(--ink-2)', margin: '0 0 12px' } },
          `${asides.join('; ')}. `
          + (asides.length === 1
            ? 'It does not count against coverage.'
            : 'Neither counts against coverage.'))
      : null,
    confidenceBar(stats),
    h('div', { style: { display: 'flex', gap: '14px', marginTop: '10px', flexWrap: 'wrap' } },
      h('span.conf.conf-exact', `${stats.exact ?? 0} stated`),
      h('span.conf.conf-inferred', `${stats.inferred ?? 0} assumed`),
      h('span.conf.conf-unknown', `${stats.unknown ?? 0} unresolved`),
      h('span', { style: { flex: '1' } }),
      h('button.btn', { type: 'button', onClick: () => onOpen?.('source-map') },
        'Open the source map')),
  ];
}

/**
 * Things worth reading, each one a count the reader can go and check.
 *
 * Phrased as observations rather than as problems. A bidirectional filter is not a bug, a
 * hidden visual is usually intentional, and a tool that calls them defects trains people
 * to ignore the list. The one thing each row promises is that the number is real.
 */
function observations(model, shape, calcGroups, onOpen) {
  const items = [];

  const add = (count, text, lens, ref) => {
    if (!count) return;
    items.push(h('div.observation', {
      role: onOpen ? 'button' : null,
      tabindex: onOpen ? '0' : null,
      onClick: () => onOpen?.(lens, ref),
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen?.(lens, ref);
        }
      },
    },
      h('b.observation-count', String(count)),
      h('span', text)));
  };

  // A calculation group changes what every measure in a visual evaluates to, and nothing
  // in the measure's own DAX says so. It leads the list because it is the observation most
  // likely to explain a number somebody cannot reproduce.
  for (const group of calcGroups) {
    const applied = (model.visuals || [])
      .filter((v) => v.appliesCalculationGroups?.includes(group.name)).length;
    add(applied,
      `visual${applied === 1 ? '' : 's'} apply "${group.name}", which rewrites every measure on them`,
      'model', `table:${group.name}`);
  }

  const unresolved = model.stats?.confidence?.unresolved ?? 0;
  add(unresolved, `column${unresolved === 1 ? '' : 's'} read from a source this tool could not name`,
    'source-map');

  const unusedMeasures = (model.measures || []).filter((m) => m.usedByVisuals.length === 0).length;
  add(unusedMeasures, `measure${unusedMeasures === 1 ? '' : 's'} no visual shows directly`,
    'measures');

  const neverShown = (model.visuals || []).filter((v) => v.neverShown).length;
  add(neverShown, `hidden visual${neverShown === 1 ? '' : 's'} that no bookmark reveals`, 'pages');

  add(shape.bidirectional.length,
    `relationship${shape.bidirectional.length === 1 ? '' : 's'} filter both ways — the usual cause of an ambiguous path`,
    'model');

  add(shape.inactive.length,
    `inactive relationship${shape.inactive.length === 1 ? '' : 's'}, which only fire inside USERELATIONSHIP()`,
    'model');

  add(shape.dangling.length,
    `relationship${shape.dangling.length === 1 ? '' : 's'} naming a table this model does not contain`,
    'model');

  if (items.length === 0) {
    return [h('div.empty',
      h('b', 'Nothing stands out'),
      'Every column is traced, every measure is shown, and no relationship is ambiguous.')];
  }
  return items;
}

/** Re-exported so the shell can label the tab without importing the whole lens. */
export function overviewCount(model) {
  return (model.tables || []).length;
}
