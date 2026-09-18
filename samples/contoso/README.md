# Contoso — the bundled sample

A small, real PBIP project used by the tests, the screenshots in the root README, and the
live demo. Everything public about this tool is generated from here.

```
contoso_project.Report/                      2 pages, 15 visuals
contoso_sales_thin.Report/                   1 page, 2 visuals — a thin report over the same model
directlake_import_composite.SemanticModel/   9 tables, 12 measures
```

Point any command at this folder:

```bash
pbi-lineage-lenz check   samples/contoso
pbi-lineage-lenz handoff samples/contoso -o handoff.html
pbi-lineage-lenz docs    samples/contoso -o MODEL.md
pbi-lineage-lenz impact  samples/contoso --all --column dbo.sales.OrderKey
```

## Why this one

It is small enough to read in a screenshot and to hold in your head — 7 tables against a
61-table production model — while still exercising the parts that are easy to get wrong:

- **A Fabric Lakehouse SQL endpoint**, so the source map resolves to
  `Lakehouse_Contoso.dbo.customer.CustomerKey`. Most of the development happened against a
  BigQuery model, and a second connector is what keeps the resolver honest about being
  general rather than tuned to one warehouse.
- **A report whose name does not match its model.** `contoso_project.Report` reads
  `directlake_import_composite.SemanticModel`, which can only be discovered by reading
  `definition.pbir`. Name-matching finds nothing here, and that is the point — see
  `packages/core/src/parser/projectLayout.js`.
- **A clean star**: 2 facts, 4 dimensions, 1 disconnected table. The model lens should make
  that obvious at a glance, and if it ever stops doing so, this is where it shows.
- **Two reports over one model.** `contoso_sales_thin.Report` is a thin report reading the
  same `directlake_import_composite.SemanticModel` — the normal shape of a Fabric workspace,
  and what `--all` exists for. It deliberately reuses the visual id `Card_SalesAmount`,
  because PBIR ids are unique only within a report, and a tool keyed on the raw id would
  merge the two cards.
- **An alias measure.** `Margin per Order` is `[_Margin per Order]` and nothing else; the
  logic is three levels down, in hidden measures. It is the shape reference-chain expansion
  and reverse impact exist for: nothing on any visual names `sales[OrderKey]`, and still a
  card on each report depends on it.

## What was changed

The Fabric SQL endpoint hostname was replaced with a placeholder,
`contoso-lakehouse.datawarehouse.fabric.microsoft.com`. The original identified a live
workspace.

Added for the tests, and not in the original project: the `Margin per Order` measure and
the four hidden measures under it, the card showing it on the Insights page, and the whole
`contoso_sales_thin.Report`.

The consequence is that **this sample cannot refresh** — it is for reading, not for
connecting. Every path the tool reports is still exactly what it would report against the
real thing, because the resolver works from the M expression rather than from the data.

## Data

Contoso is Microsoft's fictional sample company. There is no real customer, product or
sales data anywhere in this folder — a PBIP holds a model definition, not its rows.
