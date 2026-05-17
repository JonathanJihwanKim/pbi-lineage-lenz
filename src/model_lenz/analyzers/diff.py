"""Compare two parsed `Model` snapshots and emit a `DiffPayload`.

Used by the v0.3 `model-lenz diff` CLI and `GET /api/diff` endpoint.

Design choices that aren't obvious from the code:

- Measures are keyed by `(table, name)`. The same measure name can legitimately
  appear on two different tables (rare but valid TMDL).
- Tables are keyed by name.
- Relationships are keyed by `from_table.from_column->to_table.to_column`,
  *not* by the GUID `id`. Power BI rewrites relationship GUIDs on save in some
  scenarios; keying by the canonical endpoint quadruple is stable across saves
  and matches the user's mental model ("the relationship from FactSales to
  DimCustomer").
- A relationship that flipped direction (A→B in base, B→A in head) reads as
  one removed + one added, which is what a reviewer wants to see — direction
  changes are not "modified," they're a structural rewire.
- For multi-partition tables (incremental refresh), source-lineage comparison
  uses the highest-confidence partition only. Otherwise a "low → high"
  confidence flip on the same underlying source would spuriously read as a
  source change.
"""

from __future__ import annotations

from model_lenz.models.diff import (
    ColumnDiff,
    DiffCounts,
    DiffPayload,
    MeasureDiff,
    RelationshipDiff,
    TableDiff,
)
from model_lenz.models.semantic import Measure, Model, Relationship, Table
from model_lenz.parsers.dax import extract_refs

_CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1}


def diff_models(
    base: Model,
    head: Model,
    *,
    base_label: str,
    head_label: str,
    base_path: str = "",
    head_path: str = "",
    base_is_default_branch: bool = False,
) -> DiffPayload:
    measures = _measures_diff(base, head)
    tables = _tables_diff(base, head)
    relationships = _relationships_diff(base, head)

    counts = DiffCounts()
    for m in measures:
        if m.status == "added":
            counts.measures_added += 1
        elif m.status == "removed":
            counts.measures_removed += 1
        else:
            counts.measures_modified += 1
    for t in tables:
        if t.status == "added":
            counts.tables_added += 1
        elif t.status == "removed":
            counts.tables_removed += 1
        else:
            counts.tables_modified += 1
    for r in relationships:
        if r.status == "added":
            counts.relationships_added += 1
        elif r.status == "removed":
            counts.relationships_removed += 1
        else:
            counts.relationships_modified += 1

    return DiffPayload(
        base_label=base_label,
        head_label=head_label,
        base_path=base_path,
        head_path=head_path,
        base_is_default_branch=base_is_default_branch,
        counts=counts,
        measures=measures,
        tables=tables,
        relationships=relationships,
    )


# --------------------------------------------------------------------------- #
# Per-entity diffs
# --------------------------------------------------------------------------- #


def _measures_diff(base: Model, head: Model) -> list[MeasureDiff]:
    b = _measure_index(base)
    h = _measure_index(head)
    out: list[MeasureDiff] = []
    for key in sorted(set(b) | set(h)):
        table_name, measure_name = key
        bm = b.get(key)
        hm = h.get(key)
        if bm is None:
            out.append(
                MeasureDiff(
                    status="added",
                    table=table_name,
                    name=measure_name,
                    head=hm,
                    dax_changed=True,
                    refs_changed=True,
                    userel_changed=True,
                )
            )
        elif hm is None:
            out.append(
                MeasureDiff(
                    status="removed",
                    table=table_name,
                    name=measure_name,
                    before=bm,
                )
            )
        else:
            dax_changed = (bm.expression or "").strip() != (hm.expression or "").strip()
            refs_changed = False
            userel_changed = False
            try:
                b_refs = extract_refs(bm.expression or "")
                h_refs = extract_refs(hm.expression or "")
                refs_changed = b_refs.tables != h_refs.tables
                userel_changed = set(b_refs.userel_hints) != set(h_refs.userel_hints)
            except Exception:
                # Defensive: if the DAX tokenizer chokes on either side, fall
                # back to the textual comparison. Better to flag the measure
                # than to drop it from the diff silently.
                pass
            description_changed = (bm.description or "").strip() != (hm.description or "").strip()
            display_folder_changed = (bm.display_folder or "") != (hm.display_folder or "")
            format_string_changed = (bm.format_string or "") != (hm.format_string or "")
            is_hidden_changed = bm.is_hidden != hm.is_hidden
            if (
                dax_changed
                or refs_changed
                or userel_changed
                or description_changed
                or display_folder_changed
                or format_string_changed
                or is_hidden_changed
            ):
                out.append(
                    MeasureDiff(
                        status="modified",
                        table=table_name,
                        name=measure_name,
                        before=bm,
                        head=hm,
                        dax_changed=dax_changed,
                        refs_changed=refs_changed,
                        userel_changed=userel_changed,
                        description_changed=description_changed,
                        display_folder_changed=display_folder_changed,
                        format_string_changed=format_string_changed,
                        is_hidden_changed=is_hidden_changed,
                    )
                )
    return out


