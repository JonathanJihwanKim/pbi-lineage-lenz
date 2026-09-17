/**
 * Viewer model — the serializable shape both the web app and the handoff file render.
 *
 * `analyze()` returns Maps, Sets, and cross-referenced objects. None of that survives
 * JSON, and the handoff file is nothing but JSON embedded in a page. This module flattens
 * an analysis result into plain arrays with stable string ids, so the same payload can be
 * rendered live in the browser or frozen into a file and opened months later.
 *
 * Ids are also the deep-link anchors, which is why they are readable rather than numeric:
 * `#/measure/Sales[Total Sales]` pasted into a chat is the whole point of the handoff.
 */

/** Bump when the payload shape changes incompatibly. */
export const VIEWER_MODEL_VERSION = 3;

/**
 * What a table is, beyond its rows.
 *
 * A field parameter and a calculation group are model machinery: they carry no data of
 * their own, they cannot have a physical source, and they change what every *other* table
 * shows. The core detected both from the first release and the viewer payload dropped
 * them, so a reader met a two-column table called `NPM go live after` with no measures and
 * no source and nothing anywhere saying that picking a row from it rewrites every measure
 * in the visual.
 */
export const TABLE_KIND = Object.freeze({
  TABLE: 'table',
  FIELD_PARAMETER: 'fieldParameter',
  CALCULATION_GROUP: 'calculationGroup',
});

/** Stable id for a model object, used as both map key and URL fragment. */
export const refs = {
  table: (table) => `table:${table}`,
  column: (table, column) => `column:${table}[${column}]`,
  measure: (table, measure) => `measure:${table}[${measure}]`,
  visual: (page, visual) => `visual:${page}/${visual}`,
  page: (page) => `page:${page}`,
  source: (key) => `source:${key}`,
};

/**
 * Keys that identify a report, page, visual or binding across a whole workspace.
 *
 * A PBIR visual id is unique within its page of one report and nowhere else, and page ids
 * and page names repeat across reports ("Overview" is in most of them). An id that looks
 * global and is not produces confidently wrong aggregates the moment anyone groups by it
 * outside this tool — two visuals from two reports merged into one row, silently.
 *
 * Keys are built from PBIR ids rather than display names, so renaming a page does not look
 * like deleting it, and from the report's folder, so they come out the same on every run
 * over the same input. The raw `id` stays on each object: it is what finds the file on disk.
 */
export const keys = {
  page: (reportKey, pageId) => `${reportKey}/${pageId}`,
  visual: (reportKey, pageId, visualId) => `${reportKey}/${pageId}/${visualId}`,
  binding: (visualKey, kind, table, name) => `${visualKey}|${kind}|${table ?? ''}[${name ?? ''}]`,
};

/**
 * A field's binding key. Derived rather than stored: the handoff file embeds the payload,
 * and on a real report the stored keys were a tenth of it. Exports write it out.
 */
export function bindingKeyOf(visual, field) {
  return keys.binding(visual.key, field.kind, field.table, field.name);
}

/** Split a ref back into its parts. Returns null when it is not a ref. */
export function parseRef(ref) {
  const match = /^(table|column|measure|visual|page|source):(.*)$/s.exec(ref || '');
  if (!match) return null;

  const [, kind, rest] = match;
  if (kind === 'column' || kind === 'measure') {
    // Non-greedy on the table so the first `[` splits: a name may contain brackets,
    // a table name may not.
    const m = /^(.*?)\[(.*)\]$/s.exec(rest);
    return m ? { kind, table: m[1], name: m[2] } : { kind, table: null, name: rest };
  }
  if (kind === 'visual') {
    const idx = rest.indexOf('/');
    return idx === -1
      ? { kind, page: null, name: rest }
      : { kind, page: rest.slice(0, idx), name: rest.slice(idx + 1) };
  }
  return { kind, name: rest };
}

/**
 * Flatten an analysis result into the viewer payload.
 *
 * @param {object} analysis - Output of analyze() / analyzeFromFiles().
 * @param {object} [meta] - `{ modelName, reportName, generatedAt, projectPath }`
 * @returns {object} JSON-serializable viewer model.
 */
