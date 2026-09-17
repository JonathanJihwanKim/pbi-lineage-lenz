/**
 * A whole workspace, read as one thing.
 *
 * The questions that matter in a Fabric workspace span reports: which reports show this
 * measure, which of the thin reports over this model depend on it, is it defined in the
 * model or only in one report. A per-report document cannot answer them by construction,
 * and one model with many reports — the normal shape, and the most dangerous place to make
 * a change — is invisible from inside any one of them.
 */

import { buildIndex, traceMeasure, VIEWER_MODEL_VERSION } from '@pbi-lineage-lenz/viewer';
import { toJson } from './json.js';

/** Escape a markdown table cell. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function table(headers, rows) {
  if (rows.length === 0) return '_None._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/**
 * Every measure a report reaches — bound directly, or read by something bound — with the
 * number of visuals reaching it.
 * @returns {Map<string, number>} measure ref → visuals
 */
export function measuresReached(model) {
  const index = buildIndex(model);
  const reached = new Map();
  const closures = new Map();
  for (const visual of model.visuals || []) {
    const inVisual = new Set();
    for (const field of visual.fields || []) {
      if (!field.ref?.startsWith('measure:')) continue;
      if (!closures.has(field.ref)) {
        closures.set(field.ref, traceMeasure(field.ref, model, index).chain.map((entry) => entry.ref));
      }
      for (const ref of closures.get(field.ref)) inVisual.add(ref);
    }
    for (const ref of inVisual) reached.set(ref, (reached.get(ref) || 0) + 1);
  }
  return reached;
}

/** Relative link from the index to a report's or model's own document. */
export function estateDocPath(model) {
  const key = model.meta?.reportKey;
  return key ? `reports/${key}.md` : `models/${model.meta?.modelKey ?? model.meta?.modelName}.md`;
}

/**
 * The workspace index: what was found, how it paired, and which measures each shared model
 * serves to which reports.
 *
 * @param {Array<object>} models - Viewer models, one per report (and per unused model).
 * @param {object} manifest - From the CLI's workspace loader.
 * @returns {string}
 */
export function toEstateMarkdown(models, manifest) {
  const generated = (models[0]?.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
  const lines = [
    '# Workspace lineage',
    '',
    `_Generated ${generated} by [PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz)._`,
    '',
  ];

  const { counts } = manifest;
  lines.push(
    `**${counts.reports}** report${counts.reports === 1 ? '' : 's'} over **${counts.models}** `
    + `semantic model${counts.models === 1 ? '' : 's'}; ${counts.analysed} analysed`
    + `${counts.unpaired ? `, ${counts.unpaired} not paired with a model` : ''}`
    + `${counts.failed ? `, ${counts.failed} could not be read` : ''}.`,
    '',
  );

  const byReport = new Map(models.filter((m) => m.meta?.reportKey).map((m) => [m.meta.reportKey, m]));
  const byModelOnly = new Map(models.filter((m) => !m.meta?.reportKey).map((m) => [m.meta.modelKey, m]));

  lines.push('## Reports', '');
  lines.push(table(
    ['Report', 'Model', 'Pages', 'Visuals', 'Status'],
    manifest.reports.map((report) => {
      const model = byReport.get(report.key);
      return [
        model ? `[${report.key}](${encodeURI(estateDocPath(model))})` : report.key,
        report.modelKey ?? '—',
        model ? model.pages.length : '',
        model ? model.visuals.length : report.visualCount,
        report.status === 'analysed' ? 'analysed' : `${report.status}: ${report.problem}`,
      ];
    }),
  ), '');

  lines.push('## Semantic models', '');
  lines.push(
    'A model read by several reports is where a change is most dangerous: whoever changes it '
    + 'cannot see the reports.',
    '',
  );
  lines.push(table(
    ['Model', 'Read by', 'Reports', 'Status'],
    manifest.models.map((model) => {
      const only = byModelOnly.get(model.key);
      return [
        only ? `[${model.key}](${encodeURI(estateDocPath(only))})` : model.key,
        model.reports.length,
        model.reports.join(', ') || '_no report in this folder_',
        model.status === 'analysed' ? 'analysed' : `${model.status}: ${model.problem}`,
      ];
    }),
  ), '');

  // Which measures each report reaches, per model. Only for models more than one report
  // reads — for a model with one report, the report's own document already says it.
  const shared = manifest.models.filter((model) => model.reports.length > 1);
  if (shared.length > 0) {
    lines.push('## Measures across reports', '');
    lines.push(
      'For each model read by more than one report: the reports that show each measure, '
      + 'directly or through another measure.',
      '',
    );
    for (const modelRow of shared) {
      const reports = modelRow.reports.map((key) => byReport.get(key)).filter(Boolean);
      if (reports.length === 0) continue;
      const reach = reports.map((model) => ({ key: model.meta.reportKey, reached: measuresReached(model) }));

      const measures = reports[0].measures;
      const rows = measures
        .map((measure) => {
          const showing = reach.filter((r) => r.reached.has(measure.ref));
          return [measure, showing];
        })
        .filter(([, showing]) => showing.length > 0)
        .sort((a, b) => b[1].length - a[1].length || a[0].ref.localeCompare(b[0].ref))
        .map(([measure, showing]) => [
          `${measure.table}[${measure.name}]`,
          `${showing.length} of ${reports.length}`,
          showing.map((r) => `${r.key} (${r.reached.get(measure.ref)})`).join(', '),
        ]);
      const unused = measures.length - rows.length;

      lines.push(`### ${modelRow.key}`, '');
      lines.push(table(['Measure', 'Reports', 'Where (visuals)'], rows), '');
      if (unused > 0) {
        lines.push(`_${unused} measure${unused === 1 ? '' : 's'} no report in this folder reaches._`, '');
      }
    }
  }

  // Report-level measures: defined in one report, invisible from the model.
  const reportMeasures = models.flatMap((model) => (model.reportMeasures || [])
    .map((m) => [model.meta.reportKey, `${m.table}[${m.name}]`]));
  if (reportMeasures.length > 0) {
    lines.push('## Report-level measures', '');
    lines.push('Defined in a report\'s own extensions rather than in its model, so no other report has them.', '');
    lines.push(table(['Report', 'Measure'], reportMeasures), '');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * The workspace as one JSON document: the manifest and every report's model, each in the
 * same shape `docs --format json` gives for a single report.
 */
export function toEstateJson(models, manifest, { pretty = true } = {}) {
  const reports = models.map((model) => JSON.parse(toJson(model, { pretty: false })));
  return `${JSON.stringify({ version: VIEWER_MODEL_VERSION, kind: 'workspace', manifest, reports }, null, pretty ? 2 : 0)}\n`;
}
