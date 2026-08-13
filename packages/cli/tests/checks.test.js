/**
 * The CI gate's rules.
 *
 * A gate is only worth having if it is believed, so most of these test the ways it used
 * to cry wolf. Running the first version over one real model reported 166 broken
 * references and 101 unused measures; the true figures were 0 and 14.
 */

import { describe, it, expect } from 'vitest';
import { runChecks, exitCodeFor, DEFAULT_FAIL_ON } from '../src/checks.js';

function measure(table, name, extra = {}) {
  return {
    ref: `measure:${table}[${name}]`,
    table,
    name,
    usedByVisuals: [],
    dependsOn: { measures: [], columns: [], tables: [] },
    ...extra,
  };
}

function model(overrides = {}) {
  return {
    meta: { modelName: 'Test' },
    stats: { confidence: { coverage: 0.8 } },
    tables: [{ ref: 'table:Sales', name: 'Sales' }],
    columns: [{ ref: 'column:Sales[Amount]', table: 'Sales', name: 'Amount', physicalPath: 'db.dbo.f.amt' }],
    measures: [],
    visuals: [],
    pages: [],
    ...overrides,
  };
}

const find = (findings, rule) => findings.find((f) => f.rule === rule);

describe('broken references', () => {
  it('reports a measure reading a column that does not exist', () => {
    const findings = runChecks(model({
      measures: [measure('Sales', 'Total', { dependsOn: { measures: [], columns: ['Sales[Nope]'], tables: [] } })],
    }));
    expect(find(findings, 'broken').items).toEqual(['Sales[Total] reads Sales[Nope], which does not exist']);
  });

  it('accepts a reference that differs only in case', () => {
    // DAX is case-insensitive. `[Orders on Time %]` resolves to a measure defined
    // as `Orders On Time %`, and calling that broken reports the comparison rather
    // than a defect — which is exactly what it did on a real model.
    const findings = runChecks(model({
      measures: [
        measure('Sales', 'Orders On Time %'),
        measure('Sales', 'Index', { dependsOn: { measures: ['Sales[orders on time %]'], columns: [], tables: [] } }),
      ],
    }));
    expect(find(findings, 'broken').items).toEqual([]);
  });

  it('accepts a bare name that resolves to a column rather than a measure', () => {
    // `[source_transaction_name]` in a row context is a column reference. A text parser
    // cannot tell it from a measure reference, so a name that exists as either is fine.
    const findings = runChecks(model({
      measures: [measure('Sales', 'Label', { dependsOn: { measures: ['Amount'], columns: [], tables: [] } })],
    }));
    expect(find(findings, 'broken').items).toEqual([]);
  });

  it('reports a missing table', () => {
    const findings = runChecks(model({
      measures: [measure('Sales', 'X', { dependsOn: { measures: [], columns: [], tables: ['Ghost'] } })],
    }));
    expect(find(findings, 'broken').items).toEqual(['Sales[X] reads table Ghost, which does not exist']);
  });
});

