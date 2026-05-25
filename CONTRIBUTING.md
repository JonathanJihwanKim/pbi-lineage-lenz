# Contributing to Model Lenz

Thanks for your interest in improving Model Lenz. This guide covers how to set up the project locally, where things live, and what kind of changes are most welcome.

## Architecture at a glance

```
                           ┌───────────────────┐
   .tmdl, .pq files  ───▶  │  Python backend   │  ◀── HTTP /api  ───┐
   in your PBIP            │  parsers /        │                    │
                           │  analyzers /      │   ┌──────────────────┐
                           │  FastAPI          │   │ React + Vite SPA │
                           └───────────────────┘   │ D3 force graph   │
                                  ▲                │ Zustand store    │
                                  │                └──────────────────┘
                           model-lenz CLI
                          (typer + uvicorn)
```

- **Parser layer** (`src/model_lenz/parsers/`). TMDL block parser (indent-aware state machine), DAX reference extractor (hand-rolled tokenizer), M-query lineage extractor (recursive descent with native-SQL parsing).
- **Analysis layer** (`src/model_lenz/analyzers/`). Relationship graph and indirect-dep walker on NetworkX, transitive measure resolver, fact/dim classifier.
- **JSON contract** (`src/model_lenz/models/`). Pydantic models that the API serializes and the frontend mirrors as TypeScript types. `mypy --strict` runs **only** on this package.
- **HTTP API** (`src/model_lenz/api/routes.py`). FastAPI. Full OpenAPI at `/docs`.
- **Frontend** (`frontend/`). React 18 + Vite + TypeScript. Force graph in D3 directly (no Cytoscape). Zustand for state.

For the full data-flow trace through a single `/api/measures/{table}/{name}/graph` request, see [CLAUDE.md](CLAUDE.md).

## Project layout

```
src/model_lenz/         Python package (parser, analyzers, API, CLI)
  parsers/              TMDL, DAX, M-query parsers
  analyzers/            Classifier, relationship walker, transitive resolver
  models/               Pydantic schemas (the JSON contract)
  api/                  FastAPI routes + cache
  server.py             Uvicorn launcher
  cli.py                Typer entry point: `model-lenz`
  frontend_dist/        Built React bundle (committed at release time)

frontend/               React + Vite + TypeScript source
  src/
    api/                Mirror of the JSON contract + fetch client
    store/              Zustand store
    components/         Header, Sidebar, DetailPanel, Legend
    graph/              D3 force graph (the centerpiece visualization)

tests/
  unit/                 Fast, deterministic unit tests
  e2e/                  Tests that read a real PBIP — gated on
                        $MODEL_LENZ_SAMPLE_PBIP
  fixtures/             Hand-authored TMDL slices

examples/tiny_pbip/     Runnable PBIP shipped with the repo
```

## Dev environment

You need Python 3.10+ and Node 20+.

### One-time setup

**Step 1.** Create the Python virtual environment with `uv`:

```bash
uv venv --python 3.12
```

**Step 2.** Install Model Lenz in editable mode along with dev dependencies:

```bash
uv pip install -e ".[dev]"
```

**Step 3.** Install the frontend dependencies:

```bash
cd frontend && npm install && cd ..
```

That's all the one-time setup you need.

### Daily dev loop — hot reload (recommended)

Iterate on the UI with sub-second feedback. You'll need two terminals running side by side.

**Terminal 1** — Python API server on port 8765 (no browser, no frontend bundle needed):

```bash
.venv/Scripts/model-lenz serve examples/tiny_pbip --port 8765 --no-browser
```

(Linux/macOS: drop the `Scripts/` and use `.venv/bin/model-lenz`.)

Restart this terminal manually whenever you edit a `.py` file.

