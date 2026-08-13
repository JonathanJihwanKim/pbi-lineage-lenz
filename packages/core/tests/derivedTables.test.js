/**
 * Tables that read other tables, rather than a physical source.
 *
 * The resolver walked each table on its own, so a table whose `Source` is another table
 * in the same model had no connector to point at and every one of its columns landed on
 * `unknown` — even when the upstream table resolved to a fully qualified path. The chain
 * stopped one hop short of the end, which is precisely the thing the tool is named after.
 *
 * On the real model this accounted for 35 of 118 unresolved columns: 17 in a calculated
 * table copying `Store`, 15 in `Stock and Transaction Date` reading `Time Period`
 * and renaming one column, and 3 more in parameter tables copying a dimension.
 *
 * These are the safe kind of wrong — `unknown` under-claims rather than lying — but a gap
 * the model closes for you is still a gap the tool should not report.
 */

import { describe, it, expect } from 'vitest';
import { resolveSourceNames, CONFIDENCE } from '../src/naming/sourceNameResolver.js';

/** A physical table plus whichever derived tables a case needs. */
const model = (tables) => ({
  expressions: [
    {
      name: 'src',
      expression: `let
        Source = GoogleBigQuery.Database([BillingProject="proj"]),
        #"proj" = Source{[Name="proj"]}[Data],
        Schema = #"proj"{[Name="ds",Kind="Schema"]}[Data],
        Base = Schema{[Name="date_dim",Kind="Table"]}[Data]
      in Base`,
    },
  ],
  tables: [
    {
      name: 'Time Period',
      columns: [{ name: 'Date', sourceColumn: 'Date' }, { name: 'Year', sourceColumn: 'Year' }],
      partitions: [{
        name: 'p',
        sourceExpression: 'let Source = src, R = Table.RenameColumns(Source, {{"sql_date", "Date"}}) in R',
      }],
    },
    ...tables,
  ],
});

const derived = (sourceExpression, columns) =>
  model([{ name: 'Derived', columns, partitions: [{ name: 'p', sourceExpression }] }]);

