$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try { node scripts/start.mjs; if ($LASTEXITCODE -ne 0) { throw 'Host exited with an error' } }
finally { Pop-Location }
