/**
 * A flat, one-row-per-binding export — lineage shaped for slicing rather than reading.
 *
 * `md` is for the reviewer, `html` for the person the file is handed to, `json` for someone
 * building a tool. This is for the person who wants to join lineage to their own catalog:
 * load it into a semantic model and let a stakeholder filter it, or `JOIN` it to a dbt
 * manifest or `information_schema` on the physical column. Both need one row per fact,
 * with the context denormalised onto every row, and neither can use a nested tree without
 * writing the same flattener again.
 *
 * **The column list is public API.** It is consumed by refreshes and CI jobs, where a column
 * that moves breaks something downstream. Columns are only ever added at the end, and any
 * other change bumps FLAT_CONTRACT_VERSION. See docs/output-contract.md.
 */

import { buildIndex, traceMeasure, bindingKeyOf } from '@pbi-lineage-lenz/viewer';

/** Bumped on any change to FLAT_COLUMNS other than appending a column. */
export const FLAT_CONTRACT_VERSION = 1;

/** Every column, in order. The order is part of the contract. */
export const FLAT_COLUMNS = Object.freeze([
  'contract_version',
  // where
  'report_key', 'report', 'model_key', 'model',
  'page_key', 'page_id', 'page_name',
  'visual_key', 'visual_id', 'visual_type', 'visual_title', 'visual_hidden',
  // how
  'binding_key', 'via', 'data_role', 'via_parameter',
  // what
  'field_kind', 'field_scope', 'model_table', 'model_field', 'field_hidden', 'dax',
  // from
  'source_column',
  'physical_system', 'physical_server', 'physical_database', 'physical_schema',
  'physical_table', 'physical_column', 'physical_path',
  'confidence', 'origin', 'sourceless',
  // appended in contract 1, filled only with --page-maps
  'page_map',
]);

/**
 * Every row of the flat export for one report.
 *
 * Grain: one row per (field a visual reaches) × (physical column behind it). A measure
 * expands through measure-to-measure references and calculated columns to the columns it
 * reads, so a row count per physical column is the number of places it reaches.
 *
 * Two kinds of row exist so that a `COUNT` over the file agrees with the `docs` summary:
 * a binding that reaches no physical column still gets one row, with `sourceless` saying
 * why; and a measure no visual in the report reaches gets a row with `via = unbound`.
 *
 * Rows are yielded in a deterministic order — by visual key, binding key, then source
 * column — so the file diffs cleanly in git.
 *
 * @param {object} model - A viewer model.
 * @param {object} [options]
 * @param {(visual: object, page: object) => string|null} [options.pageMap] - Supplies the
 *   `page_map` value per visual; see pageMapDataUri().
 * @returns {Generator<object>} Plain objects with exactly FLAT_COLUMNS as keys, in order.
 */
export function* toBindingRows(model, { pageMap = null } = {}) {
  const index = buildIndex(model);
  const pages = new Map((model.pages || []).map((page) => [page.id, page]));
  const reportMeasures = new Set((model.reportMeasures || [])
    .map((m) => `${m.table}[${m.name}]`.toLowerCase()));
  const meta = model.meta || {};
  const reportKey = meta.reportKey ?? meta.reportName ?? null;

  const context = {
    report_key: reportKey,
    report: meta.reportName ?? null,
    model_key: meta.modelKey ?? meta.modelName ?? null,
    model: meta.modelName ?? null,
  };

  const reached = new Set();
  const visuals = [...(model.visuals || [])].sort((a, b) => compare(a.key ?? a.ref, b.key ?? b.ref));

  for (const visual of visuals) {
    const page = pages.get(visual.page);
    const where = {
      page_key: page?.key ?? null,
      page_id: visual.page ?? null,
      page_name: page?.name ?? null,
      visual_key: visual.key ?? null,
      visual_id: visual.id,
      visual_type: visual.type ?? null,
      visual_title: visual.title ?? null,
      visual_hidden: !!visual.isHidden,
    };
    const map = pageMap ? pageMap(visual, page) : null;

    const fields = (visual.fields || [])
      .map((field) => ({ field, bindingKey: bindingKeyOf(visual, field) }))
      .sort((a, b) => compare(a.bindingKey, b.bindingKey));
    for (const { field, bindingKey } of fields) {
      if (field.ref) reached.add(field.ref);
      const how = {
        binding_key: bindingKey,
        via: field.via ?? null,
        data_role: field.role ?? null,
        via_parameter: field.viaParameter ?? null,
      };
      for (const what of expandField(field, model, index, reportMeasures)) {
        yield row({ ...context, ...where, ...how, ...what, page_map: map });
      }
    }
  }

  // Measures nothing in this report reaches — directly or through another measure.
  const readByReached = new Set();
  for (const ref of reached) {
    if (!ref.startsWith('measure:')) continue;
    for (const entry of traceMeasure(ref, model, index).chain) readByReached.add(entry.ref);
  }
  const unbound = (model.measures || [])
    .filter((measure) => !reached.has(measure.ref) && !readByReached.has(measure.ref))
    .sort((a, b) => compare(a.ref, b.ref));

  for (const measure of unbound) {
    const how = {
      binding_key: `${reportKey ?? ''}|unbound|measure|${measure.table}[${measure.name}]`,
      via: 'unbound',
      data_role: null,
      via_parameter: null,
    };
    const field = { kind: 'measure', ref: measure.ref, table: measure.table, name: measure.name };
    for (const what of expandField(field, model, index, reportMeasures)) {
      yield row({ ...context, ...how, ...what });
    }
  }
}

