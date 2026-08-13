/**
 * DAX Parser - Lightweight parser for DAX expressions.
 * Extracts references to measures, columns, and tables from DAX formulas
 * to build dependency edges in the lineage graph.
 */

/** DAX functions that take a table as their first argument. */
const TABLE_FUNCTIONS = [
  'CALCULATE', 'CALCULATETABLE', 'FILTER', 'SUMX', 'AVERAGEX',
  'COUNTX', 'MAXX', 'MINX', 'RANKX', 'ADDCOLUMNS', 'SELECTCOLUMNS',
  'RELATEDTABLE', 'ALL', 'ALLEXCEPT', 'VALUES', 'DISTINCT',
  'TOPN', 'GENERATE', 'TABLEOF', 'NAMEOF', 'SAMEPERIODLASTYEAR',
  'DATEADD', 'DATESYTD', 'DATESMTD', 'DATESQTD',
];

/**
 * Strip string literals, line comments, and block comments from DAX
 * so we don't pick up false references inside them.
 * @param {string} dax
 * @returns {string} DAX with strings/comments replaced by whitespace.
 */
function stripStringsAndComments(dax) {
  // Order matters: block comments, line comments, then double-quoted strings
  return dax.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
    .replace(/"(?:[^"\\]|"")*"/g, ' ');
}

/**
 * Extract column references from a DAX expression.
 * Matches patterns like 'Table Name'[Column] or TableName[Column].
 * @param {string} dax - The DAX expression.
 * @returns {Array<{table: string, column: string}>} Array of table-column pairs.
 */
export function extractColumnRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const adHoc = adHocColumnNames(dax);
  const pattern = /(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]/g;
  const refs = [];
  const seen = new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const table = m[1] || m[2];
    const column = m[3];
    const key = `${table}[${column}]`;
    // `SELECTCOLUMNS(…, "Known[X]", …)` invents a column whose *name* contains brackets,
    // so the reference `Known[X]` reads as table `Known`, column `X`. Both are fictional,
    // and the phantom table follows from the phantom column, so excluding the column here
    // removes both.
    if (adHoc.has(key)) continue;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ table, column });
    }
  }
  return refs;
}

/**
 * Extract measure references from a DAX expression.
 * Matches standalone [MeasureName] references not preceded by a table name.
 * @param {string} dax - The DAX expression.
 * @returns {Array<{measure: string}>} Array of referenced measure objects.
 */
export function extractMeasureRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const adHoc = adHocColumnNames(dax);
  const pattern = /(?<![\w'])\[([^\]]+)\]/g;
  const refs = [];
  const seen = new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const measure = m[1];
    // `ADDCOLUMNS(…, "@value", [Sales])` then `NOT([@value] = BLANK())` — `[@value]` is
    // a column this expression just invented, not a measure. It reads identically, so
    // without this every such expression reports a broken reference to a measure that
    // was never supposed to exist.
    if (adHoc.has(measure)) continue;
    if (!seen.has(measure)) {
      seen.add(measure);
      refs.push({ measure });
    }
  }
  return refs;
}

/** DAX functions whose arguments declare new column names as string literals. */
const COLUMN_DECLARING_FUNCTIONS = [
  'ADDCOLUMNS', 'SELECTCOLUMNS', 'SUMMARIZE', 'SUMMARIZECOLUMNS',
  'GROUPBY', 'ROW', 'DATATABLE', 'GENERATESERIES', 'TOPNSKIP',
];

/**
 * Column names invented inside this expression by a table constructor.
 *
 * Scoped to the argument list of the declaring call rather than collected from the whole
 * expression: a bare `"Sales",` appears in plenty of `SWITCH` and `CONCATENATE` calls,
 * and excluding on that alone would silently drop a real reference to a measure named
 * `Sales`. Dropping a real dependency is the worse failure, so the span is tracked.
 *
 * @param {string} dax - Raw DAX, with strings intact.
 * @returns {Set<string>}
 */
function adHocColumnNames(dax) {
  const names = new Set();
  const opener = new RegExp(`\\b(?:${COLUMN_DECLARING_FUNCTIONS.join('|')})\\s*\\(`, 'gi');

  let match;
  while ((match = opener.exec(dax)) !== null) {
    const span = argumentSpan(dax, opener.lastIndex - 1);
    if (!span) continue;
    // `"name",` — a literal in a position that names a column.
    const declaration = /"([^"]+)"\s*,/g;
    let declared;
    while ((declared = declaration.exec(span)) !== null) names.add(declared[1]);
  }
  return names;
}

/**
 * Text between the parenthesis at `open` and its match, string-aware.
 * @returns {string|null} null when the parentheses never balance.
 */
