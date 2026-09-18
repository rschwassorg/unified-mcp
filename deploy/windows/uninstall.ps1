$ErrorActionPreference = "Stop"
$serviceRoot = Join-Path $env:ProgramData "UnifiedMcp"

foreach ($name in "UnifiedMcpNginx","UnifiedMcpBackend") {
  $exe = Join-Path $serviceRoot ($name + ".exe")
  if (Test-Path -LiteralPath $exe) {
    & $exe stop 2>$null
    & $exe uninstall 2>$null
  }
}

Write-Host "Unified MCP services removed. Configuration and logs remain in $serviceRoot."
Write-Host "Legacy nginx/certificate/PSK files, if present from an older install, are no longer used."
