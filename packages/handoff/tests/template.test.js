/**
 * The isomorphic half of the handoff builder.
 *
 * These functions run in Node during a CLI build and in the browser during a web export,
 * so the tests avoid anything Node-only. The round trip matters most: a handoff file the
 * web app cannot re-open is a file whose recipient has no way to look at it in the tool
 * that made it.
 */

import { describe, it, expect } from 'vitest';
import {
  renderHandoff, extractPayload, embedJson, summarize, byteLength,
  sizeVerdict, handoffFileName, SIZE_WARN_BYTES, SIZE_FAIL_BYTES,
} from '../src/template.js';

const CLOSE_SCRIPT = `</${'script'}>`;

function fixture(overrides = {}) {
  return {
    version: 1,
    meta: { modelName: 'Sales', generatedAt: '2026-08-11T09:00:00.000Z', generator: 'PBI Lineage Lenz' },
    stats: { confidence: { coverage: 0.74 } },
    tables: [{ ref: 'table:Sales', name: 'Sales' }],
    columns: [{ ref: 'column:Sales[Amount]', name: 'Amount' }],
    measures: [],
    visuals: [],
    pages: [],
    ...overrides,
  };
}

describe('renderHandoff / extractPayload', () => {
  it('round-trips a model through a rendered document', () => {
    const model = fixture();
    const html = renderHandoff({ model, css: 'body{}', js: 'void 0;' });
    expect(extractPayload(html)).toEqual(model);
  });

  it('survives a model string that would otherwise close the script block', () => {
    // This is the escaping bug that shipped once already: written as a JS escape, the
    // replacement resolves at parse time and silently becomes a no-op. A measure named
    // with a closing script tag then truncates the payload and the file renders blank.
    const model = fixture({
      measures: [{ ref: 'measure:Sales[X]', name: `Evil ${CLOSE_SCRIPT}<!-- ${String.fromCharCode(0x2028)}`, table: 'Sales' }],
    });
    const html = renderHandoff({ model, css: '', js: '' });

    expect(html).not.toContain(`${CLOSE_SCRIPT}<!--`);
    expect(extractPayload(html).measures[0].name).toBe(model.measures[0].name);
  });

  it('escapes the model name where it lands in markup, not just in JSON', () => {
    const html = renderHandoff({
      model: fixture({ meta: { modelName: '<img src=x onerror=alert(1)>' } }),
      css: '', js: '',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('inlines the stylesheet and script rather than linking them', () => {
    const html = renderHandoff({ model: fixture(), css: '.a{color:red}', js: 'console.log(1)' });
    expect(html).toContain('.a{color:red}');
    expect(html).toContain('console.log(1)');
    // The entire promise of the artifact: it fetches nothing.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  it('rejects a file that is not a handoff', () => {
    expect(() => extractPayload('<html><body>hello</body></html>')).toThrow(/No handoff payload/);
  });

  it('rejects a payload that is not a model', () => {
    const html = '<script type="application/json" id="lenz-payload">{"nope":1}</script>';
    expect(() => extractPayload(html)).toThrow(/missing its model/);
  });

  it('rejects a payload that is not JSON', () => {
    const html = '<script type="application/json" id="lenz-payload">{oops</script>';
    expect(() => extractPayload(html)).toThrow(/not readable JSON/);
  });
});

describe('embedJson', () => {
  it('emits a six-character escape, not the character it denotes', () => {
    const escaped = embedJson({ a: '<' });
    expect(escaped).toContain(`${String.fromCharCode(92)}u003c`);
    expect(escaped).not.toContain('"<"');
    expect(JSON.parse(escaped).a).toBe('<');
  });

  it('escapes the line terminators that are legal in JSON but not in JS source', () => {
    const escaped = embedJson({ a: `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}` });
    expect(escaped).not.toContain(String.fromCharCode(0x2028));
    expect(escaped).not.toContain(String.fromCharCode(0x2029));
  });
});

describe('sizeVerdict', () => {
  it('passes a small file', () => {
    expect(sizeVerdict(1024).level).toBe('ok');
    expect(sizeVerdict(1024).message).toBeNull();
  });

  it('warns above the forwarding target', () => {
    expect(sizeVerdict(SIZE_WARN_BYTES + 1).level).toBe('warn');
  });

  it('fails above the hard limit', () => {
    expect(sizeVerdict(SIZE_FAIL_BYTES + 1).level).toBe('fail');
  });
});

describe('byteLength', () => {
  it('counts UTF-8 bytes, not code units', () => {
    // A model full of non-ASCII names is exactly where a naive .length undercounts and
    // a file sails past the size limit unnoticed.
    expect(byteLength('café')).toBe(5);
    expect(byteLength('日本語')).toBe(9);
  });
});

describe('handoffFileName', () => {
  it('names the file after the model and the day it was generated', () => {
    expect(handoffFileName(fixture())).toBe('Sales-handoff-2026-08-11.html');
  });

  it('strips characters a filesystem would reject', () => {
    const name = handoffFileName(fixture({ meta: { modelName: 'Sales/Ops: Q3 *draft*', generatedAt: '2026-08-11T00:00:00Z' } }));
    expect(name).toBe('Sales-Ops-Q3-draft-handoff-2026-08-11.html');
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('falls back to a usable name when the model has none', () => {
    expect(handoffFileName({ meta: { generatedAt: '2026-08-11T00:00:00Z' } })).toBe('model-handoff-2026-08-11.html');
  });
});

describe('summarize', () => {
  it('reports coverage when it is known', () => {
    expect(summarize(fixture())).toBe('1 tables · 1 columns · 74% of source-backed columns traced');
  });

  it('omits coverage rather than printing a confident zero', () => {
    // "0% resolved" and "not measured" mean very different things to a data engineer.
    expect(summarize(fixture({ stats: {} }))).toBe('1 tables · 1 columns');
  });
});
