# The CI gate

[← back to the README](../README.md)

```bash
npx pbi-lineage-lenz check ./MyReport
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
| `dangling-visuals` | a visual referencing a measure that does not exist | no |
| `unused` | measures nothing reaches, following measure-to-measure references | no |
| `coverage` | columns with no physical source | only with `--min-coverage` |
| `dead-visuals` | hidden visuals that no bookmark reveals | no |

### `broken`

The only unambiguous defect: DAX pointing at something the model does not contain. A renamed
table leaves exactly this trace.

Everything is compared **case-insensitively**, because DAX is. `[Orders on Time %]` resolves
to a measure defined as `Orders On Time %` in Power BI, and a gate that calls that broken is
reporting its own comparison rather than a defect.

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

### `coverage`

Reports the traced percentage. Only fails with an explicit threshold:

```bash
npx pbi-lineage-lenz check ./MyReport --min-coverage 70
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
npx pbi-lineage-lenz check ./MyReport --fail-on broken,dangling-visuals
```

Any comma-separated subset of the rule names. `--quiet` prints only problems, which is what
you want in a log somebody reads after the fact.

## A ready-made workflow

[`.github/workflows/handoff.yml`](../.github/workflows/handoff.yml) runs the gate on every
PR, builds a handoff file, and comments a download link plus a summary of what changed about
the model.

## Keeping the documentation in step

```yaml
- run: npx --yes pbi-lineage-lenz docs . -o MODEL.md
# Fails if the committed file no longer matches the model. The generated file carries a
# date stamp, so `-I` ignores that one line — otherwise this would fail every midnight
# and be switched off within a week.
- run: git diff --exit-code -I'^_Generated' MODEL.md
```

Same principle as the gate itself: the check has to fail only on things the author can
actually fix. See [documentation.md](documentation.md).

## What changed, not which lines moved

```bash
npx pbi-lineage-lenz diff main..HEAD
```

Reads both revisions through the parser and reports model-level changes — a measure's
expression, a relationship, a column's physical source, a calculation item added or removed —
rather than a TMDL line diff. Point it at any revision range git understands, from anywhere
in or outside the repository.
