/**
 * Columns that arrive through a join, and projections that outrank SELECT *.
 *
 * Both bugs here were found by picking one `inferred` column at random to spot-check
 * against the warehouse. The tool claimed `Store[Handover Date]` lived at
 * `…store_cur_func_dim.Handover Date`. It is `handover_date`, and it is in
 * a different table in a different dataset — the M said so twice and the parser read
 * neither statement.
 *
 * That is the failure mode this whole confidence model exists to prevent: not a gap, but
 * a wrong answer delivered in the same tone as a right one.
 */

import { describe, it, expect } from 'vitest';
import { extractTableLineage, classifyStepKind, parseMSteps, STEP_KINDS } from '../src/parser/mquery.js';
import { resolveSourceNames, CONFIDENCE } from '../src/naming/sourceNameResolver.js';

describe('extractTableLineage — joins and expands', () => {
  it('captures the column a joined table lands in', () => {
    const lineage = extractTableLineage(`let
      Merged = Table.NestedJoin(Base, {"store_key"}, other_src, {"store_fk"}, "_NPM", JoinKind.LeftOuter)
    in Merged`);

    expect(lineage.joins[0]).toMatchObject({ rightStep: 'other_src', intoColumn: '_NPM' });
  });

  it('reads the rename an expand performs', () => {
    const lineage = extractTableLineage(`let
      Expanded = Table.ExpandTableColumn(Merged, "_NPM", {"handover_date"}, {"Handover Date"})
    in Expanded`);

    expect(lineage.expands).toEqual([
      { intoColumn: '_NPM', sourceName: 'handover_date', modelName: 'Handover Date' },
    ]);
  });

  it('keeps the original name when the expand does not rename', () => {
    // The fourth argument is optional; without it the column arrives under its own name.
    const lineage = extractTableLineage(`let
      Expanded = Table.ExpandTableColumn(Merged, "_NPM", {"amount"})
    in Expanded`);

    expect(lineage.expands).toEqual([{ intoColumn: '_NPM', sourceName: 'amount', modelName: 'amount' }]);
  });

  it('pairs several expanded columns with their new names', () => {
    const lineage = extractTableLineage(`let
      Expanded = Table.ExpandTableColumn(Merged, "_x", {"a", "b"}, {"A", "B"})
    in Expanded`);

    expect(lineage.expands.map((e) => [e.sourceName, e.modelName])).toEqual([['a', 'A'], ['b', 'B']]);
  });
});

describe('classifyStepKind — quoted step names', () => {
  it('recognises navigation off a quoted step name', () => {
    // M requires quoting a step name that is not a bare identifier, and BigQuery project
    // names are hyphenated by convention — so `#"contoso-analytics-prod"{[Name=…]}[Data]` is
    // the ordinary shape, not an exotic one. Matching only `\w+` labelled every one of
    // them Custom, which reads as "the tool does not understand this step" about the
    // plainest step in the chain.
    expect(classifyStepKind('#"contoso-analytics-prod"{[Name="report_calendar",Kind="Schema"]}[Data]'))
      .toBe(STEP_KINDS.NAVIGATION);
  });

  it('still recognises navigation off a bare step name', () => {
    expect(classifyStepKind('Source{[Schema="dbo",Item="FactSales"]}[Data]')).toBe(STEP_KINDS.NAVIGATION);
  });

  it('does not mistake a table function for navigation', () => {
    expect(classifyStepKind('Table.SelectColumns(Source, {"a"})')).toBe(STEP_KINDS.PROJECTION);
    expect(classifyStepKind('Table.RenameColumns(Source, {{"a","b"}})')).toBe(STEP_KINDS.RENAME);
  });

  it('still says Custom for something genuinely unrecognised', () => {
    // The label has to keep meaning something, because it is the signal that the chain
    // is not fully understood.
    expect(classifyStepKind('if DatasetFilter = 1 then Filtered else Base')).toBe(STEP_KINDS.CUSTOM);
  });
});

