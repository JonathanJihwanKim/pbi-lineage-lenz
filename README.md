![Model Lenz](docs/hero.png)

# Model Lenz

*Open-source static analyzer for Power BI PBIP projects. For any DAX measure, it shows every table that measure depends on (directly through the expression, and indirectly through active relationships).*

[![PyPI](https://img.shields.io/pypi/v/model-lenz.svg)](https://pypi.org/project/model-lenz/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue.svg)](https://www.python.org/downloads/)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/JonathanJihwanKim?label=Sponsor&logo=GitHub)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-%E2%98%95-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)
[![Microsoft MVP](https://img.shields.io/badge/Microsoft-MVP-5E5E5E?logo=microsoft)](https://mvp.microsoft.com/en-us/PublicProfile/5005958)

**If Model Lenz has saved you time, you can sponsor here:**

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)

---

## Who this is for

Model Lenz is built for the two-person conversation that happens every time a Power BI measure touches a warehouse table:

- **Power BI developers.** See every table a DAX measure depends on — directly through the expression and indirectly through active relationships, with `USERELATIONSHIP(...)` overrides honored. Spot which referenced sub-measure introduced a table you didn't expect.
- **Data engineers.** See the underlying source identifier for every table the model exposes — BigQuery FQN, SQL `[schema].[table]`, Snowflake `DB.SCHEMA.TABLE`, file path — without opening Power Query Editor. Preview which BI measures break before renaming a source column.

Both views render on every table node at once, so a screenshot dropped into a PR or Slack thread tells the full story to both audiences.

---

## Try it in 30 seconds (no clone needed)

```bash
uv tool install model-lenz       # or: pipx install model-lenz
model-lenz demo                  # opens a built-in 5-table demo in your browser
```

Nothing to clone. Nothing to download from GitHub. The wheel ships the CLI, a pre-built React UI, and a tiny demo PBIP.

The demo is a hand-authored 5-table model (Date, Customer, Product, Sales_fct, Measure). When the browser opens:

1. Click **Margin %** in the left sidebar. The dashed edges light up across all three dimensions, even though the expression only mentions other measures.
2. Look at any table node. Every node shows both its semantic-model name (the one a Power BI developer types in DAX) and the source identifier below it (the BigQuery / SQL / Snowflake path a data engineer recognizes). A small connector glyph on the source line tells you at a glance which warehouse the table came from.
3. Click **Copy MD** in the right-hand detail panel. A one-pager Markdown card for Margin % is on your clipboard — DAX, direct/indirect tables, source lineage — ready to paste into a PR description or Jira ticket.
4. Click **Copy link** in the header. The URL now encodes your selection and walk depth (`?table=Sales_fct&measure=Margin%20%25&depth=3`). Paste it into Slack and a teammate running `model-lenz serve` against the same PBIP lands on the exact same view.

Got your own PBIP folder? Continue to [Install](#install).

---

## What it does

I built Model Lenz to answer one question for any DAX measure: which tables does it actually depend on?

Take `Total Sales = SUM ( Sales[Amount] )`. The expression references `Sales`. But the moment someone slices the report by Customer or Date, the result changes, because filters propagate through active relationships. Power BI Desktop's model view shows the relationships, and the formula bar shows the expression. You have to combine them in your head. I wanted a tool that just shows the combined picture.

For every measure (and for User Defined Functions, calculated columns, and calculation groups), Model Lenz surfaces:

- Direct table refs parsed from the DAX expression.
- Referenced measures (`[Other Measure]` calls), resolved transitively so the chain bottoms out at real tables.
- Indirect tables reached by walking active relationships from the direct refs, with cardinality glyphs (`*:1`, `1:*`), crossfilter direction (single or `↔`), and `USERELATIONSHIP(...)` overrides honored per measure.
- Per-table source-system lineage with confidence labels. Every table node carries **both** names: the semantic-model name a Power BI developer sees, and the source identifier a data engineer recognizes — `report_sales.fact_orders_combined` (BigQuery), `dbo.DimCustomer` (SQL Server), the full Snowflake path, or whichever source the M query points at. A connector glyph on the source line makes the warehouse obvious at a glance.

Same graph for both sides. When the Power BI developer and the data engineer talk about a measure in a PR or a Slack thread, they're looking at the same picture and reading the same labels.

### Compare two PBIPs

`model-lenz diff` opens a side-by-side comparison of two model snapshots. The diff view opens on a **Graph tab** by default — the same bus-layout canvas you see in single-model mode, painted with green (added), amber (modified), or red (removed) borders on table cards and relationship edges. A **List tab** behind it gives you the per-entity audit: every modified measure's BASE vs HEAD DAX, column-by-column deltas on each modified table, and source-lineage rewrites. The legend strip floating above the canvas reconciles to the same totals as the header — a `+N measure change →` chip jumps you to the List tab for changes that don't have a graph representation.

Both views share the same swap button (flips BASE ↔ HEAD client-side) and the same export controls — `Copy Mermaid` and `Download SVG` in the top bar serialize the current canvas with status colors baked in, ready to paste into a PR description or attach to a design doc.

You can point it at two folders, or at two Git refs in the same repo.

**By Git refs (recommended).** Pass `--git` and two ref strings. Model Lenz materializes each ref into a temp directory via `git archive` — your working tree is never touched, no worktree to clean up:

```powershell
# Diff origin/main vs your current HEAD, in the current repo
model-lenz diff --git origin/main HEAD

# A different repo, with an explicit subpath if the repo has more than one PBIP
model-lenz diff --git main feature/yoy `
  --repo D:\my_pbip_repo `
  --subpath import_contoso_sales.SemanticModel
```

Ref names auto-fill the BASE / HEAD pills. A gold ★ pin appears when BASE is `main`, `master`, `origin/main`, or `origin/master`.

**By folder paths (works everywhere).** When the two snapshots aren't refs in one repo — a teammate sent you a PBIP for review, you have two clones, you want to diff a backup — pass two folder paths directly:

```powershell
model-lenz diff ..\my_pbip_repo-main\import_contoso_sales.SemanticModel `
                .\import_contoso_sales.SemanticModel
```

If you'd rather stay in the worktree pattern you used pre-v0.3.1:

```powershell
cd D:\my_pbip_repo
git worktree add ..\my_pbip_repo-main main
model-lenz diff ..\my_pbip_repo-main\import_contoso_sales.SemanticModel `
                .\import_contoso_sales.SemanticModel
git worktree remove ..\my_pbip_repo-main   # when done
```

Branch names auto-fill the BASE / HEAD pills when either folder is inside a working tree.

### Share a view, hand it off, embed it

Every interaction in Model Lenz is one paste away from a teammate's screen. The header buttons are the same on the single-model view and the diff view:

- **Copy link.** Captures your current measure selection and walk depth in the URL — e.g. `/?table=Sales_fct&measure=Margin%20%25&depth=3`. Paste into Slack, a PR comment, or a Jira ticket. Anyone running `model-lenz serve` against the same PBIP lands on the exact same view. Filesystem paths are never encoded.
- **Copy MD.** On the right-hand detail panel. Produces a one-pager Markdown card for the selected measure or table — DAX, referenced measures, direct + indirect tables walked at your current depth, USERELATIONSHIP overrides, source lineage, and a clickable share URL at the bottom. Paste straight into a PR description when asking a data engineer about a column rename.
- **Copy Mermaid.** Header button. Serializes the current canvas as Mermaid `graph LR` syntax. Pastes into [mermaid.live](https://mermaid.live), GitHub / GitLab Markdown, Notion, or any renderer that speaks Mermaid. On the diff view the output includes status colors so the diagram in your PR matches the canvas you reviewed.
- **Download SVG.** Header button. Saves a standalone SVG of the current canvas with the active theme baked in — preserves the current pan/zoom so you can frame a sub-graph before exporting. Drop into a design doc or Confluence page.

---

## Install

You only need Python 3.10+. Pick whichever installer you have. They all end with the same `model-lenz` command on your PATH.

> **Do I need to clone the repo?** No. Installing from PyPI gives you the full tool, including the bundled `model-lenz demo`. Clone the repo only if you want to contribute code or read the source.

### Windows (PowerShell), three steps

**Step 1.** Install `uv` (Astral's installer, one-time, ~10 seconds):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

You only do this once per machine. If `uv --version` already prints something, skip it.

**Step 2.** Install Model Lenz as a global tool:

```powershell
uv tool install model-lenz
```

This downloads the latest `model-lenz` wheel from PyPI and registers a `model-lenz` command on your PATH (in `~\.local\bin\`). No clone, no Python project setup.

**Step 3.** Open a *new* PowerShell window (so the PATH update is picked up), then run:

```powershell
model-lenz serve "C:\projects\Sales\Sales.SemanticModel"
```

Replace the path with your `*.SemanticModel/` folder. That's the one Power BI Desktop creates next to your `.pbip` file. The browser opens automatically.

- *Path has spaces?* Wrap it in double quotes: `model-lenz serve "C:\My Reports\Q4 Sales\Q4 Sales.SemanticModel"`.
- *Prefer pointing at the PBIP root?* That works too. Model Lenz auto-detects the `*.SemanticModel/` child. See [Point it at your PBIP folder](#point-it-at-your-pbip-folder).

### macOS / Linux, three steps

**Step 1.** Install `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Skip if you already have `uv`. If you have `pipx` and prefer it, you can use `pipx install model-lenz` in step 2 instead.

**Step 2.** Install Model Lenz as a global tool:

```bash
uv tool install model-lenz
```

**Step 3.** In a new shell session, run it against your `*.SemanticModel/` folder:

```bash
model-lenz serve path/to/Sales.SemanticModel
```

### Already have Python and just want it in your environment?

```bash
pip install model-lenz
```

(Not recommended. `uv tool` / `pipx` keep `model-lenz` isolated from your project Pythons.)

---

## Update

When a new Model Lenz release lands on PyPI, your installed copy keeps running the old version until you upgrade. One command:

```powershell
uv tool upgrade model-lenz
```

(macOS/Linux: same command. With pipx: `pipx upgrade model-lenz`.)

After upgrading, close any open `model-lenz` browser tab and stop any running server (Ctrl+C in the terminal), then run `model-lenz serve` again. The browser should pick up the new bundle automatically. If it doesn't, hit **Ctrl+F5** (or **Cmd+Shift+R** on Mac) to force-refresh past the cached JavaScript.

Confirm the version you have:

```powershell
model-lenz version
```

---

## Point it at your PBIP folder

PBIP saves your project as a folder tree:

```
Sales\                                      ← the PBIP root (what Power BI Desktop opens)
  Sales.pbip                                ← the project file
  Sales.SemanticModel\                      ← the model. Point here.
    definition\
      tables\*.tmdl
      relationships.tmdl
      expressions.tmdl
  Sales.Report\                             ← report layer (PBIR). Not read by Model Lenz.
                                              See PBIP Lineage Explorer for visual lineage.
```

`model-lenz serve` accepts any of these three paths. They all parse the same model:

| Path you pass                                       | Works? | Notes                                     |
|-----------------------------------------------------|--------|-------------------------------------------|
| `Sales\Sales.SemanticModel`  *(the model folder)*   | ✅ recommended | The folder Model Lenz actually reads. |
| `Sales`  *(the PBIP root, containing `Sales.pbip`)* | ✅      | Also works. Model Lenz locates the `.SemanticModel/` child automatically. |
| `Sales\Sales.SemanticModel\definition`              | ✅      | The innermost folder still works.        |

**Switch PBIPs without restarting.** Once the server is running, click **Open…** next to the model name in the header to point it at a different PBIP. No `Ctrl+C` and re-run — paste the path (Explorer's *Copy as path* with surrounding quotes works), hit **Open**, and the sidebar, graph, and selection state all refresh to the new model. The previously loaded model stays cached in memory, so toggling back is instant.

---

## Troubleshooting

- **"`pipx` is not recognized" on Windows.** Use `uv tool install` instead (see [Install](#install)). `uv` is a single-binary installer and doesn't need pip.
- **`model-lenz` isn't found after install.** Open a *new* terminal window. The installer added a directory (`~/.local/bin` on Linux/macOS, `%USERPROFILE%\.local\bin` on Windows) to your PATH, but existing terminals don't see it until they restart.
- **Browser doesn't open automatically.** It prints the URL. Copy `http://127.0.0.1:<port>/` into your browser. Add `--no-browser` to suppress the auto-open.
- **"Address already in use".** Pick a port: `model-lenz serve … --port 8765`.

---

## CLI

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

- `model-lenz demo`. The fastest way to see what the tool does. No path, no clone. Uses a bundled 5-table model.
- `model-lenz serve <pbip>`. The main experience on your own model. Local web app plus interactive graph.
- `model-lenz diff <base_pbip> <head_pbip>`. Side-by-side comparison of two model snapshots — opens on a Graph tab (diff-status borders on the bus layout) with a List tab behind for the per-entity audit. Auto-detects Git branch names for the BASE / HEAD pills when either folder is inside a working tree; override with `--name-base` / `--name-head`.
- `model-lenz diff --git <base_ref> <head_ref> [--repo <path>] [--subpath <path>]`. Same as above but BASE and HEAD are Git refs (branch / tag / SHA / `origin/main` / `HEAD~3`, etc.) resolved against `--repo` (default: current directory). Uses `git archive` so your working tree is never touched. Auto-detects the PBIP subpath when the repo root has exactly one `*.SemanticModel/` folder.
- `model-lenz summary <pbip>`. Counts, classification breakdown, lineage confidence. Useful for CI.
- `model-lenz inspect <pbip> -o model.json`. Full parsed model as JSON. Plug it into other tools.

---

## Features

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
| **Mermaid / SVG export** | Header **Copy Mermaid** and **Download SVG** serialize the current canvas. Diff exports preserve the green / amber / red status colors. SVG bakes in the active theme and current pan/zoom. |
| **Theme** | Dark (default) and light themes, both with the Power BI gold gradient as the brand accent. Theme switch lives in a labeled `Dark / Light` control next to `Hops` in the header. |
| **Switch PBIPs in-app** | Header **Open…** button swaps the active PBIP at runtime — no server restart. Previously loaded PBIPs stay cached so toggling back is instant. |
| **Distribution** | Single Python wheel. Install via `uv tool install model-lenz` (recommended) or `pipx install model-lenz`. Frontend bundle is included; no Node required at install time. |
| **Read-only** | Model Lenz never modifies your PBIP files. |

---

## Roadmap

Model Lenz exists because Power BI developers and data engineers need to look at the same model and have the same conversation about it. Everything on this roadmap serves that handshake. It surfaces model changes early, in a vocabulary both sides recognize, on a surface both sides can review.

- **v0.3.x. Diff polish.** _Shipped._
  - Diff on the graph canvas — green / amber / red borders on tables and edges, with a Graph / List tab toggle at `/diff`.
  - Per-measure / per-table Markdown handoff cards via **Copy MD**.
  - Shareable URLs (selection + walk depth) via **Copy link**.
  - Export to Mermaid / SVG via header buttons — works on both the single-model view and the diff view.
  - Git-ref diff mode — `model-lenz diff --git origin/main HEAD` materializes refs via `git archive` instead of requiring a manual worktree.

> **Where your sponsorship goes.** The v0.4 CI gate (`model-lenz check`) and the next batch of source connectors (Snowflake native SQL, Databricks, Synapse Serverless) are the next things on the build list. [GitHub Sponsors](https://github.com/sponsors/JonathanJihwanKim) or [Buy Me a Coffee](https://www.buymeacoffee.com/jihwankim) accelerates them.

- **v0.4. Guardrails before the merge.**
  - **`model-lenz check` for CI.** Extends `summary` into a policy-gate command that can fail a build on orphan measures, fact tables sourced from more than one warehouse, ambiguous propagation paths through multiple facts, or measures whose indirect-table set grew by more than N tables in a single commit. Catches anti-patterns at PR time, before they become a review thread.
  - **Annotation layer on sub-graph exports.** Reviewers leave inline comments on an exported SVG/Mermaid sub-graph attached to a PR.

- **Later.** DMV / XMLA mode for deployed semantic models. `.pbix` adapter. Perspective-aware views. Bus-layout (Kimball-style dims-top / facts-left) auto-arrangement for star-schema review.

> **Not on this roadmap by design:** report-layer (PBIR) measure-usage, meaning which pages and visuals consume each measure. That's exactly what **[PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)** is for. Use Lineage Explorer for visual → DAX → source-column tracing, and use Model Lenz for the model-side dependency picture.

Have something else you'd like to see? Open a [feature request](https://github.com/JonathanJihwanKim/pbip_model_lenz/issues/new?template=feature_request.yml).

---

## Also by Jihwan Kim

- **[PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)**. Trace any visual back to its source columns through DAX. Browser-based, 100% client-side. Use this when the question is *"where does the number on this card actually come from?"*
- **[PBIP Documenter](https://github.com/JonathanJihwanKim/pbip-documenter)**. Generate bidirectional documentation (measures, tables, relationships, M-steps, native SQL) from PBIP/TMDL in seconds. Use this when the question is *"can I hand someone a readable spec of this model without writing one?"*

Together with Model Lenz, the three tools cover the model side, the report side, and the documentation side of a PBIP project without overlap.

---

## Architecture (for contributors)

```
                           ┌───────────────────┐
   .tmdl, .pq files  ───▶  │  Python backend   │  ◀── HTTP /api  ───┐
   in your PBIP            │  parsers /        │                    │
                           │  analyzers /      │   ┌──────────────────┐
                           │  FastAPI          │   │ React + Vite SPA │
                           └───────────────────┘   │ D3 force graph   │
                                  ▲                │ Zustand store    │
                                  │                └──────────────────┘
                           model-lenz CLI
                          (typer + uvicorn)
```

- **Parser layer** ([`src/model_lenz/parsers/`](src/model_lenz/parsers/)). TMDL block parser (indent-aware state machine), DAX reference extractor (hand-rolled tokenizer), M-query lineage extractor (recursive descent with native-SQL parsing).
- **Analysis layer** ([`src/model_lenz/analyzers/`](src/model_lenz/analyzers/)). Relationship graph and indirect-dep walker on NetworkX, transitive measure resolver, fact/dim classifier.
- **JSON contract** ([`src/model_lenz/models/`](src/model_lenz/models/)). Pydantic models that the API serializes and the frontend mirrors as TypeScript types.
- **HTTP API** ([`src/model_lenz/api/routes.py`](src/model_lenz/api/routes.py)). FastAPI. Full OpenAPI at `/docs`.
- **Frontend** ([`frontend/`](frontend/)). React 18 + Vite + TypeScript. Force graph in D3 directly (no Cytoscape). Zustand for state.

See [CONTRIBUTING.md](CONTRIBUTING.md) for a deeper tour.

### From source

```bash
git clone https://github.com/JonathanJihwanKim/pbip_model_lenz
cd pbip_model_lenz
uv pip install -e ".[dev]"
cd frontend && npm install && npm run build && cd ..
model-lenz serve examples/tiny_pbip
```

---

## FAQ

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

## Support development

Model Lenz is free, ad-free, and never phones home. Every parser, walker, and graph runs on your machine. If it has saved you time on a model review, an audit, or a *"wait, where does this column actually come from?"* conversation, consider sponsoring development:

- **[❤ GitHub Sponsors](https://github.com/sponsors/JonathanJihwanKim)**. Recurring $2 / $5 / $10 / $25 / $50 per month. Top tier includes a 30-minute monthly call with a Microsoft MVP.
- **[☕ Buy Me a Coffee](https://www.buymeacoffee.com/jihwankim)**. One-time contributions, any amount.

**Where sponsorship goes:**

- **`model-lenz check` CI gate (v0.4).** Fail a build on orphan measures, fact tables sourced from more than one warehouse, ambiguous propagation paths, or indirect-table-set growth above a threshold.
- **Annotation layer on sub-graph exports (v0.4).** Inline reviewer comments on an exported SVG / Mermaid sub-graph attached to a PR.
- **New source connectors.** Snowflake native SQL, Databricks, Synapse Serverless. Each opens a class of warehouses Model Lenz currently labels with low confidence.
- **Documentation, issue triage, maintenance.** The unglamorous work that keeps the tool usable.

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)

### Hall of Sponsors

*Your name here. Sponsor at the $10+ tier and you'll be listed (with your consent) here on the README and on the project website.*

---

## License

[MIT](LICENSE). Use it commercially, fork it, ship it inside whatever you're building. Attribution appreciated but not required.
