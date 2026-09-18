[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $WinSWExe,
  [string] $NodeExe = (Get-Command node -ErrorAction Stop).Source,
  [string] $BindHost = "127.0.0.1",
  [int] $Port = 18766,
  [string] $CloudflareAccessTeamDomain = "",
  [string] $CloudflareAccessAudience = "",
  [switch] $AllowNoAuth
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$winswPath = (Resolve-Path $WinSWExe).Path
$nodePath = (Resolve-Path $NodeExe).Path
$serviceRoot = Join-Path $env:ProgramData "UnifiedMcp"
$logRoot = Join-Path $serviceRoot "logs"
$filesystemConfigPath = Join-Path $serviceRoot "filesystem-roots.json"

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Port must be between 1 and 65535"
}

New-Item -ItemType Directory -Force -Path $serviceRoot,$logRoot | Out-Null
if (-not (Test-Path -LiteralPath $filesystemConfigPath)) {
  $defaultCodeRoot = Join-Path $env:USERPROFILE "code"
  $filesystemConfig = @{ roots = @{ code = @{ path = $defaultCodeRoot; readOnly = $false } } } | ConvertTo-Json -Depth 5
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($filesystemConfigPath, $filesystemConfig, $utf8NoBom)
}

Write-Host "Phase: build"
npm --prefix (Join-Path $projectRoot "server") ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm --prefix (Join-Path $projectRoot "server") run build
if ($LASTEXITCODE -ne 0) { throw "npm build failed" }

$accessEnvironment = ""
if ($CloudflareAccessTeamDomain -or $CloudflareAccessAudience) {
  if (-not $CloudflareAccessTeamDomain -or -not $CloudflareAccessAudience) {
    throw "CloudflareAccessTeamDomain and CloudflareAccessAudience must be configured together"
  }
  $normalizedAccessTeam = $CloudflareAccessTeamDomain.TrimEnd("/")
  if ($normalizedAccessTeam -notmatch '^https://[^/]+\.cloudflareaccess\.com$') {
    throw "CloudflareAccessTeamDomain must be an https://*.cloudflareaccess.com origin"
  }
  $escapedAccessTeam = [Security.SecurityElement]::Escape($normalizedAccessTeam)
  $escapedAccessAud = [Security.SecurityElement]::Escape($CloudflareAccessAudience)
  $accessEnvironment = '<env name="UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN" value="' + $escapedAccessTeam + '"/><env name="UNIFIED_MCP_CF_ACCESS_AUD" value="' + $escapedAccessAud + '"/>'
}
elseif (-not $AllowNoAuth) {
  throw "Cloudflare Access is required unless -AllowNoAuth is explicitly specified"
}

$escapedProject = [Security.SecurityElement]::Escape($projectRoot)
$escapedNode = [Security.SecurityElement]::Escape($nodePath)
$escapedFilesystemConfig = [Security.SecurityElement]::Escape($filesystemConfigPath)
$escapedBindHost = [Security.SecurityElement]::Escape($BindHost)
$noAuthEnvironment = if ($AllowNoAuth) { '<env name="UNIFIED_MCP_ALLOW_NO_AUTH" value="true"/>' } else { '' }

$backendXml = @"
<service><id>UnifiedMcpBackend</id><name>Unified MCP Backend</name><description>Unified MCP HTTP and WebSocket backend for Cloudflare Tunnel.</description><executable>$escapedNode</executable><arguments>&quot;$escapedProject\server\dist\index.js&quot;</arguments><workingdirectory>$escapedProject\server</workingdirectory><env name="UNIFIED_MCP_BIND_HOST" value="$escapedBindHost"/><env name="UNIFIED_MCP_PORT" value="$Port"/><env name="UNIFIED_MCP_FS_CONFIG" value="$escapedFilesystemConfig"/>$accessEnvironment$noAuthEnvironment<env name="UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH" value="true"/><env name="UNIFIED_MCP_KEEP_ALIVE" value="1"/><logpath>$logRoot</logpath><log mode="roll"/><startmode>Automatic</startmode><onfailure action="restart" delay="5 sec"/></service>
"@

Write-Host "Phase: remove legacy nginx service"
$legacyNginxExe = Join-Path $serviceRoot "UnifiedMcpNginx.exe"
if (Test-Path -LiteralPath $legacyNginxExe) {
  & $legacyNginxExe stop 2>$null
  & $legacyNginxExe uninstall 2>$null
}

Write-Host "Phase: Windows service"
$backendExe = Join-Path $serviceRoot "UnifiedMcpBackend.exe"
$backendXmlPath = Join-Path $serviceRoot "UnifiedMcpBackend.xml"
Copy-Item -Force -LiteralPath $winswPath -Destination $backendExe
Set-Content -LiteralPath $backendXmlPath -Value $backendXml -Encoding utf8
& $backendExe stop 2>$null
& $backendExe uninstall 2>$null
& $backendExe install
if ($LASTEXITCODE -ne 0) { throw "Failed to install UnifiedMcpBackend" }
& $backendExe start
if ($LASTEXITCODE -ne 0) { throw "Failed to start UnifiedMcpBackend" }

Write-Host "Unified MCP is listening on http://$($BindHost):$Port"
Write-Host "HTTP MCP endpoint: http://$($BindHost):$Port/mcp"
Write-Host "WebSocket bridge: ws://$($BindHost):$Port/bridge"
Write-Host "Filesystem roots: $filesystemConfigPath"
if ($AllowNoAuth) {
  Write-Warning "Authentication is disabled. Do not expose this listener outside a trusted local environment."
} else {
  Write-Host "Authentication: Cloudflare Access JWT validation for HTTP and WebSocket upgrades"
  Write-Host "Cloudflare Access team: $($CloudflareAccessTeamDomain.TrimEnd('/'))"
  Write-Host "Publish this single origin through Cloudflare Tunnel: http://127.0.0.1:$Port"
}
Write-Host "TLS is intentionally not configured locally; Cloudflare terminates public HTTPS/WSS."
