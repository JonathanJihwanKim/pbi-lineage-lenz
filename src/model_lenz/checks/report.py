"""Typed result objects for ``model-lenz check``.

CLI-only contract — these are *not* part of the frontend JSON contract under
``models/`` and are not mirrored in ``frontend/src/api/types.ts``. They exist so
the rule engine and the renderers share one well-typed payload and so tests can
assert on structure instead of scraping stdout.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["error", "warning"]

RULE_BROKEN_REFERENCES = "broken-references"
RULE_AMBIGUOUS_PATHS = "ambiguous-paths"
RULE_INDIRECT_BLOWUP = "indirect-blowup"


class CheckConfig(BaseModel):
    """Knobs that decide which rules run and how hard they bite."""

    depth: int = 2
    """Relationship-walk depth handed to ``build_measure_graph``."""

    max_indirect: int | None = None
    """Indirect-table count above which ``indirect-blowup`` fires.
    ``None`` disables the rule entirely."""

    fail_on_ambiguous: bool = False
    """Escalate ``ambiguous-paths`` from warning to error."""


class Violation(BaseModel):
    rule: str
    severity: Severity
    table: str
    measure: str
    message: str
    unresolved: list[str] = Field(default_factory=list)
    ambiguous_tables: list[str] = Field(default_factory=list)
    indirect_count: int | None = None


class CheckReport(BaseModel):
    ok: bool
    error_count: int
    warning_count: int
    violations: list[Violation] = Field(default_factory=list)
    config: CheckConfig

    @property
    def exit_code(self) -> int:
        return 0 if self.error_count == 0 else 1

    @classmethod
    def from_violations(cls, violations: list[Violation], config: CheckConfig) -> CheckReport:
        errors = sum(1 for v in violations if v.severity == "error")
        warnings = sum(1 for v in violations if v.severity == "warning")
        return cls(
            ok=errors == 0,
            error_count=errors,
            warning_count=warnings,
            violations=violations,
            config=config,
        )
