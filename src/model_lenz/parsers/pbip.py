"""PBIP discovery and parser orchestration.

Walks a PBIP folder, parses every TMDL file into typed `Model` objects,
extracts M lineage on each partition / named expression, and runs the table
classifier.
"""

from __future__ import annotations

from pathlib import Path

from model_lenz.analyzers.classifier import classify_tables
from model_lenz.models.semantic import (
    CalculationGroup,
    CalculationItem,
    Classification,
    Column,
    Expression,
    Function,
    Measure,
    Model,
    Partition,
    Relationship,
    Table,
)
from model_lenz.parsers import m_query, tmdl
from model_lenz.parsers.tmdl import TmdlBlock

# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #


def find_semantic_model(pbip_path: str | Path) -> Path:
    """Locate the ``*.SemanticModel`` directory inside a PBIP project.

    Accepts either the PBIP project root, the ``.SemanticModel`` folder
    itself, or the inner ``definition`` folder.
    """
    p = Path(pbip_path).resolve()
    if not p.exists():
        raise FileNotFoundError(f"PBIP path does not exist: {p}")
    if p.is_file():
        p = p.parent
    if p.name.lower() == "definition" and (p / "model.tmdl").exists():
        return p.parent
    if p.suffix == ".SemanticModel" or p.name.endswith(".SemanticModel"):
        return p
    candidates = sorted(p.glob("*.SemanticModel"))
    if not candidates:
        # also accept a nested layout (some users keep one PBIP per repo)
        candidates = sorted(p.glob("**/*.SemanticModel"))
    if not candidates:
        raise FileNotFoundError(
            f"No *.SemanticModel folder found under {p}. "
            "Pass either the PBIP project root or the .SemanticModel folder."
        )
    return candidates[0]


# --------------------------------------------------------------------------- #
# Top-level parse
# --------------------------------------------------------------------------- #


def parse_pbip(pbip_path: str | Path) -> Model:
    sm = find_semantic_model(pbip_path)
    definition = sm / "definition"
    if not definition.exists():
        raise FileNotFoundError(f"Missing definition folder: {definition}")

    model = Model(name=sm.stem)

    # 1. Expressions (named M queries) — parse first so partitions can resolve refs.
    expr_file = definition / "expressions.tmdl"
    expression_names: set[str] = set()
    if expr_file.exists():
        blocks, warns = tmdl.parse(expr_file.read_text(encoding="utf-8"))
        model.warnings.extend(f"expressions.tmdl: {w}" for w in warns)
        for b in blocks:
            if b.keyword != "expression":
                continue
            expression_names.add(b.name)
            model.expressions.append(_to_expression(b))
    # Now run lineage on each expression body, with full known names
    for ex in model.expressions:
        ex.source_lineage = m_query.extract_lineage(
            ex.expression, expression_names=expression_names
        )

    # 2. Tables (and their measures, columns, partitions, calc groups).
    tables_dir = definition / "tables"
    if tables_dir.exists():
        for tmdl_file in sorted(tables_dir.glob("*.tmdl")):
            blocks, warns = tmdl.parse(tmdl_file.read_text(encoding="utf-8"))
            model.warnings.extend(f"{tmdl_file.name}: {w}" for w in warns)
            for b in blocks:
                if b.keyword == "table":
                    model.tables.append(_to_table(b, expression_names))

    # 3. Relationships.
    rel_file = definition / "relationships.tmdl"
    if rel_file.exists():
        blocks, warns = tmdl.parse(rel_file.read_text(encoding="utf-8"))
        model.warnings.extend(f"relationships.tmdl: {w}" for w in warns)
        for b in blocks:
            if b.keyword != "relationship":
                continue
            rel = _to_relationship(b)
            if rel is not None:
                model.relationships.append(rel)

    # 4. UDFs (preview): definition/functions/*.tmdl OR top-level `function` blocks.
    fn_dir = definition / "functions"
    if fn_dir.exists():
        for tmdl_file in sorted(fn_dir.glob("*.tmdl")):
            blocks, warns = tmdl.parse(tmdl_file.read_text(encoding="utf-8"))
            model.warnings.extend(f"{tmdl_file.name}: {w}" for w in warns)
            for b in blocks:
                if b.keyword == "function":
                    model.functions.append(_to_function(b))

    # 5. Mark FK columns based on relationships, then classify.
    _mark_fk_columns(model)
    overrides = _load_overrides(sm)
    classify_tables(model.tables, model.relationships, overrides=overrides)

    # 6. Propagate lineage from named expressions back to partitions that
    #    reference them (e.g. `Source = bu_dim_src`).
    _propagate_upstream_lineage(model)

    return model


