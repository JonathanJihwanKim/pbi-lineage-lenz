/**
 * Field parameters — following the binding, not just finding it.
 *
 * A visual binds a field parameter as one opaque entry. The 22 measures behind
 * `prmMeasures` live in the semantic model as `NAMEOF` rows, so the report alone cannot
 * say what the visual can show — only what it shows right now.
 *
 * On the sample report this understated one pivot table by fifteen measures, and told a
 * reader that `Orders On Time %` *filters* that visual when in fact a slicer puts
 * it on the canvas. Same shape as reading `queryState` only: the reference was found and
 * then not followed.
 *
 * @see https://learn.microsoft.com/en-us/power-bi/create-reports/power-bi-field-parameters
 */

import { describe, it, expect } from 'vitest';
import {
  parseNameOfTargets, isFieldParameterTable, resolveFieldParameters, expandFieldParameters,
} from '../src/parser/fieldParameters.js';

describe('parseNameOfTargets', () => {
  it('reads a table-qualified reference', () => {
    expect(parseNameOfTargets("NAMEOF('Measure'[Orders On Time %])"))
      .toEqual([{ table: 'Measure', name: 'Orders On Time %' }]);
  });

  it('reads a table name written without quotes', () => {
    expect(parseNameOfTargets('NAMEOF(Range[Category Number Name Combined])'))
      .toEqual([{ table: 'Range', name: 'Category Number Name Combined' }]);
  });

  it('reads a bare reference with no table at all', () => {
    // Legal for a measure, and present in this model. The table comes from the model.
    expect(parseNameOfTargets('NAMEOF([Picking Productivity Orderlines per Hour])'))
      .toEqual([{ table: null, name: 'Picking Productivity Orderlines per Hour' }]);
  });

  it('collapses the repetition that grouping columns create', () => {
    // The real parameter has 147 rows and 22 fields: one row per measure per grouping.
    const dax = `{
      ("Picked OLs", NAMEOF('Measure'[Picked]), 0, "Main", 0, "Country"),
      ("Picked OLs", NAMEOF('Measure'[Picked]), 0, "Main", 0, "Store"),
      ("First Time Right", NAMEOF('Measure'[FTR]), 1, "Main", 0, "Country")
    }`;
    expect(parseNameOfTargets(dax).map((t) => t.name)).toEqual(['Picked', 'FTR']);
  });

  it('finds nothing in DAX that has no NAMEOF', () => {
    expect(parseNameOfTargets("SUMMARIZE('Sales', 'Sales'[Region])")).toEqual([]);
  });
});

describe('isFieldParameterTable', () => {
  const table = (source) => ({ name: 'p', partitions: [{ type: 'calculated', sourceExpression: source }] });

  it('recognises a calculated table built from NAMEOF', () => {
    expect(isFieldParameterTable(table('{ ("A", NAMEOF(\'M\'[A]), 0) }'))).toBe(true);
  });

  it('does not mistake an ordinary calculated table for one', () => {
    expect(isFieldParameterTable(table("FILTER('Sales', 'Sales'[Amount] > 0)"))).toBe(false);
  });
});

describe('resolveFieldParameters', () => {
  const model = {
    tables: [
      {
        name: 'Measure',
        measures: [{ name: 'Orders with Target not Met' }, { name: 'Picked' }],
        columns: [],
      },
      { name: 'Store', columns: [{ name: 'Country Name' }], measures: [] },
      {
        name: 'prm',
        columns: [],
        measures: [],
        partitions: [{
          type: 'calculated',
          sourceExpression: `{
            ("Wait", NAMEOF('Measure'[Orders with Target Not Met]), 0),
            ("Country", NAMEOF('Store'[Country Name]), 1),
            ("Bare", NAMEOF([Picked]), 2)
          }`,
        }],
      },
    ],
  };

  it('resolves measures and columns from one parameter', () => {
    expect(resolveFieldParameters(model).get('prm')).toEqual([
      { type: 'measure', table: 'Measure', name: 'Orders with Target not Met' },
      { type: 'column', table: 'Store', name: 'Country Name' },
      { type: 'measure', table: 'Measure', name: 'Picked' },
    ]);
  });

  it('returns the model’s spelling, not the DAX’s', () => {
    // The parameter writes `Orders with Target Not Met`; the measure is defined as
    // `…not Met`. DAX does not care and neither should the index — matching the literal
    // text invents a second measure that does not exist anywhere in the model.
    const entry = resolveFieldParameters(model).get('prm')[0];
    expect(entry.name).toBe('Orders with Target not Met');
  });

  it('drops a reference to something the model does not have', () => {
    const broken = {
      tables: [{
        name: 'prm',
        partitions: [{ type: 'calculated', sourceExpression: "{ (\"X\", NAMEOF('Gone'[Missing]), 0) }" }],
      }],
    };
    expect(resolveFieldParameters(broken).get('prm')).toBeUndefined();
  });

  it('ignores tables that are not field parameters', () => {
    expect(resolveFieldParameters(model).has('Measure')).toBe(false);
  });
});

describe('expandFieldParameters', () => {
  const parameters = new Map([['prm', [
    { type: 'measure', table: 'Measure', name: 'Picked' },
    { type: 'measure', table: 'Measure', name: 'Offered Only' },
  ]]]);

  const visualWith = (...fields) => ({ fields: [
    { type: 'fieldParameter', table: 'prm', column: null, measure: null, role: 'Values', via: 'query' },
    ...fields,
  ] });

  it('adds a measure the visual never mentioned', () => {
    const visual = visualWith();
    expandFieldParameters([visual], parameters);

    const added = visual.fields.find((f) => f.measure === 'Offered Only');
    expect(added).toMatchObject({ via: 'parameter', viaParameter: 'prm', table: 'Measure' });
  });

  it('leaves a plotted measure plotted', () => {
    // Currently selected beats merely offered: it is on the canvas right now.
    const visual = visualWith(
      { type: 'measure', table: 'Measure', column: null, measure: 'Picked', role: 'Values', via: 'query' });
    expandFieldParameters([visual], parameters);

    expect(visual.fields.filter((f) => f.measure === 'Picked')).toHaveLength(1);
    expect(visual.fields.find((f) => f.measure === 'Picked').via).toBe('query');
  });

  it('upgrades a measure previously known only as a filter', () => {
    // The finding this exists for. "Filters this visual" and "can be displayed in this
    // visual" are different answers, and the reader asked for the second one.
    const visual = visualWith(
      { type: 'measure', table: 'Measure', column: null, measure: 'Picked', role: 'filter', via: 'filter' });
    expandFieldParameters([visual], parameters);

    expect(visual.fields.find((f) => f.measure === 'Picked').via).toBe('parameter');
  });

  it('matches case-insensitively, like DAX', () => {
    const visual = visualWith(
      { type: 'measure', table: 'Measure', column: null, measure: 'PICKED', role: 'filter', via: 'filter' });
    expandFieldParameters([visual], parameters);

    expect(visual.fields.filter((f) => (f.measure || '').toLowerCase() === 'picked')).toHaveLength(1);
  });

  it('leaves a visual that binds no parameter alone', () => {
    const visual = { fields: [{ type: 'measure', table: 'Measure', measure: 'Picked', via: 'query' }] };
    expandFieldParameters([visual], parameters);
    expect(visual.fields).toHaveLength(1);
  });
});