export function toViewerModel(analysis, meta = {}) {
  const {
    model, report, graph, stats, sourceNames, dataSources, bookmarks,
    enrichments, fieldParameters, fieldParameterGaps,
  } = analysis;

  // What the report is called in keys. A folder name is the only identity a PBIR report
  // carries that is stable across runs and unique within a workspace.
  // An explicit null means "no report" — a model analysed on its own.
  const reportKey = meta.reportKey !== undefined
    ? meta.reportKey
    : meta.reportName ?? meta.modelName ?? 'report';
  const modelKey = meta.modelKey ?? meta.modelName ?? null;

  const tables = buildTables(model, sourceNames, enrichments, fieldParameters, fieldParameterGaps);
  const columns = buildColumns(model, sourceNames);
  const measures = buildMeasures(model, graph);
  const visuals = buildVisuals(report, enrichments, reportKey);
  const pages = buildPages(report, visuals, reportKey);
  const sources = buildSources(dataSources);
  const relationships = buildRelationships(model);

  linkMeasureUsage(measures, visuals);
  linkCalculationGroups(measures, visuals);
  linkReferences(measures, columns);

  return {
    version: VIEWER_MODEL_VERSION,
    meta: {
      modelName: meta.modelName ?? null,
      reportName: meta.reportName ?? null,
      reportKey,
      modelKey,
      projectPath: meta.projectPath ?? null,
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
      generator: 'PBI Lineage Lenz',
    },
    stats: {
      ...stats,
      confidence: sourceNames?.stats ?? null,
    },
    tables,
    columns,
    measures,
    relationships,
    visuals,
    pages,
    sources,
    bookmarks: (bookmarks || []).map((b) => ({ id: b.id, name: b.name })),
    // Measures the report defines for itself, in `reportExtensions.json`. Kept apart from
    // `measures` because they are not in the semantic model — but a visual referencing one
    // is referencing something real, and anything checking for dangling references has to
    // know that before it accuses a live measure of being deleted.
    reportMeasures: (report?.reportMeasures || []).map((m) => ({ table: m.table, name: m.name })),
  };
}

function buildTables(model, sourceNames, enrichments, fieldParameters, fieldParameterGaps) {
  // Keyed by table name. Both come from `analyze()`, so the viewer says exactly what the
  // visual expansion and the source resolver already acted on.
  const calcGroups = new Map(
    (enrichments?.calculationGroups || []).map((cg) => [cg.tableName, cg]));
  const offers = fieldParameters instanceof Map
    ? fieldParameters
    : new Map(Object.entries(fieldParameters || {}));

  const gaps = fieldParameterGaps instanceof Map ? fieldParameterGaps : new Map();

  return (model?.tables || []).map((table) => {
    const resolved = sourceNames?.tables?.get(table.name);
    const calcGroup = calcGroups.get(table.name);
    const offered = offers.get(table.name);

    const kind = calcGroup
      ? TABLE_KIND.CALCULATION_GROUP
      // A parameter whose every NAMEOF target is gone is still a parameter.
      : offered || gaps.has(table.name)
        ? TABLE_KIND.FIELD_PARAMETER
        : TABLE_KIND.TABLE;

    return {
      ref: refs.table(table.name),
      name: table.name,
      kind,
      // A calculation group's items, with the DAX that rewrites the selected measure.
      // This is the whole content of such a table and it was not in the payload at all.
      calculationItems: (calcGroup?.items || []).map((item) => ({
        name: item.name,
        expression: item.expression ?? null,
      })),
      // What a field parameter offers, resolved against the model: the fields a slicer can
      // put on a visual that binds it. Refs so they link like anything else.
      offers: (offered || []).map((entry) => ({
        kind: entry.type,
        table: entry.table,
        name: entry.name,
        ref: entry.type === 'measure'
          ? refs.measure(entry.table, entry.name)
          : refs.column(entry.table, entry.name),
      })),
      // Fields a parameter's NAMEOF list names that the model does not contain — a slicer
      // entry that renders nothing and says nothing.
      offersMissing: (gaps.get(table.name) || []).map((target) => ({
        table: target.table ?? null,
        name: target.name,
      })),
      isCalculated: !!table.isCalculated,
      isHidden: !!table.isHidden,
      physicalPath: resolved?.physicalPath ?? null,
      physical: resolved?.physical ?? null,
      // Steps are the M pipeline a data engineer reads to see what happened to the data.
      steps: (resolved?.steps || []).map((s) => ({ name: s.name, kind: s.kind, expr: s.exprText })),
      renames: resolved?.renames ?? [],
      joins: resolved?.joins ?? [],
      columnCount: (table.columns || []).length,
      measureCount: (table.measures || []).length,
    };
  });
}

