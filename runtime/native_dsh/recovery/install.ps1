param([ValidateSet('Preview','Install','Start','Status','Stop')][string]$Action='Preview')
$ErrorActionPreference='Stop'
$name='Persona-Independent-Recovery'
$runner=Join-Path $PSScriptRoot 'run-standby.ps1'
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$runner+'"'
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($existing -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Arguments -ne $arguments)) { throw 'Existing task is not owned by this exact recovery entry' }
if($Action -eq 'Preview') { [pscustomobject]@{TaskName=$name;Runner=$runner;Independent=$true;AtLogon=$true;Hidden=$true};exit }
if($Action -eq 'Status') { $existing | Select-Object TaskName,State;exit }
if($Action -eq 'Stop') { if($existing){Stop-ScheduledTask -TaskName $name};exit }
if($Action -eq 'Install') {
  $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Settings $settings -Description 'Independent Persona recovery watchdog; minimal native Agent, preserve history and budget' -Force | Select-Object TaskName,State
}
if($Action -eq 'Start') { Start-ScheduledTask -TaskName $name;Get-ScheduledTask -TaskName $name | Select-Object TaskName,State }
