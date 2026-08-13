/**
 * The shape of a data model — what each table is *for*, read from how it joins.
 *
 * A relationship list is not a data model. `_orders_agg_fct.date_fk -> Time Period.date_sk`
 * repeated 87 times tells you nothing about the model until you notice that 16 tables only
 * ever point outwards and 24 are only ever pointed at, at which point the star is obvious
 * and the model explains itself.
 *
 * Direction is the whole signal, and it is already in the data. Power BI relationships run
 * many-to-one from fact to dimension, so a table that only originates relationships is a
 * fact and a table that only receives them is a dimension. Nothing here guesses from
 * naming conventions — `_agg_fct` and `_dim` happen to line up in this model and will not
 * in the next one.
 */

/** What a table does in the model, deduced from the direction of its relationships. */
export const TABLE_ROLE = Object.freeze({
  /** Originates relationships and receives none — the many side of every join it is in. */
  FACT: 'fact',
  /** Receives relationships and originates none — the one side. */
  DIMENSION: 'dimension',
  /** Both. A bridge, a snowflaked dimension, or a fact another fact joins to. */
  BRIDGE: 'bridge',
  /** In no relationship at all. Field parameters, disconnected tables, measure holders. */
  STANDALONE: 'standalone',
});

/** Human ordering: the spine of the model first, the loose parts last. */
export const ROLE_ORDER = [
  TABLE_ROLE.FACT, TABLE_ROLE.BRIDGE, TABLE_ROLE.DIMENSION, TABLE_ROLE.STANDALONE,
];

/**
 * Classify every table and index the relationships both ways.
 *
 * @param {object} model - Viewer model.
 * @returns {{
 *   tables: Map<string, {name: string, role: string, outgoing: Array, incoming: Array, degree: number}>,
 *   counts: Record<string, number>,
 *   bidirectional: Array<object>,
 *   inactive: Array<object>,
 *   dangling: Array<object>,
 * }}
 */
export function describeModelShape(model) {
  const tables = new Map();
  const known = new Set();

  for (const table of model?.tables || []) {
    known.add(table.name);
    tables.set(table.name, { name: table.name, role: TABLE_ROLE.STANDALONE, outgoing: [], incoming: [], degree: 0 });
  }

  const bidirectional = [];
  const inactive = [];
  const dangling = [];

  for (const rel of model?.relationships || []) {
    // A relationship naming a table the model does not have is the trace a rename leaves.
    // Reported rather than silently dropped, and never used to invent a table.
    if (!known.has(rel.fromTable) || !known.has(rel.toTable)) {
      dangling.push(rel);
      continue;
    }
    tables.get(rel.fromTable).outgoing.push(rel);
    tables.get(rel.toTable).incoming.push(rel);
    if (rel.crossFilter === 'bothDirections') bidirectional.push(rel);
    if (rel.isActive === false) inactive.push(rel);
  }

  const counts = { fact: 0, dimension: 0, bridge: 0, standalone: 0 };
  for (const entry of tables.values()) {
    entry.degree = entry.outgoing.length + entry.incoming.length;
    entry.role = roleOf(entry.outgoing.length, entry.incoming.length);
    counts[entry.role]++;
  }

  return { tables, counts, bidirectional, inactive, dangling };
}

function roleOf(out, incoming) {
  if (out > 0 && incoming > 0) return TABLE_ROLE.BRIDGE;
  if (out > 0) return TABLE_ROLE.FACT;
  if (incoming > 0) return TABLE_ROLE.DIMENSION;
  return TABLE_ROLE.STANDALONE;
}

/**
 * One table and everything it joins to directly.
 *
 * The unit the model lens draws. Drawing all 61 tables and 87 edges at once produces the
 * hairball the page lens was rebuilt to avoid — and the fix is the same one: draw a
 * neighbourhood, never the whole graph. The widest neighbourhood in a real 61-table model
 * is 12, which fits on a screen without overlapping.
 *
 * @param {object} shape - describeModelShape() output.
 * @param {string} tableName
 * @returns {{name: string, role: string, edges: Array<{
 *   other: string, direction: 'out'|'in', fromColumn: string, toColumn: string,
 *   crossFilter: string|null, isActive: boolean,
 * }>}|null}
 */
export function neighbourhood(shape, tableName) {
  const entry = shape?.tables?.get(tableName);
  if (!entry) return null;

  const edges = [
    ...entry.outgoing.map((rel) => ({
      other: rel.toTable,
      direction: 'out',
      fromColumn: rel.fromColumn,
      toColumn: rel.toColumn,
      crossFilter: rel.crossFilter ?? null,
      isActive: rel.isActive !== false,
    })),
    ...entry.incoming.map((rel) => ({
      other: rel.fromTable,
      direction: 'in',
      fromColumn: rel.fromColumn,
      toColumn: rel.toColumn,
      crossFilter: rel.crossFilter ?? null,
      isActive: rel.isActive !== false,
    })),
  ];

  // Stable and readable: what this table points at, then what points at it, alphabetical.
  edges.sort((a, b) =>
    a.direction === b.direction ? a.other.localeCompare(b.other) : (a.direction === 'out' ? -1 : 1));

  return { name: entry.name, role: entry.role, edges };
}

/** One-line description of a role, for a legend or a tooltip. */
export function describeRole(role) {
  return {
    [TABLE_ROLE.FACT]: 'Points at dimensions and nothing points at it — the many side',
    [TABLE_ROLE.DIMENSION]: 'Filters other tables and joins to none — the one side',
    [TABLE_ROLE.BRIDGE]: 'Both filters and is filtered — a bridge or a snowflaked dimension',
    [TABLE_ROLE.STANDALONE]: 'In no relationship: a field parameter, a measure holder, or disconnected',
  }[role] ?? '';
}
