# CLI Reference

← Back to [README](../README.md)

```text
$ model-lenz --help

Usage: model-lenz [OPTIONS] COMMAND [ARGS]...

  Open-source PBIP analyzer.

Commands:
  check     Run CI guardrail checks and exit non-zero on failure.
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
- **`model-lenz check <pbip>`**. CI guardrail. Runs three static rules over every measure and exits non-zero when an error-severity rule fires, so a PR build fails before a model regression merges.

### `model-lenz check`

| Rule | Severity | Fires when |
|---|---|---|
| `broken-references` | error (always) | A measure's DAX references a measure / column / table that doesn't resolve. |
| `ambiguous-paths` | warning (error with `--fail-on-ambiguous`) | A measure reaches an indirect table by more than one relationship path. |
| `indirect-blowup` | error (only with `--max-indirect N`) | A measure's indirect-table count exceeds `N`. |

| Flag | Default | Meaning |
|---|---|---|
| `--depth / -d` | `2` | Relationship-walk depth. |
| `--max-indirect` | _unset_ | Enable `indirect-blowup` at this threshold. Omit to disable. |
| `--fail-on-ambiguous` | off | Escalate `ambiguous-paths` to an error. |
| `--format` | `text` | `text` or `json`. |
| `--github` | off | Emit `::error` / `::warning` workflow annotations. Auto-on when `$GITHUB_ACTIONS == "true"`. |

Exit code is `0` when no error-severity rule fires (warnings still pass), `1` otherwise. GitHub annotations are emitted without a `file=` anchor — the parser doesn't yet track which TMDL file a measure came from, so they appear in the run log and the PR Checks summary but not inline on a diff line.

```yaml
# .github/workflows/model-lenz.yml
- name: Model Lenz check
  run: |
    uvx model-lenz check path/to/MyModel.SemanticModel --max-indirect 12
```

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
| **CI guardrail** | `model-lenz check <pbip>` fails a PR build on broken references, ambiguous propagation paths (opt-in error), or an indirect-table blow-up past `--max-indirect`. Text / JSON output plus GitHub Actions annotations. |
| **Distribution** | Single Python wheel. Install via `uv tool install model-lenz` (recommended) or `pipx install model-lenz`. Frontend bundle is included; no Node required at install time. |
| **Read-only** | Model Lenz never modifies your PBIP files. |
