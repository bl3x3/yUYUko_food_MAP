<#
.SYNOPSIS
    Install the backend watchdog as a Windows Scheduled Task (auto-start on boot).
.DESCRIPTION
    Run once as Administrator. The task triggers every 1 minute,
    ensuring the watchdog is always running after system boot.
.NOTES
    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\install-watchdog-task.ps1"
           powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\install-watchdog-task.ps1" -Uninstall
#>

param(
    [switch]$Uninstall
)

$TaskName = "yUYUko_FoodMAP_Watchdog"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchdogScript = Join-Path $ScriptRoot "watchdog.ps1"

if (-not (Test-Path $WatchdogScript)) {
    Write-Host "ERROR: watchdog.ps1 not found. Ensure both scripts are in the same directory." -ForegroundColor Red
    exit 1
}

if ($Uninstall) {
    Write-Host "Removing scheduled task: $TaskName ..." -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Scheduled task removed successfully." -ForegroundColor Green
    } catch {
        if ($_.Exception.Message -match 'not found|does not exist|not exist') {
            Write-Host "Scheduled task does not exist, nothing to remove." -ForegroundColor Gray
        } else {
            Write-Host "Removal failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    exit 0
}

# Check admin rights
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Please run this script as Administrator." -ForegroundColor Red
    pause
    exit 1
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Install Watchdog Scheduled Task" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Task Name : $TaskName" -ForegroundColor Gray
Write-Host "  Script    : $WatchdogScript" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Remove old task if exists
try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
} catch { }

# Action: run powershell with watchdog script (hidden window, highest privileges)
$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchdogScript`""

# Trigger 1: At system startup (with random delay to avoid resource contention)
$Trigger1 = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)

# Trigger 2: Every 1 minute (ensures task restarts quickly if it dies)
$Trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Seconds 30) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -Priority 6

# Run as SYSTEM (no user login required)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

try {
    Register-ScheduledTask -TaskName $TaskName `
        -Action $Action `
        -Trigger @($Trigger1, $Trigger2) `
        -Settings $Settings `
        -Principal $Principal `
        -Description "yUYUko Food MAP - Backend & Memurai auto-restart watchdog. Checks every minute, auto-restarts on failure." `
        -Force `
        -ErrorAction Stop

    Write-Host "Scheduled task installed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  - Task auto-starts at system boot" -ForegroundColor Green
    Write-Host "  - Checks backend & Memurai every minute" -ForegroundColor Green
    Write-Host "  - Auto-restarts services on failure" -ForegroundColor Green
    Write-Host ""
    Write-Host "Log files: script\logs\watchdog_YYYY-MM-DD.log" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Start task now:" -ForegroundColor Yellow
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
    Write-Host ""
    Write-Host "View task status:" -ForegroundColor Yellow
    Write-Host "  Get-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
    Write-Host ""
    Write-Host "Uninstall task:" -ForegroundColor Yellow
    Write-Host "  .\script\install-watchdog-task.ps1 -Uninstall" -ForegroundColor White
    Write-Host ""

    $choice = Read-Host "Start the watchdog task now? (y/n)"
    if ($choice -eq 'y' -or $choice -eq 'Y') {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Watchdog task started." -ForegroundColor Green
    }

} catch {
    Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

pause
