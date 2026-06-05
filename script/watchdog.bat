@echo off
cd /d "%~dp0"

echo.
echo ========================================
echo   yUYUko Food MAP - Watchdog Launcher
echo ========================================
echo.

:: Request admin if not already elevated
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [INFO] Watchdog will run in this window.
echo [INFO] Close this window to stop the watchdog.
echo [INFO] Logs: script\logs\watchdog_YYYY-MM-DD.log
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1"

pause
