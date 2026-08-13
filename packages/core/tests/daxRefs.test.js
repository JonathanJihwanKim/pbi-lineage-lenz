/**
 * DAX reference extraction, and the four ways it used to invent references.
 *
 * Every case here was found by running the CI gate over one real model, where it reported
 * 166 broken references. Eleven survived investigation as parser artefacts and the rest
 * were these patterns. A lineage tool that hallucinates dependencies is worse than one
 * that misses them: the missing edge is a gap, the invented one is a lie that sends
 * somebody looking for a table that never existed.
 */

import { describe, it, expect } from 'vitest';
import { extractTableRefs, extractColumnRefs, extractMeasureRefs, parseDaxExpression } from '../src/parser/daxParser.js';

describe('extractTableRefs', () => {
  it('reads the table out of a plain iterator', () => {
    expect(extractTableRefs('SUMX(FactSales, FactSales[Amount])')).toEqual(['FactSales']);
  });

  it('reads a quoted table name', () => {
    expect(extractTableRefs("COUNTROWS(VALUES('Store Table'))")).toEqual(['Store Table']);
  });

  it('does not mistake a nested function for a table', () => {
    // `FILTER(ALL(Dates), …)` — the first argument is a call, and its name is not a
    // table. The old 12-name keyword blocklist let every function it had not heard of
    // through: MAX, MIN, COUNTROWS, FILTER, VALUES.
    expect(extractTableRefs('CALCULATE([Sales], FILTER(ALL(Dates), Dates[Year] = MAX(Dates[Year])))'))
      .toEqual(['Dates']);
  });

  it('finds the real table underneath several nested calls', () => {
    // Skipping the function must not skip past what it wraps, or the fix for the false
    // positive would create a false negative in the same expression.
    expect(extractTableRefs('CALCULATE(SUMX(FILTER(ALL(VALUES(Deep)), TRUE()), 1))')).toEqual(['Deep']);
  });

  it('does not mistake a table-valued variable for a table', () => {
    expect(extractTableRefs('VAR _MaxFilters = FILTER(Sales, TRUE()) RETURN COUNTROWS(_MaxFilters)'))
      .toEqual(['Sales']);
  });
});

describe('extractMeasureRefs', () => {
  it('finds a bare measure reference', () => {
    expect(extractMeasureRefs('[Total Sales] * 2')).toEqual([{ measure: 'Total Sales' }]);
  });

  it('ignores a column the expression invented with ADDCOLUMNS', () => {
    // `"@value"` is a column this expression creates; `[@value]` reads it back. It looks
    // exactly like a measure reference and is not one.
    const dax = `
      VAR _t = FILTER(
        ADDCOLUMNS(VALUES('Time Period'[Date]), "@value", [Number of Picked Orderlines]),
        NOT([@value] == BLANK()))
      RETURN COUNTROWS(_t)`;
    const names = extractMeasureRefs(dax).map((r) => r.measure);

    expect(names).toContain('Number of Picked Orderlines');
    expect(names).not.toContain('@value');
  });

  it('still reports a measure whose name appears as an unrelated string literal', () => {
    // The narrow rule matters: excluding every quoted string would drop this real
    // reference, and dropping a real dependency is the worse failure of the two.
    const dax = 'IF([Sales] > 0, "Sales", "None")';
    expect(extractMeasureRefs(dax).map((r) => r.measure)).toEqual(['Sales']);
  });
});

describe('extractColumnRefs', () => {
  it('finds a qualified column', () => {
    expect(extractColumnRefs("SUM('Fact Sales'[Amount])")).toEqual([{ table: 'Fact Sales', column: 'Amount' }]);
  });

  it('ignores an invented column whose name contains brackets', () => {
    // `SELECTCOLUMNS(…, "Known[X]", …)` names a column `Known[X]`, so reading it back
    // parses as table `Known`, column `X`. Neither exists.
    const dax = `
      VAR Known = SELECTCOLUMNS(Source, "Known[X]", 'Time Period'[Date], "Known[Y]", [Sales])
      RETURN SUMX(Known, Known[X])`;
    const refs = extractColumnRefs(dax);

    expect(refs).not.toContainEqual({ table: 'Known', column: 'X' });
    expect(refs).toContainEqual({ table: 'Time Period', column: 'Date' });
  });

  it('drops the phantom table along with the phantom column', () => {
    // The table is derived from the column reference, so one exclusion has to remove
    // both — otherwise the graph keeps a node for a table nobody defined.
    const dax = `
      VAR Known = SELECTCOLUMNS(Source, "Known[X]", 'Time Period'[Date])
      RETURN SUMX(Known, Known[X])`;
    expect(parseDaxExpression(dax).tableRefs).not.toContain('Known');
  });
});