function argumentSpan(text, open) {
  let depth = 0;
  let inString = false;

  for (let i = open; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      // DAX escapes a quote by doubling it.
      if (char === '"') inString = text[i + 1] === '"' ? (i++, true) : false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Extract table references from a DAX expression.
 * Finds table names used as first arguments to known DAX iterator/table functions.
 * @param {string} dax - The DAX expression.
 * @returns {string[]} Array of referenced table names (deduplicated).
 */
export function extractTableRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const funcList = TABLE_FUNCTIONS.join('|');
  // Match: FUNCNAME ( 'Table Name' or FUNCNAME ( TableName
  const pattern = new RegExp(
    `(?:${funcList})\\s*\\(\\s*(?:'([^']+)'|([A-Za-z_]\\w*))`,
    'gi'
  );

  const locals = declaredVars(clean);
  const refs = [];
  const seen = new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const quoted = m[1];
    const bare = m[2];
    const table = quoted || bare;
    if (!table || seen.has(table)) continue;

    // A quoted name is unambiguously a table. A bare one has to earn it.
    if (!quoted) {
      // `FILTER(ALL(Dates), …)` captures `ALL`, not `Dates`: the first argument is
      // another call, and its name is a function. Checking for the open parenthesis is
      // structural, so it holds for functions no blocklist has heard of — the previous
      // 12-name keyword list let MAX, COUNTROWS, VALUES and every other nested call
      // through as a table, and on one real model that was most of what it reported.
      if (isCallName(clean, m.index + m[0].length)) {
        // Resume at the nested name rather than past it. `FILTER(ALL(Dates)` is one
        // match that swallows `ALL(`, so skipping ahead would lose `Dates` — the real
        // table — along with the function that was the false positive. The new position
        // is still ahead of this match's start, so the scan cannot stall.
        pattern.lastIndex = m.index + m[0].length - bare.length;
        continue;
      }
      // `VAR _MaxFilters = FILTER(…) … COUNTROWS(_MaxFilters)` — a variable holding a
      // table reads exactly like a table name here, and is not one.
      if (locals.has(bare.toLowerCase())) continue;
      if (isDAXKeyword(bare)) continue;
    }

    seen.add(table);
    refs.push(table);
  }
  return refs;
}

/** True when the identifier ending at `index` is followed by `(`. */
function isCallName(text, index) {
  const rest = text.slice(index);
  return /^\s*\(/.test(rest);
}

/** Names introduced by `VAR <name> =` in this expression, lowercased. */
function declaredVars(clean) {
  const names = new Set();
  const pattern = /\bVAR\s+([A-Za-z_]\w*)/gi;
  let m;
  while ((m = pattern.exec(clean)) !== null) names.add(m[1].toLowerCase());
  return names;
}

/**
 * Check if a name is a DAX keyword/function rather than a table name.
 */
function isDAXKeyword(name) {
  const keywords = new Set([
    'TRUE', 'FALSE', 'BLANK', 'NOT', 'AND', 'OR', 'IN',
    'VAR', 'RETURN', 'IF', 'SWITCH', 'SELECTEDVALUE'
  ]);
  return keywords.has(name.toUpperCase());
}

/**
 * Extract USERELATIONSHIP column references from a DAX expression.
 * USERELATIONSHIP(Table1[Col1], Table2[Col2]) creates alternate join paths.
 * Both referenced columns are part of the measure's lineage.
 * @param {string} dax - The DAX expression.
 * @returns {Array<{fromTable: string, fromColumn: string, toTable: string, toColumn: string}>}
 */
export function extractUseRelationshipRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const pattern = /USERELATIONSHIP\s*\(\s*(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]\s*,\s*(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]\s*\)/gi;
  const refs = [];
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    refs.push({
      fromTable: m[1] || m[2],
      fromColumn: m[3],
      toTable: m[4] || m[5],
      toColumn: m[6],
    });
  }
  return refs;
}

/**
 * Parse a DAX expression and extract all referenced objects.
 * @param {string} daxExpression - The DAX formula text.
 * @returns {{ tableRefs: string[], columnRefs: Array<{table: string, column: string}>, measureRefs: Array<{measure: string, table?: string}>, useRelationshipRefs: Array }}
 */
export function parseDaxExpression(daxExpression) {
  if (!daxExpression || typeof daxExpression !== 'string') {
    return { tableRefs: [], columnRefs: [], measureRefs: [], useRelationshipRefs: [] };
  }

  const columnRefs = extractColumnRefs(daxExpression);
  const measureRefs = extractMeasureRefs(daxExpression);
  const tableRefs = extractTableRefs(daxExpression);
  const useRelationshipRefs = extractUseRelationshipRefs(daxExpression);

  // Also add tables from column refs that aren't already in tableRefs
  const tableSet = new Set(tableRefs);
  for (const col of columnRefs) {
    if (!tableSet.has(col.table)) {
      tableSet.add(col.table);
      tableRefs.push(col.table);
    }
  }

  return { tableRefs, columnRefs, measureRefs, useRelationshipRefs };
}
