/**
 * Workspaces: every report paired with the model it names, shared models parsed once, and
 * reports that cannot be paired listed rather than dropped.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { partitionEstate, partitionPbip, keyOf } from '../src/parser/projectLayout.js';
import { findMissingNameOfTargets, resolveFieldParameters } from '../src/parser/fieldParameters.js';
import { parseModel, analyzeReport, identifyProjectStructure } from '../src/index.js';

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

const pbir = (path) => JSON.stringify({ datasetReference: { byPath: { path } } });
const TABLE = 'table Sales\n\tcolumn Amount\n';

describe('partitionEstate', () => {
  it('pairs every report with the model it names, including thin reports over a shared model', () => {
    const estate = partitionEstate(readAll(SAMPLE));
    expect(estate.models.map((m) => m.key)).toEqual(['directlake_import_composite']);
    expect(estate.models[0].reports).toEqual(['contoso_project', 'contoso_sales_thin']);
    expect(estate.reports.map((r) => [r.key, r.modelKey, r.problem])).toEqual([
      ['contoso_project', 'directlake_import_composite', null],
      ['contoso_sales_thin', 'directlake_import_composite', null],
    ]);
    expect([...estate.reports[1].files.keys()]).toContain('pages/e5f6a7b8c9d0e1f2a3b4/page.json');
  });

  it('lists a report whose model is not in the folder, and says why', () => {
    const estate = partitionEstate(new Map(Object.entries({
      'team/Shared.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'team/Good.Report/definition.pbir': pbir('../Shared.SemanticModel'),
      'team/Good.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
      'team/Elsewhere.Report/definition.pbir': pbir('../../other/Remote.SemanticModel'),
      'team/Live.Report/definition.pbir': JSON.stringify({ datasetReference: { byConnection: { connectionString: 'x' } } }),
    })));

    const byKey = Object.fromEntries(estate.reports.map((r) => [r.key, r]));
    expect(byKey['team/Good'].modelKey).toBe('team/Shared');
    expect(byKey['team/Good'].visualCount).toBe(1);
    expect(byKey['team/Elsewhere'].problem).toMatch(/not in this folder/);
    expect(byKey['team/Live'].problem).toMatch(/byConnection/);
    expect(estate.models[0].reports).toEqual(['team/Good']);
  });

  it('keeps the reference a report names, not only a sentence about it', () => {
    // A caller explaining a bad pick has to name the model that was asked for, which
    // means the raw value has to survive being turned into prose.
    const estate = partitionEstate(new Map(Object.entries({
      'team/Shared.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'team/Good.Report/definition.pbir': pbir('../Shared.SemanticModel'),
      'team/Elsewhere.Report/definition.pbir': pbir('../../other/Remote.SemanticModel'),
      'team/Live.Report/definition.pbir': JSON.stringify({ datasetReference: { byConnection: { connectionString: 'x' } } }),
      'team/Silent.Report/definition/pages/p1/page.json': '{}',
    })));

    const byKey = Object.fromEntries(estate.reports.map((r) => [r.key, r]));
    expect(byKey['team/Good'].reference).toBe('../Shared.SemanticModel');
    expect(byKey['team/Elsewhere'].reference).toBe('../../other/Remote.SemanticModel');
    expect(byKey['team/Live'].reference).toBeNull();
    expect(byKey['team/Silent'].reference).toBeNull();
  });

  it('keys on the folder path, so two reports with one name in different folders stay apart', () => {
    expect(keyOf('finance/Sales.Report')).toBe('finance/Sales');
    expect(keyOf('ops/Sales.Report')).toBe('ops/Sales');
    expect(partitionPbip(readAll(SAMPLE)).reportKey).toBe('contoso_project');
  });
});

describe('a shared model, parsed once', () => {
  it('serves every report without being changed by any of them', () => {
    const parsed = parseModel(identifyProjectStructure(
      readAll(join(SAMPLE, 'directlake_import_composite.SemanticModel/definition'))));
    const snapshot = JSON.stringify(parsed.model, (key, value) => (value instanceof Map ? [...value] : value));

    const first = analyzeReport(parsed, identifyProjectStructure(readAll(join(SAMPLE, 'contoso_project.Report/definition'))));
    const second = analyzeReport(parsed, identifyProjectStructure(readAll(join(SAMPLE, 'contoso_sales_thin.Report/definition'))));

    expect(JSON.stringify(parsed.model, (key, value) => (value instanceof Map ? [...value] : value))).toBe(snapshot);
    expect(first.report.visuals).toHaveLength(15);
    expect(second.report.visuals).toHaveLength(2);
    // The same parse behind both — no second chance for the model half to differ.
    expect(first.sourceNames).toBe(second.sourceNames);
  });
});

describe('field parameter entries the model does not contain', () => {
  const model = {
    tables: [
      { name: 'Sales', columns: [{ name: 'Amount' }], measures: [{ name: 'Total' }] },
      {
        name: 'Metric',
        columns: [],
        measures: [],
        partitions: [{
          type: 'calculated',
          sourceExpression: '{ ("Total", NAMEOF([Total]), 0), ("Old", NAMEOF(\'Sales\'[Deleted Measure]), 1), ("Gone", NAMEOF([Retired])) }',
        }],
      },
    ],
  };

  it('reports the targets it could not resolve, and still resolves the rest', () => {
    const missing = findMissingNameOfTargets(model);
    expect(missing.get('Metric')).toEqual([
      { table: 'Sales', name: 'Deleted Measure' },
      { table: null, name: 'Retired' },
    ]);
    expect(resolveFieldParameters(model).get('Metric')).toEqual([{ type: 'measure', table: 'Sales', name: 'Total' }]);
  });
});
