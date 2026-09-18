# The CI gate

[← back to the README](../README.md)

```bash
npm i -g https://github.com/JonathanJihwanKim/pbi-lineage-lenz/releases/latest/download/pbi-lineage-lenz.tgz
pbi-lineage-lenz check ./MyReport
```

Exits `1` on a broken reference. Reports everything else and exits `0`.

That split is the whole design. **A gate that fails on judgement calls gets disabled within
a week, and a disabled gate catches nothing.** A measure with no visual may be a building
block. A column that resolves to `unknown` may be a legitimately dynamic query. Neither is a
defect, and failing a build on either teaches the team to delete the step.

---

## The rules

| rule | what it finds | fails the build |
|---|---|---|
| `broken` | DAX reading a column or measure that does not exist | **yes** |
| `broken-nameof` | a field parameter offering a field that does not exist | **yes** |
| `dangling-visuals` | a visual referencing a measure that does not exist | no |
| `unused` | measures nothing reaches, following measure-to-measure references | no |
| `unresolved` | columns reading from a source that could not be traced | no |
| `coverage` | the traced percentage | only with `--min-coverage` |
| `dead-visuals` | hidden visuals that no bookmark reveals | no |

### `broken`

The only unambiguous defect: DAX pointing at something the model does not contain. A renamed
table leaves exactly this trace.

Everything is compared **case-insensitively**, because DAX is. `[Orders on Time %]` resolves
to a measure defined as `Orders On Time %` in Power BI, and a gate that calls that broken is
reporting its own comparison rather than a defect.

### `broken-nameof`

A field parameter is a list of `NAMEOF` references. When one names a measure that has since
been deleted, nothing errors: the slicer entry is still there, and choosing it puts nothing on
the visual. That is as broken as DAX reading a deleted column, and quieter, so it fails the
build by default.

