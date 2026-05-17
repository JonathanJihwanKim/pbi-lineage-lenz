"""HTTP routes for Model Lenz.

Exposed under ``/api``. The frontend (M3) consumes this contract; the CLI's
``serve`` command launches it.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from model_lenz.analyzers.diff import diff_models
from model_lenz.analyzers.measure_graph import build_measure_graph
from model_lenz.analyzers.relationships import RelationshipGraph
from model_lenz.api.cache import ModelCache
from model_lenz.exporters.markdown import measure_card, table_card
from model_lenz.models.diff import DiffContext, DiffPayload
from model_lenz.models.graph import MeasureGraph
from model_lenz.models.semantic import Model
from model_lenz.parsers.pbip import find_semantic_model

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Dependency: pull (model, rel_graph) for the configured PBIP path
# --------------------------------------------------------------------------- #


def get_state(request: Request) -> tuple[Model, RelationshipGraph]:
    cache: ModelCache = request.app.state.cache
    pbip_path = request.app.state.pbip_path
    entry = cache.get(pbip_path)
    return entry.model, entry.rel_graph


State = Annotated[tuple[Model, RelationshipGraph], Depends(get_state)]


# --------------------------------------------------------------------------- #
# Response models
# --------------------------------------------------------------------------- #


class ModelSummary(BaseModel):
    name: str | None
    counts: dict[str, int]
    classifications: dict[str, int]
    lineage_confidence: dict[str, int]
    warnings: list[str]


class MeasureListItem(BaseModel):
    name: str
    table: str
    display_folder: str | None = None
    description: str | None = None
    is_hidden: bool = False


class TableListItem(BaseModel):
    name: str
    classification: str
    is_hidden: bool
    column_count: int
    measure_count: int
    source_table: str | None = None
    source_connector: str | None = None
    source_confidence: str | None = None


class SearchHit(BaseModel):
    kind: str  # 'measure' | 'table' | 'column'
    name: str
    table: str | None = None
    score: int


class OpenPbipRequest(BaseModel):
    path: str


class OpenPbipResponse(BaseModel):
    path: str
    summary: ModelSummary


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #


@router.get("/model", response_model=ModelSummary)
def get_model_summary(state: State) -> ModelSummary:
    model, _ = state
    return _build_summary(model)


def _build_summary(model: Model) -> ModelSummary:
    counts = {
        "tables": len(model.tables),
        "measures": sum(len(t.measures) for t in model.tables),
        "relationships": len(model.relationships),
        "expressions": len(model.expressions),
        "functions": len(model.functions),
    }
    classifications = dict(Counter(t.classification for t in model.tables))
    confidence: Counter[str] = Counter()
    for t in model.tables:
        for p in t.partitions:
            confidence[p.source_lineage.confidence if p.source_lineage else "none"] += 1
    return ModelSummary(
        name=model.name,
        counts=counts,
        classifications=classifications,
        lineage_confidence=dict(confidence),
        warnings=model.warnings,
    )


@router.post("/model/open", response_model=OpenPbipResponse)
def open_pbip(body: OpenPbipRequest, request: Request) -> OpenPbipResponse:
    """Switch the server's active PBIP path at runtime.

    Trusts localhost — `model-lenz serve` binds 127.0.0.1 by default. Refused
    in diff mode (`model-lenz diff`) because the two-PBIP pinning would be
    inconsistent with a single-model swap.
    """
    if request.app.state.diff_context:
        raise HTTPException(
            409,
            "Cannot switch PBIPs while a diff session is active. "
            "Restart with `model-lenz serve` for the single-model view.",
        )
    try:
        find_semantic_model(body.path)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e)) from e
    resolved = str(Path(body.path).resolve())
    request.app.state.pbip_path = resolved
    model, _ = get_state(request)
    return OpenPbipResponse(path=resolved, summary=_build_summary(model))


@router.get("/measures", response_model=list[MeasureListItem])
def list_measures(state: State) -> list[MeasureListItem]:
    model, _ = state
    out: list[MeasureListItem] = []
    for t in model.tables:
        for m in t.measures:
            out.append(
                MeasureListItem(
                    name=m.name,
                    table=m.table,
                    display_folder=m.display_folder,
                    description=m.description,
                    is_hidden=m.is_hidden,
                )
            )
    out.sort(key=lambda x: (x.table, x.display_folder or "", x.name))
    return out


@router.get(
    "/measures/{table}/{name}/graph",
    response_model=MeasureGraph,
)
def measure_graph(
    table: str,
    name: str,
    state: State,
    depth: int = Query(2, ge=1, le=5, description="Max relationship hops"),
) -> MeasureGraph:
    model, rel_graph = state
    measure = next(
        (m for t in model.tables if t.name == table for m in t.measures if m.name == name),
        None,
    )
    if measure is None:
        raise HTTPException(404, f"Measure '{name}' not found on table '{table}'")
    return build_measure_graph(measure, model=model, rel_graph=rel_graph, depth=depth)


@router.get(
    "/measures/{table}/{name}/markdown",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/markdown": {}}}},
)
def measure_markdown(
    table: str,
    name: str,
    request: Request,
    state: State,
    depth: int = Query(2, ge=1, le=5, description="Max relationship hops"),
) -> PlainTextResponse:
    """One-pager Markdown card for a measure — paste into PR/Jira/Slack."""
    model, rel_graph = state
    try:
        body = measure_card(
            model,
            rel_graph,
            table,
            name,
            depth=depth,
            share_url=str(request.base_url),
        )
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    return PlainTextResponse(content=body, media_type="text/markdown; charset=utf-8")


@router.get("/tables", response_model=list[TableListItem])
def list_tables(state: State) -> list[TableListItem]:
    model, _ = state
    out: list[TableListItem] = []
    for t in model.tables:
        # Pick the most informative partition lineage when there are several.
        best = max(
            (p for p in t.partitions if p.source_lineage),
            key=lambda p: _conf_rank(p.source_lineage.confidence),
            default=None,
        )
        lineage = best.source_lineage if best else None
        out.append(
            TableListItem(
                name=t.name,
                classification=t.classification,
                is_hidden=t.is_hidden,
                column_count=len(t.columns),
                measure_count=len(t.measures),
                source_table=lineage.fully_qualified or lineage.table if lineage else None,
                source_connector=lineage.connector if lineage else None,
                source_confidence=lineage.confidence if lineage else None,
            )
        )
    out.sort(key=lambda x: (x.classification, x.name))
    return out


@router.get("/tables/{name}")
def get_table(name: str, state: State):
    model, _ = state
    t = next((t for t in model.tables if t.name == name), None)
    if t is None:
        raise HTTPException(404, f"Table '{name}' not found")
    related = [
        {
            "id": r.id,
            "from_table": r.from_table,
            "from_column": r.from_column,
            "to_table": r.to_table,
            "to_column": r.to_column,
            "cardinality": r.cardinality,
            "crossfilter": r.crossfilter,
            "is_active": r.is_active,
        }
        for r in model.relationships
        if r.from_table == name or r.to_table == name
    ]
    return {
        "table": t.model_dump(by_alias=True),
        "relationships": related,
    }


@router.get(
    "/tables/{name}/markdown",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/markdown": {}}}},
)
def table_markdown(name: str, request: Request, state: State) -> PlainTextResponse:
    """One-pager Markdown card for a table — paste into PR/Jira/Slack."""
    model, _ = state
    try:
        body = table_card(model, name, share_url=str(request.base_url))
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    return PlainTextResponse(content=body, media_type="text/markdown; charset=utf-8")


@router.get("/relationships")
def list_relationships(state: State):
    model, _ = state
    return [r.model_dump(by_alias=True) for r in model.relationships]


@router.get("/functions")
def list_functions(state: State):
    model, _ = state
    return [f.model_dump(by_alias=True) for f in model.functions]


@router.get("/calculation-groups")
def list_calculation_groups(state: State):
    model, _ = state
    return [
        t.calculation_group.model_dump(by_alias=True)
        for t in model.tables
        if t.calculation_group is not None
    ]


@router.get("/expressions")
def list_expressions(state: State):
    model, _ = state
    return [e.model_dump(by_alias=True) for e in model.expressions]


@router.get("/diff/context", response_model=DiffContext)
def get_diff_context(request: Request) -> DiffContext:
    """Return the two PBIPs the active `model-lenz diff` session was launched
    against, plus the resolved BASE/HEAD labels. The frontend's `/diff` route
    calls this on mount to populate the diff header.
    """
    ctx = request.app.state.diff_context
    if not ctx:
        raise HTTPException(
            400,
            "No diff session active. Launch with `model-lenz diff <base> <head>` "
            "or use `model-lenz serve` for the single-model view.",
        )
    return DiffContext(**ctx)


@router.get("/diff", response_model=DiffPayload)
def get_diff(request: Request) -> DiffPayload:
    """Compute the diff between the two PBIPs configured by `model-lenz diff`.

    Cached implicitly by `ModelCache`: each PBIP is parsed once per server
    lifetime (and re-parsed transparently if its TMDL files have changed).
    """
    ctx = request.app.state.diff_context
    if not ctx:
        raise HTTPException(
            400,
            "No diff session active. Launch with `model-lenz diff <base> <head>`.",
        )
    cache: ModelCache = request.app.state.cache
    base_entry = cache.get(ctx["base_path"])
    head_entry = cache.get(ctx["head_path"])
    return diff_models(
        base_entry.model,
        head_entry.model,
        base_label=ctx["base_label"],
        head_label=ctx["head_label"],
        base_path=ctx["base_path"],
        head_path=ctx["head_path"],
        base_is_default_branch=ctx.get("base_is_default_branch", False),
    )


@router.get("/search", response_model=list[SearchHit])
def search(
    state: State,
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(40, ge=1, le=200),
) -> list[SearchHit]:
    model, _ = state
    needle = q.lower()
    hits: list[SearchHit] = []

    def _score(hay: str) -> int:
        h = hay.lower()
        if h == needle:
            return 100
        if h.startswith(needle):
            return 80
        if needle in h:
            return 60
        return 0

    for t in model.tables:
        s = _score(t.name)
        if s:
            hits.append(SearchHit(kind="table", name=t.name, score=s))
        for m in t.measures:
            s = _score(m.name)
            if s:
                hits.append(SearchHit(kind="measure", name=m.name, table=t.name, score=s))
        for c in t.columns:
            s = _score(c.name)
            if s:
                hits.append(SearchHit(kind="column", name=c.name, table=t.name, score=s))

    hits.sort(key=lambda h: (-h.score, h.kind, h.name))
    return hits[:limit]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _conf_rank(c: str) -> int:
    return {"high": 3, "medium": 2, "low": 1, "none": 0}.get(c, 0)
