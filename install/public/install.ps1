# claude-mem installer - PowerShell version
# Works on Windows with PowerShell 5.0+
#
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
#   or:  powershell -ExecutionPolicy Bypass -File install.ps1 -Provider gemini -ApiKey YOUR_KEY

param(
  [string]$Provider = '',
  [string]$ApiKey = ''
)

# ANSI colors
$colors = @{
  'reset'  = "`e[0m"
  'red'    = "`e[31m"
  'green'  = "`e[32m"
  'cyan'   = "`e[36m"
}

function Write-Error-Custom {
  param([string]$message)
  Write-Host "$($colors['red'])Error: $message$($colors['reset'])" -ForegroundColor Red
  exit 1
}

function Write-Info {
  param([string]$message)
  Write-Host "$($colors['cyan'])$message$($colors['reset'])" -ForegroundColor Cyan
}

function Write-Success {
  param([string]$message)
  Write-Host "$($colors['green'])$message$($colors['reset'])" -ForegroundColor Green
}

# Check Node.js version
try {
  $nodeVersion = & node -v 2>&1
  Write-Info "claude-mem installer (Node.js $nodeVersion)"

  # Parse version - extract major version number
  if ($nodeVersion -match 'v(\d+)\.') {
    $majorVersion = [int]$matches[1]
    if ($majorVersion -lt 18) {
      Write-Error-Custom "Node.js >= 18 required. Current: $nodeVersion"
    }
  }
  else {
    Write-Error-Custom "Could not parse Node.js version: $nodeVersion"
  }
}
catch {
  Write-Error-Custom "Node.js is required but not found. Install from https://nodejs.org"
}

# Find installer script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$possiblePaths = @(
  (Join-Path $scriptDir 'installer.js'),
  (Join-Path $scriptDir '../..' 'installer/dist/installer.js'),
  (Join-Path (Get-Location) 'installer.js')
)

$installerPath = $null
foreach ($path in $possiblePaths) {
  if (Test-Path $path) {
    Write-Info "Using installer: $path"
    $installerPath = $path
    break
  }
}

if (-not $installerPath) {
  Write-Error-Custom "Installer script not found. Expected one of:`n  $($possiblePaths -join "`n  ")"
}

# Build arguments
$arguments = @()
if ($Provider) {
  $arguments += "--provider=$Provider"
}
if ($ApiKey) {
  $arguments += "--api-key=$ApiKey"
}

# Run installer
Write-Info "Starting claude-mem installation...`n"

try {
  & node $installerPath @arguments
  $exitCode = $LASTEXITCODE

  if ($exitCode -eq 0) {
    Write-Success "`n✅ claude-mem installation complete!"
    exit 0
  }
  else {
    Write-Error-Custom "Installer exited with code $exitCode"
  }
}
catch {
  Write-Error-Custom $_.Exception.Message
}
