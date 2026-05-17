<#
.SYNOPSIS
    Model Lenz dev convenience script (Windows / PowerShell).

.DESCRIPTION
    One-command wrapper around the rebuild / reinstall / run cycle so iterating
    on the code doesn't require remembering four separate commands.

    Why this exists: Model Lenz lives in two places on a dev machine.
      - The .venv editable install: source-code changes are live immediately
        (no rebuild needed for Python edits) and frontend changes are picked
        up by `npm run build`.
      - The global `uv tool` install at ~/.local/bin: stale until you rebuild
        the wheel AND `uv tool install --force` it.

    `dev.ps1 reinstall` does the whole dance in one go.

.EXAMPLE
    .\dev.ps1 reinstall
    Rebuild frontend + Python wheel, kill running model-lenz processes, and
    reinstall the global tool. After this, `model-lenz` everywhere serves
    the latest code.

.EXAMPLE
    .\dev.ps1 serve "D:\sample_powerbi"
    Reinstall, then serve the given PBIP. Browser opens to the new bundle.

.EXAMPLE
    .\dev.ps1 demo
    Reinstall, then serve the bundled demo PBIP.

.EXAMPLE
    .\dev.ps1 test
    Run pytest. (Doesn't reinstall - tests run against the editable .venv.)
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("help", "dev", "rebuild", "reinstall", "serve", "demo", "test", "fmt", "clean")]
    [string]$Command = "help",

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
# `uvx hatch` instead of the venv shim — on Windows machines with Application
# Control policies, the venv-local hatch.exe trampoline can be blocked with
# `uv trampoline failed to spawn Python child process (os error 4551)`.
# uvx routes through the signed top-level uv.exe and avoids that class of block.
$WheelGlob = Join-Path $RepoRoot "dist\model_lenz-*.whl"
$GlobalExe = Join-Path $env:USERPROFILE ".local\bin\model-lenz.exe"

function Write-Step {
    param([string]$msg)
    Write-Host ""
    Write-Host ">>> $msg" -ForegroundColor Cyan
}

function Invoke-CleanDist {
    if (Test-Path (Join-Path $RepoRoot "dist")) {
        Remove-Item -Recurse -Force (Join-Path $RepoRoot "dist")
    }
}

function Stop-RunningServers {
    $procs = Get-Process model-lenz -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Step "Stopping $($procs.Count) running model-lenz process(es)"
        $procs | ForEach-Object { Write-Host "    PID $($_.Id)"; $_.Kill() }
        Start-Sleep -Milliseconds 500
    }
}

function Invoke-Rebuild {
    Stop-RunningServers
    Write-Step "Building frontend bundle (npm run build)"
    Push-Location (Join-Path $RepoRoot "frontend")
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "    node_modules missing - running npm install first"
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }

    Write-Step "Building Python wheel (hatch build)"
    Invoke-CleanDist
    uvx hatch build
    if ($LASTEXITCODE -ne 0) { throw "hatch build failed" }
}

function Invoke-Reinstall {
    Invoke-Rebuild
    Write-Step "Installing global model-lenz from the new wheel"
    $wheel = Get-ChildItem $WheelGlob | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $wheel) { throw "No wheel found at $WheelGlob" }
    uv tool install --force $wheel.FullName
    if ($LASTEXITCODE -ne 0) { throw "uv tool install failed" }

    Write-Step "Verifying bundle hashes match between source and global install"
    $srcAssets = Get-ChildItem (Join-Path $RepoRoot "src\model_lenz\frontend_dist\assets") | Select-Object -ExpandProperty Name | Sort-Object
    $globalAssets = Get-ChildItem (Join-Path $env:APPDATA "uv\tools\model-lenz\Lib\site-packages\model_lenz\frontend_dist\assets") | Select-Object -ExpandProperty Name | Sort-Object
    if (Compare-Object $srcAssets $globalAssets) {
        Write-Warning "Bundle hash mismatch! Source: $srcAssets / Global: $globalAssets"
    } else {
        Write-Host "    OK - both have: $($srcAssets -join ', ')" -ForegroundColor Green
    }
    Write-Host ""
    Write-Host "Done. The 'model-lenz' command everywhere now serves the latest code." -ForegroundColor Green
    Write-Host "Tip: in your browser, hit Ctrl+F5 to bypass the JS cache." -ForegroundColor Yellow
}

