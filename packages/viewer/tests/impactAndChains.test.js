/**
 * Keys, sourceless reasons, reference chains and reverse impact, over the bundled Contoso
 * sample — both of its reports, which read one shared model.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { identifyProjectStructure, parseModel, analyzeReport } from '@pbi-lineage-lenz/core';
import {
  toViewerModel, buildIndex, traceMeasure, describeReferences, expandReferences, bindingKeyOf,
} from '../src/viewerModel.js';
import { reverseImpact, resolveTarget, columnUsage } from '../src/impact.js';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../../samples/contoso');

function readAll(dir, prefix = '') {
  const files = new Map();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) for (const [k, v] of readAll(full, rel)) files.set(k, v);
    else files.set(rel, readFileSync(full, 'utf-8'));
  }
  return files;
}

let project;
let thin;

beforeAll(() => {
  const parsed = parseModel(identifyProjectStructure(
    readAll(join(SAMPLE, 'directlake_import_composite.SemanticModel/definition'))));
  const meta = (reportKey) => ({ modelName: 'directlake_import_composite', reportName: reportKey, reportKey });
  project = toViewerModel(analyzeReport(parsed,
    identifyProjectStructure(readAll(join(SAMPLE, 'contoso_project.Report/definition')))), meta('contoso_project'));
  thin = toViewerModel(analyzeReport(parsed,
    identifyProjectStructure(readAll(join(SAMPLE, 'contoso_sales_thin.Report/definition')))), meta('contoso_sales_thin'));
});

describe('stable keys', () => {
  it('scopes a visual id to its report and page', () => {
    const a = project.visuals.find((v) => v.id === 'Card_SalesAmount');
    const b = thin.visuals.find((v) => v.id === 'Card_SalesAmount');
    // The same raw id in both reports — exactly what merges two visuals downstream.
    expect(a.id).toBe(b.id);
    expect(a.key).not.toBe(b.key);
    expect(b.key).toBe('contoso_sales_thin/e5f6a7b8c9d0e1f2a3b4/Card_SalesAmount');
  });

  it('keys every visual and binding uniquely, and the same way twice', () => {
    for (const model of [project, thin]) {
      const visualKeys = model.visuals.map((v) => v.key);
      expect(new Set(visualKeys).size).toBe(visualKeys.length);
      const bindingKeys = model.visuals.flatMap((v) => v.fields.map((f) => bindingKeyOf(v, f)));
      expect(new Set(bindingKeys).size).toBe(bindingKeys.length);
    }
    const pageKeys = [...project.pages, ...thin.pages].map((p) => p.key);
    expect(new Set(pageKeys).size).toBe(pageKeys.length);
  });
});

describe('sourceless reasons', () => {
  it('gives every column without a source a reason, and only a gap counts as unresolved', () => {
    const reasons = new Set(project.columns.map((c) => c.sourceless));
    expect(reasons).toEqual(new Set([null, 'unresolved', 'field-parameter', 'calculated-column', 'calculation-group']));

    expect(project.columns.find((c) => c.ref === 'column:product[Margin Tier]').sourceless).toBe('calculated-column');
    expect(project.columns.find((c) => c.table === 'Time Intelligence').sourceless).toBe('calculation-group');
    expect(project.columns.find((c) => c.table === 'Metric Selection').sourceless).toBe('field-parameter');
    expect(project.columns.filter((c) => c.physicalPath).every((c) => c.sourceless === null)).toBe(true);
    expect(project.columns.filter((c) => c.sourceless === 'unresolved').length)
      .toBe(project.stats.confidence.unresolved);
  });

  it('marks a measure that reads no column', () => {
    expect(project.measures.find((m) => m.name === 'Sales Amount').sourceless).toBeNull();
    // Through two hidden levels, it still reaches `sales` columns.
    expect(project.measures.find((m) => m.name === 'Margin per Order').sourceless).toBeNull();
  });
});

describe('reference chains', () => {
  it('reads an alias measure through every hidden level, in resolution order', () => {
    const index = buildIndex(project);
    const alias = project.measures.find((m) => m.name === 'Margin per Order');
    const chain = describeReferences(alias, index);

    expect(chain.map((r) => [r.name, r.depth])).toEqual([
      ['_Margin per Order', 1],
      ['_Margin Value', 2],
      ['_Order Volume', 2],
      ['_Net Sales', 3],
      ['Total Cost', 3],
    ]);
    expect(chain.filter((r) => r.isHidden).map((r) => r.name))
      .toEqual(['_Margin per Order', '_Margin Value', '_Order Volume', '_Net Sales']);
    expect(chain[0].expression).toBe('DIVIDE ( [_Margin Value], [_Order Volume] )');
    // The root is not part of its own chain.
    expect(chain.some((r) => r.ref === alias.ref)).toBe(false);
    expect(alias.referencesTruncated).toBe(false);
  });

  it('stops at a cycle, a depth cap and a size cap without hanging', () => {
    const a = { ref: 'measure:T[A]', table: 'T', name: 'A', expression: '[B]', dependsOn: { measures: ['T[B]'], columns: [] } };
    const b = { ref: 'measure:T[B]', table: 'T', name: 'B', expression: '[A] + [C]', dependsOn: { measures: ['T[A]', 'T[C]'], columns: [] } };
    const c = { ref: 'measure:T[C]', table: 'T', name: 'C', expression: 'x'.repeat(50), dependsOn: { measures: [], columns: [] } };
    const lookup = { byRef: new Map([a, b, c].map((m) => [m.ref, m])), byName: new Map() };

    expect(expandReferences(a, lookup).references.map((r) => r.ref)).toEqual(['measure:T[B]', 'measure:T[C]']);
    expect(expandReferences(a, lookup, { maxDepth: 1, maxChars: 8000 })).toMatchObject({ truncated: true });
    expect(expandReferences(a, lookup, { maxDepth: 6, maxChars: 20 })).toMatchObject({ truncated: true });
  });

  it('traces through a calculated column to the columns it reads', () => {
    const index = buildIndex(project);
    const fake = {
      ref: 'measure:product[High Margin Count]', kind: 'measures', table: 'product', name: 'High Margin Count',
      dependsOn: { measures: [], columns: ['product[Margin Tier]'], tables: [] },
    };
    index.byRef.set(fake.ref, fake);
    const { columns, unresolved } = traceMeasure(fake.ref, project, index);
    expect(columns.map((c) => c.name).sort()).toEqual(['Cost', 'Price']);
    expect(unresolved).toEqual([]);
  });
});

describe('reverse impact', () => {
  it('finds a column by its physical name, and every visual that reaches it through hidden measures', () => {
    const result = reverseImpact([project, thin], { column: 'dbo.sales.OrderKey' });

    expect(result.found).toBe(true);
    expect(result.reports.map((r) => r.reportKey)).toEqual(['contoso_project', 'contoso_sales_thin']);

    const inProject = result.reports[0];
    expect(inProject.targets.map((t) => t.ref)).toEqual(['column:sales[OrderKey]']);
    const alias = inProject.measures.find((m) => m.name === 'Margin per Order');
    // OrderKey → _Order Volume → _Margin per Order → Margin per Order.
    expect(alias.hops).toBe(3);
    expect(alias.path).toEqual([
      'column:sales[OrderKey]', 'measure:sales[_Order Volume]', 'measure:sales[_Margin per Order]',
      'measure:sales[Margin per Order]',
    ]);

    // A direct-binding reading would find no visual here at all: no visual names OrderKey
    // or any measure that reads it directly.
    const thinVisuals = result.reports[1].visuals.map((v) => v.key);
    expect(thinVisuals).toContain('contoso_sales_thin/e5f6a7b8c9d0e1f2a3b4/Card_MarginPerOrder');
    expect(result.totals.reports).toBe(2);
    // One shared model: its measures are counted once, not once per report.
    expect(result.totals.measures).toBe(inProject.measures.length);
  });

  it('accepts a physical table wildcard, a model column, and a measure', () => {
    // Physical, so it also finds model columns in other tables that read `dbo.sales`.
    const wildcard = resolveTarget(project, { column: 'sales.*' });
    expect(wildcard.columns.length).toBeGreaterThan(3);
    expect(wildcard.columns.every((c) => [c.physicalPath, ...c.alsoFrom]
      .some((path) => /\.dbo\.sales\.[^.]+$/.test(path ?? '')))).toBe(true);

    expect(resolveTarget(project, { column: "'sales'[OrderKey]" }).columns).toHaveLength(1);
    const modelTable = resolveTarget(project, { column: 'sales[*]' }).columns;
    expect(modelTable.length).toBe(project.columns.filter((c) => c.table === 'sales').length);
    expect(resolveTarget(project, { measure: 'total cost' }).measures.map((m) => m.ref))
      .toEqual(['measure:sales[Total Cost]']);
  });

  it('says so when nothing matches', () => {
    const result = reverseImpact([project], { column: 'no_such_table.no_such_column' });
    expect(result.found).toBe(false);
    expect(result.totals.visuals).toBe(0);
  });

  it('summarises usage per column the same way a single impact walk does', () => {
    const usage = columnUsage(project);
    const walk = reverseImpact(project, { column: 'sales[OrderKey]' }).reports[0];
    expect(usage.get('column:sales[OrderKey]')).toEqual({
      measures: walk.measures.length,
      visuals: walk.visuals.length,
      pages: walk.pages.length,
    });
  });
});

describe('references spelled in a different case', () => {
  // DAX is case-insensitive, and authors are not consistent. A reference Power BI resolves
  // must resolve here too, or everything underneath it vanishes from every answer.
  const measure = (name, measures = [], columns = []) => ({
    ref: `measure:T[${name}]`, kind: 'measures', table: 'T', name, expression: '', isHidden: false,
    dependsOn: { measures, columns, tables: [] }, usedByVisuals: [],
  });
  const model = {
    meta: {},
    columns: [{ ref: 'column:T[Amount]', table: 'T', name: 'Amount', physicalPath: 'db.t.amount' }],
    measures: [
      measure('Orders with Target not Met', [], ['T[amount]']),
      measure('Headline', ['T[Orders with Target Not Met]']),
    ],
    visuals: [{ ref: 'visual:p/v', key: 'R/p/v', id: 'v', page: 'p', fields: [{ kind: 'measure', ref: 'measure:T[Headline]' }] }],
    pages: [{ id: 'p', key: 'R/p', name: 'Page' }],
  };

  it('traces through them', () => {
    const index = buildIndex(model);
    expect(traceMeasure('measure:T[Headline]', model, index).columns.map((c) => c.ref)).toEqual(['column:T[Amount]']);
  });

  it('finds the visual behind them in reverse', () => {
    const result = reverseImpact(model, { column: 'db.t.amount' });
    expect(result.reports[0].visuals.map((v) => v.key)).toEqual(['R/p/v']);
    expect(columnUsage(model).get('column:T[Amount]')).toEqual({ measures: 2, visuals: 1, pages: 1 });
  });
});

describe('two answers to one question', () => {
  it('agrees with the flat export on which visuals each column reaches', async () => {
    // The flat export traces forwards from every binding; reverse impact walks backwards
    // from every column. Independent code paths — if they ever disagree, one is wrong.
    const { toBindingRows } = await import('@pbi-lineage-lenz/export');
    const { impactInModel } = await import('../src/impact.js');
    for (const model of [project, thin]) {
      const flat = new Map();
      for (const row of toBindingRows(model)) {
        if (!row.visual_key || !row.source_column) continue;
        if (!flat.has(row.source_column)) flat.set(row.source_column, new Set());
        flat.get(row.source_column).add(row.visual_key);
      }
      const index = buildIndex(model);
      for (const column of model.columns.filter((c) => !c.expression)) {
        const reverse = impactInModel(model, { columns: [column], measures: [] }, index).visuals.map((v) => v.key).sort();
        expect([...(flat.get(`${column.table}[${column.name}]`) ?? [])].sort()).toEqual(reverse);
      }
    }
  });
});