# --------------------------------------------------------------------------- #
# Block → typed model conversion
# --------------------------------------------------------------------------- #


def _to_table(block: TmdlBlock, expression_names: set[str]) -> Table:
    columns: list[Column] = []
    measures: list[Measure] = []
    partitions: list[Partition] = []
    calc_group: CalculationGroup | None = None

    for child in block.children:
        if child.keyword == "column":
            columns.append(_to_column(child))
        elif child.keyword == "measure":
            measures.append(_to_measure(child, table_name=block.name))
        elif child.keyword == "partition":
            partitions.append(_to_partition(child, expression_names))
        elif child.keyword == "calculationGroup":
            calc_group = _to_calculation_group(child, table_name=block.name)

    return Table(
        name=block.name,
        is_hidden="isHidden" in block.flags,
        data_category=block.properties.get("dataCategory"),
        description=block.description or block.properties.get("description"),
        lineage_tag=block.properties.get("lineageTag"),
        columns=columns,
        measures=measures,
        partitions=partitions,
        calculation_group=calc_group,
    )


def _to_column(block: TmdlBlock) -> Column:
    return Column(
        name=block.name,
        data_type=block.properties.get("dataType"),
        is_hidden="isHidden" in block.flags,
        is_key="isKey" in block.flags,
        source_column=block.properties.get("sourceColumn"),
        description=block.description or block.properties.get("description"),
        lineage_tag=block.properties.get("lineageTag"),
        expression=block.expression or None,
    )


def _to_measure(block: TmdlBlock, *, table_name: str) -> Measure:
    return Measure(
        name=block.name,
        table=table_name,
        expression=block.expression.strip(),
        display_folder=block.properties.get("displayFolder"),
        format_string=block.properties.get("formatString"),
        description=block.description or block.properties.get("description"),
        is_hidden="isHidden" in block.flags,
        lineage_tag=block.properties.get("lineageTag"),
    )


def _to_partition(block: TmdlBlock, expression_names: set[str]) -> Partition:
    src = block.properties.get("source", "")
    lineage = m_query.extract_lineage(src, expression_names=expression_names) if src else None
    return Partition(
        name=block.name,
        mode=block.properties.get("mode", "import"),
        query_group=block.properties.get("queryGroup"),
        source_expression=src,
        source_lineage=lineage,
    )


def _to_calculation_group(block: TmdlBlock, *, table_name: str) -> CalculationGroup:
    items: list[CalculationItem] = []
    for child in block.children:
        if child.keyword == "calculationItem":
            items.append(
                CalculationItem(
                    name=child.name,
                    expression=child.expression.strip(),
                    ordinal=_safe_int(child.properties.get("ordinal")),
                    format_string=child.properties.get("formatString"),
                    description=child.description or child.properties.get("description"),
                )
            )
    precedence = _safe_int(block.properties.get("precedence"))
    return CalculationGroup(name=table_name, precedence=precedence, items=items)


def _to_expression(block: TmdlBlock) -> Expression:
    return Expression(
        name=block.name,
        kind="m",
        expression=(block.expression or block.inline_value or "").strip(),
        lineage_tag=block.properties.get("lineageTag"),
    )


def _to_function(block: TmdlBlock) -> Function:
    return Function(
        name=block.name,
        expression=block.expression.strip(),
        return_type=block.properties.get("returnType"),
        description=block.description or block.properties.get("description"),
        lineage_tag=block.properties.get("lineageTag"),
    )