def _tables_diff(base: Model, head: Model) -> list[TableDiff]:
    b = _table_index(base)
    h = _table_index(head)
    out: list[TableDiff] = []
    for name in sorted(set(b) | set(h)):
        bt = b.get(name)
        ht = h.get(name)
        if bt is None:
            assert ht is not None
            out.append(
                TableDiff(
                    status="added",
                    name=name,
                    head=ht,
                    classification_head=ht.classification,
                    columns_added=[c.name for c in ht.columns],
                )
            )
        elif ht is None:
            out.append(
                TableDiff(
                    status="removed",
                    name=name,
                    before=bt,
                    classification_before=bt.classification,
                    columns_removed=[c.name for c in bt.columns],
                )
            )
        else:
            b_cols = {c.name for c in bt.columns}
            h_cols = {c.name for c in ht.columns}
            cols_added = sorted(h_cols - b_cols)
            cols_removed = sorted(b_cols - h_cols)
            cols_modified = _columns_diff(bt, ht)
            b_lineage = _best_lineage_dict(bt)
            h_lineage = _best_lineage_dict(ht)
            lineage_changed = b_lineage != h_lineage
            cls_changed = bt.classification != ht.classification
            hidden_changed = bt.is_hidden != ht.is_hidden
            description_changed = (bt.description or "").strip() != (ht.description or "").strip()
            if (
                cols_added
                or cols_removed
                or cols_modified
                or lineage_changed
                or cls_changed
                or hidden_changed
                or description_changed
            ):
                out.append(
                    TableDiff(
                        status="modified",
                        name=name,
                        before=bt,
                        head=ht,
                        source_lineage_changed=lineage_changed,
                        columns_added=cols_added,
                        columns_removed=cols_removed,
                        columns_modified=cols_modified,
                        classification_before=bt.classification if cls_changed else None,
                        classification_head=ht.classification if cls_changed else None,
                        description_changed=description_changed,
                        is_hidden_changed=hidden_changed,
                    )
                )
    return out


def _columns_diff(bt: Table, ht: Table) -> list[ColumnDiff]:
    """Per-column delta for columns that exist on both sides. Added / removed
    columns are surfaced separately as `columns_added` / `columns_removed`."""
    b_index = {c.name: c for c in bt.columns}
    h_index = {c.name: c for c in ht.columns}
    out: list[ColumnDiff] = []
    for name in sorted(set(b_index) & set(h_index)):
        bc = b_index[name]
        hc = h_index[name]
        description_changed = (bc.description or "").strip() != (hc.description or "").strip()
        data_type_changed = (bc.data_type or "") != (hc.data_type or "")
        is_hidden_changed = bc.is_hidden != hc.is_hidden
        is_key_changed = bc.is_key != hc.is_key
        source_column_changed = (bc.source_column or "") != (hc.source_column or "")
        expression_changed = (bc.expression or "").strip() != (hc.expression or "").strip()
        if (
            description_changed
            or data_type_changed
            or is_hidden_changed
            or is_key_changed
            or source_column_changed
            or expression_changed
        ):
            out.append(
                ColumnDiff(
                    name=name,
                    before=bc,
                    head=hc,
                    description_changed=description_changed,
                    data_type_changed=data_type_changed,
                    is_hidden_changed=is_hidden_changed,
                    is_key_changed=is_key_changed,
                    source_column_changed=source_column_changed,
                    expression_changed=expression_changed,
                )
            )
    return out


def _relationships_diff(base: Model, head: Model) -> list[RelationshipDiff]:
    b = _rel_index(base)
    h = _rel_index(head)
    out: list[RelationshipDiff] = []
    for key in sorted(set(b) | set(h)):
        br = b.get(key)
        hr = h.get(key)
        if br is None:
            out.append(RelationshipDiff(status="added", key=key, head=hr))
        elif hr is None:
            out.append(RelationshipDiff(status="removed", key=key, before=br))
        else:
            active_changed = br.is_active != hr.is_active
            card_changed = br.cardinality != hr.cardinality
            cross_changed = br.crossfilter != hr.crossfilter
            if active_changed or card_changed or cross_changed:
                out.append(
                    RelationshipDiff(
                        status="modified",
                        key=key,
                        before=br,
                        head=hr,
                        is_active_changed=active_changed,
                        cardinality_changed=card_changed,
                        crossfilter_changed=cross_changed,
                    )
                )
    return out


# --------------------------------------------------------------------------- #
# Indexers / helpers
# --------------------------------------------------------------------------- #


def _measure_index(model: Model) -> dict[tuple[str, str], Measure]:
    return {(t.name, m.name): m for t in model.tables for m in t.measures}


def _table_index(model: Model) -> dict[str, Table]:
    return {t.name: t for t in model.tables}


def _rel_index(model: Model) -> dict[str, Relationship]:
    return {_rel_key(r): r for r in model.relationships}


def _rel_key(r: Relationship) -> str:
    return f"{r.from_table}.{r.from_column}->{r.to_table}.{r.to_column}"


def _best_lineage_dict(t: Table) -> dict | None:
    """Highest-confidence partition's source identifier, normalized for compare.

    Returns None if no partition has lineage. Compares against another table's
    output via dict equality — None == None is "both had no source," dicts
    with identical connector/schema/table/fully_qualified mean "same source."
    """
    best = None
    best_rank = -1
    for p in t.partitions:
        if p.source_lineage is None:
            continue
        rank = _CONFIDENCE_RANK.get(p.source_lineage.confidence, 0)
        if rank > best_rank:
            best = p.source_lineage
            best_rank = rank
    if best is None:
        return None
    return {
        "connector": best.connector,
        "schema": best.schema_,
        "table": best.table,
        "fully_qualified": best.fully_qualified,
    }
