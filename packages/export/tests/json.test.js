/**
 * JSON export — the contract for anyone building on top of this.
 *
 * The viewer model *is* the export, deliberately. A reduced shape that only the exporter
 * produces drifts from the one the app renders, and then the file quietly stops matching
 * what the tool shows on screen.
 */

import { describe, it, expect } from 'vitest';
import { toJson, jsonFileName } from '../src/json.js';
import { VIEWER_MODEL_VERSION } from '@pbi-lineage-lenz/viewer';

const model = {
  version: VIEWER_MODEL_VERSION,
  meta: { modelName: 'Sales Model', generatedAt: '2026-08-13T09:00:00.000Z' },
  tables: [{ name: 'Sales' }],
  columns: [{ table: 'Sales', name: 'Amount', confidence: 'exact' }],
};

describe('toJson', () => {
  it('round-trips the model unchanged', () => {
    expect(JSON.parse(toJson(model))).toEqual(model);
  });

  it('carries a version so a consumer can tell when the shape moves', () => {
    expect(JSON.parse(toJson({ tables: [] })).version).toBe(VIEWER_MODEL_VERSION);
  });

  it('ends with a newline, so the file is well formed in a diff', () => {
    expect(toJson(model).endsWith('\n')).toBe(true);
  });

  it('indents by default and can be told not to', () => {
    expect(toJson(model)).toContain('\n  "meta"');
    expect(toJson(model, { pretty: false })).not.toContain('\n  ');
  });

  it('does not let a Map disappear into an empty object', () => {
    // Nothing in the viewer model uses one today, but a field added later would serialise
    // to `{}` and vanish without an error — a consumer would find nothing where the data
    // used to be. Cheap to convert, and it removes a way for this file to lie.
    const parsed = JSON.parse(toJson({ lookup: new Map([['a', 1]]), tags: new Set(['x']) }));
    expect(parsed.lookup).toEqual({ a: 1 });
    expect(parsed.tags).toEqual(['x']);
  });
});

describe('jsonFileName', () => {
  it('names the file after the model and the day it was generated', () => {
    expect(jsonFileName(model)).toBe('Sales-Model-model-2026-08-13.json');
  });

  it('strips characters a file system would refuse', () => {
    expect(jsonFileName({ meta: { modelName: 'A/B: C*', generatedAt: '2026-01-02T00:00:00Z' } }))
      .toBe('A-B-C--model-2026-01-02.json');
  });

  it('falls back rather than producing a nameless file', () => {
    expect(jsonFileName({})).toMatch(/^model-model-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
