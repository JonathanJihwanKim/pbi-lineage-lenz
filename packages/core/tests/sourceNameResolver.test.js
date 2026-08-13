import { describe, it, expect } from 'vitest';
import {
  resolveSourceNames,
  parseSqlSelectList,
  formatPhysicalTablePath,
  formatPhysicalColumnPath,
  toSourceMapRows,
  CONFIDENCE,
  ORIGIN,
} from '../src/naming/sourceNameResolver.js';

/** Build a minimal parsed model around one table's M expression. */
function modelWith(mExpr, columns, extra = {}) {
  return {
    tables: [
      {
        name: 'Sales',
        columns: columns.map((c) => (typeof c === 'string' ? { name: c } : c)),
        calculatedColumns: extra.calculatedColumns || [],
        partitions: [{ name: 'p', source: mExpr }],
        ...extra.table,
      },
    ],
    expressions: extra.expressions || [],
  };
}

const RENAMED_M = `let
    Source = Sql.Database("prod-sql.company.com", "SalesDW"),
    Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
    Renamed = Table.RenameColumns(Nav, {{"amt_net_usd","Net Amount"},{"cust_id","Customer Id"}})
in Renamed`;

describe('resolveSourceNames — exact mappings', () => {
  it('resolves a renamed column back to its physical source column', () => {
    const resolved = resolveSourceNames(modelWith(RENAMED_M, ['Net Amount', 'Customer Id']));
    const col = resolved.columns.get('Sales[Net Amount]');

    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.origin).toBe(ORIGIN.SOURCE);
    expect(col.physical.column).toBe('amt_net_usd');
    expect(col.physical.schema).toBe('dbo');
    expect(col.physical.table).toBe('FactSales');
    expect(col.physical.database).toBe('SalesDW');
    expect(col.physical.system).toBe('SQL Server');
  });

  it('builds the fully qualified physical path a data engineer can paste into a query', () => {
    const resolved = resolveSourceNames(modelWith(RENAMED_M, ['Net Amount']));
    expect(resolved.columns.get('Sales[Net Amount]').physicalPath).toBe('SalesDW.dbo.FactSales.amt_net_usd');
  });

  it('treats a column kept by an explicit projection as exact', () => {
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="T"]}[Data],
        Sel = Table.SelectColumns(Nav, {"order_id","gross_amt"})
    in Sel`;
    const col = resolveSourceNames(modelWith(m, ['order_id'])).columns.get('Sales[order_id]');
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physical.column).toBe('order_id');
  });

  it('resolves through a shared expression the partition delegates to', () => {
    const model = modelWith('let Source = sales_src in Source', ['Net Amount'], {
      expressions: [{ name: 'sales_src', expression: RENAMED_M }],
    });
    const col = resolveSourceNames(model).columns.get('Sales[Net Amount]');
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physical.column).toBe('amt_net_usd');
    expect(col.physical.table).toBe('FactSales');
  });

  it('resolves the BigQuery three-part path', () => {
    const m = `let
        Source = GoogleBigQuery.Database("acme-analytics"),
        Proj = Source{[Name="acme-analytics"]}[Data],
        Ds = Proj{[Name="sales_mart"]}[Data],
        Tbl = Ds{[Name="fact_orders"]}[Data],
        Sel = Table.SelectColumns(Tbl, {"order_id","gross_amt"})
    in Sel`;
    const col = resolveSourceNames(modelWith(m, ['gross_amt'])).columns.get('Sales[gross_amt]');
    expect(col.physical.project).toBe('acme-analytics');
    expect(col.physical.dataset).toBe('sales_mart');
    expect(col.physical.table).toBe('fact_orders');
    expect(col.physicalPath).toBe('acme-analytics.sales_mart.fact_orders.gross_amt');
  });

  it('names columns from an explicit native SQL select list', () => {
    const m = `let
        Source = Value.NativeQuery(Sql.Database("srv","db"), "SELECT id, total_amt FROM dbo.Orders", null, [])
    in Source`;
    const col = resolveSourceNames(modelWith(m, ['total_amt'])).columns.get('Sales[total_amt]');
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physical.column).toBe('total_amt');
    expect(col.physical.table).toBe('Orders');
  });
});

describe('resolveSourceNames — pass-through columns', () => {
  // Whether a pass-through is a deduction or a guess turns on one question: is the whole
  // chain accounted for? With every step known and none of them able to rename a column,
  // the source name cannot differ from the model name. With an unreadable step in the
  // way, it can.

  it('states the name when every step in the chain is known and none renames', () => {
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data]
    in Nav`;
    const col = resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]');

    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.origin).toBe(ORIGIN.SOURCE);
    expect(col.physical.column).toBe('Quantity');
    expect(col.reason).toMatch(/none of them renames/i);
  });

  it('states the name behind SELECT * too, for the same reason', () => {
    // SELECT * returns the source's columns unchanged, so it is navigation by another
    // route. What made the old label right was never the star — it was not knowing what
    // happened afterwards.
    const m = `let
        Source = Value.NativeQuery(GoogleBigQuery.Database("p"), "SELECT * FROM \`proj.sales.orders\`", null, [])
    in Source`;
    const col = resolveSourceNames(modelWith(m, ['gross_amt'])).columns.get('Sales[gross_amt]');

    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physicalPath).toBe('proj.sales.orders.gross_amt');
  });

  it('sees through a branch whose arms are row filters', () => {
    // `if DatasetFilter = 1 then #"Filtered" else Base` is the single commonest shape in
    // a real model, and it filters *rows*. An earlier rule rejected it for not being a
    // recognised category, which is a question about the parser rather than about names,
    // and it cost 120 columns of one model their correct label.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
        Filtered = Table.SelectRows(Nav, each [x] > 1),
        Branch = if Flag = 1 then Filtered else Nav
    in Branch`;
    const col = resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]');

    expect(col.confidence).toBe(CONFIDENCE.EXACT);
  });

  it('falls back to assumed when a step really can rename', () => {
    // `Table.TransformColumnNames` rewrites every header by a function nobody can read
    // statically. This is what `inferred` is for.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
        Renamed = Table.TransformColumnNames(Nav, Text.Upper)
    in Renamed`;
    const col = resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]');

    expect(col.confidence).toBe(CONFIDENCE.INFERRED);
    expect(col.physical.column).toBe('Quantity');
    expect(col.reason).toMatch(/assumed/i);
    expect(col.reason).toMatch(/cannot read/i);
  });

  it('is only as safe as the least safe arm of a branch', () => {
    // The recursion has to fail closed: one arm that promotes headers poisons the branch
    // even though the other is harmless.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
        Branch = if Flag = 1 then Table.PromoteHeaders(Nav) else Nav
    in Branch`;
    expect(resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]').confidence)
      .toBe(CONFIDENCE.INFERRED);
  });

  it('withdraws the guarantee when a transform can invent a column', () => {
    // `MissingField.UseNull` makes Table.TransformColumnTypes create a column that has no
    // source at all — found in Microsoft's own Example 4 for that function, not by
    // guessing at the signature.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
        Typed = Table.TransformColumnTypes(Nav, {{"Quantity", type number}}, [Culture="en-US", MissingField=MissingField.UseNull])
    in Typed`;
    expect(resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]').confidence)
      .toBe(CONFIDENCE.INFERRED);
  });

  it('falls back to assumed when tables are appended', () => {
    // Table.Combine unions two tables, so a column may come from either. Naming one of
    // them would be a guess wearing a deduction's clothes.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
        Both = Table.Combine({Nav, Nav})
    in Both`;
    const col = resolveSourceNames(modelWith(m, ['Quantity'])).columns.get('Sales[Quantity]');
    expect(col.confidence).toBe(CONFIDENCE.INFERRED);
  });
});

describe('resolveSourceNames — honest unknowns', () => {
  it('reports unknown when no physical table can be resolved', () => {
    const col = resolveSourceNames(modelWith('let Source = #table({"a"},{{1}}) in Source', ['a']))
      .columns.get('Sales[a]');
    expect(col.confidence).toBe(CONFIDENCE.UNKNOWN);
    expect(col.physical).toBeNull();
  });

  it('reports unknown for a column missing from an explicit projection', () => {
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="T"]}[Data],
        Sel = Table.SelectColumns(Nav, {"a","b"})
    in Sel`;
    const col = resolveSourceNames(modelWith(m, ['c'])).columns.get('Sales[c]');
    expect(col.confidence).toBe(CONFIDENCE.UNKNOWN);
  });

  it('reports unknown for a column absent from the native SQL select list', () => {
    const m = `let
        Source = Value.NativeQuery(Sql.Database("srv","db"), "SELECT id FROM dbo.Orders", null, [])
    in Source`;
    const col = resolveSourceNames(modelWith(m, ['not_selected'])).columns.get('Sales[not_selected]');
    expect(col.confidence).toBe(CONFIDENCE.UNKNOWN);
  });

  it('reports unknown for a table with no Power Query expression', () => {
    const model = {
      tables: [{ name: 'Sales', columns: [{ name: 'a' }], partitions: [] }],
      expressions: [],
    };
    const col = resolveSourceNames(model).columns.get('Sales[a]');
    expect(col.confidence).toBe(CONFIDENCE.UNKNOWN);
    expect(col.reason).toMatch(/no Power Query expression/i);
  });
});

