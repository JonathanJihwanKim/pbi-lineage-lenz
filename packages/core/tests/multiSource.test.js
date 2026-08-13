/**
 * Columns whose values come from more than one physical place.
 *
 * A calculated table built with `UNION` draws one column from several facts, and TMDL
 * records only the first — DAX takes the lineage of the leading argument. The path the
 * tool reports is therefore real and correctly named; it is simply not the whole answer.
 *
 * That is a quieter failure than a wrong path and a worse one to leave alone: a single
 * row reads as complete, so someone checking whether a change to the *second* fact table
 * can affect this column concludes it cannot.
 */

import { describe, it, expect } from 'vitest';
import { resolveSourceNames, CONFIDENCE } from '../src/naming/sourceNameResolver.js';

/** Two physical facts carrying the same column name, plus a calculated table over them. */
const model = (dax, sourceColumn = 'FactA[leadtime]') => ({
  expressions: [
    {
      name: 'srcA',
      expression: `let Source = GoogleBigQuery.Database([BillingProject="proj"]),
        #"proj" = Source{[Name="proj"]}[Data],
        S = #"proj"{[Name="ds",Kind="Schema"]}[Data],
        T = S{[Name="fact_a",Kind="Table"]}[Data] in T`,
    },
    {
      name: 'srcB',
      expression: `let Source = GoogleBigQuery.Database([BillingProject="proj"]),
        #"proj" = Source{[Name="proj"]}[Data],
        S = #"proj"{[Name="ds",Kind="Schema"]}[Data],
        T = S{[Name="fact_b",Kind="Table"]}[Data] in T`,
    },
  ],
  tables: [
    {
      name: 'FactA',
      columns: [{ name: 'leadtime' }],
      partitions: [{ name: 'p', sourceExpression: 'let Source = srcA in Source' }],
    },
    {
      name: 'FactB',
      columns: [{ name: 'leadtime' }],
      partitions: [{ name: 'p', sourceExpression: 'let Source = srcB in Source' }],
    },
    {
      name: 'prmLeadtime',
      columns: [{ name: 'leadtime', sourceColumn }],
      partitions: [{ name: 'p', type: 'calculated', sourceExpression: dax }],
    },
  ],
});

const UNION_DAX = `
  VAR _one = DISTINCT ( FactA[leadtime] )
  VAR _two = DISTINCT ( FactB[leadtime] )
  RETURN DISTINCT ( UNION ( _one, _two ) )`;

describe('a calculated table that unions two facts', () => {
  const resolved = resolveSourceNames(model(UNION_DAX));
  const column = resolved.columns.get('prmLeadtime[leadtime]');

  it('still reports the origin TMDL names', () => {
    expect(column.physicalPath).toBe('proj.ds.fact_a.leadtime');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
  });

  it('reports the second source rather than stopping at the first', () => {
    expect(column.alsoFrom).toEqual(['proj.ds.fact_b.leadtime']);
  });

  it('says so in the reason, not only in a field', () => {
    expect(column.reason).toMatch(/also reads FactB\[leadtime\]/);
  });

  it('stays exact — nothing here is assumed', () => {
    // The name is stated and the path is right. Incompleteness is a different property
    // from uncertainty, and collapsing the two would make `exact` mean less everywhere.
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
  });
});

describe('a calculated table that is a plain copy', () => {
  it('reports no other sources', () => {
    const resolved = resolveSourceNames(model("'FactA'"));
    expect(resolved.columns.get('prmLeadtime[leadtime]').alsoFrom).toBeUndefined();
  });

  it('does not count the origin itself as a second source', () => {
    // `FactA[leadtime]` appears in the expression *and* is what TMDL names. Reporting it
    // twice would be a fabricated second source, which is worse than reporting one.
    const resolved = resolveSourceNames(model('DISTINCT ( FactA[leadtime] )'));
    expect(resolved.columns.get('prmLeadtime[leadtime]').alsoFrom).toBeUndefined();
  });
});

describe('what it declines to claim', () => {
  it('ignores a reference to a column of a different name', () => {
    const resolved = resolveSourceNames(model(
      'UNION ( DISTINCT ( FactA[leadtime] ), DISTINCT ( FactB[something_else] ) )'));
    expect(resolved.columns.get('prmLeadtime[leadtime]').alsoFrom).toBeUndefined();
  });

  it('ignores a reference it cannot resolve', () => {
    // A table that is not in the model, or one whose own source is unknown. Listing it
    // would put a name in front of a reader that they cannot look up anywhere.
    const resolved = resolveSourceNames(model(
      'UNION ( DISTINCT ( FactA[leadtime] ), DISTINCT ( Ghost[leadtime] ) )'));
    expect(resolved.columns.get('prmLeadtime[leadtime]').alsoFrom).toBeUndefined();
  });

  it('handles a quoted table name in the expression', () => {
    const resolved = resolveSourceNames(model(
      "UNION ( DISTINCT ( FactA[leadtime] ), DISTINCT ( 'FactB'[leadtime] ) )"));
    expect(resolved.columns.get('prmLeadtime[leadtime]').alsoFrom).toEqual(['proj.ds.fact_b.leadtime']);
  });
});