def _to_relationship(block: TmdlBlock) -> Relationship | None:
    fc = block.properties.get("fromColumn")
    tc = block.properties.get("toColumn")
    if not fc or not tc:
        return None
    f_table, f_col = _split_table_column(fc)
    t_table, t_col = _split_table_column(tc)
    if not f_table or not t_table:
        return None

    cardinality = "many_to_one"
    from_card = block.properties.get("fromCardinality")
    to_card = block.properties.get("toCardinality")
    if from_card == "one" and to_card == "one":
        cardinality = "one_to_one"
    elif from_card == "one":
        cardinality = "one_to_many"
    elif to_card == "many":
        cardinality = "many_to_many"

    crossfilter = "single"
    if block.properties.get("crossFilteringBehavior") == "bothDirections":
        crossfilter = "both"

    is_active = block.properties.get("isActive", "true").lower() != "false"
    if "isActive" in block.flags:
        # Bare `isActive` flag (rare) — defaults to True.
        is_active = True

    return Relationship(
        id=block.name,
        from_table=f_table,
        from_column=f_col,
        to_table=t_table,
        to_column=t_col,
        cardinality=cardinality,
        crossfilter=crossfilter,
        is_active=is_active,
    )


# --------------------------------------------------------------------------- #
# Post-processing
# --------------------------------------------------------------------------- #


def _propagate_upstream_lineage(model: Model) -> None:
    """For partitions whose `source_lineage` lacks a resolved table but lists
    upstream expressions, follow the chain and inherit the deepest known
    connector / schema / table. Lineage that came indirectly is reported with
    confidence ``medium``.
    """
    expr_index: dict[str, Expression] = {ex.name: ex for ex in model.expressions}

    def resolve(name: str, seen: set[str]) -> tuple[str | None, str | None, str | None, str | None] | None:
        if name in seen or name not in expr_index:
            return None
        seen.add(name)
        ex = expr_index[name]
        if ex.source_lineage and ex.source_lineage.table:
            lineage = ex.source_lineage
            return (lineage.connector, lineage.schema_, lineage.table, lineage.fully_qualified)
        if ex.source_lineage:
            for u in ex.source_lineage.upstream_expressions:
                got = resolve(u, seen)
                if got is not None:
                    return got
        return None

    for t in model.tables:
        for p in t.partitions:
            if not p.source_lineage:
                continue
            lineage = p.source_lineage
            if lineage.table is not None:
                continue
            for u in lineage.upstream_expressions:
                got = resolve(u, set())
                if got is None:
                    continue
                connector, schema, table, full = got
                lineage.connector = lineage.connector or connector
                lineage.schema_ = schema
                lineage.table = table
                lineage.fully_qualified = full
                if lineage.confidence != "high":
                    lineage.confidence = "medium"
                break


def _mark_fk_columns(model: Model) -> None:
    by_table: dict[str, dict[str, Column]] = {
        t.name: {c.name: c for c in t.columns} for t in model.tables
    }
    for r in model.relationships:
        cols = by_table.get(r.from_table)
        if cols and r.from_column in cols:
            cols[r.from_column].is_fk = True


def _load_overrides(semantic_model_dir: Path) -> dict[str, Classification]:
    """Read optional ``model_lenz.toml`` from the PBIP root."""
    pbip_root = semantic_model_dir.parent
    toml_path = pbip_root / "model_lenz.toml"
    if not toml_path.exists():
        return {}
    try:
        import tomllib
    except ModuleNotFoundError:  # Python < 3.11 — not in our supported range, but be safe.
        return {}
    data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    raw = data.get("classify", {})
    valid = {"fact", "dim", "parameter", "time", "calculation_group", "other"}
    return {k: v for k, v in raw.items() if v in valid}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _split_table_column(qualified: str) -> tuple[str, str]:
    """Split ``Table.Column`` or ``'Quoted Table'.Column`` or ``T.'Quoted Col'``."""
    s = qualified.strip()
    in_quote = False
    last_dot = -1
    for i, ch in enumerate(s):
        if ch == "'":
            in_quote = not in_quote
        elif ch == "." and not in_quote:
            last_dot = i
    if last_dot < 0:
        return ("", s)
    table = _strip_quotes(s[:last_dot])
    column = _strip_quotes(s[last_dot + 1 :])
    return (table, column)


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    return s


def _safe_int(s: str | None) -> int | None:
    if s is None:
        return None
    try:
        return int(s)
    except ValueError:
        return None
