<#
.SYNOPSIS
    环境自检：检查依赖是否就绪，路径是否解析正确。

.DESCRIPTION
    新用户第一次跑最容易卡在「找不到 dsh」「找不到 cloudflared」这类问题上。
    这个脚本把它们一次性列出来，并给出该怎么修。

.EXAMPLE
    .\doctor.ps1
#>

$ErrorActionPreference = 'Continue'

function Line($ok, $label, $detail) {
    $mark = if ($ok -eq $true) { '[OK]  ' } elseif ($ok -eq $false) { '[X]   ' } else { '[!]   ' }
    $color = if ($ok -eq $true) { 'Green' } elseif ($ok -eq $false) { 'Red' } else { 'Yellow' }
    Write-Host $mark -ForegroundColor $color -NoNewline
    Write-Host "$label" -NoNewline
    if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host '' }
}

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  DSH Pocket 环境自检' -ForegroundColor Cyan
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''

# ── 路径解析 ──
$repoRoot = if ($env:DSH_POCKET_ROOT) { $env:DSH_POCKET_ROOT } else { $PSScriptRoot }
$stateDir = if ($env:DSH_STATE_DIR) { $env:DSH_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'dsh-pocket' }

Write-Host '路径' -ForegroundColor White
Line $true '仓库根目录' $repoRoot
Line $true '状态目录' $stateDir
Write-Host ''

# ── 依赖 ──
Write-Host '依赖' -ForegroundColor White

# dsh
$dsh = $env:DSH_CLI
$dshFrom = ''
if ($dsh -and (Test-Path $dsh)) {
    $dshFrom = '环境变量 DSH_CLI'
} else {
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($onPath) {
        $dsh = $onPath.Source
        $dshFrom = 'PATH'
    } else {
        $cands = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
            (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
            'E:\DSH\resources\runtime\cli\bin\dsh.cmd'
        )
        $dsh = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($dsh) { $dshFrom = '常见安装位置' }
    }
}
if ($dsh) {
    Line $true 'dsh' "$dsh（来自 $dshFrom）"
} else {
    Line $false 'dsh' '找不到。装 DeepSeek Harness，或设 $env:DSH_CLI'
}

# cloudflared
$cf = $env:DSH_CLOUDFLARED
$cfFrom = ''
if ($cf -and (Test-Path $cf)) {
    $cfFrom = '环境变量 DSH_CLOUDFLARED'
} else {
    $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($onPath) {
        $cf = $onPath.Source
        $cfFrom = 'PATH'
    } else {
        $cands = @(
            'E:\cloudflared\cloudflared.exe',
            (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'),
            (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
        )
        $cf = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($cf) { $cfFrom = '常见位置' }
    }
}
if ($cf) {
    $ver = ''
    try { $ver = (& $cf --version 2>&1 | Select-Object -First 1) } catch {}
    Line $true 'cloudflared' "$ver（来自 $cfFrom）"
} else {
    Line 'warn' 'cloudflared' '没找到 —— 只有用 Cloudflare 隧道才需要'
    Write-Host '        下载：https://github.com/cloudflare/cloudflared/releases' -ForegroundColor DarkGray
    Write-Host '        放到 %LOCALAPPDATA%\cloudflared\ 或设 $env:DSH_CLOUDFLARED' -ForegroundColor DarkGray
}

# node（隧道服务需要）
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Line $true 'node' (& node --version 2>&1)
} else {
    Line $false 'node' '找不到 —— 隧道控制服务需要 Node.js 18+'
}
Write-Host ''

# ── 运行状态 ──
Write-Host '运行状态' -ForegroundColor White

$webPort = if ($env:DSH_WEB_PORT) { [int]$env:DSH_WEB_PORT } else { 3095 }
$svcPort = if ($env:DSH_TUNNEL_PORT) { [int]$env:DSH_TUNNEL_PORT } else { 3199 }

$web = Get-NetTCPConnection -LocalPort $webPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($web) {
    Line $true "DSH Web (:${webPort})" "$($web.LocalAddress)"
} else {
    Line 'warn' "DSH Web (:${webPort})" '没在跑。启动：.\start-dsh-web.ps1 -Bind lan'
}

$svc = Get-NetTCPConnection -LocalPort $svcPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svc) {
    Line $true "隧道服务 (:${svcPort})" "PID $($svc.OwningProcess)"
} else {
    Line 'warn' "隧道服务 (:${svcPort})" '没在跑。启动：.\start-tunnel-service.ps1'
}