describe('a partition that reads another model table', () => {
  it('follows the reference and keeps the upstream rename', () => {
    // `Source = #"Time Period"` looks exactly like a shared-expression reference, but the
    // name belongs to a table. Splicing finds nothing to splice, so before this the whole
    // chain read as unfollowable.
    const resolved = resolveSourceNames(derived(
      `let
        Source = #"Time Period",
        Renamed = Table.RenameColumns(Source, {{"Date", "Stock and Transaction Date"}})
      in Renamed`,
      [{ name: 'Stock and Transaction Date', sourceColumn: 'Stock and Transaction Date' }]
    ));

    const column = resolved.columns.get('Derived[Stock and Transaction Date]');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.physicalPath).toBe('proj.ds.date_dim.sql_date');
  });

  it('shows both hops in the reason, so the whole chain is readable', () => {
    const resolved = resolveSourceNames(derived(
      `let
        Source = #"Time Period",
        Renamed = Table.RenameColumns(Source, {{"Date", "Stock and Transaction Date"}})
      in Renamed`,
      [{ name: 'Stock and Transaction Date', sourceColumn: 'Stock and Transaction Date' }]
    ));

    const { reason } = resolved.columns.get('Derived[Stock and Transaction Date]');
    expect(reason).toMatch(/Read from Time Period/);
    expect(reason).toMatch(/"Date" -> "Stock and Transaction Date"/);
    expect(reason).toMatch(/"sql_date" -> "Date"/);
  });

  it('carries a column through unrenamed when the partition only copies', () => {
    const resolved = resolveSourceNames(derived(
      'let Source = #"Time Period" in Source',
      [{ name: 'Year', sourceColumn: 'Year' }]
    ));

    expect(resolved.columns.get('Derived[Year]')).toMatchObject({
      confidence: CONFIDENCE.EXACT,
      physicalPath: 'proj.ds.date_dim.Year',
    });
  });

  it('is only as confident as the hop it just made', () => {
    // The upstream mapping is stated, but this partition can rename anything it likes,
    // so which upstream column ends up here is an assumption.
    const resolved = resolveSourceNames(derived(
      'let Source = #"Time Period", Upper = Table.TransformColumnNames(Source, Text.Upper) in Upper',
      [{ name: 'Year', sourceColumn: 'Year' }]
    ));

    expect(resolved.columns.get('Derived[Year]').confidence).toBe(CONFIDENCE.INFERRED);
  });

  it('stays unknown when the upstream table is itself unresolved', () => {
    const resolved = resolveSourceNames({
      expressions: [],
      tables: [
        { name: 'Mystery', columns: [{ name: 'Year' }], partitions: [{ name: 'p', sourceExpression: 'let Source = Nowhere in Source' }] },
        { name: 'Derived', columns: [{ name: 'Year' }], partitions: [{ name: 'p', sourceExpression: 'let Source = Mystery in Source' }] },
      ],
    });

    expect(resolved.columns.get('Derived[Year]').confidence).toBe(CONFIDENCE.UNKNOWN);
  });

  it('terminates on a circular reference instead of spinning', () => {
    const resolved = resolveSourceNames({
      expressions: [],
      tables: [
        { name: 'A', columns: [{ name: 'x' }], partitions: [{ name: 'p', sourceExpression: 'let Source = B in Source' }] },
        { name: 'B', columns: [{ name: 'x' }], partitions: [{ name: 'p', sourceExpression: 'let Source = A in Source' }] },
      ],
    });

    expect(resolved.columns.get('A[x]').confidence).toBe(CONFIDENCE.UNKNOWN);
    expect(resolved.columns.get('B[x]').confidence).toBe(CONFIDENCE.UNKNOWN);
  });

  it('prefers a shared expression when one carries the same name as a table', () => {
    // Ambiguous by construction. `parseMSteps` already spliced the expression's steps in,
    // so treating the name as a table too would double-count the chain.
    const base = model([]);
    const resolved = resolveSourceNames({
      expressions: [...base.expressions, { name: 'Time Period', expression: 'let Source = src in Source' }],
      tables: [...base.tables, {
        name: 'Derived',
        columns: [{ name: 'Year' }],
        partitions: [{ name: 'p', sourceExpression: 'let Source = #"Time Period" in Source' }],
      }],
    });

    expect(resolved.columns.get('Derived[Year]').physicalPath).toBe('proj.ds.date_dim.Year');
  });
});

describe('a calculated table', () => {
  const calculated = (sourceColumn) => model([{
    name: 'Benchmark',
    columns: [{ name: 'Date', sourceColumn }],
    partitions: [{ name: 'p', type: 'calculated', sourceExpression: "'Time Period'" }],
  }]);

  it('follows the origin column TMDL states on it', () => {
    // `sourceColumn: Time Period[Date]` is the model saying where the column came from.
    // Nothing is deduced here — it is written down.
    const column = resolveSourceNames(calculated('Time Period[Date]')).columns.get('Benchmark[Date]');

    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.physicalPath).toBe('proj.ds.date_dim.sql_date');
  });

  it('reports the origin as stated rather than as a copy', () => {
    // The DAX behind the table is not read. One real calculated table in the sample is a
    // UNION of the same column from two fact tables, and TMDL names the first — DAX's own
    // lineage rule, and a genuine source, but not the only one. "Copied from" would claim
    // a check that did not happen.
    const { reason } = resolveSourceNames(calculated('Time Period[Date]')).columns.get('Benchmark[Date]');

    expect(reason).toMatch(/model gives this calculated table's column as Time Period\[Date\]/);
    expect(reason).not.toMatch(/[Cc]opied/);
  });

  it('reports the Power Query name of the origin, not the model reference', () => {
    expect(resolveSourceNames(calculated('Time Period[Date]')).columns.get('Benchmark[Date]').pqName)
      .toBe('Date');
  });

  it('stays unknown when the named origin does not resolve', () => {
    expect(resolveSourceNames(calculated('Nowhere[Date]')).columns.get('Benchmark[Date]').confidence)
      .toBe(CONFIDENCE.UNKNOWN);
  });
});
