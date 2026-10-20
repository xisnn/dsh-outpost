<#
.SYNOPSIS
    配置 DSH 移动网关（手机端审批的必要条件）。

.DESCRIPTION
    手机要能回答审批，需要 dsh-plugin-mobile-gateway 这个插件。
    它会：
      1. 在 Host 内部接入 approval/request waterfall
      2. 开一个独立 WebSocket（默认 3081）把审批投影给手机

    这个脚本做三件事：
      1. 检查插件是否已装，没装就装
      2. 往 profile 的 cordis.patch.yml 写网关配置
         （默认是关闭的，而且管理接口只允许回环 —— 但 DSH 绑在局域网 IP 上，
          回环连不进去，所以必须把 adminLoopbackOnly 关掉）
      3. 重启 DSH Web 生效

.PARAMETER Port
    DSH Web 端口，默认 3095。

.PARAMETER NoRestart
    只改配置，不重启。

.EXAMPLE
    .\setup-gateway.ps1
    .\setup-gateway.ps1 -NoRestart
#>
param(
    [int]$Port = 3095,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$ProfileFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
$PluginName = 'dsh-plugin-mobile-gateway'
$GatewayPort = 3081

function Write-Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  DSH 移动网关配置' -ForegroundColor Cyan
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''

if (-not (Test-Path $ProfileFile)) {
    Write-Err2 "找不到 profile 配置：$ProfileFile"
    Write-Step '先启动一次 DSH Web，让它创建 profile。'
    exit 1
}

# ── 1. 检查插件 ──
Write-Step "检查插件 $PluginName ..."
$pluginDir = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\$PluginName"
if (Test-Path $pluginDir) {
    $ver = 'unknown'
    $pj = Join-Path $pluginDir 'package.json'
    if (Test-Path $pj) {
        try { $ver = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch {}
    }
    Write-Ok "已安装（$ver）"
} else {
    Write-Warn2 '未安装，正在装 ...'
    $dshCands = @(
        'E:\DSH\resources\runtime\cli\bin\dsh.cmd',
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    $dsh = $dshCands | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $dsh) {
        Write-Err2 '找不到 dsh，请手动安装：npx dsh plugin add ' + $PluginName
        exit 1
    }
    & $dsh --profile web plugin add $PluginName 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Step $_ }
    if (-not (Test-Path $pluginDir)) {
        Write-Err2 '安装失败'
        exit 1
    }
    Write-Ok '安装完成'
}

# ── 2. 写配置 ──
Write-Step '写入网关配置 ...'
$content = [IO.File]::ReadAllText($ProfileFile, [Text.Encoding]::UTF8)

if ($content -match '(?m)^- id:\s*mobile-gateway') {
    Write-Warn2 '配置已存在，跳过（如需重写请先手动删掉那段）'
} else {
    $block = @"

# 手机网关：让 DSH Pocket 能通过 WebSocket 接审批和实时事件。
# 由 setup-gateway.ps1 写入。
- id: mobile-gateway
  name: '$PluginName'
  config:
    gatewayEnabled: true
    gatewayMode: persistent
    gatewayName: DSH Pocket
    requireAuth: true
    adminLoopbackOnly: false
    lanEnabled: true
    lanHost: 0.0.0.0
    lanPort: $GatewayPort
    pairingTtlMs: 300000
"@
    # 备份再写
    $bak = "$ProfileFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $ProfileFile $bak -Force
    [IO.File]::WriteAllText($ProfileFile, $content.TrimEnd() + $block, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "已写入（备份：$(Split-Path $bak -Leaf)）"
}

# ── 3. 重启 ──
if ($NoRestart) {
    Write-Warn2 '按 -NoRestart，未重启。手动重启 DSH Web 后生效。'
    exit 0
}

Write-Step '重启 DSH Web ...'
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn[0].OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

$script = Join-Path (Split-Path $PSCommandPath -Parent) 'start-dsh-web.ps1'
if (Test-Path $script) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script,
        '-Bind', 'lan', '-Port', "$Port", '-NoQr'
    ) -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 35
} else {
    Write-Err2 "找不到 $script，请手动重启"
    exit 1
}

# ── 4. 验证 ──
Write-Step '验证 ...'
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Err2 'DSH Web 没起来'
    exit 1
}
$gw = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue
if ($gw) {
    Write-Ok "网关已启动：$($gw[0].LocalAddress):$GatewayPort"
} else {
    Write-Warn2 "网关端口 $GatewayPort 没监听，检查 DSH 日志"
}

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  配置完成' -ForegroundColor Green
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  手机 App 进聊天页会自动配对，之后审批就能在手机上点了。' -ForegroundColor White
Write-Host ''
Write-Host "  查看网关状态：curl http://$($listening[0].LocalAddress):$Port/mgw/status" -ForegroundColor DarkGray
Write-Host "  协议细节见：docs/mobile-gateway.md" -ForegroundColor DarkGray
Write-Host ''
