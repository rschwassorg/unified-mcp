$ErrorActionPreference = "Stop"
$serviceRoot = Join-Path $env:ProgramData "UnifiedMcp"
foreach ($name in "UnifiedMcpNginx","UnifiedMcpBackend") {
  $exe = Join-Path $serviceRoot ($name + ".exe")
  if (Test-Path -LiteralPath $exe) { & $exe stop; & $exe uninstall }
}
Write-Host "Services removed. Certificates, PSK, configs, and logs remain in $serviceRoot."