describe('resolveSourceNames — computed columns', () => {
  it('marks a DAX calculated column as computed, not as a source column', () => {
    const model = modelWith(RENAMED_M, ['Net Amount'], {
      calculatedColumns: [{ name: 'Margin', expression: 'Sales[Net Amount] * 0.2' }],
    });
    const col = resolveSourceNames(model).columns.get('Sales[Margin]');

    expect(col.origin).toBe(ORIGIN.COMPUTED_DAX);
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physical).toBeNull();
  });

  it('marks a Power Query added column as computed', () => {
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="T"]}[Data],
        Added = Table.AddColumn(Nav, "Margin", each [Revenue] - [Cost])
    in Added`;
    const col = resolveSourceNames(modelWith(m, ['Margin'])).columns.get('Sales[Margin]');

    expect(col.origin).toBe(ORIGIN.COMPUTED_PQ);
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
    expect(col.physical).toBeNull();
  });
});

describe('resolveSourceNames — sourceColumn indirection', () => {
  it('maps through the TMDL sourceColumn when it differs from the model column name', () => {
    const model = modelWith(RENAMED_M, [{ name: 'Revenue', sourceColumn: 'Net Amount' }]);
    const col = resolveSourceNames(model).columns.get('Sales[Revenue]');

    expect(col.pqName).toBe('Net Amount');
    expect(col.physical.column).toBe('amt_net_usd');
    expect(col.confidence).toBe(CONFIDENCE.EXACT);
  });
});

describe('resolveSourceNames — stats', () => {
  it('counts confidence levels and reports coverage', () => {
    const model = modelWith(RENAMED_M, ['Net Amount', 'Quantity'], {
      calculatedColumns: [{ name: 'Margin', expression: '1' }],
    });
    const { stats } = resolveSourceNames(model);

    expect(stats.total).toBe(3);
    // Renamed column, DAX calculated column, and `Quantity` — which passes through a
    // chain with nothing unreadable in it, so its source name is stated by the absence
    // of any renaming step rather than assumed.
    expect(stats.exact).toBe(3);
    expect(stats.inferred).toBe(0);
    expect(stats.unknown).toBe(0);
    expect(stats.coverage).toBe(1);
  });

  it('separates what is stated from what is assumed', () => {
    // Coverage counts exact and inferred together, so it cannot fall when a mapping
    // quietly degrades from stated to assumed. This ratio can.
    const m = `let
        Source = Sql.Database("s","d"),
        Nav = Source{[Schema="dbo",Item="T"]}[Data],
        Renamed = Table.TransformColumnNames(Nav, Text.Upper)
    in Renamed`;
    const { stats } = resolveSourceNames(modelWith(m, ['a', 'b']));

    expect(stats.exact).toBe(0);
    expect(stats.inferred).toBe(2);
    expect(stats.coverage).toBe(1);
  });
});

describe('parseSqlSelectList', () => {
  it('flags SELECT * as unknowable', () => {
    expect(parseSqlSelectList('SELECT * FROM t')).toEqual({ star: true, columns: [] });
  });

  it('flags a qualified star as unknowable', () => {
    expect(parseSqlSelectList('SELECT t.* FROM t').star).toBe(true);
  });

  it('reads plain and qualified column names', () => {
    const result = parseSqlSelectList('SELECT id, o.total FROM orders o');
    expect(result.star).toBe(false);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'total']);
  });

  it('uses the alias as the output name', () => {
    const result = parseSqlSelectList('SELECT amt_net_usd AS net_amount FROM t');
    expect(result.columns[0]).toMatchObject({ name: 'net_amount', alias: 'net_amount' });
  });

  it('does not split on a comma inside a function call', () => {
    const result = parseSqlSelectList('SELECT COALESCE(a, b) AS c, d FROM t');
    expect(result.columns.map((c) => c.name)).toEqual(['c', 'd']);
  });

  it('ignores a FROM inside a subquery when finding the select list', () => {
    const result = parseSqlSelectList('SELECT (SELECT MAX(x) FROM y) AS mx, z FROM t');
    expect(result.columns.map((c) => c.name)).toEqual(['mx', 'z']);
  });

  it('returns null when there is no SELECT', () => {
    expect(parseSqlSelectList('UPDATE t SET a = 1')).toBeNull();
  });
});

describe('path formatting', () => {
  it('orders a physical table path from most to least qualified', () => {
    expect(formatPhysicalTablePath({ database: 'SalesDW', schema: 'dbo', table: 'FactSales' }))
      .toBe('SalesDW.dbo.FactSales');
  });

  it('returns null when nothing is known', () => {
    expect(formatPhysicalTablePath({})).toBeNull();
    expect(formatPhysicalColumnPath(null)).toBeNull();
  });
});

describe('toSourceMapRows', () => {
  it('flattens resolved columns into exportable rows', () => {
    const resolved = resolveSourceNames(modelWith(RENAMED_M, ['Net Amount']));
    const [row] = toSourceMapRows(resolved);

    expect(row).toMatchObject({
      modelTable: 'Sales',
      modelColumn: 'Net Amount',
      sourceTable: 'FactSales',
      sourceColumn: 'amt_net_usd',
      confidence: CONFIDENCE.EXACT,
      origin: ORIGIN.SOURCE,
    });
    expect(row.reason).toBeTruthy();
  });
});
