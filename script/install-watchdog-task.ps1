<#
.SYNOPSIS
    将后端守护脚本注册为 Windows 计划任务，实现开机自启、崩溃自动恢复。
.DESCRIPTION
    以管理员身份运行一次即可。任务会每 1 分钟触发一次，
    每次触发时先检查旧实例是否仍在运行（防止重复），然后执行守护逻辑。
.NOTES
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\install-watchdog-task.ps1"
          powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\install-watchdog-task.ps1" -Uninstall
#>

param(
    [switch]$Uninstall
)

$TaskName = "yUYUko_FoodMAP_Watchdog"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchdogScript = Join-Path $ScriptRoot "watchdog.ps1"

if (-not (Test-Path $WatchdogScript)) {
    Write-Host "错误: 找不到 watchdog.ps1，请确保两个脚本在同一目录下" -ForegroundColor Red
    exit 1
}

if ($Uninstall) {
    Write-Host "正在移除计划任务: $TaskName ..." -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "已成功移除计划任务" -ForegroundColor Green
    } catch {
        if ($_.Exception.Message -match "不存在|not found|does not exist") {
            Write-Host "计划任务不存在，无需移除" -ForegroundColor Gray
        } else {
            Write-Host "移除失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    exit 0
}

# 检查管理员权限
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "错误: 请以管理员身份运行此脚本" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  安装后端守护计划任务" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  任务名称: $TaskName" -ForegroundColor Gray
Write-Host "  脚本路径: $WatchdogScript" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 先移除旧任务（如果存在）
try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
} catch { }

# 创建计划任务操作 — 必须以最高权限运行且隐藏窗口
$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchdogScript`""

# 触发器: 系统启动后 1 分钟触发，之后每 5 分钟重复（确保活着）
$Trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)
# 额外触发器: 每分钟检查一次（如果任务还没在运行）
$Trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)

# 设置
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Seconds 30) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -Priority 6

# 以 SYSTEM 账户运行（无需用户登录）
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

try {
    Register-ScheduledTask -TaskName $TaskName `
        -Action $Action `
        -Trigger @($Trigger, $Trigger2) `
        -Settings $Settings `
        -Principal $Principal `
        -Description "东方饭联地图 — 后端 & Memurai 自动守护任务。每 1 分钟检查一次，异常时自动重启。" `
        -Force `
        -ErrorAction Stop

    Write-Host "计划任务已安装成功!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  - 该任务将在系统启动后自动运行" -ForegroundColor Green
    Write-Host "  - 每 1 分钟检测后端和 Memurai 状态" -ForegroundColor Green
    Write-Host "  - 发现异常时自动重启对应服务" -ForegroundColor Green
    Write-Host ""
    Write-Host "日志文件: script\logs\watchdog_YYYY-MM-DD.log" -ForegroundColor Gray
    Write-Host ""
    Write-Host "立即手动启动任务:" -ForegroundColor Yellow
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
    Write-Host ""
    Write-Host "查看任务状态:" -ForegroundColor Yellow
    Write-Host "  Get-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
    Write-Host ""
    Write-Host "卸载任务:" -ForegroundColor Yellow
    Write-Host "  .\script\install-watchdog-task.ps1 -Uninstall" -ForegroundColor White
    Write-Host ""

    # 询问是否立即启动
    $choice = Read-Host "是否立即启动守护任务? (y/n)"
    if ($choice -eq 'y' -or $choice -eq 'Y') {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "守护任务已启动" -ForegroundColor Green
    }

} catch {
    Write-Host "安装失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

pause
