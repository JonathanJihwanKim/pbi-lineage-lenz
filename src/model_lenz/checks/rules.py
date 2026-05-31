"""The ``model-lenz check`` rule engine.

One pass over every measure. Each measure's ``MeasureGraph`` already carries the
three signals the rules need — ``warnings`` (unresolved refs), ``indirect_tables``
(each flagged ``ambiguous``), and the indirect count — so the rules read off that
payload instead of re-walking the model.
"""

from __future__ import annotations

from model_lenz.analyzers.measure_graph import build_measure_graph
from model_lenz.analyzers.relationships import RelationshipGraph
from model_lenz.checks.report import (
    RULE_AMBIGUOUS_PATHS,
    RULE_BROKEN_REFERENCES,
    RULE_INDIRECT_BLOWUP,
    CheckConfig,
    CheckReport,
    Violation,
)
from model_lenz.models.semantic import Model


def run_checks(model: Model, rel_graph: RelationshipGraph, config: CheckConfig) -> CheckReport:
    violations: list[Violation] = []

    for table in model.tables:
        for measure in table.measures:
            mg = build_measure_graph(measure, model=model, rel_graph=rel_graph, depth=config.depth)

            if mg.warnings:
                violations.append(
                    Violation(
                        rule=RULE_BROKEN_REFERENCES,
                        severity="error",
                        table=measure.table,
                        measure=measure.name,
                        message="; ".join(mg.warnings),
                        unresolved=list(mg.warnings),
                    )
                )

            ambiguous_tables = sorted({it.table for it in mg.indirect_tables if it.ambiguous})
            if ambiguous_tables:
                violations.append(
                    Violation(
                        rule=RULE_AMBIGUOUS_PATHS,
                        severity="error" if config.fail_on_ambiguous else "warning",
                        table=measure.table,
                        measure=measure.name,
                        message=(
                            "Indirect tables reached by more than one path: "
                            + ", ".join(ambiguous_tables)
                        ),
                        ambiguous_tables=ambiguous_tables,
                    )
                )

            if config.max_indirect is not None:
                count = len(mg.indirect_tables)
                if count > config.max_indirect:
                    violations.append(
                        Violation(
                            rule=RULE_INDIRECT_BLOWUP,
                            severity="error",
                            table=measure.table,
                            measure=measure.name,
                            message=(
                                f"{count} indirect tables exceeds the limit of "
                                f"{config.max_indirect}"
                            ),
                            indirect_count=count,
                        )
                    )

    return CheckReport.from_violations(violations, config)
