/**
 * Where the model is, given a folder somebody pointed at.
 *
 * The failure this guards against is not a crash — it is the tool saying "no TMDL files
 * here" about a folder that plainly contains a model, because the user pointed one level
 * up or one level down from where the code expected. That reads as the tool being broken,
 * and in the web app it happens on the very first interaction.
 */

import { describe, it, expect } from 'vitest';
import {
  partitionPbip, shouldRead, normalizePath, describeProblem, planOpen, joinReportToModel,
} from '../src/parser/projectLayout.js';

const TABLE = 'table Sales\n\tcolumn Amount\n';

function map(entries) {
  return new Map(Object.entries(entries));
}

describe('partitionPbip', () => {
  it('finds both halves from the project root', () => {
    const result = partitionPbip(map({
      'Shop.pbip': '{}',
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'Shop.SemanticModel/definition/expressions.tmdl': 'expression P = "x"',
      'Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(result.layout).toBe('project');
    expect(result.modelName).toBe('Shop');
    expect(result.reportName).toBe('Shop');
    expect([...result.modelFiles.keys()]).toContain('tables/Sales.tmdl');
    expect([...result.reportFiles.keys()]).toContain('pages/p1/visuals/v1/visual.json');
  });

  it('relativizes to `definition`, since that is what makes a visual path recognisable', () => {
    // `identifyProjectStructure` keys off `/visuals/` and `/page.json`. Paths that still
    // carry the project prefix match anyway, but the model half would carry
    // `definition/expressions.tmdl` into a check that wants it at the root.
    const result = partitionPbip(map({
      'Shop.SemanticModel/definition/expressions.tmdl': 'expression P = "x"',
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
    }));
    expect(result.modelFiles.has('expressions.tmdl')).toBe(true);
  });

  it('accepts the .SemanticModel folder on its own', () => {
    const result = partitionPbip(map({
      'definition/tables/Sales.tmdl': TABLE,
      '.platform': '{}',
    }));
    expect(result.modelFiles.has('tables/Sales.tmdl')).toBe(true);
    expect(result.reportFiles).toBeNull();
    expect(describeProblem(result)).toBeNull();
  });

  it('accepts a bare definition folder', () => {
    const result = partitionPbip(map({ 'tables/Sales.tmdl': TABLE }));
    expect(result.layout).toBe('definition');
    expect(result.modelFiles.has('tables/Sales.tmdl')).toBe(true);
    expect(describeProblem(result)).toBeNull();
  });

  it('reads a model with no report rather than refusing the folder', () => {
    // A semantic model is often maintained in its own repo, with no report beside it.
    const result = partitionPbip(map({ 'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE }));
    expect(result.layout).toBe('semantic-model');
    expect(result.reportFiles).toBeNull();
    expect(describeProblem(result)).toBeNull();
  });

  it('normalizes Windows separators', () => {
    const result = partitionPbip(map({ 'Shop.SemanticModel\\definition\\tables\\Sales.tmdl': TABLE }));
    expect(result.modelFiles.has('tables/Sales.tmdl')).toBe(true);
  });

  it('matches the folder suffix case-insensitively', () => {
    const result = partitionPbip(map({ 'shop.semanticmodel/definition/tables/Sales.tmdl': TABLE }));
    expect(result.modelName).toBe('shop');
    expect(result.modelFiles.has('tables/Sales.tmdl')).toBe(true);
  });

  it('names a problem for a folder holding no model', () => {
    const result = partitionPbip(map({ 'readme.json': '{}' }));
    expect(result.layout).toBe('unknown');
    expect(describeProblem(result)).toMatch(/\.SemanticModel/);
  });

  it('handles a project nested below the picked folder', () => {
    // Picking a repo root rather than the project folder inside it is an easy slip.
    const result = partitionPbip(map({
      'src/reports/Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'src/reports/Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));
    expect(result.layout).toBe('project');
    expect(result.modelFiles.has('tables/Sales.tmdl')).toBe(true);
    expect(result.reportFiles.has('pages/p1/visuals/v1/visual.json')).toBe(true);
  });
});

describe('partitionPbip — a folder holding several items', () => {
  /** `definition.pbir` states which model a report reads. Nothing else does. */
  const pbir = (modelFolder) => JSON.stringify({
    version: '4.0',
    datasetReference: { byPath: { path: `../${modelFolder}` } },
  });

  // A Fabric workspace synced to git: every item side by side, names that do not line up,
  // and one report that was never finished.
  const workspace = map({
    'contoso_import.SemanticModel/definition/tables/Sales.tmdl': TABLE,
    'contoso_import.Report/definition.pbir': pbir('contoso_import.SemanticModel'),
    'contoso_import.Report/definition/pages/p1/page.json': '{}',

    'directlake_import_composite.SemanticModel/definition/tables/Orders.tmdl': TABLE,
    'contoso_project.Report/definition.pbir': pbir('directlake_import_composite.SemanticModel'),
    'contoso_project.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    'contoso_project.Report/definition/pages/p1/visuals/v2/visual.json': '{}',
  });

  it('pairs a report with the model it names, not the one it sorts next to', () => {
    // The bug this replaces read the first `.SemanticModel` and the first `.Report`
    // independently, so it paired `contoso_import.SemanticModel` with whichever report
    // came first — and the pair that matters here shares no part of its name.
    const result = partitionPbip(workspace);

    expect(result.modelName).toBe('directlake_import_composite');
    expect(result.reportName).toBe('contoso_project');
  });

  it('reads the visuals of the report it chose', () => {
    const result = partitionPbip(workspace);
    expect([...result.reportFiles.keys()]).toContain('pages/p1/visuals/v1/visual.json');
  });

  it('prefers the report that has visuals over the one that has none', () => {
    // Both pairs are stated correctly; only one of them is worth opening.
    expect(partitionPbip(workspace).pairs[0]).toEqual({
      report: 'contoso_project', model: 'directlake_import_composite', visualCount: 2,
    });
  });

  it('says how many it found, so the caller need not choose silently', () => {
    const result = partitionPbip(workspace);
    expect(result.layout).toBe('project-multi');
    expect(result.pairs.map((pair) => pair.report).sort())
      .toEqual(['contoso_import', 'contoso_project']);
  });

  it('ignores a reference to a model that is not there', () => {
    // A half-migrated repository. Falling back beats resolving to a folder of nothing.
    const result = partitionPbip(map({
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'Shop.Report/definition.pbir': pbir('Deleted.SemanticModel'),
      'Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(result.modelName).toBe('Shop');
    expect(result.reportFiles.size).toBeGreaterThan(0);
  });

  it('survives a definition.pbir that is not valid JSON', () => {
    const result = partitionPbip(map({
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'Shop.Report/definition.pbir': '{ this is not json',
      'Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(result.modelName).toBe('Shop');
    expect(result.layout).toBe('project');
  });

  it('leaves a single-pair project on the path it always took', () => {
    // The fallback has to stay exact: most projects have one of each and no `.pbir` worth
    // reading, and this change must be invisible to them.
    const result = partitionPbip(map({
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(result).toMatchObject({ layout: 'project', modelName: 'Shop', reportName: 'Shop' });
    expect(result.pairs).toEqual([]);
  });
});

describe('shouldRead', () => {
  it('takes the file types the parsers understand', () => {
    expect(shouldRead('definition/tables/Sales.tmdl')).toBe(true);
    expect(shouldRead('definition/pages/p1/visuals/v1/visual.json')).toBe(true);
    expect(shouldRead('definition.pbir')).toBe(true);
    expect(shouldRead('.platform')).toBe(true);
  });

  it('skips the directories that make a real project slow to read', () => {
    // `.pbi/cache.abf` alone is tens of megabytes, and a project under version control
    // has a `.git` larger than everything else combined. Reading either in a browser
    // looks like a hang.
    expect(shouldRead('.git/objects/ab/cdef.json')).toBe(false);
    expect(shouldRead('Shop.SemanticModel/.pbi/localSettings.json')).toBe(false);
    expect(shouldRead('node_modules/thing/package.json')).toBe(false);
  });

  it('skips files the parsers have no use for', () => {
    expect(shouldRead('StaticResources/logo.png')).toBe(false);
    expect(shouldRead('.pbi/cache.abf')).toBe(false);
    expect(shouldRead('README.md')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('produces forward slashes with no leading dot-slash', () => {
    expect(normalizePath('.\\a\\b.tmdl')).toBe('a/b.tmdl');
    expect(normalizePath('/a/b.tmdl')).toBe('a/b.tmdl');
  });
});

/**
 * Which screen a pick earns.
 *
 * The regression that matters most here is the quiet one: a folder that opens straight to
 * a viewer today must keep doing so. Diverting an unambiguous project to a chooser would
 * add a click to the common case to solve a problem it does not have.
 */
describe('planOpen', () => {
  const pbir = (modelFolder) => JSON.stringify({
    version: '4.0',
    datasetReference: { byPath: { path: `../${modelFolder}` } },
  });

  it('asks which report, when the folder holds more than one', () => {
    const plan = planOpen(map({
      'contoso_import.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'contoso_import.Report/definition.pbir': pbir('contoso_import.SemanticModel'),
      'contoso_import.Report/definition/pages/p1/page.json': '{}',
      'directlake_import_composite.SemanticModel/definition/tables/Orders.tmdl': TABLE,
      'contoso_project.Report/definition.pbir': pbir('directlake_import_composite.SemanticModel'),
      'contoso_project.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('chooser');
    expect(plan.estate.reports.map((report) => report.key).sort())
      .toEqual(['contoso_import', 'contoso_project']);
  });

  it('asks which model, when there are two of them and one report', () => {
    // Two models is ambiguous even with a single report: the report names one of them,
    // and the other is a model somebody may well have opened the folder to read.
    const plan = planOpen(map({
      'A.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'B.SemanticModel/definition/tables/Orders.tmdl': TABLE,
      'A.Report/definition.pbir': pbir('A.SemanticModel'),
      'A.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('chooser');
    expect(plan.estate.models.map((model) => model.key)).toEqual(['A', 'B']);
  });

  it('opens a single project straight away, with nothing to ask', () => {
    const plan = planOpen(map({
      'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE,
      'Shop.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('viewer');
    expect(plan.partition).toMatchObject({ modelName: 'Shop', reportName: 'Shop' });
  });

  it('opens a lone .SemanticModel folder straight away', () => {
    const plan = planOpen(map({ 'Shop.SemanticModel/definition/tables/Sales.tmdl': TABLE }));
    expect(plan.screen).toBe('viewer');
    expect(plan.partition.layout).toBe('semantic-model');
  });

  it('opens a bare definition folder straight away', () => {
    const plan = planOpen(map({ 'tables/Sales.tmdl': TABLE }));
    expect(plan.screen).toBe('viewer');
    expect(plan.partition.layout).toBe('definition');
  });

  it('asks for the model by name when the report folder itself was picked', () => {
    // The pick to expect, not the pick to correct. The report states which model it reads
    // and cannot open it, so the only thing missing is that one folder.
    const plan = planOpen(map({
      'definition.pbir': pbir('directlake_import_composite.SemanticModel'),
      'definition/pages/p1/visuals/v1/visual.json': '{}',
    }), { name: 'contoso_project.Report' });

    expect(plan.screen).toBe('model-wanted');
    expect(plan.report.wanted).toBe('directlake_import_composite.SemanticModel');
    expect(plan.report.reference).toBe('../directlake_import_composite.SemanticModel');
    expect(plan.report.name).toBe('contoso_project.Report');
    // Relativized past `definition`, the way the report parser wants it.
    expect([...plan.report.files.keys()]).toContain('pages/p1/visuals/v1/visual.json');
  });

  it('asks for the model when the folder holds exactly one report and no model', () => {
    const plan = planOpen(map({
      'contoso_project.Report/definition.pbir': pbir('directlake_import_composite.SemanticModel'),
      'contoso_project.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('model-wanted');
    expect(plan.report.wanted).toBe('directlake_import_composite.SemanticModel');
    expect(plan.report.name).toBe('contoso_project.Report');
  });

  it('says so when the picked report folder reads a published model', () => {
    const plan = planOpen(map({
      'definition.pbir': JSON.stringify({
        datasetReference: { byConnection: { connectionString: 'x' } },
      }),
      'definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('problem');
    expect(plan.message).toMatch(/published semantic model/);
  });

  it('names the report folder when it was picked from a workspace with no model', () => {
    const plan = planOpen(map({
      'contoso_project.Report/definition.pbir': pbir('directlake_import_composite.SemanticModel'),
      'contoso_project.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
      'contoso_sales_thin.Report/definition.pbir': pbir('directlake_import_composite.SemanticModel'),
    }));

    expect(plan.screen).toBe('problem');
    expect(plan.message).toMatch(/^contoso_project\.Report is a report folder/);
  });

  it('joins a separately-picked report and model into one partition', () => {
    // Two pickers, each relativized to its own folder — exactly the shape one pick would
    // have produced, so nothing downstream learns how many dialogs it took.
    const joined = joinReportToModel({
      reportFiles: map({
        'definition.pbir': pbir('Shop.SemanticModel'),
        'definition/pages/p1/visuals/v1/visual.json': '{}',
      }),
      reportName: 'Shop.Report',
      modelFiles: map({ 'definition/tables/Sales.tmdl': TABLE }),
      modelName: 'Shop.SemanticModel',
    });

    expect(joined).toMatchObject({
      modelName: 'Shop', reportName: 'Shop', modelKey: 'Shop', reportKey: 'Shop',
    });
    expect([...joined.modelFiles.keys()]).toEqual(['tables/Sales.tmdl']);
    expect([...joined.reportFiles.keys()]).toContain('pages/p1/visuals/v1/visual.json');
  });

  it('joins a model picked with no report at all', () => {
    const joined = joinReportToModel({
      reportFiles: null,
      reportName: null,
      modelFiles: map({ 'definition/tables/Sales.tmdl': TABLE }),
      modelName: 'Shop.SemanticModel',
    });

    expect(joined.reportFiles).toBeNull();
    expect(joined.modelName).toBe('Shop');
  });

  it('says so when the report reads a published model rather than one on disk', () => {
    const plan = planOpen(map({
      'Live.Report/definition.pbir': JSON.stringify({
        datasetReference: { byConnection: { connectionString: 'x' } },
      }),
      'Live.Report/definition/pages/p1/visuals/v1/visual.json': '{}',
    }));

    expect(plan.screen).toBe('problem');
    expect(plan.message).toMatch(/published semantic model/);
  });

  it('falls back to the generic message for a folder that is neither', () => {
    const plan = planOpen(map({ 'readme.json': '{}' }));
    expect(plan.screen).toBe('problem');
    expect(plan.message).toMatch(/No TMDL files here/);
  });
});
