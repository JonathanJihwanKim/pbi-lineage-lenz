# Contoso — the bundled sample

A small, real PBIP project used by the tests, the screenshots in the root README, and the
live demo. Everything public about this tool is generated from here.

```
contoso_project.Report/                      2 pages, 12 visuals
directlake_import_composite.SemanticModel/   7 tables, 7 measures, 88 columns
```

Point any command at this folder:

```bash
npx pbi-lineage-lenz check   samples/contoso
npx pbi-lineage-lenz handoff samples/contoso -o handoff.html
npx pbi-lineage-lenz docs    samples/contoso -o MODEL.md
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

## What was changed

The Fabric SQL endpoint hostname was replaced with a placeholder,
`contoso-lakehouse.datawarehouse.fabric.microsoft.com`. The original identified a live
workspace. Nothing else was touched.

The consequence is that **this sample cannot refresh** — it is for reading, not for
connecting. Every path the tool reports is still exactly what it would report against the
real thing, because the resolver works from the M expression rather than from the data.

## Data

Contoso is Microsoft's fictional sample company. There is no real customer, product or
sales data anywhere in this folder — a PBIP holds a model definition, not its rows.
