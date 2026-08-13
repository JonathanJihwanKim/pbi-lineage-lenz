/**
 * Source name resolver — the data-engineer <-> BI-developer bridge.
 *
 * Answers "which physical column is this model column?" by walking the rename chain
 * backwards: physical source column -> Power Query name -> model column name.
 *
 * The resolver is deliberately honest about what it does not know. Every result carries
 * a `confidence`, and a column whose physical origin cannot be established resolves to
 * `unknown` rather than to a plausible guess. A lineage tool that quietly guesses is
 * worse than one that admits the gap — a data engineer who finds one wrong mapping
 * stops trusting all of them.
 */

import {
  extractDataSources,
  extractLineageResolvingRef,
  extractSqlTableRefs,
  collectExpressionBodies,
  collectDeclaredParams,
  extractSharedExpressionRef,
  resolveParameters,
  parseMSteps,
  partitionMExpr,
  collectParamValues,
  extractSqlTablePath,
  stepAffectsColumnNames,
} from '../parser/mquery.js';

/**
 * How much to trust the `physical` mapping on a resolved column.
 *
 * - `exact`    — the mapping is stated in the model. An explicit `Table.RenameColumns`
 *                pair, an explicit projection, or an explicit native-SQL select list.
 *                Also used for computed columns, where "it has no physical source" is
 *                itself an exact answer.
 * - `inferred` — the physical table is known and the column passes through unrenamed,
 *                so the source column name is assumed to equal the model column name.
 *                Usually right, but it is an assumption, not a statement.
 * - `unknown`  — no physical origin could be established. `physical` is null.
 */
export const CONFIDENCE = Object.freeze({
  EXACT: 'exact',
  INFERRED: 'inferred',
  UNKNOWN: 'unknown',
});

/** Where a model column's values come from. */
export const ORIGIN = Object.freeze({
  /** Read from a physical source system. */
  SOURCE: 'source',
  /** Computed in Power Query via Table.AddColumn. */
  COMPUTED_PQ: 'computed-pq',
  /** Computed in the model by a DAX calculated column. */
  COMPUTED_DAX: 'computed-dax',
  /** Physical origin could not be established. */
  UNRESOLVED: 'unresolved',
});

/**
 * Parse a SQL SELECT list into output columns.
 *
 * @param {string} sql
 * @returns {{ star: boolean, columns: Array<{expr: string, alias: string|null, name: string}> }|null}
 *   `star: true` means the output column set is not knowable from the query text.
 *   Returns null when no SELECT clause is found.
 */
