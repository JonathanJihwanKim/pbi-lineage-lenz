# The five lenses

[← back to the README](../README.md)

One model, five ways of looking at it. The web app and the handoff file mount the identical
component, so everything on this page is true of both.

| Lens | The question it answers |
|---|---|
| **Overview** | What am I holding, and what should I look at first? |
| **Model** | Which tables are facts, which are dimensions, and what joins to what? |
| **Source map** | Which physical column is behind this model column — and how sure are we? |
| **Measures** | What is the DAX, which physical columns does it read, and which visuals show it? |
| **Pages** | What is on this report page, and where exactly is this visual? |

---

## Overview

Opens first, and it is the only lens that is not a list. A list is the right shape once you
know what you are looking for and the wrong one when somebody has just sent you a model you
have never seen.

Three things, in order:

1. **What this is** — *"2 facts around 4 dimensions, plus a field parameter and a calculation
   group."*
2. **How much of it is traced** — coverage, with the columns that cannot have a source
   counted separately rather than folded into the failures.
3. **Worth a look** — calculation groups that rewrite measures, columns that could not be
   traced, measures nothing shows, hidden visuals no bookmark reveals, bidirectional and
   inactive relationships. Each is a count you can click into.

Every sentence on this screen is arithmetic over the parsed model. No scores, no grades, no
estimates — a *"model health: B+"* would undo the honesty the source map spends so much
effort on.

## Model

Table roles are read from the **direction of relationships**, not from names. A table that
only originates joins is a fact; one that only receives them is a dimension. `_fct` and
`_dim` line up in one model and will not in the next.

Selection-first: drawing 61 tables and 87 edges at once produces a hairball, and the honest
fix is to draw less rather than to hide some. The list holds everything; the canvas draws one
neighbourhood.

Field parameters and calculation groups get their own chip and their own filter tab, because
`standalone` — true of a field parameter, a measure holder and a genuinely disconnected table
alike — was the largest bucket in a real model and the one that said least. Selecting a
calculation group shows each item with its DAX; selecting a field parameter lists every field
it offers.

## Source map

The table a data engineer and a BI developer read together. Deliberately dense and sortable
rather than pretty: the job is to find one row fast and trust what it says.

Search spans **both vocabularies at once** — type `Net Amount` or `amt_net_usd` and the same
row comes back. Filter by confidence to see only what is assumed, or only what is unresolved.

See [confidence.md](confidence.md) for what the labels mean.

## Measures

The DAX, the physical columns underneath it following measure-to-measure chains, and every
visual that shows it — each located on its page. That last one is the question that decides
whether a change is safe.

Unresolved inputs are **shown, never omitted**: an absent row would read as "nothing
upstream", which is the opposite of the truth.

Where a calculation group rewrites the measure, a note says so under the DAX. That note is
the only warning a reader gets that the expression above it is not what the page displays.

## Pages

Nothing is ever filtered out. Hidden visuals are listed with the bookmark that reveals them,
because "hidden" and "dead" are different answers and only one of them is a problem.

Each field says **how** the visual reaches it: plotted, a text box's dynamic value, a dynamic
title, a filter, a navigation link, conditional formatting, or offered by a field parameter.
"Shows (29)" is only useful if it can say how each of the 29 is shown.

---

## Both names, everywhere

Every column carries its model name and its physical name side by side, with an honest label
on the mapping.

**Press `S`** to swap which vocabulary leads. It physically rearranges the tables rather than
dimming one side: people scan the first column, so the side you think in has to be the side
you read first.

## Deep links

Every measure, column, table, page and visual has a URL you can paste into a chat:

```
handoff.html#/measure:Sales[Gross Margin %]
handoff.html#/column:customer[CustomerKey]
```

The **copy link** button on any detail panel produces one. They work identically in the web
app and in a handoff file opened from disk.

## Accessibility

Every colour carries at least 4.5:1 against its background in both light and dark themes, and
the confidence markers differ in **shape** as well as hue — solid, half-filled, hollow — so
`exact` and `inferred` remain distinguishable under deuteranopia and in greyscale.