**Terminal 2** — Vite dev server on port 5173 with hot module reload:

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173/` in your browser. Vite proxies `/api/*` calls to the Python server on `:8765`. Edit any `.tsx` or `.css` file under `frontend/src/` and the browser updates in well under a second — no rebuild, no reinstall.

**Windows shortcut** — `dev.ps1 dev` does both terminals for you in one command:

```powershell
.\dev.ps1 dev "examples\tiny_pbip"
```

It opens two new PowerShell windows (one per terminal) and a browser tab.

### Run the test suite

Unit tests (fast, run in under 2 s):

```bash
pytest tests/unit -v
```

Include the end-to-end sample test by pointing it at a real PBIP:

```bash
MODEL_LENZ_SAMPLE_PBIP=/path/to/your/PBIP pytest tests -v
```

Or use the bundled example so the e2e tests work without a real model:

```bash
MODEL_LENZ_SAMPLE_PBIP=examples/tiny_pbip pytest -v
```

### Pre-release validation — test the actual end-user install path

Before tagging a release (or before sharing the install URL with anyone), verify that a *fresh* `uv tool install` of the wheel works end to end. On Windows, one command does the whole rebuild + reinstall + bundle-hash check:

```powershell
.\dev.ps1 reinstall
```

This kills any running `model-lenz` processes, rebuilds the React bundle, rebuilds the Python wheel, force-reinstalls the global tool from the new wheel, and confirms the source `frontend_dist` and the installed `frontend_dist` have matching JS hashes. After it finishes, `model-lenz serve` from any new terminal runs the latest code.

Skip this for daily UI iteration — the HMR loop above is 200x faster.

## Style and quality

- **Python**: `ruff` for linting/formatting, `mypy --strict` on `src/model_lenz/models/` only (the JSON contract — strictly typed). Other modules use lenient typing.
- **TypeScript**: `tsc --noEmit` in the frontend; `npm run typecheck`.
- Default to writing **no comments**. Add a comment only when it explains *why* something non-obvious is happening (a hidden constraint, a workaround, a subtle invariant). Don't restate what the code does.
- Tests live next to the layer they exercise (parser tests test parsers, walker tests test the walker). Keep fixtures small and hand-authored — no copy-pasted real-world dumps.

## High-leverage contribution areas

Particularly welcome:

1. **TMDL parser fixtures.** Found a TMDL construct that produces a warning or wrong AST? Add a minimal `.tmdl` snippet to `tests/fixtures/edge_cases/` with the expected behaviour. The parser is intentionally tolerant — every fixture grows the test suite.
2. **M lineage connectors.** Add detection for a connector you use (Snowflake, Databricks, Postgres, REST APIs, etc.) in `src/model_lenz/parsers/m_query.py`. Each connector is a small recognizer + a few tests in `test_m_lineage.py`.
3. **Frontend visual polish.** New node shapes, better edge routing, keyboard shortcuts, accessible focus rings.
4. **Real-world PBIP samples.** Anonymized PBIP folders we can include as fixtures help us catch regressions.

## What's *not* in scope

- Authoring or modifying PBIP files (Model Lenz is read-only by design — the README's FAQ states this explicitly).
- Re-implementing what Tabular Editor or DAX Studio already do well (DAX expression debugging, profile traces).
- Connecting to a live AS/Fabric XMLA endpoint (different problem; XMLA-based introspection might land in a separate sibling tool).

## Pull requests

- One topic per PR.
- Add or update tests for behavior changes.
- Include a one-paragraph description focused on the *why* (commit-message style).
- Keep frontend bundle changes (`src/model_lenz/frontend_dist/`) out of feature PRs — those are regenerated at release time.

## Releasing (maintainers only)

```bash
cd frontend && npm run build      # rebuild the SPA bundle
hatch build                       # produce sdist + wheel into dist/
# verify: pipx install dist/model_lenz-X.Y.Z-py3-none-any.whl
twine upload dist/*               # or use OIDC publish via GitHub Actions
git tag vX.Y.Z && git push --tags
```

Thanks for contributing.
