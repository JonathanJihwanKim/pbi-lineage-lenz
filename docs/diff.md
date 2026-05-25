# Diff Two PBIPs, Share Views, and Export

← Back to [README](../README.md)

## Compare two PBIPs

`model-lenz diff` opens a side-by-side comparison of two model snapshots. The diff view opens on a **Graph tab** by default — the same bus-layout canvas you see in single-model mode, painted with green (added), amber (modified), or red (removed) borders on table cards and relationship edges. A **List tab** behind it gives you the per-entity audit: every modified measure's BASE vs HEAD DAX, column-by-column deltas on each modified table, and source-lineage rewrites. The legend strip floating above the canvas reconciles to the same totals as the header — a `+N measure change →` chip jumps you to the List tab for changes that don't have a graph representation.

Both views share the same swap button (flips BASE ↔ HEAD client-side) and the same export controls — `Copy Mermaid` and `Download SVG` in the top bar serialize the current canvas with status colors baked in, ready to paste into a PR description or attach to a design doc.

You can point it at two folders, or at two Git refs in the same repo.

### By Git refs (recommended)

Pass `--git` and two ref strings. Model Lenz materializes each ref into a temp directory via `git archive` — your working tree is never touched, no worktree to clean up:

```powershell
# Diff origin/main vs your current HEAD, in the current repo
model-lenz diff --git origin/main HEAD

# A different repo, with an explicit subpath if the repo has more than one PBIP
model-lenz diff --git main feature/yoy `
  --repo D:\my_pbip_repo `
  --subpath import_contoso_sales.SemanticModel
```

Ref names auto-fill the BASE / HEAD pills. A gold ★ pin appears when BASE is `main`, `master`, `origin/main`, or `origin/master`.

### By folder paths (works everywhere)

When the two snapshots aren't refs in one repo — a teammate sent you a PBIP for review, you have two clones, you want to diff a backup — pass two folder paths directly:

```powershell
model-lenz diff ..\my_pbip_repo-main\import_contoso_sales.SemanticModel `
                .\import_contoso_sales.SemanticModel
```

If you'd rather stay in the worktree pattern you used pre-v0.3.1:

```powershell
cd D:\my_pbip_repo
git worktree add ..\my_pbip_repo-main main
model-lenz diff ..\my_pbip_repo-main\import_contoso_sales.SemanticModel `
                .\import_contoso_sales.SemanticModel
git worktree remove ..\my_pbip_repo-main   # when done
```

Branch names auto-fill the BASE / HEAD pills when either folder is inside a working tree.

---

## Share a view, hand it off, embed it

Every interaction in Model Lenz is one paste away from a teammate's screen. The header buttons are the same on the single-model view and the diff view:

- **Copy link.** Captures your current measure selection and walk depth in the URL — e.g. `/?table=Sales_fct&measure=Margin%20%25&depth=3`. Paste into Slack, a PR comment, or a Jira ticket. Anyone running `model-lenz serve` against the same PBIP lands on the exact same view. Filesystem paths are never encoded.
- **Copy MD.** On the right-hand detail panel. Produces a one-pager Markdown card for the selected measure or table — DAX, referenced measures, direct + indirect tables walked at your current depth, USERELATIONSHIP overrides, source lineage, and a clickable share URL at the bottom. Paste straight into a PR description when asking a data engineer about a column rename.
- **Copy Mermaid.** Header button. Serializes the current canvas as Mermaid `graph LR` syntax. Pastes into [mermaid.live](https://mermaid.live), GitHub / GitLab Markdown, Notion, or any renderer that speaks Mermaid. On the diff view, both table borders and relationship arrows are emitted in their green / amber / red status colors, and removed edges render dashed — the diagram in your PR matches the canvas you reviewed (v0.3.2+).
- **Download SVG.** Header button. Saves a standalone SVG of the current canvas with the active theme baked in — preserves the current pan/zoom so you can frame a sub-graph before exporting. Drop into a design doc or Confluence page.
