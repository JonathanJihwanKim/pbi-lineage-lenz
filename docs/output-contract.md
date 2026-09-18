# Output contract

[← back to the README](../README.md)

What the machine-readable outputs contain, and what is promised not to change under you.
Everything here is consumed by something that is not a person: a scheduled refresh, a CI
job, a warehouse load, a coding agent. A column that moves breaks a refresh, and an id that
looks global but is not produces numbers that look plausible and are wrong.

---

## Keys

PBIR ids are **not** globally unique. A visual id is unique within its page of one report;
page ids and page names repeat across reports (`Overview` is in most of them). Group by the
raw id across a workspace and two unrelated visuals merge into one row, silently.

Every entity therefore carries an explicit key:

| key | composed of | example |
|---|---|---|
| `reportKey` | the report's folder path, `.Report` dropped | `contoso_sales_thin` |
| `modelKey` | the model's folder path, `.SemanticModel` dropped | `directlake_import_composite` |
| `pageKey` | `reportKey` / page id | `contoso_sales_thin/e5f6a7b8c9d0e1f2a3b4` |
| `visualKey` | `pageKey` / visual id | `contoso_sales_thin/e5f6a7b8c9d0e1f2a3b4/Card_SalesAmount` |
| `bindingKey` | `visualKey` \| field kind \| `Table[Field]` | `…/Card_SalesAmount\|measure\|sales[Sales Amount]` |

Two properties are committed to:

- **Stable across runs.** The same input produces the same keys, so output diffs cleanly in
  git and a downstream refresh does not churn.
- **Stable across a rename.** Keys use the PBIR page and visual *ids*, never display names,
  so renaming a page does not look like deleting one and adding another.

The raw `id` stays on every page and visual. It is what finds the file on disk; it just does
not identify anything on its own.

A key is opaque. Do not parse it — every part of it is also a separate field.

---

## `docs --format json`

The viewer model: exactly what the app and the handoff file render. `version` is **3**.

What version 3 added over 2:

