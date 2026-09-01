$fileValue = [IO.File]::ReadAllText((Join-Path $env:ProgramData "UnifiedMcp\secrets\psk.txt")).Trim()
$userValue = [Environment]::GetEnvironmentVariable("UNIFIED_MCP_PSK", "User")
$sha = [Security.Cryptography.SHA256]::Create()
$fileHash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fileValue))
$userHash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($userValue))
$sha.Dispose()
[pscustomobject]@{ ValuesMatch = ([Convert]::ToBase64String($fileHash) -eq [Convert]::ToBase64String($userHash)); FilePresent = [bool]$fileValue; UserEnvironmentPresent = [bool]$userValue } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:ProgramData "UnifiedMcp\psk-sync-check.txt") -Encoding ascii
