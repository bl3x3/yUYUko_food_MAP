@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo.
echo ========================================
echo   东方饭联地图 - 后端守护脚本 (CMD)
echo ========================================
echo.

:: 以管理员身份重新运行
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 需要管理员权限来管理 Memurai 服务...
    echo 正在请求管理员权限...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [启动] 守护脚本将在后台运行
echo [提示] 关闭此窗口即停止守护
echo [日志] script\logs\watchdog_YYYY-MM-DD.log
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1"

pause
