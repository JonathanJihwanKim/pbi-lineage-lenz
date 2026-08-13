/**
 * `docs` — documentation for a repository.
 *
 * Markdown by default, because the point is a file committed next to the PBIP: a pull
 * request then shows what changed about the model in prose, and somebody browsing GitHub
 * can read it without Power BI. JSON is the same model the viewer renders, for anyone
 * building their own thing on top. HTML is the handoff file, which is what `docs --format
 * html` should honestly produce rather than a second, worse renderer.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve, basename } from 'path';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import { toMarkdown, toJson } from '@pbi-lineage-lenz/export';
import { buildHandoff } from '@pbi-lineage-lenz/handoff';
import { loadProject } from '../readProject.js';
import { out, heading, rows, ok, warn, style, bytesToMb } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz docs')} <path> [options]

  Generate documentation from a PBIP project.

  ${style.dim('-f, --format <fmt>')}   md (default) | json | html
  ${style.dim('-o, --out <file>')}     Output path; omit to print markdown or JSON to stdout
  ${style.dim('    --quiet')}          Print only the output path
`;

const EXTENSION = { md: 'md', json: 'json', html: 'html' };

export async function docsCommand({ positionals, options }) {
  const path = positionals[0] ?? '.';
  const format = (options.format ?? 'md').toLowerCase();

  if (!EXTENSION[format]) {
    throw new Error(`Unknown format "${format}". Use md, json, or html.`);
  }

  const { partition, note } = loadProject(path);
  const analysis = analyzeFromFiles({
    modelFiles: partition.modelFiles,
    reportFiles: partition.reportFiles ?? undefined,
  });
  const model = toViewerModel(analysis, {
    modelName: partition.modelName ?? basename(resolve(path)),
    reportName: partition.reportName,
    projectPath: resolve(path),
  });

  let content;
  let bytes;

  if (format === 'html') {
    const built = await buildHandoff(model);
    content = built.html;
    bytes = built.bytes;
  } else {
    content = format === 'json' ? `${JSON.stringify(model, null, 2)}\n` : toMarkdown(model);
    bytes = Buffer.byteLength(content, 'utf-8');
  }

  // HTML is a megabyte of inlined bundle; printing it to a terminal helps nobody.
  if (!options.out && format === 'html') {
    throw new Error('--out is required for --format html.');
  }

  if (!options.out) {
    process.stdout.write(content);
    return 0;
  }

  const target = resolve(options.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');

  if (options.quiet) {
    out(target);
    return 0;
  }

  if (note) out(warn(note), '');
  heading('Documentation written');
  rows([
    ['file', target],
    ['format', format],
    ['size', bytesToMb(bytes)],
    ['model', `${model.tables.length} tables · ${model.measures.length} measures`],
  ]);
  out('', ok('Commit this next to your PBIP so the model is readable in a pull request.'));

  return 0;
}
