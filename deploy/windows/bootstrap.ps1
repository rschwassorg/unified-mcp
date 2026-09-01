[CmdletBinding()]
param([string] $PublicHost = "localhost")

$ErrorActionPreference = "Stop"
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this bootstrap from an elevated PowerShell prompt."
}

$toolRoot = Join-Path $env:ProgramData "UnifiedMcp\tools"
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null

$existingNginx = Get-ChildItem -LiteralPath (Join-Path $toolRoot "nginx") -Filter nginx.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existingNginx) {
  winget install --id nginxinc.nginx --exact --silent --accept-package-agreements --accept-source-agreements --scope machine --location (Join-Path $toolRoot "nginx")
  if ($LASTEXITCODE -ne 0) { throw "nginx installation failed with exit code $LASTEXITCODE" }
}
$existingWinSW = Get-ChildItem -LiteralPath (Join-Path $toolRoot "winsw") -Filter "*WinSW*.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existingWinSW) {
  winget install --id CloudBees.WindowsServiceWrapper --exact --silent --accept-package-agreements --accept-source-agreements --scope machine --location (Join-Path $toolRoot "winsw")
  if ($LASTEXITCODE -ne 0) { throw "WinSW installation failed with exit code $LASTEXITCODE" }
}
$nginxExe = Get-ChildItem -LiteralPath (Join-Path $toolRoot "nginx") -Filter nginx.exe -File -Recurse | Select-Object -First 1
$winswExe = Get-ChildItem -LiteralPath (Join-Path $toolRoot "winsw") -Filter "*WinSW*.exe" -File -Recurse | Select-Object -First 1
$opensslExe = @(
  "$env:ProgramFiles\OpenSSL-Win64\bin\openssl.exe",
  "$env:ProgramFiles\OpenSSL\bin\openssl.exe",
  "$env:ProgramFiles\Git\usr\bin\openssl.exe",
  "$env:ProgramFiles\Git\mingw64\bin\openssl.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nginxExe) { throw "winget installed nginx but nginx.exe was not found under $toolRoot\nginx" }
if (-not $winswExe) { throw "winget installed WinSW but its executable was not found under $toolRoot\winsw" }
if (-not $opensslExe) { throw "OpenSSL was not found. Install it or Git for Windows, then rerun." }

& (Join-Path $PSScriptRoot "install.ps1") -NginxRoot $nginxExe.Directory.FullName -WinSWExe $winswExe.FullName -OpenSslExe $opensslExe -PublicHost $PublicHost
if ($LASTEXITCODE -ne 0) { throw "Unified MCP service installation failed" }

$certificate = Join-Path $env:ProgramData "UnifiedMcp\certs\unified-mcp.crt"
Import-Certificate -FilePath $certificate -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null

$health = Invoke-RestMethod -Uri "https://localhost:9443/health"
if ($null -eq $health.connected) { throw "Unified MCP health response was invalid" }
Write-Host "Unified MCP is installed, trusted locally, and healthy."
Write-Host "Windows Firewall was not changed."
