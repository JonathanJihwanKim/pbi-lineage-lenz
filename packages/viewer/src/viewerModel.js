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
export const VIEWER_MODEL_VERSION = 2;

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
    enrichments, fieldParameters,
  } = analysis;

  const tables = buildTables(model, sourceNames, enrichments, fieldParameters);
  const columns = buildColumns(model, sourceNames);
  const measures = buildMeasures(model, graph);
  const visuals = buildVisuals(report, enrichments);
  const pages = buildPages(report, visuals);
  const sources = buildSources(dataSources);
  const relationships = buildRelationships(model);

  linkMeasureUsage(measures, visuals);
  linkCalculationGroups(measures, visuals);

  return {
    version: VIEWER_MODEL_VERSION,
    meta: {
      modelName: meta.modelName ?? null,
      reportName: meta.reportName ?? null,
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

function buildTables(model, sourceNames, enrichments, fieldParameters) {
  // Keyed by table name. Both come from `analyze()`, so the viewer says exactly what the
  // visual expansion and the source resolver already acted on.
  const calcGroups = new Map(
    (enrichments?.calculationGroups || []).map((cg) => [cg.tableName, cg]));
  const offers = fieldParameters instanceof Map
    ? fieldParameters
    : new Map(Object.entries(fieldParameters || {}));

  return (model?.tables || []).map((table) => {
    const resolved = sourceNames?.tables?.get(table.name);
    const calcGroup = calcGroups.get(table.name);
    const offered = offers.get(table.name);

    const kind = calcGroup
      ? TABLE_KIND.CALCULATION_GROUP
      : offered
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
        dependsOn: {
          measures: (deps.measureRefs || []).map((m) =>
            typeof m === 'string' ? m : `${m.table ?? table.name}[${m.measure ?? m.name}]`
          ),
          columns: (deps.columnRefs || []).map((c) => `${c.table}[${c.column}]`),
          tables: deps.tableRefs || [],
        },
        usedByVisuals: [],
      });
    }
  }
  return out;
}

function buildVisuals(report, enrichments) {
  const calcGroupNames = new Set(
    (enrichments?.calculationGroups || []).map((cg) => cg.tableName));

  return (report?.visuals || []).map((visual) => ({
    ref: refs.visual(visual.pageId ?? visual.page, visual.id),
    id: visual.id,
    page: visual.pageId ?? visual.page ?? null,
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
  }));
}

function buildPages(report, visuals) {
  const counts = new Map();
  for (const visual of visuals) {
    counts.set(visual.page, (counts.get(visual.page) || 0) + 1);
  }
  return (report?.pages || []).map((page) => ({
    ref: refs.page(page.id),
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

  return { byRef, columnsByTable, measuresByTable, visualsByPage, byPhysicalPath };
}

/**
 * Trace a measure to the physical columns behind it, following measure-to-measure chains.
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
  const columnRefs = new Set();
  const seen = new Set();

  const walk = (ref, depth) => {
    if (seen.has(ref) || depth > 32) return;
    seen.add(ref);

    const measure = index.byRef.get(ref);
    if (!measure || measure.kind !== 'measures') return;

    chain.push({ ref, name: measure.name, table: measure.table, depth, expression: measure.expression });

    for (const columnRef of measure.dependsOn.columns) columnRefs.add(`column:${columnRef}`);
    for (const childName of measure.dependsOn.measures) {
      // DAX measure references may or may not carry a table qualifier.
      const direct = `measure:${childName}`;
      if (index.byRef.has(direct)) {
        walk(direct, depth + 1);
        continue;
      }
      const bare = childName.replace(/^.*\[|\]$/g, '');
      const match = (viewerModel.measures || []).find((m) => m.name === bare);
      if (match) walk(match.ref, depth + 1);
    }
  };

  walk(measureRef, 0);

  const columns = [];
  const unresolved = [];
  for (const ref of columnRefs) {
    const column = index.byRef.get(ref);
    if (!column) continue;
    (column.physicalPath ? columns : unresolved).push(column);
  }

  return { chain, columns, unresolved };
}
