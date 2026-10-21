<#
.SYNOPSIS
    启动隧道控制小服务（供 DSH 插件面板调用）。

.DESCRIPTION
    插件跑在浏览器里，没法直接启停本地进程，所以需要这个中间服务：
    
      浏览器插件  →  fetch http://127.0.0.1:3199/tunnel/start
                        ↓
                  本服务 →  运行 start-tunnel.ps1
                        ↓
                  cloudflared + DSH 重启

    服务只监听 127.0.0.1，并且校验 Origin 必须是本机页面。

.PARAMETER Stop
    停止服务。

.EXAMPLE
    .\start-tunnel-service.ps1
    .\start-tunnel-service.ps1 -Stop
#>
param(
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

# 路径从脚本位置推导，不写死；可用环境变量覆盖
$RepoRoot = if ($env:DSH_POCKET_ROOT) { $env:DSH_POCKET_ROOT } else { $PSScriptRoot }

$StateDir = if ($env:DSH_STATE_DIR) {
    $env:DSH_STATE_DIR
} else {
    Join-Path $env:LOCALAPPDATA 'dsh-pocket'
}
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

$ServiceScript = Join-Path $RepoRoot 'dsh-plugin-connect\tunnel-service.mjs'
$Port = if ($env:DSH_TUNNEL_PORT) { [int]$env:DSH_TUNNEL_PORT } else { 3199 }
$LogFile = Join-Path $StateDir 'tunnel-service.log'
$PidFile = Join-Path $StateDir 'tunnel-service.pid'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  [X] $msg" -ForegroundColor Red }

if ($Stop) {
    $stopped = $false
    if (Test-Path $PidFile) {
        $old = (Get-Content $PidFile -Raw).Trim()
        if ($old -match '^\d+$' -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*tunnel-service*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $stopped = $true }
    if ($stopped) { Write-Ok '服务已停止' } else { Write-Step '服务没在运行' }
    exit 0
}

Write-Host ''
Write-Host '  启动隧道控制服务' -ForegroundColor Cyan
Write-Host ''

# 已经在跑就不重复启动
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Ok "已经在运行（127.0.0.1:$Port, PID $($existing[0].OwningProcess)）"
    exit 0
}

if (-not (Test-Path $ServiceScript)) {
    Write-Err "找不到 $ServiceScript"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err '找不到 node'
    exit 1
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }

# 用计划任务启动，保证服务独立于当前窗口
$taskName = 'DSH-Tunnel-Service'
$batPath = Join-Path $env:TEMP 'dsh-tunnel-service.bat'
$batLines = @(
    '@echo off',
    "`"$($node.Source)`" `"$ServiceScript`" > `"$LogFile`" 2>&1"
)
Set-Content -Path $batPath -Value $batLines -Encoding ASCII

$null = cmd /c "schtasks /Delete /TN `"$taskName`" /F >nul 2>&1"
$null = cmd /c "schtasks /Create /TN `"$taskName`" /TR `"`"`"$batPath`"`"`" /SC ONCE /ST 00:00 /F >nul 2>&1"
$null = cmd /c "schtasks /Run /TN `"$taskName`" >nul 2>&1"

Start-Sleep -Seconds 4
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Err '启动失败'
    Get-Content $LogFile -ErrorAction SilentlyContinue | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    exit 1
}

$listening[0].OwningProcess | Set-Content $PidFile -Encoding UTF8
Write-Ok "已启动：http://127.0.0.1:$Port（PID $($listening[0].OwningProcess)）"
Write-Host ''
Write-Host '  现在插件面板里的「启动隧道」按钮可以用了。' -ForegroundColor Gray
Write-Host "  停止服务：$PSCommandPath -Stop" -ForegroundColor DarkGray
Write-Host ''
