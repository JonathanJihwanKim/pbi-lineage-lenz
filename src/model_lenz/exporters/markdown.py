"""Markdown handoff cards for measures and tables.

One-pagers a BI developer can paste into a PR description, Jira ticket, or
Slack thread when asking a data engineer about a specific column or
relationship. Produced from the already-parsed `Model` + `RelationshipGraph`
so the cache feeds them for free.

Pure functions — no I/O, no FastAPI dependencies. The HTTP layer wraps these
in a `PlainTextResponse(content_type="text/markdown")` and optionally appends
a shareable URL footer.
"""

from __future__ import annotations

from urllib.parse import quote

from model_lenz.analyzers.measure_graph import build_measure_graph
from model_lenz.analyzers.relationships import RelationshipGraph
from model_lenz.models.graph import IndirectTable
from model_lenz.models.semantic import Measure, Model, Table

_CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1}


def measure_card(
    model: Model,
    rel_graph: RelationshipGraph,
    table: str,
    name: str,
    *,
    depth: int = 2,
    share_url: str | None = None,
) -> str:
    """Render a one-pager Markdown card for a single measure.

    Raises:
        LookupError: when no measure named `name` exists on table `table`.
    """
    measure = _find_measure(model, table, name)
    graph = build_measure_graph(measure, model=model, rel_graph=rel_graph, depth=depth)
    table_index = model.table_index()

    parts: list[str] = []
    parts.append(f"# {measure.name} (Measure)")
    parts.append("")
    parts.append(f"**Table:** `{measure.table}`")
    if measure.display_folder:
        parts.append(f"**Display folder:** `{measure.display_folder}`")
    if measure.format_string:
        parts.append(f"**Format:** `{measure.format_string}`")
    if measure.is_hidden:
        parts.append("**Hidden:** true")
    if measure.description:
        parts.append("")
        parts.append(f"> {measure.description}")
    parts.append("")

    parts.append("## DAX")
    parts.append("```dax")
    parts.append(measure.expression.strip() or "(empty)")
    parts.append("```")
    parts.append("")

    parts.append(f"## Direct tables ({len(graph.direct_tables)})")
    if not graph.direct_tables:
        parts.append("- _none parsed from the expression_")
    else:
        for t_name in graph.direct_tables:
            meta = next((m for m in graph.direct_table_meta if m.label == t_name), None)
            source = (
                _format_source(meta.source_connector, meta.source_label, meta.source_confidence)
                if meta and meta.source_label
                else None
            )
            line = f"- `{t_name}`"
            if source:
                line += f" — {source}"
            parts.append(line)
    parts.append("")

    if graph.referenced_measures:
        parts.append(f"## Referenced measures ({len(graph.referenced_measures)})")
        for ref in graph.referenced_measures:
            parts.append(f"- `[{ref.name}]` ({ref.table})")
        parts.append("")

    if graph.userel_hints:
        parts.append("## USERELATIONSHIP overrides")
        for h in graph.userel_hints:
            from_ref = getattr(h, "from_", None) or h.model_dump(by_alias=True).get("from")
            parts.append(f"- `{from_ref}` → `{h.to}`")
        parts.append("")

    parts.append(f"## Indirect tables (depth {depth}, {len(graph.indirect_tables)})")
    if not graph.indirect_tables:
        parts.append("- _no tables reachable through relationships_")
    else:
        for it in graph.indirect_tables:
            parts.append(f"- {_format_indirect(it)}")
    parts.append("")

    lineage_lines = _source_lineage_lines(graph.direct_tables, graph.indirect_tables, table_index)
    if lineage_lines:
        parts.append("## Source lineage")
        parts.extend(lineage_lines)
        parts.append("")

    if graph.warnings:
        parts.append("## Warnings")
        for w in graph.warnings:
            parts.append(f"- {w}")
        parts.append("")

    if share_url:
        parts.append("---")
        parts.append(
            f"View in Model Lenz: {_measure_share_url(share_url, measure.table, measure.name, depth)}"
        )

    return "\n".join(parts).rstrip() + "\n"


