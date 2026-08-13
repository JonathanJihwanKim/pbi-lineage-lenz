import { describe, it, expect } from 'vitest';
import {
  extractDataSources,
  extractTableLineage,
  parseMSteps,
  classifyStepKind,
  extractSqlTableRefs,
  requiresGateway,
  stripMComments,
  looksLikeMFunction,
  extractAllFromModel,
  extractTableLineageFromModel,
  STEP_KINDS,
} from '../src/parser/mquery.js';

const SQL_SERVER_M = `let
    Source = Sql.Database("prod-sql.company.com", "SalesDW"),
    Nav = Source{[Schema="dbo",Item="FactSales"]}[Data],
    Renamed = Table.RenameColumns(Nav, {{"amt_net_usd","Net Amount USD"},{"cust_id","Customer Id"}}),
    Typed = Table.TransformColumnTypes(Renamed, {{"Net Amount USD", type number}}),
    Filtered = Table.SelectRows(Typed, each [Net Amount USD] > 0)
in Filtered`;

const BIGQUERY_M = `let
    Source = GoogleBigQuery.Database("acme-analytics"),
    Proj = Source{[Name="acme-analytics"]}[Data],
    Ds = Proj{[Name="sales_mart"]}[Data],
    Tbl = Ds{[Name="fact_orders"]}[Data],
    Sel = Table.SelectColumns(Tbl, {"order_id","order_ts","gross_amt"})
in Sel`;

describe('extractDataSources', () => {
  it('reads server and database from Sql.Database', () => {
    const [source] = extractDataSources(SQL_SERVER_M);
    expect(source).toMatchObject({
      type: 'SQL Server',
      server: 'prod-sql.company.com',
      database: 'SalesDW',
    });
  });

  it('reads the project from GoogleBigQuery.Database', () => {
    const [source] = extractDataSources(BIGQUERY_M);
    expect(source).toMatchObject({ type: 'Google BigQuery', server: 'acme-analytics' });
  });

  it('reads server and warehouse from Snowflake.Databases', () => {
    const m = 'let S = Snowflake.Databases("acme.snowflakecomputing.com","COMPUTE_WH") in S';
    expect(extractDataSources(m)[0]).toMatchObject({
      type: 'Snowflake',
      server: 'acme.snowflakecomputing.com',
      database: 'COMPUTE_WH',
    });
  });

  it('captures the SQL text and backing connector of Value.NativeQuery', () => {
    const m = `let S = Value.NativeQuery(Sql.Database("srv","db"), "SELECT id FROM dbo.Customers", null, [EnableFolding=true]) in S`;
    const [source] = extractDataSources(m);
    expect(source.type).toBe('SQL Server');
    expect(source.isNativeQuery).toBe(true);
    expect(source.nativeQuery).toBe('SELECT id FROM dbo.Customers');
  });

  it('detects Fabric Lakehouse, which takes no literal arguments', () => {
    const m = 'let S = Lakehouse.Contents([]) in S';
    expect(extractDataSources(m)[0]).toMatchObject({ type: 'Fabric Lakehouse' });
  });

  it('marks a source parameterized when it references a declared parameter', () => {
    const m = 'let S = Sql.Database(#"ServerParam", #"DbParam") in S';
    const declared = new Set(['ServerParam', 'DbParam']);
    expect(extractDataSources(m, declared)[0].parameterized).toBe(true);
  });

  it('ignores connectors inside comments', () => {
    const m = `let
        // Source = Sql.Database("old-server", "OldDb"),
        /* Legacy = Oracle.Database("legacy-ora") */
        Source = Sql.Database("new-server", "NewDb")
    in Source`;
    const sources = extractDataSources(m);
    expect(sources).toHaveLength(1);
    expect(sources[0].server).toBe('new-server');
  });

  it('does not treat a SQL comment marker inside a string literal as a comment', () => {
    const m = `let S = Value.NativeQuery(Sql.Database("srv","db"), "SELECT a // not a comment", null, []) in S`;
    expect(extractDataSources(m)[0].nativeQuery).toBe('SELECT a // not a comment');
  });
});

