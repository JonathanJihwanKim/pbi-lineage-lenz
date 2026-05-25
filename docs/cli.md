# CLI Reference

← Back to [README](../README.md)

```text
$ model-lenz --help

Usage: model-lenz [OPTIONS] COMMAND [ARGS]...

  Open-source PBIP analyzer.

Commands:
  demo      Serve the bundled tiny demo PBIP. No path or clone needed.
  diff      Diff two PBIP folders and open a side-by-side comparison.
  inspect   Parse a PBIP and print the parsed model as JSON.
  serve     Start the local web server and open the model in a browser.
  summary   Print a one-screen human summary of the parsed model.
  version   Print the Model Lenz version.
```

## Commands

- **`model-lenz demo`**. The fastest way to see what the tool does. No path, no clone. Uses a bundled 5-table model.
- **`model-lenz serve <pbip>`**. The main experience on your own model. Local web app plus interactive graph.
- **`model-lenz diff <base_pbip> <head_pbip>`**. Side-by-side comparison of two model snapshots — opens on a Graph tab (diff-status borders on the bus layout) with a List tab behind for the per-entity audit. Auto-detects Git branch names for the BASE / HEAD pills when either folder is inside a working tree; override with `--name-base` / `--name-head`. See [diff.md](diff.md) for the full walkthrough.
- **`model-lenz diff --git <base_ref> <head_ref> [--repo <path>] [--subpath <path>]`**. Same as above but BASE and HEAD are Git refs (branch / tag / SHA / `origin/main` / `HEAD~3`, etc.) resolved against `--repo` (default: current directory). Uses `git archive` so your working tree is never touched. Auto-detects the PBIP subpath when the repo root has exactly one `*.SemanticModel/` folder.
- **`model-lenz summary <pbip>`**. Counts, classification breakdown, lineage confidence. Useful for CI.
- **`model-lenz inspect <pbip> -o model.json`**. Full parsed model as JSON. Plug it into other tools.

## Features at a glance

| | |
|---|---|
| **PBIP format** | TMDL semantic model only (no legacy `.pbix` in v1). Reads `definition/tables/*.tmdl`, `definition/relationships.tmdl`, `definition/expressions.tmdl`, `definition/functions/*.tmdl`. |
| **DAX coverage** | Measures, User Defined Functions (preview syntax), calculated columns, calculation groups, `USERELATIONSHIP` hints, table-arg DAX functions (FILTER, ALL, CALCULATETABLE, …). |
| **Power Query** | Per-partition lineage. Connectors: `GoogleBigQuery`, `Sql.Database`, `Snowflake`, `AzureStorage`, `Csv.Document`, `Excel.Workbook`, `Web.Contents`, `SharePoint`, `OData`, `Json.Document`. Resolves cross-query references to surface the deepest known source. |
| **Dual-name graph** | Every table node carries both its semantic-model name and its source identifier (BigQuery FQN, SQL `[schema].[table]`, Snowflake `DB.SCHEMA.TABLE`, file path) with a connector glyph. No mode toggle — both audiences read the same screenshot. |
| **Relationships** | Active and inactive, all four cardinalities, single and bidirectional crossfilter. Walker honors filter-propagation direction and re-enables inactive relationships when a measure declares `USERELATIONSHIP(…)`. |
| **Classification** | Heuristic fact / dim / parameter / time / calc-group / other, configurable via a `model_lenz.toml` in the PBIP root. |
| **PBIP diff** | `model-lenz diff <base> <head>` opens on a **Graph** tab — the bus-layout canvas with green (added) / amber (modified) / red (removed) borders on tables and edges. A **List** tab gives the per-entity audit (side-by-side BASE vs HEAD DAX for modified measures, column deltas, source-lineage rewrites). |
| **Git-ref diff mode** | `model-lenz diff --git <base_ref> <head_ref>` materializes each ref into a temp directory via `git archive`. No worktree to set up, no working tree disturbed. |
| **Shareable URLs** | Header **Copy link** captures the current measure + walk depth in the URL. Paste into Slack / PR / Jira; recipients running `model-lenz serve` against the same PBIP land on the same view. No filesystem paths encoded. |
| **Markdown handoff cards** | Detail-panel **Copy MD** button produces a one-pager (DAX + direct & indirect tables + source lineage + share URL) per measure or table. Paste into a PR description when asking a data engineer about a column rename. |
| **Mermaid / SVG export** | Header **Copy Mermaid** and **Download SVG** serialize the current canvas. Diff exports color both table borders and relationship arrows (green / amber / red), with removed edges dashed — needs v0.3.2+ for the edge coloring. SVG bakes in the active theme and current pan/zoom. |
| **Theme** | Dark (default) and light themes, both with the Power BI gold gradient as the brand accent. Theme switch lives in a labeled `Dark / Light` control next to `Hops` in the header. |
| **Switch PBIPs in-app** | Header **Open…** button swaps the active PBIP at runtime — no server restart. Previously loaded PBIPs stay cached so toggling back is instant. |
| **Distribution** | Single Python wheel. Install via `uv tool install model-lenz` (recommended) or `pipx install model-lenz`. Frontend bundle is included; no Node required at install time. |
| **Read-only** | Model Lenz never modifies your PBIP files. |
