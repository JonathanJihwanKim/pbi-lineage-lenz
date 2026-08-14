/**
 * Handoff file contract.
 *
 * The product promise is that this file opens in any browser, anywhere, with no Power BI
 * and no network. Each assertion here is one clause of that promise; if one breaks, the
 * file still opens on the machine that produced it and fails silently on the recipient's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import { buildHandoff, SIZE_WARN_BYTES } from '../src/build.js';

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

let html;
let bytes;
let model;

beforeAll(async () => {
  const root = join(__dirname, '../../../samples/sample-pbip');
  const analysis = analyzeFromFiles({
    modelFiles: readAll(join(root, 'Sample.SemanticModel/definition')),
    reportFiles: readAll(join(root, 'Sample.Report/definition')),
  });
  model = toViewerModel(analysis, { modelName: 'Sample' });
  ({ html, bytes } = await buildHandoff(model));
}, 60_000);

describe('self-containment', () => {
  it('references no external scripts or stylesheets', () => {
    expect(html).not.toMatch(/<script[^>]+\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]+\shref=/i);
  });

  it('loads no remote fonts or images', () => {
    // Match the at-rule itself, not the word — the stylesheet's own comment explains
    // why there is no @font-face, and that prose is not a network request.
    expect(html).not.toMatch(/@font-face\s*\{/i);
    expect(html).not.toMatch(/<img[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it('contains no fetch, XHR, or WebSocket call', () => {
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest/);
    expect(html).not.toMatch(/new WebSocket/);
  });

  it('has no http(s) URL other than the credit link', () => {
    const urls = (html.match(/https?:\/\/[^"'\s)]+/g) || [])
      .filter((u) => !u.includes('github.com/JonathanJihwanKim') && !u.includes('www.w3.org'));
    expect(urls).toEqual([]);
  });
});

describe('payload', () => {
  it('embeds the model as parseable JSON', () => {
    const match = /<script type="application\/json" id="lenz-payload">([\s\S]*?)<\/script>/.exec(html);
    expect(match).toBeTruthy();
    const parsed = JSON.parse(match[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
    expect(parsed.columns.length).toBe(model.columns.length);
    expect(parsed.measures.length).toBe(model.measures.length);
  });

  it('escapes angle brackets so no payload string can close the script block', () => {
    const payload = /<script type="application\/json" id="lenz-payload">([\s\S]*?)<\/script>/.exec(html)[1];
    expect(payload).not.toContain('<');
    expect(payload).not.toContain('>');
  });

  it('survives a payload containing a script-closing tag', async () => {
    const hostile = structuredClone(model);
    hostile.meta.modelName = '</script><script>alert(1)</script>';
    const built = await buildHandoff(hostile);
    const payload = /<script type="application\/json" id="lenz-payload">([\s\S]*?)<\/script>/.exec(built.html)[1];
    expect(payload).not.toContain('</script');
    expect(JSON.parse(payload.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')).meta.modelName)
      .toBe('</script><script>alert(1)</script>');
  });

  it('escapes the model name where it appears in the document title', async () => {
    const hostile = structuredClone(model);
    hostile.meta.modelName = '"><script>alert(1)</script>';
    const built = await buildHandoff(hostile);
    expect(built.html).not.toMatch(/<title>[^<]*<script>/);
  });
});

describe('size budget', () => {
  it('stays well under the forwarding target for the sample model', () => {
    expect(bytes).toBeLessThan(SIZE_WARN_BYTES);
  });

  it('reports its own size', () => {
    expect(bytes).toBe(Buffer.byteLength(html, 'utf-8'));
  });
});

describe('document', () => {
  it('is a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('names the model in the title', () => {
    expect(html).toMatch(/<title>Sample — PBI Lineage Lenz<\/title>/);
  });

  it('explains itself when scripting is off', () => {
    expect(html).toMatch(/<noscript>/);
  });

  it('carries the credit link that travels with a forwarded file', () => {
    expect(html).toContain('Made with');
    expect(html).toContain('pbi-lineage-lenz');
  });

  it('does not force a theme on the reader', () => {
    // The script picks the reader's system theme; a hardcoded attribute would override it.
    expect(html).not.toMatch(/<html[^>]+data-theme=/);
  });
});