| where | field | meaning |
|---|---|---|
| `meta` | `reportKey`, `modelKey` | see [Keys](#keys) |
| `pages[]` | `key` | `pageKey` |
| `visuals[]` | `key` | `visualKey` |
| `visuals[].fields[]` | `bindingKey`, `role`, `viaParameter` | the key; the data role (`Values`, `Category`, …); the field parameter offering it. The handoff file's embedded payload omits `bindingKey` — it is derived from the visual key — and `docs --format json` writes it out. |
| `visuals[]` | `pageMap` | only with `--page-maps`; see [Page maps](#page-maps) |
| `columns[]` | `sourceless` | why a column has no physical source; see [Sourceless reasons](#sourceless-reasons) |
| `columns[]` | `dependsOn` | for a calculated column: the `Table[Name]` references its DAX reads |
| `measures[]` | `sourceless` | `no-column-reference` when nothing in the measure's closure reads a column |
| `measures[]` | `references`, `referencesTruncated` | the measure's reference chain; see below |
| `tables[]` | `offersMissing` | a field parameter's `NAMEOF` targets the model does not contain |

### Reference chains

`measures[].references` is every measure and calculated column the measure resolves
through, breadth-first — resolution order, read top-down — with the measure itself
excluded:

```json
"references": [
  { "kind": "measure", "ref": "measure:sales[_Margin per Order]", "table": "sales",
    "name": "_Margin per Order", "isHidden": true, "depth": 1,
    "expression": "DIVIDE ( [_Margin Value], [_Order Volume] )" },
  { "kind": "measure", "ref": "measure:sales[_Order Volume]", "table": "sales",
    "name": "_Order Volume", "isHidden": true, "depth": 2,
    "expression": "DISTINCTCOUNT ( 'sales'[OrderKey] )" }
]
```

Hidden members are included and marked, because an alias measure's logic lives in exactly
those. The chain is capped at depth 6 and 8,000 characters of expression; `referencesTruncated`
says when a cap was hit. A circular reference ends the branch rather than the run.

In the handoff file's embedded payload, each entry carries only `ref` and `depth` — the
expressions are already on the payload once, and inlining them doubled the file on a real
model. `docs --format json` writes them out whole.

### Workspaces

`docs --all --format json` wraps one viewer model per report:

```json
{ "version": 3, "kind": "workspace", "manifest": { … }, "reports": [ { …viewer model… } ] }
```

`manifest` lists every model and report found, how each report paired, and each one's
`status` — `analysed`, `unpaired` (its `definition.pbir` names no model in the folder, or
connects `byConnection`), or `failed` — with the `problem` in words.

---

## `docs --format csv` / `ndjson`

One row per **field a visual reaches**, per **physical column behind it**. A measure is
expanded through every measure-to-measure reference and calculated column to the columns it
reads. Report, page and visual context repeats on every row: it is a fact table, and any
consumer will group by them.

```bash
pbi-lineage-lenz docs ./MyReport --format csv -o lineage.csv
pbi-lineage-lenz docs ./workspace --all --format ndjson -o lineage.ndjson
```

The file is written a row at a time, so a workspace-sized export never has to fit in memory.

### Columns — contract version 1

| # | column | contents |
|---:|---|---|
| 1 | `contract_version` | `1` |
| 2 | `report_key` | see [Keys](#keys); empty on a row for a model no report reads |
| 3 | `report` | report name |
| 4 | `model_key` | |
| 5 | `model` | model name |
| 6 | `page_key` | |
| 7 | `page_id` | PBIR page id |
| 8 | `page_name` | display name |
| 9 | `visual_key` | |
| 10 | `visual_id` | PBIR visual id — unique only within its page |
| 11 | `visual_type` | `card`, `barChart`, … |
| 12 | `visual_title` | |
| 13 | `visual_hidden` | `true` / `false` |
| 14 | `binding_key` | see [Keys](#keys) |
| 15 | `via` | how the visual reaches the field: `query` (plotted), `value` (a text box's dynamic value), `parameter` (offered by a field parameter), `title`, `filter`, `action`, `format` — or `unbound` |
| 16 | `data_role` | the well the field sits in, when the report says |
| 17 | `via_parameter` | the field parameter offering the field, for `via = parameter` |
| 18 | `field_kind` | `measure`, `column`, `fieldParameter` |
| 19 | `field_scope` | `model`; `report` for a report-level measure; `missing` for a reference to something the model does not contain |
| 20 | `model_table` | |
| 21 | `model_field` | the measure or column the visual names |
| 22 | `field_hidden` | |
| 23 | `dax` | the field's expression, for a measure or calculated column |
| 24 | `source_column` | the model column this row traces to, `Table[Column]` |
| 25 | `physical_system` | `SQL Server`, `Fabric Lakehouse`, `BigQuery`, … |
| 26 | `physical_server` | server or URL |
| 27 | `physical_database` | database — for BigQuery, the project |
| 28 | `physical_schema` | schema — for BigQuery, the dataset |
| 29 | `physical_table` | |
| 30 | `physical_column` | |
| 31 | `physical_path` | the same, dotted — for display, not for parsing |
| 32 | `confidence` | `exact` / `inferred` / `unknown`; see [confidence.md](confidence.md) |
| 33 | `origin` | `source`, `computed-dax`, `computed-pq`, `model-defined`, `unresolved` |
| 34 | `sourceless` | empty when there is a physical column; otherwise the reason |
| 35 | `page_map` | only with `--page-maps` |

The physical name is split into parts deliberately. A dotted string has to be re-parsed by
every consumer, and the rules differ per source system.

### Rows that are not a physical column

A `COUNT` over the file agrees with the `docs` summary, because nothing is silently dropped:

- A binding that reaches **no** physical column still gets one row, with `sourceless`
  saying why.
- A measure **no visual reaches**, directly or through another measure, gets rows with
  `via = unbound` and the visual columns empty.

`binding_key` + `source_column` identifies a row.

### Order

Rows are sorted by visual key, then binding key, then source column, so the file diffs
cleanly in git.

### Versioning

- New columns are only ever **appended**, and do not change `contract_version`.
- Any other change — a rename, a removal, a reorder, a change to what a column means —
  increments `contract_version` and is called out in the [CHANGELOG](../CHANGELOG.md).

Read columns by name if you can, and check `contract_version` if you cannot.

---

## Sourceless reasons

Why a column — or a binding — has no physical source. A small, closed set:

| value | meaning | a gap? |
|---|---|---|
| `field-parameter` | a field parameter's column: its rows are `NAMEOF` references | no |
| `calculation-group` | a calculation group's column: its rows are calculation items | no |
| `calculated-column` | a DAX calculated column — traced through to what it reads | no |
| `computed-in-m` | a column added in Power Query with `Table.AddColumn` | no |
| `no-column-reference` | a measure that reads no column at all: a constant, a `COUNTROWS` | no |
| `unresolved` | reads from a source that could not be traced | **yes** |

Only `unresolved` counts against coverage, and only `unresolved` is listed by the
`unresolved` check rule. A blank in a physical-column cell reads as a failure, and most of
them are facts about the model — this is what lets a consumer tell the two apart.

---

## Page maps

With `--page-maps`, each visual carries a small SVG of its page — every visual a grey
rectangle, this one filled in — as a `data:image/svg+xml;utf8,` URI. It goes in
`visuals[].pageMap` in JSON, the `page_map` column in CSV and NDJSON, and an image per visual
in markdown.

It is built to survive Power BI's image URL column, the strictest place it will go:

- no `#` anywhere (Power BI reads it as a fragment and renders nothing) — colours are `rgb()`
- single-quoted attributes only, so it can sit inside JSON inside a DAX string literal
- scaled to the page's own size, not an assumed 1280 × 720
- capped at 30,000 characters; past the cap the other visuals are dropped and the page
  outline and the highlighted visual stay

To show it in Power BI, load the flat export and set the `page_map` column's data category to
**Image URL**.

GitHub strips `data:` images from rendered markdown, so in a markdown file on GitHub the
maps do not display. They do in most other markdown renderers.

---

## Baseline files

`check --write-baseline` writes:

```json
{
  "version": 1,
  "generator": "pbi-lineage-lenz 2.0.0",
  "findings": {
    "broken-nameof": ["broken-nameof|table:Metric Selection|sales[Retired Measure]"],
    "unused": ["unused|measure:sales[Old KPI]"]
  }
}
```

Keys are built from stable identities — model refs, visual keys — never positions or line
numbers, so moving a visual does not resurrect a finding. Under `--all` each key is prefixed
with the model or report it belongs to. Keys are sorted and there is no timestamp, so writing
the file twice over the same findings produces the same bytes. See [ci.md](ci.md#adopting-the-gate-on-a-repository-with-history).
