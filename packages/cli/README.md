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
| Where does this column actually come from? | `handoff` — the source map, every model column beside its physical one |
| What does this model look like? | `handoff` — table roles read from the direction of relationships |
| Did this change break anything? | `check` — exits non-zero on a broken reference |
| Can I hand someone documentation? | `docs --format md` — markdown with a mermaid ER diagram |
| What changed about the model in this PR? | `diff main..HEAD` |

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
