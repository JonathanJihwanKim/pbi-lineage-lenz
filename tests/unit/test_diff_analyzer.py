"""Tests for `analyzers/diff.py`.

Covers each status x entity-kind combination. Helpers build minimal Model
fixtures focused on the one thing each test is asserting.
"""

from __future__ import annotations

from model_lenz.analyzers.diff import diff_models
from model_lenz.models.lineage import SourceLineage
from model_lenz.models.semantic import (
    Column,
    Measure,
    Model,
    Partition,
    Relationship,
    Table,
)


def _model(
    *,
    tables: list[Table] | None = None,
    relationships: list[Relationship] | None = None,
) -> Model:
    return Model(tables=tables or [], relationships=relationships or [])


def _measure(table: str, name: str, expression: str) -> Measure:
    return Measure(name=name, table=table, expression=expression)


def _table_with_measure(table_name: str, m: Measure, *, classification: str = "other") -> Table:
    return Table(
        name=table_name,
        classification=classification,  # type: ignore[arg-type]
        measures=[m],
    )


def _table(
    name: str,
    *,
    classification: str = "other",
    columns: list[str] | None = None,
    lineage: SourceLineage | None = None,
    is_hidden: bool = False,
) -> Table:
    cols = [Column(name=c) for c in (columns or [])]
    parts: list[Partition] = []
    if lineage is not None:
        parts.append(Partition(name="p0", source_expression="", source_lineage=lineage))
    return Table(
        name=name,
        classification=classification,  # type: ignore[arg-type]
        columns=cols,
        partitions=parts,
        is_hidden=is_hidden,
    )


def _rel(
    rid: str,
    f_table: str,
    f_col: str,
    t_table: str,
    t_col: str,
    *,
    cardinality: str = "many_to_one",
    crossfilter: str = "single",
    is_active: bool = True,
) -> Relationship:
    return Relationship(
        id=rid,
        from_table=f_table,
        from_column=f_col,
        to_table=t_table,
        to_column=t_col,
        cardinality=cardinality,  # type: ignore[arg-type]
        crossfilter=crossfilter,  # type: ignore[arg-type]
        is_active=is_active,
    )


# --------------------------------------------------------------------------- #
# Measures
# --------------------------------------------------------------------------- #


def test_measure_added_when_only_in_head():
    base = _model()
    head = _model(
        tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])"))]
    )
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.measures_added == 1
    assert d.measures[0].status == "added"
    assert d.measures[0].name == "Total"
    assert d.measures[0].head is not None
    assert d.measures[0].before is None


def test_measure_removed_when_only_in_base():
    base = _model(
        tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])"))]
    )
    head = _model()
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.measures_removed == 1
    assert d.measures[0].status == "removed"
    assert d.measures[0].before is not None
    assert d.measures[0].head is None


def test_measure_unchanged_is_omitted():
    expr = "SUM ( FactSales[Amount] )"
    base = _model(tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", expr))])
    head = _model(tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", expr))])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.measures_added == 0
    assert d.counts.measures_removed == 0
    assert d.counts.measures_modified == 0
    assert d.measures == []


def test_measure_dax_changed_flagged_modified():
    base = _model(
        tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])"))]
    )
    head = _model(
        tables=[
            _table_with_measure(
                "FactSales", _measure("FactSales", "Total", "SUMX(FactSales, FactSales[Amt] * 1.1)")
            )
        ]
    )
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.measures_modified == 1
    md = d.measures[0]
    assert md.status == "modified"
    assert md.dax_changed is True


def test_measure_whitespace_only_change_is_unchanged():
    # Pure whitespace differences don't count as a DAX change (post .strip()).
    base = _model(
        tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])"))]
    )
    head = _model(
        tables=[
            _table_with_measure(
                "FactSales", _measure("FactSales", "Total", "  SUM(FactSales[Amt])  ")
            )
        ]
    )
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.measures == []


def test_measure_refs_changed_when_new_table_referenced():
    base = _model(
        tables=[_table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])"))]
    )
    head = _model(
        tables=[
            _table_with_measure(
                "FactSales",
                _measure(
                    "FactSales", "Total", "CALCULATE(SUM(FactSales[Amt]), DimDate[Year] = 2026)"
                ),
            )
        ]
    )
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.measures_modified == 1
    assert d.measures[0].dax_changed is True
    assert d.measures[0].refs_changed is True


# --------------------------------------------------------------------------- #
# Tables
# --------------------------------------------------------------------------- #


def test_table_added():
    base = _model()
    head = _model(tables=[_table("DimNew", classification="dim", columns=["id", "name"])])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.tables_added == 1
    t = d.tables[0]
    assert t.status == "added"
    assert t.name == "DimNew"
    assert t.classification_head == "dim"
    assert t.columns_added == ["id", "name"]


def test_table_removed():
    base = _model(tables=[_table("OldTable", classification="other", columns=["x"])])
    head = _model()
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.tables_removed == 1
    assert d.tables[0].columns_removed == ["x"]


