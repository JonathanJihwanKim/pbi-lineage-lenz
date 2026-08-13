/**
 * Field-reference extraction.
 *
 * A visual can consume a measure without plotting it: a textbox titled by it, a button
 * whose link is measure-driven, a conditional format. Those compile to a subquery where
 * the table arrives as an *alias* (`SourceRef.Source: "m"`) resolved against a sibling
 * `From: [{ Name: "m", Entity: "Measure" }]`, not as `SourceRef.Entity`.
 *
 * Reading only `Entity` dropped 96 references across 56 visuals in a real report, which
 * understated every "shown in (N)" count and reported 24 live measures as unused.
 */
import { describe, it, expect } from 'vitest';
import { parsePbirReport } from '../src/parser/pbirParser.js';

/** Wrap a visual config as the file entry the parser consumes. */
function visualFile(id, config, page = 'p1') {
  return { path: `pages/${page}/visuals/${id}/visual.json`, content: JSON.stringify(config) };
}

/** The shape a dynamic title or conditional format compiles to. */
function aliasedMeasure(entity, property) {
  return {
    Aggregation: {
      Expression: {
        Column: {
          Expression: {
            Subquery: {
              Query: {
                Version: 2,
                From: [{ Name: 'm', Entity: entity, Type: 0 }],
                Select: [{
                  Measure: { Expression: { SourceRef: { Source: 'm' } }, Property: property },
                  Name: `Measure.${property}`,
                }],
              },
            },
          },
          Property: `Measure.${property}`,
        },
      },
      Function: 3,
    },
  };
}

const fieldsOf = (config, id = 'v1') =>
  parsePbirReport([visualFile(id, config)], []).visuals[0].fields;

describe('aliased references', () => {
  it('resolves a measure whose SourceRef is an alias', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: { visualType: 'textbox', objects: { values: [{ properties: { expr: { expr: aliasedMeasure('Measure', 'Orders On Time %') } } }] } },
    });
    expect(fields.some((f) => f.measure === 'Orders On Time %' && f.table === 'Measure')).toBe(true);
  });

  it('still resolves a direct SourceRef.Entity', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'card',
        query: { queryState: { Values: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } } }] } } },
      },
    });
    expect(fields.some((f) => f.measure === 'Total' && f.table === 'Sales')).toBe(true);
  });

  it('lets an inner query shadow an outer alias', () => {
    const config = {
      name: 'v1',
      visual: {
        visualType: 'textbox',
        objects: {
          outer: {
            From: [{ Name: 'm', Entity: 'OuterTable' }],
            inner: {
              From: [{ Name: 'm', Entity: 'InnerTable' }],
              Select: [{ Measure: { Expression: { SourceRef: { Source: 'm' } }, Property: 'X' } }],
            },
          },
        },
      },
    };
    const fields = fieldsOf(config);
    expect(fields.find((f) => f.measure === 'X').table).toBe('InnerTable');
  });

  it('drops a reference whose alias resolves to nothing rather than inventing a table', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'textbox',
        objects: { v: { Select: [{ Measure: { Expression: { SourceRef: { Source: 'ghost' } }, Property: 'X' } }] } },
      },
    });
    expect(fields.some((f) => f.measure === 'X')).toBe(false);
  });

  it('finds a measure behind a measure-driven button action', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: { visualType: 'actionButton', objects: { icon: [{ properties: { url: { expr: aliasedMeasure('Internal measure', 'ContactLink') } } }] } },
    });
    expect(fields.some((f) => f.measure === 'ContactLink')).toBe(true);
  });
});

describe('role and boundFields', () => {
  it('marks a chart as data with bound fields', () => {
    const [visual] = parsePbirReport([visualFile('v1', {
      name: 'v1',
      visual: {
        visualType: 'barChart',
        query: { queryState: { Values: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } } }] } } },
      },
    })], []).visuals;
    expect(visual.role).toBe('data');
    expect(visual.boundFields).toBe(1);
  });

  it('marks a measure-titled textbox as data with no bound fields', () => {
    // It consumes the measure but plots nothing — the distinction the two counts exist for.
    const [visual] = parsePbirReport([visualFile('v1', {
      name: 'v1',
      visual: { visualType: 'textbox', objects: { values: [{ properties: { expr: { expr: aliasedMeasure('Measure', 'X') } } }] } },
    })], []).visuals;
    expect(visual.role).toBe('data');
    expect(visual.boundFields).toBe(0);
    expect(visual.fields.length).toBeGreaterThan(0);
  });

  it('marks a plain shape as decoration', () => {
    const [visual] = parsePbirReport([visualFile('v1', {
      name: 'v1',
      visual: { visualType: 'shape', objects: { shape: [{ properties: { tileShape: { expr: { Literal: { Value: "'rectangle'" } } } } }] } },
    })], []).visuals;
    expect(visual.role).toBe('decoration');
    expect(visual.fields).toEqual([]);
  });

  it('marks a group as a container', () => {
    const [visual] = parsePbirReport([visualFile('g1', {
      name: 'g1',
      visualGroup: { displayName: 'Right Info pane' },
    })], []).visuals;
    expect(visual.role).toBe('container');
  });
});

