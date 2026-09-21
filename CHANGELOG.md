# Changelog

## Unreleased — one folder to open, and it says what is in it

"Open a PBIP folder" never said which folder. A Fabric workspace synced to git holds several
`.Report` and several `.SemanticModel` folders side by side, and the label named none of
them — so the first thing the tool asked was a question the reader had no way to answer yet.

There is now one button, **Open a repository folder**, and it takes the folder those items
sit in. The screen after it does the explaining: every report listed under the model its
`definition.pbir` names, with its visual count, ready to pick. Nobody is asked which model
belongs to which report.

- **One action, not a choice between three.** The `.Report` route still works — a report
  names its model and the app asks for that one folder as a second step — but it is no
  longer offered as a decision up front. A browser can read only the folder you pick, and a
  report's model is its sibling, so that route can never be the short one.
- **Reports are paired by `definition.pbir`, never by name.** `contoso_project` reads
  `directlake_import_composite`, and reading the first `.Report` beside the first
  `.SemanticModel` — which is what this used to do — pairs report A with model B in any
  folder holding more than one of each. Reports whose model is absent are listed with the
  reason rather than dropped.
- **Switch report** moves between reports over a shared model without picking the folder
  again, parsing that model once however many times you switch.
- **A pick that comes back empty now says why.** It used to repaint the same screen in
  silence, which is indistinguishable from the click having done nothing. It now separates
  a picker the browser refused outright from one that was open and then closed — the
  elapsed time tells them apart — and names Chrome's second prompt, *"Let site view
  files?"*, which cancels the pick when dismissed and is the likeliest reason a carefully
  chosen folder never arrives.
- **A fallback that needs no permission.** Where the File System Access API is blocked by
  policy or site setting, the plain file input reads the same folder. If the picker is
  refused before any dialog appears, the app switches to it automatically.
- **Large folders no longer come back empty** through that fallback: it waited 500ms after
  the window regained focus and gave up, which a folder of thousands of files can exceed.
  It now uses the browser's own `cancel` event where that exists.

`partitionEstate()` keeps each report's raw reference rather than folding it into prose,
because a caller asking for a folder by name needs the name. No change to the CLI, the
handoff file, or the release.

## 2.0.1 — install it from here

No change to what the tool does. It changes where it comes from.

Publishing to npm needs an account on a site that can, and did, lock the maintainer out of
releasing their own work — a strange dependency for a tool whose source is right here, and
one this project no longer has. Releases are now built and attached by CI, using nothing
but the token GitHub Actions mints for the run.

```bash
npm i -g https://github.com/JonathanJihwanKim/pbi-lineage-lenz/releases/latest/download/pbi-lineage-lenz.tgz
pbi-lineage-lenz docs ./MyReport -o MODEL.md
```

- **One tarball per release**, carrying the four internal packages inside it via
  `bundleDependencies`. The layout is preserved rather than bundled into a single file,
  because `handoff` builds the viewer with esbuild at runtime and reads its stylesheet off
  disk — flattening it would break that command on a user's machine and nowhere else.
- **The artefact is installed into an empty project and run before it is published**, on
  every release and on every pull request. A tarball that lost its bundled packages still
  builds and still looks right; only running it finds out.
- **The release installs nothing.** The viewer is bundled when the tarball is built rather
  than on the machine that installs it, so the artefact has no dependencies at all — the
  install is an extract, with nothing to download and no scripts to run. It also fixes a
  real failure: a package that carries bundled dependencies *and* installs one of its own
  breaks under `npm i -g`, leaving esbuild half-written. A project install does not
  reproduce it, so CI caught what a laptop had not. Both CI and the release job now install
  globally, the way the README says to.
- **`esbuild` moved to `^0.25.0`** in the workspace, clearing three moderate advisories that
  showed up on every install. It is used as a library here, never as a dev server, so the
  advisory could not bite — but nobody should have to work that out from an audit warning.
- **The handoff workflow builds the tool from the code under review** instead of installing
  a published copy, so a pull request that breaks the CLI no longer passes its own workflow.

**On npm, this package stops at 1.1.1.** The five packages are still built on every release
and can be published unchanged if that account becomes reachable; nothing here depends on it.


## 2.0.0 — the other direction, a whole workspace, and a gate you can switch on today

Every change here answers a question somebody had to write their own script for, running
this tool over a real Fabric workspace of fourteen reports: which visuals break if I drop
this column, which reports use this measure, what does this alias measure actually compute,
and how do we turn the gate on over years of existing debt. Issues #3 to #10.

### Breaking

- **Viewer payload version 3.** Additive for anyone reading by field name — keys,
  `sourceless`, `references`, `offersMissing` — but a consumer checking `version === 2` will
  see 3. See [docs/output-contract.md](docs/output-contract.md).
- **`check` fails on `broken-nameof` by default.** A field parameter offering a field the
  model no longer contains was dropped silently; it is now a broken reference, and gated
  like one. A repository that has some can record them with `--write-baseline` first.