def test_table_column_added_and_removed_diffed():
    base = _model(tables=[_table("DimDate", columns=["date_sk", "year"])])
    head = _model(tables=[_table("DimDate", columns=["date_sk", "year", "quarter"])])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.tables_modified == 1
    t = d.tables[0]
    assert t.columns_added == ["quarter"]
    assert t.columns_removed == []


def test_table_classification_flip_flagged():
    base = _model(tables=[_table("Sales", classification="other")])
    head = _model(tables=[_table("Sales", classification="fact")])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.tables_modified == 1
    t = d.tables[0]
    assert t.classification_before == "other"
    assert t.classification_head == "fact"


def test_table_source_lineage_changed_when_fqn_differs():
    old = SourceLineage(
        connector="GoogleBigQuery",
        schema="sales",
        table="fact_orders",
        fully_qualified="prod.sales.fact_orders",
        confidence="high",
    )
    new = SourceLineage(
        connector="GoogleBigQuery",
        schema="sales",
        table="fact_orders_v2",
        fully_qualified="prod.sales.fact_orders_v2",
        confidence="high",
    )
    base = _model(tables=[_table("Sales", lineage=old)])
    head = _model(tables=[_table("Sales", lineage=new)])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.tables_modified == 1
    assert d.tables[0].source_lineage_changed is True


def test_table_unchanged_when_only_confidence_differs_under_same_fqn():
    # Same source, different confidence label — should NOT count as a change.
    low = SourceLineage(
        connector="GoogleBigQuery",
        schema="sales",
        table="fact_orders",
        fully_qualified="prod.sales.fact_orders",
        confidence="low",
    )
    high = SourceLineage(
        connector="GoogleBigQuery",
        schema="sales",
        table="fact_orders",
        fully_qualified="prod.sales.fact_orders",
        confidence="high",
    )
    base = _model(tables=[_table("Sales", lineage=low)])
    head = _model(tables=[_table("Sales", lineage=high)])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.tables == []


# --------------------------------------------------------------------------- #
# Relationships
# --------------------------------------------------------------------------- #


def test_relationship_keyed_by_canonical_endpoints_not_guid():
    # Same endpoints, different GUIDs → "unchanged"; not duplicated as add+remove.
    base = _model(relationships=[_rel("guid-A", "FactSales", "date_fk", "DimDate", "date_sk")])
    head = _model(relationships=[_rel("guid-B", "FactSales", "date_fk", "DimDate", "date_sk")])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.relationships == []


def test_relationship_direction_flip_is_remove_plus_add():
    base = _model(relationships=[_rel("r1", "A", "ak", "B", "bk")])
    head = _model(relationships=[_rel("r1", "B", "bk", "A", "ak")])
    d = diff_models(base, head, base_label="main", head_label="feat")
    statuses = sorted(r.status for r in d.relationships)
    assert statuses == ["added", "removed"]


def test_relationship_inactive_flag_change_is_modified():
    base = _model(relationships=[_rel("r1", "A", "ak", "B", "bk", is_active=True)])
    head = _model(relationships=[_rel("r1", "A", "ak", "B", "bk", is_active=False)])
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.relationships_modified == 1
    r = d.relationships[0]
    assert r.is_active_changed is True
    assert r.cardinality_changed is False


def test_relationship_cardinality_change_is_modified():
    base = _model(
        relationships=[_rel("r1", "A", "ak", "B", "bk", cardinality="many_to_one")]
    )
    head = _model(
        relationships=[_rel("r1", "A", "ak", "B", "bk", cardinality="many_to_many")]
    )
    d = diff_models(base, head, base_label="main", head_label="feat")
    assert d.counts.relationships_modified == 1
    assert d.relationships[0].cardinality_changed is True


# --------------------------------------------------------------------------- #
# Top-level payload
# --------------------------------------------------------------------------- #


def test_payload_carries_labels_and_paths_through():
    d = diff_models(
        _model(),
        _model(),
        base_label="production",
        head_label="PR #142",
        base_path="C:/base",
        head_path="C:/head",
        base_is_default_branch=True,
    )
    assert d.base_label == "production"
    assert d.head_label == "PR #142"
    assert d.base_path == "C:/base"
    assert d.head_path == "C:/head"
    assert d.base_is_default_branch is True


def test_identical_models_emit_empty_payload():
    rels = [_rel("r1", "FactSales", "date_fk", "DimDate", "date_sk")]
    tables = [
        _table_with_measure("FactSales", _measure("FactSales", "Total", "SUM(FactSales[Amt])")),
        _table("DimDate", classification="time"),
    ]
    base = _model(tables=tables, relationships=rels)
    head = _model(tables=tables, relationships=rels)
    d = diff_models(base, head, base_label="m", head_label="h")
    assert d.measures == []
    assert d.tables == []
    assert d.relationships == []
    assert d.counts.measures_added == 0
    assert d.counts.tables_modified == 0


# --------------------------------------------------------------------------- #
# Description / metadata-only diffs (added in 0.3.1)
# --------------------------------------------------------------------------- #


