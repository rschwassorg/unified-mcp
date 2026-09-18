[CmdletBinding()]
param(
  [int] $Port = 18766,
  [string] $CloudflareAccessTeamDomain = $env:UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN,
  [string] $CloudflareAccessAudience = $env:UNIFIED_MCP_CF_ACCESS_AUD
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\server")).Path

if (-not $CloudflareAccessTeamDomain -or -not $CloudflareAccessAudience) {
  throw "CloudflareAccessTeamDomain and CloudflareAccessAudience are required"
}

$env:UNIFIED_MCP_BIND_HOST = "127.0.0.1"
$env:UNIFIED_MCP_PORT = [string]$Port
$env:UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN = $CloudflareAccessTeamDomain.TrimEnd("/")
$env:UNIFIED_MCP_CF_ACCESS_AUD = $CloudflareAccessAudience
$env:UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH = "true"
$env:UNIFIED_MCP_KEEP_ALIVE = "1"
Remove-Item Env:UNIFIED_MCP_ALLOW_NO_AUTH -ErrorAction SilentlyContinue
Remove-Item Env:UNIFIED_MCP_PSK -ErrorAction SilentlyContinue
Remove-Item Env:UNIFIED_MCP_PSK_FILE -ErrorAction SilentlyContinue

& node (Join-Path $serverRoot "dist\index.js")