function buildColumns(model, sourceNames) {
  const out = [];
  for (const table of model?.tables || []) {
    const seen = new Set();
    const all = [...(table.columns || []), ...(table.calculatedColumns || [])];

    for (const column of all) {
      if (seen.has(column.name)) continue;
      seen.add(column.name);

      const resolved = sourceNames?.columns?.get(`${table.name}[${column.name}]`);
      out.push({
        ref: refs.column(table.name, column.name),
        table: table.name,
        name: column.name,
        dataType: column.dataType ?? null,
        isHidden: !!column.isHidden,
        expression: column.expression ?? null,
        pqName: resolved?.pqName ?? null,
        physicalPath: resolved?.physicalPath ?? null,
        physical: resolved?.physical ?? null,
        origin: resolved?.origin ?? null,
        confidence: resolved?.confidence ?? null,
        reason: resolved?.reason ?? null,
        // Why there is no physical source, when there is none: field-parameter,
        // calculation-group, calculated-column, computed-in-m, or unresolved. Only
        // `unresolved` is a gap; the rest are facts about the model.
        sourceless: resolved?.sourceless ?? (resolved ? null : 'unresolved'),
        // What a calculated column's DAX reads, so a trace can continue through it to the
        // columns underneath rather than stopping at a column with no source.
        dependsOn: column.expression ? daxDependsOn(column.daxDeps, table.name) : null,
        // Further physical columns the same values also come from — a calculated table
        // built with UNION draws one column from several facts, and DAX records only the
        // first. `physicalPath` is not wrong there, it is just not the whole answer, and
        // someone deciding whether a change is safe needs the rest.
        alsoFrom: resolved?.alsoFrom ?? [],
      });
    }
  }
  return out;
}

function buildMeasures(model, graph) {
  const out = [];
  for (const table of model?.tables || []) {
    for (const measure of table.measures || []) {
      const deps = measure.daxDeps || {};
      const node = graph?.nodes?.get(`measure::${table.name}.${measure.name}`);

      out.push({
        ref: refs.measure(table.name, measure.name),
        table: table.name,
        name: measure.name,
        expression: measure.expression ?? null,
        formatString: measure.formatString ?? null,
        description: measure.description ?? null,
        isHidden: !!measure.isHidden,
        // Enrichment metadata marks field parameters and calculation groups, which
        // read as ordinary measures until you know what they are.
        enrichmentType: node?.metadata?.enrichmentType ?? null,
        badge: node?.metadata?.badge ?? null,
        fieldParameter: node?.metadata?.fieldParameter ?? null,
        dependsOn: daxDependsOn(deps, table.name),
        usedByVisuals: [],
      });
    }
  }
  return out;
}

/** A DAX expression's references, as `Table[Name]` strings. */
function daxDependsOn(deps = {}, tableName) {
  return {
    measures: (deps.measureRefs || []).map((m) =>
      typeof m === 'string' ? m : `${m.table ?? tableName}[${m.measure ?? m.name}]`
    ),
    columns: (deps.columnRefs || []).map((c) => `${c.table}[${c.column}]`),
    tables: deps.tableRefs || [],
  };
}

