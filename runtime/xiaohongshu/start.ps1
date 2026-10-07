$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Raw | ConvertFrom-Json
$taskHealthUrl = 'http://127.0.0.1:' + $taskConfig.port + '/health'
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod -Uri $taskHealthUrl -TimeoutSec 2 } catch { }
if ($taskHealth) {
    $taskExpectedCount = if ($taskConfig.enable_image_export) { 16 } else { 14 }
    if ($taskHealth.public_social_read_only -and $taskHealth.tools.Count -eq $taskExpectedCount) {
        $taskHealth | ConvertTo-Json -Depth 6
        exit 0
    }
    throw 'Port belongs to a different service'
}
New-Item -ItemType Directory -Force -Path $taskConfig.private_root | Out-Null
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
$taskScript = Join-Path $taskRoot 'server.py'
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-X','utf8',('"' + $taskScript + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskConfig.private_root 'service.stdout.log') -RedirectStandardError (Join-Path $taskConfig.private_root 'service.stderr.log')
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskConfig.private_root 'service.pid')
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    try { Invoke-RestMethod -Uri $taskHealthUrl -TimeoutSec 1 | ConvertTo-Json -Depth 6; exit 0 } catch { }
}
throw 'Xiaohongshu MCP did not become healthy; inspect private service logs'
