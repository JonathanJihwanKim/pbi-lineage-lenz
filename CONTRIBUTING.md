# Contributing

## The most useful thing you can send

**A PBIP shape this tool got wrong.**

Every serious bug in this project was found by pointing it at a model nobody had tried
before — a report whose name did not match its model, a Direct Lake partition, a column
renamed inside `Table.ExpandTableColumn` rather than `Table.RenameColumns`. None was found
by reading the code, and the synthetic fixtures were all green throughout.

So a report that says *"my model has X and the source map shows Y"* is worth more than a
patch. Open an issue with:

- what the tool said, and what the model actually contains
- the TMDL or `visual.json` fragment that produces it, with names changed if you need to
- ideally, a minimal `samples/`-shaped folder that reproduces it

If you can share a sanitised project, that is the gold standard — see
[`samples/contoso/`](samples/contoso/) for the shape and for what "sanitised" means.

## Running it

```bash
npm install
npm test                 # the whole suite
npx vitest run <file>     # one file
npm run dev              # the web app at localhost:5173
```

Try changes against the bundled sample rather than a synthetic fixture:

```bash
node packages/cli/src/bin.js check   samples/contoso
node packages/cli/src/bin.js handoff samples/contoso -o /tmp/h.html
```

## The rule that matters most

**A real model stays in the loop.**

`packages/core/tests/bundledSample.test.js` runs everywhere, against a project committed
in this repository. It is not a formality: real-world resolution once sat at **0.2%** while
every synthetic fixture passed. If you change a parser, check what happens to the sample's
numbers before you check what happens to the unit tests.

A second suite guards a 61-table production model. It is not in this repository and will
not be — it is written against a private report, so it names that report's tables and
measures. That is fine for you: it would skip itself on your machine anyway. But it means
the numbers quoted in the README come from a model you cannot run, and the bundled sample
is the one doing the real work in your checkout.

## What a good change looks like

- **Explain the *why* in a comment, not the *what*.** The code says what it does. A comment
  earns its space by recording the case that made the code look like that — which is
  usually a specific model that broke it.
- **A test that would have failed before.** If the fix is real, there is an input that used
  to produce the wrong answer. Assert on that input.
- **Numbers, when you have them.** "This moved coverage from 78% to 95% on the sample" is a
  reviewable claim. "Improves lineage" is not.
- **Honest confidence.** A wrong `exact` is a much worse bug than an `unknown`. If a change
  makes the tool *more* certain, be sure the certainty is stated by the model rather than
  assumed by the parser.

## Scope

This is deliberately not a general Power BI toolkit. It does three things: find lineage
correctly, make a model understandable, and produce documentation you can hand to someone.
A feature that does not serve one of those is likely to be declined — not because it is a
bad idea, but because [pbip-documenter](https://github.com/JonathanJihwanKim/pbip-documenter)
and [pbip-lineage-explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)
exist and may be the better home for it.

## Style

No framework, no build step in `packages/*` — plain ES modules that run in Node and the
browser unchanged. `packages/viewer` may touch the DOM; `packages/core` may not touch the
DOM, the filesystem, or the network.

## License

By contributing you agree that your contribution is licensed under the MIT License.