- **`resolveVisibility()` keys by page and visual id** (`visibilityKey()`), not visual id
  alone.

### What breaks if I drop this column? (#3)

`impact` starts from the name a data engineer knows — `dbo.orders.order_count`,
`orders.*`, or a model column or measure — and returns every measure that reads it,
following measure-to-measure references with hop count and path, then every visual those
reach, located on its page and grouped by report. `--fail-if-used` exits 1 for a warehouse
repository's CI; a name that matches nothing exits 2, so a typo never passes as "unused".
`docs` gains a *Used by* column per model column, from the same walk.

### A flat export (#4)

`docs --format csv` and `--format ndjson`: one row per field a visual reaches, per physical
column behind it, with the physical name in parts and a documented, versioned column
contract. Rows that reach no physical column are kept with a reason, and measures nothing
reaches appear as `unbound`, so a count over the file agrees with the documentation.
Written a row at a time.

### Keys that are unique across a workspace (#5)

PBIR visual ids are unique within a page of one report and nowhere else. Reports, pages,
visuals and bindings now carry `reportKey`, `pageKey`, `visualKey` and `bindingKey`, built
from folder paths and PBIR ids — stable across runs and across a page rename. Two places
inside the tool made the same mistake and are fixed: `diff` keyed visuals by id alone, so a
visual added on one page could hide one removed from another; and bookmark visibility did
the same across pages.

### Why a column has no source (#6)

Every column carries `sourceless`: `field-parameter`, `calculation-group`,
`calculated-column`, `computed-in-m`, or `unresolved` — and measures `no-column-reference`.
Only `unresolved` is a gap. The markdown names the reason in place of a blank, and lists the
unresolved columns by name under the coverage summary. A new `unresolved` check rule reports
exactly those, and never fails by default.

### Alias measures, read through (#7)

A measure whose body is `[_Some Hidden Measure]` now carries its reference chain: every
measure and calculated column below it, breadth-first, with DAX and a hidden flag, capped in
depth and size and safe against cycles. In `docs` it is a collapsible chain under the
measure; in the measures lens, a *Resolves through* list. Hidden measures are read, not
unhidden.

Calculated columns were missing from the lineage graph altogether, so a measure reading one
lost the dependency, and a trace stopped at a column with no source. They are nodes now, and
traces continue through them to the columns their DAX reads.

### Page maps (#8)

`docs --page-maps` adds a small SVG of each visual's page, visual highlighted, as a `data:`
URI — in JSON, in the flat export, and in markdown. Built for Power BI's image URL column: no
`#`, single-quoted attributes, scaled to the page's own size, and capped in length.

### A gate you can switch on today (#9)

`check --write-baseline <file>` records current findings as known debt; `--baseline <file>`
fails only on new ones and prints the suppressed count on every run. A recorded finding that
has since been fixed fails until removed, and `--update-baseline` removes it — the file can
only shrink. Findings are matched on stable keys, so moving a visual does not resurrect one.

The `broken-nameof` rule is new with it: `docs/documentation.md` had promised that `check`
reports field parameter entries naming a deleted field, and nothing did.

### A whole workspace (#10)

`--all` on `docs`, `check` and `impact` analyses every report in the folder against the
model its `definition.pbir` names, and parses each shared model once. `docs --all` writes an
index — every pairing, reports whose model is not in the folder or that connect
`byConnection`, and for each shared model which reports reach each measure — plus one
document per report. One unreadable report is listed and skipped, not fatal. Across a
workspace, a measure is `unused` only if no report over its model reaches it.

### Also

- **References spelled in a different case now resolve.** DAX is case-insensitive and the
  forward trace was not: a measure called as `[Orders with Target Not Met]` but defined as
  `Orders with Target not Met` was dropped, with every column underneath it — from the
  measures lens, from `unused` (which called the callee unused), and from anything built on
  the trace. Found by checking the flat export and reverse impact against each other; they
  now share one resolver, and a test holds them to the same answer.
- The web app now shows which report it opened when a folder holds several; it always meant
  to.
- `samples/contoso` gains an alias measure over three levels of hidden measures and a thin
  second report over the same model, reusing a visual id — so every claim above is asserted
  on every commit.
- 596 tests, up from 533.

## 1.1.1 — `pbi-lineage-lenz` only

No behaviour change. The npm package page described a tool with no calculation groups, no
field parameters and no honest coverage count — the three things 1.1.0 is about — because
npm serves the README from the published tarball rather than from the repository, so the
1.1.0 publish carried the old text.

Same failure as 1.0.1, and worth naming twice: the package page is where somebody decides
whether to try this at all, and it keeps being the last place the new work reaches.

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

`npm test` is 533 tests in the repository, plus 44 against a private production model
that live on the maintainer's disk and skip themselves everywhere else.

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
