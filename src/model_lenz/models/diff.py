"""Pydantic models for the PBIP diff payload (v0.3).

The diff endpoint compares two parsed `Model` snapshots and emits one record
per *changed* entity. Unchanged entities are omitted to keep payloads small —
the frontend can derive "unchanged" from "in both but not in the diff" if
needed.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from model_lenz.models.semantic import Column, Measure, Relationship, Table

DiffStatus = Literal["added", "removed", "modified"]


class MeasureDiff(BaseModel):
    status: DiffStatus
    table: str
    name: str
    before: Measure | None = None
    head: Measure | None = None
    dax_changed: bool = False
    """True when the trimmed expression text differs."""
    refs_changed: bool = False
    """True when the set of directly-referenced tables changed."""
    userel_changed: bool = False
    """True when the set of USERELATIONSHIP overrides changed."""
    description_changed: bool = False
    display_folder_changed: bool = False
    format_string_changed: bool = False
    is_hidden_changed: bool = False


class ColumnDiff(BaseModel):
    """Per-column delta for columns present on both sides of a modified table."""

    name: str
    before: Column | None = None
    head: Column | None = None
    description_changed: bool = False
    data_type_changed: bool = False
    is_hidden_changed: bool = False
    is_key_changed: bool = False
    source_column_changed: bool = False
    expression_changed: bool = False
    """True when the calculated-column DAX expression differs."""


class TableDiff(BaseModel):
    status: DiffStatus
    name: str
    before: Table | None = None
    head: Table | None = None
    source_lineage_changed: bool = False
    """True when the highest-confidence partition's source identifier (connector
    + schema + table + fully_qualified) differs between base and head."""
    columns_added: list[str] = Field(default_factory=list)
    columns_removed: list[str] = Field(default_factory=list)
    columns_modified: list[ColumnDiff] = Field(default_factory=list)
    classification_before: str | None = None
    classification_head: str | None = None
    description_changed: bool = False
    is_hidden_changed: bool = False


class RelationshipDiff(BaseModel):
    status: DiffStatus
    key: str
    """Stable canonical key: ``from_table.from_column->to_table.to_column``.

    GUIDs on relationships can churn between PBIP saves; the canonical key is
    direction-aware (does not normalize from/to) so a reversed relationship
    reads as one removed + one added, which is the correct semantic.
    """
    before: Relationship | None = None
    head: Relationship | None = None
    is_active_changed: bool = False
    cardinality_changed: bool = False
    crossfilter_changed: bool = False


class DiffCounts(BaseModel):
    measures_added: int = 0
    measures_removed: int = 0
    measures_modified: int = 0
    tables_added: int = 0
    tables_removed: int = 0
    tables_modified: int = 0
    relationships_added: int = 0
    relationships_removed: int = 0
    relationships_modified: int = 0


class DiffPayload(BaseModel):
    base_label: str
    head_label: str
    base_path: str
    head_path: str
    base_is_default_branch: bool = False
    """True when the BASE folder's Git working tree is on the repo's default
    branch (origin/HEAD → main/master). Drives the gold pin icon next to the
    BASE label in the UI."""
    counts: DiffCounts = Field(default_factory=DiffCounts)
    measures: list[MeasureDiff] = Field(default_factory=list)
    tables: list[TableDiff] = Field(default_factory=list)
    relationships: list[RelationshipDiff] = Field(default_factory=list)


class DiffContext(BaseModel):
    """Returned by `GET /api/diff/context`. Tells the frontend which two PBIPs
    the CLI launched the diff session against, plus the resolved labels."""

    base_label: str
    head_label: str
    base_path: str
    head_path: str
    base_is_default_branch: bool = False
