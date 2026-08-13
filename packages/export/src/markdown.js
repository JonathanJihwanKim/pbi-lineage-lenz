import { describeModelShape, ROLE_ORDER, TABLE_ROLE } from '@pbi-lineage-lenz/viewer';

/**
 * Markdown documentation from a viewer model.
 *
 * Aimed at a repository, not at a printer: it is meant to be committed beside the PBIP so
 * a pull request shows what changed about the model in words, and so somebody browsing
 * GitHub can read the model without opening Power BI.
 *
 * The dual name leads every table and column section. That is the whole reason the tool
 * exists — a data engineer searching this file for `fact_sales` should find it.
 */

/** Escape the characters that would otherwise break a table cell or start markup. */
function cell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** A markdown table, or an em dash when there is nothing to show. */
function table(headers, rows) {
  if (rows.length === 0) return '_None._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/** GitHub's heading anchor: lowercase, spaces to hyphens, punctuation dropped. */
function anchor(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const CONFIDENCE_MARK = { exact: '●', inferred: '◐', unknown: '○' };

function confidence(value) {
  return value ? `${CONFIDENCE_MARK[value] ?? '○'} ${value}` : '○ unknown';
}

/**
 * Render a model as markdown.
 *
 * @param {object} model - Viewer model from toViewerModel().
 * @param {object} [options]
 * @param {boolean} [options.dax=true] - Include measure expressions.
 * @returns {string}
 */
export function toMarkdown(model, { dax = true } = {}) {
  const name = model.meta?.modelName || 'Power BI model';
  const generated = (model.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
  const stats = model.stats?.confidence;

  const sections = [];

  sections.push(`# ${name}`, '');
  sections.push(
    `_Generated ${generated} by [PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz)._`,
    '',
  );

  sections.push('## Overview', '');
  sections.push(table(
    ['', 'Count'],
    [
      ['Tables', model.tables.length],
      ['Columns', model.columns.length],
      ['Measures', model.measures.length],
      ['Relationships', model.relationships.length],
      ['Report pages', model.pages.length],
      ['Visuals', model.visuals.length],
    ],
  ), '');

  if (stats) {
    sections.push(
      `**${stats.sourced ?? 0} of ${(stats.sourced ?? 0) + (stats.unresolved ?? 0)} columns** that read `
      + `from a source are traced to a physical column (${Math.round((stats.coverage ?? 0) * 100)}%)`
      + `${stats.computed ? `, and **${stats.computed}** more are computed and have no source at all` : ''}.`,
      '',
      `Confidence in those answers: ${stats.exact ?? 0} stated, ${stats.inferred ?? 0} assumed, `
      + `${stats.unknown ?? 0} unresolved.`,
      '',
      '> The two counts measure different things. `exact` / `inferred` / `unknown` is confidence in '
      + 'the answer — "this column is computed in DAX and has no physical source" is an exact answer, '
      + 'so a calculated column is `exact`. Coverage is about origin, and counts only the columns '
      + 'that read from somewhere.',
      '',
      '> `exact` means the source name is stated by the model — written down as a rename, or fixed '
      + 'by a chain in which every step is accounted for and none of them can rename a column. '
      + '`inferred` means a step in that chain could not be read, so the name is assumed to pass '
      + 'through unchanged. `unknown` means no physical table was resolved at all, and says so '
      + 'rather than guessing.',
      '',
    );
  }

  // ── Sources ──
  if (model.sources.length > 0) {
    sections.push('## Data sources', '');
    sections.push(table(
      ['Type', 'Server', 'Database', 'Notes'],
      model.sources.map((source) => [
        source.type ?? '',
        source.server ?? '',
        source.database ?? '',
        [
          source.parameterized ? 'parameterized' : '',
          source.isNativeQuery ? 'native SQL' : '',
          source.gatewayRequired ? 'gateway required' : '',
        ].filter(Boolean).join(', '),
      ]),
    ), '');
  }

  // ── Tables ──
  sections.push('## Tables', '');
  sections.push(table(
    ['Table', 'Physical source', 'Columns', 'Measures'],
    model.tables.map((t) => [
      `[${t.name}](#${anchor(t.name)})`,
      t.physicalPath ?? '_unresolved_',
      t.columnCount,
      t.measureCount,
    ]),
  ), '');

  for (const modelTable of model.tables) {
    sections.push(`### ${modelTable.name}`, '');
    if (modelTable.physicalPath) sections.push(`**Source:** \`${modelTable.physicalPath}\``, '');

    const columns = model.columns.filter((column) => column.table === modelTable.name);
    sections.push(table(
      ['Column', 'Physical column', 'Type', 'Confidence'],
      columns.map((column) => [
        column.name,
        column.physicalPath ?? '_unresolved_',
        column.dataType ?? '',
        confidence(column.confidence),
      ]),
    ), '');

    // The M pipeline, so a data engineer can see what happened between their table and
    // the model's.
    if (modelTable.steps.length > 0) {
      sections.push(
        '<details><summary>Power Query steps</summary>',
        '',
        table(['#', 'Step', 'Kind'], modelTable.steps.map((step, i) => [i + 1, step.name, step.kind])),
        '',
        '</details>',
        '',
      );
    }
  }

  // ── Measures ──
  sections.push('## Measures', '');
  sections.push(table(
    ['Measure', 'Table', 'Shown in'],
    model.measures.map((measure) => [
      measure.name,
      measure.table,
      measure.usedByVisuals.length === 0 ? '_no visual_' : `${measure.usedByVisuals.length} visuals`,
    ]),
  ), '');

  if (dax) {
    for (const measure of model.measures) {
      if (!measure.expression) continue;
      sections.push(`### ${measure.table}[${measure.name}]`, '');
      if (measure.description) sections.push(measure.description, '');
      sections.push('```dax', measure.expression.trim(), '```', '');

      const shown = measure.usedByVisuals.length;
      sections.push(
        shown === 0
          ? '_No visual shows this measure._'
          : `Shown in ${shown} visual${shown === 1 ? '' : 's'}.`,
        '',
      );
    }
  }

  // ── Model shape ──
  // A relationship list is not a data model. 87 rows of `fact.date_fk -> Time Period`
  // describe the file; "16 facts around 24 dimensions" describes the model, and it is
  // the first thing somebody reading this in a pull request needs.
  const shape = describeModelShape(model);
  if (model.relationships.length > 0) {
    sections.push('## Model shape', '');
    sections.push(
      ROLE_ORDER
        .filter((role) => shape.counts[role] > 0)
        .map((role) => `**${shape.counts[role]}** ${role}${shape.counts[role] === 1 ? '' : 's'}`)
        .join(' · '),
      '',
    );

    for (const [label, list, note] of [
      ['Bidirectional', shape.bidirectional, 'filters travel both ways, a common source of ambiguous paths'],
      ['Inactive', shape.inactive, 'only applies inside `USERELATIONSHIP()`'],
      ['Dangling', shape.dangling, 'names a table this model does not contain'],
    ]) {
      if (list.length === 0) continue;
      sections.push(`> **${label}: ${list.length}** — ${note}.`, '',
        list.map((rel) => `> - \`${rel.fromTable}[${rel.fromColumn}]\` → \`${rel.toTable}[${rel.toColumn}]\``).join('\n'),
        '');
    }

    sections.push(mermaidErd(model, shape), '');

    sections.push('### Relationships', '');
    sections.push(table(
      ['From', 'To', 'Cross filter', 'Active'],
      model.relationships.map((rel) => [
        `${rel.fromTable}[${rel.fromColumn}]`,
        `${rel.toTable}[${rel.toColumn}]`,
        rel.crossFilter ?? '',
        rel.isActive ? 'yes' : 'no',
      ]),
    ), '');
  }

  // ── Report ──
  if (model.pages.length > 0) {
    sections.push('## Report pages', '');
    sections.push(table(
      ['Page', 'Visuals', 'Size'],
      model.pages.map((page) => [
        page.name,
        page.visualCount,
        page.width && page.height ? `${page.width}×${page.height}` : '',
      ]),
    ), '');
  }

  return `${sections.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * A mermaid entity-relationship diagram of the model.
 *
 * Mermaid because GitHub renders it inline: a diagram that needs a viewer is a diagram
 * nobody opens, and the whole point of committing this file beside the PBIP is that
 * somebody browsing the repository can read the model without installing anything.
 *
 * Facts and dimensions only. Standalone tables — 20 of 61 in one real model, all field
 * parameters and measure holders — would be 20 disconnected boxes carrying no shape, and
 * they are listed in the Tables section anyway. Nothing is hidden that a relationship
 * touches.
 *
 * Above a threshold the diagram stops being readable and starts being a hairball, so it
 * gives way to the table below it rather than rendering something useless.
 */
function mermaidErd(model, shape, { maxTables = 40 } = {}) {
  const drawn = [...shape.tables.values()].filter((entry) => entry.role !== TABLE_ROLE.STANDALONE);

  if (drawn.length === 0) return '';
  if (drawn.length > maxTables) {
    return `_${drawn.length} related tables — too many to draw legibly. `
      + 'The relationships are listed below, and the app draws one table at a time._';
  }

  const id = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');
  const seen = new Set();
  const lines = ['```mermaid', 'erDiagram'];

  for (const rel of model.relationships) {
    if (!shape.tables.has(rel.fromTable) || !shape.tables.has(rel.toTable)) continue;
    // Many-to-one, fact to dimension, which is the direction Power BI relationships run.
    // `}o--||` reads "many optional on the left, exactly one on the right".
    const key = `${rel.fromTable}|${rel.toTable}|${rel.fromColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = rel.isActive === false
      ? `${rel.fromColumn} (inactive)`
      : rel.crossFilter === 'bothDirections' ? `${rel.fromColumn} (both)` : rel.fromColumn;
    lines.push(`  ${id(rel.toTable)} ||--o{ ${id(rel.fromTable)} : "${label}"`);
  }

  // Give every drawn table a box even when nothing above named it, so a table that only
  // appears on the receiving side of a deduplicated pair is not dropped.
  for (const entry of drawn) lines.push(`  ${id(entry.name)}`);

  lines.push('```');
  return lines.join('\n');
}
