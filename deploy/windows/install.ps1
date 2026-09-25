[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $WinSWExe,
  [string] $NodeExe = (Get-Command node -ErrorAction Stop).Source,
  [string] $BindHost = "127.0.0.1",
  [int] $Port = 18766,
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

function Stop-And-UninstallWinSwService {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [string] $WrapperExe
  )

  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne "Stopped") {
    Write-Host "Stopping service '$Name'..."
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    try {
      (Get-Service -Name $Name -ErrorAction Stop).WaitForStatus(
        [System.ServiceProcess.ServiceControllerStatus]::Stopped,
        [TimeSpan]::FromSeconds(15)
      )
    }
    catch {
      Write-Warning "Service '$Name' did not report Stopped immediately; continuing with WinSW cleanup."
    }
  }

  if (Test-Path -LiteralPath $WrapperExe) {
    try {
      & $WrapperExe uninstall 2>$null
    }
    catch {
      Write-Warning "WinSW uninstall for '$Name' returned an error: $($_.Exception.Message)"
    }
  }

  # WinSW can return from stop/uninstall before the wrapper process releases its
  # executable. Wait for the file lock to clear before overwriting the wrapper.
  if (Test-Path -LiteralPath $WrapperExe) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      try {
        $stream = [IO.File]::Open(
          $WrapperExe,
          [IO.FileMode]::Open,
          [IO.FileAccess]::ReadWrite,
          [IO.FileShare]::None
        )
        $stream.Dispose()
        return
      }
      catch {
        Start-Sleep -Milliseconds 250
      }
    }
    throw "Timed out waiting for service wrapper to be released: $WrapperExe"
  }
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


$escapedProject = [Security.SecurityElement]::Escape($projectRoot)
$escapedNode = [Security.SecurityElement]::Escape($nodePath)
$escapedFilesystemConfig = [Security.SecurityElement]::Escape($filesystemConfigPath)
$escapedBindHost = [Security.SecurityElement]::Escape($BindHost)
$noAuthEnvironment = if ($AllowNoAuth) {
  Write-Warning "Authentication is disabled. Do not expose this listener outside a trusted local environment."
} else {
  Write-Host "Authentication: direct loopback access only"
}