function buildVisuals(report, enrichments, reportKey) {
  const calcGroupNames = new Set(
    (enrichments?.calculationGroups || []).map((cg) => cg.tableName));

  return (report?.visuals || []).map((visual) => {
    const pageId = visual.pageId ?? visual.page ?? null;
    const visualKey = keys.visual(reportKey, pageId, visual.id);
    return {
      ref: refs.visual(pageId, visual.id),
      key: visualKey,
      id: visual.id,
      page: pageId,
      type: visual.visualType ?? visual.type ?? null,
      title: visual.title ?? null,
      position: visual.position ?? null,
      // role labels and sorts; it is never used to drop a visual from a view.
      role: visual.role ?? null,
      boundFields: visual.boundFields ?? 0,
      isHidden: !!visual.isHidden,
      // Hidden alone is not an answer: a button usually brings the visual back, and
      // saying which named state does that is the difference between "hidden" and "dead".
      revealedBy: visual.revealedBy ?? [],
      neverShown: !!visual.neverShown,
      parentGroup: visual.parentGroupName ?? null,
      // Calculation groups this visual binds. A visual that does changes what every measure
      // on it evaluates to, and no amount of reading the measure's DAX reveals that — the
      // rewrite lives in the group's calculation item, on a different table entirely.
      appliesCalculationGroups: [...new Set(
        (visual.fields || []).map((f) => f.table).filter((t) => calcGroupNames.has(t)))],
      fields: (visual.fields || []).map((f) => ({
        kind: f.type,
        table: f.table ?? null,
        name: f.measure ?? f.column ?? null,
        // The data role the field sits in (Values, Category, …), when the report says.
        role: f.role || null,
        // The field parameter that offers this field, for `via: 'parameter'`.
        viaParameter: f.viaParameter ?? null,
        // Which Power BI feature reaches this field: plotted, a text box's dynamic value,
        // a dynamic title, a filter, a link, or conditional formatting. "Shown in (7)" is
        // only useful if it can say how each of the seven shows it.
        via: f.via ?? null,
        ref:
          f.type === 'measure' && f.table && f.measure
            ? refs.measure(f.table, f.measure)
            : f.type === 'column' && f.table && f.column
              ? refs.column(f.table, f.column)
              : null,
      })),
    };
  });
}

function buildPages(report, visuals, reportKey) {
  const counts = new Map();
  for (const visual of visuals) {
    counts.set(visual.page, (counts.get(visual.page) || 0) + 1);
  }
  return (report?.pages || []).map((page) => ({
    ref: refs.page(page.id),
    key: keys.page(reportKey, page.id),
    id: page.id,
    name: page.displayName ?? page.name ?? page.id,
    order: page.order ?? 0,
    width: page.width ?? null,
    height: page.height ?? null,
    visualCount: counts.get(page.id) || 0,
  }));
}

function buildSources(dataSources) {
  return (dataSources || []).map((source) => {
    const key = [source.type, source.server, source.database, source.url, source.path]
      .filter(Boolean)
      .join('|');
    return {
      ref: refs.source(key),
      type: source.type ?? null,
      server: source.serverResolved ?? source.server ?? null,
      database: source.databaseResolved ?? source.database ?? null,
      url: source.url ?? null,
      path: source.path ?? null,
      parameterized: !!source.parameterized,
      gatewayRequired: source.gatewayRequired ?? null,
      nativeQuery: source.nativeQuery ?? null,
      isNativeQuery: !!source.isNativeQuery,
    };
  });
}

function buildRelationships(model) {
  return (model?.relationships || []).map((rel) => ({
    name: rel.name ?? null,
    fromTable: rel.fromTable,
    fromColumn: rel.fromColumn,
    toTable: rel.toTable,
    toColumn: rel.toColumn,
    crossFilter: rel.crossFilter ?? null,
    isActive: rel.isActive !== false,
  }));
}

/**
 * Record which visuals consume each measure.
 *
 * Answering "is this measure used anywhere?" is the question that decides whether a
 * change is safe, so it is resolved once here rather than scanned per render.
 */
