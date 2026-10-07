$ErrorActionPreference = 'Stop'
$reportRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../reports/task_C'))
$testRoot = Join-Path $reportRoot ('task-plan-test-' + [guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$configPath = Join-Path $testRoot 'config.json'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$config = @{ technicalTest=$true; instanceId=('c-plan-' + [guid]::NewGuid().ToString());
  command=$node; args=@((Join-Path $PSScriptRoot 'supervisor-fixture.mjs'),'steady'); cwd=$testRoot; stateDir=$testRoot }
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$name = 'Persona-C-Test-' + [guid]::NewGuid().ToString()
$installed = $false
$result = @{ observedAt=[DateTimeOffset]::Now.ToUniversalTime().ToString('o'); production_registered=$false;
  preview_validated=$false; temporary_disabled_registration=$false; unregister_verified=$false; ownership_rejection=$false }
try {
    & (Join-Path $PSScriptRoot 'task-plan.ps1') -Config $configPath -TaskName $name -Action Preview -TechnicalDisabled | Out-Null
    $xmlPath = Join-Path $testRoot 'task-definition.preview.xml'
    $xml = [xml](Get-Content -LiteralPath $xmlPath -Raw -Encoding UTF8)
    if ($xml.Task.Settings.Enabled -ne 'false' -or $xml.Task.Settings.MultipleInstancesPolicy -ne 'IgnoreNew' -or
        $xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or $xml.Task.Settings.WakeToRun -ne 'false' -or
        $xml.Task.Settings.ExecutionTimeLimit -ne 'PT0S') { throw 'Unexpected temporary task definition.' }
    $result.preview_validated = $true
    $result.xml = $xmlPath
    try {
        & (Join-Path $PSScriptRoot 'task-plan.ps1') -Config $configPath -TaskName $name -Action Install -TechnicalDisabled | Out-Null
        $installed = $true
        $saved = Get-ScheduledTask -TaskName $name
        if ($saved.Settings.Enabled -ne $false) { throw 'Temporary task unexpectedly enabled.' }
        $result.temporary_disabled_registration = $true
        $otherConfig = Join-Path $testRoot 'not-owner.json'
        [IO.File]::WriteAllText($otherConfig, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        foreach ($operation in @('Install','Stop','Disable','Uninstall','Enable','Start')) {
            $rejected = $false
            try {
                & (Join-Path $PSScriptRoot 'task-plan.ps1') -Config $otherConfig -TaskName $name -Action $operation -TechnicalDisabled | Out-Null
            } catch {
                if ($_.Exception.Message -notlike '*not owned*') { throw }
                $rejected = $true
            }
            if (-not $rejected) { throw 'Mismatched task config was not rejected.' }
        }
        $result.ownership_rejection = $true
        & (Join-Path $PSScriptRoot 'task-plan.ps1') -Config $configPath -TaskName $name -Action Uninstall -TechnicalDisabled | Out-Null
        $installed = $false
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Temporary task remains registered.' }
        $result.unregister_verified = $true
    } catch {
        $result.registration_error = $_.Exception.Message
    }
} finally {
    if ($installed) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
    $result.passed = $result.preview_validated -and $result.temporary_disabled_registration -and $result.unregister_verified -and $result.ownership_rejection
    [IO.File]::WriteAllText((Join-Path $reportRoot 'task-plan-verification.json'), ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
$result | ConvertTo-Json -Depth 8
