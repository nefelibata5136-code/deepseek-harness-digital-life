$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  npm --prefix runtime/native_dsh ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  python -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed' }
  node scripts/configure.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Configuration failed' }
} finally { Pop-Location }
