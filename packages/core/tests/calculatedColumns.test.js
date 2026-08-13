/**
 * Inline calculated columns, and where a DAX expression ends.
 *
 * `column 'Is Past Date' = 'Time Period'[Date] <= TODAY()` was parsed as a column named
 * with that entire line. The real column was therefore missing from the model, its DAX
 * was never parsed, and every measure reading it was reported as a broken reference —
 * one bad regex producing a wrong name, a lost dependency, and a false alarm at once.
 */

import { describe, it, expect } from 'vitest';
import { parseTmdlModel, extractDaxExpression, parseRelationships } from '../src/parser/tmdlParser.js';

const tab = '\t';

function parse(content) {
  return parseTmdlModel([{ path: 'Test.tmdl', content }], []).tables[0];
}

describe('inline calculated columns', () => {
  it('separates a quoted name from its expression', () => {
    const table = parse([
      'table Dates',
      `${tab}column 'Is Past Date' = 'Dates'[Date] <= TODAY()`,
      `${tab}${tab}dataType: boolean`,
      '',
    ].join('\n'));

    expect(table.calculatedColumns).toHaveLength(1);
    expect(table.calculatedColumns[0].name).toBe('Is Past Date');
    expect(table.calculatedColumns[0].expression).toBe("'Dates'[Date] <= TODAY()");
  });

  it('handles an unquoted name', () => {
    const table = parse(`table T\n${tab}column IsPast = T[Date] <= TODAY()\n`);
    expect(table.calculatedColumns[0].name).toBe('IsPast');
    expect(table.calculatedColumns[0].expression).toBe('T[Date] <= TODAY()');
  });

  it('leaves an ordinary column alone', () => {
    const table = parse([
      'table T',
      `${tab}column 'Year Month'`,
      `${tab}${tab}dataType: string`,
      `${tab}${tab}sourceColumn: year_month`,
      '',
    ].join('\n'));

    expect(table.calculatedColumns).toHaveLength(0);
    expect(table.columns[0].name).toBe('Year Month');
    expect(table.columns[0].sourceColumn).toBe('year_month');
  });

  it('reads a multi-line expression', () => {
    const table = parse([
      'table T',
      `${tab}column Bucket =`,
      `${tab}${tab}SWITCH(TRUE(),`,
      `${tab}${tab}${tab}T[N] > 10, "high",`,
      `${tab}${tab}${tab}"low")`,
      `${tab}${tab}dataType: string`,
      '',
    ].join('\n'));

    expect(table.calculatedColumns[0].name).toBe('Bucket');
    expect(table.calculatedColumns[0].expression).toContain('SWITCH');
    expect(table.calculatedColumns[0].expression).toContain('"low"');
    expect(table.calculatedColumns[0].expression).not.toContain('dataType');
  });
});

describe('extractDaxExpression boundaries', () => {
  it('stops at a bare boolean flag', () => {
    // `isHidden` has no colon, so the property rule walked straight past it and appended
    // it to the DAX. Every measure with a bare flag under it carried the flag in its
    // expression, which then reached the DAX parser and the syntax highlighter.
    const lines = [
      `${tab}measure X = SUM(T[A])`,
      `${tab}${tab}isHidden`,
      `${tab}${tab}formatString: 0`,
    ];
    expect(extractDaxExpression(lines, 0)).toBe('SUM(T[A])');
  });

  it('stops at an annotation sub-block', () => {
    const lines = [
      `${tab}measure X = SUM(T[A])`,
      `${tab}${tab}annotation Foo = Bar`,
    ];
    expect(extractDaxExpression(lines, 0)).toBe('SUM(T[A])');
  });

  it('keeps a lone identifier that is genuinely part of the DAX', () => {
    // The reason the flags are listed by name rather than matched as "any single word":
    // `RETURN` on one line and the variable on the next is ordinary DAX formatting.
    const lines = [
      `${tab}measure X =`,
      `${tab}${tab}VAR _result = SUM(T[A])`,
      `${tab}${tab}RETURN`,
      `${tab}${tab}${tab}_result`,
      `${tab}${tab}formatString: 0`,
    ];
    expect(extractDaxExpression(lines, 0)).toContain('_result');
    expect(extractDaxExpression(lines, 0)).not.toContain('formatString');
  });
});

/**
 * Relationship endpoints — `Table.Column`, with either half optionally quoted.
 *
 * Found by the model lens, not by looking: one relationship in a 61-table model reported
 * an empty table name, which the shape classifier then flagged as pointing at a table the
 * model does not contain. The model was fine; the parser required the column half to be a
 * bare identifier and `Range.'Category Name'` is not.
 */
describe('parseRelationships — quoted endpoints', () => {
  const one = (from, to) => parseRelationships(
    `relationship abc\n\tfromColumn: ${from}\n\ttoColumn: ${to}\n`)[0];

  it('reads a quoted table with a bare column', () => {
    expect(one("Sales.amount", "'Time Period'.date_sk")).toMatchObject({
      fromTable: 'Sales', fromColumn: 'amount', toTable: 'Time Period', toColumn: 'date_sk',
    });
  });

  it('reads a bare table with a quoted column', () => {
    expect(one("Range.'Category Name'", "Category.'Category Name'")).toMatchObject({
      fromTable: 'Range', fromColumn: 'Category Name', toTable: 'Category', toColumn: 'Category Name',
    });
  });

  it('reads both halves quoted', () => {
    expect(one("'Order Lines'.'Product Key'", "'Product Master'.'Product Key'")).toMatchObject({
      fromTable: 'Order Lines', fromColumn: 'Product Key',
      toTable: 'Product Master', toColumn: 'Product Key',
    });
  });

  it('does not split on a dot inside a quoted name', () => {
    expect(one("'A.B'.'C.D'", 'X.y')).toMatchObject({ fromTable: 'A.B', fromColumn: 'C.D' });
  });

  it('never leaves an endpoint half-parsed', () => {
    // An empty table with a populated column is the shape of the original bug, and it
    // reads downstream as a relationship pointing at a table that does not exist.
    const rel = one("Range.'Category Name'", "Category.'Category Name'");
    expect(rel.fromTable).not.toBe('');
    expect(rel.toTable).not.toBe('');
  });
});