def table_card(model: Model, name: str, *, share_url: str | None = None) -> str:
    """Render a one-pager Markdown card for a single table.

    Raises:
        LookupError: when no table named `name` exists.
    """
    t = _find_table(model, name)
    lineage = _best_source_lineage(t)

    parts: list[str] = []
    parts.append(f"# {t.name} (Table)")
    parts.append("")
    parts.append(f"**Classification:** `{t.classification}`")
    if t.is_hidden:
        parts.append("**Hidden:** true")
    if t.description:
        parts.append("")
        parts.append(f"> {t.description}")
    parts.append("")

    parts.append("## Source lineage")
    if lineage is None:
        parts.append(
            "- _no source detected — likely a calculated table, manually entered, or parameter_"
        )
    else:
        parts.append(f"- Connector: `{lineage.connector or '—'}`")
        parts.append(f"- Schema: `{lineage.schema_ or '—'}`")
        parts.append(f"- Table: `{lineage.table or '—'}`")
        if lineage.fully_qualified:
            parts.append(f"- Fully qualified: `{lineage.fully_qualified}`")
        parts.append(f"- Confidence: `{lineage.confidence}`")
        if lineage.upstream_expressions:
            parts.append(f"- Upstream: {' → '.join(f'`{u}`' for u in lineage.upstream_expressions)}")
        if lineage.transformed_steps:
            parts.append(f"- Steps: {' → '.join(f'`{s}`' for s in lineage.transformed_steps)}")
        if lineage.sql:
            parts.append("")
            parts.append("```sql")
            parts.append(lineage.sql.strip())
            parts.append("```")
    parts.append("")

    parts.append(f"## Columns ({len(t.columns)})")
    if not t.columns:
        parts.append("- _no columns_")
    else:
        for c in t.columns:
            attrs = []
            if c.is_key:
                attrs.append("key")
            if c.is_fk:
                attrs.append("FK")
            if c.is_hidden:
                attrs.append("hidden")
            if c.expression:
                attrs.append("calc")
            attrs_str = f" — {', '.join(attrs)}" if attrs else ""
            type_str = f" ({c.data_type})" if c.data_type else ""
            parts.append(f"- `{c.name}`{type_str}{attrs_str}")
    parts.append("")

    if t.measures:
        parts.append(f"## Measures hosted ({len(t.measures)})")
        for m in t.measures:
            parts.append(f"- `{m.name}`")
        parts.append("")

    rels = [
        r
        for r in model.relationships
        if r.from_table == t.name or r.to_table == t.name
    ]
    if rels:
        parts.append(f"## Relationships ({len(rels)})")
        for r in rels:
            arrow = "↔" if r.crossfilter == "both" else "→"
            inactive = " _(inactive)_" if not r.is_active else ""
            parts.append(
                f"- `{r.from_table}[{r.from_column}]` {arrow}"
                f"({_cardinality_glyph(r.cardinality)}) `{r.to_table}[{r.to_column}]`{inactive}"
            )
        parts.append("")

    if share_url:
        parts.append("---")
        parts.append(f"View in Model Lenz: {_table_share_url(share_url, t.name)}")

    return "\n".join(parts).rstrip() + "\n"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _find_measure(model: Model, table: str, name: str) -> Measure:
    for t in model.tables:
        if t.name != table:
            continue
        for m in t.measures:
            if m.name == name:
                return m
    raise LookupError(f"Measure '{name}' not found on table '{table}'")


def _find_table(model: Model, name: str) -> Table:
    for t in model.tables:
        if t.name == name:
            return t
    raise LookupError(f"Table '{name}' not found")


def _best_source_lineage(t: Table):
    best = None
    for p in t.partitions:
        lineage = p.source_lineage
        if lineage is None:
            continue
        if best is None or _CONFIDENCE_RANK.get(lineage.confidence, 0) > _CONFIDENCE_RANK.get(
            best.confidence, 0
        ):
            best = lineage
    return best


def _format_source(connector: str | None, label: str, confidence) -> str:
    conn = f"{connector} " if connector else ""
    conf = f" ({confidence})" if confidence else ""
    return f"{conn}`{label}`{conf}".strip()


def _format_indirect(it: IndirectTable) -> str:
    base = f"`{it.table}` (depth {it.depth})"
    badges: list[str] = []
    if it.ambiguous:
        badges.append("ambiguous")
    if it.crosses_fact:
        badges.append("crosses fact")
    badge_str = f" — {', '.join(badges)}" if badges else ""
    # Show the first path's hop chain (the shortest, since BFS).
    if it.paths and it.paths[0].hops:
        hops = it.paths[0].hops
        chain = " → ".join(
            f"{h.from_table}[{h.from_column}]→{h.to_table}[{h.to_column}] "
            f"({_cardinality_glyph(h.cardinality)}"
            f"{', inactive' if not h.is_active else ''}"
            f"{', bidi' if h.crossfilter == 'both' else ''})"
            for h in hops
        )
        return f"{base}{badge_str} via {chain}"
    return f"{base}{badge_str}"


def _source_lineage_lines(
    direct_tables: list[str],
    indirect_tables: list[IndirectTable],
    table_index: dict[str, Table],
) -> list[str]:
    """One bullet per table with a resolved source, direct first then indirect.
    Skips tables we couldn't resolve a source for (the dual-name UI omits them
    too)."""
    seen: set[str] = set()
    lines: list[str] = []
    for name in direct_tables:
        if name in seen:
            continue
        seen.add(name)
        t = table_index.get(name)
        if t is None:
            continue
        lineage = _best_source_lineage(t)
        if lineage is None or not (lineage.fully_qualified or lineage.table):
            continue
        label = lineage.fully_qualified or lineage.table
        lines.append(
            f"- `{name}` → "
            + _format_source(lineage.connector, label, lineage.confidence)
        )
    for it in indirect_tables:
        if it.table in seen:
            continue
        seen.add(it.table)
        if it.source_label:
            lines.append(
                f"- `{it.table}` → "
                + _format_source(it.source_connector, it.source_label, it.source_confidence)
            )
    return lines


def _cardinality_glyph(card: str) -> str:
    return {
        "many_to_one": "*:1",
        "one_to_many": "1:*",
        "one_to_one": "1:1",
        "many_to_many": "*:*",
    }.get(card, card)


def _measure_share_url(base: str, table: str, name: str, depth: int) -> str:
    qs = f"table={quote(table)}&measure={quote(name)}"
    if depth != 2:
        qs += f"&depth={depth}"
    return f"{base.rstrip('/')}/?{qs}"


def _table_share_url(base: str, name: str) -> str:
    return f"{base.rstrip('/')}/?table={quote(name)}"
