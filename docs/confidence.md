# Reading the confidence labels

[← back to the README](../README.md)

This is the part a data engineer will judge the whole tool on, so it is worth thirty
seconds.

**A tool that quietly guesses is worse than one that admits the gap**, because you cannot
tell which rows to trust. Every mapping this tool produces carries a label saying how it was
arrived at.

## Two axes, counted separately

They answer different questions, and collapsing them into one number is how a headline ends
up disagreeing with the rows underneath it.

### Confidence — how sure is this answer?

| label | meaning |
|---|---|
| **`exact`** | The source name is **stated by the model** — a rename pair written down, a projection, a native-SQL select list, a Direct Lake partition, or a chain in which every step is accounted for and none of them *can* rename a column. |
| **`inferred`** | The chain contains a step the tool cannot read, so the name is **assumed** to pass through unchanged. Usually right. Still an assumption. |
| **`unknown`** | No physical table could be established. It says so instead of guessing. |

Note that "this column is computed in DAX and has no physical source" is an **exact** answer.
Confidence is about the answer, not about whether the answer is a path.

### Origin — where do the values come from?

| bucket | meaning | counts toward coverage |
|---|---|---|
| `source` | Read from a physical source system. | **yes** |
| `computed-pq` | Added in Power Query via `Table.AddColumn`. | no |
| `computed-dax` | A DAX calculated column. | no |
| `model-defined` | A field parameter's or calculation group's own columns. | no |
| `unresolved` | Reads from a source, and the tool could not name it. | **yes — as a miss** |

Coverage is `sourced / (sourced + unresolved)`: *of the columns that do read from a source,
how many were traced.*

## Why `model-defined` exists

A field parameter's columns hold a list of `NAMEOF` references. A calculation group's columns
hold the names of its items. Neither reads from anywhere, and neither ever could.

They used to resolve to `unknown` with the reason *"No physical table could be resolved from
the Power Query expression"* — which is not merely unhelpful but false, because there is no
Power Query expression to resolve.

In one real 61-table model that was **67 columns: 81% of everything reported as untraced.**
It held a genuine 96% coverage down to a reported 82%, and it sent a reader hunting for 67
things that were never lost. Counting a table that cannot have a source as a failure to find
its source makes the number mean less, not more.

The three non-source buckets are reported separately rather than merged, because they invite
different reactions. A calculated column with no source is a modelling decision worth
reading. A field parameter's three columns are plumbing, and a reader who sees 65 of them
listed as findings learns to skim the list.

## Completeness is separate again

A calculated table built with `UNION` draws one column from several facts, and DAX records
only the first — so the path shown is right but partial. The row says `+1 more` rather than
reading as the whole answer.

## In the app

The source map filters on all three confidence labels, and the proportional bar at the top
shows the split. Colour is reinforcement, not the message: `exact` is a solid marker,
`inferred` a half-filled one and `unknown` hollow, so the distinction survives greyscale and
colour-blindness. Every colour in the interface carries at least 4.5:1 against its
background in both themes.