function linkMeasureUsage(measures, visuals) {
  const byRef = new Map(measures.map((m) => [m.ref, m]));
  for (const visual of visuals) {
    for (const field of visual.fields) {
      if (field.kind !== 'measure' || !field.ref) continue;
      byRef.get(field.ref)?.usedByVisuals.push(visual.ref);
    }
  }
}

/**
 * Record where a measure is shown under a calculation group.
 *
 * The question this answers is "is the number on the page the number my DAX computes?",
 * and for a measure on a visual that binds a calculation group the answer is *no* — the
 * group's calculation item wraps it, and nothing in the measure's own definition says so.
 * Someone editing that measure and checking the visual would be reading a different
 * expression than the one they changed.
 *
 * Only visuals that plot the measure count. A measure that merely filters such a visual
 * is not the measure the group is rewriting.
 */
function linkCalculationGroups(measures, visuals) {
  const byRef = new Map(measures.map((m) => [m.ref, m]));
  for (const measure of measures) measure.underCalculationGroups = [];

  for (const visual of visuals) {
    if (visual.appliesCalculationGroups.length === 0) continue;
    for (const field of visual.fields) {
      if (field.kind !== 'measure' || !field.ref) continue;
      const measure = byRef.get(field.ref);
      if (!measure) continue;
      for (const group of visual.appliesCalculationGroups) {
        if (!measure.underCalculationGroups.includes(group)) {
          measure.underCalculationGroups.push(group);
        }
      }
    }
  }
}

/** How far, and how much, a measure's reference chain is expanded. */
export const REFERENCE_LIMITS = Object.freeze({ maxDepth: 6, maxChars: 8000 });

/**
 * Lookups for resolving `Table[Name]` dependency strings, from any list of measures and
 * columns carrying a `ref`.
 */
export function dependencyLookup(items) {
  const byRef = new Map();
  const byFoldedRef = new Map();
  const byName = new Map();
  for (const item of items) {
    if (!item?.ref) continue;
    byRef.set(item.ref, item);
    const folded = item.ref.toLowerCase();
    if (!byFoldedRef.has(folded)) byFoldedRef.set(folded, item);
    if (item.ref.startsWith('measure:')) {
      const name = item.name.toLowerCase();
      if (!byName.has(name)) byName.set(name, item);
    }
  }
  return { byRef, byFoldedRef, byName };
}

/**
 * Find the model object a `Table[Name]` dependency string names.
 *
 * DAX is case-insensitive and authors are not consistent: a measure defined as
 * `Orders with Target not Met` is referenced as `[Orders with Target Not Met]`, and Power
 * BI resolves it. An exact-case lookup silently dropped such a reference — and with it
 * every column underneath, from traces, reference chains and reverse impact alike.
 *
 * DAX also lets a measure be referenced without its table, and the parser records such a
 * reference against the table doing the referencing, so the qualified lookup is tried
 * first and the bare name second.
 *
 * @param {'measure'|'column'} kind
 * @param {string} dependency - `Table[Name]`.
 * @param {{byRef: Map, byFoldedRef: Map, byName: Map}} lookup - dependencyLookup() output.
 */
export function resolveDependency(kind, dependency, lookup) {
  const ref = `${kind}:${dependency}`;
  const found = lookup.byRef.get(ref) ?? lookup.byFoldedRef?.get(ref.toLowerCase());
  if (found) return found;
  if (kind !== 'measure') return null;
  const bare = dependency.replace(/^.*?\[/, '').replace(/\]$/, '');
  return lookup.byName.get(bare.toLowerCase()) ?? null;
}