describe('dangling visual references', () => {
  /** A visual referencing one measure by a named route. */
  const visual = (name, table = 'Measure', via = 'format') => ({
    ref: 'visual:p1/v1', id: 'v1', type: 'cardVisual', title: 'Card', page: 'p1',
    fields: [{ kind: 'measure', table, name, via }],
  });
  const page = { id: 'p1', name: 'Sales' };

  it('reports a visual pointing at a measure the model does not have', () => {
    const findings = runChecks(model({ visuals: [visual('Deleted')], pages: [page] }));
    const dangling = find(findings, 'dangling-visuals');

    expect(dangling.items).toHaveLength(1);
    expect(dangling.items[0]).toMatch(/Measure\[Deleted\]/);
  });

  it('names the visual, the page and the route', () => {
    // Which of six formatting cards holds the dead reference is the whole difficulty of
    // fixing one, so the finding has to say more than the measure name.
    const findings = runChecks(model({ visuals: [visual('Deleted')], pages: [page] }));

    expect(find(findings, 'dangling-visuals').items[0]).toBe(
      'Measure[Deleted] — referenced by Card on Sales (format)');
  });

  it('does not report a measure the model has', () => {
    const findings = runChecks(model({
      measures: [{ ref: 'measure:Measure[Live]', table: 'Measure', name: 'Live', dependsOn: { columns: [], measures: [], tables: [] }, usedByVisuals: [] }],
      visuals: [visual('Live')],
      pages: [page],
    }));
    expect(find(findings, 'dangling-visuals').items).toEqual([]);
  });

  it('does not report a report-level measure', () => {
    // Defined in reportExtensions.json, not in the semantic model — usually because the
    // report is live-connected to a model its author cannot edit. Absent from the model
    // and entirely alive. Without this the rule accuses every one of them.
    const findings = runChecks(model({
      reportMeasures: [{ table: 'Range', name: 'Portal Link' }],
      visuals: [visual('Portal Link', 'Range')],
      pages: [page],
    }));
    expect(find(findings, 'dangling-visuals').items).toEqual([]);
  });

  it('matches case-insensitively, like DAX', () => {
    const findings = runChecks(model({
      measures: [{ ref: 'measure:Measure[Orders On Time %]', table: 'Measure', name: 'Orders On Time %', dependsOn: { columns: [], measures: [], tables: [] }, usedByVisuals: [] }],
      visuals: [visual('orders on time %')],
      pages: [page],
    }));
    expect(find(findings, 'dangling-visuals').items).toEqual([]);
  });

  it('accepts a measure whose table was renamed', () => {
    // The reference still names the old table. The measure exists, so this is a stale
    // qualifier, not a deletion — and reporting it would bury the real ones.
    const findings = runChecks(model({
      measures: [{ ref: 'measure:New[Total]', table: 'New', name: 'Total', dependsOn: { columns: [], measures: [], tables: [] }, usedByVisuals: [] }],
      visuals: [visual('Total', 'Old')],
      pages: [page],
    }));
    expect(find(findings, 'dangling-visuals').items).toEqual([]);
  });

  it('does not fail the build on its own', () => {
    // A dead conditional format renders the default rather than erroring, so it is real
    // signal at a lower severity than DAX that cannot evaluate.
    const findings = runChecks(model({ visuals: [visual('Deleted')], pages: [page] }));
    expect(exitCodeFor(findings)).toBe(0);
    expect(exitCodeFor(findings, new Set(['dangling-visuals']))).toBe(1);
  });

  it('says so plainly when there is nothing to report', () => {
    const findings = runChecks(model());
    expect(find(findings, 'dangling-visuals')).toMatchObject({ severity: 'ok', items: [] });
  });
});

