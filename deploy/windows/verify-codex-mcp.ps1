$present = [bool]$env:UNIFIED_MCP_PSK
$headers = @{ Authorization = "Bearer $env:UNIFIED_MCP_PSK" }
$body = @{
  jsonrpc = "2.0"
  id = 1
  method = "initialize"
  params = @{ protocolVersion = "2025-03-26"; capabilities = @{}; clientInfo = @{ name = "config-check"; version = "1" } }
} | ConvertTo-Json -Depth 6
try {
  $response = Invoke-RestMethod -Method Post -Uri "https://localhost:9443/mcp" -Headers $headers -ContentType "application/json" -Body $body
  [pscustomobject]@{ TokenPresent = $present; McpInitialized = ($response.result.serverInfo.name -eq "chrome_mcp") }
} catch {
  [pscustomobject]@{ TokenPresent = $present; McpInitialized = $false; Status = $_.Exception.Message }
}
