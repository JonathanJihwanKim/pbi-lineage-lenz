/**
 * Markdown documentation.
 *
 * The output is committed to a repository and read in a pull request, so the things that
 * matter are that it renders as markdown at all — a stray pipe in a measure name will
 * silently shred a table — and that both vocabularies appear, since a data engineer will
 * search this file for their own column names.
 */

import { describe, it, expect } from 'vitest';
import { toMarkdown } from '../src/markdown.js';

function model(overrides = {}) {
  return {
    meta: { modelName: 'Sales Model', generatedAt: '2026-08-11T00:00:00Z' },
    stats: { confidence: { coverage: 0.74, exact: 10, inferred: 5, unknown: 3 } },
    tables: [{
      name: 'Sales',
      physicalPath: 'mydb.dbo.fact_sales',
      columnCount: 2,
      measureCount: 1,
      steps: [{ name: 'Source', kind: 'Source' }, { name: 'Nav', kind: 'Navigation' }],
    }],
    columns: [
      { table: 'Sales', name: 'Amount', physicalPath: 'mydb.dbo.fact_sales.sale_amount', dataType: 'double', confidence: 'exact' },
      { table: 'Sales', name: 'Note', physicalPath: null, dataType: 'string', confidence: 'unknown' },
    ],
    measures: [{
      table: 'Sales',
      name: 'Total Sales',
      expression: 'SUM(Sales[Amount])',
      usedByVisuals: ['visual:p1/v1'],
    }],
    relationships: [],
    pages: [{ name: 'Overview', visualCount: 3, width: 1280, height: 720 }],
    visuals: [{ id: 'v1' }],
    sources: [{ type: 'SQL Server', server: 'srv', database: 'mydb', parameterized: false, isNativeQuery: false }],
    ...overrides,
  };
}

describe('toMarkdown', () => {
  it('leads with the model name and the date', () => {
    const markdown = toMarkdown(model());
    expect(markdown).toMatch(/^# Sales Model/);
    expect(markdown).toContain('2026-08-11');
  });

  it('carries both vocabularies side by side', () => {
    const markdown = toMarkdown(model());
    expect(markdown).toContain('mydb.dbo.fact_sales.sale_amount');
    expect(markdown).toContain('Amount');
  });

  it('says unresolved rather than leaving a blank cell', () => {
    // An empty cell reads as "nothing here"; the truth is "we could not tell", and the
    // difference is the whole confidence model.
    expect(toMarkdown(model())).toContain('_unresolved_');
  });

  it('explains what the confidence words mean', () => {
    // The file is read by people who never saw the app, so the legend travels with it —
    // including the part that says how `exact` can be reached by deduction and not only
    // by reading a rename pair.
    const markdown = toMarkdown(model());
    expect(markdown).toContain('`exact` means the source name is stated by the model');
    expect(markdown).toContain('none of them can rename a column');
    expect(markdown).toContain('`inferred` means a step in that chain could not be read');
  });

  it('escapes a pipe so one measure name cannot shred a table', () => {
    const markdown = toMarkdown(model({
      columns: [{ table: 'Sales', name: 'A|B', physicalPath: 'x.y.z', dataType: 'string', confidence: 'exact' }],
    }));
    expect(markdown).toContain('A\\|B');
  });

  it('flattens a newline inside a cell', () => {
    // A multi-line description would otherwise end the table row early and leave the
    // rest of the model rendering as paragraphs.
    const markdown = toMarkdown(model({
      tables: [{ name: 'A\nB', physicalPath: null, columnCount: 0, measureCount: 0, steps: [] }],
    }));
    expect(markdown).not.toMatch(/\| A\nB \|/);
  });

  it('includes DAX and says where the measure is shown', () => {
    const markdown = toMarkdown(model());
    expect(markdown).toContain('```dax');
    expect(markdown).toContain('SUM(Sales[Amount])');
    expect(markdown).toContain('Shown in 1 visual.');
  });

  it('says plainly when no visual shows a measure', () => {
    const markdown = toMarkdown(model({
      measures: [{ table: 'Sales', name: 'Orphan', expression: 'BLANK()', usedByVisuals: [] }],
    }));
    expect(markdown).toContain('_No visual shows this measure._');
  });

  it('can omit DAX for a shorter overview', () => {
    expect(toMarkdown(model(), { dax: false })).not.toContain('```dax');
  });

  it('handles an empty model without producing broken markup', () => {
    const markdown = toMarkdown({
      meta: {}, stats: {}, tables: [], columns: [], measures: [],
      relationships: [], pages: [], visuals: [], sources: [],
    });
    expect(markdown).toContain('# Power BI model');
    expect(markdown).toContain('_None._');
  });

  it('links each table to its own section', () => {
    const markdown = toMarkdown(model({
      tables: [{ name: 'Fact Sales', physicalPath: null, columnCount: 0, measureCount: 0, steps: [] }],
    }));
    expect(markdown).toContain('[Fact Sales](#fact-sales)');
    expect(markdown).toContain('### Fact Sales');
  });

  it('records the Power Query steps a data engineer reads', () => {
    const markdown = toMarkdown(model());
    expect(markdown).toContain('Power Query steps');
    expect(markdown).toContain('Navigation');
  });
});
