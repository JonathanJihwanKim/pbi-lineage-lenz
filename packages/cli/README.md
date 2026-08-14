# pbi-lineage-lenz

**Find the lineage. Understand the model. Document both.** For the BI developer **and** the
data engineer.

Point it at a PBIP folder and get documentation you can commit, or a single self-contained
HTML file that opens in any browser — with no Power BI, no project folder and no install on
the far end.

**[See a live example](https://jonathanjihwankim.github.io/pbi-lineage-lenz/demo.html)** —
a real model in your browser, nothing to download.

```bash
npx pbi-lineage-lenz handoff ./MyReport -o handoff.html
```

## What it answers

| Question | Command |
|---|---|
| Can I hand someone documentation? | `docs --format md` — markdown with a mermaid ER diagram, committed beside the PBIP |
| Where does this column actually come from? | `handoff` — the source map, every model column beside its physical one |
| What does this model look like? | `handoff` — table roles read from the direction of relationships |
| Why is this number not what the measure computes? | `handoff` — the calculation group rewriting it, and which visuals apply it |
| What can this visual be made to show? | `handoff` — every field the bound field parameter offers |
| Did this change break anything? | `check` — exits non-zero on a broken reference |
| What changed about the model in this PR? | `diff main..HEAD` |

## Calculation groups and field parameters

Both are references to references, and finding the reference is not the same as following
it.

A **field parameter** is bound to a visual as a single name. The report says *"this well
holds prmMeasures"*; the 22 measures behind it live in DAX. Not following it understated one
real pivot table by fifteen measures.

A **calculation group** wraps `SELECTEDMEASURE()` around whatever a visual shows, so the
number on the page is not the number the measure computes — and nothing in the measure says
so. It is not a measure, its table has no physical source, and its effect appears on visuals
that never name it, which makes it invisible from every other direction.

Both are followed, both are labelled wherever they appear, and `docs` gives each its own
section with the DAX that does the work.

## Commands

```bash
pbi-lineage-lenz handoff <path> -o handoff.html   # the self-contained file
pbi-lineage-lenz check   <path>                   # CI gate; non-zero only on broken refs
pbi-lineage-lenz docs    <path> --format md|json|html
pbi-lineage-lenz diff    main..HEAD <path>        # what changed about the model
```

Every command takes the folder holding your `.Report` and `.SemanticModel` directories. When
a folder holds several reports — a Fabric workspace synced to git — the pairing is read from
`definition.pbir` rather than guessed, and the CLI says which pair it chose.

## Confidence, not coverage

Every resolved column states how far to trust it: `exact` when the model says so outright,
`inferred` when the physical table is known and the column passes through unrenamed, and
`unknown` when no origin could be established.

`unknown` is a feature. `SELECT *` in native SQL, a column missing from an explicit
projection, and a table with no Power Query expression all resolve to `unknown` rather than
to a plausible guess — because one wrong mapping costs more trust than ten missing ones.

Coverage counts only the columns that *could* have a source. A DAX calculated column has
none by definition, and neither does a field parameter or a calculation group — counting
those as untraced held one real model's genuine 96% down to a reported 82%, and sent readers
looking for 67 things that were never lost.

## In CI

```yaml
- run: npx --yes pbi-lineage-lenz check .
- run: npx --yes pbi-lineage-lenz handoff . -o handoff.html
- uses: actions/upload-artifact@v4
  with: { name: handoff, path: handoff.html }
```

A reviewer with no Power BI installed gets a readable artifact attached to the pull request.
There is a complete workflow in
[`.github/workflows/handoff.yml`](https://github.com/JonathanJihwanKim/pbi-lineage-lenz/blob/main/.github/workflows/handoff.yml).

## Nothing leaves your machine

No network requests, from the CLI or from a generated handoff file. A handoff contains
model definitions — table names, DAX, Power Query steps, server hostnames — and **no data
rows**, because a PBIP holds a model definition rather than its contents. Treat the file
with the same care as the project it came from.

## Documentation

Full README, screenshots and the browser version:
**https://github.com/JonathanJihwanKim/pbi-lineage-lenz**

MIT © Jihwan Kim
