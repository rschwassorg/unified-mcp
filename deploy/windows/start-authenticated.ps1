[CmdletBinding()]
param(
  [int] $BridgePort = 18767,
  [int] $ApiPort = 18768
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\server")).Path
$secretRoot = Join-Path $env:LOCALAPPDATA "UnifiedMcp\secrets"
$pskPath = Join-Path $secretRoot "psk.txt"

& (Join-Path $PSScriptRoot "ensure-user-psk.ps1")

$env:CHROME_BIND_HOST = "127.0.0.1"
$env:CHROME_MCP_PORT = [string]$BridgePort
$env:CHROME_API_PORT = [string]$ApiPort
$env:UNIFIED_MCP_PSK_FILE = $pskPath
$env:UNIFIED_MCP_KEEP_ALIVE = "1"
$env:UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH = "true"
Remove-Item Env:UNIFIED_MCP_ALLOW_NO_AUTH -ErrorAction SilentlyContinue
Remove-Item Env:UNIFIED_MCP_PSK -ErrorAction SilentlyContinue

& node (Join-Path $serverRoot "dist\index.js")
