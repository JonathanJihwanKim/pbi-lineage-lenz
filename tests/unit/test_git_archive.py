"""Tests for `_git_archive.py` — Git ref materialization for `diff --git`.

Unit tests mock `subprocess.run` for error paths (ref not found, git missing).
The integration tests build a real two-commit Git repo in `tmp_path` and run
`materialize_ref` end-to-end; they're skipped when `git` isn't on PATH so the
suite stays hermetic.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from model_lenz import _git_archive
from model_lenz._git_archive import autodetect_pbip_subpath, materialize_ref

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _git_available() -> bool:
    try:
        subprocess.run(
            ["git", "--version"], capture_output=True, timeout=2, check=True
        )
        return True
    except (FileNotFoundError, subprocess.SubprocessError):
        return False


requires_git = pytest.mark.skipif(not _git_available(), reason="git not on PATH")


def _git(repo: Path, *args: str, env_extras: dict | None = None) -> None:
    env = {
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
    }
    if env_extras:
        env.update(env_extras)
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        env={**env},
    )


def _init_two_commit_repo(repo: Path) -> tuple[str, str]:
    """Build a tiny repo with two commits. Returns (first_sha, second_sha)."""
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q", "-b", "main")

    pbip = repo / "pbip" / "tiny.SemanticModel" / "definition"
    pbip.mkdir(parents=True)
    (pbip / "tables").mkdir()
    (pbip / "tables" / "Sales.tmdl").write_text(
        "table Sales\n  measure 'Total' = SUM(Sales[Amount])\n", encoding="utf-8"
    )
    (pbip / "relationships.tmdl").write_text("", encoding="utf-8")

    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "first")
    first = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    # Second commit: tweak the DAX
    (pbip / "tables" / "Sales.tmdl").write_text(
        "table Sales\n  measure 'Total' = SUMX(Sales, Sales[Amount])\n",
        encoding="utf-8",
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "second")
    second = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    return first, second


# --------------------------------------------------------------------------- #
# Unit tests (mocked subprocess)
# --------------------------------------------------------------------------- #


def test_materialize_ref_raises_when_git_missing(monkeypatch, tmp_path: Path):
    def boom(*args, **kwargs):
        raise FileNotFoundError("git not installed")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(FileNotFoundError, match="`git` not found"):
        materialize_ref(tmp_path, "HEAD")


def test_materialize_ref_raises_when_ref_unresolvable(monkeypatch, tmp_path: Path):
    def fake_run(args, **kwargs):
        assert args[3] == "rev-parse"
        return subprocess.CompletedProcess(
            args, returncode=128, stdout="", stderr="fatal: bad revision 'nope'"
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(ValueError, match="Could not resolve ref 'nope'"):
        materialize_ref(tmp_path, "nope")


def test_materialize_ref_raises_when_repo_missing(tmp_path: Path):
    missing = tmp_path / "does_not_exist"
    with pytest.raises(ValueError, match="Repo path does not exist"):
        materialize_ref(missing, "HEAD")


# --------------------------------------------------------------------------- #
# Autodetect
# --------------------------------------------------------------------------- #


def test_autodetect_finds_top_level_semantic_model(tmp_path: Path):
    (tmp_path / "Sales.SemanticModel").mkdir()
    found = autodetect_pbip_subpath(tmp_path)
    assert found == Path("Sales.SemanticModel")


def test_autodetect_finds_nested_semantic_model(tmp_path: Path):
    (tmp_path / "project" / "Sales.SemanticModel").mkdir(parents=True)
    found = autodetect_pbip_subpath(tmp_path)
    assert found == Path("project") / "Sales.SemanticModel"


def test_autodetect_returns_none_when_ambiguous(tmp_path: Path):
    (tmp_path / "A.SemanticModel").mkdir()
    (tmp_path / "B.SemanticModel").mkdir()
    assert autodetect_pbip_subpath(tmp_path) is None


def test_autodetect_returns_none_when_missing(tmp_path: Path):
    (tmp_path / "src").mkdir()
    assert autodetect_pbip_subpath(tmp_path) is None


def test_autodetect_ignores_dot_directories(tmp_path: Path):
    (tmp_path / ".git" / "Sales.SemanticModel").mkdir(parents=True)
    (tmp_path / "Sales.SemanticModel").mkdir()
    assert autodetect_pbip_subpath(tmp_path) == Path("Sales.SemanticModel")


# --------------------------------------------------------------------------- #
# Integration tests (real git)
# --------------------------------------------------------------------------- #


@requires_git
def test_materialize_extracts_full_repo_at_head(tmp_path: Path):
    repo = tmp_path / "repo"
    _first, _second = _init_two_commit_repo(repo)
    out = materialize_ref(repo, "HEAD", register_cleanup=False)
    try:
        tmdl = out / "pbip" / "tiny.SemanticModel" / "definition" / "tables" / "Sales.tmdl"
        assert tmdl.exists()
        assert "SUMX" in tmdl.read_text(encoding="utf-8")
    finally:
        _git_archive._safe_rmtree(out)


@requires_git
def test_materialize_extracts_subpath_at_old_commit(tmp_path: Path):
    repo = tmp_path / "repo"
    first, _second = _init_two_commit_repo(repo)
    sub = Path("pbip/tiny.SemanticModel")
    out = materialize_ref(repo, first, subpath=sub, register_cleanup=False)
    try:
        # Should return the materialized subpath (not the temp root)
        assert out.name == "tiny.SemanticModel"
        tmdl = out / "definition" / "tables" / "Sales.tmdl"
        assert tmdl.exists()
        # First commit had SUM, not SUMX
        text = tmdl.read_text(encoding="utf-8")
        assert "SUM(" in text
        assert "SUMX" not in text
    finally:
        _git_archive._safe_rmtree(out.parent.parent)


@requires_git
def test_materialize_raises_on_missing_subpath(tmp_path: Path):
    repo = tmp_path / "repo"
    _init_two_commit_repo(repo)
    with pytest.raises(ValueError):
        materialize_ref(repo, "HEAD", subpath=Path("not_a_real_path"))


@requires_git
def test_materialize_raises_on_bad_ref(tmp_path: Path):
    repo = tmp_path / "repo"
    _init_two_commit_repo(repo)
    with pytest.raises(ValueError, match="Could not resolve ref"):
        materialize_ref(repo, "no-such-branch")
