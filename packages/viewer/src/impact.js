/**
 * Reverse impact — "what breaks if I drop this column?"
 *
 * Every lens is rooted at something a Power BI developer already knows: a page, a measure,
 * a model column. The person asking whether a column can be dropped is usually a data
 * engineer, who knows `lakehouse.schema.table.column` and nothing else. This reads the
 * same lineage from the other end, starting from their name for the thing.
 *
 * The trap is reading bindings directly. A visual that shows `[Margin %]` never names the
 * column under `[Margin]` two measures down, so a reverse index built on direct bindings
 * alone under-reports impact — the dangerous direction to be wrong in. Everything here
 * follows measure-to-measure and calculated-column references transitively, and records
 * how many hops each answer took.
 *
 * Works over one viewer model or many, so the same call answers across a workspace.
 */

import { buildIndex, resolveDependency } from './viewerModel.js';

/** Lowercased, trimmed, and with SQL-style brackets and quotes dropped from each part. */
function normalizeName(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/["`[\]]/g, '');
}

/** `Table[Name]` → {table, name}, or null. */
function splitModelName(text) {
  const match = /^'?(.*?)'?\[(.*)\]$/s.exec(String(text ?? '').trim());
  return match ? { table: match[1], name: match[2] } : null;
}

/** Does a dotted physical path end with the dotted spec, on segment boundaries? */
function pathEndsWith(path, spec) {
  if (!path) return false;
  const p = normalizeName(path);
  return p === spec || p.endsWith(`.${spec}`);
}

/** The physical table part of a column path: everything before the last segment. */
function tableOfPath(path) {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Find the model objects a target spec names, in one model.
 *
 * @param {object} model - A viewer model.
 * @param {{column?: string, measure?: string}} spec
 *   `column` accepts a physical name matched on its trailing segments
 *   (`order_count`, `order_agg_rpt.order_count`, `lakehouse.dbo.order_agg_rpt.order_count`),
 *   a physical table wildcard (`order_agg_rpt.*`), or a model column (`Sales[Amount]`,
 *   `Sales[*]`). `measure` accepts `Table[Measure]` or a bare measure name.
 * @returns {{columns: Array<object>, measures: Array<object>}}
 */
export function resolveTarget(model, spec = {}) {
  const columns = [];
  const measures = [];

  if (spec.column) {
    const modelName = splitModelName(spec.column);
    if (modelName) {
      const table = modelName.table.toLowerCase();
      const name = modelName.name.toLowerCase();
      for (const column of model.columns || []) {
        if (column.table.toLowerCase() !== table) continue;
        if (name === '*' || column.name.toLowerCase() === name) columns.push(column);
      }
    } else {
      const text = normalizeName(spec.column);
      const wildcard = text.endsWith('.*');
      const wanted = wildcard ? text.slice(0, -2) : text;
      for (const column of model.columns || []) {
        const paths = [column.physicalPath, ...(column.alsoFrom || [])].filter(Boolean);
        const hit = paths.some((path) => (wildcard
          ? pathEndsWith(tableOfPath(normalizeName(path)), wanted)
          : pathEndsWith(path, wanted)));
        if (hit) columns.push(column);
      }
    }
  }

  if (spec.measure) {
    const modelName = splitModelName(spec.measure);
    const name = (modelName ? modelName.name : spec.measure).trim().toLowerCase();
    const table = modelName?.table.toLowerCase();
    for (const measure of model.measures || []) {
      if (measure.name.toLowerCase() !== name) continue;
      if (table && measure.table.toLowerCase() !== table) continue;
      measures.push(measure);
    }
  }

  return { columns, measures };
}

/**
 * Who reads each measure and column directly: the inverse of `dependsOn`.
 * @returns {Map<string, Array<object>>} ref → measures and calculated columns reading it.
 */
function buildReaders(model, index) {
  const readers = new Map();
  const add = (ref, reader) => {
    if (!readers.has(ref)) readers.set(ref, []);
    const list = readers.get(ref);
    if (!list.includes(reader)) list.push(reader);
  };

  const items = [
    ...(model.measures || []),
    ...(model.columns || []).filter((column) => column.dependsOn),
  ];
  // Resolved exactly as a forward trace resolves them — case-insensitively, qualified
  // first — so impact and trace can never disagree about what reads what.
  for (const item of items) {
    for (const dependency of item.dependsOn?.columns || []) {
      const column = resolveDependency('column', dependency, index.lookup);
      add(column ? column.ref : `column:${dependency}`, item);
    }
    for (const dependency of item.dependsOn?.measures || []) {
      const measure = resolveDependency('measure', dependency, index.lookup);
      if (measure) add(measure.ref, item);
    }
  }
  return readers;
}

/**
 * Everything downstream of a set of model objects, in one model.
 *
 * @param {object} model - A viewer model.
 * @param {{columns: Array<object>, measures: Array<object>}} targets - resolveTarget() output.
 * @param {object} [index] - buildIndex(model), when the caller already has one.
 * @returns {{measures: Array<object>, columns: Array<object>, visuals: Array<object>,
 *   pages: Array<object>}}
 *   Measures and calculated columns carry `hops` (1 = reads the target directly) and `path`
 *   (refs from the target to it). Visuals carry the field that reaches them and its hops.
 */
export function impactInModel(model, targets, index = buildIndex(model)) {
  const readers = buildReaders(model, index);

  // Breadth-first so `hops` is the shortest route and `path` the one a reader follows.
  const reached = new Map();
  const queue = [];
  for (const target of [...targets.columns, ...targets.measures]) {
    reached.set(target.ref, { item: target, hops: 0, path: [target.ref] });
    queue.push(target.ref);
  }
  while (queue.length > 0) {
    const ref = queue.shift();
    const from = reached.get(ref);
    for (const reader of readers.get(ref) || []) {
      if (reached.has(reader.ref)) continue;
      reached.set(reader.ref, { item: reader, hops: from.hops + 1, path: [...from.path, reader.ref] });
      queue.push(reader.ref);
    }
  }

  const measures = [];
  const columns = [];
  for (const { item, hops, path } of reached.values()) {
    if (hops === 0) continue;
    const entry = {
      ref: item.ref, table: item.table, name: item.name, isHidden: !!item.isHidden, hops, path,
    };
    (item.ref.startsWith('measure:') ? measures : columns).push(entry);
  }

  const pageNames = new Map((model.pages || []).map((page) => [page.id, page]));
  const visuals = [];
  for (const visual of model.visuals || []) {
    let best = null;
    for (const field of visual.fields || []) {
      const hit = field.ref && reached.get(field.ref);
      if (!hit) continue;
      if (!best || hit.hops < best.hops) best = { field, hops: hit.hops };
    }
    if (!best) continue;
    const page = pageNames.get(visual.page);
    visuals.push({
      key: visual.key ?? null,
      ref: visual.ref,
      id: visual.id,
      page: visual.page,
      pageKey: page?.key ?? null,
      pageName: page?.name ?? visual.page,
      type: visual.type,
      title: visual.title,
      via: best.field.via,
      field: best.field.ref,
      // Reaching the visual is one hop past the field it binds.
      hops: best.hops + 1,
      isHidden: !!visual.isHidden,
      neverShown: !!visual.neverShown,
    });
  }

  const pages = [...new Set(visuals.map((visual) => visual.page))]
    .map((id) => ({ id, key: pageNames.get(id)?.key ?? null, name: pageNames.get(id)?.name ?? id }));

  const byHops = (a, b) => a.hops - b.hops || a.ref.localeCompare(b.ref);
  const byPlace = (a, b) => String(a.pageName).localeCompare(String(b.pageName))
    || String(a.key ?? a.ref).localeCompare(String(b.key ?? b.ref));
  return {
    measures: measures.sort(byHops),
    columns: columns.sort(byHops),
    visuals: visuals.sort(byPlace),
    pages,
  };
}

/**
 * Reverse impact across one or more reports.
 *
 * @param {object|Array<object>} models - A viewer model, or one per report in a workspace.
 * @param {{column?: string, measure?: string}} spec - See resolveTarget().
 * @returns {{spec: object, found: boolean, reports: Array<object>,
 *   totals: {targets: number, measures: number, visuals: number, pages: number, reports: number}}}
 *   `reports` lists every report where the target exists, including those where nothing
 *   reads it — "exists and unused" is an answer worth giving.
 */
export function reverseImpact(models, spec) {
  const list = Array.isArray(models) ? models : [models];
  const reports = [];
  const measureKeys = new Set();
  const targetKeys = new Set();

  for (const model of list) {
    const targets = resolveTarget(model, spec);
    if (targets.columns.length === 0 && targets.measures.length === 0) continue;

    const result = impactInModel(model, targets);
    const modelKey = model.meta?.modelKey ?? model.meta?.modelName ?? '';
    for (const target of [...targets.columns, ...targets.measures]) targetKeys.add(`${modelKey}|${target.ref}`);
    for (const measure of result.measures) measureKeys.add(`${modelKey}|${measure.ref}`);

    reports.push({
      report: model.meta?.reportName ?? null,
      reportKey: model.meta?.reportKey ?? null,
      model: model.meta?.modelName ?? null,
      modelKey: model.meta?.modelKey ?? null,
      targets: [
        ...targets.columns.map((c) => ({
          kind: 'column', ref: c.ref, table: c.table, name: c.name, physicalPath: c.physicalPath ?? null,
        })),
        ...targets.measures.map((m) => ({ kind: 'measure', ref: m.ref, table: m.table, name: m.name })),
      ],
      ...result,
    });
  }

  return {
    spec,
    found: reports.length > 0,
    reports,
    totals: {
      targets: targetKeys.size,
      // A model shared by several reports is counted once: the measures are the same measures.
      measures: measureKeys.size,
      visuals: reports.reduce((n, r) => n + r.visuals.length, 0),
      pages: reports.reduce((n, r) => n + r.pages.length, 0),
      reports: reports.filter((r) => r.visuals.length > 0).length,
    },
  };
}

/**
 * How widely each column is used, for every column at once.
 *
 * The per-column "Used by" line in generated docs, which would otherwise mean one impact
 * walk per column. Computed from the other direction instead — each measure's closure of
 * columns, inverted — so it costs one pass over the measures.
 *
 * @param {object} model - A viewer model.
 * @param {object} [index] - buildIndex(model).
 * @returns {Map<string, {measures: number, visuals: number, pages: number}>} keyed by column ref.
 */
export function columnUsage(model, index = buildIndex(model)) {
  const readers = buildReaders(model, index);
  const usage = new Map();

  const visualsByField = new Map();
  for (const visual of model.visuals || []) {
    for (const field of visual.fields || []) {
      if (!field.ref) continue;
      if (!visualsByField.has(field.ref)) visualsByField.set(field.ref, new Set());
      visualsByField.get(field.ref).add(visual);
    }
  }

  for (const column of model.columns || []) {
    const seen = new Set([column.ref]);
    const stack = [column.ref];
    let measures = 0;
    const visuals = new Set(visualsByField.get(column.ref) || []);
    while (stack.length > 0) {
      for (const reader of readers.get(stack.pop()) || []) {
        if (seen.has(reader.ref)) continue;
        seen.add(reader.ref);
        stack.push(reader.ref);
        if (reader.ref.startsWith('measure:')) measures++;
        for (const visual of visualsByField.get(reader.ref) || []) visuals.add(visual);
      }
    }
    usage.set(column.ref, {
      measures,
      visuals: visuals.size,
      pages: new Set([...visuals].map((visual) => visual.page)).size,
    });
  }
  return usage;
}