New in 2.0.0. A repository with years of reports behind it may well have some — see
[adopting the gate](#adopting-the-gate-on-a-repository-with-history) before upgrading a gate
that is already switched on.

### `dangling-visuals`

Separate from `broken` because it fails *quietly*. A measure whose DAX reads a deleted column
errors outright; a card whose dynamic label references a deleted measure just renders blank.
One real report carried 12 of these and nobody had noticed.

Two things are read before this can be reported honestly:

- **`reportExtensions.json`** — a report can define measures of its own, usually against a
  live connection. They are not in the semantic model and they are not missing.
- **Field parameters** — a measure offered by one is referenced through the parameter's DAX,
  so it must resolve the same way any other reference does.

Getting either wrong turns the rule into an accusation.

### `unused`

Follows measure-to-measure references rather than direct visual bindings. On one real model
the direct-only reading claimed 101 unused measures; following the chains, it is 14. The
other 87 were building blocks feeding measures that *are* displayed.

Measures reached only through a dynamic title, a button, or a field parameter count as used,
because they are.

### `unresolved`

Columns whose `sourceless` reason is `unresolved` — the real gaps. Field parameter and
calculation group columns, calculated columns and columns added in Power Query have no source
by definition and are never listed; a rule that fired on every one of them would be muted on
day one. Reported, not failed. With a [baseline](#adopting-the-gate-on-a-repository-with-history)
and `--fail-on unresolved`, it fails only when the list grows.

### `coverage`

Reports the traced percentage. Only fails with an explicit threshold:

```bash
pbi-lineage-lenz check ./MyReport --min-coverage 70
```

Coverage counts only columns that read from a source. Field parameters, calculation groups
and DAX calculated columns are excluded, because they cannot have one —
see [confidence.md](confidence.md).

### `dead-visuals`

A hidden visual no bookmark reveals. Distinct from merely hidden: on one real report, 15 of
17 hidden visuals had a named bookmark behind them and 2 were genuinely unreachable.

---

## Choosing what fails

```bash
pbi-lineage-lenz check ./MyReport --fail-on broken,dangling-visuals
```

Any comma-separated subset of the rule names. `--quiet` prints only problems, which is what
you want in a log somebody reads after the fact.

## Adopting the gate on a repository with history

There is a second way a gate gets switched off within a week: **failing on day one.** Run
`check` over a repository with years of reports behind it and it may find two dozen genuine
broken references in reports other teams own. The author of an unrelated pull request can
fix all of them or turn the gate off — and the next broken reference arrives unnoticed.

A baseline lets the gate go on today:

```bash
# once, when adopting
pbi-lineage-lenz check ./reports --all --write-baseline .lenz-baseline.json
git add .lenz-baseline.json

# in CI, from then on
pbi-lineage-lenz check ./reports --all --baseline .lenz-baseline.json
```

- **Only findings not in the file fail.** Existing debt is acknowledged, not accepted
  silently.
- **The suppressed count prints on every run**, even under `--quiet` — *"29 known issues
  suppressed"* — so the debt stays visible.
- **A recorded finding that has been fixed fails too**, until it is removed. Run with
  `--update-baseline` to remove fixed findings; it never adds new ones. The file can only
  shrink as debt is paid, and can never go on suppressing something that might come back.
- **Findings are matched on stable keys** — the measure, the visual key, the reference —
  never a position, so moving a visual does not resurrect one.
- **Commit the file.** It is a reviewable ledger of report debt, and a pull request that
  grows it says so in the diff.

`coverage` is a threshold rather than a list of defects, so it cannot be baselined. The file
format is in [output-contract.md](output-contract.md#baseline-files).

## A whole workspace

```bash
pbi-lineage-lenz check ./workspace --all
```

Every report, against the model it names. A finding about a model — a broken reference, a
field parameter entry, an unresolved column — is reported once, however many reports read
that model. A measure is `unused` only when **no** report over its model reaches it: a measure
one thin report never shows may be the headline of another. Reports that could not be paired
with a model are listed before the findings.

## Before dropping a column

```bash
pbi-lineage-lenz impact ./reports --all --column order_agg_rpt.order_count --fail-if-used
```

For a warehouse repository's CI: a change that drops a column fails its own build while a
report still reads it. `impact` matches the physical name on its last parts, follows every
measure-to-measure reference, and exits `1` with `--fail-if-used` when anything reaches the
column — `2` if nothing by that name exists, so a typo does not pass as "unused". Without
`--fail-if-used` it prints the measures, hop by hop, and the visuals, page by page.

## Installing it in CI

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm i -g https://github.com/JonathanJihwanKim/pbi-lineage-lenz/releases/latest/download/pbi-lineage-lenz.tgz
- run: pbi-lineage-lenz check .
```

The tool installs from its GitHub release rather than from npm — no registry account is
involved on either side, and `releases/latest/download` always resolves to the newest
version. Pin a build by using the versioned filename from a specific release instead, which
is what a gate you do not want moving under you should do.

## A ready-made workflow

[`.github/workflows/handoff.yml`](../.github/workflows/handoff.yml) runs the gate on every
PR, builds a handoff file, and comments a download link plus a summary of what changed about
the model.

## Keeping the documentation in step

```yaml
- run: pbi-lineage-lenz docs . -o MODEL.md
# Fails if the committed file no longer matches the model. The generated file carries a
# date stamp, so `-I` ignores that one line — otherwise this would fail every midnight
# and be switched off within a week.
- run: git diff --exit-code -I'^_Generated' MODEL.md
```

Same principle as the gate itself: the check has to fail only on things the author can
actually fix. See [documentation.md](documentation.md).

## What changed, not which lines moved

```bash
pbi-lineage-lenz diff main..HEAD
```

Reads both revisions through the parser and reports model-level changes — a measure's
expression, a relationship, a column's physical source, a calculation item added or removed —
rather than a TMDL line diff. Point it at any revision range git understands, from anywhere
in or outside the repository.
