# Changelog

## 1.1.0 — calculation groups, honest coverage, and an overview

### Calculation groups reach the reader

The core detected them from the first release and the viewer payload dropped them, so a
calculation group rendered as a two-column table with no measures, no source, and nothing
saying what it does. It is the hardest object in a model to discover by reading — not a
measure, no physical source, and its effect appears on visuals that never name it — so
being silent about it was the worst possible outcome.

- `toViewerModel` carries a table's `kind`, a calculation group's items with their DAX, and
  the fields a field parameter offers. Payload version bumped to 2.
- The model lens marks both, filters on both, and shows a calculation group's items with
  their DAX — the only place that DAX appears at all.
- The measures lens says when a measure is rewritten: *"1 of the 12 visuals showing this
  measure also binds 'Time Intelligence', so what they display is this expression wrapped
  in the selected calculation item — not this expression."*
- The pages lens marks visuals that apply one, and labels fields a field parameter offers
  as offered rather than shown.
- `docs` gains `## Calculation groups` and `## Field parameters` sections.

### Coverage stops counting metadata as failures

Field parameter and calculation group columns have no physical source and never could. They
resolved to `unknown` with the reason *"No physical table could be resolved from the Power
Query expression"* — false, because there is no Power Query expression to resolve.

On a real 61-table model that was **67 columns, 81% of everything reported as untraced.** It
held a genuine 96% coverage down to a reported 82% and sent readers looking for 67 things
that were never lost. They are now `model-defined`, counted apart from both `sourced` and
`computed`, and reported separately everywhere.

### Overview lens, shown first

A fifth lens that is not a list: what the model is, how much of it is traced, and what is
worth looking at, in sentences. Every number on it is arithmetic over the payload — no
scores and no grades, because a summary screen is the easiest place in the product to start
quietly guessing.

### Contrast and colour

- Every colour now carries at least **4.5:1** against every ground in both themes, checked
  at the value. `--ink-4` was **2.09:1** and rendered every "no source" placeholder, which
  made the tool's *unknown* state the least readable thing on screen.
- `exact` and `inferred` differed by hue alone — green and amber, the pair that converges
  under deuteranopia. They are now solid, half-filled and hollow markers, so the tool's
  central signal survives greyscale and colour-blindness.
- A distinct tint for model machinery, chosen to read as neither a warning nor a vocabulary.

### Documentation

The README keeps the pitch and the quick start; the depth moves into `docs/`:
[documentation](docs/documentation.md), [lenses](docs/lenses.md),
[confidence](docs/confidence.md),
[calculation groups and field parameters](docs/calculation-groups-and-field-parameters.md),
and [CI](docs/ci.md).

### Samples

`samples/contoso` — the demo, every screenshot, and the bundled-sample test — now carries a
four-item calculation group and a five-measure field parameter bound to real visuals, so
the behaviour the README describes is demonstrated and a regression fails the build.
`samples/sample-pbip` is restructured into a real PBIP layout; its report was previously
unreachable through the CLI.

`npm test` is 577 tests.

## 1.0.1 — `pbi-lineage-lenz` only

No behaviour change. The package page led with lineage and the handoff file, and mentioned
documentation only in passing — but generating documentation is one of the three things
this tool exists to do, and a reader could finish the page without learning that `docs`
exists. The README and description now say so.

## 1.0.0

First release. Consolidates three earlier tools —
[pbip-documenter](https://github.com/JonathanJihwanKim/pbip-documenter),
[pbip-lineage-explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer) and
`pbip_model_lenz` — into one engine, filtered to three purposes: find lineage correctly,
make a model understandable, and produce documentation you can hand over.

### The lenses

- **Model** — table roles read from the direction of relationships rather than from names.
  Selection-first: one neighbourhood is drawn at a time, so a 61-table model never becomes
  a hairball. Bidirectional, inactive and dangling relationships are called out.
- **Source map** — every model column beside its physical column, with a confidence label
  and the reasoning behind it.
- **Measures** — DAX, the physical columns underneath it, and every visual that shows it,
  each located on its page.
- **Pages** — every visual on a page, nothing filtered out, with the bookmark that reveals
  each hidden one.

### The handoff file

One self-contained HTML file. No Power BI, no project folder, no install, no network
requests. The CLI and the browser produce a byte-identical file.

### CLI

`handoff`, `check`, `docs` (markdown with a mermaid ER diagram, JSON, or HTML) and `diff`.
Five check rules, of which only `broken` fails a build by default.

### Notable correctness work

Each of these was found by pointing the tool at a real model, not by reading the code.

- **Direct Lake tables resolve.** A `= entity` partition names its Delta table outright.
  It previously matched no branch at all, so the main fact table of a Fabric model resolved
  to nothing while its imported dimensions resolved perfectly. Sample coverage 78% → 95%.
- **Reports pair with the model they name.** `definition.pbir` is now read, instead of
  taking the first `.Report` and the first `.SemanticModel` independently. In a Fabric
  workspace synced to git — several items in one repository — the old behaviour checked a
  report's visuals against an unrelated model and manufactured findings that did not exist.
- **Renames hidden outside `Table.RenameColumns`** — `Table.ExpandTableColumn`'s fourth
  argument, `Table.SelectColumns` projections over `SELECT *`, and native-SQL select lists.
- **Step chains spliced across shared expressions** rather than replaced by them; 20 of one
  model's 21 rename steps had been invisible.
- **Tables that read other tables** — an M partition whose `Source` is another table, and
  calculated tables — now resolve instead of stopping one hop short.
- **Field parameters followed into the model.** A visual binds `prmMeasures`; the 22
  measures behind that name live in DAX. One pivot table was understated by fifteen.
- **Every field reference carries how it is reached** — plotted, a text box's dynamic value,
  a dynamic title, a filter, a link, or conditional formatting.
- **Coverage counts only columns that could have a source.** A DAX calculated column has
  none by definition; counting it as untraced penalised a model for containing a
  calculation, and counting it as traced made the headline disagree with the rows beneath.
- **166 → 0 false broken references** on a 61-table production model, across eight parser
  fixes. Every one of the original 166 was an artefact.

### Verified against

- `samples/contoso` — Fabric Lakehouse, Direct Lake plus import, committed to this
  repository. 95% of source-backed columns traced, none assumed.
- A 61-table production report — 473 columns, 274 measures, 542 visuals. 82% traced, every
  mapping stated rather than assumed.

560 tests.
