"""Model Lenz CLI.

Entry point installed as the ``model-lenz`` console script.

Subcommands:
- ``model-lenz inspect <pbip-path>`` — parse the model and print JSON to stdout.
- ``model-lenz summary <pbip-path>``  — terse human summary.
- ``model-lenz <pbip-path>``          — (M2+) start the local web app. For M1
  this is aliased to ``summary`` so the binary already does something useful.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import typer

from model_lenz import __version__
from model_lenz.parsers.pbip import parse_pbip

app = typer.Typer(
    name="model-lenz",
    help="Open-source PBIP analyzer.",
    add_completion=False,
    no_args_is_help=True,
)

PBIP_PATH_HELP = (
    "Path to a PBIP. Recommended: the PBIP ROOT folder (the one "
    "containing the .pbip file and the *.SemanticModel\\ subfolder). "
    "The *.SemanticModel\\ folder itself or its definition\\ subfolder "
    "also work."
)


def _print_summary(pbip_path: Path) -> None:
    model = parse_pbip(pbip_path)
    measure_total = sum(len(t.measures) for t in model.tables)
    classifications: dict[str, int] = {}
    for t in model.tables:
        classifications[t.classification] = classifications.get(t.classification, 0) + 1

    confidence: dict[str, int] = {}
    for t in model.tables:
        for p in t.partitions:
            label = p.source_lineage.confidence if p.source_lineage else "none"
            confidence[label] = confidence.get(label, 0) + 1

    typer.echo(f"Model:         {model.name}")
    typer.echo(f"Tables:        {len(model.tables)}")
    typer.echo(f"Measures:      {measure_total}")
    typer.echo(f"Relationships: {len(model.relationships)}")
    typer.echo(f"Expressions:   {len(model.expressions)}")
    typer.echo(f"Functions:     {len(model.functions)}")
    typer.echo(f"Warnings:      {len(model.warnings)}")
    typer.echo(f"Classification: {classifications}")
    typer.echo(f"Lineage conf  : {confidence}")


@app.command()
def inspect(
    pbip_path: Path = typer.Argument(..., exists=True, help=PBIP_PATH_HELP),
    indent: int = typer.Option(2, "--indent", "-i", help="JSON indent (0 for compact)."),
    output: Path | None = typer.Option(None, "--output", "-o", help="Write JSON to this file instead of stdout."),
) -> None:
    """Parse a PBIP and print the parsed model as JSON."""
    model = parse_pbip(pbip_path)
    blob = model.model_dump(by_alias=True, mode="json")
    rendered = json.dumps(blob, indent=indent if indent > 0 else None, ensure_ascii=False)
    if output:
        output.write_text(rendered, encoding="utf-8")
        typer.echo(f"Wrote {output} ({len(rendered):,} bytes)")
    else:
        # Write to stdout as UTF-8 bytes to avoid Windows cp1252 errors on
        # Unicode characters embedded in DAX/M expressions.
        sys.stdout.buffer.write(rendered.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")


@app.command()
def summary(
    pbip_path: Path = typer.Argument(..., exists=True, help=PBIP_PATH_HELP),
) -> None:
    """Print a one-screen human summary of the parsed model."""
    _print_summary(pbip_path)


@app.command(name="version")
def version_cmd() -> None:
    """Print the Model Lenz version."""
    typer.echo(__version__)


@app.command()
def serve(
    pbip_path: Path = typer.Argument(..., exists=True, help=PBIP_PATH_HELP),
    host: str = typer.Option("127.0.0.1", "--host", "-H", help="Bind host."),
    port: int = typer.Option(0, "--port", "-p", help="Bind port (0 = auto)."),
    no_browser: bool = typer.Option(False, "--no-browser", help="Don't open a browser."),
) -> None:
    """Start the local web server and open the model in a browser."""
    from model_lenz.server import serve as _serve

    _serve(pbip_path, host=host, port=port, open_browser=not no_browser)


@app.command()
def diff(
    base: str = typer.Argument(
        ...,
        help=(
            "BASE side (the 'main' side). A folder path by default; "
            "interpreted as a Git ref when --git is set."
        ),
    ),
    head: str = typer.Argument(
        ...,
        help=(
            "HEAD side (the side proposing changes). A folder path by default; "
            "interpreted as a Git ref when --git is set."
        ),
    ),
    git: bool = typer.Option(
        False,
        "--git",
        "-g",
        help=(
            "Interpret BASE and HEAD as Git refs (branch / tag / SHA / "
            "origin/main / HEAD~1, etc.) instead of folder paths. Materializes "
            "each ref into a temp directory via `git archive` — your working "
            "tree is not touched."
        ),
    ),
    repo: Path = typer.Option(
        Path("."),
        "--repo",
        help="Git repo root for --git mode. Defaults to the current directory.",
    ),
    subpath: Path | None = typer.Option(
        None,
        "--subpath",
        help=(
            "Subdirectory inside the repo to extract in --git mode. "
            "Auto-detected when the repo root contains exactly one "
            "*.SemanticModel/ folder (root or one level deep)."
        ),
    ),
    name_base: str | None = typer.Option(
        None,
        "--name-base",
        help="Override the BASE label shown in the diff UI. Defaults to the Git branch (if `base` is in a working tree), the ref name (--git), or the folder name.",
    ),
    name_head: str | None = typer.Option(
        None,
        "--name-head",
        help="Override the HEAD label shown in the diff UI. Defaults to the Git branch (if `head` is in a working tree), the ref name (--git), or the folder name.",
    ),
    host: str = typer.Option("127.0.0.1", "--host", "-H", help="Bind host."),
    port: int = typer.Option(0, "--port", "-p", help="Bind port (0 = auto)."),
    no_browser: bool = typer.Option(False, "--no-browser", help="Don't open a browser."),
) -> None:
    """Diff two PBIP folders and open a side-by-side comparison in the browser.

    BASE is the 'main' side; HEAD is the side proposing changes (typically a
    feature branch wanting to merge back). Labels auto-fill from Git branch
    names when either folder is inside a working tree; pass `--name-base` /
    `--name-head` to override.

    With --git, BASE and HEAD are Git refs resolved against --repo (or the
    current directory). Use this to compare two branches without setting up
    a worktree:

        model-lenz diff --git origin/main HEAD
    """
    from model_lenz.git_meta import detect_branch_label, detect_is_default_branch
    from model_lenz.server import serve as _serve

    if git:
        from model_lenz._git_archive import autodetect_pbip_subpath, materialize_ref

        repo_resolved = repo.resolve()
        sp = subpath if subpath is not None else autodetect_pbip_subpath(repo_resolved)
        if sp is None:
            raise typer.BadParameter(
                "Could not auto-detect a *.SemanticModel/ folder in "
                f"{repo_resolved}. Pass --subpath explicitly "
                "(e.g. --subpath examples/tiny_pbip)."
            )
        try:
            typer.echo(f"Materializing BASE ({base}) from {repo_resolved}/{sp}…")
            base_resolved = materialize_ref(repo_resolved, base, subpath=sp)
            typer.echo(f"Materializing HEAD ({head}) from {repo_resolved}/{sp}…")
            head_resolved = materialize_ref(repo_resolved, head, subpath=sp)
        except FileNotFoundError as e:
            raise typer.BadParameter(str(e)) from e
        except ValueError as e:
            raise typer.BadParameter(str(e)) from e

        base_label = name_base or base
        head_label = name_head or head
        # Temp dirs aren't in a working tree, so the origin/HEAD heuristic
        # doesn't apply. Honor the explicit "main"/"master" ref names as the
        # default branch though — common usage where the gold pin is helpful.
        base_is_default = base in {"main", "master", "origin/main", "origin/master"}
    else:
        base_path = Path(base)
        head_path = Path(head)
        if not base_path.exists():
            raise typer.BadParameter(f"BASE path does not exist: {base_path}")
        if not head_path.exists():
            raise typer.BadParameter(f"HEAD path does not exist: {head_path}")
        base_resolved = base_path.resolve()
        head_resolved = head_path.resolve()
        base_label = name_base or detect_branch_label(base_resolved) or base_resolved.name
        head_label = name_head or detect_branch_label(head_resolved) or head_resolved.name
        base_is_default = detect_is_default_branch(base_resolved)

    diff_context = {
        "base_path": str(base_resolved),
        "head_path": str(head_resolved),
        "base_label": base_label,
        "head_label": head_label,
        "base_is_default_branch": base_is_default,
    }

    typer.echo(f"BASE  ({base_label}): {base_resolved}")
    typer.echo(f"HEAD  ({head_label}): {head_resolved}")

    # Pass `base_resolved` as the primary pbip_path so single-model API
    # endpoints (/api/measures, /api/tables) still work on the BASE side if
    # the user navigates to "/" from the diff view. The diff endpoints use
    # both paths through diff_context.
    _serve(
        base_resolved,
        host=host,
        port=port,
        open_browser=not no_browser,
        diff_context=diff_context,
        landing_path="/diff",
    )


@app.command()
def demo(
    host: str = typer.Option("127.0.0.1", "--host", "-H", help="Bind host."),
    port: int = typer.Option(0, "--port", "-p", help="Bind port (0 = auto)."),
    no_browser: bool = typer.Option(False, "--no-browser", help="Don't open a browser."),
) -> None:
    """Serve the bundled tiny demo PBIP - no path or clone needed."""
    from model_lenz.server import serve as _serve

    # Wheel install: bundled at <package>/_demo/tiny_pbip via force-include.
    # Editable install (pip install -e .): fall back to repo's examples/tiny_pbip.
    candidates = [
        Path(__file__).parent / "_demo" / "tiny_pbip",
        Path(__file__).parent.parent.parent / "examples" / "tiny_pbip",
    ]
    demo_path = next((p for p in candidates if p.exists()), None)
    if demo_path is None:
        raise typer.BadParameter(
            "Bundled demo not found. Tried:\n  "
            + "\n  ".join(str(p) for p in candidates)
            + "\nIf you're running from a source checkout, ensure examples/tiny_pbip exists."
        )
    typer.echo(f"Serving bundled demo from {demo_path}")
    _serve(demo_path, host=host, port=port, open_browser=not no_browser)


def main() -> None:  # pragma: no cover
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