function Invoke-Serve {
    if (-not $Args -or $Args.Count -eq 0) {
        throw "Usage: .\dev.ps1 serve <path-to-pbip-folder>"
    }
    Invoke-Reinstall
    Write-Step "Starting model-lenz serve $($Args -join ' ')"
    & $GlobalExe serve @Args
}

function Invoke-Demo {
    Invoke-Reinstall
    Write-Step "Starting model-lenz demo"
    & $GlobalExe demo @Args
}

function Invoke-Dev {
    if (-not $Args -or $Args.Count -eq 0) {
        throw "Usage: .\dev.ps1 dev <path-to-pbip-folder>"
    }
    $pbip = $Args[0]
    Stop-RunningServers

    Write-Step "Launching API terminal (Python, port 8765)"
    $apiCmd = "& '$VenvPython' -m model_lenz.cli serve '$pbip' --port 8765 --no-browser"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $apiCmd

    Start-Sleep -Seconds 2

    Write-Step "Launching frontend HMR terminal (Vite, port 5173)"
    $frontendDir = Join-Path $RepoRoot "frontend"
    if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
        Write-Host "    node_modules missing - running npm install in foreground first..."
        Push-Location $frontendDir
        npm install
        Pop-Location
    }
    $feCmd = "Set-Location '$frontendDir'; npm run dev"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $feCmd

    Start-Sleep -Seconds 3
    $url = "http://localhost:5173/"
    Write-Step "Opening browser at $url"
    Start-Process $url

    Write-Host ""
    Write-Host "Two terminals are now running:" -ForegroundColor Green
    Write-Host "  1. Python API on http://127.0.0.1:8765 (restart it manually after .py edits)" -ForegroundColor White
    Write-Host "  2. Vite frontend on http://localhost:5173 (auto-reloads on .tsx/.css edits)" -ForegroundColor White
    Write-Host ""
    Write-Host "Browser is open. Edit anything under frontend/src/ -> changes appear in <1 s." -ForegroundColor Yellow
    Write-Host "Close either terminal window to stop that piece." -ForegroundColor Yellow
}

function Invoke-Test {
    Write-Step "Running pytest (against the editable .venv install)"
    & $VenvPython -m pytest tests/ @Args
}

function Invoke-Fmt {
    Write-Step "Running ruff format + check"
    & (Join-Path $RepoRoot ".venv\Scripts\ruff.exe") format src tests
    & (Join-Path $RepoRoot ".venv\Scripts\ruff.exe") check src tests
}

function Show-Help {
    Write-Host ""
    Write-Host "Model Lenz dev script" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage:  .\dev.ps1 <command> [args]" -ForegroundColor White
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor White
    Write-Host "  dev <pbip-path>      Hot-reload dev mode: opens API terminal + Vite HMR terminal + browser"
    Write-Host "  rebuild              Rebuild frontend bundle + Python wheel"
    Write-Host "  reinstall            Rebuild + reinstall the GLOBAL 'model-lenz' (one-shot)"
    Write-Host "  serve <pbip-path>    Reinstall, then serve the given PBIP folder"
    Write-Host "  demo                 Reinstall, then serve the bundled demo"
    Write-Host "  test [pytest-args]   Run the test suite"
    Write-Host "  fmt                  Run ruff format + check"
    Write-Host "  clean                Remove dist/ and frontend/dist/"
    Write-Host "  help                 This screen"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor White
    Write-Host "  .\dev.ps1 reinstall"
    Write-Host "  .\dev.ps1 serve `"D:\sample_powerbi`""
    Write-Host "  .\dev.ps1 demo"
    Write-Host "  .\dev.ps1 test -k userel"
    Write-Host ""
}

switch ($Command) {
    "dev"       { Invoke-Dev }
    "rebuild"   { Invoke-Rebuild }
    "reinstall" { Invoke-Reinstall }
    "serve"     { Invoke-Serve }
    "demo"      { Invoke-Demo }
    "test"      { Invoke-Test }
    "fmt"       { Invoke-Fmt }
    "clean"     {
        Invoke-CleanDist
        if (Test-Path (Join-Path $RepoRoot "frontend\dist")) {
            Remove-Item -Recurse -Force (Join-Path $RepoRoot "frontend\dist")
        }
        Write-Host "Cleaned dist/ and frontend/dist/"
    }
    default     { Show-Help }
}
