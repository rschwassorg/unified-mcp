[CmdletBinding()]
param(
  [switch] $CopyToClipboard
)

$ErrorActionPreference = "Stop"
$secretRoot = Join-Path $env:LOCALAPPDATA "UnifiedMcp\secrets"
$pskPath = Join-Path $secretRoot "psk.txt"

if (-not (Test-Path -LiteralPath $secretRoot)) {
  New-Item -ItemType Directory -Path $secretRoot | Out-Null
}

if (-not (Test-Path -LiteralPath $pskPath)) {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    $psk = [Convert]::ToBase64String($bytes)
    [IO.File]::WriteAllText($pskPath, $psk, [Text.Encoding]::ASCII)
  }
  finally {
    $generator.Dispose()
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    Remove-Variable psk,bytes -ErrorAction SilentlyContinue
  }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $secretRoot /inheritance:r /grant:r "$identity`:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict the Unified MCP secret directory permissions" }

if ($CopyToClipboard) {
  $psk = [IO.File]::ReadAllText($pskPath, [Text.Encoding]::ASCII).Trim()
  Set-Clipboard -Value $psk
  Remove-Variable psk -ErrorAction SilentlyContinue
}

Write-Host "Unified MCP user PSK is ready. The value was not printed."
