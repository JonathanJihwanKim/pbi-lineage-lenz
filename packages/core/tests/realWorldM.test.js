/**
 * Regression tests for M patterns found in a real production PBIP.
 *
 * Every case here resolved to `unknown` before the pattern was supported. They are kept
 * verbatim (names aside) because each one silently zeroed out lineage for a whole model:
 * the synthetic fixtures all passed while real coverage sat at 0.2%.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDataSources,
  extractTableLineage,
  extractNavigationSteps,
  resolveMStringConcat,
  extractSqlTablePath,
  collectParamValues,
} from '../src/parser/mquery.js';
import { resolveSourceNames, CONFIDENCE } from '../src/naming/sourceNameResolver.js';

/** Parameters as this project's tmdlParser emits them: value already unquoted. */
const PARAMS = new Map([
  ['_BillingProject', 'contoso-analytics-prod'],
  ['_ReportId', 'RETAIL'],
  ['_Dataset', 'report_orders'],
]);

const BQ_NATIVE_M = `let
    Source = Value.NativeQuery(GoogleBigQuery.Database([UseStorageApi=false, BillingProject=_BillingProject]){[Name=_BillingProject]}[Data], "SELECT * FROM \`" & _BillingProject & ".report_calendar.calendar_func_dim\` ('" & _ReportId & "')", null, [EnableFolding=true])
in
    Source`;

describe('BigQuery options-record connector', () => {
  it('reads the billing project out of the options record', () => {
    // `GoogleBigQuery.Database([BillingProject=_BillingProject])` passes the project as a
    // record field, not a string argument.
    const [source] = extractDataSources(BQ_NATIVE_M, undefined, PARAMS);
    expect(source.type).toBe('Google BigQuery');
    expect(source.server).toBe('contoso-analytics-prod');
  });

  it('leaves the project unresolved rather than wrong when the parameter is unknown', () => {
    const [source] = extractDataSources(BQ_NATIVE_M, undefined, new Map());
    expect(source.server).toBe('_BillingProject');
    expect(source.parameterized).toBe(true);
  });
});

describe('parameterized native SQL', () => {
  it('assembles SQL built by string concatenation', () => {
    const [source] = extractDataSources(BQ_NATIVE_M, undefined, PARAMS);
    expect(source.nativeQuery).toBe(
      "SELECT * FROM `contoso-analytics-prod.report_calendar.calendar_func_dim` ('RETAIL')"
    );
    expect(source.nativeQueryComplete).toBe(true);
  });

  it('stops at the first literal when concatenation is not evaluated', () => {
    // The pre-fix behaviour, kept as a guard: taking only the first string literal
    // truncates the SQL to "SELECT * FROM `" and loses the table entirely.
    const [source] = extractDataSources(BQ_NATIVE_M, undefined, PARAMS);
    expect(source.nativeQuery).not.toBe('SELECT * FROM `');
  });

  it('marks the SQL incomplete and shows the gap when a parameter is unknown', () => {
    const [source] = extractDataSources(BQ_NATIVE_M, undefined, new Map([['_BillingProject', 'proj']]));
    expect(source.nativeQueryComplete).toBe(false);
    expect(source.nativeQuery).toContain('{_ReportId}');
  });
});

describe('resolveMStringConcat', () => {
  it('joins literals and parameter values', () => {
    expect(resolveMStringConcat('"a" & _ReportId & "b"', PARAMS)).toEqual({
      text: 'aRETAILb', complete: true,
    });
  });

  it('handles the M escaped quote', () => {
    expect(resolveMStringConcat('"say ""hi"""', PARAMS).text).toBe('say "hi"');
  });

  it('marks unknown names inline instead of dropping them', () => {
    const result = resolveMStringConcat('"x" & _Missing', PARAMS);
    expect(result.text).toBe('x{_Missing}');
    expect(result.complete).toBe(false);
  });

  it('resolves a quoted identifier reference', () => {
    expect(resolveMStringConcat('#"_ReportId"', PARAMS).text).toBe('RETAIL');
  });
});

