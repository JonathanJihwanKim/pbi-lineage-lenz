# model-lenz is deprecated

**It has been replaced by [PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).**

```bash
npx pbi-lineage-lenz handoff ./MyReport -o handoff.html
```

No Python, no virtualenv, no install. Or open a model in your browser with nothing
installed at all: **https://jonathanjihwankim.github.io/pbi-lineage-lenz/**

## What moved

| model-lenz | PBI Lineage Lenz |
|---|---|
| `model-lenz serve` | the [web app](https://jonathanjihwankim.github.io/pbi-lineage-lenz/), or a handoff file you can send to someone |
| `model-lenz check` | `npx pbi-lineage-lenz check` |
| `model-lenz summary` | `npx pbi-lineage-lenz docs --format md` |
| `model-lenz export` | `npx pbi-lineage-lenz docs --format md\|json\|html` |

Everything model-lenz did is there, plus a model lens that reads table roles from the
direction of relationships, field parameters followed into the model, Direct Lake support,
and a self-contained HTML handoff file that opens in any browser with no Power BI and no
install on the far end.

## Why

Three tools of mine overlapped — [pbip-documenter](https://github.com/JonathanJihwanKim/pbip-documenter),
[pbip-lineage-explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer) and this
one. Keeping a Python engine and a JavaScript one in step meant every parser fix had to be
made twice, and the second one was always late.

The JavaScript engine also runs in the browser, which is what makes the handoff file
possible: one HTML file, no server, and no install for whoever receives it. That was worth
more than keeping two of everything.

## If you still need this tool

Nothing is deleted. The last working release stays on PyPI forever:

```bash
pip install model-lenz==0.4.0
```

Its source is the [`python-model-lenz`](https://github.com/JonathanJihwanKim/pbi-lineage-lenz/tree/python-model-lenz)
branch, tagged [`v0.4.0`](https://github.com/JonathanJihwanKim/pbi-lineage-lenz/releases/tag/v0.4.0).

This release — 0.5.1 — does nothing but print that message and exit non-zero. Non-zero on
purpose: `model-lenz check` was a build gate, and a deprecated version that printed a notice
and exited 0 would leave a gate that always passes standing where a real check used to be.

MIT © Jihwan Kim