/**
 * Which Power BI feature a reference belongs to.
 *
 * Widening the search found 96 lost references; filing them all under "not bound" then
 * threw most of the value away. Microsoft documents the text box's Values well as a field
 * selector — Format > General > Values, the fx button — so a measure placed there is a
 * measure the author chose to display, and calling that the same as a colour rule is the
 * old mistake at a smaller scale.
 *
 * @see https://learn.microsoft.com/en-us/power-bi/create-reports/power-bi-reports-add-text-and-shapes
 */
describe('how a visual reaches a field', () => {
  const textboxValue = (property) => ({
    name: 'v1',
    visual: {
      visualType: 'textbox',
      objects: { values: [{ properties: { expr: { expr: aliasedMeasure('Measure', property) } } }] },
    },
  });

  it('calls a text box dynamic value a value, not formatting', () => {
    expect(fieldsOf(textboxValue('Orders On Time %'))[0].via).toBe('value');
  });

  it('does not call a matrix values-card rule a dynamic value', () => {
    // `objects.values` is two different features. On a text box it is the Values field
    // well; on a table, matrix or pivot table it is the Values *formatting* card, where
    // an icon threshold lives. Reading the key without the visual type called a pivot
    // table's icon rule a displayed value — 9 references in the sample report.
    const rule = (property) => ({
      name: 'v1',
      visual: {
        visualType: 'pivotTable',
        objects: { values: [{ properties: { icon: { value: { expr: aliasedMeasure('Measure', property) } } } }] },
      },
    });
    expect(fieldsOf(rule('Outbound Quality Slope'))[0].via).toBe('format');
  });

  it('calls a plotted projection a query', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'card',
        query: { queryState: { Values: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } } }] } } },
      },
    });
    expect(fields[0].via).toBe('query');
  });

  it('separates a link from something the reader sees', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'actionButton',
        visualContainerObjects: { visualLink: [{ properties: { expr: { expr: aliasedMeasure('Measure', 'ContactLink') } } }] },
      },
    });
    expect(fields[0].via).toBe('action');
  });

  it('separates a dynamic title from a colour rule', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'clusteredBarChart',
        visualContainerObjects: { title: [{ properties: { text: { expr: aliasedMeasure('Measure', 'Header') } } }] },
        objects: { dataPoint: [{ properties: { fill: { expr: aliasedMeasure('Measure', 'Colour') } } }] },
      },
    });
    expect(fields.find((f) => f.measure === 'Header').via).toBe('title');
    expect(fields.find((f) => f.measure === 'Colour').via).toBe('format');
  });

  it('calls a visual-level filter a filter', () => {
    const fields = fieldsOf({
      name: 'v1',
      visual: { visualType: 'pivotTable' },
      filterConfig: {
        filters: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Measure' } }, Property: 'Total' } } }],
      },
    });
    expect(fields[0].via).toBe('filter');
  });

  it('keeps the most direct route when a field is reachable two ways', () => {
    // A chart that plots a measure and also colours itself by it is plotting it. Ranking
    // matters because the routes are walked in file order, not importance order.
    const fields = fieldsOf({
      name: 'v1',
      visual: {
        visualType: 'card',
        objects: { dataPoint: [{ properties: { fill: { expr: aliasedMeasure('Sales', 'Total') } } }] },
        query: { queryState: { Values: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } } }] } } },
      },
    });
    expect(fields).toHaveLength(1);
    expect(fields[0].via).toBe('query');
  });

  it('gives every reference a route', () => {
    for (const field of fieldsOf(textboxValue('Anything'))) expect(field.via).toBeTruthy();
  });
});
