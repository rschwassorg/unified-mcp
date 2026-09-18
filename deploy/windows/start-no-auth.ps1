[CmdletBinding()]
param(
  [int] $Port = 18768
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\server")).Path
$env:UNIFIED_MCP_BIND_HOST = "127.0.0.1"
$env:UNIFIED_MCP_PORT = [string]$Port
$env:UNIFIED_MCP_ALLOW_NO_AUTH = "true"
$env:UNIFIED_MCP_KEEP_ALIVE = "1"

& node (Join-Path $serverRoot "dist\index.js")
