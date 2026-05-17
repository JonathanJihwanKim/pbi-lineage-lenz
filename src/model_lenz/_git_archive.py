"""Git-ref materializer for `model-lenz diff --git`.

Uses ``git archive`` rather than ``git worktree`` so:

- The user's working tree is never disturbed (works fine on dirty repos).
- No persistent state to clean up (a single temp dir per ref).
- The materialized snapshot is a frozen point-in-time copy that
  ``ModelCache`` can hold open without surprise mtime changes.

Cross-platform extraction goes through the stdlib's ``tarfile`` so Windows
hosts without the ``tar`` binary still work.
"""

from __future__ import annotations

import atexit
import io
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def materialize_ref(
    repo: Path,
    ref: str,
    *,
    subpath: Path | None = None,
    register_cleanup: bool = True,
) -> Path:
    """Extract a Git ref's tree into a fresh temp directory.

    Args:
        repo: Path to a Git working tree (or any directory inside one).
            Passed to ``git -C <repo>``.
        ref: Any Git ref string Git can resolve — branch, tag, SHA,
            ``origin/main``, ``HEAD~3``, etc.
        subpath: Optional subdirectory inside the repo to extract. When
            given, only files under that subdirectory are written; the
            returned path is the materialized subpath. When None, the
            entire tree at ``ref`` is extracted.
        register_cleanup: When True (default) the temp dir is scheduled for
            removal at process exit via ``atexit``.

    Returns:
        Absolute path to the extracted directory (or its ``subpath`` child
        when ``subpath`` is given).

    Raises:
        FileNotFoundError: ``git`` is not on PATH.
        ValueError: ``repo`` doesn't exist, ``ref`` doesn't resolve, or the
            extracted tree is empty (subpath missing at this ref).
    """
    repo = Path(repo).resolve()
    if not repo.exists():
        raise ValueError(f"Repo path does not exist: {repo}")

    # Resolve up front so a bad ref fails fast with a clear message instead
    # of the more cryptic `git archive` error.
    sha = _rev_parse(repo, ref)

    tmp_dir = Path(tempfile.mkdtemp(prefix="model-lenz-git-"))
    if register_cleanup:
        atexit.register(_safe_rmtree, tmp_dir)

    archive_args = ["archive", "--format=tar", sha]
    if subpath is not None:
        # Normalize to POSIX separators — git pathspecs reject backslashes
        # even on Windows.
        archive_args += ["--", str(subpath).replace("\\", "/")]

    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *archive_args],
            capture_output=True,
            check=False,
            timeout=120,
        )
    except FileNotFoundError as e:
        _safe_rmtree(tmp_dir)
        raise FileNotFoundError("`git` not found on PATH") from e

    if result.returncode != 0:
        _safe_rmtree(tmp_dir)
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(
            f"`git archive {ref}` failed in {repo}: {stderr or 'unknown error'}"
        )

    if not result.stdout:
        _safe_rmtree(tmp_dir)
        sp_hint = f" ({subpath})" if subpath else ""
        raise ValueError(
            f"`git archive {ref}` produced an empty tar — check that the "
            f"subpath exists at this ref{sp_hint}"
        )

    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as tf:
            _extract_safely(tf, tmp_dir)
    except (tarfile.TarError, OSError) as e:
        _safe_rmtree(tmp_dir)
        raise ValueError(f"Failed to extract archive for ref '{ref}': {e}") from e

    target = (tmp_dir / subpath) if subpath else tmp_dir
    if not target.exists() or not any(target.iterdir()):
        _safe_rmtree(tmp_dir)
        sp_hint = f" {subpath}" if subpath else ""
        raise ValueError(
            f"No content found at{sp_hint} in ref '{ref}' — wrong subpath, "
            "wrong ref, or PBIP not present in that commit"
        )
    return target.resolve()


def _extract_safely(tf: tarfile.TarFile, dest: Path) -> None:
    """Extract using the safest available filter.

    Python 3.12+ takes a `filter="data"` kwarg that rejects path-traversal
    members and unsafe permissions. On 3.10/3.11 we fall back to the
    unfiltered call — acceptable because the tar bytes came from our own
    `git archive` invocation, not from an untrusted source.
    """
    if sys.version_info >= (3, 12):
        tf.extractall(dest, filter="data")  # type: ignore[call-arg]
    else:
        tf.extractall(dest)


def _rev_parse(repo: Path, ref: str) -> str:
    """Resolve ``ref`` to a commit SHA. Raises ValueError on failure."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--verify", f"{ref}^{{commit}}"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except FileNotFoundError as e:
        raise FileNotFoundError("`git` not found on PATH") from e
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise ValueError(
            f"Could not resolve ref '{ref}' in {repo}: {stderr or 'no such ref'}"
        )
    return result.stdout.strip()


def autodetect_pbip_subpath(repo: Path) -> Path | None:
    """Look for a single ``*.SemanticModel/`` folder at the repo root or one
    level deep in the working tree. Returns its repo-relative path when
    exactly one is found; None when zero or multiple exist (caller should
    then require an explicit ``--subpath``)."""
    repo = Path(repo).resolve()
    if not repo.is_dir():
        return None

    candidates: list[Path] = []
    for child in repo.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        if child.name.endswith(".SemanticModel"):
            candidates.append(child)
            continue
        # One level deep — covers PBIPs nested in a project folder.
        try:
            for sub in child.iterdir():
                if sub.is_dir() and sub.name.endswith(".SemanticModel"):
                    candidates.append(sub)
        except (PermissionError, OSError):
            continue

    if len(candidates) != 1:
        return None
    return candidates[0].relative_to(repo)


def _safe_rmtree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