describe('navigation records', () => {
  it('resolves a parameter-valued Name', () => {
    const steps = extractNavigationSteps('Source{[Name=_BillingProject]}[Data]', PARAMS);
    expect(steps).toEqual([{ Name: 'contoso-analytics-prod' }]);
  });

  it('reads a record that carries a Kind alongside Name', () => {
    // The original pattern required Name to be the record's only field, so every
    // kind-tagged BigQuery and Fabric navigation step was skipped.
    const steps = extractNavigationSteps('x{[Name="report_calendar",Kind="Schema"]}[Data]', PARAMS);
    expect(steps).toEqual([{ Name: 'report_calendar', Kind: 'Schema' }]);
  });

  it('resolves a #"quoted" identifier reference', () => {
    const steps = extractNavigationSteps('x{[Name=#"_Dataset",Kind="Schema"]}[Data]', PARAMS);
    expect(steps[0].Name).toBe('report_orders');
  });

  it('maps a kind-tagged chain to schema and table', () => {
    const m = `let
        Source = GoogleBigQuery.Database([BillingProject=_BillingProject]),
        Proj = Source{[Name=_BillingProject]}[Data],
        Sch = Proj{[Name="report_calendar",Kind="Schema"]}[Data],
        Tbl = Sch{[Name="date_dim",Kind="Table"]}[Data]
    in Tbl`;
    const lineage = extractTableLineage(m, PARAMS);
    expect(lineage.physicalSchema).toBe('report_calendar');
    expect(lineage.physicalTable).toBe('date_dim');
    expect(lineage.physicalProject).toBe('contoso-analytics-prod');
  });

  it('does not mistake the billing project for a table under a native query', () => {
    // `{[Name=_BillingProject]}` is connector-level navigation. Treating it positionally
    // would name the table "contoso-analytics-prod".
    const lineage = extractTableLineage(BQ_NATIVE_M, PARAMS);
    expect(lineage.physicalTable).not.toBe('contoso-analytics-prod');
  });
});

describe('extractSqlTablePath', () => {
  it('splits a BigQuery backtick-quoted three-part path', () => {
    expect(extractSqlTablePath('SELECT * FROM `proj.dataset.tbl` (\'X\')')).toEqual({
      project: 'proj', dataset: 'dataset', table: 'tbl',
    });
  });

  it('handles a two-part path', () => {
    expect(extractSqlTablePath('SELECT a FROM dbo.Orders')).toEqual({
      project: null, dataset: 'dbo', table: 'Orders',
    });
  });

  it('returns null when there is no FROM', () => {
    expect(extractSqlTablePath('SELECT 1')).toBeNull();
  });
});

describe('collectParamValues', () => {
  it('reads values from the parameters map', () => {
    const values = collectParamValues({ parameters: new Map([['_A', 'x']]), expressions: [] });
    expect(values.get('_A')).toBe('x');
  });

  it('reads a value out of a meta-annotated parameter expression', () => {
    const values = collectParamValues({
      expressions: [{ name: '_B', mExpression: '"y" meta [IsParameterQuery=true, Type="Text"]' }],
    });
    expect(values.get('_B')).toBe('y');
  });

  it('reads a bare value from an expression already classified as a parameter', () => {
    const values = collectParamValues({
      expressions: [{ name: '_C', mExpression: 'z', kind: 'parameter' }],
    });
    expect(values.get('_C')).toBe('z');
  });
});

describe('end to end on the production shape', () => {
  const model = {
    tables: [
      {
        name: 'Store',
        columns: [
          { name: 'Store Code', sourceColumn: 'Store Code' },
          { name: 'Passthrough Column', sourceColumn: 'Passthrough Column' },
        ],
        partitions: [{
          name: 'p',
          sourceExpression: `let
              Source = bu_dim_src,
              #"Renamed Columns" = Table.RenameColumns(Source,{{"store_code", "Store Code"}})
          in
              #"Renamed Columns"`,
        }],
      },
    ],
    parameters: new Map([['_BillingProject', 'contoso-analytics-prod'], ['_ReportId', 'RETAIL']]),
    expressions: [
      { name: '_BillingProject', mExpression: 'contoso-analytics-prod', kind: 'parameter' },
      { name: '_ReportId', mExpression: 'RETAIL', kind: 'parameter' },
      {
        name: 'bu_dim_src',
        kind: 'expression',
        mExpression: `let
            Source = Value.NativeQuery(GoogleBigQuery.Database([UseStorageApi=false, BillingProject=_BillingProject]){[Name=_BillingProject]}[Data], "SELECT * FROM \`" & _BillingProject & ".report_stores.store_cur_func_dim\` ('" & _ReportId & "')", null, [EnableFolding=true])
        in Source`,
      },
    ],
  };

  it('resolves a renamed column through delegation, parameters, and native SQL', () => {
    const column = resolveSourceNames(model).columns.get('Store[Store Code]');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.physicalPath).toBe(
      'contoso-analytics-prod.report_stores.store_cur_func_dim.store_code'
    );
  });

  it('resolves a pass-through column onto the same physical table', () => {
    // Exact rather than inferred: the chain here is delegation, a native SELECT *, and a
    // rename that touches a different column. Nothing in it can rename this one, so its
    // source name is determined — the same standing as the renamed column above, reached
    // by deduction instead of by reading a pair.
    const column = resolveSourceNames(model).columns.get('Store[Passthrough Column]');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.physical.table).toBe('store_cur_func_dim');
    expect(column.physical.column).toBe('Passthrough Column');
  });
});
