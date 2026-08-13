/**
 * Field parameters — the fields a visual can show, as opposed to the ones it shows now.
 *
 * A field parameter is a calculated table of `NAMEOF` references, bound to a visual as a
 * single entry in `queryState.<role>.fieldParameters`. The report says "this well holds
 * prmMeasures" and stops; the list of 22 measures behind that name lives in the semantic
 * model, in DAX.
 *
 * Not following it understated a real pivot table by fifteen measures. The tool named the
 * seven currently-selected projections plus an opaque `prmMeasures`, so a reader was told
 * the visual shows seven measures when a slicer lets them display any of twenty-two. It
 * also mislabelled the relationship: `Orders On Time %` was reported as *filtering*
 * that visual, when a reader can put it on the canvas.
 *
 * This is the `queryState`-only mistake one level deeper. A field parameter is a
 * reference to a list of references, and finding the reference is not the same as
 * following it.
 *
 * @see https://learn.microsoft.com/en-us/power-bi/create-reports/power-bi-field-parameters
 */

import { VIA, VIA_RANK } from './pbirParser.js';

/**
 * Every `NAMEOF` target in a field parameter's DAX, in declaration order, deduplicated.
 *
 * Three shapes occur, all in one real model:
 *   NAMEOF('Measure'[Orders On Time %])   quoted table
 *   NAMEOF(Range[Category Number Name Combined])     bare table
 *   NAMEOF([Picking Productivity Orderlines per Hour])   no table at all
 *
 * The third is legal because a measure reference does not need its table. It resolves
 * against the model rather than the text, so it is returned with `table: null` for the
 * caller to fill in.
 *
 * @param {string} dax
 * @returns {Array<{table: string|null, name: string}>}
 */
export function parseNameOfTargets(dax) {
  if (!dax) return [];

  const pattern = /NAMEOF\s*\(\s*(?:'([^']*)'|([A-Za-z_][\w ]*?))?\s*\[([^\]]+)\]\s*\)/g;
  const found = [];
  const seen = new Set();

  let match;
  while ((match = pattern.exec(dax)) !== null) {
    const table = match[1] ?? match[2]?.trim() ?? null;
    const name = match[3].trim();
    // The same field appears once per grouping row — 147 rows, 22 fields in one case.
    const key = `${(table ?? '').toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ table: table || null, name });
  }
  return found;
}

/**
 * Is this table a field parameter?
 *
 * The annotation is what Power BI writes, so it is the reliable signal; the DAX check
 * catches a table hand-authored in TMDL or Tabular Editor, where the annotation may be
 * absent but the `NAMEOF` list is the whole point.
 */
export function isFieldParameterTable(table) {
  const source = fieldParameterSource(table);
  return !!source && /\bNAMEOF\s*\(/i.test(source);
}

/** The calculated-table DAX behind a field parameter, or null. */
function fieldParameterSource(table) {
  for (const partition of table?.partitions || []) {
    const body = partition?.sourceExpression ?? partition?.source ?? null;
    if (body && /\bNAMEOF\s*\(/i.test(body)) return body;
  }
  return null;
}

/**
 * Resolve every field parameter in a model to the fields it offers.
 *
 * @param {object} model - Parsed TMDL model.
 * @returns {Map<string, Array<{type: string, table: string, name: string}>>}
 *   Keyed by field-parameter table name. Entries whose target cannot be located in the
 *   model are dropped rather than guessed at — a parameter offering a field that no
 *   longer exists is a broken reference, and inventing a table for it would hide that.
 */
export function resolveFieldParameters(model) {
  // Keyed case-insensitively and carrying the model's own spelling, because DAX is
  // case-insensitive and authors do not stay consistent: this model's parameter writes
  // `NAMEOF('Measure'[Orders with Target Not Met])` for a measure defined as
  // `Orders with Target not Met`. Matching on the literal text invents a second
  // measure that does not exist.
  const measureOwners = new Map();
  const columnOwners = new Map();
  for (const table of model?.tables || []) {
    for (const measure of table.measures || []) {
      measureOwners.set(measure.name.toLowerCase(), { table: table.name, name: measure.name });
    }
    for (const column of [...(table.columns || []), ...(table.calculatedColumns || [])]) {
      columnOwners.set(`${table.name.toLowerCase()}|${column.name.toLowerCase()}`,
        { table: table.name, name: column.name });
    }
  }

  const resolved = new Map();
  for (const table of model?.tables || []) {
    const source = fieldParameterSource(table);
    if (!source) continue;

    const entries = [];
    for (const target of parseNameOfTargets(source)) {
      // A measure resolves by name whether or not a table is written against it, so it
      // is tried first either way; a bare `NAMEOF([X])` can only ever be a measure.
      const measure = measureOwners.get(target.name.toLowerCase());
      if (measure) {
        entries.push({ type: 'measure', table: measure.table, name: measure.name });
        continue;
      }
      if (!target.table) continue;
      const column = columnOwners.get(`${target.table.toLowerCase()}|${target.name.toLowerCase()}`);
      if (column) entries.push({ type: 'column', table: column.table, name: column.name });
    }

    if (entries.length > 0) resolved.set(table.name, entries);
  }
  return resolved;
}

/**
 * Attach the fields a parameter offers to every visual that binds it.
 *
 * They join `fields` under `via: 'parameter'` rather than replacing anything. What the
 * visual shows right now and what it can be made to show are different answers, and a
 * reader asked "where is this measure displayed?" needs both.
 *
 * @param {Array<object>} visuals - Parsed visuals, mutated in place.
 * @param {Map<string, Array<object>>} parameters - resolveFieldParameters() output.
 */
export function expandFieldParameters(visuals, parameters) {
  if (!parameters || parameters.size === 0) return;

  // Case-insensitive, like DAX itself. The report JSON and the parameter's DAX spell the
  // same measure differently in this model, and a case-sensitive key made a phantom.
  const keyOf = (f) =>
    `${f.type}|${f.table}|${f.column || ''}|${f.measure || ''}`.toLowerCase();

  for (const visual of visuals || []) {
    const bound = (visual.fields || []).filter((f) => f.type === 'fieldParameter');
    if (bound.length === 0) continue;

    const existing = new Map((visual.fields || []).map((f) => [keyOf(f), f]));

    for (const binding of bound) {
      const entries = parameters.get(binding.table);
      if (!entries) continue;

      for (const entry of entries) {
        const field = {
          type: entry.type,
          table: entry.table,
          column: entry.type === 'column' ? entry.name : null,
          measure: entry.type === 'measure' ? entry.name : null,
          role: binding.role || '',
          via: VIA.PARAMETER,
          viaParameter: binding.table,
        };

        const already = existing.get(keyOf(field));
        if (!already) {
          existing.set(keyOf(field), field);
          visual.fields.push(field);
          continue;
        }

        // Already referenced some other way. Plotted outranks offered, so leave that
        // alone — but a measure known only as a *filter* of this visual is one the
        // reader can also display, and saying only "filters it" is the wrong answer.
        if (VIA_RANK.indexOf(VIA.PARAMETER) < VIA_RANK.indexOf(already.via)) {
          already.via = VIA.PARAMETER;
          already.viaParameter = binding.table;
        }
      }
    }
  }
}
