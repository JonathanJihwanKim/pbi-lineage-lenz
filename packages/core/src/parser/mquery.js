/**
 * Power Query M parser.
 *
 * Extracts data-source connections, physical table/column lineage, and ordered
 * transformation steps from M expressions.
 *
 * Ported from pbip-documenter's `m-parser.js` (MExpressionParser) with three changes:
 *   1. Static class -> ES module functions, matching the rest of core.
 *   2. The mutable `MExpressionParser._declaredParams` static is gone; the declared
 *      parameter set is threaded through explicitly, so results no longer depend on
 *      whether extractAllFromModel() happened to run first.
 *   3. M comments are stripped before connector matching, so commented-out connectors
 *      no longer register as live data sources.
 */

/** Transformation step kinds produced by {@link parseMSteps}. */
export const STEP_KINDS = Object.freeze({
  SOURCE: 'Source',
  NAVIGATION: 'Navigation',
  PROJECTION: 'Projection',
  RENAME: 'Rename',
  FILTER: 'Filter',
  JOIN: 'Join',
  ADD_COLUMN: 'AddColumn',
  TYPE_CHANGE: 'TypeChange',
  EXPAND: 'Expand',
  CUSTOM: 'Custom',
});

const ON_PREM_CONNECTORS = ['SQL Server', 'Oracle', 'Teradata', 'SAP HANA', 'ODBC', 'Analysis Services'];

const CLOUD_CONNECTORS = [
  'Azure Blob Storage', 'Dataverse', 'Snowflake', 'Google BigQuery',
  'Power BI Dataflow', 'OData', 'SharePoint Tables', 'SharePoint Files',
  'Fabric Lakehouse', 'Fabric Warehouse', 'Azure Data Explorer', 'Databricks',
  'Web', 'MySQL', 'PostgreSQL',
];

const CLOUD_HOST_PATTERN =
  /\.database\.windows\.net|\.sql\.azuresynapse\.net|\.datawarehouse\.fabric\.microsoft\.com|\.pbidedicated\.windows\.net|\.asazure\.windows\.net/i;

/**
 * Strip M comments so commented-out connectors are not mistaken for live sources.
 * Quoted strings are preserved — a `--` or `//` inside a SQL literal is not a comment.
 * @param {string} text
 * @returns {string}
 */
export function stripMComments(text) {
  if (!text) return text;
  let out = '';
  let i = 0;
  let inStr = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inStr) {
      out += ch;
      // In M, "" is an escaped quote inside a string literal.
      if (ch === '"') {
        if (next === '"') { out += next; i += 2; continue; }
        inStr = false;
      }
      i++;
      continue;
    }

    if (ch === '"') { inStr = true; out += ch; i++; continue; }

    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Strip ```-fenced code blocks that TMDL sometimes wraps M bodies in. */
function stripFences(text) {
  return text.replace(/^\s*```[^\n]*\n?/, '').replace(/\n?\s*```\s*$/, '');
}

/* ---------------------------------------------------------------------------
 * Parsed-model field accessors.
 *
 * Two TMDL parsers feed this module and they name the same things differently:
 * this package's tmdlParser emits `partition.sourceExpression` / `expression.mExpression`,
 * while pbip-documenter emits `partition.source` / `expression.expression`. Reading both
 * keeps the engine usable from either project as they converge on this core.
 * ------------------------------------------------------------------------ */

/** The M body of a partition, under whichever field name the parser used. */
export function partitionMExpr(partition) {
  return partition?.source ?? partition?.sourceExpression ?? null;
}

/** The body of a shared expression, under whichever field name the parser used. */
export function expressionBody(expression) {
  return expression?.expression ?? expression?.mExpression ?? null;
}

/** The kind of a shared expression ('parameter', 'function', 'list', ...). */
export function expressionKind(expression) {
  return (expression?.resultType ?? expression?.kind ?? '').toLowerCase();
}

/** Every M body attached to a table, most specific first. */
function tableMExprs(table) {
  const bodies = [];
  if (table?.refreshPolicy?.sourceExpression) bodies.push(table.refreshPolicy.sourceExpression);
  for (const partition of table?.partitions || []) {
    const body = partitionMExpr(partition);
    if (body) bodies.push(body);
  }
  return bodies;
}

/**
 * Extract parameter references (`#"Name"`) from an M expression.
 * Only names present in `declaredParams` count as parameters.
 * @param {string} mExpression
 * @param {Set<string>} [declaredParams]
 * @returns {string[]}
 */
export function extractParameterRefs(mExpression, declaredParams) {
  const refs = [];
  const pattern = /#"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(mExpression)) !== null) {
    if (!declaredParams || declaredParams.has(match[1])) refs.push(match[1]);
  }
  return refs;
}

/**
 * Extract data-source connections from an M expression.
 *
 * @param {string} mExpression - Power Query M expression text.
 * @param {Set<string>} [declaredParams] - Names of expressions that are parameter queries.
 * @param {Map<string, string>} [paramValues] - Literal values of those parameters.
 * @returns {Array<object>} Source descriptors: `{ type, server?, database?, url?, path?,
 *   parameterized, parameters?, nativeQuery?, nativeQueryComplete?, isNativeQuery?, isInline? }`
 */
