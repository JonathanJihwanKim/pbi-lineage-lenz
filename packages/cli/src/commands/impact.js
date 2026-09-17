/**
 * `impact` — "I want to drop this column. What breaks?"
 *
 * The question a data engineer brings, in their own vocabulary: the physical name, not the
 * model's. The answer is the measures that read it — however many measures down — and the
 * visuals those reach, each located on its page and grouped by report, so it can be pasted
 * into a ticket and settle whether a change is a rename or a negotiation.
 */

import { reverseImpact } from '@pbi-lineage-lenz/viewer';
import { loadModels } from '../analyzeProject.js';
import { out, heading, ok, warn, fail, style, sponsorLine } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz impact')} <path> --column <name> | --measure <name> [options]

  What reads a column or a measure, following every measure-to-measure reference, and
  which visuals that reaches.

  ${style.dim('--column <name>')}      A physical name, matched on its last parts:
                         order_count, order_agg_rpt.order_count, dbo.order_agg_rpt.order_count
                         A whole physical table: order_agg_rpt.*
                         Or a model column: Sales[Amount], Sales[*]
  ${style.dim('--measure <name>')}     A measure: Total Orders, or Sales[Total Orders]
  ${style.dim('--all')}                Every report in the folder, not only one
  ${style.dim('-f, --format <fmt>')}   text (default) | json | md
  ${style.dim('--fail-if-used')}       Exit 1 when anything reads the target. For a warehouse
                         repo's CI: a change dropping a column fails while a report reads it.

  Exit codes: 0 found, 1 used and --fail-if-used, 2 nothing matched.
