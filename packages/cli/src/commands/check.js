/**
 * `check` — the CI gate.
 *
 * Exits 1 on a broken reference and prints what broke. Everything else is reported and
 * does not fail unless asked for with `--fail-on`, because a gate that fails on judgement
 * calls gets switched off, and a switched-off gate catches nothing.
 */

import { basename, resolve } from 'path';
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import { loadProject } from '../readProject.js';
import { runChecks, exitCodeFor, DEFAULT_FAIL_ON, RULES } from '../checks.js';
import { parsePercent, parseList } from '../args.js';
import { out, heading, ok, warn, fail, style } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz check')} <path> [options]

  Verify a model and exit 1 when something is broken. Built for CI.

  ${style.dim('--fail-on <list>')}       Comma-separated: ${RULES.join(', ')} (default: broken)
  ${style.dim('--min-coverage <pct>')}   Require this % of columns resolved to a physical source.
                         Setting it makes coverage fail the build.
  ${style.dim('--json')}                 Machine-readable findings
  ${style.dim('-q, --quiet')}            Only print problems
`;

const MAX_LISTED = 12;

export function checkCommand({ positionals, options }) {
  const path = positionals[0] ?? '.';
  const { partition, note } = loadProject(path);

  const analysis = analyzeFromFiles({
    modelFiles: partition.modelFiles,
    reportFiles: partition.reportFiles ?? undefined,
  });
  const model = toViewerModel(analysis, {
    modelName: partition.modelName ?? basename(resolve(path)),
    reportName: partition.reportName,
  });

  const minCoverage = parsePercent(options['min-coverage']);
  if (options['min-coverage'] !== undefined && minCoverage === null) {
    throw new Error(`--min-coverage must be a percentage, got "${options['min-coverage']}"`);
  }

  const requested = parseList(options['fail-on']);
  const unknown = [...requested].filter((rule) => !RULES.includes(rule));
  if (unknown.length > 0) {
    throw new Error(`Unknown --fail-on rule${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Known rules: ${RULES.join(', ')}`);
  }

  const failOn = new Set(requested.size > 0 ? requested : DEFAULT_FAIL_ON);

  // Naming a threshold is asking for it to be enforced. Without this the flag computes a
  // finding, prints it, and exits 0 — a gate that looks configured and passes everything,
  // which is the most expensive kind of nothing.
  if (minCoverage != null) failOn.add('coverage');
  const findings = runChecks(model, { minCoverage });
  const code = exitCodeFor(findings, failOn);

  if (options.json) {
    out(JSON.stringify({
      model: model.meta.modelName,
      failOn: [...failOn],
      exitCode: code,
      findings,
    }, null, 2));
    return code;
  }

  if (!options.quiet) {
    if (note) out(warn(note), '');
    heading(`${model.meta.modelName ?? path} — ${model.tables.length} tables · ${model.measures.length} measures · ${model.visuals.length} visuals`);
    out('');
  }

  for (const finding of findings) {
    const fails = finding.items.length > 0 && failOn.has(finding.rule);
    if (finding.items.length === 0) {
      if (!options.quiet) out(ok(finding.summary));
      continue;
    }

    out(fails ? fail(finding.summary) : warn(finding.summary));
    for (const item of finding.items.slice(0, MAX_LISTED)) out(`    ${style.dim(item)}`);
    if (finding.items.length > MAX_LISTED) {
      out(`    ${style.dim(`… and ${finding.items.length - MAX_LISTED} more`)}`);
    }
  }

  if (code !== 0) {
    out('', fail('Check failed.'));
  } else if (!options.quiet) {
    out('', ok('Check passed.'));
  }

  return code;
}
