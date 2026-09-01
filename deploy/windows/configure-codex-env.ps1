$ErrorActionPreference = "Stop"
$pskPath = Join-Path $env:ProgramData "UnifiedMcp\secrets\psk.txt"
$certificatePath = Join-Path $env:ProgramData "UnifiedMcp\certs\unified-mcp.crt"
$psk = [IO.File]::ReadAllText($pskPath).Trim()
if (-not $psk) { throw "Unified MCP PSK file is empty" }

[Environment]::SetEnvironmentVariable("UNIFIED_MCP_PSK", $psk, "User")
[Environment]::SetEnvironmentVariable("VIBETERM_API_TOKEN", $psk, "User")
$wslEnv = [Environment]::GetEnvironmentVariable("WSLENV", "User")
$entries = @($wslEnv -split ':' | Where-Object { $_ })
if ($entries -notcontains "UNIFIED_MCP_PSK") { $entries += "UNIFIED_MCP_PSK" }
[Environment]::SetEnvironmentVariable("WSLENV", ($entries -join ':'), "User")

Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null

$wslRouteScript = 'gateway="$(ip route show default | awk ''NR == 1 { print $3 }'')"; [ -n "$gateway" ] || exit 1; sed -i "/[[:space:]]$1\([[:space:]]\|$\)/d" /etc/hosts; printf "%s\t%s\n" "$gateway" "$1" >> /etc/hosts'
& wsl.exe --user root --exec /bin/sh -c $wslRouteScript unified-mcp-route unified-mcp.local
if ($LASTEXITCODE -ne 0) { throw "Failed to configure the unified-mcp.local WSL host route" }
& wsl.exe --user root --exec /usr/bin/install -m 0644 /mnt/c/ProgramData/UnifiedMcp/certs/unified-mcp.crt /usr/local/share/ca-certificates/unified-mcp.crt
if ($LASTEXITCODE -ne 0) { throw "Failed to install the Unified MCP certificate in WSL" }
& wsl.exe --user root --exec /usr/sbin/update-ca-certificates
if ($LASTEXITCODE -ne 0) { throw "Failed to refresh WSL certificate trust" }

Restart-Service -Name UnifiedMcpNginx
Write-Host "Codex, VibeTerm, WSL routing, and certificate trust are configured for the Unified MCP gateway."
Write-Host "Restart Codex and WSL terminals to inherit the new environment variable."
