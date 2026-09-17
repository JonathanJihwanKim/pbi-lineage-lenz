/**
 * `check` — the CI gate.
 *
 * Exits 1 on a broken reference and prints what broke. Everything else is reported and
 * does not fail unless asked for with `--fail-on`, because a gate that fails on judgement
 * calls gets switched off, and a switched-off gate catches nothing.
 *
 * A baseline handles the other way a gate gets switched off: failing on day one, over
 * debt that predates it. See baseline.js.
 */

import { loadModels } from '../analyzeProject.js';
import { runChecks, runEstateChecks, exitCodeFor, DEFAULT_FAIL_ON, RULES } from '../checks.js';
import { baselineFor, writeBaseline, readBaseline, applyBaseline, prune } from '../baseline.js';
import { parsePercent, parseList } from '../args.js';
import { version } from '../version.js';
import { out, heading, ok, warn, fail, style } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz check')} <path> [options]

  Verify a model and exit 1 when something is broken. Built for CI.

  ${style.dim('--fail-on <list>')}         Comma-separated: ${RULES.join(', ')}
                           (default: ${[...DEFAULT_FAIL_ON].join(', ')})
  ${style.dim('--min-coverage <pct>')}     Require this % of columns resolved to a physical source.
                           Setting it makes coverage fail the build.
  ${style.dim('--all')}                    Every report in the folder, and every model they read
  ${style.dim('--write-baseline <file>')}  Record every current finding as known debt, then exit 0
  ${style.dim('--baseline <file>')}        Fail only on findings not in the file. A recorded finding
                           that has been fixed fails too, until removed from the file.
  ${style.dim('--update-baseline')}        With --baseline: remove fixed findings from the file
  ${style.dim('--json')}                   Machine-readable findings
  ${style.dim('-q, --quiet')}              Only print problems
`;

const MAX_LISTED = 12;

export function checkCommand({ positionals, options }) {
  const path = positionals[0] ?? '.';

  const minCoverage = parsePercent(options['min-coverage']);
  if (options['min-coverage'] !== undefined && minCoverage === null) {
    throw new Error(`--min-coverage must be a percentage, got "${options['min-coverage']}"`);
  }

  const requested = parseList(options['fail-on']);
  const unknown = [...requested].filter((rule) => !RULES.includes(rule));
  if (unknown.length > 0) {
    throw new Error(`Unknown --fail-on rule${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Known rules: ${RULES.join(', ')}`);
  }
  if (options['update-baseline'] && !options.baseline) {
    throw new Error('--update-baseline needs --baseline <file>: the file to update.');
  }
  if (options['write-baseline'] && options.baseline) {
    throw new Error('Use --write-baseline to create a baseline, or --baseline to check against one — not both.');
  }

  const { models, note } = loadModels(path, { all: options.all });
  const model = models[0];

  const failOn = new Set(requested.size > 0 ? requested : DEFAULT_FAIL_ON);

  // Naming a threshold is asking for it to be enforced. Without this the flag computes a
  // finding, prints it, and exits 0 — a gate that looks configured and passes everything,
  // which is the most expensive kind of nothing.
  if (minCoverage != null) failOn.add('coverage');
  let findings = options.all
    ? runEstateChecks(models, { minCoverage })
    : runChecks(model, { minCoverage });

  const label = options.all ? `${models.length} report${models.length === 1 ? '' : 's'} in ${path}` : (model.meta.modelName ?? path);

  // ── Writing a baseline: record everything, fail nothing ──
  if (options['write-baseline']) {
    const document = baselineFor(findings, `pbi-lineage-lenz ${version()}`);
    const target = writeBaseline(options['write-baseline'], document);
    const recorded = Object.values(document.findings).reduce((n, keys) => n + keys.length, 0);
    if (options.json) {
      out(JSON.stringify({ model: label, baseline: { file: target, recorded }, exitCode: 0 }, null, 2));
      return 0;
    }
    if (!options.quiet && note) out(warn(note), '');
    out(ok(`Baseline written: ${recorded} finding${recorded === 1 ? '' : 's'} recorded in ${target}`));
    if (!options.quiet) out(style.dim('  Commit it, then run check with --baseline so only new findings fail.'));
    return 0;
  }

  // ── Checking against a baseline ──
  let baseline = null;
  if (options.baseline) {
    const document = readBaseline(options.baseline);
    const applied = applyBaseline(findings, document);
    findings = applied.findings;
    baseline = { file: options.baseline, suppressed: applied.suppressed, new: applied.fresh, stale: applied.stale };

    if (options['update-baseline'] && applied.stale.length > 0) {
      writeBaseline(options.baseline, prune(document, applied.stale));
      baseline.removed = applied.stale.length;
      baseline.stale = [];
    }
  }

  // A fixed finding still in the baseline fails the gates it belongs to, so the file cannot
  // quietly go on suppressing something that might come back.
  const staleFailing = (baseline?.stale || []).filter((entry) => failOn.has(entry.rule));
  let code = exitCodeFor(findings, failOn);
  if (staleFailing.length > 0) code = 1;

  if (options.json) {
    out(JSON.stringify({
      model: label,
      failOn: [...failOn],
      exitCode: code,
      baseline: baseline ?? undefined,
      findings,
    }, null, 2));
    return code;
  }

  if (!options.quiet) {
    if (note) out(warn(note), '');
    heading(options.all
      ? label
      : `${model.meta.modelName ?? path} — ${model.tables.length} tables · ${model.measures.length} measures · ${model.visuals.length} visuals`);
    out('');
  }

  for (const finding of findings) {
    const fails = finding.items.length > 0 && failOn.has(finding.rule);
    const known = finding.suppressed ? style.dim(` (${finding.suppressed} known, in baseline)`) : '';
    if (finding.items.length === 0) {
      if (!options.quiet) out(ok(`${finding.summary}${known}`));
      continue;
    }

    out((fails ? fail : warn)(`${finding.summary}${known}`));
    for (const item of finding.items.slice(0, MAX_LISTED)) out(`    ${style.dim(item)}`);
    if (finding.items.length > MAX_LISTED) {
      out(`    ${style.dim(`… and ${finding.items.length - MAX_LISTED} more`)}`);
    }
  }

  if (baseline) {
    // Shown even under --quiet: debt that is never counted becomes debt nobody remembers.
    out('', `${style.dim('baseline')}  ${baseline.suppressed} known issue${baseline.suppressed === 1 ? '' : 's'} suppressed by ${baseline.file}`);
    if (baseline.removed) out(ok(`Removed ${baseline.removed} fixed finding${baseline.removed === 1 ? '' : 's'} from ${baseline.file}.`));
    if (baseline.stale.length > 0) {
      const say = staleFailing.length > 0 ? fail : warn;
      out(say(`${baseline.stale.length} finding${baseline.stale.length === 1 ? ' is' : 's are'} in the baseline but fixed. `
        + 'Run with --update-baseline to remove them.'));
      for (const entry of baseline.stale.slice(0, MAX_LISTED)) out(`    ${style.dim(`${entry.rule}: ${entry.key}`)}`);
      if (baseline.stale.length > MAX_LISTED) out(`    ${style.dim(`… and ${baseline.stale.length - MAX_LISTED} more`)}`);
    }
  }

  if (code !== 0) {
    out('', fail('Check failed.'));
  } else if (!options.quiet) {
    out('', ok('Check passed.'));
  }

  return code;
}
