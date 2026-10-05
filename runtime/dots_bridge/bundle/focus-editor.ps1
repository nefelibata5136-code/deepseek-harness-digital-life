param([int]$TargetPid,[long]$TargetWindow,[string]$EditorLabel)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SlackFocusOwner {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$owner=[uint32]0
[void][SlackFocusOwner]::GetWindowThreadProcessId([IntPtr]$TargetWindow,[ref]$owner)
if ($owner -ne $TargetPid -or (Get-Process -Id $TargetPid).ProcessName -ne 'chrome') {throw 'SLACK_UI_EXACT_WINDOW_REQUIRED'}
if ([string]::IsNullOrWhiteSpace($EditorLabel) -or $EditorLabel.Length -gt 120 -or $EditorLabel -match '[\r\n]') {throw 'SLACK_UI_EDITOR_LABEL_REQUIRED'}
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$TargetWindow)
if ($root.Current.Name -notmatch 'Slack') {throw 'SLACK_UI_EXACT_WINDOW_REQUIRED'}
$condition=New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)),(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$EditorLabel)))
$matches=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
if ($matches.Count -ne 1) {throw 'SLACK_UI_EXACT_EDITOR_REQUIRED'}
$matches[0].SetFocus()
$focused=[System.Windows.Automation.AutomationElement]::FocusedElement
$confirmed=[string]::Join(',', $focused.GetRuntimeId()) -eq [string]::Join(',', $matches[0].GetRuntimeId())
if (!$confirmed) {throw 'SLACK_UI_EDITOR_FOCUS_UNCONFIRMED'}
[pscustomobject]@{confirmed=$true;editor_label=$EditorLabel} | ConvertTo-Json -Compress
