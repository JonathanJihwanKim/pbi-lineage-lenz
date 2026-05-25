# FAQ — How Model Lenz Works and What It Doesn't Do

← Back to [README](../README.md)

## What it actually answers

I built Model Lenz to answer one question for any DAX measure: which tables does it actually depend on?

Take `Total Sales = SUM ( Sales[Amount] )`. The expression references `Sales`. But the moment someone slices the report by Customer or Date, the result changes, because filters propagate through active relationships. Power BI Desktop's model view shows the relationships, and the formula bar shows the expression. You have to combine them in your head. I wanted a tool that just shows the combined picture.

For every measure (and for User Defined Functions, calculated columns, and calculation groups), Model Lenz surfaces:

- **Direct table refs** parsed from the DAX expression.
- **Referenced measures** (`[Other Measure]` calls), resolved transitively so the chain bottoms out at real tables.
- **Indirect tables** reached by walking active relationships from the direct refs, with cardinality glyphs (`*:1`, `1:*`), crossfilter direction (single or `↔`), and `USERELATIONSHIP(...)` overrides honored per measure.
- **Per-table source-system lineage** with confidence labels. Every table node carries both names: the semantic-model name a Power BI developer sees, and the source identifier a data engineer recognizes — `report_sales.fact_orders_combined` (BigQuery), `dbo.DimCustomer` (SQL Server), the full Snowflake path, or whichever source the M query points at. A connector glyph on the source line makes the warehouse obvious at a glance.

Same graph for both sides. When the Power BI developer and the data engineer talk about a measure in a PR or a Slack thread, they're looking at the same picture and reading the same labels.

## Who it's for

- **Power BI developers.** See every table a DAX measure depends on — directly through the expression and indirectly through active relationships, with `USERELATIONSHIP(...)` overrides honored. Spot which referenced sub-measure introduced a table you didn't expect.
- **Data engineers.** See the underlying source identifier for every table the model exposes — BigQuery FQN, SQL `[schema].[table]`, Snowflake `DB.SCHEMA.TABLE`, file path — without opening Power Query Editor. Preview which BI measures break before renaming a source column.

Both views render on every table node at once, so a screenshot dropped into a PR or Slack thread tells the full story to both audiences.

---

## Frequently asked questions

**Does Model Lenz modify my PBIP?**
No. It only reads. All processing is in-memory; nothing is written back to the model files.

**Does it need an XMLA endpoint or live AS connection?**
No. It works purely from the PBIP source files on disk. Source control is the only prerequisite. No Power BI Service or Tabular Editor required.

**What about legacy `.pbix` files?**
Not supported in v1. `.pbix` is a zipped legacy bundle. The TMDL-based PBIP format is the going-forward source-of-truth and supersedes it. If there's strong demand, a `.pbix` adapter could land in a later release.

**Does it scan my report visuals?**
No. Model Lenz reads only the `.SemanticModel/` side of a PBIP. For tracing which pages and visuals consume each measure (visual → DAX → source column), use **[PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)**.

**Does it execute DAX or run queries?**
No. It's purely static analysis. Lexical parsing of expressions, walking the relationship graph. Nothing connects to a real data source.

**Why isn't the indirect-table list deeper by default?**
Default walk depth is 2 hops, which captures the typical star or snowflake. Adjust via the depth selector in the header or `?depth=` on the API.

---

## Bundled demo walkthrough

`model-lenz demo` opens a hand-authored 5-table model (Date, Customer, Product, Sales_fct, Measure). When the browser opens:

1. Click **Margin %** in the left sidebar. The dashed edges light up across all three dimensions, even though the expression only mentions other measures.
2. Look at any table node. Every node shows both its semantic-model name (the one a Power BI developer types in DAX) and the source identifier below it (the BigQuery / SQL / Snowflake path a data engineer recognizes). A small connector glyph on the source line tells you at a glance which warehouse the table came from.
3. Click **Copy MD** in the right-hand detail panel. A one-pager Markdown card for Margin % is on your clipboard — DAX, direct/indirect tables, source lineage — ready to paste into a PR description or Jira ticket.
4. Click **Copy link** in the header. The URL now encodes your selection and walk depth (`?table=Sales_fct&measure=Margin%20%25&depth=3`). Paste it into Slack and a teammate running `model-lenz serve` against the same PBIP lands on the exact same view.