describe('unused measures', () => {
  it('does not call a measure unused when a shown measure builds on it', () => {
    // The failure this exists to prevent: a base measure that ten shown measures depend
    // on is not unused, and inviting somebody to delete it is the most damaging thing
    // this tool could get wrong.
    const findings = runChecks(model({
      measures: [
        measure('Sales', 'Base'),
        measure('Sales', 'Shown', {
          usedByVisuals: ['visual:p1/v1'],
          dependsOn: { measures: ['Sales[Base]'], columns: [], tables: [] },
        }),
      ],
    }));
    expect(find(findings, 'unused').items).toEqual([]);
  });

  it('follows a chain more than one link long', () => {
    const findings = runChecks(model({
      measures: [
        measure('Sales', 'Deep'),
        measure('Sales', 'Middle', { dependsOn: { measures: ['Sales[Deep]'], columns: [], tables: [] } }),
        measure('Sales', 'Shown', {
          usedByVisuals: ['visual:p1/v1'],
          dependsOn: { measures: ['Sales[Middle]'], columns: [], tables: [] },
        }),
      ],
    }));
    expect(find(findings, 'unused').items).toEqual([]);
  });

  it('resolves a bare dependency name', () => {
    const findings = runChecks(model({
      measures: [
        measure('Sales', 'Base'),
        measure('Sales', 'Shown', {
          usedByVisuals: ['visual:p1/v1'],
          dependsOn: { measures: ['Base'], columns: [], tables: [] },
        }),
      ],
    }));
    expect(find(findings, 'unused').items).toEqual([]);
  });

  it('still reports one that nothing reaches', () => {
    const findings = runChecks(model({ measures: [measure('Sales', 'Forgotten')] }));
    expect(find(findings, 'unused').items).toEqual(['Sales[Forgotten]']);
  });

  it('terminates on a circular dependency', () => {
    const findings = runChecks(model({
      measures: [
        measure('Sales', 'A', { dependsOn: { measures: ['Sales[B]'], columns: [], tables: [] } }),
        measure('Sales', 'B', { dependsOn: { measures: ['Sales[A]'], columns: [], tables: [] } }),
        measure('Sales', 'Shown', {
          usedByVisuals: ['visual:p1/v1'],
          dependsOn: { measures: ['Sales[A]'], columns: [], tables: [] },
        }),
      ],
    }));
    expect(find(findings, 'unused').items).toEqual([]);
  });
});

describe('coverage', () => {
  it('passes when no threshold is set', () => {
    expect(find(runChecks(model()), 'coverage').severity).toBe('ok');
  });

  it('fails below the threshold and names what is unresolved', () => {
    const findings = runChecks(
      model({ columns: [{ table: 'Sales', name: 'Amount', physicalPath: null, reason: 'dynamic query' }] }),
      { minCoverage: 0.9 },
    );
    const coverage = find(findings, 'coverage');
    expect(coverage.severity).toBe('error');
    expect(coverage.items).toEqual(['Sales[Amount] — dynamic query']);
  });

  it('says nothing rather than reporting a confident zero when coverage is unknown', () => {
    const findings = runChecks(model({ stats: {} }), { minCoverage: 0.9 });
    expect(find(findings, 'coverage').severity).toBe('ok');
  });
});

describe('dead visuals', () => {
  it('ignores a hidden visual a bookmark reveals', () => {
    const findings = runChecks(model({
      visuals: [{ id: 'v1', page: 'p1', title: 'Info', isHidden: true, neverShown: false, revealedBy: ['Show info'] }],
      pages: [{ id: 'p1', name: 'Overview' }],
    }));
    expect(find(findings, 'dead-visuals').items).toEqual([]);
  });

  it('reports one no bookmark reveals, with the page name a reader recognises', () => {
    const findings = runChecks(model({
      visuals: [{ id: 'v1', page: 'p1', title: 'Old page', isHidden: true, neverShown: true, revealedBy: [] }],
      pages: [{ id: 'p1', name: 'Unit Comparison' }],
    }));
    expect(find(findings, 'dead-visuals').items).toEqual(['Old page on page Unit Comparison']);
  });
});

describe('exitCodeFor', () => {
  const broken = runChecks(model({
    measures: [measure('Sales', 'X', { dependsOn: { measures: [], columns: ['Sales[Nope]'], tables: [] } })],
  }));
  const unusedOnly = runChecks(model({ measures: [measure('Sales', 'Forgotten')] }));

  it('fails on a broken reference by default', () => {
    expect(exitCodeFor(broken, DEFAULT_FAIL_ON)).toBe(1);
  });

  it('does not fail on judgement calls by default', () => {
    // A gate that fails on "you have an unused measure" gets switched off within a week,
    // and a switched-off gate catches nothing at all.
    expect(exitCodeFor(unusedOnly, DEFAULT_FAIL_ON)).toBe(0);
  });

  it('fails on them when asked', () => {
    expect(exitCodeFor(unusedOnly, new Set(['unused']))).toBe(1);
  });
});