/** What a field is, and one entry per physical column behind it. */
function expandField(field, model, index, reportMeasures) {
  const target = field.ref ? index.byRef.get(field.ref) : null;
  const qualified = `${field.table}[${field.name}]`.toLowerCase();

  const what = {
    field_kind: field.kind ?? null,
    field_scope: target
      ? 'model'
      : reportMeasures.has(qualified) ? 'report' : field.kind === 'fieldParameter' ? 'model' : 'missing',
    model_table: field.table ?? null,
    model_field: field.name ?? null,
    field_hidden: target ? !!target.isHidden : null,
    dax: target?.expression ?? null,
  };

  // A field parameter binding, a report-level measure, or a reference to something the
  // model no longer contains: no trace to follow, and the reason says which.
  if (!target) {
    const sourceless = field.kind === 'fieldParameter'
      ? 'field-parameter'
      : what.field_scope === 'report' ? 'no-column-reference' : 'unresolved';
    return [{ ...what, ...physical(null), sourceless }];
  }

  const { columns, unresolved } = traceMeasure(target.ref, model, index);
  const sorted = [...columns].sort((a, b) => compare(a.ref, b.ref));
  const gaps = [...unresolved].sort((a, b) => compare(a.ref, b.ref));

  if (sorted.length === 0 && gaps.length === 0) {
    return [{
      ...what,
      ...physical(null),
      sourceless: target.sourceless ?? 'no-column-reference',
    }];
  }

  return [
    ...sorted.map((column) => ({
      ...what,
      ...physical(column),
      confidence: column.confidence ?? null,
      origin: column.origin ?? null,
      sourceless: null,
    })),
    // A column with no physical source, listed rather than dropped, carrying its reason.
    ...gaps.map((column) => ({
      ...what,
      ...physical(null),
      source_column: `${column.table}[${column.name}]`,
      confidence: column.confidence ?? null,
      origin: column.origin ?? null,
      sourceless: column.sourceless ?? 'unresolved',
    })),
  ];
}

/**
 * The physical name in parts. A dotted string would have to be re-parsed by every
 * consumer, and the parsing rules differ per source system: BigQuery's project and dataset
 * are a database and a schema by another name.
 */
function physical(column) {
  const p = column?.physical ?? null;
  return {
    // The model column this row traces to — for a measure, one of the columns it reads.
    // The join key to the model side, and the only way to tell two sourceless rows apart.
    source_column: column ? `${column.table}[${column.name}]` : null,
    physical_system: p?.system ?? null,
    physical_server: p?.server ?? p?.url ?? null,
    physical_database: p?.database ?? p?.project ?? null,
    physical_schema: p?.schema ?? p?.dataset ?? null,
    physical_table: p?.table ?? null,
    physical_column: p?.column ?? null,
    physical_path: column?.physicalPath ?? null,
    confidence: null,
    origin: null,
  };
}

/** Exactly FLAT_COLUMNS, in order, with absent values as null. */
function row(values) {
  const out = {};
  for (const column of FLAT_COLUMNS) {
    out[column] = column === 'contract_version' ? FLAT_CONTRACT_VERSION : (values[column] ?? null);
  }
  return out;
}

function compare(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** One CSV field, quoted only when it has to be (RFC 4180). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV header line, CRLF-terminated as RFC 4180 has it. */
export function csvHeader() {
  return `${FLAT_COLUMNS.join(',')}\r\n`;
}

/** One row as a CSV line. */
export function csvLine(values) {
  return `${FLAT_COLUMNS.map((column) => csvField(values[column])).join(',')}\r\n`;
}

/** One row as an NDJSON line. */
export function ndjsonLine(values) {
  return `${JSON.stringify(values)}\n`;
}

/**
 * The whole export as one string. For a large workspace, write csvHeader() and then
 * csvLine() per row from toBindingRows() instead, so the file never exists in memory whole.
 *
 * @param {object|Array<object>} models - One viewer model, or one per report.
 * @param {object} [options] - See toBindingRows(); `format` is 'csv' (default) or 'ndjson'.
 */
export function toFlat(models, { format = 'csv', ...options } = {}) {
  const line = format === 'ndjson' ? ndjsonLine : csvLine;
  const parts = format === 'ndjson' ? [] : [csvHeader()];
  for (const model of Array.isArray(models) ? models : [models]) {
    for (const values of toBindingRows(model, options)) parts.push(line(values));
  }
  return parts.join('');
}
