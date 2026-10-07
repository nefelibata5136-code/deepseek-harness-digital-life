$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'stable-manifest.json') -Raw | ConvertFrom-Json
$name = $manifest.bootstrapEntry
if (!$name -or $name -notmatch '^bootstrap\.stable(?:-[a-z0-9-]+)?\.mjs$') { throw 'Verified bootstrap snapshot is required' }
$entry = Join-Path $PSScriptRoot $name
$expected = $manifest.files.PSObject.Properties[$name].Value
if (!$expected -or (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Bootstrap snapshot hash mismatch; preserve evidence' }
& $node $entry --run
exit $LASTEXITCODE
