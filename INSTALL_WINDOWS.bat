@echo off
REM Claude-mem Windows Installer
REM Runs the interactive installer in PowerShell

echo.
echo ======================================
echo   Claude-mem Windows Installer
echo ======================================
echo.
echo Starting interactive installation...
echo.

cd /d "%~dp0"

REM Run PowerShell with the Node.js installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "node install\public\install.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Installation failed with exit code %ERRORLEVEL%
    echo.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Installation complete!
echo.
pause