/**
 * Expand the measures and calculated columns a measure resolves through.
 *
 * A well-factored model is full of measures whose whole body is `[_Some Hidden Measure]`,
 * and documentation that prints that line has documented nothing: the business logic is in
 * the hidden measures below it. Those are hidden because the field list is a product
 * surface, so "unhide them" is a model change, not a documentation one — this reads
 * through them instead.
 *
 * Breadth-first, so the chain reads in resolution order top-down. Cycle-safe on the ref,
 * because circular references are invalid DAX that still turns up in drafts. Capped in
 * depth and in total expression length, because a calculation-group-heavy model can expand
 * one measure into something nobody would read. The root itself is excluded.
 *
 * The payload stores only `{ref, depth}` per entry: on a real model the expressions
 * inlined doubled the handoff file, and every one of them is already on the payload once.
 * describeReferences() puts them back for a reader or an export.
 *
 * @returns {{references: Array<{ref: string, depth: number}>, truncated: boolean}}
 */
export function expandReferences(measure, lookup, limits = REFERENCE_LIMITS) {
  const references = [];
  const seen = new Set([measure.ref]);
  const queue = [{ item: measure, depth: 0 }];
  let chars = 0;
  let truncated = false;

  while (queue.length > 0) {
    const { item, depth } = queue.shift();
    for (const next of dependenciesOf(item, lookup)) {
      if (seen.has(next.ref)) continue;
      seen.add(next.ref);

      if (depth + 1 > limits.maxDepth) { truncated = true; continue; }
      const length = (next.expression || '').length;
      if (chars + length > limits.maxChars) { truncated = true; queue.length = 0; break; }
      chars += length;

      references.push({ ref: next.ref, depth: depth + 1 });
      queue.push({ item: next, depth: depth + 1 });
    }
  }

  return { references, truncated };
}

/**
 * A measure's reference chain with each entry's kind, name, hidden flag and expression.
 * @param {object} measure - A viewer-model measure.
 * @param {object} index - Output of buildIndex().
 * @returns {Array<{kind: 'measure'|'column', ref: string, table: string, name: string,
 *   isHidden: boolean, expression: string|null, depth: number}>}
 */
export function describeReferences(measure, index) {
  return (measure?.references || []).map(({ ref, depth }) => {
    const item = index.byRef.get(ref);
    return {
      kind: ref.startsWith('column:') ? 'column' : 'measure',
      ref,
      table: item?.table ?? null,
      name: item?.name ?? null,
      isHidden: !!item?.isHidden,
      expression: item?.expression ?? null,
      depth,
    };
  });
}

/** The measures and calculated columns one measure or calculated column reads directly. */
function dependenciesOf(item, lookup) {
  const out = [];
  for (const dependency of item.dependsOn?.measures || []) {
    const found = resolveDependency('measure', dependency, lookup);
    if (found) out.push(found);
  }
  for (const dependency of item.dependsOn?.columns || []) {
    const found = resolveDependency('column', dependency, lookup);
    // Only calculated columns have something below them worth reading.
    if (found?.expression) out.push(found);
  }
  return out;
}

/**
 * Attach each measure's reference chain, and say when it reads no column at all.
 */
function linkReferences(measures, columns) {
  const lookup = dependencyLookup([...measures, ...columns]);

  for (const measure of measures) {
    const { references, truncated } = expandReferences(measure, lookup);
    measure.references = references;
    measure.referencesTruncated = truncated;
  }

  for (const measure of measures) {
    measure.sourceless = readsAnyColumn(measure, lookup) ? null : 'no-column-reference';
  }
}

/** Does anything in this measure's closure read a model column? */
function readsAnyColumn(measure, lookup) {
  const stack = [measure];
  const seen = new Set();
  while (stack.length > 0) {
    const item = stack.pop();
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    if ((item.dependsOn?.columns || []).length > 0) return true;
    for (const dependency of item.dependsOn?.measures || []) {
      const found = resolveDependency('measure', dependency, lookup);
      if (found) stack.push(found);
    }
  }
  return false;
}

/**
 * Build lookup indexes over a viewer model. Kept out of the payload — derived data
 * would only inflate the handoff file.
 * @param {object} viewerModel
 */
