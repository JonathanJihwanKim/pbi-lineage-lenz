"""Tests for `exporters/markdown.py` — handoff card rendering.

Asserts on the *shape* of the markdown (headings, code fences, links, badges)
rather than exact whitespace, so small phrasing tweaks don't churn the test
suite. Where a precise value matters (URL encoding, hidden flag emission) we
pin the exact substring.
"""

from __future__ import annotations

import pytest

from model_lenz.analyzers.relationships import RelationshipGraph
from model_lenz.exporters.markdown import measure_card, table_card
from model_lenz.models.lineage import SourceLineage
from model_lenz.models.semantic import (
    Column,
    Measure,
    Model,
    Partition,
    Relationship,
    Table,
)


def _model_with_star() -> Model:
    """Sales_fct (fact) -[*:1]-> Date (dim), -[*:1]-> Customer (dim).

    Sales_fct has Total Sales (uses Sales_fct[Amount]) and Margin % (uses
    [Total Sales] -- referenced measure). All lineages high-confidence.
    """
    sales = Table(
        name="Sales_fct",
        classification="fact",
        columns=[
            Column(name="OrderID", data_type="Int64", is_key=True),
            Column(name="CustomerKey", data_type="Int64", is_fk=True),
            Column(name="DateKey", data_type="Int64", is_fk=True),
            Column(name="Amount", data_type="Decimal"),
        ],
        measures=[
            Measure(
                name="Total Sales",
                table="Sales_fct",
                expression="Total Sales = SUM ( Sales_fct[Amount] )",
                display_folder="KPIs",
                format_string="0",
            ),
            Measure(
                name="Margin %",
                table="Sales_fct",
                expression="Margin % = DIVIDE ( [Total Sales], 100 )",
                format_string="0.00%",
            ),
            Measure(
                name="Hidden Helper",
                table="Sales_fct",
                expression="Hidden Helper = COUNTROWS ( Sales_fct )",
                is_hidden=True,
            ),
        ],
        partitions=[
            Partition(
                name="p0",
                source_expression="",
                source_lineage=SourceLineage(
                    connector="GoogleBigQuery",
                    schema="analytics",
                    table="fact_orders",
                    fully_qualified="analytics.fact_orders",
                    confidence="high",
                ),
            )
        ],
    )
    date = Table(
        name="Date",
        classification="time",
        columns=[Column(name="DateKey", data_type="Int64", is_key=True)],
        partitions=[
            Partition(
                name="p0",
                source_expression="",
                source_lineage=SourceLineage(
                    connector="GoogleBigQuery",
                    table="dim_date",
                    fully_qualified="analytics.dim_date",
                    confidence="high",
                ),
            )
        ],
    )
    customer = Table(
        name="Customer",
        classification="dim",
        columns=[Column(name="CustomerKey", data_type="Int64", is_key=True)],
        partitions=[
            Partition(
                name="p0",
                source_expression="",
                source_lineage=SourceLineage(
                    connector="GoogleBigQuery",
                    table="dim_customer",
                    fully_qualified="analytics.dim_customer",
                    confidence="high",
                ),
            )
        ],
    )
    rels = [
        Relationship(
            id="r1",
            from_table="Sales_fct",
            from_column="DateKey",
            to_table="Date",
            to_column="DateKey",
        ),
        Relationship(
            id="r2",
            from_table="Sales_fct",
            from_column="CustomerKey",
            to_table="Customer",
            to_column="CustomerKey",
        ),
    ]
    return Model(tables=[sales, date, customer], relationships=rels)


def _rg(model: Model) -> RelationshipGraph:
    return RelationshipGraph.from_relationships(model.relationships)


# --------------------------------------------------------------------------- #
# measure_card
# --------------------------------------------------------------------------- #


def test_measure_card_includes_heading_and_dax_fence():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Total Sales")
    assert card.startswith("# Total Sales (Measure)")
    assert "```dax" in card
    assert "Total Sales = SUM ( Sales_fct[Amount] )" in card


def test_measure_card_lists_direct_tables_with_source():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Total Sales")
    assert "## Direct tables" in card
    assert "`Sales_fct`" in card
    assert "analytics.fact_orders" in card


def test_measure_card_lists_indirect_tables_at_depth():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Total Sales", depth=2)
    # Date and Customer reach Sales_fct via *:1 — propagate to fact = no walk
    # from fact to dim by default in PBI semantics. Without bidi, walking
    # from a fact-side seed yields no indirect dims. Just confirm the section
    # renders even when empty.
    assert "## Indirect tables (depth 2," in card


