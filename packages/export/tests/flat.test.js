/**
 * The flat export. Its column list is a public contract — consumed by refreshes and CI —
 * so the first test pins it exactly, and changing it should mean changing that test on
 * purpose.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import {
  toBindingRows, toFlat, csvLine, FLAT_COLUMNS, FLAT_CONTRACT_VERSION,
} from '../src/flat.js';

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

let model;
let rows;

beforeAll(() => {
  model = toViewerModel(analyzeFromFiles({
    modelFiles: readAll(join(SAMPLE, 'directlake_import_composite.SemanticModel/definition')),
    reportFiles: readAll(join(SAMPLE, 'contoso_project.Report/definition')),
  }), { modelName: 'directlake_import_composite', reportName: 'contoso_project', reportKey: 'contoso_project' });
  rows = [...toBindingRows(model)];
});

describe('flat export contract', () => {
  it('keeps its columns, in order', () => {
    expect(FLAT_CONTRACT_VERSION).toBe(1);
    expect(FLAT_COLUMNS).toEqual([
      'contract_version',
      'report_key', 'report', 'model_key', 'model',
      'page_key', 'page_id', 'page_name',
      'visual_key', 'visual_id', 'visual_type', 'visual_title', 'visual_hidden',
      'binding_key', 'via', 'data_role', 'via_parameter',
      'field_kind', 'field_scope', 'model_table', 'model_field', 'field_hidden', 'dax',
      'source_column',
      'physical_system', 'physical_server', 'physical_database', 'physical_schema',
      'physical_table', 'physical_column', 'physical_path',
      'confidence', 'origin', 'sourceless',
      'page_map',
    ]);
    for (const row of rows) expect(Object.keys(row)).toEqual(FLAT_COLUMNS);
  });

  it('identifies each row by binding and source column', () => {
    const identities = rows.map((r) => `${r.binding_key}|${r.source_column}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('comes out the same twice', () => {
    expect(toFlat(model)).toBe(toFlat(model));
  });
});

describe('flat export rows', () => {
  it('expands a measure to the physical columns behind it, in parts', () => {
    const card = rows.filter((r) => r.visual_id === 'Card_MarginPerOrder');
    // Margin per Order → hidden measures → Quantity, NetPrice, UnitCost and OrderKey.
    expect(card.map((r) => r.physical_column).sort()).toEqual(['NetPrice', 'OrderKey', 'Quantity', 'UnitCost']);
    const orderKey = card.find((r) => r.physical_column === 'OrderKey');
    expect(orderKey).toMatchObject({
      physical_database: 'Lakehouse_Contoso',
      physical_schema: 'dbo',
      physical_table: 'sales',
      physical_path: 'Lakehouse_Contoso.dbo.sales.OrderKey',
      source_column: 'sales[OrderKey]',
      model_field: 'Margin per Order',
      dax: '[_Margin per Order]',
      sourceless: null,
    });
  });

  it('keeps a binding with no physical source, with the reason', () => {
    const machinery = rows.filter((r) => ['calculation-group', 'field-parameter'].includes(r.sourceless));
    expect(machinery.length).toBeGreaterThan(0);
    expect(machinery.every((r) => r.physical_path === null)).toBe(true);
  });

  it('emits a measure no visual reaches as an unbound row', () => {
    const extra = {
      ...model,
      measures: [...model.measures, {
        ...model.measures[0], ref: 'measure:sales[Unused]', table: 'sales', name: 'Unused', expression: '1',
        dependsOn: { measures: [], columns: [], tables: [] }, references: [], sourceless: 'no-column-reference',
      }],
    };
    const unbound = [...toBindingRows(extra)].filter((r) => r.via === 'unbound');
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toMatchObject({
      model_field: 'Unused', sourceless: 'no-column-reference', visual_key: null,
      binding_key: 'contoso_project|unbound|measure|sales[Unused]',
    });
  });
});

describe('csv and ndjson', () => {
  it('quotes only what needs quoting', () => {
    const values = Object.fromEntries(FLAT_COLUMNS.map((c) => [c, null]));
    const line = csvLine({ ...values, dax: 'DIVIDE ( [A], "x" )', visual_title: 'plain', visual_hidden: false });
    expect(line).toContain(',plain,false,');
    expect(line).toContain(',"DIVIDE ( [A], ""x"" )",');
    expect(line.endsWith('\r\n')).toBe(true);
  });

  it('writes a header and parseable lines', () => {
    const csv = toFlat(model).split('\r\n');
    expect(csv[0]).toBe(FLAT_COLUMNS.join(','));
    const ndjson = toFlat(model, { format: 'ndjson' }).trim().split('\n').map((l) => JSON.parse(l));
    expect(ndjson).toHaveLength(rows.length);
    expect(ndjson[0].contract_version).toBe(1);
  });
});
