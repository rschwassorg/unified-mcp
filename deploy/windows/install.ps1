[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $NginxRoot,
  [Parameter(Mandatory)] [string] $WinSWExe,
  [string] $NodeExe = (Get-Command node -ErrorAction Stop).Source,
  [string] $OpenSslExe = (Get-Command openssl -ErrorAction Stop).Source,
  [string] $PublicHost = "localhost",
  [switch] $AllowNoAuth
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nginxRootPath = (Resolve-Path $NginxRoot).Path
$winswPath = (Resolve-Path $WinSWExe).Path
$nodePath = (Resolve-Path $NodeExe).Path
$opensslPath = (Resolve-Path $OpenSslExe).Path
$serviceRoot = Join-Path $env:ProgramData "UnifiedMcp"
$secretRoot = Join-Path $serviceRoot "secrets"
$certRoot = Join-Path $serviceRoot "certs"
$logRoot = Join-Path $serviceRoot "logs"
$filesystemConfigPath = Join-Path $serviceRoot "filesystem-roots.json"

New-Item -ItemType Directory -Force -Path $serviceRoot,$secretRoot,$certRoot,$logRoot | Out-Null
if (-not (Test-Path -LiteralPath $filesystemConfigPath)) {
  $defaultCodeRoot = Join-Path $env:USERPROFILE "code"
  $filesystemConfig = @{ roots = @{ code = @{ path = $defaultCodeRoot; readOnly = $false } } } | ConvertTo-Json -Depth 5
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($filesystemConfigPath, $filesystemConfig, $utf8NoBom)
}
npm --prefix (Join-Path $projectRoot "server") ci
npm --prefix (Join-Path $projectRoot "server") run build

Write-Host "Phase: PSK storage"
$pskPath = Join-Path $secretRoot "psk.txt"
if (-not (Test-Path -LiteralPath $pskPath)) {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  $generator.GetBytes($bytes)
  $generator.Dispose()
  [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $pskPath -NoNewline -Encoding ascii
}
$certPath = Join-Path $certRoot "unified-mcp.crt"
$keyPath = Join-Path $certRoot "unified-mcp.key"
Write-Host "Phase: TLS certificate"
if (-not (Test-Path -LiteralPath $certPath) -or -not (Test-Path -LiteralPath $keyPath)) {
  & $opensslPath req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes -keyout $keyPath -out $certPath -subj "/CN=$PublicHost" -addext "subjectAltName=DNS:$PublicHost,DNS:localhost,IP:127.0.0.1"
  if ($LASTEXITCODE -ne 0) { throw "OpenSSL certificate generation failed" }
}

$nginxTemplate = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "deploy\nginx\unified-mcp.conf.template")
Write-Host "Phase: nginx configuration"
$nginxConfig = $nginxTemplate.Replace("__CERTIFICATE__", $certPath.Replace("\", "/")).Replace("__PRIVATE_KEY__", $keyPath.Replace("\", "/"))
$nginxConfigPath = Join-Path $nginxRootPath "conf\unified-mcp.conf"
Set-Content -LiteralPath $nginxConfigPath -Value $nginxConfig -Encoding ascii

$escapedProject = [Security.SecurityElement]::Escape($projectRoot)
$escapedNode = [Security.SecurityElement]::Escape($nodePath)
$escapedPsk = [Security.SecurityElement]::Escape($pskPath)
$escapedFilesystemConfig = [Security.SecurityElement]::Escape($filesystemConfigPath)
$escapedNginx = [Security.SecurityElement]::Escape((Join-Path $nginxRootPath "nginx.exe"))
$nginxPrefix = $nginxRootPath.Replace("\", "/") + "/"
$noAuthEnvironment = if ($AllowNoAuth) { '<env name="UNIFIED_MCP_ALLOW_NO_AUTH" value="true"/>' } else { '' }
$backendXml = @"
<service><id>UnifiedMcpBackend</id><name>Unified MCP Backend</name><description>Unified MCP and multi-client Chrome CDP backend.</description><executable>$escapedNode</executable><arguments>&quot;$escapedProject\server\dist\index.js&quot;</arguments><workingdirectory>$escapedProject\server</workingdirectory><env name="CHROME_BIND_HOST" value="127.0.0.1"/><env name="UNIFIED_MCP_PSK_FILE" value="$escapedPsk"/><env name="UNIFIED_MCP_FS_CONFIG" value="$escapedFilesystemConfig"/>$noAuthEnvironment<env name="UNIFIED_MCP_KEEP_ALIVE" value="1"/><logpath>$logRoot</logpath><log mode="roll"/><startmode>Automatic</startmode><onfailure action="restart" delay="5 sec"/></service>
"@
$nginxXml = @"
<service><id>UnifiedMcpNginx</id><name>Unified MCP nginx</name><description>TLS reverse proxy for Unified MCP.</description><executable>$escapedNginx</executable><arguments>-p &quot;$nginxPrefix&quot; -c conf/unified-mcp.conf</arguments><stopexecutable>$escapedNginx</stopexecutable><stoparguments>-p &quot;$nginxPrefix&quot; -s stop</stoparguments><workingdirectory>$nginxRootPath</workingdirectory><logpath>$logRoot</logpath><log mode="roll"/><startmode>Automatic</startmode><depend>UnifiedMcpBackend</depend><onfailure action="restart" delay="5 sec"/></service>
"@

Write-Host "Phase: Windows services"
foreach ($service in @(@{Name="UnifiedMcpBackend"; Xml=$backendXml}, @{Name="UnifiedMcpNginx"; Xml=$nginxXml})) {
  $exe = Join-Path $serviceRoot ($service.Name + ".exe")
  $xml = Join-Path $serviceRoot ($service.Name + ".xml")
  Copy-Item -Force -LiteralPath $winswPath -Destination $exe
  Set-Content -LiteralPath $xml -Value $service.Xml -Encoding utf8
  & $exe stop 2>$null
  & $exe uninstall 2>$null
  & $exe install
  & $exe start
}

Write-Host "Phase: ACL hardening"
& icacls.exe $secretRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict PSK directory permissions" }

Write-Host "Unified MCP installed at https://$PublicHost`:9443/mcp"
Write-Host "Import $certPath into Trusted Root Certification Authorities on each browser machine."
Write-Host "Filesystem roots are configured in $filesystemConfigPath."
if ($AllowNoAuth) {
  Write-Warning "Authentication is disabled. Keep port 9443 restricted to this machine."
} else {
  Write-Host "The PSK is stored at $pskPath and was intentionally not printed."
}