describe('stripMComments', () => {
  it('removes line and block comments but keeps string contents', () => {
    expect(stripMComments('a // gone\nb')).toBe('a \nb');
    expect(stripMComments('a /* gone */ b')).toBe('a   b');
    expect(stripMComments('"keep // this"')).toBe('"keep // this"');
  });

  it('handles the M escaped-quote sequence', () => {
    expect(stripMComments('"a""b" // gone')).toBe('"a""b" ');
  });
});

describe('extractTableLineage', () => {
  it('reads schema and table from a Schema/Item navigation', () => {
    const lineage = extractTableLineage(SQL_SERVER_M);
    expect(lineage.physicalSchema).toBe('dbo');
    expect(lineage.physicalTable).toBe('FactSales');
  });

  it('collects rename pairs in source-to-model order', () => {
    expect(extractTableLineage(SQL_SERVER_M).renames).toEqual([
      { sourceName: 'amt_net_usd', modelName: 'Net Amount USD' },
      { sourceName: 'cust_id', modelName: 'Customer Id' },
    ]);
  });

  it('resolves the BigQuery project/dataset/table chain', () => {
    const lineage = extractTableLineage(BIGQUERY_M);
    expect(lineage.physicalProject).toBe('acme-analytics');
    expect(lineage.physicalDataset).toBe('sales_mart');
    expect(lineage.physicalTable).toBe('fact_orders');
  });

  it('records an explicit projection', () => {
    expect(extractTableLineage(BIGQUERY_M).selectedColumns).toEqual(['order_id', 'order_ts', 'gross_amt']);
  });

  it('prunes removed columns out of the projection', () => {
    const m = `let
        S = Sql.Database("s","d"),
        N = S{[Schema="dbo",Item="T"]}[Data],
        Sel = Table.SelectColumns(N, {"a","b","c","d"}),
        Rem = Table.RemoveColumns(Sel, {"c"})
    in Rem`;
    expect(extractTableLineage(m).selectedColumns).toEqual(['a', 'b', 'd']);
  });

  it('records joins with their key columns', () => {
    const m = `let
        A = Sql.Database("s","d"),
        L = A{[Schema="dbo",Item="Orders"]}[Data],
        R = A{[Schema="dbo",Item="Customers"]}[Data],
        J = Table.NestedJoin(L, {"CustomerId"}, R, {"Id"}, "Cust", JoinKind.LeftOuter)
    in J`;
    expect(extractTableLineage(m).joins[0]).toMatchObject({
      type: 'NestedJoin',
      leftKeys: ['CustomerId'],
      rightKeys: ['Id'],
    });
  });

  it('records columns added in Power Query', () => {
    const m = `let
        S = Sql.Database("s","d"),
        N = S{[Schema="dbo",Item="T"]}[Data],
        Added = Table.AddColumn(N, "Margin", each [Revenue] - [Cost])
    in Added`;
    expect(extractTableLineage(m).addedColumns).toEqual(['Margin']);
  });
});

describe('parseMSteps', () => {
  it('returns steps in order with their names', () => {
    expect(parseMSteps(SQL_SERVER_M).map((s) => s.name)).toEqual([
      'Source', 'Nav', 'Renamed', 'Typed', 'Filtered',
    ]);
  });

  it('classifies each step kind', () => {
    expect(parseMSteps(SQL_SERVER_M).map((s) => s.kind)).toEqual([
      STEP_KINDS.SOURCE,
      STEP_KINDS.NAVIGATION,
      STEP_KINDS.RENAME,
      STEP_KINDS.TYPE_CHANGE,
      STEP_KINDS.FILTER,
    ]);
  });

  it('follows a shared expression reference', () => {
    const steps = parseMSteps('let Source = shared_src in Source', { shared_src: SQL_SERVER_M });
    expect(steps.map((s) => s.name)).toEqual(['Source', 'Nav', 'Renamed', 'Typed', 'Filtered']);
  });

  it('does not split on a comma inside a string literal', () => {
    const m = `let
        S = Sql.Database("host,with,commas", "db"),
        N = S{[Schema="dbo",Item="T"]}[Data]
    in N`;
    expect(parseMSteps(m).map((s) => s.name)).toEqual(['S', 'N']);
  });

  it('returns no steps for an expression without a let block', () => {
    expect(parseMSteps('Sql.Database("s","d")')).toEqual([]);
  });
});

