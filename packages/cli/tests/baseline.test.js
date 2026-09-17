/**
 * Baselines. The two ways one goes wrong are both silent: suppressing a finding it should
 * not, and going on suppressing one that has been fixed and might come back.
 */

import { describe, it, expect } from 'vitest';
import { baselineFor, applyBaseline, prune } from '../src/baseline.js';
import { runChecks, exitCodeFor, DEFAULT_FAIL_ON } from '../src/checks.js';

function measure(table, name, extra = {}) {
  return {
    ref: `measure:${table}[${name}]`, table, name, usedByVisuals: [],
    dependsOn: { measures: [], columns: [], tables: [] }, ...extra,
  };
}

function model(measures, overrides = {}) {
  return {
    meta: { modelName: 'Test' },
    stats: { confidence: { coverage: 1 } },
    tables: [{ ref: 'table:Sales', name: 'Sales' }],
    columns: [{ ref: 'column:Sales[Amount]', table: 'Sales', name: 'Amount', physicalPath: 'db.f.amt' }],
    measures,
    visuals: [],
    pages: [],
    ...overrides,
  };
}

const broken = (name, column) => measure('Sales', name, {
  dependsOn: { measures: [], columns: [`Sales[${column}]`], tables: [] },
});

describe('baselines', () => {
  const before = model([broken('A', 'Gone'), broken('B', 'AlsoGone')]);

  it('records every finding by key, sorted and without a timestamp', () => {
    const first = baselineFor(runChecks(before), 'test');
    const second = baselineFor(runChecks(before), 'test');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.findings.broken).toEqual([
      'broken|measure:Sales[A]|column:Sales[Gone]',
      'broken|measure:Sales[B]|column:Sales[AlsoGone]',
    ]);
    // A threshold is not a list of defects.
    expect(first.findings.coverage).toBeUndefined();
  });

  it('passes on known findings and says how many it suppressed', () => {
    const baseline = baselineFor(runChecks(before), 'test');
    const applied = applyBaseline(runChecks(before), baseline);
    // Two broken references, and the same two measures are also unused.
    expect(applied.suppressed).toBe(4);
    expect(applied.fresh).toBe(0);
    expect(applied.stale).toEqual([]);
    expect(exitCodeFor(applied.findings, DEFAULT_FAIL_ON)).toBe(0);
    expect(applied.findings.find((f) => f.rule === 'broken').suppressed).toBe(2);
  });

  it('fails on a new finding only', () => {
    const baseline = baselineFor(runChecks(before), 'test');
    const after = model([broken('A', 'Gone'), broken('B', 'AlsoGone'), broken('C', 'New')]);
    const applied = applyBaseline(runChecks(after), baseline);
    // C is both a new broken reference and a new unused measure.
    expect(applied.fresh).toBe(2);
    expect(applied.findings.find((f) => f.rule === 'broken').items)
      .toEqual(['Sales[C] reads Sales[New], which does not exist']);
    expect(exitCodeFor(applied.findings, DEFAULT_FAIL_ON)).toBe(1);
  });

  it('reports a fixed finding as stale, and prune removes it without adding anything', () => {
    const baseline = baselineFor(runChecks(before), 'test');
    const fixed = model([broken('A', 'Gone'), measure('Sales', 'B')]);
    const applied = applyBaseline(runChecks(fixed), baseline);
    expect(applied.stale).toEqual([{ rule: 'broken', key: 'broken|measure:Sales[B]|column:Sales[AlsoGone]' }]);

    const pruned = prune(baseline, applied.stale);
    expect(pruned.findings.broken).toEqual(['broken|measure:Sales[A]|column:Sales[Gone]']);
  });

  it('matches a moved visual as the same finding', () => {
    const visual = (x) => ({
      ref: 'visual:p1/v1', key: 'Report/p1/v1', id: 'v1', page: 'p1', type: 'card', title: 'KPI',
      neverShown: true, position: { x, y: 0, width: 10, height: 10 }, fields: [],
    });
    const at = (x) => model([], { visuals: [visual(x)], pages: [{ id: 'p1', name: 'Overview' }] });
    const baseline = baselineFor(runChecks(at(0)), 'test');
    expect(applyBaseline(runChecks(at(500)), baseline)).toMatchObject({ fresh: 0, suppressed: 1, stale: [] });
  });
});
