# Calculation groups and field parameters

[← back to the README](../README.md)

These two are where a lineage tool quietly gets things wrong, because both are references to
other references. Finding the reference is not the same as following it.

---

## Field parameters

A field parameter is a calculated table of `NAMEOF` references, bound to a visual as a single
entry in `queryState.<role>.fieldParameters`. The report says *"this well holds
prmMeasures"* and stops. The list of 22 measures behind that name lives in the semantic
model, in DAX.

**What the tool does.** It reads the parameter's DAX, resolves every `NAMEOF` target against
the model, and adds each one to the visual's field list marked `via: parameter` — *offered*
rather than *shown*.

Not following it understated a real pivot table by fifteen measures: the tool named the seven
currently-selected projections plus an opaque `prmMeasures`, so a reader was told the visual
shows seven measures when a slicer lets them display any of twenty-two. It also mislabelled
the relationship — `Orders On Time %` was reported as *filtering* that visual, when a reader
can put it on the canvas.

**Three shapes occur, all in one real model:**

```dax
NAMEOF('Measure'[Orders On Time %])                    -- quoted table
NAMEOF(Range[Category Number Name Combined])           -- bare table
NAMEOF([Picking Productivity Orderlines per Hour])     -- no table at all
```

The third is legal, because a measure reference does not need its table. It resolves against
the model rather than against the text.

**Matching is case-insensitive**, like DAX itself. One real parameter writes
`NAMEOF('Measure'[Orders with Target Not Met])` for a measure defined as `Orders with Target
not Met`; matching on the literal text invented a second measure that does not exist.

**A field it offers that the model no longer contains is dropped, not listed.** That is a
broken reference — `check` reports it, and inventing a row for it here would hide it.

### Where you see it

- **Model lens** — a `field parameter` chip, and the detail panel lists every field it
  offers as a link.
- **Pages lens** — fields reached through a parameter are labelled *field parameter*, so
  "shows (29)" says how each of the 29 is reached.
- **Measures lens** — a measure a parameter offers counts as used, so it is not reported as
  an orphan.
- **`docs`** — a `## Field parameters` section listing every parameter, everything it offers,
  and how many visuals bind it.

---

## Calculation groups

A calculation group's items wrap `SELECTEDMEASURE()` around whatever measure the visual
shows. Selecting *YTD* does not change the measure; it changes what the measure evaluates to,
on that visual only.

This is the single hardest thing to discover by reading a model, because it is invisible from
every direction:

- it is **not a measure**, so a measure listing skips it;
- its table has **no physical source**, so a source map has nothing to say about it;
- its effect appears on **visuals that never name the group in their DAX**;
- the measure being rewritten **contains no hint** that anything is wrapping it.

Someone editing a measure and checking the visual would read a different expression than the
one they changed, and conclude their edit had no effect.

**What the tool does.** It reads the group and its items from TMDL, keeps the DAX of each
item, and records every visual that binds the group's column. From that it can say which
measures are rewritten and where.

### Where you see it

- **Overview** — leads the observations list, because it is the finding most likely to
  explain a number somebody cannot reproduce.
- **Model lens** — a `calculation group` chip, and the detail panel shows each item with its
  DAX. This is the only place that DAX appears at all.
- **Measures lens** — a note under the measure's own DAX: *"Rewritten by a calculation group.
  1 of the 12 visuals showing this measure also binds 'Time Intelligence', so what they
  display is this expression wrapped in the selected calculation item — not this
  expression."*
- **Pages lens** — visuals that apply one are marked.
- **`docs`** — a `## Calculation groups` section with every item's DAX and the visuals it
  reaches.

---

## What the tool cannot see

Honest limits, because a tool that overstates these is worse than one that says nothing:

- **Which item is selected at render time.** That is runtime state, not model definition. The
  tool says which groups apply, never which item was active.
- **Precedence between two calculation groups** is read from TMDL where it is stated, but the
  *combined* effect of two groups on one visual is not simulated.
- **Dynamic format strings** on calculation items are parsed as expressions, not evaluated.
- **A field parameter built by something other than `NAMEOF`** — a hand-authored table of
  string literals, for instance — is not a field parameter as far as this tool is concerned,
  because there is nothing to follow.

## Where they come from in the source

Neither is guessed from a naming convention. A calculation group is found by the
`calculationGroup` block in TMDL; a field parameter by `NAMEOF` in its partition expression.
`prm*` prefixes line up in one model and will not in the next.

Both are exercised end to end by [`samples/contoso`](../samples/contoso/), which carries a
four-item calculation group and a five-measure field parameter bound to a real visual — so a
regression in any of the above fails the build rather than being noticed months later.
