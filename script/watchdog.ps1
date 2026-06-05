<#
.SYNOPSIS
    yUYUko Food MAP - Backend & Memurai auto-restart watchdog.
.DESCRIPTION
    Continuously monitors Memurai (Redis) service and Node.js backend.
    Automatically restarts them on failure. Logs all actions to file.
.NOTES
    Run as Administrator to manage Windows services.
    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\watchdog.ps1"
#>

param(
    [int]$CheckIntervalSeconds = 10,
    [int]$BackendPort = 2053,
    [string]$BackendDir = $null,
    [string]$LogDir = $null,
    [string]$MemuraiServiceName = "Memurai",
    [string[]]$MemuraiFallbackNames = @("Redis", "memurai", "redis")
)

# ====================== Paths ======================
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

if (-not $BackendDir) {
    $BackendDir = Join-Path $ProjectRoot "backend"
}

if (-not $LogDir) {
    $LogDir = Join-Path $ScriptRoot "logs"
}
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "watchdog_$(Get-Date -Format 'yyyy-MM-dd').log"

# ====================== Helpers ======================
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    try {
        Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ====================== Memurai Management ======================
function Get-MemuraiServiceName {
    $namesToTry = @($MemuraiServiceName) + $MemuraiFallbackNames
    foreach ($name in $namesToTry) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc) { return $name }
    }
    $all = Get-Service -ErrorAction SilentlyContinue | Where-Object {
        $_.DisplayName -match 'redis|memurai'
    }
    if ($all) { return $all[0].Name }
    return $null
}

function Test-MemuraiRunning {
    param([string]$ServiceName)
    if (-not $ServiceName) { return $false }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') { return $false }
    if (-not $svc) { return $false }

    # Double-check with redis-cli ping
    $cli = $null
    $found = Get-Command redis-cli -ErrorAction SilentlyContinue
    if ($found) { $cli = $found.Source }

    if (-not $cli) {
        $memePath = "${env:ProgramFiles}\Memurai\redis-cli.exe"
        $memePathX86 = "${env:ProgramFiles(x86)}\Memurai\redis-cli.exe"
        if (Test-Path $memePath) { $cli = $memePath }
        elseif (Test-Path $memePathX86) { $cli = $memePathX86 }
    }
    if ($cli) {
        try {
            $result = & $cli ping 2>$null
            if ($result -eq "PONG") { return $true }
        } catch { }
        return $false
    }
    return ($svc.Status -eq 'Running')
}

