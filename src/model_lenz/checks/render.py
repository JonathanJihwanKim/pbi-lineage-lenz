"""Renderers for a ``CheckReport``: human text, GitHub annotations, JSON.

GitHub annotations are emitted *without* a ``file=`` anchor: the parser does not
currently track which TMDL file a measure came from, so a workflow command can't
point at a line. The annotations still surface in the Actions run log and the PR
"Checks" summary — just not inline against a diff hunk. Wiring measure→source-file
is a follow-up; until then these are file-less ``::error``/``::warning`` lines.
"""

from __future__ import annotations

from model_lenz.checks.report import CheckReport, Violation

_SEVERITY_GLYPH = {"error": "✖", "warning": "⚠"}


def render_text(report: CheckReport) -> str:
    lines: list[str] = []
    by_rule: dict[str, list[Violation]] = {}
    for v in report.violations:
        by_rule.setdefault(v.rule, []).append(v)

    for rule in sorted(by_rule):
        violations = by_rule[rule]
        lines.append(f"{rule} ({len(violations)}):")
        for v in violations:
            glyph = _SEVERITY_GLYPH.get(v.severity, "-")
            lines.append(f"  {glyph} [{v.table}].[{v.measure}] — {v.message}")
        lines.append("")

    if report.ok:
        suffix = ""
        if report.warning_count:
            suffix = f" ({report.warning_count} warning(s))"
        lines.append(f"PASS{suffix}")
    else:
        lines.append(f"FAIL: {report.error_count} error(s), {report.warning_count} warning(s)")
    return "\n".join(lines)


def render_github(report: CheckReport) -> str:
    lines: list[str] = []
    for v in report.violations:
        title = f"{v.rule}: [{v.table}].[{v.measure}]"
        msg = _escape_annotation(v.message)
        lines.append(f"::{v.severity} title={title}::{msg}")
    return "\n".join(lines)


def render_json(report: CheckReport) -> str:
    return report.model_dump_json(indent=2)


def _escape_annotation(text: str) -> str:
    """Escape the characters GitHub treats specially in workflow command data."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
