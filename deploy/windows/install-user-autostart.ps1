[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$serverScript = (Resolve-Path (Join-Path $PSScriptRoot "start-authenticated.ps1")).Path
$tunnelScript = (Resolve-Path (Join-Path $PSScriptRoot "start-cloudflare-tunnel.ps1")).Path
$powerShell = (Get-Command powershell.exe).Source

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

function Register-UserTask([string] $TaskName, [string] $ScriptPath, [string] $Description) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $Description
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

Register-UserTask `
  -TaskName "Unified MCP Server" `
  -ScriptPath $serverScript `
  -Description "Starts the authenticated loopback Unified MCP server and Chrome bridge at user logon."

Register-UserTask `
  -TaskName "Unified MCP Cloudflare Tunnel" `
  -ScriptPath $tunnelScript `
  -Description "Starts the Unified MCP named Cloudflare Tunnel at user logon."

Write-Host "Unified MCP server and tunnel autostart tasks are installed for the current user."
