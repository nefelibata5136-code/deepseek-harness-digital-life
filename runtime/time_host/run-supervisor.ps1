param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
& $node (Join-Path $PSScriptRoot 'supervisor.mjs') $Config
exit $LASTEXITCODE
