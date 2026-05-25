# Install, Update, and Point Model Lenz at Your PBIP

← Back to [README](../README.md)

You only need Python 3.10+. Pick whichever installer you have. They all end with the same `model-lenz` command on your PATH.

> **Do I need to clone the repo?** No. Installing from PyPI gives you the full tool, including the bundled `model-lenz demo`. Clone the repo only if you want to contribute code or read the source.

## Windows (PowerShell), three steps

**Step 1.** Install `uv` (Astral's installer, one-time, ~10 seconds):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

You only do this once per machine. If `uv --version` already prints something, skip it.

**Step 2.** Install Model Lenz as a global tool:

```powershell
uv tool install model-lenz
```

This downloads the latest `model-lenz` wheel from PyPI and registers a `model-lenz` command on your PATH (in `~\.local\bin\`). No clone, no Python project setup.

**Step 3.** Open a *new* PowerShell window (so the PATH update is picked up), then run:

```powershell
model-lenz serve "C:\projects\Sales\Sales.SemanticModel"
```

Replace the path with your `*.SemanticModel/` folder. That's the one Power BI Desktop creates next to your `.pbip` file. The browser opens automatically.

- *Path has spaces?* Wrap it in double quotes: `model-lenz serve "C:\My Reports\Q4 Sales\Q4 Sales.SemanticModel"`.
- *Prefer pointing at the PBIP root?* That works too. Model Lenz auto-detects the `*.SemanticModel/` child. See [Point it at your PBIP folder](#point-it-at-your-pbip-folder).

## macOS / Linux, three steps

**Step 1.** Install `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Skip if you already have `uv`. If you have `pipx` and prefer it, you can use `pipx install model-lenz` in step 2 instead.

**Step 2.** Install Model Lenz as a global tool:

```bash
uv tool install model-lenz
```

**Step 3.** In a new shell session, run it against your `*.SemanticModel/` folder:

```bash
model-lenz serve path/to/Sales.SemanticModel
```

## Already have Python and just want it in your environment?

```bash
pip install model-lenz
```

(Not recommended. `uv tool` / `pipx` keep `model-lenz` isolated from your project Pythons.)

---

## Update

When a new Model Lenz release lands on PyPI, your installed copy keeps running the old version until you upgrade. One command:

```powershell
uv tool upgrade model-lenz
```

(macOS/Linux: same command. With pipx: `pipx upgrade model-lenz`.)

After upgrading, close any open `model-lenz` browser tab and stop any running server (Ctrl+C in the terminal), then run `model-lenz serve` again. The browser should pick up the new bundle automatically. If it doesn't, hit **Ctrl+F5** (or **Cmd+Shift+R** on Mac) to force-refresh past the cached JavaScript.

Confirm the version you have:

```powershell
model-lenz version
```

---

## Point it at your PBIP folder

PBIP saves your project as a folder tree:

```
Sales\                                      ← the PBIP root (what Power BI Desktop opens)
  Sales.pbip                                ← the project file
  Sales.SemanticModel\                      ← the model. Point here.
    definition\
      tables\*.tmdl
      relationships.tmdl
      expressions.tmdl
  Sales.Report\                             ← report layer (PBIR). Not read by Model Lenz.
                                              See PBIP Lineage Explorer for visual lineage.
```

`model-lenz serve` accepts any of these three paths. They all parse the same model:

| Path you pass                                       | Works? | Notes                                     |
|-----------------------------------------------------|--------|-------------------------------------------|
| `Sales\Sales.SemanticModel`  *(the model folder)*   | ✅ recommended | The folder Model Lenz actually reads. |
| `Sales`  *(the PBIP root, containing `Sales.pbip`)* | ✅      | Also works. Model Lenz locates the `.SemanticModel/` child automatically. |
| `Sales\Sales.SemanticModel\definition`              | ✅      | The innermost folder still works.        |

**Switch PBIPs without restarting.** Once the server is running, click **Open…** next to the model name in the header to point it at a different PBIP. No `Ctrl+C` and re-run — paste the path (Explorer's *Copy as path* with surrounding quotes works), hit **Open**, and the sidebar, graph, and selection state all refresh to the new model. The previously loaded model stays cached in memory, so toggling back is instant.

---

## Troubleshooting

- **"`pipx` is not recognized" on Windows.** Use `uv tool install` instead (see top of this page). `uv` is a single-binary installer and doesn't need pip.
- **`model-lenz` isn't found after install.** Open a *new* terminal window. The installer added a directory (`~/.local/bin` on Linux/macOS, `%USERPROFILE%\.local\bin` on Windows) to your PATH, but existing terminals don't see it until they restart.
- **Browser doesn't open automatically.** It prints the URL. Copy `http://127.0.0.1:<port>/` into your browser. Add `--no-browser` to suppress the auto-open.
- **"Address already in use".** Pick a port: `model-lenz serve … --port 8765`.
