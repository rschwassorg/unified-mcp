[CmdletBinding()]
param(
  [string] $McpUrl = "https://unified-mcp.pentestsystem.com/mcp"
)

$ErrorActionPreference = "Stop"
[Environment]::SetEnvironmentVariable("UNIFIED_MCP_URL", $McpUrl, "User")

Write-Host "UNIFIED_MCP_URL is configured for the Cloudflare-published endpoint:"
Write-Host $McpUrl
Write-Host "No PSK or local TLS certificate is configured. Use Cloudflare Access Managed OAuth in compatible MCP clients."
Write-Host "Restart terminals and clients to inherit the new environment variable."
