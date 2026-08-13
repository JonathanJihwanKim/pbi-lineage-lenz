"""
The entire behaviour of model-lenz 0.5.x: say where the tool went, and exit non-zero.

Exiting non-zero is deliberate. The command people most often automated was
`model-lenz check`, a gate that fails a build on a broken reference. A deprecated
version that printed a notice and exited 0 would turn that gate into something that
always passes — a silent no-op standing where a check used to be, which is worse
than no check at all, because it still looks like one.
"""

import sys

NOTICE = """
  model-lenz is no longer maintained.

  It has been replaced by PBI Lineage Lenz, which does everything this did and
  more — and needs no Python, no virtualenv, and no install:

      npx pbi-lineage-lenz handoff ./MyReport -o handoff.html

  Or open a model in your browser with nothing installed at all:

      https://jonathanjihwankim.github.io/pbi-lineage-lenz/

  What moved:

      model-lenz serve     ->  the web app, or `npx pbi-lineage-lenz handoff`
      model-lenz check     ->  npx pbi-lineage-lenz check
      model-lenz summary   ->  npx pbi-lineage-lenz docs --format md
      model-lenz export    ->  npx pbi-lineage-lenz docs --format md|json|html

  Why: three tools of mine overlapped, and keeping a Python engine and a
  JavaScript one in step meant every parser fix had to be made twice. The
  JavaScript engine also runs in the browser, which is what makes a handoff file
  possible — one HTML file that opens with no Power BI and no install on the far
  end. That was worth more than keeping two of everything.

  Nothing is being deleted. If you depend on this tool, pin the last working
  release:

      pip install model-lenz==0.4.0

  Source, docs and issues:
  https://github.com/JonathanJihwanKim/pbi-lineage-lenz
"""


def main() -> int:
    """Print the notice on stderr and fail."""
    # stderr, so a pipeline capturing stdout does not fold this into its data.
    print(NOTICE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