describe('resolveSourceNames — a joined column belongs to the joined table', () => {
  const model = {
    expressions: [
      {
        name: 'bu_src',
        mExpression: `let
          Source = Value.NativeQuery(GoogleBigQuery.Database(){[Name="proj"]}[Data], "SELECT * FROM \`proj.units.store_dim\`"),
          Kept = Table.SelectColumns(Source, {"store_key", "longitude"})
        in Kept`,
      },
      {
        name: 'switch_src',
        mExpression: `let
          Source = Value.NativeQuery(GoogleBigQuery.Database(){[Name="proj"]}[Data], "SELECT * FROM \`proj.orders.handover_times_fct\`")
        in Source`,
      },
    ],
    tables: [{
      name: 'Store',
      columns: [
        { name: 'store_key' },
        { name: 'longitude' },
        { name: 'Handover Date' },
      ],
      partitions: [{
        name: 'p',
        sourceExpression: `let
          Source = bu_src,
          Merged = Table.NestedJoin(Source, {"store_key"}, switch_src, {"store_fk"}, "_NPM", JoinKind.LeftOuter),
          Expanded = Table.ExpandTableColumn(Merged, "_NPM", {"handover_date"}, {"Handover Date"})
        in Expanded`,
      }],
    }],
  };

  const resolved = resolveSourceNames(model);
  const column = (name) => resolved.columns.get(`Store[${name}]`);

  it('points a joined column at the joined table, not the one it was merged onto', () => {
    const handover = column('Handover Date');
    expect(handover.physical.table).toBe('handover_times_fct');
    expect(handover.physical.schema).toBe('orders');
  });

  it('uses the source-side name the expand states', () => {
    expect(column('Handover Date').physical.column).toBe('handover_date');
    expect(column('Handover Date').physicalPath).toBe('proj.orders.handover_times_fct.handover_date');
  });

  it('calls it exact, because the M states both halves outright', () => {
    expect(column('Handover Date').confidence).toBe(CONFIDENCE.EXACT);
    expect(column('Handover Date').reason).toMatch(/Joined in from/);
  });

  it('does not leak the joined column into the base table', () => {
    expect(column('store_key').physical.table).toBe('store_dim');
  });
});

describe('parseMSteps — the chain reads end to end', () => {
  const bodies = {
    src: `let
      Source = GoogleBigQuery.Database([BillingProject=_P]),
      #"proj" = Source{[Name=_P]}[Data],
      Schema = #"proj"{[Name="ds",Kind="Schema"]}[Data],
      View = Schema{[Name="the_view",Kind="View"]}[Data]
    in View`,
  };

  it('splices a shared expression in rather than replacing the partition', () => {
    // Substituting threw the partition's own steps away. On one real model that hid 20
    // of 21 rename steps: the displayed lineage showed navigation only, so a reader
    // auditing it would conclude no column was renamed — the opposite of the truth.
    const steps = parseMSteps(`let
      Source = src,
      #"Renamed Columns" = Table.RenameColumns(Source, {{"correction_text", "Correction Description"}})
    in #"Renamed Columns"`, bodies);

    expect(steps.map((s) => s.kind)).toEqual([
      STEP_KINDS.SOURCE, STEP_KINDS.NAVIGATION, STEP_KINDS.NAVIGATION, STEP_KINDS.NAVIGATION,
      STEP_KINDS.RENAME,
    ]);
  });

  it('records which expression each borrowed step came from', () => {
    const steps = parseMSteps('let Source = src, Filtered = Table.SelectRows(Source, each true) in Filtered', bodies);
    expect(steps.filter((s) => s.via === 'src')).toHaveLength(4);
    expect(steps.at(-1).via).toBeUndefined();
  });

  it('still expands a partition that is nothing but a reference', () => {
    expect(parseMSteps('let Source = src in Source', bodies).map((s) => s.kind)).toEqual([
      STEP_KINDS.SOURCE, STEP_KINDS.NAVIGATION, STEP_KINDS.NAVIGATION, STEP_KINDS.NAVIGATION,
    ]);
  });

  it('terminates on an expression that references itself', () => {
    expect(() => parseMSteps('let Source = loop in Source', { loop: 'let Source = loop in Source' }))
      .not.toThrow();
  });
});

