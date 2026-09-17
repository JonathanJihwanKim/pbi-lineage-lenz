/**
 * `docs` — documentation for a repository.
 *
 * Markdown by default, because the point is a file committed next to the PBIP: a pull
 * request then shows what changed about the model in prose, and somebody browsing GitHub
 * can read it without Power BI. JSON is the same model the viewer renders, for anyone
 * building their own thing on top. HTML is the handoff file, which is what `docs --format
 * html` should honestly produce rather than a second, worse renderer. CSV and NDJSON are
 * the flat export: one row per binding, for joining lineage to a catalog.
 */

import { writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'fs';
import { dirname, resolve, join } from 'path';
import {
  toMarkdown, toJson, toBindingRows, csvHeader, csvLine, ndjsonLine,
  toEstateMarkdown, toEstateJson, estateDocPath, attachPageMaps,
} from '@pbi-lineage-lenz/export';
import { buildHandoff } from '@pbi-lineage-lenz/handoff';
import { loadModels } from '../analyzeProject.js';
import { out, heading, rows, ok, warn, style, bytesToMb, sponsorLine } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz docs')} <path> [options]

  Generate documentation from a PBIP project, or from every report in a workspace.

  ${style.dim('-f, --format <fmt>')}   md (default) | json | html | csv | ndjson
  ${style.dim('-o, --out <path>')}     Output file; omit to print to stdout (not html).
                         With --all and md, a folder: index.md plus one file per report.
  ${style.dim('    --all')}            Every report in the folder, each against the model it names
  ${style.dim('    --page-maps')}      A small SVG map of each visual's page, visual highlighted
                         (json, csv, ndjson, md)
  ${style.dim('    --quiet')}          Print only the output path
`;

const FORMATS = new Set(['md', 'json', 'html', 'csv', 'ndjson']);

/** Formats written row by row: one row per binding, and a workspace can be tens of MB. */
const FLAT = new Set(['csv', 'ndjson']);

export async function docsCommand({ positionals, options }) {
  const path = positionals[0] ?? '.';
  const format = (options.format ?? 'md').toLowerCase();

  if (!FORMATS.has(format)) {
    throw new Error(`Unknown format "${format}". Use md, json, html, csv, or ndjson.`);
  }
  if (options.all && format === 'html') {
    throw new Error('--format html builds one handoff file per report. Use md, json, csv, or ndjson with --all.');
  }
  if (options.all && format === 'md' && !options.out) {
    throw new Error('--all with markdown writes a folder of files. Say where with --out <folder>.');
  }
  // HTML is a megabyte of inlined bundle; printing it to a terminal helps nobody.
  if (!options.out && format === 'html') {
    throw new Error('--out is required for --format html.');
  }

  const { models, note, manifest } = loadModels(path, { all: options.all });
  const pageMaps = !!options['page-maps'];
  if (pageMaps) for (const model of models) attachPageMaps(model);

  if (FLAT.has(format)) {
    const pageMap = pageMaps ? (visual) => visual.pageMap ?? null : null;
    const { bytes, rows: count, target } = writeFlat(models, format, options.out, { pageMap });
    return summary(options, note, target, [
      ['format', format],
      ['rows', String(count)],
      ['size', bytesToMb(bytes)],
    ], 'One row per field a visual reaches, per physical column behind it. See docs/output-contract.md.');
  }

  if (options.all && format === 'md') {
    const folder = resolve(options.out);
    let bytes = 0;
    const write = (relative, content) => {
      const target = join(folder, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
      bytes += Buffer.byteLength(content, 'utf-8');
    };
    write('index.md', toEstateMarkdown(models, manifest));
    for (const model of models) write(estateDocPath(model), toMarkdown(model, { pageMaps }));

    return summary(options, note, folder, [
      ['format', 'md'],
      ['files', String(models.length + 1)],
      ['size', bytesToMb(bytes)],
    ], 'Commit this folder next to the workspace so every report is readable in a pull request.');
  }

  const model = models[0];
  let content;
  let bytes;

  if (format === 'html') {
    const built = await buildHandoff(model);
    content = built.html;
    bytes = built.bytes;
  } else {
    content = format === 'json'
      ? (options.all ? toEstateJson(models, manifest) : toJson(model))
      : toMarkdown(model, { pageMaps });
    bytes = Buffer.byteLength(content, 'utf-8');
  }

  if (!options.out) {
    process.stdout.write(content);
    return 0;
  }

  const target = resolve(options.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');

  return summary(options, note, target, [
    ['format', format],
    ['size', bytesToMb(bytes)],
    options.all
      ? ['reports', String(models.length)]
      : ['model', `${model.tables.length} tables · ${model.measures.length} measures`],
  ], 'Commit this next to your PBIP so the model is readable in a pull request.');
}

function summary(options, note, target, pairs, closing) {
  if (!options.out) return 0;
  if (options.quiet) {
    out(target);
    return 0;
  }
  if (note) out(warn(note), '');
  heading('Documentation written');
  rows([['path', target], ...pairs]);
  out('', ok(closing));
  sponsorLine(options);
  return 0;
}

/**
 * Write the flat export for one or more reports, a row at a time.
 *
 * Never builds the file as one string: across a workspace the export runs to tens of
 * megabytes, and the rows are generated lazily for exactly this reason.
 *
 * @param {Array<object>} models - Viewer models, one per report.
 * @param {'csv'|'ndjson'} format
 * @param {string} [outPath] - Omit to write to stdout.
 * @param {object} [options] - Passed to toBindingRows().
 * @returns {{bytes: number, rows: number, target: string|null}}
 */
export function writeFlat(models, format, outPath, options = {}) {
  const line = format === 'csv' ? csvLine : ndjsonLine;
  let target = null;
  let fd = null;
  if (outPath) {
    target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    fd = openSync(target, 'w');
  }

  // Buffered in modest chunks: one write per row is slow, one write per file is the thing
  // this function exists to avoid.
  let buffer = '';
  let bytes = 0;
  let count = 0;
  const flush = () => {
    if (!buffer) return;
    bytes += Buffer.byteLength(buffer, 'utf-8');
    if (fd !== null) writeSync(fd, buffer, null, 'utf-8');
    else process.stdout.write(buffer);
    buffer = '';
  };

  try {
    if (format === 'csv') buffer += csvHeader();
    for (const model of models) {
      for (const values of toBindingRows(model, options)) {
        buffer += line(values);
        count++;
        if (buffer.length > 1 << 20) flush();
      }
    }
    flush();
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { bytes, rows: count, target };
}