function Start-MemuraiService {
    param([string]$ServiceName)

    if (-not $ServiceName) {
        Write-Log "Memurai/Redis service not found. Is Memurai installed?" "ERROR"
        return $false
    }

    Write-Log "Starting service: $ServiceName ..." "WARN"
    try {
        Start-Service -Name $ServiceName -ErrorAction Stop
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Log "Service $ServiceName started successfully" "INFO"
            return $true
        } else {
            $status = if ($svc) { $svc.Status } else { "UNKNOWN" }
            Write-Log "Service $ServiceName status abnormal: $status" "ERROR"
            return $false
        }
    } catch {
        Write-Log "Failed to start $ServiceName : $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== Backend Process Management ======================
$script:BackendProcess = $null
$script:LogFileForEvents = $LogFile

function Test-BackendRunning {
    param([int]$Port)
    try {
        $client = [Net.Sockets.TcpClient]::new("127.0.0.1", $Port)
        if ($client.Connected) {
            $client.Dispose()
            return $true
        }
        $client.Dispose()
    } catch { }
    return $false
}

function Start-BackendProcess {
    param([string]$WorkDir)

    if (-not (Test-Path $WorkDir)) {
        Write-Log "Backend directory not found: $WorkDir" "ERROR"
        return $false
    }

    # Kill old backend process
    if ($script:BackendProcess -and -not $script:BackendProcess.HasExited) {
        Write-Log "Killing old backend process (PID: $($script:BackendProcess.Id))..." "WARN"
        try {
            $script:BackendProcess.Kill()
            $script:BackendProcess.WaitForExit(5000)
            $script:BackendProcess = $null
        } catch { }
    }

    # Kill any node process occupying the backend port
    $pidsOnPort = Get-NetTCPConnection -LocalPort $BackendPort -ErrorAction SilentlyContinue `
        | Where-Object { $_.State -eq 'Listen' } `
        | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pidTarget in $pidsOnPort) {
        try {
            $proc = Get-Process -Id $pidTarget -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'node') {
                Write-Log "Killing stale node process on port $BackendPort (PID: $pidTarget)" "WARN"
                $proc.Kill()
            }
        } catch { }
    }

    Write-Log "Starting backend (node index.js)..." "WARN"
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "node"
        $psi.Arguments = "index.js"
        $psi.WorkingDirectory = $WorkDir
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.EnableRaisingEvents = $true

        $logPath = $script:LogFileForEvents

        # Event handlers for stdout/stderr redirection
        $outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-out] $line"
                Write-Host $msg
                try { Add-Content -Path $logPath -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        }

        $errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-err] $line"
                Write-Host $msg -ForegroundColor Red
                try { Add-Content -Path $logPath -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        }

        $proc.Start() | Out-Null
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()

        $script:BackendProcess = $proc
        Write-Log "Backend process started (PID: $($proc.Id))" "INFO"
        return $true
    } catch {
        Write-Log "Failed to start backend: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== Main Loop ======================
function Main-Loop {
    $serviceName = Get-MemuraiServiceName
    if ($serviceName) {
        Write-Log "Detected Redis service: $serviceName" "INFO"
    } else {
        Write-Log "No Memurai/Redis service detected, will skip Redis monitoring" "WARN"
    }

    # Startup: ensure everything is ready
    if ($serviceName) {
        if (-not (Test-MemuraiRunning -ServiceName $serviceName)) {
            Write-Log "Memurai not running, starting..." "WARN"
            Start-MemuraiService -ServiceName $serviceName | Out-Null
        } else {
            Write-Log "Memurai is running" "INFO"
        }
    }

    if (-not (Test-BackendRunning -Port $BackendPort)) {
        Write-Log "Backend not running, starting..." "WARN"
        Start-BackendProcess -WorkDir $BackendDir | Out-Null
    } else {
        Write-Log "Backend is running (port $BackendPort)" "INFO"
    }

    $memuraiFailCount = 0
    $backendFailCount = 0

    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSeconds

        # ---- Check Memurai ----
        if ($serviceName) {
            if (Test-MemuraiRunning -ServiceName $serviceName) {
                $memuraiFailCount = 0
            } else {
                $memuraiFailCount++
                Write-Log "Memurai unresponsive (consecutive: $memuraiFailCount)" "WARN"
                if ($memuraiFailCount -ge 2) {
                    Start-MemuraiService -ServiceName $serviceName | Out-Null
                    $memuraiFailCount = 0
                }
            }
        }

        # ---- Check Backend ----
        if (Test-BackendRunning -Port $BackendPort) {
            $backendFailCount = 0
        } else {
            $backendFailCount++
            if ($script:BackendProcess -and -not $script:BackendProcess.HasExited) {
                Write-Log "Backend process exists but port $BackendPort not responding (consecutive: $backendFailCount)" "WARN"
            } else {
                Write-Log "Backend process exited (consecutive: $backendFailCount)" "WARN"
            }

            if ($backendFailCount -ge 2) {
                Write-Log "Backend abnormal, attempting restart..." "ERROR"

                # If Memurai is also down, fix it first
                if ($serviceName -and -not (Test-MemuraiRunning -ServiceName $serviceName)) {
                    Write-Log "Memurai also down, restarting Memurai first..." "ERROR"
                    Start-MemuraiService -ServiceName $serviceName | Out-Null
                    Start-Sleep -Seconds 3
                }

                Start-BackendProcess -WorkDir $BackendDir | Out-Null
                $backendFailCount = 0

                # Wait a moment then verify
                Start-Sleep -Seconds 5
                if (Test-BackendRunning -Port $BackendPort) {
                    Write-Log "Backend recovered successfully" "INFO"
                } else {
                    Write-Log "Backend still not responding after restart, will retry next round" "ERROR"
                }
            }
        }
    }
}

# ====================== Entry Point ======================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  yUYUko Food MAP - Watchdog Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Check Interval: ${CheckIntervalSeconds}s" -ForegroundColor Gray
Write-Host "  Backend Port  : $BackendPort" -ForegroundColor Gray
Write-Host "  Backend Dir   : $BackendDir" -ForegroundColor Gray
Write-Host "  Log Dir       : $LogDir" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Admin)) {
    Write-Log "WARNING: Not running as Administrator. Memurai service management may fail." "WARN"
    Write-Host ""
}

try {
    Main-Loop
} catch {
    Write-Log "Watchdog script crashed: $($_.Exception.Message)" "FATAL"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" "FATAL"
    throw
} finally {
    Write-Log "Watchdog script stopped" "INFO"
}