describe('resolveSourceNames — a complete chain states the name', () => {
  const model = (partition) => ({
    expressions: [{
      name: 'src',
      mExpression: `let
        Source = GoogleBigQuery.Database([BillingProject="proj"]),
        #"proj" = Source{[Name="proj"]}[Data],
        Schema = #"proj"{[Name="ds",Kind="Schema"]}[Data],
        View = Schema{[Name="the_view",Kind="View"]}[Data]
      in View`,
    }],
    tables: [{
      name: 'T',
      columns: [{ name: 'correction_code' }],
      partitions: [{ name: 'p', sourceExpression: partition }],
    }],
  });

  it('calls an unrenamed column exact when every step is known and none renames', () => {
    // The whole view is imported and the one rename touches a different column, so the
    // source column cannot be named anything else. That is a deduction from a complete
    // chain, not a guess — and it only became checkable once the chain was complete.
    const resolved = resolveSourceNames(model(`let
      Source = src,
      Renamed = Table.RenameColumns(Source, {{"correction_text", "Correction Description"}})
    in Renamed`));

    const column = resolved.columns.get('T[correction_code]');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.physicalPath).toBe('proj.ds.the_view.correction_code');
  });

  it('sees through a branch between two prior steps', () => {
    // A branch returns one of its arms. Both are prior steps here, so nothing in it can
    // rename a column — a fact about names, not about whether the parser has a category
    // for the shape.
    const resolved = resolveSourceNames(model(`let
      Source = src,
      Branch = if DatasetFilter = 1 then Source else Source
    in Branch`));

    expect(resolved.columns.get('T[correction_code]').confidence).toBe(CONFIDENCE.EXACT);
  });

  it('refuses to deduce past a reference it could not follow', () => {
    // `Source = SomeOtherQuery` where that query is not a shared expression: splicing
    // could not expand it, so everything upstream is unseen. "No step renames this
    // column" would be a statement about the visible half of a chain.
    const resolved = resolveSourceNames({
      expressions: [],
      tables: [{
        name: 'T',
        columns: [{ name: 'correction_code' }],
        partitions: [{ name: 'p', sourceExpression: 'let Source = SomeOtherQuery in Source' }],
      }],
    });
    expect(resolved.columns.get('T[correction_code]').confidence).not.toBe(CONFIDENCE.EXACT);
  });

  it('falls back to inferred when a step really can rename', () => {
    const resolved = resolveSourceNames(model(`let
      Source = src,
      Renamed = Table.TransformColumnNames(Source, Text.Upper)
    in Renamed`));

    const column = resolved.columns.get('T[correction_code]');
    expect(column.confidence).toBe(CONFIDENCE.INFERRED);
    expect(column.reason).toMatch(/cannot read/);
  });

  it('falls back to inferred when tables are appended', () => {
    // Table.Combine unions two tables, so a column may come from either one. Naming a
    // single source table would be a guess wearing a deduction's clothes.
    const resolved = resolveSourceNames(model('let Source = src, Both = Table.Combine({Source, Source}) in Both'));
    expect(resolved.columns.get('T[correction_code]').confidence).toBe(CONFIDENCE.INFERRED);
  });
});

describe('resolveSourceNames — an explicit projection beats SELECT *', () => {
  const model = {
    expressions: [{
      name: 'src',
      mExpression: `let
        Source = Value.NativeQuery(GoogleBigQuery.Database(){[Name="proj"]}[Data], "SELECT * FROM \`proj.units.dim\`"),
        Kept = Table.SelectColumns(Source, {"longitude", "latitude"})
      in Kept`,
    }],
    tables: [{
      name: 'T',
      columns: [{ name: 'longitude' }, { name: 'latitude' }],
      partitions: [{ name: 'p', sourceExpression: 'let Source = src in Source' }],
    }],
  };

  const resolved = resolveSourceNames(model);

  it('reads the name out of the projection rather than assuming it', () => {
    // `SELECT *` says nothing about column names, but `Table.SelectColumns` selects *from*
    // that result — so the names it lists are the source's own. Testing SELECT * first
    // labelled 32 columns of one real model "assumed" when the M named them.
    const longitude = resolved.columns.get('T[longitude]');
    expect(longitude.confidence).toBe(CONFIDENCE.EXACT);
    expect(longitude.reason).toMatch(/Table\.SelectColumns/);
  });

  it('still resolves the physical path', () => {
    expect(resolved.columns.get('T[latitude]').physicalPath).toBe('proj.units.dim.latitude');
  });

  it('leaves a column outside the projection unresolved rather than inventing it', () => {
    const outside = resolveSourceNames({
      ...model,
      tables: [{ ...model.tables[0], columns: [{ name: 'not_selected' }] }],
    }).columns.get('T[not_selected]');

    expect(outside.confidence).toBe(CONFIDENCE.UNKNOWN);
    expect(outside.physicalPath).toBeNull();
  });
});
