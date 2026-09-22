# Regenerating the README screenshots

The images in `docs/images/` are captured from the app itself, not drawn. They go stale
quietly — the header carries the generation date, and the counts change whenever the
bundled sample does — so this records how they were made.

Playwright is deliberately **not** a dependency of this repository: the release artefact
has none, and a screenshot tool is not worth breaking that for. Install it somewhere else.

```bash
mkdir -p /tmp/shots && cd /tmp/shots
npm init -y && npm install playwright
# Drives an already-installed Chrome, so nothing large is downloaded:
#   executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
```

## The five lens images

Built from the bundled sample, so they show a real model and nothing private:

```bash
node packages/cli/src/bin.js handoff samples/contoso -o /tmp/shots/demo.html
```

Then, against `file:///tmp/shots/demo.html`, at **1440x900**, `colorScheme: 'dark'`,
`deviceScaleFactor: 1` — click the `button.lenz-lens` for the lens, then click the row in
`table.tbl tbody tr` whose `.n-model` text is exactly the name below:

| Image | Lens | Row to select |
|---|---|---|
| `overview.png` | overview | — |
| `model-lens.png` | model | `sales` |
| `source-map.png` | source map | `customer[CustomerKey]` |
| `measures.png` | measures | `Margin per Order` |
| `pages.png` | pages | `Selected metric by month` |

Match the row exactly. `sales` as a substring also hits `Monthly Sales Summary`, and
`Margin per Order` also hits the hidden `_Margin per Order` it resolves through.

`model-lens.png` selects `sales` because its caption promises "what the sales table joins
to" — an earlier version had the calculation group selected, which joins to nothing.

## The two web-app images

Captured against the published app, which is the thing readers will actually open:

| Image | Where | Crop |
|---|---|---|
| `open-repository.png` | the landing page | `.landing-head` down to the end of `.landing-hint` |
| `choose-report.png` | after opening a repository folder | the `.chooser` element |

For `choose-report.png` the folder picker cannot be driven from a script, so stub
`window.showDirectoryPicker` with a handle over `samples/contoso` before the page loads.
Both are cropped to their content with ~26px of padding rather than shot at a fixed size.
