$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  npm --prefix runtime/native_dsh ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment failed' }
  }
  .venv/Scripts/python.exe -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed' }
  node scripts/setup-world.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Configuration failed' }
} finally { Pop-Location }