export function extractDataSources(mExpression, declaredParams, paramValues) {
  if (!mExpression) return [];

  const expr = stripMComments(mExpression);
  const sources = [];
  const isParameterized = extractParameterRefs(expr, declaredParams).length > 0;
  let match;

  // --- Two-argument connectors: server + database ------------------------------
  const serverDbConnectors = [
    [/Sql\.Databases?\s*\(\s*("([^"]*)"|#"([^"]*)")\s*(?:,\s*("([^"]*)"|#"([^"]*)"))?/g, 'SQL Server'],
    [/AnalysisServices\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")\s*(?:,\s*("([^"]*)"|#"([^"]*)"))?/g, 'Analysis Services'],
    [/Snowflake\.Databases\s*\(\s*("([^"]*)"|#"([^"]*)")\s*(?:,\s*("([^"]*)"|#"([^"]*)"))?/g, 'Snowflake'],
    [/PostgreSQL\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")\s*,\s*("([^"]*)"|#"([^"]*)")/g, 'PostgreSQL'],
    [/MySQL\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")\s*,\s*("([^"]*)"|#"([^"]*)")/g, 'MySQL'],
    [/(?:AzureDataExplorer|Kusto)\.Contents\s*\(\s*("([^"]*)"|#"([^"]*)")\s*(?:,\s*("([^"]*)"|#"([^"]*)"))?/g, 'Azure Data Explorer'],
  ];
  for (const [pattern, type] of serverDbConnectors) {
    while ((match = pattern.exec(expr)) !== null) {
      const server = match[2] || match[3] || null;
      const database = match[5] || match[6] || null;
      const source = {
        type,
        server,
        database,
        parameterized: !!(match[3] || match[6]),
      };
      if (type === 'SQL Server') {
        source.parameterized = isParameterized || source.parameterized;
        if (match[3]) source.parameters = [match[3]];
        else if (match[6]) source.parameters = [match[6]];
      }
      sources.push(source);
    }
  }

  // --- Single-argument connectors: server only ---------------------------------
  const serverOnlyConnectors = [
    [/Oracle\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Oracle'],
    [/Teradata\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Teradata'],
    [/SapHana\.Database\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'SAP HANA'],
    [/Odbc\.(?:DataSource|Query)\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'ODBC'],
    [/Fabric\.Warehouse\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Fabric Warehouse'],
    [/Databricks\.Catalogs\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Databricks'],
  ];
  for (const [pattern, type] of serverOnlyConnectors) {
    while ((match = pattern.exec(expr)) !== null) {
      sources.push({ type, server: match[2] || match[3] || null, parameterized: !!match[3] });
    }
  }

  // --- URL-based connectors ----------------------------------------------------
  const urlConnectors = [
    [/OData\.Feed\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'OData'],
    [/Web\.Contents\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Web'],
    [/SharePoint\.Tables\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'SharePoint Tables'],
    [/SharePoint\.Files\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'SharePoint Files'],
    [/AzureStorage\.Blobs\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Azure Blob Storage'],
    [/Dataverse\.Contents\s*\(\s*("([^"]*)"|#"([^"]*)")?/g, 'Dataverse'],
  ];
  for (const [pattern, type] of urlConnectors) {
    while ((match = pattern.exec(expr)) !== null) {
      sources.push({ type, url: match[2] || match[3] || null, parameterized: !!match[3] });
    }
  }

  // --- File-based connectors ---------------------------------------------------
  const fileConnectors = [
    [/Excel\.Workbook\s*\(\s*File\.Contents\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'Excel'],
    [/Csv\.Document\s*\(\s*File\.Contents\s*\(\s*("([^"]*)"|#"([^"]*)")/g, 'CSV'],
  ];
  for (const [pattern, type] of fileConnectors) {
    while ((match = pattern.exec(expr)) !== null) {
      sources.push({ type, path: match[2] || match[3] || null, parameterized: !!match[3] });
    }
  }

  // --- Google BigQuery: a bare project, or an options record ------------------
  // `GoogleBigQuery.Database([UseStorageApi=false, BillingProject=_BillingProject])` is
  // the common real-world form; the project arrives as a record field, not a string.
  const bqRecordPattern = /GoogleBigQuery\.Database\s*\(\s*\[([^\]]*)\]/g;
  const bqRecordEnds = [];
  while ((match = bqRecordPattern.exec(expr)) !== null) {
    bqRecordEnds.push(match.index);
    const field = /BillingProject\s*=\s*(?:"([^"]*)"|#"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(match[1]);
    let project = field ? (field[1] ?? field[2] ?? field[3] ?? null) : null;
    const isIdent = !!field && field[1] === undefined;
    if (isIdent && project && paramValues?.has(project)) project = paramValues.get(project);
    sources.push({ type: 'Google BigQuery', server: project, parameterized: isIdent });
  }

  const bqPattern = /GoogleBigQuery\.Database\s*\(\s*(?:"([^"]*)"|#"([^"]*)")?/g;
  while ((match = bqPattern.exec(expr)) !== null) {
    if (bqRecordEnds.includes(match.index)) continue; // already handled as a record
    sources.push({ type: 'Google BigQuery', server: match[1] || match[2] || null, parameterized: !!match[2] });
  }

  // --- Connectors with no literal arguments ------------------------------------
  if (/PowerBI\.Dataflows\s*\(/.test(expr)) sources.push({ type: 'Power BI Dataflow', parameterized: false });
  if (/Lakehouse\.Contents\s*\(/.test(expr)) sources.push({ type: 'Fabric Lakehouse', parameterized: false });
  if (/Binary\.(?:Decompress|FromText)\s*\(/.test(expr)) sources.push({ type: 'Inline Literal', isInline: true });

  // --- Value.NativeQuery: wraps a connector with passthrough SQL ---------------
  const nativeQueryPattern = /Value\.NativeQuery\s*\(/g;
  while ((match = nativeQueryPattern.exec(expr)) !== null) {
    const afterOpen = expr.slice(match.index + match[0].length);
    const firstComma = findTopLevelComma(afterOpen);

    // The SQL argument is frequently a concatenation of literals and parameters, not a
    // single literal. Take the whole argument and evaluate it, or the table name is lost.
    let sqlText = null;
    let sqlComplete = false;
    if (firstComma !== -1) {
      const rest = afterOpen.slice(firstComma + 1);
      const secondComma = findTopLevelComma(rest);
      const sqlArg = secondComma === -1 ? rest : rest.slice(0, secondComma);
      const resolved = resolveMStringConcat(sqlArg, paramValues);
      sqlText = resolved.text;
      sqlComplete = resolved.complete;
    }

    const firstArg = firstComma !== -1 ? afterOpen.slice(0, firstComma) : afterOpen.slice(0, 500);
    const innerSources = extractDataSources(firstArg, declaredParams, paramValues);
    const nativeFields = { nativeQuery: sqlText, nativeQueryComplete: sqlComplete, isNativeQuery: true };
    if (innerSources.length > 0) {
      for (const inner of innerSources) sources.push({ ...inner, ...nativeFields });
    } else {
      sources.push({ type: 'Native Query', ...nativeFields });
    }
  }

  // A connector wrapped by Value.NativeQuery was also matched standalone by the
  // connector patterns above. Drop that bare duplicate — it carries the same
  // sourceKey, so deduplicateSources() would otherwise keep it and discard the
  // native SQL, which is the highest-value detail for a data engineer.
  const nativeKeys = new Set(sources.filter((s) => s.isNativeQuery).map(sourceKey));
  return nativeKeys.size === 0
    ? sources
    : sources.filter((s) => s.isNativeQuery || !nativeKeys.has(sourceKey(s)));
}

/**
 * Index of the first comma at bracket depth 0, or -1.
 * String literals are skipped — a SQL argument like `"SELECT id, total FROM t"` must not
 * be split at the comma inside it.
 */
function findTopLevelComma(text) {
  let depth = 0;
  let inStr = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      // "" is the escaped quote in M.
      if (ch === '"') {
        if (text[i + 1] === '"') { i++; continue; }
        inStr = false;
      }
      continue;
    }

    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/**
 * Resolve parameter references in sources against the model's parameter queries.
 * Adds `<field>Resolved` alongside the original value rather than overwriting it.
 * @param {Array<object>} sources
 * @param {Array<{name: string, expression: string}>} expressions
 * @returns {Array<object>}
 */
export function resolveParameters(sources, expressions) {
  if (!expressions || expressions.length === 0) return sources;

  const paramMap = new Map();
  for (const expr of expressions) {
    const body = expressionBody(expr);
    if (!body) continue;
    if (/IsParameterQuery\s*=\s*true/i.test(body)) {
      const valueMatch = body.match(/"([^"]+)"\s*meta\s*\[/);
      if (valueMatch) paramMap.set(expr.name, valueMatch[1]);
    } else if (expressionKind(expr) === 'parameter') {
      // Core's tmdlParser stores a literal parameter's value as the body itself.
      paramMap.set(expr.name, body.replace(/^"|"$/g, ''));
    }
  }

  return sources.map((source) => {
    const resolved = { ...source };
    for (const field of ['server', 'database', 'url', 'path']) {
      if (resolved[field] && paramMap.has(resolved[field])) {
        resolved[`${field}Resolved`] = paramMap.get(resolved[field]);
      }
    }
    if (resolved.parameters) {
      for (const paramName of resolved.parameters) {
        if (paramMap.has(paramName) && !resolved.server && !resolved.serverResolved) {
          resolved.serverResolved = paramMap.get(paramName);
        }
      }
    }
    return resolved;
  });
}

/**
 * Extract physical table and column lineage from an M expression.
 *
 * @param {string} mExpression
 * @param {Map<string, string>} [paramValues] - Literal parameter values, for identifier-valued
 *   navigation records such as `{[Name=_BillingProject]}`.
 * @returns {{physicalSchema: string|null, physicalTable: string|null, physicalDataset: string|null,
 *   physicalProject: string|null, renames: Array<{sourceName: string, modelName: string}>,
 *   selectedColumns: string[]|null, addedColumns: string[], joins: Array<object>,
 *   expands: Array<{intoColumn: string, sourceName: string, modelName: string}>}|null}
 */
export function extractTableLineage(mExpression, paramValues) {
  if (!mExpression) return null;

  const expr = stripMComments(mExpression);
  const result = {
    physicalSchema: null,
    physicalTable: null,
    physicalDataset: null, // BigQuery dataset or ADLS container
    physicalProject: null, // BigQuery project or cloud account
    renames: [],
    selectedColumns: null, // null = all columns; array = explicit projection
    addedColumns: [],
    joins: [],
    // Columns pulled in from a joined table: `{intoColumn, sourceName, modelName}`.
    // Kept apart from `renames` because their physical home is the joined table, not
    // this one.
    expands: [],
  };

  // 1. Navigation. Records take several shapes across connectors:
  //      {[Schema="dbo", Item="FactSales"]}          SQL Server
  //      {[Name="report_calendar", Kind="Schema"]}       BigQuery / Fabric, kind-tagged
  //      {[Name=_BillingProject]}                    parameter-valued
  //      {[Name="proj"]}{[Name="ds"]}{[Name="tbl"]}  untagged chain
  const navSteps = extractNavigationSteps(expr, paramValues);
  const hasNativeQuery = /Value\.NativeQuery\s*\(/.test(expr);

  for (const step of navSteps) {
    if (step.Schema && step.Item) {
      result.physicalSchema = step.Schema;
      result.physicalTable = step.Item;
    }
  }

  // Kind-tagged chain: each record says what it is, so position does not matter.
  if (!result.physicalTable) {
    const untagged = [];
    for (const step of navSteps) {
      if (!step.Name) continue;
      const kind = (step.Kind || '').toLowerCase();
      if (kind === 'schema' || kind === 'dataset') result.physicalSchema = step.Name;
      else if (kind === 'table' || kind === 'view') result.physicalTable = step.Name;
      else if (!kind) untagged.push(step.Name);
    }

    // Untagged records are positional: ...project -> dataset -> table.
    // Under a native query they are connector-level navigation (the BigQuery billing
    // project), not a table — the SQL names the table, so leave it to the caller.
    if (!result.physicalTable && untagged.length > 0 && !hasNativeQuery) {
      result.physicalTable = untagged[untagged.length - 1];
      if (untagged.length >= 2 && !result.physicalDataset) result.physicalDataset = untagged[untagged.length - 2];
      if (untagged.length >= 3) result.physicalProject = untagged[untagged.length - 3];
    } else if (untagged.length > 0 && !result.physicalProject) {
      // A leading untagged record alongside kind-tagged ones is the project/catalog.
      result.physicalProject = untagged[0];
    }
  }

  // 2. Table.RenameColumns -> {"OldName","NewName"} pairs.
  const renamePattern = /Table\.RenameColumns\b/g;
  let rm;
  while ((rm = renamePattern.exec(expr)) !== null) {
    const afterCall = expr.slice(rm.index);
    const commaIdx = afterCall.indexOf(',');
    if (commaIdx === -1) continue;
    const listStart = afterCall.indexOf('{', commaIdx);
    if (listStart === -1) continue;
    const window = afterCall.slice(listStart, listStart + 2000);
    const pairPattern = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
    let pp;
    while ((pp = pairPattern.exec(window)) !== null) {
      result.renames.push({ sourceName: pp[1], modelName: pp[2] });
    }
  }

  // 3. Table.SelectColumns — the last call wins; it is the final projected set.
  const selectPattern = /Table\.SelectColumns\b/g;
  let sm;
  let lastSelectPos = -1;
  while ((sm = selectPattern.exec(expr)) !== null) lastSelectPos = sm.index;
  if (lastSelectPos !== -1) {
    const afterSel = expr.slice(lastSelectPos);
    const commaIdx = afterSel.indexOf(',');
    if (commaIdx !== -1) {
      const braceIdx = afterSel.indexOf('{', commaIdx);
      if (braceIdx !== -1) {
        const window = afterSel.slice(braceIdx, braceIdx + 4000);
        const colPattern = /"([^"]+)"/g;
        const cols = [];
        let cp;
        while ((cp = colPattern.exec(window)) !== null) {
          if (cp.index > 10 && window.slice(0, cp.index).includes('Table.')) break;
          cols.push(cp[1]);
        }
        if (cols.length > 0) result.selectedColumns = cols;
      }
    }
  }

  // 4. Table.AddColumn -> computed column names.
  const addPattern = /Table\.AddColumn\s*\(\s*(?:[^,\n]+),\s*"([^"]+)"/g;
  let ac;
  while ((ac = addPattern.exec(expr)) !== null) result.addedColumns.push(ac[1]);

  // 4b. Table.NestedJoin -> joined step names and key columns.
  // The fifth argument is the name of the nested column the joined table lands in
  // (`"_NPM"`). Capturing it is what lets a later Table.ExpandTableColumn be traced back
  // to the table the column actually came from, rather than to the table being joined
  // onto — which is a different physical table, in a different dataset.
  const joinPattern = /Table\.NestedJoin\s*\(\s*([^,\n]+),\s*\{([^}]*)\}\s*,\s*([^,\n]+),\s*\{([^}]*)\}\s*,\s*"([^"]+)"/g;
  let jm;
  while ((jm = joinPattern.exec(expr)) !== null) {
    result.joins.push({
      type: 'NestedJoin',
      leftStep: jm[1].trim(),
      rightStep: jm[3].trim(),
      leftKeys: (jm[2].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')),
      rightKeys: (jm[4].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')),
      intoColumn: jm[5],
    });
  }

  // 4b-ii. Table.ExpandTableColumn(prev, "_NPM", {old...}, {new...}) — the third and
  // fourth arguments are an old-name/new-name pair list, which is a rename stated
  // outright. Reading only the step kind and discarding the names left these columns
  // labelled "assumed to pass through" while their real source name sat in the argument.
  const expandPattern = /Table\.ExpandTableColumn\s*\(\s*[^,]+,\s*"([^"]+)"\s*,\s*\{([^}]*)\}(?:\s*,\s*\{([^}]*)\})?/g;
  let em;
  while ((em = expandPattern.exec(expr)) !== null) {
    const sourceNames = (em[2].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ''));
    const newNames = (em[3]?.match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ''));
    for (const [i, sourceName] of sourceNames.entries()) {
      result.expands.push({
        intoColumn: em[1],
        sourceName,
        // The fourth argument is optional; without it the column keeps its own name.
        modelName: newNames[i] ?? sourceName,
      });
    }
  }

  // 4c. Table.Combine -> appended step names.
  const combinePattern = /Table\.Combine\s*\(\s*\{([^}]+)\}/g;
  let cm;
  while ((cm = combinePattern.exec(expr)) !== null) {
    result.joins.push({ type: 'Combine', steps: cm[1].split(',').map((s) => s.trim()).filter(Boolean) });
  }

  // 5. Table.RemoveColumns prunes an explicit projection.
  if (result.selectedColumns !== null) {
    const removePattern = /Table\.RemoveColumns\b/g;
    let rmc;
    while ((rmc = removePattern.exec(expr)) !== null) {
      const afterRem = expr.slice(rmc.index);
      const commaIdx = afterRem.indexOf(',');
      if (commaIdx === -1) continue;
      const braceIdx = afterRem.indexOf('{', commaIdx);
      if (braceIdx === -1) continue;
      const window = afterRem.slice(braceIdx, braceIdx + 2000);
      const rColPattern = /"([^"]+)"/g;
      let rc;
      while ((rc = rColPattern.exec(window)) !== null) {
        const idx = result.selectedColumns.indexOf(rc[1]);
        if (idx !== -1) result.selectedColumns.splice(idx, 1);
      }
    }
  }

  return result;
}

/**
 * TMDL's parser folds partition properties into `partition.source`. Return just the
 * M body that follows the embedded `source =` marker, or the input unchanged.
 *
 * The marker must be a line-anchored TMDL property. An unanchored `\bsource\s*=` also
 * matches the M step `Source =` — Power Query's default name for the first step — which
 * would truncate `let Source = shared_src in Source` to `shared_src in Source` and break
 * every downstream parse. A body that already starts with `let` is never unwrapped.
 */
export function extractMExprFromPartitionSource(src) {
  if (!src) return src;

  const stripped = stripFences(src).trim();
  if (/^let\b/i.test(stripped)) return src;

  const m = src.match(/^[ \t]*source[ \t]*=[ \t]*([\s\S]+)/im);
  return m ? m[1].trim() : src;
}

/**
 * If an M body is a reference to a shared expression rather than a query of its own,
 * return that expression's name.
 *
 * Both delegation shapes are recognised, because the two TMDL parsers produce different
 * ones for the same partition: a full `let` block whose first step is a bare reference,
 * and the bare expression name on its own.
 *
 * `let Source = bu_dim_src in Source` -> `bu_dim_src`
 * `bu_dim_src`                        -> `bu_dim_src`
 *
 * @param {string} mExpr
 * @returns {string|null}
 */
export function extractSharedExpressionRef(mExpr) {
  if (!mExpr) return null;
  const stripped = stripFences(extractMExprFromPartitionSource(mExpr)).trim();

  // Whole body is a single identifier — a bare delegation.
  const bare = stripped.match(/^(?:#"([^"]+)"|([A-Za-z_][A-Za-z0-9_.]*))$/);
  if (bare) return bare[1] || bare[2] || null;

  const m = stripped.match(
    /^\s*let\s+(?:#"[^"]+"|[A-Za-z_][A-Za-z0-9_ ]*)\s*=\s*(?:#"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?![ \t]*\()/i
  );
  if (!m) return null;
  return m[1] || m[2] || null;
}

/**
 * Extract lineage for one M body, following shared-expression delegation.
 * Physical source comes from the referenced expression; renames and projections
 * from the referring body are layered on top.
 */
export function extractLineageResolvingRef(mExpr, expressionBodies = {}, visited = new Set(), paramValues) {
  const refName = extractSharedExpressionRef(mExpr);
  const refBody = refName && !visited.has(refName) ? expressionBodies[refName] : null;

  if (!refBody) return extractTableLineage(mExpr, paramValues);

  visited.add(refName);
  const baseLineage = extractLineageResolvingRef(refBody, expressionBodies, visited, paramValues);
  const partitionLineage = extractTableLineage(mExpr, paramValues);
  if (!baseLineage) return partitionLineage;

  return {
    physicalSchema: baseLineage.physicalSchema,
    physicalTable: baseLineage.physicalTable,
    physicalDataset: baseLineage.physicalDataset ?? null,
    physicalProject: baseLineage.physicalProject ?? null,
    renames: [...(partitionLineage?.renames || []), ...(baseLineage.renames || [])],
    selectedColumns: partitionLineage?.selectedColumns || baseLineage.selectedColumns,
    addedColumns: [...(partitionLineage?.addedColumns || []), ...(baseLineage.addedColumns || [])],
    joins: [...(partitionLineage?.joins || []), ...(baseLineage.joins || [])],
    expands: [...(partitionLineage?.expands || []), ...(baseLineage.expands || [])],
  };
}

/** Collect `name -> body` for every shared expression in a parsed model. */
export function collectExpressionBodies(parsedModel) {
  const bodies = {};
  for (const expr of parsedModel?.expressions || []) {
    const body = expressionBody(expr);
    if (expr.name && body) bodies[expr.name] = body;
  }
  return bodies;
}

/**
 * Literal values of the model's parameter queries, by name.
 *
 * Real models build connection strings and SQL out of parameters
 * (`"SELECT * FROM \`" & _BillingProject & ".report_calendar.date_dim\`"`), so without these
 * values the physical path is unknowable. With them it resolves exactly.
 *
 * @param {object} parsedModel
 * @returns {Map<string, string>}
 */
export function collectParamValues(parsedModel) {
  const values = new Map();

  // parseExpressions() hands back literal parameters separately.
  if (parsedModel?.parameters instanceof Map) {
    for (const [name, value] of parsedModel.parameters) values.set(name, value);
  }

  for (const expr of parsedModel?.expressions || []) {
    if (!expr.name || values.has(expr.name)) continue;
    const body = expressionBody(expr);
    if (!body) continue;

    if (expressionKind(expr) === 'parameter') {
      // The body is either the bare value or still quoted.
      const quoted = body.match(/^"([^"]*)"/);
      values.set(expr.name, quoted ? quoted[1] : body.trim());
      continue;
    }
    // `"value" meta [IsParameterQuery=true, ...]`
    const meta = body.match(/^\s*"([^"]*)"\s*meta\s*\[/);
    if (meta) values.set(expr.name, meta[1]);
  }

  return values;
}

/**
 * Evaluate an M string-concatenation chain (`"a" & Param & "b"`) into a literal.
 *
 * @param {string} exprText
 * @param {Map<string, string>} [paramValues]
 * @returns {{text: string|null, complete: boolean}}
 *   `complete` is false when any operand could not be evaluated; unresolved names are
 *   left in the text as `{Name}` so the gap is visible rather than silently closed.
 */
export function resolveMStringConcat(exprText, paramValues) {
  if (!exprText) return { text: null, complete: false };

  const text = exprText.trim();
  const parts = [];
  let complete = true;
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /[\s&]/.test(text[i])) i++;
    if (i >= text.length) break;

    // String literal, with "" as the escaped quote.
    if (text[i] === '"') {
      let out = '';
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { out += '"'; i += 2; continue; }
          i++;
          break;
        }
        out += text[i++];
      }
      parts.push(out);
      continue;
    }

    // Identifier, quoted or bare.
    let name = null;
    if (text[i] === '#' && text[i + 1] === '"') {
      const end = text.indexOf('"', i + 2);
      if (end !== -1) {
        name = text.slice(i + 2, end);
        i = end + 1;
      }
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (m) {
        name = m[0];
        i += m[0].length;
      }
    }

    if (name === null) {
      // A function call or operator we do not evaluate — stop, and say so.
      complete = false;
      break;
    }
    if (paramValues?.has(name)) parts.push(paramValues.get(name));
    else {
      parts.push(`{${name}}`);
      complete = false;
    }
  }

  return { text: parts.length > 0 ? parts.join('') : null, complete };
}

/**
 * Parse the fields of every `{[...]}[ Data ]` navigation record in an expression.
 * Identifier-valued fields are resolved through `paramValues` when possible.
 *
 * @param {string} expr
 * @param {Map<string, string>} [paramValues]
 * @returns {Array<Object<string, string>>}
 */
export function extractNavigationSteps(expr, paramValues) {
  const steps = [];
  const recordPattern = /\{\s*\[([^\]]*)\]\s*\}\s*\[\s*Data\s*\]/gi;
  let m;

  while ((m = recordPattern.exec(expr)) !== null) {
    const fields = {};
    const fieldPattern =
      /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|#"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;
    let f;
    while ((f = fieldPattern.exec(m[1])) !== null) {
      const key = f[1];
      const literal = f[2];
      const quotedIdent = f[3];
      const bareIdent = f[4];

      let value = literal ?? quotedIdent ?? bareIdent ?? null;
      // `{[Name=_BillingProject]}` references a parameter, not a literal name.
      if (literal === undefined && value !== null && paramValues?.has(value)) {
        value = paramValues.get(value);
      }
      fields[key] = value;
    }
    if (Object.keys(fields).length > 0) steps.push(fields);
  }

  return steps;
}

/**
 * Physical path behind the first FROM in a SQL string.
 * Handles BigQuery's backtick-quoted `project.dataset.table`.
 *
 * @param {string} sql
 * @returns {{project: string|null, dataset: string|null, table: string|null}|null}
 */
export function extractSqlTablePath(sql) {
  if (!sql) return null;
  const m = /\bFROM\s+(?:`([^`]+)`|\[([^\]]+)\]|"([^"]+)"|((?:[\w$]+\s*\.\s*)*[\w$]+))/i.exec(sql);
  if (!m) return null;

  const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
  if (!raw) return null;

  const parts = raw.split('.').map((p) => p.replace(/[`"[\]]/g, '').trim()).filter(Boolean);
  if (parts.length === 0) return null;

  return {
    project: parts.length >= 3 ? parts[parts.length - 3] : null,
    dataset: parts.length >= 2 ? parts[parts.length - 2] : null,
    table: parts[parts.length - 1],
  };
}

/** Names of expressions that are parameter queries. */
export function collectDeclaredParams(parsedModel) {
  const names = new Set();
  for (const expr of parsedModel?.expressions || []) {
    if (!expr.name) continue;
    const body = expressionBody(expr);
    // Either the parser already classified it, or the body declares itself one.
    if (expressionKind(expr) === 'parameter' || (body && /IsParameterQuery\s*=\s*true/i.test(body))) {
      names.add(expr.name);
    }
  }
  return names;
}

/**
 * Physical table lineage for every table in a model.
 * @param {object} parsedModel
 * @returns {Map<string, object>} table name -> lineage
 */
export function extractTableLineageFromModel(parsedModel) {
  const expressionBodies = collectExpressionBodies(parsedModel);
  const paramValues = collectParamValues(parsedModel);
  const map = new Map();

  const tryLineage = (mExpr) => {
    if (!mExpr) return null;
    const lineage = extractLineageResolvingRef(mExpr, expressionBodies, new Set(), paramValues);
    return lineage && (lineage.physicalTable || lineage.renames.length > 0) ? lineage : null;
  };

  for (const table of parsedModel?.tables || []) {
    for (const mExpr of tableMExprs(table)) {
      const lineage = tryLineage(mExpr);
      if (lineage) {
        map.set(table.name, lineage);
        break;
      }
    }
  }
  return map;
}

/** Stable dedup key for a source descriptor. */
export function sourceKey(source) {
  const parts = [source.type];
  if (source.server) parts.push(source.server);
  if (source.database) parts.push(source.database);
  if (source.url) parts.push(source.url);
  if (source.path) parts.push(source.path);
  return parts.join('|').toLowerCase();
}

/** Deduplicate sources by {@link sourceKey}, keeping the first occurrence. */
export function deduplicateSources(allSources) {
  const seen = new Map();
  for (const source of allSources) {
    const key = sourceKey(source);
    if (!seen.has(key)) seen.set(key, source);
  }
  return [...seen.values()];
}

/**
 * Physical table names referenced by a SQL string's FROM/JOIN clauses.
 * Returns the last segment of each reference, unquoted — `dbo.Customers` and
 * BigQuery's backtick-wrapped `` `proj.ds.orders` `` both yield the table alone.
 * @param {string} sql
 * @returns {string[]}
 */
export function extractSqlTableRefs(sql) {
  if (!sql) return [];
  const results = new Set();

  // Either one quoted identifier that may itself contain dots (BigQuery style),
  // or a chain of bare/quoted segments joined by dots.
  const pattern =
    /\b(?:FROM|JOIN)\s+(?:`([^`]+)`|\[([^\]]+)\]|"([^"]+)"|((?:[\w$]+\s*\.\s*)*[\w$]+))/gi;

  let m;
  while ((m = pattern.exec(sql)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!raw) continue;
    const last = raw.split('.').pop().replace(/[`"[\]]/g, '').trim();
    if (last && !/^(SELECT|WHERE|ON|AS|SET|VALUES|INTO|UPDATE|DELETE)$/i.test(last)) {
      results.add(last);
    }
  }
  return [...results];
}

/**
 * Map each table to the set of resolved source keys it connects to.
 * Used to build source edges without key mismatches from unresolved parameters.
 * @param {object} parsedModel
 * @returns {Map<string, Set<string>>}
 */
export function buildTableSourceKeyMap(parsedModel) {
  const expressionBodies = collectExpressionBodies(parsedModel);
  const declaredParams = collectDeclaredParams(parsedModel);
  const paramValues = collectParamValues(parsedModel);
  const map = new Map();

  for (const table of parsedModel?.tables || []) {
    for (const partition of table.partitions || []) {
      const mExpr = partitionMExpr(partition);
      if (!mExpr) continue;
      let sources = extractDataSources(mExpr, declaredParams, paramValues);
      if (sources.length === 0) {
        const refName = extractSharedExpressionRef(mExpr);
        const refBody = refName && expressionBodies[refName];
        if (refBody) sources = extractDataSources(refBody, declaredParams, paramValues);
      }
      sources = resolveParameters(sources, parsedModel.expressions || []);
      for (const src of sources) {
        if (!map.has(table.name)) map.set(table.name, new Set());
        map.get(table.name).add(sourceKey(src));
      }
    }
  }
  return map;
}

/**
 * True if an M body declares a function rather than a query, e.g. `(a, b) => ...`.
 * Such bodies are excluded from data-source scanning.
 */
export function looksLikeMFunction(body) {
  if (!body) return false;
  const stripped = stripFences(body).trim();
  if (/^\(\s*[^)]*\)\s*=>/.test(stripped)) return true;
  if (/^let\s+\S+\s*=\s*\([^)]*\)\s*=>/i.test(stripped)) return true;
  return false;
}

/**
 * Whether a source needs an on-premises data gateway.
 * @returns {boolean|null} null when the connector kind is unknown.
 */
export function requiresGateway(source) {
  if (ON_PREM_CONNECTORS.includes(source.type)) {
    const server = source.serverResolved || source.server || '';
    return !CLOUD_HOST_PATTERN.test(server);
  }
  if (['Excel', 'CSV'].includes(source.type)) {
    return !/sharepoint|onedrive/i.test(source.path || '');
  }
  if (CLOUD_CONNECTORS.includes(source.type)) return false;
  return null;
}

/**
 * Every data source in a model, deduplicated and parameter-resolved.
 * Scans table partitions and also shared expressions that no partition loads
 * (Enable Load = false helpers still reach real systems).
 * @param {object} parsedModel
 * @returns {Array<object>}
 */
export function extractAllFromModel(parsedModel) {
  const declaredParams = collectDeclaredParams(parsedModel);
  const expressionBodies = collectExpressionBodies(parsedModel);
  const paramValues = collectParamValues(parsedModel);
  const allSources = [];

  for (const table of parsedModel?.tables || []) {
    for (const partition of table.partitions || []) {
      const mExpr = partitionMExpr(partition);
      if (!mExpr) continue;
      let sources = extractDataSources(mExpr, declaredParams, paramValues);

      // A partition that just delegates to a shared expression resolves through it.
      if (sources.length === 0) {
        const refName = extractSharedExpressionRef(mExpr);
        const refBody = refName && expressionBodies[refName];
        if (refBody) sources = extractDataSources(refBody, declaredParams, paramValues);
      }

      for (const src of sources) {
        src.tableName = table.name;
        src.partitionName = partition.name;
      }
      allSources.push(...sources);
    }
  }

  // Shared expressions that are never a loaded table's direct M still connect to systems.
  for (const expr of parsedModel?.expressions || []) {
    const body = expressionBody(expr);
    if (!body || !expr.name) continue;
    if (declaredParams.has(expr.name)) continue;
    const kind = expressionKind(expr);
    if (kind === 'function' || kind === 'list' || kind === 'record' || kind === 'parameter') continue;
    if (looksLikeMFunction(body)) continue;

    for (const src of extractDataSources(body, declaredParams, paramValues)) {
      src.expressionName = expr.name;
      src.isNonLoadedQuery = true; // tableName stays null until a partition consumes it
      allSources.push(src);
    }
  }

  const resolved = resolveParameters(allSources, parsedModel?.expressions || []);
  for (const src of resolved) {
    const gateway = requiresGateway(src);
    if (gateway !== null) src.gatewayRequired = gateway;
  }

  return deduplicateSources(resolved);
}

/**
 * Parse an M expression into the full ordered chain of steps behind a table.
 *
 * A step that is nothing but a reference to a shared expression is replaced by the steps
 * of that expression, so the chain reads end to end: connector, navigation, then whatever
 * the table itself does.
 *
 * This used to *substitute* rather than splice — a partition delegating to a shared
 * expression had its own steps thrown away and only the expression's shown. On one real
 * model that meant the lineage for a table displayed four navigation steps and silently
 * omitted the `Table.RenameColumns` that produced one of its columns. A reader auditing
 * that lineage would conclude no column was renamed, which is the opposite of the truth
 * and exactly the conclusion the display invited.
 *
 * @param {string} mExpr
 * @param {Object<string, string>} [expressionBodies] - shared expression name -> body
 * @param {Set<string>} [visited] - guards against an expression cycle
 * @returns {Array<{name: string, kind: string, exprText: string, refs: string[], via?: string}>}
 */
export function parseMSteps(mExpr, expressionBodies = {}, visited = new Set()) {
  if (!mExpr) return [];

  const own = parseLetSteps(mExpr);

  // A partition can also be a bare reference with no `let` of its own.
  if (own.length === 0) {
    const refName = extractSharedExpressionRef(mExpr);
    if (refName && expressionBodies[refName] && !visited.has(refName)) {
      return parseMSteps(expressionBodies[refName], expressionBodies, new Set([...visited, refName]))
        .map((step) => ({ ...step, via: step.via ?? refName }));
    }
    return own;
  }

  const spliced = [];
  for (const step of own) {
    const refName = bareExpressionRef(step.exprText);
    const body = refName && !visited.has(refName) ? expressionBodies[refName] : null;

    if (body) {
      // The reference step stands for the chain it names, so it is replaced by that
      // chain rather than listed beside it. `via` records where each borrowed step came
      // from, which is what lets a reader see that half the lineage lives elsewhere.
      const nested = parseMSteps(body, expressionBodies, new Set([...visited, refName]));
      for (const inner of nested) spliced.push({ ...inner, via: inner.via ?? refName });
      continue;
    }
    spliced.push(step);
  }
  return spliced;
}

/** The shared expression a step consists of, when it is nothing but a reference. */
function bareExpressionRef(exprText) {
  const match = /^(?:#"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))$/.exec((exprText || '').trim());
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Split one `let ... in` block into its own steps, without following references.
 * @param {string} mExpr
 * @returns {Array<object>}
 */
function parseLetSteps(mExpr) {
  let resolved = mExpr;
  resolved = stripMComments(stripFences(resolved));

  const letMatch = /^\s*let\b/i.exec(resolved);
  if (!letMatch) return [];

  const afterLet = resolved.slice(letMatch.index + letMatch[0].length);
  const steps = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  let strChar = '';
  let i = 0;

  while (i < afterLet.length) {
    const ch = afterLet[i];

    if (inStr) {
      buf += ch;
      if (ch === strChar && afterLet[i - 1] !== '\\') inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      buf += ch;
      i++;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') { depth++; buf += ch; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; buf += ch; i++; continue; }

    // Top-level comma ends a step.
    if (ch === ',' && depth === 0) {
      const step = parseOneStep(buf.trim());
      if (step) steps.push(step);
      buf = '';
      i++;
      continue;
    }

    // A top-level `in` ends the let block.
    if (depth === 0 && ch === 'i' && afterLet[i + 1] === 'n' && /\s/.test(afterLet[i + 2] || ' ')) {
      const prev = afterLet[i - 1] || ' ';
      if (/[\s,]/.test(prev)) {
        const step = parseOneStep(buf.trim());
        if (step) steps.push(step);
        buf = '';
        break;
      }
    }

    buf += ch;
    i++;
  }

  if (buf.trim()) {
    const step = parseOneStep(buf.trim());
    if (step) steps.push(step);
  }

  return steps;
}

/** Parse one `Name = expr` step into a descriptor. */
function parseOneStep(text) {
  if (!text) return null;
  const nameMatch = text.match(
    /^(?:#"([^"]+)"|([A-Za-z_À-ɏ][A-Za-z0-9_ À-ɏ]*))\s*=\s*([\s\S]*)/
  );
  if (!nameMatch) return null;

  const exprText = nameMatch[3].trim();
  // The unquoted-name character class allows spaces, so it absorbs the whitespace
  // before `=`. Trim it off rather than surfacing step names like "Source ".
  return {
    name: (nameMatch[1] || nameMatch[2]).trim(),
    kind: classifyStepKind(exprText),
    exprText,
    refs: extractStepRefs(exprText),
  };
}

/**
 * Classify a step expression into one of {@link STEP_KINDS}.
 * @param {string} expr
 * @returns {string}
 */
export function classifyStepKind(expr) {
  if (/^(?:Sql\.|GoogleBigQuery\.|AzureDataExplorer\.|Kusto\.|Lakehouse\.|Fabric\.|Databricks\.|Snowflake\.|PostgreSQL\.|MySQL\.|Teradata\.|SapHana\.|Odbc\.|Oracle\.|Excel\.|Csv\.|OData\.|SharePoint\.|PowerBI\.|Web\.|Value\.NativeQuery)/i.test(expr)) {
    return STEP_KINDS.SOURCE;
  }
  // A step name that is not a bare identifier must be quoted in M: `#"contoso-analytics-prod"`.
  // Matching only `\w+` therefore missed every navigation off a hyphenated step — which
  // is all of them on BigQuery, where project names are hyphenated by convention. Those
  // steps fell through to Custom and read as "the tool does not understand this", when
  // it is the plainest step in the chain.
  const STEP_NAME = '(?:#"[^"]*"|\\w+)';
  if (new RegExp(`^${STEP_NAME}\\s*\\{\\s*\\[`).test(expr)) return STEP_KINDS.NAVIGATION; // item{[Schema=...,Item=...]}[Data]
  if (new RegExp(`^${STEP_NAME}\\s*\\[`).test(expr) && !/^Table\./.test(expr)) return STEP_KINDS.NAVIGATION; // step["column"]
  if (/^Table\.SelectColumns\b/.test(expr)) return STEP_KINDS.PROJECTION;
  if (/^Table\.RenameColumns\b/.test(expr)) return STEP_KINDS.RENAME;
  if (/^Table\.SelectRows\b/.test(expr)) return STEP_KINDS.FILTER;
  if (/^Table\.NestedJoin\b/.test(expr)) return STEP_KINDS.JOIN;
  if (/^Table\.Combine\b/.test(expr)) return STEP_KINDS.JOIN;
  if (/^Table\.AddColumn\b/.test(expr)) return STEP_KINDS.ADD_COLUMN;
  if (/^Table\.TransformColumnTypes\b/.test(expr)) return STEP_KINDS.TYPE_CHANGE;
  if (/^Table\.ExpandTableColumn\b/.test(expr)) return STEP_KINDS.EXPAND;
  if (/^Table\.RemoveColumns\b/.test(expr)) return STEP_KINDS.PROJECTION;
  if (/^Table\.ReorderColumns\b/.test(expr)) return STEP_KINDS.PROJECTION;
  return STEP_KINDS.CUSTOM;
}

/**
 * M functions that cannot change what an existing column is called.
 *
 * Taken from the categories in Microsoft's Table function reference rather than from
 * memory, because a wrong entry here turns an honest `inferred` into a false `exact` —
 * the one failure this confidence model exists to prevent.
 * https://learn.microsoft.com/en-us/powerquery-m/table-functions
 *
 * Everything in the reference's **Row operations**, **Membership** and **Ordering**
 * groups acts on rows and leaves headers alone. From **Column operations** only the
 * three that keep names qualify — `Table.PromoteHeaders`, `DemoteHeaders`, `Pivot`,
 * `Unpivot`, `PrefixColumns` and `TransformColumnNames` all rewrite headers and are
 * deliberately absent. From **Transformation**, only those that touch values.
 *
 * `Table.RenameColumns`, `Table.ExpandTableColumn` and `Table.NestedJoin` are included
 * because they state their renames outright and those statements are read. `AddColumn`
 * is included because a column it adds is recognised as computed before the pass-through
 * rule is ever reached.
 *
 * Anything not listed is assumed to be able to rename. That default is what makes the
 * list safe to be incomplete.
 */
const NAME_PRESERVING_FUNCTIONS = new Set([
  // Row operations
  'Table.SelectRows', 'Table.SelectRowsWithErrors', 'Table.RemoveRowsWithErrors', 'Table.FindText',
  'Table.FirstN', 'Table.LastN', 'Table.Skip', 'Table.Range', 'Table.AlternateRows', 'Table.Repeat',
  'Table.RemoveFirstN', 'Table.RemoveLastN', 'Table.RemoveRows', 'Table.ReverseRows',
  'Table.InsertRows', 'Table.ReplaceRows',
  // Membership and ordering
  'Table.Distinct', 'Table.RemoveMatchingRows', 'Table.ReplaceMatchingRows',
  'Table.Sort', 'Table.MinN', 'Table.MaxN',
  // Column operations that keep the names they keep
  'Table.SelectColumns', 'Table.RemoveColumns', 'Table.ReorderColumns',
  // Renames, stated and read
  'Table.RenameColumns', 'Table.ExpandTableColumn', 'Table.NestedJoin',
  // Value-level transformation
  'Table.ReplaceValue', 'Table.ReplaceErrorValues', 'Table.FillDown', 'Table.FillUp',
  'Table.TransformColumns', 'Table.TransformColumnTypes', 'Table.AddColumn',
  // Evaluation control and the query itself
  'Table.Buffer', 'Table.StopFolding', 'Value.NativeQuery',
]);

/**
 * `MissingField.UseNull` turns a transform into a column *creator*.
 *
 * Both `Table.TransformColumns` and `Table.TransformColumnTypes` accept it — the latter
 * hidden inside a record in the `culture` argument — and a column conjured that way has
 * no source column at all. Claiming it passes through from the source under the same
 * name would be exactly the confident lie this model is built to avoid, so the presence
 * of the flag withdraws the guarantee.
 */
const CREATES_MISSING_COLUMNS = /MissingField\.UseNull/;

/**
 * Can this step change what a column is called?
 *
 * Conservative: anything unrecognised answers yes, because the cost of a wrong `exact` is
 * a data engineer sent to look for a column that is not there.
 *
 * Two shapes matter beyond the function list. A step that is nothing but a reference to
 * another step obviously renames nothing. And `if <cond> then <A> else <B>` returns one of
 * its two arms, so it is safe exactly when both arms are — which is what makes the common
 * `if DatasetFilter = 1 then #"Filtered" else Base` harmless: both arms are row filters,
 * and row filters do not touch headers.
 *
 * @param {string} exprText
 * @returns {boolean}
 */
export function stepAffectsColumnNames(exprText) {
  const expr = (exprText || '').trim();
  if (!expr) return true;

  // A bare reference to another step.
  if (/^(?:#"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)$/.test(expr)) return false;

  // A conditional returns one of its arms, so it is as safe as the less safe arm.
  const branch = splitConditional(expr);
  if (branch) return branch.some((arm) => stepAffectsColumnNames(arm));

  // Connecting to a source and navigating to an object *establish* the columns; there is
  // nothing upstream for them to have renamed. Recognising them by kind rather than by
  // listing every connector is what keeps this from silently failing on the next one.
  const kind = classifyStepKind(expr);
  if (kind === STEP_KINDS.SOURCE || kind === STEP_KINDS.NAVIGATION) return false;

  const call = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(expr);
  if (call) {
    if (!NAME_PRESERVING_FUNCTIONS.has(call[1])) return true;
    return CREATES_MISSING_COLUMNS.test(expr);
  }

  return true;
}

/**
 * Split `if <cond> then <a> else <b>` into its two arms.
 * @returns {[string, string]|null} null when the expression is not a conditional.
 */
function splitConditional(expr) {
  if (!/^if\b/.test(expr)) return null;

  const thenAt = findKeyword(expr, 'then');
  if (thenAt === -1) return null;
  const elseAt = findKeyword(expr, 'else', thenAt + 4);
  if (elseAt === -1) return null;

  return [expr.slice(thenAt + 4, elseAt).trim(), expr.slice(elseAt + 4).trim()];
}

/** Index of a top-level keyword, ignoring nesting and string literals. */
function findKeyword(text, keyword, from = 0) {
  let depth = 0;
  let inStr = false;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '"') inStr = text[i + 1] === '"' ? (i++, true) : false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }

    if (depth === 0 && text.startsWith(keyword, i)) {
      const before = text[i - 1] ?? ' ';
      const after = text[i + keyword.length] ?? ' ';
      if (/\s/.test(before) && /\s/.test(after)) return i;
    }
  }
  return -1;
}

const M_BUILTIN_NAMES =
  /^(let|in|if|then|else|each|try|otherwise|true|false|null|and|or|not|meta|type|error|section|shared|Table|Text|Number|List|Record|Date|DateTime|Duration|Binary|Value|Function|Type|Logical|Web|Sql|Csv|Excel|Json|OData|SharePoint|Power|Fabric|Google|Azure|Snowflake|Databricks|Odbc|Oracle|Teradata|Kusto|SapHana|MySQL|PostgreSQL)$/i;

/** Prior-step names referenced by a step expression. */
export function extractStepRefs(expr) {
  const refs = [];
  const pattern = /(?:^|[,({\s])(?:#"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?=[,[{)]|$)/g;
  let m;
  while ((m = pattern.exec(expr)) !== null) {
    const name = m[1] || m[2];
    if (M_BUILTIN_NAMES.test(name)) continue;
    refs.push(name);
  }
  return [...new Set(refs)];
}

/**
 * Parse M steps for every table in a model.
 * @param {object} parsedModel
 * @returns {Map<string, Array<object>>} table name -> ordered steps
 */
export function parseMStepsFromModel(parsedModel) {
  const expressionBodies = collectExpressionBodies(parsedModel);
  const map = new Map();

  for (const table of parsedModel?.tables || []) {
    for (const mExpr of tableMExprs(table)) {
      const steps = parseMSteps(mExpr, expressionBodies);
      if (steps.length > 0) {
        map.set(table.name, steps);
        break;
      }
    }
  }
  return map;
}
