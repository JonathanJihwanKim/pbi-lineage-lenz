import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import {
  toViewerModel,
  buildIndex,
  traceMeasure,
  parseRef,
  refs,
  VIEWER_MODEL_VERSION,
} from '../src/viewerModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
let index;

beforeAll(() => {
  const root = join(__dirname, '../../../samples/sample-pbip');
  const analysis = analyzeFromFiles({
    modelFiles: readAll(join(root, 'definition')),
    reportFiles: readAll(join(root, 'report/definition')),
  });
  model = toViewerModel(analysis, { modelName: 'Sample' });
  index = buildIndex(model);
});

describe('toViewerModel', () => {
  it('produces a payload that survives JSON round-tripping', () => {
    // The handoff file is nothing but this payload embedded in a page, so anything
    // that does not survive JSON is a silently empty section in a shipped artifact.
    const json = JSON.stringify(model);
    expect(JSON.parse(json)).toEqual(model);
  });

  it('contains no Maps or Sets anywhere in the tree', () => {
    const walk = (value, path = '$') => {
      if (value instanceof Map || value instanceof Set) {
        throw new Error(`non-serializable collection at ${path}`);
      }
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    expect(() => walk(model)).not.toThrow();
  });

  it('stamps a version so old handoff files stay readable', () => {
    expect(model.version).toBe(VIEWER_MODEL_VERSION);
  });

  it('flattens every collection the sample defines', () => {
    expect(model.tables.length).toBeGreaterThan(0);
    expect(model.columns.length).toBeGreaterThan(0);
    expect(model.measures.length).toBeGreaterThan(0);
    expect(model.visuals.length).toBeGreaterThan(0);
    expect(model.relationships.length).toBeGreaterThan(0);
  });

  it('carries the dual name on resolved columns', () => {
    const amount = model.columns.find((c) => c.ref === 'column:Sales[Amount]');
    expect(amount.physicalPath).toBe('mydb.dbo.fact_sales.sale_amount');
    expect(amount.confidence).toBe('exact');
  });

  it('carries a confidence and reason on every column', () => {
    for (const column of model.columns) {
      expect(column.confidence).toBeTruthy();
      expect(column.reason).toBeTruthy();
    }
  });

  it('records the M step pipeline for a sourced table', () => {
    const sales = model.tables.find((t) => t.name === 'Sales');
    expect(sales.steps.map((s) => s.kind)).toEqual(['Source', 'Navigation', 'Rename']);
  });

  it('links measures to the visuals that consume them', () => {
    const totalSales = model.measures.find((m) => m.name === 'Total Sales');
    expect(totalSales.usedByVisuals.length).toBeGreaterThan(0);
    expect(totalSales.usedByVisuals[0]).toMatch(/^visual:/);
  });

  it('leaves usedByVisuals empty for an unused measure', () => {
    const unused = model.measures.find((m) => m.name === 'Unused Metric');
    expect(unused.usedByVisuals).toEqual([]);
  });

  it('preserves the field parameter badge', () => {
    const fieldParam = model.measures.find((m) => m.badge === 'FP');
    expect(fieldParam).toBeDefined();
    expect(fieldParam.enrichmentType).toBe('field_parameter');
  });
});

describe('refs and parseRef', () => {
  it('round-trips a column ref', () => {
    const ref = refs.column('Sales', 'Net Amount');
    expect(parseRef(ref)).toEqual({ kind: 'column', table: 'Sales', name: 'Net Amount' });
  });

  it('round-trips a measure ref containing brackets in the name', () => {
    const ref = refs.measure('Sales', 'Total [USD]');
    expect(parseRef(ref)).toEqual({ kind: 'measure', table: 'Sales', name: 'Total [USD]' });
  });

  it('round-trips a visual ref', () => {
    expect(parseRef(refs.visual('page1', 'visual2'))).toEqual({
      kind: 'visual', page: 'page1', name: 'visual2',
    });
  });

  it('returns null for a non-ref', () => {
    expect(parseRef('not-a-ref')).toBeNull();
    expect(parseRef('')).toBeNull();
  });

  it('survives a deep link for a measure whose name contains a percent sign', () => {
    // `%` is common in Power BI measure names — 28 of 274 in one real model. It is also
    // the URI escape character, so `encodeURI` leaves it bare and the resulting link is
    // malformed. `decodeURI` then throws, and the throw took the whole routing path down.
    const ref = refs.measure('Measure', 'Orders On Time %');

    expect(() => decodeURI(`#/${encodeURI(ref)}`)).not.toThrow();
    expect(decodeURIComponent(encodeURIComponent(ref))).toBe(ref);
    expect(parseRef(decodeURIComponent(encodeURIComponent(ref)))).toEqual({
      kind: 'measure', table: 'Measure', name: 'Orders On Time %',
    });
  });

  it('every ref in a real model round-trips through a URL fragment', () => {
    for (const item of [...model.measures, ...model.columns, ...model.visuals]) {
      expect(decodeURIComponent(encodeURIComponent(item.ref))).toBe(item.ref);
    }
  });
});

describe('visual payload', () => {
  it('carries a role for every visual, and never drops one', () => {
    // The property the page lens depends on: role labels, it never filters.
    expect(model.visuals.every((v) => v.role)).toBe(true);
  });

  it('separates displaying a measure from plotting it', () => {
    for (const visual of model.visuals) {
      expect(visual.boundFields).toBeLessThanOrEqual(visual.fields.length);
    }
  });

  it('carries visibility state so hidden never has to mean dead', () => {
    for (const visual of model.visuals) {
      expect(Array.isArray(visual.revealedBy)).toBe(true);
      if (visual.neverShown) expect(visual.isHidden).toBe(true);
      if (visual.revealedBy.length > 0) expect(visual.neverShown).toBe(false);
    }
  });
});

describe('buildIndex', () => {
  it('indexes every object by ref', () => {
    expect(index.byRef.get('measure:Sales[Total Sales]')?.name).toBe('Total Sales');
    expect(index.byRef.get('table:Sales')?.name).toBe('Sales');
  });

  it('indexes columns by physical path so a data engineer can search their own names', () => {
    const hits = index.byPhysicalPath.get('mydb.dbo.fact_sales.sale_amount');
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe('column:Sales[Amount]');
  });

  it('groups columns and measures by table', () => {
    expect(index.columnsByTable.get('Sales').length).toBe(5);
    expect(index.measuresByTable.get('Sales').length).toBe(5);
  });
});

describe('traceMeasure', () => {
  it('follows a measure-to-measure chain', () => {
    const { chain } = traceMeasure('measure:Sales[YoY Growth]', model, index);
    expect(chain.map((c) => c.name)).toContain('Total Sales');
    expect(chain[0].name).toBe('YoY Growth');
  });

  it('reaches the physical column behind the chain', () => {
    const { columns } = traceMeasure('measure:Sales[YoY Growth]', model, index);
    expect(columns.map((c) => c.physicalPath)).toContain('mydb.dbo.fact_sales.sale_amount');
  });

  it('surfaces unresolved columns instead of dropping them', () => {
    // A silently missing column reads as "nothing upstream", which is the opposite
    // of the truth. Unknowns have to stay visible.
    const { unresolved } = traceMeasure('measure:Sales[YoY Growth]', model, index);
    expect(unresolved.map((c) => c.ref)).toContain('column:DateTable[Date]');
  });

  it('terminates on a circular measure reference', () => {
    const circular = {
      measures: [
        { ref: 'measure:T[A]', table: 'T', name: 'A', dependsOn: { measures: ['T[B]'], columns: [], tables: [] }, usedByVisuals: [] },
        { ref: 'measure:T[B]', table: 'T', name: 'B', dependsOn: { measures: ['T[A]'], columns: [], tables: [] }, usedByVisuals: [] },
      ],
      columns: [], tables: [], visuals: [], pages: [], sources: [],
    };
    const circularIndex = buildIndex(circular);
    const { chain } = traceMeasure('measure:T[A]', circular, circularIndex);
    expect(chain.map((c) => c.name).sort()).toEqual(['A', 'B']);
  });

  it('returns an empty chain for an unknown ref', () => {
    expect(traceMeasure('measure:Nope[Nope]', model, index).chain).toEqual([]);
  });
});
