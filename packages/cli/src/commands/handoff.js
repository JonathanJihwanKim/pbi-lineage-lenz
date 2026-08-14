/**
 * `handoff` — the hero feature, scriptable.
 *
 * Identical output to the web app's Export button, because both call the same template
 * with the same bundle. That equivalence is what lets a team put this in CI without
 * anyone wondering whether the file a robot produced differs from the one a developer
 * would have exported by hand.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve, basename } from 'path';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import { buildHandoff, handoffFileName } from '@pbi-lineage-lenz/handoff';
import { loadProject } from '../readProject.js';
import { out, heading, rows, ok, warn, style, bytesToMb, duration, sponsorLine } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz handoff')} <path> [options]

  Build one self-contained HTML file from a PBIP project. It opens in any browser
  with no Power BI, no project folder, and no network access.

  ${style.dim('-o, --out <file>')}   Output path (default: <model>-handoff-<date>.html)
  ${style.dim('    --quiet')}        Print only the output path
`;

export async function handoffCommand({ positionals, options }) {
  const started = Date.now();
  const path = positionals[0] ?? '.';
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

  const built = await buildHandoff(model);
  const target = resolve(options.out ?? handoffFileName(model));

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, built.html, 'utf-8');

  if (options.quiet) {
    out(target);
    return 0;
  }

  const coverage = model.stats?.confidence?.coverage;

  if (note) out(warn(note), '');
  heading('Handoff built');
  rows([
    ['file', target],
    ['size', bytesToMb(built.bytes)],
    ['model', `${model.tables.length} tables · ${model.columns.length} columns · ${model.measures.length} measures`],
    ['report', `${model.pages.length} pages · ${model.visuals.length} visuals`],
    ...(coverage == null ? [] : [['resolved', `${Math.round(coverage * 100)}% of columns traced to a physical source column`]]),
    ['took', duration(Date.now() - started)],
  ]);

  out('');
  for (const message of built.warnings) out(warn(message));
  out(ok('Send this file to anyone. It fetches nothing.'));
  sponsorLine(options);

  return 0;
}
