<#
.SYNOPSIS
    东方饭联地图 — 后端 & Memurai 自动守护脚本
.DESCRIPTION
    循环检测 Memurai (Redis) 服务状态和 Node.js 后端进程，
    发现异常时自动重启，并记录日志。
.NOTES
    以管理员身份运行此脚本，否则无法管理 Windows 服务。
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\watchdog.ps1"
          或直接双击 watchdog.bat
#>

param(
    [int]$CheckIntervalSeconds = 10,
    [int]$BackendPort = 2053,
    [string]$BackendDir = $null,
    [string]$LogDir = $null,
    [string]$MemuraiServiceName = "Memurai",
    [string[]]$MemuraiFallbackNames = @("Redis", "memurai", "redis")
)

# ====================== 路径初始化 ======================
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

# ====================== 工具函数 ======================
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

# ====================== Memurai 服务管理 ======================
function Get-MemuraiServiceName {
    # 按顺序尝试找到实际存在的 Redis 服务名
    $namesToTry = @($MemuraiServiceName) + $MemuraiFallbackNames
    foreach ($name in $namesToTry) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc) { return $name }
    }
    # 尝试模糊匹配
    $all = Get-Service -ErrorAction SilentlyContinue | Where-Object {
        $_.DisplayName -match 'redis|memurai'
    }
    if ($all) { return $all[0].Name }
    return $null
}

function Test-MemuraiRunning {
    param([string]$ServiceName)
    if (-not $ServiceName) { return $false }

    # 先检查 Windows 服务状态
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') { return $false }
    if (-not $svc) { return $false }

    # 再通过 redis-cli ping 做二次确认
    $cli = Get-Command redis-cli -ErrorAction SilentlyContinue
    if (-not $cli) {
        # 尝试 Memurai 安装目录
        $memePath = "${env:ProgramFiles}\Memurai\redis-cli.exe"
        $memePathX86 = "${env:ProgramFiles(x86)}\Memurai\redis-cli.exe"
        if (Test-Path $memePath) { $cli = $memePath }
        elseif (Test-Path $memePathX86) { $cli = $memePathX86 }
    }
    if ($cli) {
        $result = & $cli ping 2>$null
        if ($result -eq "PONG") { return $true }
        return $false
    }
    # 没有 redis-cli，仅凭服务状态判断
    return ($svc.Status -eq 'Running')
}

function Start-MemuraiService {
    param([string]$ServiceName)

    if (-not $ServiceName) {
        Write-Log "未找到 Memurai/Redis 服务，请确认已安装 Memurai" "ERROR"
        return $false
    }

    Write-Log "正在启动 ${ServiceName} 服务..." "WARN"
    try {
        Start-Service -Name $ServiceName -ErrorAction Stop
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Log "${ServiceName} 服务启动成功" "INFO"
            return $true
        } else {
            Write-Log "${ServiceName} 服务启动后状态异常: $($svc.Status)" "ERROR"
            return $false
        }
    } catch {
        Write-Log "启动 ${ServiceName} 失败: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== 后端进程管理 ======================
$global:BackendProcess = $null

function Test-BackendRunning {
    param([int]$Port)
    # 方法1: TCP 端口检测
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpClient]::new("127.0.0.1", $Port)
        if ($listener.Connected) { return $true }
    } catch { }
    finally {
        if ($listener) { $listener.Dispose() }
    }

    # 方法2: 如果进程对象还在，检查是否响应
    if ($global:BackendProcess -and -not $global:BackendProcess.HasExited) {
        return $false  # 进程存在但端口不监听 = 正在启动中
    }
    return $false
}