`;

const FORMATS = new Set(['text', 'json', 'md']);

export function impactCommand({ positionals, options }) {
  const path = positionals[0] ?? '.';
  const format = (options.format ?? 'text').toLowerCase();
  if (!FORMATS.has(format)) throw new Error(`Unknown format "${format}". Use text, json, or md.`);
  if (!options.column && !options.measure) {
    throw new Error('Say what to look up: --column <name> or --measure <name>.');
  }

  const spec = {};
  if (options.column) spec.column = options.column;
  if (options.measure) spec.measure = options.measure;

  const { models, note, manifest } = loadModels(path, { all: options.all });
  const result = reverseImpact(models, spec);

  const used = result.totals.measures > 0 || result.totals.visuals > 0;
  const code = !result.found ? 2 : used && options['fail-if-used'] ? 1 : 0;

  if (format === 'json') {
    out(JSON.stringify({ ...result, exitCode: code, manifest: manifest ?? undefined }, null, 2));
    return code;
  }
  if (format === 'md') {
    out(toMarkdown(result, spec));
    return code;
  }

  if (note && !options.quiet) out(warn(note));
  printText(result, spec, options);

  if (!result.found) {
    out('', fail(`Nothing in ${models.length === 1 ? 'this model' : 'these models'} matches ${describeSpec(spec)}.`));
    if (!options.all && !options.quiet) {
      out(style.dim('  If the folder holds several reports, --all searches every one of them.'));
    }
  } else if (code === 1) {
    out('', fail('Used — failing because of --fail-if-used.'));
  } else if (!options.quiet) {
    out('', used ? warn('In use. The list above is what a change to it would reach.') : ok('Nothing reads it.'));
    sponsorLine(options);
  }
  return code;
}

function describeSpec(spec) {
  return [spec.column && `column "${spec.column}"`, spec.measure && `measure "${spec.measure}"`]
    .filter(Boolean).join(' and ');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Report sections grouped by model, so a shared model's measures are listed once. */
function byModel(result) {
  const groups = new Map();
  for (const report of result.reports) {
    const key = report.modelKey ?? report.model ?? '';
    if (!groups.has(key)) groups.set(key, { model: report.model, reports: [] });
    groups.get(key).reports.push(report);
  }
  return [...groups.values()];
}

/** `_Order Volume → _Margin per Order`, the measures between the target and this one. */
function via(path) {
  const between = path.slice(1, -1).map((ref) => ref.replace(/^\w+:.*?\[/, '').replace(/\]$/, ''));
  return between.length > 0 ? `via ${between.join(' → ')}` : '';
}

function visualLabel(visual) {
  const title = visual.title ? `"${visual.title}"` : null;
  return [visual.type, title].filter(Boolean).join(' ') || visual.id;
}

function printText(result, spec, options) {
  if (!result.found) return;
  const { totals } = result;
  heading(`Impact of ${describeSpec(spec)}`);
  out(`  ${plural(totals.targets, 'match')} · ${plural(totals.measures, 'measure')} · `
    + `${plural(totals.visuals, 'visual')} on ${plural(totals.pages, 'page')} · ${plural(totals.reports, 'report')}`);

  for (const group of byModel(result)) {
    const first = group.reports[0];
    out('', style.bold(`Model ${group.model ?? ''}`));
    for (const target of first.targets) {
      out(`  ${style.dim('matched')}  ${target.table}[${target.name}]`
        + `${target.physicalPath ? `  ${style.dim('←')} ${target.physicalPath}` : ''}`);
    }
    if (first.measures.length > 0) {
      out(`  ${style.dim('measures, by hops from the target')}`);
      for (const measure of first.measures) {
        out(`    ${String(measure.hops).padStart(2)}  ${measure.table}[${measure.name}]`
          + `${measure.isHidden ? style.dim(' (hidden)') : ''}  ${style.dim(via(measure.path))}`);
      }
    }

    for (const report of group.reports) {
      if (report.reportKey === null && report.visuals.length === 0) continue;
      out('', `  ${style.bold(`Report ${report.report ?? report.reportKey}`)}  `
        + style.dim(`${plural(report.visuals.length, 'visual')} on ${plural(report.pages.length, 'page')}`));
      if (report.visuals.length === 0) {
        out(`    ${style.dim('No visual reaches it.')}`);
        continue;
      }
      let page = null;
      for (const visual of report.visuals) {
        if (visual.pageName !== page) {
          page = visual.pageName;
          out(`    ${page}`);
        }
        const field = visual.field ? visual.field.replace(/^\w+:/, '') : '';
        const flags = [visual.neverShown ? 'never shown' : visual.isHidden ? 'hidden' : null].filter(Boolean);
        out(`      ${visualLabel(visual)}  ${style.dim(`${visual.via ?? ''} ${field}`.trim())}`
          + `${flags.length ? style.dim(` (${flags.join(', ')})`) : ''}`
          + `${options.quiet ? '' : `  ${style.dim(visual.key ?? visual.id)}`}`);
      }
    }
  }
}

/** The same answer as markdown, for a ticket or a pull request comment. */
export function toMarkdown(result, spec) {
  const lines = [`## Impact of ${describeSpec(spec)}`, ''];
  if (!result.found) {
    lines.push('_Nothing matches._');
    return lines.join('\n');
  }
  const { totals } = result;
  lines.push(`**${plural(totals.measures, 'measure')}** · **${plural(totals.visuals, 'visual')}** on `
    + `${plural(totals.pages, 'page')} · ${plural(totals.reports, 'report')}`, '');

  for (const group of byModel(result)) {
    const first = group.reports[0];
    lines.push(`### Model \`${group.model}\``, '');
    lines.push(`Matched: ${first.targets.map((t) => `\`${t.table}[${t.name}]\``
      + `${t.physicalPath ? ` (\`${t.physicalPath}\`)` : ''}`).join(', ')}`, '');
    if (first.measures.length > 0) {
      lines.push('| Hops | Measure | Hidden | Through |', '| ---: | --- | --- | --- |');
      for (const m of first.measures) {
        lines.push(`| ${m.hops} | \`${m.table}[${m.name}]\` | ${m.isHidden ? 'yes' : ''} | ${via(m.path).replace(/^via /, '')} |`);
      }
      lines.push('');
    }
    for (const report of group.reports) {
      if (report.visuals.length === 0) continue;
      lines.push(`#### Report \`${report.report ?? report.reportKey}\``, '');
      lines.push('| Page | Visual | Via | Field |', '| --- | --- | --- | --- |');
      for (const v of report.visuals) {
        lines.push(`| ${v.pageName} | ${visualLabel(v).replace(/\|/g, '\\|')} | ${v.via ?? ''} | \`${(v.field ?? '').replace(/^\w+:/, '')}\` |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
