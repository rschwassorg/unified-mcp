[CmdletBinding()]
param(
  [string] $McpUrl = "http://127.0.0.1:18766/mcp"
)

$ErrorActionPreference = "Stop"
[Environment]::SetEnvironmentVariable("UNIFIED_MCP_URL", $McpUrl, "User")
Write-Host "UNIFIED_MCP_URL is configured:"
Write-Host $McpUrl
Write-Host "Restart terminals and clients to inherit the new environment variable."
