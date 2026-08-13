/**
 * Direct Lake tables.
 *
 * A Direct Lake partition reads a Delta table in OneLake with no Power Query between the
 * two, so it states its physical object outright instead of hiding it behind a query:
 *
 *   partition sales = entity
 *     mode: directLake
 *     source
 *       entityName: sales
 *       schemaName: dbo
 *       expressionSource: 'DirectLake - Lakehouse_Contoso'
 *
 * It is therefore the *easiest* shape in the whole resolver — and it was the only one with
 * no branch at all. `= entity` matched nothing, so the main fact table of a Direct Lake
 * model resolved to nothing while its dimensions, which happened to be imported through M,
 * resolved perfectly. Coverage on the bundled sample went 78% → 95% when this landed.
 *
 * Found by preparing a public sample rather than by reading the code, which is the
 * argument for having a second model in the suite at all: everything else was built
 * against one BigQuery import model, and a resolver tuned to one storage mode passes every
 * test written for it.
 *
 * @see https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview
 */

import { describe, it, expect } from 'vitest';
import { resolveSourceNames, CONFIDENCE, ORIGIN } from '../src/naming/sourceNameResolver.js';
import { parseTmdlModel } from '../src/parser/tmdlParser.js';

const TMDL = `table sales
	column OrderKey
		dataType: int64
		sourceColumn: OrderKey

	column Quantity
		dataType: int64
		sourceColumn: Quantity

	column 'Line Total' = sales[Quantity] * 2
		dataType: double

	partition sales = entity
		mode: directLake
		source
			entityName: sales
			schemaName: dbo
			expressionSource: 'DirectLake - Lakehouse_Contoso'
`;

const model = () => {
  const parsed = parseTmdlModel([{ path: 'sales.tmdl', content: TMDL }], []);
  parsed.expressions = [];
  return parsed;
};

describe('parseTmdlModel — entity partitions', () => {
  it('keeps the three properties that name the physical table', () => {
    // They sit under `source` with no `=`, which is why they were being walked past.
    expect(model().tables[0].partitions[0]).toMatchObject({
      type: 'entity',
      mode: 'directlake',
      entityName: 'sales',
      schemaName: 'dbo',
      expressionSource: 'DirectLake - Lakehouse_Contoso',
    });
  });
});

describe('resolveSourceNames — Direct Lake', () => {
  const resolved = () => resolveSourceNames(model());

  it('resolves a column to the Delta table the partition names', () => {
    expect(resolved().columns.get('sales[OrderKey]').physicalPath)
      .toBe('Lakehouse_Contoso.dbo.sales.OrderKey');
  });

  it('calls it exact, because nothing is deduced', () => {
    // There is no query, so there is no step that could rename anything. This is a
    // stronger statement than the pass-through deduction an import table relies on.
    const column = resolved().columns.get('sales[OrderKey]');
    expect(column.confidence).toBe(CONFIDENCE.EXACT);
    expect(column.origin).toBe(ORIGIN.SOURCE);
    expect(column.reason).toMatch(/Direct Lake/);
  });

  it('reads the lakehouse name rather than printing a GUID', () => {
    // The expression behind it is `AzureStorage.DataLake("…/<workspaceId>/<itemId>")`,
    // which no reader can identify. The expression's *name* is the readable half.
    const table = resolved().tables.get('sales');
    expect(table.physicalPath).toBe('Lakehouse_Contoso.dbo.sales');
    expect(table.physical.system).toBe('Fabric Lakehouse');
  });

  it('still says a calculated column has no source', () => {
    // Direct Lake does not make DAX disappear, and claiming a Delta column for one would
    // send a data engineer looking for something that was never there.
    const column = resolved().columns.get('sales[Line Total]');
    expect(column.origin).toBe(ORIGIN.COMPUTED_DAX);
    expect(column.physicalPath).toBeNull();
  });

  it('honours sourceColumn when the model renamed a column', () => {
    const renamed = parseTmdlModel([{
      path: 't.tmdl',
      content: `table sales\n\tcolumn 'Order Key'\n\t\tsourceColumn: OrderKey\n\n`
        + `\tpartition sales = entity\n\t\tmode: directLake\n\t\tsource\n`
        + `\t\t\tentityName: sales\n\t\t\tschemaName: dbo\n`,
    }], []);
    renamed.expressions = [];

    expect(resolveSourceNames(renamed).columns.get('sales[Order Key]').physicalPath)
      .toBe('dbo.sales.OrderKey');
  });

  it('leaves an ordinary import table on the path it always took', () => {
    // The Direct Lake branch runs before everything else, so it has to be certain about
    // what it claims. A partition with no `entityName` is not one.
    const imported = parseTmdlModel([{
      path: 't.tmdl',
      content: 'table other\n\tcolumn A\n\n\tpartition other = m\n\t\tmode: import\n'
        + '\t\tsource =\n\t\t\t\tlet Source = X in Source\n',
    }], []);
    imported.expressions = [];

    expect(resolveSourceNames(imported).columns.get('other[A]').reason).not.toMatch(/Direct Lake/);
  });
});
