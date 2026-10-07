$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$taskPidFile = Join-Path $taskConfig.private_root 'service.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskServicePid = [int](Get-Content -LiteralPath $taskPidFile -Raw)
    $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskServicePid)
    $taskExpectedScript = Join-Path $PSScriptRoot 'server.py'
    if ($taskProcess) {
        if (-not $taskProcess.CommandLine.Contains($taskExpectedScript)) { throw 'PID does not belong to this service; refusing to stop' }
        Stop-Process -Id $taskServicePid
    }
}
& (Join-Path $PSScriptRoot 'start.ps1')
