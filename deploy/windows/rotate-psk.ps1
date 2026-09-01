$ErrorActionPreference = "Stop"
$pskPath = Join-Path $env:ProgramData "UnifiedMcp\secrets\psk.txt"
$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
$generator.Dispose()
$psk = [Convert]::ToBase64String($bytes)
[IO.File]::WriteAllText($pskPath, $psk, [Text.Encoding]::ASCII)
[Environment]::SetEnvironmentVariable("UNIFIED_MCP_PSK", $psk, "User")
$env:UNIFIED_MCP_PSK = $psk
$wrapper = Join-Path $env:ProgramData "UnifiedMcp\UnifiedMcpBackend.exe"
& $wrapper restart
if ($LASTEXITCODE -ne 0) { throw "Backend restart failed" }
Remove-Variable psk,bytes -ErrorAction SilentlyContinue
Write-Host "Unified MCP PSK rotated and backend restarted. The value was not printed."