export function parseSqlSelectList(sql) {
  if (!sql) return null;

  // Unescape the M string literal, then flatten whitespace.
  const text = sql.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\s+/g, ' ');

  const selectMatch = /\bSELECT\b\s+(?:DISTINCT\s+|ALL\s+)?(?:TOP\s+\d+\s+)?/i.exec(text);
  if (!selectMatch) return null;

  const afterSelect = text.slice(selectMatch.index + selectMatch[0].length);

  // Find the FROM that closes this select list, ignoring any inside subqueries.
  let depth = 0;
  let end = afterSelect.length;
  for (let i = 0; i < afterSelect.length; i++) {
    const ch = afterSelect[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch) && /^\sFROM\s/i.test(afterSelect.slice(i, i + 6))) {
      end = i;
      break;
    }
  }
  const selectList = afterSelect.slice(0, end).trim();
  if (!selectList) return null;

  // A bare `*` or a qualified `t.*` makes the output set unknowable.
  if (/(^|,)\s*(?:[\w$]+\s*\.\s*)?\*\s*(,|$)/.test(selectList)) {
    return { star: true, columns: [] };
  }

  const columns = [];
  for (const item of splitTopLevel(selectList)) {
    const expr = item.trim();
    if (!expr) continue;

    // Explicit alias: `expr AS alias` or `expr alias`.
    const asMatch = /^(.*?)\s+AS\s+([`"[]?[\w$]+[`"\]]?)$/is.exec(expr);
    let alias = null;
    let body = expr;
    if (asMatch) {
      body = asMatch[1].trim();
      alias = unquoteSqlIdent(asMatch[2]);
    } else {
      const bareAlias = /^(.*[^\s.,(])\s+([`"[]?[\w$]+[`"\]]?)$/s.exec(expr);
      // Only treat a trailing token as an alias when the left side is a complete expression.
      if (bareAlias && !/\b(?:AND|OR|NOT|IS|IN|LIKE|BETWEEN)\s*$/i.test(bareAlias[1])) {
        body = bareAlias[1].trim();
        alias = unquoteSqlIdent(bareAlias[2]);
      }
    }

    // Output name is the alias, else the last segment of a qualified column reference.
    let name = alias;
    if (!name) {
      const colRef = /^[\w$`"[\].\s]+$/.test(body) ? body.split('.').pop() : null;
      name = colRef ? unquoteSqlIdent(colRef.trim()) : null;
    }
    if (!name) continue;

    columns.push({ expr: body, alias, name });
  }

  return { star: false, columns };
}

/** Split on commas that sit outside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function unquoteSqlIdent(ident) {
  return ident.replace(/^[`"[]|[`"\]]$/g, '').trim();
}

/**
 * Build the physical identity of a table: which system, and which object in it.
 *
 * @returns {{system: string|null, server: string|null, database: string|null,
 *   schema: string|null, table: string|null, dataset: string|null, project: string|null,
 *   nativeQuery: string|null, isNativeQuery: boolean, path: string|null, url: string|null}|null}
 */
function buildPhysicalTable(lineage, sources) {
  const primary = sources.find((s) => !s.isInline) || sources[0] || null;
  if (!primary && !lineage?.physicalTable) return null;

  return {
    system: primary?.type ?? null,
    server: primary?.serverResolved ?? primary?.server ?? null,
    database: primary?.databaseResolved ?? primary?.database ?? null,
    url: primary?.url ?? null,
    path: primary?.path ?? null,
    schema: lineage?.physicalSchema ?? null,
    table: lineage?.physicalTable ?? null,
    dataset: lineage?.physicalDataset ?? null,
    project: lineage?.physicalProject ?? null,
    nativeQuery: primary?.nativeQuery ?? null,
    isNativeQuery: !!primary?.isNativeQuery,
  };
}

/**
 * Dotted path for a physical table, most-qualified first.
 * e.g. `sales_dw.dbo.FactSales`, `acme-analytics.sales_mart.fact_orders`
 * @param {object|null} physical
 * @returns {string|null}
 */
export function formatPhysicalTablePath(physical) {
  if (!physical) return null;
  const parts = [
    physical.project,
    physical.database,
    physical.dataset,
    physical.schema,
    physical.table,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('.') : null;
}

/**
 * Fully-qualified physical column path, or null when unresolved.
 * @param {object|null} physical
 * @returns {string|null}
 */
export function formatPhysicalColumnPath(physical) {
  if (!physical?.column) return null;
  const tablePath = formatPhysicalTablePath(physical);
  return tablePath ? `${tablePath}.${physical.column}` : physical.column;
}

/**
 * Resolve physical source names for every table and column in a parsed model.
 *
 * @param {object} parsedModel - Output of parseTmdlModel(), with `expressions` populated.
 * @returns {{
 *   tables: Map<string, object>,
 *   columns: Map<string, object>,
 *   stats: {total: number, exact: number, inferred: number, unknown: number, coverage: number}
 * }}
 *   `columns` is keyed by `Table[Column]`.
 */
export function resolveSourceNames(parsedModel) {
  const expressionBodies = collectExpressionBodies(parsedModel);
  const declaredParams = collectDeclaredParams(parsedModel);
  const paramValues = collectParamValues(parsedModel);
  const expressions = parsedModel?.expressions || [];
  const tableNames = new Set((parsedModel?.tables || []).map((t) => t.name));

  const tables = new Map();
  const columns = new Map();
  const derived = new Map();

  // The DAX behind each calculated table, kept so a column can be told when the
  // expression that built it reads from more than one place.
  const calculatedDax = new Map();

  for (const table of parsedModel?.tables || []) {
    const resolved = resolveTable(table, {
      expressionBodies, declaredParams, paramValues, expressions, tableNames,
    });
    tables.set(table.name, resolved.table);
    for (const col of resolved.columns) columns.set(col.modelRef, col);
    if (resolved.derivedFrom) derived.set(table.name, resolved.derivedFrom);

    const calculated = (table.partitions || [])
      .find((part) => (part.type || '').toLowerCase() === 'calculated');
    const body = calculated && (calculated.sourceExpression ?? calculated.source);
    if (body) calculatedDax.set(table.name, body);
  }

  linkDerivedColumns(columns, derived, calculatedDax);

  return { tables, columns, stats: summarize(columns) };
}

/** Resolve one table plus each of its columns. */
function resolveTable(table, ctx) {
  const { expressionBodies, declaredParams, paramValues, expressions, tableNames } = ctx;

  // Prefer refreshPolicy.sourceExpression (incremental refresh), else the first partition.
  // A Direct Lake table names its physical object in the partition itself, with no query
  // to walk and no step that could rename anything. It is the most certain shape there is,
  // and it short-circuits everything below.
  const directLake = directLakeTable(table, ctx);
  if (directLake) return resolveDirectLakeTable(table, directLake);

  const mExpr =
    table.refreshPolicy?.sourceExpression ||
    (table.partitions || []).map(partitionMExpr).find(Boolean) ||
    null;

  const lineage = mExpr ? extractLineageResolvingRef(mExpr, expressionBodies, new Set(), paramValues) : null;

  // Connectors may live in the partition itself or in the shared expression it delegates to.
  let sources = mExpr ? extractDataSources(mExpr, declaredParams, paramValues) : [];
  if (sources.length === 0 && mExpr) {
    const refName = extractSharedExpressionRef(mExpr);
    const refBody = refName && expressionBodies[refName];
    if (refBody) sources = extractDataSources(refBody, declaredParams, paramValues);
  }
  sources = resolveParameters(sources, expressions);

  const physicalTable = buildPhysicalTable(lineage, sources);
  const steps = mExpr ? parseMSteps(mExpr, expressionBodies) : [];

  // A partition may read another *table* in this model rather than a physical source.
  // That reference is followable, so the chain does not end here even though this table
  // has no connector of its own.
  const upstreamTable = findUpstreamTable(steps, expressionBodies, tableNames, table.name);

  // Source column name -> Power Query name, and its inverse.
  const renamesByModelName = new Map();
  for (const { sourceName, modelName } of lineage?.renames || []) {
    renamesByModelName.set(modelName, sourceName);
  }

  const addedInPq = new Set(lineage?.addedColumns || []);
  const projection = lineage?.selectedColumns || null;

  // Columns that arrived through a join. Their physical home is the joined table, so
  // each is resolved against that table rather than this one — attributing them here
  // produces a confident path to a column that does not exist in it.
  const expandedColumns = resolveExpandedColumns(lineage, ctx);

  // A native query's select list is the authoritative output column set.
  const nativeSelect = physicalTable?.nativeQuery ? parseSqlSelectList(physicalTable.nativeQuery) : null;
  const nativeColumnNames = nativeSelect && !nativeSelect.star
    ? new Set(nativeSelect.columns.map((c) => c.name))
    : null;
  const nativeIsStar = !!nativeSelect?.star;

  // Under a native query the SQL, not M navigation, names the physical object.
  if (physicalTable?.isNativeQuery && !physicalTable.table) {
    const path = extractSqlTablePath(physicalTable.nativeQuery);
    if (path?.table) {
      physicalTable.table = path.table;
      // A BigQuery `project.dataset.table` carries its own qualification; prefer it over
      // the connector-level billing project already sitting in `server`.
      if (path.dataset && !physicalTable.schema) physicalTable.schema = path.dataset;
      if (path.project && !physicalTable.project) physicalTable.project = path.project;
    } else {
      const sqlTables = extractSqlTableRefs(physicalTable.nativeQuery);
      if (sqlTables.length === 1) physicalTable.table = sqlTables[0];
    }
  }

  const calculatedColumnNames = new Set((table.calculatedColumns || []).map((c) => c.name));
  const resolvedColumns = [];

  const allColumns = [
    ...(table.columns || []),
    ...(table.calculatedColumns || []).filter(
      (cc) => !(table.columns || []).some((c) => c.name === cc.name)
    ),
  ];

  for (const column of allColumns) {
    resolvedColumns.push(
      resolveColumn(column, {
        tableName: table.name,
        physicalTable,
        renamesByModelName,
        addedInPq,
        projection,
        expandedColumns,
        nameChainIntact: isNameChainIntact(steps, upstreamTable),
        nativeColumnNames,
        nativeIsStar,
        isCalculated: calculatedColumnNames.has(column.name),
        hasM: !!mExpr,
      })
    );
  }

  return {
    // Everything a second pass needs to follow this table's columns into the table it
    // reads from, once that one has been resolved.
    derivedFrom: upstreamTable
      ? {
        upstream: upstreamTable,
        renamesByModelName,
        projection,
        hopIsDeducible: isNameChainIntact(steps, upstreamTable),
      }
      : null,
    table: {
      name: table.name,
      physical: physicalTable,
      physicalPath: formatPhysicalTablePath(physicalTable),
      sources,
      steps,
      renames: lineage?.renames || [],
      joins: lineage?.joins || [],
      addedColumns: lineage?.addedColumns || [],
      selectedColumns: projection,
      isCalculatedTable: !!table.isCalculated,
    },
    columns: resolvedColumns,
  };
}

/**
 * The physical object behind a Direct Lake partition, or null if this is not one.
 *
 * Direct Lake reads Delta tables in OneLake with no Power Query in between, so a partition
 * says outright what an import table's M chain has to be walked to discover:
 *
 *   partition sales = entity
 *     mode: directLake
 *     source
 *       entityName: sales
 *       schemaName: dbo
 *       expressionSource: 'DirectLake - Lakehouse_Contoso'
 *
 * That is a stated three-part path, and — because Direct Lake has no transformation step
 * at all — every column of it passes through under the source's own name. Nothing is
 * deduced and nothing is assumed.
 *
 * Before this, `= entity` matched no branch: the main fact table of a Direct Lake model
 * resolved to nothing while its four dimensions, which happened to be imported through M,
 * resolved perfectly. Direct Lake is Microsoft's default for new Fabric models, so the
 * gap fell on exactly the tables people are building now.
 *
 * @returns {{schema: string|null, table: string, lakehouse: string|null, via: string|null}|null}
 */
function directLakeTable(table, ctx) {
  const partition = (table?.partitions || []).find(
    (part) => part?.entityName && ((part.type || '').toLowerCase() === 'entity'
      || (part.mode || '').toLowerCase() === 'directlake'));
  if (!partition) return null;

  return {
    schema: partition.schemaName ?? null,
    table: partition.entityName,
    lakehouse: lakehouseOf(partition.expressionSource, ctx),
    via: partition.expressionSource ?? null,
  };
}

/**
 * The lakehouse a Direct Lake expression points at.
 *
 * The expression is `AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/
 * <workspaceId>/<itemId>", …)` — GUIDs, not names, so the URL cannot be turned into
 * anything a person would recognise. The expression's own name can: authors call it
 * `DirectLake - Lakehouse_Contoso`, and Power BI generates that form. Taking the readable
 * half of the name beats printing a GUID at a data engineer.
 */
function lakehouseOf(expressionSource, ctx) {
  if (!expressionSource) return null;
  const named = /^\s*DirectLake\s*-\s*(.+?)\s*$/i.exec(expressionSource);
  if (named) return named[1];
  return ctx?.expressionBodies?.[expressionSource] ? expressionSource : null;
}

/** Resolve every column of a Direct Lake table against its stated Delta table. */
function resolveDirectLakeTable(table, directLake) {
  const physical = {
    system: 'Fabric Lakehouse',
    server: null,
    database: directLake.lakehouse,
    url: null,
    path: null,
    schema: directLake.schema,
    table: directLake.table,
    dataset: null,
    project: null,
    nativeQuery: null,
    isNativeQuery: false,
  };

  const calculated = new Set((table.calculatedColumns || []).map((column) => column.name));
  const allColumns = [
    ...(table.columns || []),
    ...(table.calculatedColumns || []).filter(
      (extra) => !(table.columns || []).some((column) => column.name === extra.name)),
  ];

  const columns = allColumns.map((column) => {
    const modelRef = `${table.name}[${column.name}]`;
    const base = {
      modelRef,
      modelTable: table.name,
      modelColumn: column.name,
      dataType: column.dataType ?? null,
      pqName: column.sourceColumn || column.name,
      physical: null,
      physicalPath: null,
    };

    if (calculated.has(column.name)) {
      return {
        ...base,
        origin: ORIGIN.COMPUTED_DAX,
        confidence: CONFIDENCE.EXACT,
        reason: 'Calculated column defined in DAX; it has no physical source column.',
      };
    }

    const withColumn = { ...physical, column: base.pqName };
    return {
      ...base,
      physical: withColumn,
      physicalPath: formatPhysicalColumnPath(withColumn),
      origin: ORIGIN.SOURCE,
      confidence: CONFIDENCE.EXACT,
      reason: `Direct Lake: the partition reads ${formatPhysicalTablePath(physical)} `
        + 'directly, with no Power Query step that could rename a column.',
    };
  });

  return {
    derivedFrom: null,
    table: {
      name: table.name,
      physical,
      physicalPath: formatPhysicalTablePath(physical),
      sources: [{
        type: 'Fabric Lakehouse',
        database: directLake.lakehouse,
        isDirectLake: true,
        expression: directLake.via,
      }],
      steps: [],
      renames: [],
      joins: [],
      addedColumns: [],
      selectedColumns: null,
      isCalculatedTable: false,
    },
    columns,
  };
}

/**
 * Is there anything in this chain that could change what a column is called?
 *
 * The question is about names, not about categories. An earlier version of this asked
 * "is every step a kind the parser recognises?", which is a different and much blunter
 * question: `if DatasetFilter = 1 then #"Filter store_key" else Base` is not a
 * recognised category, but both of its arms are row filters and row filters do not touch
 * headers. That distinction alone accounted for 120 columns reported as assumed when
 * their names were determined.
 *
 * When nothing in the chain can rename a column, a column that no step renames cannot be
 * called something else at the source. That is a deduction from a complete chain, and it
 * deserves `exact` for the same reason an explicit rename pair does.
 *
 * Completeness is the premise, so this is only trustworthy because the step list is now
 * spliced across shared expressions. While `parseMSteps` substituted instead of splicing,
 * 20 of this model's 21 rename steps were invisible, and "no step renames it" was a claim
 * about what the parser had bothered to look at.
 */
function isNameChainIntact(steps, upstreamTable = null) {
  if (!steps || steps.length === 0) return false;

  // Splicing replaces any step that is a bare reference to a shared expression with that
  // expression's own steps. So a bare reference still standing here names something the
  // parser could not follow — another query, usually — and the chain beyond it is unseen.
  // Deducing "nothing renames this column" from a chain with an unread section in it is
  // the mistake this whole rule is one step away from.
  const stepNames = new Set(steps.map((step) => step.name));
  // A reference to another model table is followable too — that table is resolved in its
  // own right and linked up afterwards, so the chain continues rather than stopping.
  if (upstreamTable) stepNames.add(upstreamTable);

  return steps.every((step) => {
    const reference = /^(?:#"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))$/.exec((step.exprText || '').trim());
    // A reference to a sibling step is fine; that step is in this list and gets checked.
    if (reference) return stepNames.has(reference[1] ?? reference[2]);
    return !stepAffectsColumnNames(step.exprText);
  });
}

/** `Table[Column]` or `'Table'[Column]` split into its two halves, else null. */
function parseModelRef(text) {
  const match = /^'?([^'[\]]+?)'?\[([^\]]+)\]$/.exec((text || '').trim());
  return match ? { table: match[1], column: match[2] } : null;
}

/**
 * The model table a partition reads from, when it reads from one.
 *
 * `Source = #"Time Period"` inside a partition looks exactly like a shared-expression
 * reference, but `Time Period` is another table in this model. `parseMSteps` splices
 * across `expressions.tmdl` and finds nothing to splice here, so the reference survives
 * as a bare step and the chain reads as incomplete. That is why 15 columns of
 * `Stock and Transaction Date` reported `unknown` while the table they came from resolved
 * to `report_calendar.calendar_func_dim` in full.
 */
function findUpstreamTable(steps, expressionBodies, tableNames, ownName) {
  if (!tableNames || steps.length === 0) return null;
  for (const step of steps) {
    const reference = /^(?:#"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))$/.exec((step.exprText || '').trim());
    if (!reference) continue;
    const name = reference[1] ?? reference[2];
    // A shared expression of the same name wins; parseMSteps would already have spliced it.
    if (expressionBodies?.[name]) continue;
    if (name !== ownName && tableNames.has(name)) return name;
  }
  return null;
}

/** The weaker of two confidences — a chain is only as good as its worst link. */
function weakerConfidence(a, b) {
  if (a === CONFIDENCE.UNKNOWN || b === CONFIDENCE.UNKNOWN) return CONFIDENCE.UNKNOWN;
  if (a === CONFIDENCE.INFERRED || b === CONFIDENCE.INFERRED) return CONFIDENCE.INFERRED;
  return CONFIDENCE.EXACT;
}

/**
 * Follow columns of derived tables into the table they actually came from.
 *
 * The first pass resolves each table on its own, so a table whose source is another table
 * has nothing physical to point at and every one of its columns lands on `unknown`. That
 * is the chain stopping one hop early — the upstream table is right there in the same
 * model, already resolved. Two shapes reach it:
 *
 * - a calculated table, whose columns carry `sourceColumn: Other Table[Column]` and so
 *   state their own origin in the TMDL;
 * - an M partition whose `Source` is a bare reference to another table, after which the
 *   partition's own renames apply on top of the upstream mapping.
 */
function linkDerivedColumns(columns, derived, calculatedDax = new Map()) {
  if (derived.size === 0 && ![...columns.values()].some((c) => parseModelRef(c.pqName))) return;

  // Index the resolved Power Query name of every column, per table, so a derived column
  // can find its upstream twin by the name the upstream query produced.
  const byTableAndPqName = new Map();
  const index = () => {
    byTableAndPqName.clear();
    for (const col of columns.values()) {
      byTableAndPqName.set(pqKey(col.modelTable, col.pqName), col);
    }
  };

  // A derived table may read another derived table, so one pass is not enough. Bounded so
  // a circular reference terminates instead of spinning.
  for (let round = 0; round < 10; round++) {
    index();
    let changed = false;

    for (const [ref, col] of columns) {
      if (col.confidence !== CONFIDENCE.UNKNOWN || col.origin !== ORIGIN.UNRESOLVED) continue;
      const linked = linkColumn(col, columns, derived, byTableAndPqName, calculatedDax);
      if (linked) {
        columns.set(ref, linked);
        changed = true;
      }
    }

    if (!changed) return;
  }
}

/**
 * Index key for a table-and-column pair.
 *
 * Serialised rather than joined by a separator character: a plain delimiter has to be one
 * that cannot occur in either half, and Power BI names contain spaces, dots, brackets and
 * percent signs. `JSON.stringify` sidesteps the question, and unlike an invisible control
 * character it survives being read by a person.
 */
function pqKey(table, name) {
  return JSON.stringify([table, name]);
}

/** Resolve one derived column against its upstream twin, or null if it cannot be. */
function linkColumn(col, columns, derived, byTableAndPqName, calculatedDax = new Map()) {
  // 1. A calculated table's TMDL names the origin column outright:
  //    `sourceColumn: Store[Store Code]`. Nothing is deduced and nothing
  //    is assumed — the model states it.
  //
  //    TMDL names one origin even when the DAX combines several — `prmDeliveryWindow`
  //    is `UNION(DISTINCT(_orders_agg_fct[delivery_window]),
  //    DISTINCT(_orders_item_dtl_agg_fct[delivery_window]))`, and TMDL records the
  //    first, because that is DAX's own lineage rule. The path is real and the name is
  //    right; it is simply not the whole answer, so the rest are read out of the
  //    expression and reported beside it.
  const stated = parseModelRef(col.pqName);
  if (stated) {
    const upstream = columns.get(`${stated.table}[${stated.column}]`);
    if (!upstream || upstream.confidence === CONFIDENCE.UNKNOWN) return null;

    const also = otherSources(calculatedDax.get(col.modelTable), stated, columns);
    const linked = inheritFrom(col, upstream, upstream.confidence,
      `The model gives this calculated table's column as ${upstream.modelRef}`
      + `${also.length > 0
        ? `, and its expression also reads ${also.map((o) => o.modelRef).join(', ')}`
        : ''}. ${upstream.reason}`);

    // Named separately from `physicalPath` so nothing downstream has to guess whether a
    // path is the only one. A row that shows a single source when there are two is not
    // wrong, but a reader deciding whether a change is safe needs both.
    return also.length > 0
      ? { ...linked, alsoFrom: also.map((o) => o.physicalPath).filter(Boolean) }
      : linked;
  }

  // 2. The partition reads another table, so this table's own renames sit on top of the
  //    upstream mapping.
  const info = derived.get(col.modelTable);
  if (!info) return null;

  const renamedFrom = info.renamesByModelName.get(col.pqName);
  const upstreamName = renamedFrom ?? col.pqName;
  if (info.projection && !info.projection.includes(col.pqName) && !renamedFrom) return null;

  const upstream = byTableAndPqName.get(pqKey(info.upstream, upstreamName));
  if (!upstream || upstream.confidence === CONFIDENCE.UNKNOWN) return null;

  // The hop is stated when a rename pair names it, deduced when nothing in this
  // partition can rename anything, and an assumption otherwise.
  const hop = renamedFrom || info.hopIsDeducible ? CONFIDENCE.EXACT : CONFIDENCE.INFERRED;
  const how = renamedFrom
    ? `renamed "${renamedFrom}" -> "${col.pqName}"`
    : 'under the same name';

  return inheritFrom(col, upstream, weakerConfidence(hop, upstream.confidence),
    `Read from ${info.upstream} (${how}). ${upstream.reason}`);
}

/**
 * Other columns the same calculated expression reads under the same name.
 *
 * A calculated table built with `UNION`, `EXCEPT` or `INTERSECT` draws one column from
 * several places, and TMDL records only the first — DAX takes the lineage of the leading
 * argument. That first path is genuinely a source of the column, so it is not wrong to
 * show it; showing it *alone* is what leaves someone believing a change to the second
 * table cannot affect this column.
 *
 * Deliberately narrow. It matches references to a column of the same name in a different
 * table, which is the shape a set operation over parallel facts takes, and does not try
 * to evaluate the expression. Anything it cannot resolve is left out rather than guessed.
 *
 * @param {string|undefined} dax - The calculated table's expression.
 * @param {{table: string, column: string}} stated - The origin TMDL already named.
 * @param {Map<string, object>} columns - Every resolved column, keyed `Table[Column]`.
 * @returns {Array<object>} Resolved columns, excluding the one already reported.
 */
function otherSources(dax, stated, columns) {
  if (!dax) return [];

  const found = [];
  const seen = new Set([`${stated.table}[${stated.column}]`.toLowerCase()]);
  const wanted = stated.column.toLowerCase();
  const pattern = /(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]/g;

  let match;
  while ((match = pattern.exec(dax)) !== null) {
    const table = match[1] ?? match[2];
    const column = match[3];
    if (column.toLowerCase() !== wanted) continue;

    const ref = `${table}[${column}]`;
    if (seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());

    const resolved = columns.get(ref);
    if (resolved && resolved.confidence !== CONFIDENCE.UNKNOWN) found.push(resolved);
  }
  return found;
}
/** Adopt an upstream column's physical mapping, keeping this column's own identity. */
function inheritFrom(col, upstream, confidence, reason) {
  return {
    ...col,
    pqName: upstream.pqName,
    physical: upstream.physical ? { ...upstream.physical } : null,
    physicalPath: upstream.physicalPath,
    origin: upstream.origin,
    confidence,
    reason,
  };
}

/**
 * Map each column that arrived through a join to its real physical home.
 *
 * `Table.NestedJoin(…, other_src, …, "_NPM", …)` followed by
 * `Table.ExpandTableColumn(…, "_NPM", {"handover_date"}, {"Handover Date"})` states
 * two things outright: the column's source name, and that it belongs to `other_src` —
 * a different physical table, usually in a different dataset. Reading neither, the
 * resolver reported `Store[Handover Date]` as
 * `…store_cur_func_dim.Handover Date`, which is wrong in both halves and
 * confidently phrased. A data engineer would go looking for a column that does not exist
 * in a table that never had it.
 *
 * @returns {Map<string, {sourceName: string, physical: object|null, viaExpression: string}>}
 *   Keyed by the model-side column name.
 */
function resolveExpandedColumns(lineage, ctx) {
  const resolved = new Map();
  const expands = lineage?.expands || [];
  if (expands.length === 0) return resolved;

  // Which joined expression landed in each nested column.
  const sourceByColumn = new Map();
  for (const join of lineage?.joins || []) {
    if (join.type === 'NestedJoin' && join.intoColumn) sourceByColumn.set(join.intoColumn, join.rightStep);
  }

  const physicalCache = new Map();
  const physicalOf = (expressionName) => {
    if (physicalCache.has(expressionName)) return physicalCache.get(expressionName);
    const physical = resolveExpressionTable(expressionName, ctx);
    physicalCache.set(expressionName, physical);
    return physical;
  };

  for (const expand of expands) {
    const viaExpression = sourceByColumn.get(expand.intoColumn);
    resolved.set(expand.modelName, {
      sourceName: expand.sourceName,
      physical: viaExpression ? physicalOf(viaExpression) : null,
      viaExpression: viaExpression ?? expand.intoColumn,
    });
  }
  return resolved;
}

/** The physical table a shared expression resolves to, or null. */
function resolveExpressionTable(expressionName, ctx) {
  const { expressionBodies, declaredParams, paramValues, expressions } = ctx;
  const body = expressionBodies[expressionName];
  if (!body) return null;

  const lineage = extractLineageResolvingRef(body, expressionBodies, new Set(), paramValues);
  const sources = resolveParameters(extractDataSources(body, declaredParams, paramValues), expressions);
  const physical = buildPhysicalTable(lineage, sources);
  if (!physical) return null;

  // A native query names the physical object; the same resolution the table path does.
  if (physical.isNativeQuery && !physical.table) {
    const path = extractSqlTablePath(physical.nativeQuery);
    if (path?.table) {
      physical.table = path.table;
      if (path.dataset && !physical.schema) physical.schema = path.dataset;
      if (path.project && !physical.project) physical.project = path.project;
    }
  }
  return physical.table ? physical : null;
}

/** Resolve one column's origin, physical mapping, and confidence. */
function resolveColumn(column, ctx) {
  const {
    tableName, physicalTable, renamesByModelName, addedInPq, projection, expandedColumns,
    nameChainIntact, nativeColumnNames, nativeIsStar, isCalculated, hasM,
  } = ctx;

  const modelRef = `${tableName}[${column.name}]`;
  const base = {
    modelRef,
    modelTable: tableName,
    modelColumn: column.name,
    dataType: column.dataType ?? null,
    pqName: null,
    physical: null,
    physicalPath: null,
  };

  // A DAX calculated column has no physical source, and that is an exact answer.
  if (isCalculated) {
    return {
      ...base,
      origin: ORIGIN.COMPUTED_DAX,
      confidence: CONFIDENCE.EXACT,
      reason: 'Calculated column defined in DAX; it has no physical source column.',
    };
  }

  // `sourceColumn` in TMDL is the Power Query column name feeding this model column.
  const pqName = column.sourceColumn || column.name;

  // Added in Power Query — computed downstream of the source, so also exact.
  if (addedInPq.has(pqName) || addedInPq.has(column.name)) {
    return {
      ...base,
      pqName,
      origin: ORIGIN.COMPUTED_PQ,
      confidence: CONFIDENCE.EXACT,
      reason: 'Added in Power Query via Table.AddColumn; it has no physical source column.',
    };
  }

  // Arrived through a join. Checked before the base table is even required, because this
  // column's physical home is the joined table and the base table is irrelevant to it.
  const expanded = expandedColumns?.get(pqName) ?? expandedColumns?.get(column.name);
  if (expanded) {
    if (expanded.physical) {
      const physical = { ...expanded.physical, column: expanded.sourceName };
      return {
        ...base,
        pqName,
        physical,
        physicalPath: formatPhysicalColumnPath(physical),
        origin: ORIGIN.SOURCE,
        confidence: CONFIDENCE.EXACT,
        reason: `Joined in from ${formatPhysicalTablePath(expanded.physical)} and expanded`
          + `${expanded.sourceName === pqName ? '' : `: "${expanded.sourceName}" -> "${pqName}"`}.`,
      };
    }
    // The source name is stated even when the joined table cannot be resolved. Saying
    // so beats attributing the column to the table it was merged onto.
    return {
      ...base,
      pqName,
      origin: ORIGIN.UNRESOLVED,
      confidence: CONFIDENCE.UNKNOWN,
      reason: `Joined in as "${expanded.sourceName}" from ${expanded.viaExpression}, `
        + 'whose physical table could not be resolved.',
    };
  }

  // Without an M expression or a physical table there is nothing to map onto.
  if (!physicalTable?.table) {
    return {
      ...base,
      pqName,
      origin: ORIGIN.UNRESOLVED,
      confidence: CONFIDENCE.UNKNOWN,
      reason: hasM
        ? 'No physical table could be resolved from the Power Query expression.'
        : 'Table has no Power Query expression (calculated or pushed-down table).',
    };
  }

  const withPhysical = (column2, confidence, reason) => {
    const physical = { ...physicalTable, column: column2 };
    return {
      ...base,
      pqName,
      physical,
      physicalPath: formatPhysicalColumnPath(physical),
      origin: ORIGIN.SOURCE,
      confidence,
      reason,
    };
  };

  // 1. An explicit rename pair states the mapping outright.
  const renamedFrom = renamesByModelName.get(pqName) ?? renamesByModelName.get(column.name);
  if (renamedFrom) {
    return withPhysical(
      renamedFrom,
      CONFIDENCE.EXACT,
      `Renamed in Power Query: "${renamedFrom}" -> "${pqName}".`
    );
  }

  // 2. A native query with an explicit select list is authoritative.
  if (nativeColumnNames) {
    if (nativeColumnNames.has(pqName)) {
      return withPhysical(pqName, CONFIDENCE.EXACT, 'Named in the native SQL select list.');
    }
    return {
      ...base,
      pqName,
      origin: ORIGIN.UNRESOLVED,
      confidence: CONFIDENCE.UNKNOWN,
      reason: `"${pqName}" is not in the native SQL select list; it may be renamed downstream or computed.`,
    };
  }

  // 3. An explicit projection names the columns it keeps *out of the source*, so those
  //    names are the source's own. This has to outrank the SELECT * rule below: a query
  //    that selects everything and is then narrowed by `Table.SelectColumns({"longitude",
  //    …})` states the column names outright, and testing SELECT * first labelled 67
  //    columns "assumed to pass through" when the answer was in the M all along.
  if (projection) {
    if (projection.includes(pqName)) {
      return withPhysical(
        pqName,
        CONFIDENCE.EXACT,
        'Kept by an explicit Table.SelectColumns projection under the same name.'
      );
    }
    return {
      ...base,
      pqName,
      origin: ORIGIN.UNRESOLVED,
      confidence: CONFIDENCE.UNKNOWN,
      reason: `"${pqName}" is not in the Table.SelectColumns projection.`,
    };
  }

  // 4. SELECT * hides the column list but still names the table exactly. Reporting
  //    `unknown` here would throw away the physical table we do know, which is most of
  //    what a data engineer wants. The table is certain; only the column name is assumed,
  //    which is the same standing as any other pass-through column.
  if (nativeIsStar) {
    return nameChainIntact
      ? withPhysical(pqName, CONFIDENCE.EXACT, deducedReason('SELECT * returns the source columns'))
      : withPhysical(
        pqName,
        CONFIDENCE.INFERRED,
        'Native SQL uses SELECT *: the source table is exact, but the column list cannot be '
          + 'verified from the query text, so the column is assumed to pass through under the same name.'
      );
  }

  // 5. Pass-through. Whether this is a deduction or a guess depends entirely on whether
  //    the chain above it is complete: with every step known and none of them able to
  //    rename anything, the source name cannot differ. With an unrecognised step in the
  //    way, it is an assumption and says so.
  return nameChainIntact
    ? withPhysical(pqName, CONFIDENCE.EXACT, deducedReason('the query returns the source columns'))
    : withPhysical(
      pqName,
      CONFIDENCE.INFERRED,
      'No rename or projection found, and the chain contains a step this tool cannot read, '
        + 'so the column is assumed to pass through from the source under the same name.'
    );
}

/** Why a pass-through column counts as stated rather than assumed. */
function deducedReason(premise) {
  return `Every step from the source to the model is accounted for and none of them renames a column, `
    + `and ${premise} — so the source column carries this name.`;
}

/**
 * Two independent axes, counted separately because they answer different questions.
 *
 * `exact` / `inferred` / `unknown` is confidence in the *answer*. "This column is computed
 * in DAX and has no physical source" is an exact answer, so a calculated column is
 * `exact`, and that is right.
 *
 * `sourced` / `computed` / `unresolved` is where the values come from. Coverage belongs on
 * this axis, and it used to be computed on the other one: 390 of 473 counted as resolved
 * while only 384 carried a physical path, because the 6 computed columns were exact about
 * having no source and got counted as traced anyway. A headline that disagrees with the
 * source map underneath it is the kind of small dishonesty that costs the whole tool its
 * credibility, so coverage is now `sourced / (sourced + unresolved)` — of the columns that
 * do read from a source, how many were traced.
 */
function summarize(columns) {
  let exact = 0;
  let inferred = 0;
  let unknown = 0;
  let sourced = 0;
  let computed = 0;
  let unresolved = 0;

  for (const col of columns.values()) {
    if (col.confidence === CONFIDENCE.EXACT) exact++;
    else if (col.confidence === CONFIDENCE.INFERRED) inferred++;
    else unknown++;

    if (col.origin === ORIGIN.SOURCE) sourced++;
    else if (col.origin === ORIGIN.UNRESOLVED) unresolved++;
    else computed++;
  }

  const traceable = sourced + unresolved;
  return {
    total: columns.size,
    exact,
    inferred,
    unknown,
    sourced,
    computed,
    unresolved,
    coverage: traceable === 0 ? 0 : Math.round((sourced / traceable) * 1000) / 1000,
  };
}

/**
 * Flatten resolved columns into rows for a source-map table or CSV export.
 * @param {{columns: Map<string, object>}} resolved - Output of resolveSourceNames().
 * @returns {Array<object>}
 */
export function toSourceMapRows(resolved) {
  const rows = [];
  for (const col of resolved.columns.values()) {
    rows.push({
      modelTable: col.modelTable,
      modelColumn: col.modelColumn,
      modelRef: col.modelRef,
      pqName: col.pqName,
      system: col.physical?.system ?? null,
      server: col.physical?.server ?? null,
      database: col.physical?.database ?? null,
      schema: col.physical?.schema ?? null,
      sourceTable: col.physical?.table ?? null,
      sourceColumn: col.physical?.column ?? null,
      physicalPath: col.physicalPath,
      origin: col.origin,
      confidence: col.confidence,
      reason: col.reason,
    });
  }
  return rows;
}
