param(
    [Parameter(Mandatory=$true)][string]$Config,
    [ValidateSet('Preview','Install','Uninstall','Disable','Enable','Start','Stop','Status','Log')][string]$Action = 'Preview',
    [string]$TaskName = 'Persona-Official-Harness',
    [switch]$TechnicalDisabled
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$supervisor = Join-Path $PSScriptRoot 'supervisor.mjs'
$control = Join-Path $PSScriptRoot 'control.mjs'
if ($TechnicalDisabled -and (-not $settings.technicalTest -or -not $TaskName.StartsWith('Persona-C-Test-'))) {
    throw 'Disabled technical registration requires a dedicated C test config and task name.'
}
if ($Action -eq 'Install' -and -not $TechnicalDisabled -and $settings.integrated -ne $true) {
    throw 'A must complete formal Host integration before production task registration.'
}
if ($Action -eq 'Log') {
    Get-Content -LiteralPath (Join-Path $settings.stateDir 'supervisor.jsonl') -Tail 40
    exit 0
}
if ($Action -eq 'Status') {
    & $nodePath $control $configPath status
    if ($LASTEXITCODE -ne 0) { throw 'Status check failed.' }
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object TaskName, State
    exit 0
}
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
function Assert-OwnedTask($registered) {
    $actions = $registered.Definition.Actions
    $entryPath = Join-Path $PSScriptRoot 'run-supervisor.ps1'
    if ($actions.Count -ne 1 -or $actions.Item(1).Type -ne 0 -or
        $actions.Item(1).Arguments.IndexOf('"' + $entryPath + '"', [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $actions.Item(1).Arguments.IndexOf('"' + $configPath + '"', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Refusing to modify a task not owned by this launcher and exact config.'
    }
}
if ($Action -in @('Stop','Disable','Uninstall')) {
    try { $registered = $folder.GetTask($TaskName) } catch { $registered = $null }
    if ($registered) { Assert-OwnedTask $registered }
    & $nodePath $control $configPath $(if ($Action -eq 'Stop') { 'stop' } else { 'disable' })
    if ($LASTEXITCODE -ne 0) { throw 'Host control failed; do not hide a shutdown failure.' }
    if ($registered) {
        if ($Action -ne 'Stop') { $registered.Enabled = $false }
        if ($Action -eq 'Uninstall') { $folder.DeleteTask($TaskName, 0) }
    }
    exit 0
}
if ($Action -eq 'Enable') {
    $registered = $folder.GetTask($TaskName)
    Assert-OwnedTask $registered
    & $nodePath $control $configPath enable
    if ($LASTEXITCODE -ne 0) { throw 'Host enable failed.' }
    $registered.Enabled = $true
    Write-Output 'Enabled; Host was not started.'
    exit 0
}
if ($Action -eq 'Start') {
    $registered = $folder.GetTask($TaskName)
    Assert-OwnedTask $registered
    $registered.Run($null) | Out-Null
    exit 0
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'Official Persona Harness supervisor; logon-only, normal stops stay stopped.'
$definition.Principal.UserId = $identity.User.Value
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Enabled = -not $TechnicalDisabled
$definition.Settings.MultipleInstances = 2
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.RunOnlyIfIdle = $false
$definition.Settings.WakeToRun = $false
$definition.Settings.RestartInterval = 'PT1M'
$definition.Settings.RestartCount = 3
$definition.Settings.Hidden = $true
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $identity.User.Value
$trigger.Delay = 'PT30S'
$trigger.Enabled = -not $TechnicalDisabled
$entry = $definition.Actions.Create(0)
$entry.Path = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$entry.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    (Join-Path $PSScriptRoot 'run-supervisor.ps1') + '" -Config "' + $configPath + '"'
$entry.WorkingDirectory = $PSScriptRoot
$xml = [xml]$definition.XmlText
if ($xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or
    $xml.Task.Settings.MultipleInstancesPolicy -ne 'IgnoreNew') { throw 'Unexpected task semantics.' }
if ($Action -eq 'Preview') {
    $output = Join-Path $settings.stateDir 'task-definition.preview.xml'
    [IO.Directory]::CreateDirectory($settings.stateDir) | Out-Null
    [IO.File]::WriteAllText($output, $definition.XmlText, [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{ action='preview'; registered=$false; xml=$output; taskName=$TaskName;
      logonType='InteractiveToken'; starts='Current user logon + 30 seconds'; wakeComputer=$false } | ConvertTo-Json
} else {
    try { $existing = $folder.GetTask($TaskName) } catch { $existing = $null }
    if ($existing) { Assert-OwnedTask $existing }
    $folder.RegisterTaskDefinition($TaskName, $definition, 38, $identity.User.Value, $null, 3, $null) | Out-Null
    $saved = $folder.GetTask($TaskName)
    [pscustomobject]@{ action='installed'; taskName=$TaskName; enabled=$saved.Enabled; xml=$saved.Xml } | ConvertTo-Json
}
