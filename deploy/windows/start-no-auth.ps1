[CmdletBinding()]
param(
  [int] $BridgePort = 18767,
  [int] $ApiPort = 18768
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\server")).Path
$env:CHROME_BIND_HOST = "127.0.0.1"
$env:CHROME_MCP_PORT = [string]$BridgePort
$env:CHROME_API_PORT = [string]$ApiPort
$env:UNIFIED_MCP_ALLOW_NO_AUTH = "true"
$env:UNIFIED_MCP_KEEP_ALIVE = "1"

& node (Join-Path $serverRoot "dist\index.js")
