"""Tests for the TMDL block parser."""

from __future__ import annotations

import textwrap

from model_lenz.parsers.tmdl import parse


def _norm(s: str) -> str:
    """Strip the common indent on a block of text and convert leading 4-space
    indent to tabs, so test fixtures stay readable."""
    s = textwrap.dedent(s).lstrip("\n")
    out_lines: list[str] = []
    for line in s.splitlines():
        depth = 0
        i = 0
        while i + 4 <= len(line) and line[i : i + 4] == "    ":
            depth += 1
            i += 4
        out_lines.append("\t" * depth + line[i:])
    return "\n".join(out_lines)


def test_simple_table_with_columns():
    src = _norm(
        """
        table 'Sales'
            lineageTag: abc
            isHidden

            column Quantity
                dataType: int64
                sourceColumn: Quantity
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    assert len(blocks) == 1
    table = blocks[0]
    assert table.keyword == "table"
    assert table.name == "Sales"
    assert table.properties["lineageTag"] == "abc"
    assert "isHidden" in table.flags
    assert len(table.children) == 1
    col = table.children[0]
    assert col.keyword == "column"
    assert col.name == "Quantity"
    assert col.properties["dataType"] == "int64"


def test_quoted_names_and_escapes():
    # The escape `''` represents a single quote inside a quoted identifier.
    src = _norm(
        """
        table 'A''s Table'
            column 'O''Brien'
                dataType: string
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    assert blocks[0].name == "A's Table"
    assert blocks[0].children[0].name == "O'Brien"


def test_single_line_measure_inline_expression():
    src = _norm(
        """
        table T
            measure 'X' = SUM ( T[c] )
                formatString: #,0
        """
    )
    blocks, _ = parse(src)
    measure = blocks[0].children[0]
    assert measure.keyword == "measure"
    assert measure.name == "X"
    assert measure.expression == "SUM ( T[c] )"
    assert measure.properties["formatString"] == "#,0"


def test_multiline_measure_expression_stops_at_property():
    src = _norm(
        """
        table T
            measure 'M' =
                    IF (
                        TRUE (),
                        SUM ( T[c] ),
                        0
                    )
                formatString: #,0
                displayFolder: F
        """
    )
    blocks, _ = parse(src)
    m = blocks[0].children[0]
    assert "IF (" in m.expression
    assert "SUM ( T[c] )" in m.expression
    # Property must not have been swallowed into the expression.
    assert m.properties["formatString"] == "#,0"
    assert m.properties["displayFolder"] == "F"


def test_fenced_format_string_definition():
    src = _norm(
        """
        table T
            measure 'M' = SUM(T[c])
                formatStringDefinition = ```
                        SWITCH ( TRUE (), [M] > 0, "+#0", "-#0" )
                        ```
                lineageTag: 1
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    m = blocks[0].children[0]
    assert "SWITCH" in m.properties["formatStringDefinition"]
    assert m.properties["lineageTag"] == "1"


def test_partition_with_source_let_in_block():
    src = _norm(
        """
        table T
            partition 'p1' = m
                mode: import
                source =
                        let
                            Source = SomeQuery
                        in
                            Source
        """
    )
    blocks, _ = parse(src)
    p = blocks[0].children[0]
    assert p.keyword == "partition"
    assert p.inline_value == "m"
    assert p.properties["mode"] == "import"
    src_text = p.properties["source"]
    assert src_text.lstrip().startswith("let")
    assert "in" in src_text and "Source" in src_text


def test_relationships_file():
    src = _norm(
        """
        relationship 11111111-1111-1111-1111-111111111111
            fromColumn: Sales.date_fk
            toColumn: 'Time Period'.date_sk

        relationship 22222222-2222-2222-2222-222222222222
            crossFilteringBehavior: bothDirections
            fromCardinality: one
            fromColumn: A.x
            toColumn: B.y
        """
    )
    blocks, _ = parse(src)
    assert all(b.keyword == "relationship" for b in blocks)
    assert blocks[0].properties["fromColumn"] == "Sales.date_fk"
    assert blocks[0].properties["toColumn"] == "'Time Period'.date_sk"
    assert blocks[1].properties["crossFilteringBehavior"] == "bothDirections"
    assert blocks[1].properties["fromCardinality"] == "one"


def test_annotations_and_changedProperty_attach_to_block():
    src = _norm(
        """
        table T
            column c
                dataType: int64
                changedProperty = IsHidden
                annotation Foo = Bar
        """
    )
    blocks, _ = parse(src)
    col = blocks[0].children[0]
    assert col.annotations.get("Foo") == "Bar"
    # changedProperty is recorded with a marker key
    assert any(k.startswith("changedProperty:") for k in col.annotations)


def test_unknown_keyword_treated_as_property_safely():
    # Future / unknown TMDL keys must not crash the parser; they get captured.
    src = _norm(
        """
        table T
            someBrandNewProperty: yes
            anotherFlag
        """
    )
    blocks, warns = parse(src)
    assert blocks[0].properties.get("someBrandNewProperty") == "yes"
    assert "anotherFlag" in blocks[0].flags
    assert warns == []


def test_calculated_column_expression():
    src = _norm(
        """
        table T
            column 'C' =
                    A[x] + B[y]
                isHidden
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    col = blocks[0].children[0]
    assert col.expression.strip() == "A[x] + B[y]"
    assert "isHidden" in col.flags


def test_multiple_top_level_blocks():
    src = _norm(
        """
        expression _BillingProject = "abc" meta [IsParameterQuery=true]
            lineageTag: 1

        expression q1 =
                let
                    Source = "x"
                in
                    Source
            queryGroup: G
        """
    )
    blocks, _ = parse(src)
    names = [b.name for b in blocks if b.keyword == "expression"]
    assert names == ["_BillingProject", "q1"]


# --------------------------------------------------------------------------- #
# `///` doc-comments
# --------------------------------------------------------------------------- #


def test_triple_slash_attaches_to_following_measure():
    src = _norm(
        """
        table 'Sales'
            /// Counts the number of unique orders.
            measure 'Number of Orders' = DISTINCTCOUNT(sales[OrderKey])
                formatString: #,0
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    table = blocks[0]
    measure = table.children[0]
    assert measure.keyword == "measure"
    assert measure.description == "Counts the number of unique orders."


def test_triple_slash_multi_line_joins_with_newline():
    src = _norm(
        """
        table 'Sales'
            /// First line.
            /// Second line.
            measure 'X' = 1
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    measure = blocks[0].children[0]
    assert measure.description == "First line.\nSecond line."


def test_triple_slash_blank_line_between_doc_and_block_is_tolerated():
    src = _norm(
        """
        table 'Sales'
            /// Documented.

            measure 'X' = 1
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    assert blocks[0].children[0].description == "Documented."


def test_triple_slash_on_table_and_column():
    src = _norm(
        """
        /// Table description.
        table 'Sales'
            /// Column description.
            column Quantity
                dataType: int64
        """
    )
    blocks, warns = parse(src)
    assert warns == []
    table = blocks[0]
    assert table.description == "Table description."
    column = table.children[0]
    assert column.description == "Column description."


def test_triple_slash_orphan_at_eof_emits_warning():
    src = _norm(
        """
        table 'Sales'
            measure 'X' = 1

        /// orphan
        """
    )
    _, warns = parse(src)
    assert any("trailing doc-comment" in w for w in warns)


def test_triple_slash_strips_one_leading_space_only():
    src = _norm(
        """
        ///  Two leading spaces.
        table 'Sales'
        """
    )
    blocks, _ = parse(src)
    assert blocks[0].description == " Two leading spaces."


def test_triple_slash_no_space_after_slashes():
    src = _norm(
        """
        ///NoSpace
        table 'Sales'
        """
    )
    blocks, _ = parse(src)
    assert blocks[0].description == "NoSpace"
