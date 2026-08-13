# @pbi-lineage-lenz/core

The analysis engine behind [PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).

Parses Power BI PBIP projects — TMDL, PBIR, DAX, and Power Query M — builds a dependency
graph, and resolves every model column back to the physical column it came from.

Platform-independent: no DOM, no file system, no network. Give it a `Map` of file paths to
contents and it returns plain data. Runs in Node.js, browsers, and VS Code alike.

```bash
npm install @pbi-lineage-lenz/core
```

## Usage

```js
import { analyzeFromFiles } from '@pbi-lineage-lenz/core';

const { graph, stats, sourceNames, dataSources } = analyzeFromFiles({
  modelFiles,  // Map<path, content> for the .SemanticModel folder
  reportFiles, // Map<path, content> for the .Report folder (optional)
});

const column = sourceNames.columns.get('Sales[Net Amount]');
column.physicalPath; // 'SalesDW.dbo.FactSales.amt_net_usd'
column.confidence;   // 'exact'
column.reason;       // 'Renamed in Power Query: "amt_net_usd" -> "Net Amount".'
```

## The two readings

One model, two vocabularies. A BI developer says `Sales[Net Amount]`; a data engineer says
`SalesDW.dbo.FactSales.amt_net_usd`. `resolveSourceNames()` holds both, so each side can read
the model in their own names.

## Confidence

Every resolved column states how far to trust its physical mapping. This matters more than
coverage: a data engineer who finds one wrong mapping stops trusting all of them.

| Value | Meaning |
|---|---|
| `exact` | Stated in the model — an explicit `Table.RenameColumns` pair, an explicit `Table.SelectColumns` projection, or a native-SQL select list. Also used for computed columns, where "no physical source" is itself an exact answer. |
| `inferred` | The physical table is known and the column passes through unrenamed, so the source column name is assumed to match. Usually right, but an assumption. |
| `unknown` | No physical origin could be established. `physical` is `null`. |

`SELECT *` in native SQL, a column missing from an explicit projection, and a table with no
Power Query expression all resolve to `unknown` rather than to a plausible guess.

Each column also carries an `origin`: `source`, `computed-pq` (added by `Table.AddColumn`),
`computed-dax` (a DAX calculated column), or `unresolved`.

## API

**Pipeline** — `analyze()`, `analyzeFromFiles()`

**Parsers** — `parseTmdlModel()`, `parseDaxExpression()`, `parsePbirReport()`,
`parseExpressions()`, `identifyProjectStructure()`

**Power Query M** — `extractDataSources()`, `extractTableLineage()`, `parseMSteps()`,
`extractAllFromModel()`, `requiresGateway()`, `STEP_KINDS`

**Source naming** — `resolveSourceNames()`, `toSourceMapRows()`, `parseSqlSelectList()`,
`formatPhysicalColumnPath()`, `CONFIDENCE`, `ORIGIN`

**Graph** — `buildGraph()`, `traceMeasureLineage()`, `traceVisualLineage()`,
`analyzeImpact()`, `findOrphans()`

**Diff** — `detectChanges()`, `resolveImpact()`, `CHANGE_TYPES`

## Provenance

The parsing and graph layers come from
[pbip-lineage-explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer); the M-query
engine comes from [pbip-documenter](https://github.com/JonathanJihwanKim/pbip-documenter); the
two-readings idea comes from [model-lenz](https://github.com/JonathanJihwanKim/pbip_model_lenz).
This package is where they converge.

MIT © Jihwan Kim
