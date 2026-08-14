/**
 * The sample that ships with the repository.
 *
 * `realProject.test.js` guards far more, but it skips itself when `D:/sample_powerbi` is
 * absent — which is every machine except one. A contributor therefore sees a green suite
 * with the entire real-world guard silently switched off, and the synthetic fixtures were
 * all passing while real-world resolution sat at 0.2%.
 *
 * This runs everywhere, because the project it reads is committed next to it. It is
 * deliberately a different shape from the other one: a Fabric Lakehouse SQL endpoint
 * rather than BigQuery, and a report whose name shares nothing with its model, so the
 * connector handling and the `definition.pbir` pairing are both exercised by default.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeFromFiles, partitionPbip, describeChoice } from '../src/index.js';
import { CONFIDENCE } from '../src/naming/sourceNameResolver.js';
import { toViewerModel, describeModelShape, TABLE_ROLE } from '@pbi-lineage-lenz/viewer';
import { runChecks } from 'pbi-lineage-lenz/checks';

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

describe('the bundled Contoso sample', () => {
  let partition;
  let analysis;

  beforeAll(() => {
    expect(existsSync(SAMPLE)).toBe(true);
    partition = partitionPbip(readAll(SAMPLE));
    analysis = analyzeFromFiles({
      modelFiles: partition.modelFiles,
      reportFiles: partition.reportFiles ?? undefined,
    });
  });

  it('pairs the report with the model it names, not the one it resembles', () => {
    // `contoso_project.Report` reads `directlake_import_composite.SemanticModel`. No part
    // of either name appears in the other, so this can only come from definition.pbir.
    expect(partition.modelName).toBe('directlake_import_composite');
    expect(partition.reportName).toBe('contoso_project');
    // One pair here, so nothing to disambiguate and nothing to warn about.
    expect(describeChoice(partition)).toBeNull();
  });

  it('parses the whole project', () => {
    expect(analysis.stats.tables).toBe(9);
    expect(analysis.stats.measures).toBe(7);
    expect(analysis.stats.visuals).toBe(14);
    expect(analysis.report.pages).toHaveLength(2);
  });

  it('carries a calculation group and a field parameter, both bound to a visual', () => {
    // The README says hidden visuals are "exactly where field parameters and calculation
    // groups live", and for a long time the sample behind every screenshot contained
    // neither — so the claim was never demonstrated and nothing here could break if the
    // handling regressed. Both are now in the sample and bound to a real visual.
    const model = toViewerModel(analysis, { modelName: 'contoso' });

    const group = model.tables.find((t) => t.kind === 'calculationGroup');
    expect(group.name).toBe('Time Intelligence');
    expect(group.calculationItems.map((i) => i.name))
      .toEqual(['Current', 'YTD', 'Prior year', 'YoY %']);
    expect(group.calculationItems[1].expression).toMatch(/SELECTEDMEASURE/);

    const parameter = model.tables.find((t) => t.kind === 'fieldParameter');
    expect(parameter.name).toBe('Metric Selection');
    expect(parameter.offers).toHaveLength(5);
    expect(parameter.offers.every((o) => o.kind === 'measure')).toBe(true);

    // The half that matters: both reach a visual, so the whole path is exercised rather
    // than only the detection.
    const chart = model.visuals.find((v) => v.id === 'Chart_MetricByMonth');
    expect(chart.appliesCalculationGroups).toEqual(['Time Intelligence']);
    expect(chart.fields.filter((f) => f.via === 'parameter').length).toBeGreaterThan(0);

    // And a measure it shows knows it is being rewritten.
    const measure = model.measures.find((m) => m.name === 'Sales Amount');
    expect(measure.underCalculationGroups).toEqual(['Time Intelligence']);
  });

  it('does not count the machinery as columns it failed to trace', () => {
    // The five columns of the field parameter and the calculation group have no physical
    // source and never could. Counting them as unresolved would drop this sample's
    // coverage from 95% to 89% and send a reader looking for five missing things.
    const { stats } = analysis.sourceNames;
    expect(stats.modelDefined).toBe(5);
    expect(stats.unresolved).toBe(4);
    expect(stats.coverage).toBeGreaterThan(0.95);
  });

  it('resolves a Fabric Lakehouse SQL endpoint to a three-part path', () => {
    // The second connector in the suite. Everything else was built against BigQuery, and
    // a resolver tuned to one warehouse would pass every other test in this file.
    const column = analysis.sourceNames.columns.get('customer[CustomerKey]');
    expect(column.physicalPath).toBe('Lakehouse_Contoso.dbo.customer.CustomerKey');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);

    const source = analysis.dataSources.find((s) => s.type === 'SQL Server');
    expect(source.database).toBe('Lakehouse_Contoso');
    // The sanitised placeholder, never the workspace that produced this file.
    expect(source.server).toBe('contoso-lakehouse.datawarehouse.fabric.microsoft.com');
  });

  it('resolves the Direct Lake fact table the partition names outright', () => {
    // `partition sales = entity` with `mode: directLake`. This resolved to nothing until
    // the shape was handled at all — the dimensions, imported through M, resolved fine,
    // so the gap fell exactly on the table Fabric users are building now.
    const column = analysis.sourceNames.columns.get('sales[OrderKey]');
    expect(column.physicalPath).toBe('Lakehouse_Contoso.dbo.sales.OrderKey');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.reason).toMatch(/Direct Lake/);
  });

  it('traces most of the model and states rather than assumes', () => {
    const { stats } = analysis.sourceNames;
    // 78% before Direct Lake was understood, 95% after.
    expect(stats.coverage).toBeGreaterThan(0.9);
    expect(stats.inferred).toBe(0);
    expect(stats.sourced).toBe(stats.exact - stats.computed - stats.modelDefined);
  });

  it('reads a star out of the join directions', () => {
    const shape = describeModelShape(toViewerModel(analysis, { modelName: 'contoso' }));
    // The field parameter and the calculation group join nothing, which is what makes
    // `standalone` a bucket a newcomer cannot read — hence the separate kind.
    expect(shape.counts).toEqual({ fact: 2, dimension: 4, bridge: 0, standalone: 3 });
    expect(shape.dangling).toEqual([]);
    expect(shape.tables.get('sales').role).toBe(TABLE_ROLE.FACT);
  });

  it('reports nothing broken and nothing dangling', () => {
    const findings = runChecks(toViewerModel(analysis, { modelName: 'contoso' }));
    expect(findings.find((f) => f.rule === 'broken').items).toEqual([]);
    expect(findings.find((f) => f.rule === 'dangling-visuals').items).toEqual([]);
  });

  it('carries no trace of the private model this was developed against', () => {
    // The other sample is a real production report. Nothing from it may reach a public
    // repository, and this is the check that runs on every commit rather than by memory.
    const text = [...readAll(SAMPLE).values()].join('\n').toLowerCase();
    // Kept in step with the `no-leaks` job in `.github/workflows/ci.yml`, which greps the
    // whole tree. This one covers the sample specifically and runs on every `npm test`.
    for (const secret of [
      'ingka', 'ilo-ia-prod', 'sample_powerbi', '77oajh3', 'fauoi4qi',
      'oversell', 'business_unit', 'report_fulfilment', 'hfb', 'pia link',
      'wait time', 'switch_over', 'cut off time',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