def test_measure_card_indirect_section_with_dim_seed():
    """A dim-seeded measure reaches the fact only when the edge is bidi.

    Default many-to-one with single crossfilter propagates fact→dim only.
    To get Sales_fct to appear indirectly from a measure on Date, the edge
    has to be bidirectional (a common pattern for role-playing time tables)."""
    m = _model_with_star()
    # Promote the Date edge to bidirectional crossfilter so Date can reach Sales_fct.
    for r in m.relationships:
        if r.to_table == "Date":
            r.crossfilter = "both"
    date = next(t for t in m.tables if t.name == "Date")
    date.measures.append(
        Measure(
            name="Distinct Dates",
            table="Date",
            expression="Distinct Dates = DISTINCTCOUNT ( Date[DateKey] )",
        )
    )
    card = measure_card(m, _rg(m), "Date", "Distinct Dates", depth=2)
    assert "## Indirect tables" in card
    assert "`Sales_fct`" in card


def test_measure_card_referenced_measures_section_present():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Margin %")
    assert "## Referenced measures" in card
    assert "`[Total Sales]`" in card


def test_measure_card_hidden_measure_flagged():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Hidden Helper")
    assert "**Hidden:** true" in card


def test_measure_card_missing_measure_raises_lookup_error():
    m = _model_with_star()
    with pytest.raises(LookupError):
        measure_card(m, _rg(m), "Sales_fct", "Nope")


def test_measure_card_share_url_appended_when_provided():
    m = _model_with_star()
    card = measure_card(
        m, _rg(m), "Sales_fct", "Margin %", depth=3, share_url="http://127.0.0.1:8765"
    )
    # Depth=3 is non-default → must appear in URL. Measure name's '%' encoded.
    assert "View in Model Lenz:" in card
    assert "table=Sales_fct" in card
    assert "measure=Margin%20%25" in card
    assert "depth=3" in card


def test_measure_card_default_depth_omitted_from_share_url():
    m = _model_with_star()
    card = measure_card(
        m, _rg(m), "Sales_fct", "Total Sales", share_url="http://localhost/"
    )
    assert "depth=" not in card.split("View in Model Lenz:")[1]


def test_measure_card_no_share_url_no_footer():
    m = _model_with_star()
    card = measure_card(m, _rg(m), "Sales_fct", "Total Sales")
    assert "View in Model Lenz" not in card


# --------------------------------------------------------------------------- #
# table_card
# --------------------------------------------------------------------------- #


def test_table_card_headings_and_classification():
    m = _model_with_star()
    card = table_card(m, "Sales_fct")
    assert card.startswith("# Sales_fct (Table)")
    assert "**Classification:** `fact`" in card
    assert "## Source lineage" in card
    assert "## Columns (4)" in card
    assert "## Measures hosted (3)" in card
    assert "## Relationships (2)" in card


def test_table_card_lineage_fields_present():
    m = _model_with_star()
    card = table_card(m, "Sales_fct")
    assert "Connector: `GoogleBigQuery`" in card
    assert "Fully qualified: `analytics.fact_orders`" in card
    assert "Confidence: `high`" in card


def test_table_card_column_attrs_rendered():
    m = _model_with_star()
    card = table_card(m, "Sales_fct")
    assert "`OrderID` (Int64) — key" in card
    assert "`CustomerKey` (Int64) — FK" in card


def test_table_card_no_lineage_when_no_partitions():
    calc = Table(
        name="MyParam",
        classification="parameter",
        columns=[Column(name="Value", data_type="Int64")],
    )
    m = Model(tables=[calc])
    card = table_card(m, "MyParam")
    assert "no source detected" in card


def test_table_card_multi_partition_uses_highest_confidence():
    """Incremental refresh fans out into low + high confidence partitions.
    The card must report the high one so a 'low → high' churn doesn't appear
    as a source change."""
    t = Table(
        name="Sales_fct",
        classification="fact",
        columns=[Column(name="Id", data_type="Int64", is_key=True)],
        partitions=[
            Partition(
                name="archival",
                source_expression="",
                source_lineage=SourceLineage(
                    connector="Sql.Database",
                    table="archived",
                    confidence="low",
                ),
            ),
            Partition(
                name="incremental",
                source_expression="",
                source_lineage=SourceLineage(
                    connector="Sql.Database",
                    table="live_orders",
                    fully_qualified="dbo.live_orders",
                    confidence="high",
                ),
            ),
        ],
    )
    m = Model(tables=[t])
    card = table_card(m, "Sales_fct")
    assert "live_orders" in card
    assert "archived" not in card
    assert "Confidence: `high`" in card


def test_table_card_share_url_encodes_table_name():
    m = _model_with_star()
    card = table_card(m, "Sales_fct", share_url="http://127.0.0.1:8765/")
    assert "View in Model Lenz: http://127.0.0.1:8765/?table=Sales_fct" in card


def test_table_card_missing_raises_lookup_error():
    m = _model_with_star()
    with pytest.raises(LookupError):
        table_card(m, "Nope")