export function buildIndex(viewerModel) {
  const byRef = new Map();
  for (const key of ['tables', 'columns', 'measures', 'visuals', 'pages', 'sources']) {
    for (const item of viewerModel[key] || []) byRef.set(item.ref, { ...item, kind: key });
  }

  const columnsByTable = new Map();
  for (const column of viewerModel.columns || []) {
    if (!columnsByTable.has(column.table)) columnsByTable.set(column.table, []);
    columnsByTable.get(column.table).push(column);
  }

  const measuresByTable = new Map();
  for (const measure of viewerModel.measures || []) {
    if (!measuresByTable.has(measure.table)) measuresByTable.set(measure.table, []);
    measuresByTable.get(measure.table).push(measure);
  }

  const visualsByPage = new Map();
  for (const visual of viewerModel.visuals || []) {
    if (!visualsByPage.has(visual.page)) visualsByPage.set(visual.page, []);
    visualsByPage.get(visual.page).push(visual);
  }

  // Physical path -> model columns, so a data engineer can search by their own names.
  const byPhysicalPath = new Map();
  for (const column of viewerModel.columns || []) {
    if (!column.physicalPath) continue;
    const key = column.physicalPath.toLowerCase();
    if (!byPhysicalPath.has(key)) byPhysicalPath.set(key, []);
    byPhysicalPath.get(key).push(column);
  }

  const lookup = dependencyLookup([...(viewerModel.measures || []), ...(viewerModel.columns || [])]);

  return { byRef, columnsByTable, measuresByTable, visualsByPage, byPhysicalPath, lookup };
}

/**
 * Trace a measure to the physical columns behind it, following measure-to-measure chains
 * and calculated columns. Accepts a column ref too; see traceColumn().
 *
 * @param {string} measureRef
 * @param {object} viewerModel
 * @param {object} index - Output of buildIndex().
 * @returns {{chain: Array<object>, columns: Array<object>, unresolved: Array<object>}}
 *   `unresolved` holds columns whose physical origin is unknown — surfaced rather than
 *   dropped, so the gap is visible instead of silently absent.
 */
export function traceMeasure(measureRef, viewerModel, index) {
  const chain = [];
  const columns = [];
  const unresolved = [];
  const seen = new Set();

  const lookup = index.lookup
    ?? dependencyLookup([...(viewerModel.measures || []), ...(viewerModel.columns || [])]);
  const measureNamed = (dependency) => resolveDependency('measure', dependency, lookup);

  const visitMeasure = (ref, depth) => {
    if (seen.has(ref) || depth > 32) return;
    seen.add(ref);

    const measure = index.byRef.get(ref);
    if (!measure || measure.kind !== 'measures') return;

    chain.push({ ref, name: measure.name, table: measure.table, depth, expression: measure.expression });
    readDependencies(measure.dependsOn, depth);
  };

  const visitColumn = (ref, depth) => {
    if (seen.has(ref) || depth > 32) return;
    seen.add(ref);

    const column = index.byRef.get(ref);
    if (!column) return;

    // A calculated column has no source of its own; what it reads does. Following it is
    // the difference between "unresolved" and the columns that actually feed the number.
    if (column.expression && column.dependsOn) {
      readDependencies(column.dependsOn, depth);
      return;
    }
    (column.physicalPath ? columns : unresolved).push(column);
  };

  function readDependencies(dependsOn, depth) {
    for (const columnRef of dependsOn?.columns || []) {
      const column = resolveDependency('column', columnRef, lookup);
      visitColumn(column ? column.ref : `column:${columnRef}`, depth);
    }
    for (const name of dependsOn?.measures || []) {
      const target = measureNamed(name);
      if (target) visitMeasure(target.ref, depth + 1);
    }
  }

  if (String(measureRef).startsWith('column:')) visitColumn(measureRef, 0);
  else visitMeasure(measureRef, 0);
  return { chain, columns, unresolved };
}

/**
 * Trace a column to the physical columns behind it. A sourced column traces to itself; a
 * calculated column to whatever its DAX reads.
 * @returns {{chain: Array<object>, columns: Array<object>, unresolved: Array<object>}}
 */
export function traceColumn(columnRef, viewerModel, index) {
  return traceMeasure(columnRef, viewerModel, index);
}
