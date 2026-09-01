[CmdletBinding()]
param(
  [string] $ConfigPath = (Join-Path $env:USERPROFILE ".cloudflared\unified-mcp.yml"),
  [string] $TunnelName = "unified-mcp"
)

$ErrorActionPreference = "Stop"
$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if ($cloudflared) {
  $cloudflaredPath = $cloudflared.Source
} else {
  $cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}

if (-not (Test-Path -LiteralPath $cloudflaredPath)) { throw "cloudflared.exe was not found" }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Cloudflare tunnel config was not found: $ConfigPath" }

& $cloudflaredPath --config $ConfigPath tunnel run $TunnelName
