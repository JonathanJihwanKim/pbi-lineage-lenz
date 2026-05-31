"""``model-lenz check`` — the CI gate. Read-only static rules over a parsed PBIP."""

from __future__ import annotations

from model_lenz.checks.render import render_github, render_json, render_text
from model_lenz.checks.report import CheckConfig, CheckReport, Severity, Violation
from model_lenz.checks.rules import run_checks

__all__ = [
    "CheckConfig",
    "CheckReport",
    "Severity",
    "Violation",
    "render_github",
    "render_json",
    "render_text",
    "run_checks",
]