function Start-BackendProcess {
    param([string]$WorkDir)

    if (-not (Test-Path $WorkDir)) {
        Write-Log "后端目录不存在: $WorkDir" "ERROR"
        return $false
    }

    # 如果旧进程还在，先杀掉
    if ($global:BackendProcess -and -not $global:BackendProcess.HasExited) {
        Write-Log "正在终止旧后端进程 (PID: $($global:BackendProcess.Id))..." "WARN"
        try {
            $global:BackendProcess.Kill()
            $global:BackendProcess.WaitForExit(5000)
        } catch { }
    }

    # 额外: 杀掉占用目标端口的残留 node 进程
    $pidsOnPort = Get-NetTCPConnection -LocalPort $BackendPort -ErrorAction SilentlyContinue `
        | Where-Object { $_.State -eq 'Listen' } `
        | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pidTarget in $pidsOnPort) {
        try {
            $proc = Get-Process -Id $pidTarget -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'node') {
                Write-Log "杀死占用端口 ${BackendPort} 的残留进程 (PID: $pidTarget)" "WARN"
                $proc.Kill()
            }
        } catch { }
    }

    Write-Log "正在启动后端 (node index.js)..." "WARN"
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "node"
        $psi.Arguments = "index.js"
        $psi.WorkingDirectory = $WorkDir
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.EnableRaisingEvents = $true

        # 将 stdout/stderr 输出到日志
        $procId = $null
        $proc.Add_Exited({
            param($s, $e)
            $id = if ($s.Id) { $s.Id } else { $procId }
            Write-Log "后端进程 (PID: $id) 已退出，退出码: $($s.ExitCode)" "ERROR"
        })

        Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-out] $line"
                Write-Host $msg
                try { Add-Content -Path $LogFile -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        } | Out-Null

        Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-err] $line"
                Write-Host $msg -ForegroundColor Red
                try { Add-Content -Path $LogFile -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        } | Out-Null

        $proc.Start() | Out-Null
        $procId = $proc.Id
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()

        $global:BackendProcess = $proc
        Write-Log "后端进程已启动 (PID: $procId)" "INFO"
        return $true
    } catch {
        Write-Log "启动后端失败: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== 主循环 ======================
function Main-Loop {
    $serviceName = Get-MemuraiServiceName
    if ($serviceName) {
        Write-Log "检测到 Redis 服务: $serviceName" "INFO"
    } else {
        Write-Log "未检测到 Memurai/Redis 服务，将跳过 Redis 守护" "WARN"
    }

    # 启动时先确保一切就绪
    $memuraiOk = $true
    if ($serviceName) {
        if (-not (Test-MemuraiRunning -ServiceName $serviceName)) {
            Write-Log "Memurai 未运行，正在启动..." "WARN"
            $memuraiOk = Start-MemuraiService -ServiceName $serviceName
        } else {
            Write-Log "Memurai 已在运行" "INFO"
        }
    }

    if (-not (Test-BackendRunning -Port $BackendPort)) {
        Write-Log "后端未运行，正在启动..." "WARN"
        Start-BackendProcess -WorkDir $BackendDir
    } else {
        Write-Log "后端已在运行 (端口 $BackendPort)" "INFO"
    }

    $memuraiFailCount = 0
    $backendFailCount = 0
    $maxConsecutiveFails = 5

    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSeconds

        # ---- 检测 Memurai ----
        if ($serviceName) {
            if (Test-MemuraiRunning -ServiceName $serviceName) {
                $memuraiFailCount = 0
            } else {
                $memuraiFailCount++
                Write-Log "Memurai 无响应 (连续 $memuraiFailCount 次)" "WARN"
                if ($memuraiFailCount -ge 2) {
                    Start-MemuraiService -ServiceName $serviceName
                    $memuraiFailCount = 0
                }
            }
        }

        # ---- 检测后端 ----
        if (Test-BackendRunning -Port $BackendPort) {
            $backendFailCount = 0
        } else {
            $backendFailCount++
            if ($global:BackendProcess -and -not $global:BackendProcess.HasExited) {
                Write-Log "后端进程存在但端口 $BackendPort 无响应 (连续 $backendFailCount 次)" "WARN"
            } else {
                Write-Log "后端进程已退出 (连续 $backendFailCount 次)" "WARN"
            }

            if ($backendFailCount -ge 2) {
                Write-Log "后端异常，尝试重启..." "ERROR"

                # 若 Memurai 也不可用，先修复 Memurai
                if ($serviceName -and -not (Test-MemuraiRunning -ServiceName $serviceName)) {
                    Write-Log "Memurai 也不可用，先重启 Memurai..." "ERROR"
                    Start-MemuraiService -ServiceName $serviceName
                    Start-Sleep -Seconds 3
                }

                Start-BackendProcess -WorkDir $BackendDir
                $backendFailCount = 0

                # 启动后等待一会再验证
                Start-Sleep -Seconds 5
                if (Test-BackendRunning -Port $BackendPort) {
                    Write-Log "后端恢复正常" "INFO"
                } else {
                    Write-Log "后端启动后仍无响应，将在下一轮重新尝试" "ERROR"
                }
            }
        }
    }
}

# ====================== 入口 ======================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  东方饭联地图 - 后端守护脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  检测间隔: ${CheckIntervalSeconds}s" -ForegroundColor Gray
Write-Host "  后端端口: $BackendPort" -ForegroundColor Gray
Write-Host "  后端目录: $BackendDir" -ForegroundColor Gray
Write-Host "  日志目录: $LogDir" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Admin)) {
    Write-Log "警告: 未以管理员身份运行。如果 Memurai 服务需要启停，请以管理员身份重新运行。" "WARN"
    Write-Host ""
}

try {
    Main-Loop
} catch {
    Write-Log "守护脚本异常退出: $($_.Exception.Message)" "FATAL"
    Write-Log "堆栈: $($_.ScriptStackTrace)" "FATAL"
} finally {
    Write-Log "守护脚本已停止" "INFO"
}
