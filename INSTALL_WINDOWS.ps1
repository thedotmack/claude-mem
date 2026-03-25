# Claude-mem Windows Installer
# Run this script to interactively install claude-mem
# Usage: powershell -ExecutionPolicy Bypass -File INSTALL_WINDOWS.ps1

Write-Host ""
Write-Host "======================================"
Write-Host "  Claude-mem Windows Installer"
Write-Host "======================================"
Write-Host ""
Write-Host "Starting interactive installation..." -ForegroundColor Cyan
Write-Host ""

# Change to script directory
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Run the Node.js installer
& node install/public/install.js

$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "Installation failed with exit code $exitCode" -ForegroundColor Red
    Write-Host ""
    Write-Host "Press any key to exit..."
    [void][System.Console]::ReadKey($true)
    exit $exitCode
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Press any key to exit..."
[void][System.Console]::ReadKey($true)