$gw = Get-NetTCPConnection -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gw) {
    Line $true '移动网关 (:3081)' '审批可用'
} else {
    Line 'warn' '移动网关 (:3081)' '没开 —— 手机不能回答审批。配置：.\setup-gateway.ps1'
}
Write-Host ''

# ── 管家工具 ──
# 这些是 DSH 自带的子代理工具，默认 disabled。
# 不启用的话 butler.ts 里的「先 list_agents、用 send_message 复用队员」
# 全部落空 —— 模型找不到工具，只能自己干。
Write-Host '管家工具' -ForegroundColor White
$profileYml = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
$enabledCount = 0
if (Test-Path $profileYml) {
    $yml = [IO.File]::ReadAllText($profileYml, [Text.Encoding]::UTF8)
    foreach ($t in @('tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork')) {
        $hit = [regex]::IsMatch($yml, "(?m)^- id:\s*$([regex]::Escape($t))\s*\r?\n\s*disabled:\s*false")
        if ($hit) { $enabledCount++ }
    }
}
if ($enabledCount -eq 4) {
    Line $true '子代理委派工具' 'list_agents / send_message / spawn 已启用'
} elseif ($enabledCount -gt 0) {
    Line 'warn' '子代理委派工具' "只启用 $enabledCount/4 —— 检查 cordis.patch.yml"
} else {
    Line 'warn' '子代理委派工具' '未启用 —— 管家无法派队员，只能自己干'
    Write-Host '        修法见 docs/butler-tools.md' -ForegroundColor DarkGray
}
Write-Host ''
# ── 状态文件 ──
Write-Host '状态文件' -ForegroundColor White
$pair = Join-Path $stateDir 'pairing.json'
$tun = Join-Path $stateDir 'tunnel.json'
if (Test-Path $pair) {
    try {
        $j = Get-Content $pair -Raw -Encoding UTF8 | ConvertFrom-Json
        Line $true 'pairing.json' $j.url
    } catch {
        Line 'warn' 'pairing.json' '存在但解析失败'
    }
} else {
    Line 'warn' 'pairing.json' '还没生成（启动 DSH Web 后会有）'
}
if (Test-Path $tun) {
    try {
        $j = Get-Content $tun -Raw -Encoding UTF8 | ConvertFrom-Json
        $alive = $false
        if ($j.pid) { $alive = [bool](Get-Process -Id $j.pid -ErrorAction SilentlyContinue) }
        Line ([bool]$alive) 'tunnel.json' "$($j.url)$(if(-not $alive){'（进程已退出）'})"
    } catch {
        Line 'warn' 'tunnel.json' '存在但解析失败'
    }
} else {
    Line 'warn' 'tunnel.json' '没有隧道记录'
}
Write-Host ''

# ── 汇总 ──
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  下一步' -ForegroundColor Cyan
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''
if (-not $dsh) {
    Write-Host '  1. 先装 DeepSeek Harness' -ForegroundColor White
} elseif (-not $web) {
    Write-Host '  1. 启动 DSH Web：.\start-dsh-web.ps1 -Bind lan' -ForegroundColor White
} elseif (-not $svc) {
    Write-Host '  1. 启动隧道服务：.\start-tunnel-service.ps1' -ForegroundColor White
} else {
    Write-Host '  1. 基本就绪，手机可以配对了' -ForegroundColor Green
    if (Test-Path $pair) {
        try {
            $j = Get-Content $pair -Raw -Encoding UTF8 | ConvertFrom-Json
            Write-Host "     配对地址：$($j.url)" -ForegroundColor Yellow
        } catch {}
    }
}
if (-not $gw) {
    Write-Host '  2. 想用手机审批：.\setup-gateway.ps1' -ForegroundColor White
}
if (-not (Test-Path $env:APPDATA'\Microsoft\Windows\Start Menu\Programs\Startup\DSH-Web.lnk')) {
    Write-Host '  3. 想开机自启：.\setup-autostart.ps1' -ForegroundColor White
}
Write-Host ''
Write-Host '  详细配置见 docs/configuration.md' -ForegroundColor DarkGray
Write-Host ''