describe('classifyStepKind', () => {
  it.each([
    ['Sql.Database("s","d")', STEP_KINDS.SOURCE],
    ['Source{[Schema="dbo",Item="T"]}[Data]', STEP_KINDS.NAVIGATION],
    ['Table.SelectColumns(x, {"a"})', STEP_KINDS.PROJECTION],
    ['Table.RenameColumns(x, {{"a","b"}})', STEP_KINDS.RENAME],
    ['Table.SelectRows(x, each true)', STEP_KINDS.FILTER],
    ['Table.NestedJoin(a,{"k"},b,{"k"},"c")', STEP_KINDS.JOIN],
    ['Table.AddColumn(x, "c", each 1)', STEP_KINDS.ADD_COLUMN],
    ['Table.TransformColumnTypes(x, {})', STEP_KINDS.TYPE_CHANGE],
    ['Table.ExpandTableColumn(x, "c", {})', STEP_KINDS.EXPAND],
    ['List.Sum({1,2})', STEP_KINDS.CUSTOM],
  ])('classifies %s', (expr, expected) => {
    expect(classifyStepKind(expr)).toBe(expected);
  });
});

describe('extractSqlTableRefs', () => {
  it('finds tables behind FROM and JOIN, unquoted', () => {
    const sql = 'SELECT * FROM `proj.ds.orders` o JOIN dbo.Customers c ON o.id = c.id';
    expect(extractSqlTableRefs(sql).sort()).toEqual(['Customers', 'orders'].sort());
  });
});

describe('requiresGateway', () => {
  it('requires a gateway for an on-prem SQL Server', () => {
    expect(requiresGateway({ type: 'SQL Server', server: 'prod-sql.corp.local' })).toBe(true);
  });

  it('does not require one for Azure SQL', () => {
    expect(requiresGateway({ type: 'SQL Server', server: 'x.database.windows.net' })).toBe(false);
  });

  it('does not require one for cloud connectors', () => {
    expect(requiresGateway({ type: 'Snowflake' })).toBe(false);
  });

  it('returns null when the connector kind is unknown', () => {
    expect(requiresGateway({ type: 'Something Else' })).toBe(null);
  });
});

describe('looksLikeMFunction', () => {
  it('detects a function declaration', () => {
    expect(looksLikeMFunction('let f = (a, b) => a + b in f')).toBe(true);
    expect(looksLikeMFunction('(x) => x * 2')).toBe(true);
  });

  it('does not flag a query', () => {
    expect(looksLikeMFunction(SQL_SERVER_M)).toBe(false);
  });
});

describe('model-level extraction', () => {
  const model = {
    tables: [
      { name: 'Sales', partitions: [{ name: 'p', source: 'let Source = sales_src in Source' }] },
      { name: 'Orders', partitions: [{ name: 'p', source: BIGQUERY_M }] },
    ],
    expressions: [
      { name: 'sales_src', expression: SQL_SERVER_M },
      { name: 'helper', expression: 'let f = (a) => a in f', resultType: 'function' },
    ],
  };

  it('resolves a delegating partition through its shared expression', () => {
    const lineage = extractTableLineageFromModel(model);
    expect(lineage.get('Sales').physicalTable).toBe('FactSales');
  });

  it('collects sources across tables and deduplicates them', () => {
    const types = extractAllFromModel(model).map((s) => s.type).sort();
    expect(types).toEqual(['Google BigQuery', 'SQL Server']);
  });

  it('excludes M function declarations from source scanning', () => {
    expect(extractAllFromModel(model).some((s) => s.expressionName === 'helper')).toBe(false);
  });
});
