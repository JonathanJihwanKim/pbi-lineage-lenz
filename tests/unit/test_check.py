"""Tests for the `model-lenz check` rule engine and renderers.

Models are built in-code (same convention as test_diff_analyzer /
test_relationship_walker) so each test isolates the one signal it asserts.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from model_lenz.analyzers.relationships import RelationshipGraph
from model_lenz.checks import (
    CheckConfig,
    CheckReport,
    render_github,
    render_json,
    render_text,
    run_checks,
)
from model_lenz.checks.report import (
    RULE_AMBIGUOUS_PATHS,
    RULE_BROKEN_REFERENCES,
    RULE_INDIRECT_BLOWUP,
)
from model_lenz.models.semantic import Column, Measure, Model, Relationship, Table


def _table(name: str, *, classification: str = "other", columns: list[str] | None = None) -> Table:
    return Table(
        name=name,
        classification=classification,  # type: ignore[arg-type]
        columns=[Column(name=c) for c in (columns or [])],
    )


def _measures_table(name: str, measures: list[Measure]) -> Table:
    return Table(name=name, classification="other", measures=measures)  # type: ignore[arg-type]


def _rel(rid: str, f_table: str, f_col: str, t_table: str, t_col: str) -> Relationship:
    return Relationship(
        id=rid,
        from_table=f_table,
        from_column=f_col,
        to_table=t_table,
        to_column=t_col,
        cardinality="many_to_one",
        crossfilter="single",
        is_active=True,
    )


def _run(model: Model, config: CheckConfig | None = None) -> CheckReport:
    rg = RelationshipGraph.from_relationships(model.relationships)
    return run_checks(model, rg, config or CheckConfig())


def _rules(report: CheckReport) -> set[str]:
    return {v.rule for v in report.violations}


# --------------------------------------------------------------------------- #
# broken-references
# --------------------------------------------------------------------------- #


def test_broken_reference_fails_with_error():
    model = Model(
        tables=[
            _table("Sales", classification="fact", columns=["amount"]),
            _measures_table(
                "_Measures",
                [Measure(name="Bad", table="_Measures", expression="[DoesNotExist] + 1")],
            ),
        ]
    )
    report = _run(model)
    assert RULE_BROKEN_REFERENCES in _rules(report)
    assert report.ok is False
    assert report.error_count == 1
    assert report.exit_code == 1


# --------------------------------------------------------------------------- #
# ambiguous-paths
# --------------------------------------------------------------------------- #


def _ambiguous_model() -> Model:
    # Two active relationships from Sales reach Date by distinct columns, so the
    # walker flags Date as ambiguous from a Sales-seeded measure.
    return Model(
        tables=[
            _table("Sales", classification="fact", columns=["amount", "orderdate", "shipdate"]),
            _table("Date", classification="time", columns=["datekey"]),
            _measures_table(
                "_Measures",
                [Measure(name="Total", table="_Measures", expression="SUM(Sales[amount])")],
            ),
        ],
        relationships=[
            _rel("r1", "Sales", "orderdate", "Date", "datekey"),
            _rel("r2", "Sales", "shipdate", "Date", "datekey"),
        ],
    )


def test_ambiguous_path_is_warning_by_default():
    report = _run(_ambiguous_model())
    assert RULE_AMBIGUOUS_PATHS in _rules(report)
    assert report.ok is True  # warnings don't fail the build
    assert report.warning_count == 1
    assert report.exit_code == 0


def test_ambiguous_path_escalates_with_fail_on_ambiguous():
    report = _run(_ambiguous_model(), CheckConfig(fail_on_ambiguous=True))
    assert report.ok is False
    assert report.error_count == 1
    assert report.violations[0].rule == RULE_AMBIGUOUS_PATHS


# --------------------------------------------------------------------------- #
# indirect-blowup
# --------------------------------------------------------------------------- #


def _wide_model() -> Model:
    return Model(
        tables=[
            _table("Sales", classification="fact", columns=["amount", "d", "c", "p"]),
            _table("Date", classification="time", columns=["datekey"]),
            _table("Customer", classification="dim", columns=["custkey"]),
            _table("Product", classification="dim", columns=["prodkey"]),
            _measures_table(
                "_Measures",
                [Measure(name="Total", table="_Measures", expression="SUM(Sales[amount])")],
            ),
        ],
        relationships=[
            _rel("r1", "Sales", "d", "Date", "datekey"),
            _rel("r2", "Sales", "c", "Customer", "custkey"),
            _rel("r3", "Sales", "p", "Product", "prodkey"),
        ],
    )


def test_blowup_fires_when_over_threshold():
    report = _run(_wide_model(), CheckConfig(max_indirect=1))
    assert RULE_INDIRECT_BLOWUP in _rules(report)
    blowup = next(v for v in report.violations if v.rule == RULE_INDIRECT_BLOWUP)
    assert blowup.indirect_count == 3
    assert report.ok is False


def test_blowup_disabled_when_max_indirect_none():
    report = _run(_wide_model(), CheckConfig(max_indirect=None))
    assert RULE_INDIRECT_BLOWUP not in _rules(report)


# --------------------------------------------------------------------------- #
# clean model
# --------------------------------------------------------------------------- #


def test_clean_model_passes():
    model = Model(
        tables=[
            _table("Sales", classification="fact", columns=["amount", "d"]),
            _table("Date", classification="time", columns=["datekey"]),
            _measures_table(
                "_Measures",
                [Measure(name="Total", table="_Measures", expression="SUM(Sales[amount])")],
            ),
        ],
        relationships=[_rel("r1", "Sales", "d", "Date", "datekey")],
    )
    report = _run(model)
    assert report.ok is True
    assert report.violations == []
    assert report.exit_code == 0


# --------------------------------------------------------------------------- #
# renderers
# --------------------------------------------------------------------------- #


def test_render_text_names_failing_rules():
    report = _run(_wide_model(), CheckConfig(max_indirect=1))
    text = render_text(report)
    assert RULE_INDIRECT_BLOWUP in text
    assert "FAIL" in text


def test_render_text_pass():
    report = _run(_wide_model(), CheckConfig(max_indirect=None))
    # _wide_model has ambiguous=False paths, so default config is a clean pass.
    assert "PASS" in render_text(report)


def test_render_github_emits_workflow_commands():
    report = _run(_ambiguous_model(), CheckConfig(fail_on_ambiguous=True))
    gh = render_github(report)
    assert "::error " in gh


def test_render_github_warning_severity():
    report = _run(_ambiguous_model())
    gh = render_github(report)
    assert "::warning " in gh


def test_render_json_round_trips():
    report = _run(_wide_model(), CheckConfig(max_indirect=1))
    restored = CheckReport.model_validate_json(render_json(report))
    assert restored == report


# --------------------------------------------------------------------------- #
# on-disk smoke (the bundled demo is always in the repo)
# --------------------------------------------------------------------------- #

_TINY_PBIP = Path(__file__).resolve().parents[2] / "examples" / "tiny_pbip"


@pytest.mark.skipif(not _TINY_PBIP.exists(), reason="examples/tiny_pbip missing")
def test_run_checks_on_demo_pbip_is_clean():
    from model_lenz.parsers.pbip import parse_pbip

    model = parse_pbip(_TINY_PBIP)
    rg = RelationshipGraph.from_relationships(model.relationships)
    report = run_checks(model, rg, CheckConfig())
    # The bundled demo has no broken refs and no ambiguous paths; blow-up is off
    # by default, so it should pass cleanly.
    assert report.ok is True
    assert report.exit_code == 0