def test_measure_description_only_change_is_modified():
    base_m = Measure(name="Total", table="FactSales", expression="SUM(FactSales[Amt])")
    head_m = Measure(
        name="Total",
        table="FactSales",
        expression="SUM(FactSales[Amt])",
        description="Adds amounts across the sales fact.",
    )
    base = _model(tables=[Table(name="FactSales", measures=[base_m])])
    head = _model(tables=[Table(name="FactSales", measures=[head_m])])
    d = diff_models(base, head, base_label="m", head_label="h")
    assert d.counts.measures_modified == 1
    md = d.measures[0]
    assert md.status == "modified"
    assert md.description_changed is True
    assert md.dax_changed is False
    assert md.refs_changed is False


def test_measure_description_whitespace_only_is_unchanged():
    base_m = Measure(name="Total", table="FactSales", expression="x", description="hello")
    head_m = Measure(name="Total", table="FactSales", expression="x", description="  hello  ")
    base = _model(tables=[Table(name="FactSales", measures=[base_m])])
    head = _model(tables=[Table(name="FactSales", measures=[head_m])])
    d = diff_models(base, head, base_label="m", head_label="h")
    assert d.measures == []


def test_measure_display_folder_change_flagged():
    base_m = Measure(name="Total", table="FactSales", expression="x", display_folder="A")
    head_m = Measure(name="Total", table="FactSales", expression="x", display_folder="B")
    base = _model(tables=[Table(name="FactSales", measures=[base_m])])
    head = _model(tables=[Table(name="FactSales", measures=[head_m])])
    d = diff_models(base, head, base_label="m", head_label="h")
    assert len(d.measures) == 1
    assert d.measures[0].display_folder_changed is True
    assert d.measures[0].dax_changed is False


def test_measure_format_string_change_flagged():
    base_m = Measure(name="Total", table="FactSales", expression="x", format_string="#,0")
    head_m = Measure(name="Total", table="FactSales", expression="x", format_string="0.00%")
    base = _model(tables=[Table(name="FactSales", measures=[base_m])])
    head = _model(tables=[Table(name="FactSales", measures=[head_m])])
    d = diff_models(base, head, base_label="m", head_label="h")
    assert d.measures[0].format_string_changed is True


def test_measure_is_hidden_change_flagged():
    base_m = Measure(name="Total", table="FactSales", expression="x", is_hidden=False)
    head_m = Measure(name="Total", table="FactSales", expression="x", is_hidden=True)
    base = _model(tables=[Table(name="FactSales", measures=[base_m])])
    head = _model(tables=[Table(name="FactSales", measures=[head_m])])
    d = diff_models(base, head, base_label="m", head_label="h")
    assert d.measures[0].is_hidden_changed is True


def test_table_description_only_change_is_modified():
    base_t = Table(name="FactSales", description="old desc")
    head_t = Table(name="FactSales", description="new desc")
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    assert d.counts.tables_modified == 1
    td = d.tables[0]
    assert td.status == "modified"
    assert td.description_changed is True
    assert td.is_hidden_changed is False


def test_table_is_hidden_change_now_surfaces_in_diff():
    # Regression: 0.3.0 detected this flip but never reported it.
    base_t = Table(name="FactSales", is_hidden=False)
    head_t = Table(name="FactSales", is_hidden=True)
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    assert d.counts.tables_modified == 1
    assert d.tables[0].is_hidden_changed is True


def test_column_description_change_surfaces_in_columns_modified():
    base_t = Table(
        name="FactSales",
        columns=[Column(name="Amount", data_type="decimal", description="Sale value")],
    )
    head_t = Table(
        name="FactSales",
        columns=[Column(name="Amount", data_type="decimal", description="Sale value (USD)")],
    )
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    assert d.counts.tables_modified == 1
    td = d.tables[0]
    assert len(td.columns_modified) == 1
    cd = td.columns_modified[0]
    assert cd.name == "Amount"
    assert cd.description_changed is True
    assert cd.data_type_changed is False


def test_column_data_type_and_hidden_change_flagged():
    base_t = Table(
        name="FactSales",
        columns=[Column(name="Amount", data_type="int64", is_hidden=False)],
    )
    head_t = Table(
        name="FactSales",
        columns=[Column(name="Amount", data_type="decimal", is_hidden=True)],
    )
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    cd = d.tables[0].columns_modified[0]
    assert cd.data_type_changed is True
    assert cd.is_hidden_changed is True
    assert cd.before is not None and cd.before.data_type == "int64"
    assert cd.head is not None and cd.head.data_type == "decimal"


def test_column_expression_change_flagged():
    base_t = Table(
        name="FactSales",
        columns=[Column(name="Margin", expression="[Sales] - [Cost]")],
    )
    head_t = Table(
        name="FactSales",
        columns=[Column(name="Margin", expression="[Sales] - [Cost] - [Tax]")],
    )
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    assert d.tables[0].columns_modified[0].expression_changed is True


def test_unchanged_column_is_omitted_from_columns_modified():
    col = Column(name="Amount", data_type="decimal", description="x")
    base_t = Table(name="FactSales", columns=[col])
    head_t = Table(name="FactSales", columns=[col])
    d = diff_models(_model(tables=[base_t]), _model(tables=[head_t]), base_label="m", head_label="h")
    assert d.tables == []
