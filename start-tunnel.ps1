<#
.SYNOPSIS
    启动 Cloudflare 快速隧道，把本机的 DSH Web 服务暴露到公网。

.DESCRIPTION
    出门在外、手机和电脑不在同一网络、又不想装 Tailscale 时用这个。

    它做四件事：
      1. 找到本机可用的 IPv4（跳过虚拟网卡）
      2. 用 http2 协议启动 cloudflared（默认 QUIC 会被代理软件干扰）
      3. 等 Cloudflare 分配 https://xxx.trycloudflare.com 域名
      4. 把域名写进 tunnel.json，供 DSH 插件读取

    注意：快速隧道的域名每次启动都会变，所以每次开隧道后
    手机 App 需要重新配对一次。想要固定域名得有自己的域名
    并用命名隧道（cloudflared tunnel create）。

.PARAMETER Port
    DSH Web 服务的端口，默认 3095。

.PARAMETER Stop
    停止正在运行的隧道。

.PARAMETER Status
    只看当前隧道状态，不启动。

.EXAMPLE
    .\start-tunnel.ps1
    .\start-tunnel.ps1 -Status
    .\start-tunnel.ps1 -Stop
#>
param(
    [int]$Port = 3095,
    [switch]$Stop,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

# ── 路径都通过环境变量配置，不写死 ──────────────────────────────────
#
# 之前这里写死 E:\cloudflared\...，别人 clone 到别的盘就跑不起来。
# 现在：
#   DSH_CLOUDFLARED    cloudflared 可执行文件（默认自动找）
#   DSH_STATE_DIR      状态目录（默认 %LOCALAPPDATA%\dsh-pocket）
#   DSH_POCKET_ROOT    仓库根（默认：本脚本所在目录）

$RepoRoot = if ($env:DSH_POCKET_ROOT) { $env:DSH_POCKET_ROOT } else { $PSScriptRoot }

$StateDir = if ($env:DSH_STATE_DIR) {
    $env:DSH_STATE_DIR
} else {
    Join-Path $env:LOCALAPPDATA 'dsh-pocket'
}
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

# cloudflared：环境变量 → PATH → 常见位置
$Cloudflared = $env:DSH_CLOUDFLARED
if (-not $Cloudflared -or -not (Test-Path $Cloudflared)) {
    $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($onPath) {
        $Cloudflared = $onPath.Source
    } else {
        $tries = @(
            'E:\cloudflared\cloudflared.exe',
            (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'),
            (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
        )
        $Cloudflared = $tries | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
}

$StateFile   = Join-Path $StateDir 'tunnel.json'
$PairingFile = Join-Path $StateDir 'pairing.json'
$LogFile     = Join-Path $StateDir 'tunnel.log'
$PidFile     = Join-Path $StateDir 'tunnel.pid'

# dsh 可执行文件：环境变量 → PATH → 常见安装位置
function Get-DshPath {
    if ($env:DSH_CLI -and (Test-Path $env:DSH_CLI)) { return $env:DSH_CLI }
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $cands = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        'E:\DSH\resources\runtime\cli\bin\dsh.cmd'
    )
    return $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [X] $msg" -ForegroundColor Red }

# ── 停止 ────────────────────────────────────────────────────────────
if ($Stop) {
    $stopped = $false
    if (Test-Path $PidFile) {
        $oldPid = (Get-Content $PidFile -Raw).Trim()
        if ($oldPid -match '^\d+$') {
            $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($p) {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                $stopped = $true
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    # 兜底：按进程名清理
    Get-Process -Name cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    if ($stopped) { Write-Ok '隧道已停止' } else { Write-Step '没有正在运行的隧道' }
    exit 0
}

# ── 状态 ────────────────────────────────────────────────────────────
function Get-TunnelState {
    if (-not (Test-Path $StateFile)) { return $null }
    try {
        return Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

if ($Status) {
    $st = Get-TunnelState
    if (-not $st) {
        Write-Step '当前没有隧道'
        exit 0
    }
    $alive = $false
    if ($st.pid) {
        $alive = [bool](Get-Process -Id $st.pid -ErrorAction SilentlyContinue)
    }
    Write-Host ''
    Write-Host "  域名:  $($st.url)"
    Write-Host "  目标:  $($st.target)"
    Write-Host "  启动:  $($st.startedAt)"
    Write-Host "  进程:  $(if ($alive) { "运行中 (PID $($st.pid))" } else { '已退出' })"
    Write-Host ''
    exit 0
}

# ── 启动 ────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host '  Cloudflare 快速隧道' -ForegroundColor Cyan
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host ''

if (-not (Test-Path $Cloudflared)) {
    Write-Err "找不到 cloudflared：$Cloudflared"
    Write-Step '下载地址：https://github.com/cloudflare/cloudflared/releases'
    exit 1
}

# 先停掉旧的，避免端口/域名冲突
if (Test-Path $PidFile) {
    $oldPid = (Get-Content $PidFile -Raw).Trim()
    if ($oldPid -match '^\d+$' -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Step '停掉已有隧道 ...'
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# 1. 确定绑定地址，必要时先把 DSH 拉起来
#
# 顺序很重要：cloudflared 要指向 DSH 的实际地址，所以 DSH 得先跑。
# 如果没跑，就按「内网段优先」猜一个地址先启动它 —— 启动后
# 再以实际监听地址为准。
$bindIp = $null
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if ($listening) {
    $real = $listening | Where-Object {
        $_.LocalAddress -ne '0.0.0.0' -and $_.LocalAddress -ne '::' -and $_.LocalAddress -notlike '127.*'
    } | Select-Object -First 1
    # 注意 $listening 可能是空数组（刚启动还没监听），要防一下
    $bindIp = if ($real) { $real.LocalAddress } elseif ($listening.Count -gt 0) { $listening[0].LocalAddress } else { $null }
    if (-not $bindIp) {
        # 已经监听在回环上，说明 DSH 在跑但绑的是 127.0.0.1
        Write-Warn2 'DSH 绑在回环地址上，隧道连不到。请用 -Bind lan 重启它。'
        exit 1
    }
    Write-Step "DSH 已在运行：$bindIp`:$Port"
} else {
    # 还没跑，挑一个可用的本机地址
    Write-Step "DSH 未运行，先启动它 ..."
    $skipPattern = 'vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Mihomo|Clash|TUN|TAP|Tailscale|ZeroTier|WSL|Bluetooth|蓝牙|Npcap'
    $cands = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' -and
            $_.InterfaceAlias -notmatch $skipPattern
        }
    # 优先选无线网卡（WLAN / Wi-Fi / 无线）。
    # 手机通常连 WiFi 或电脑开的热点，走这条线才通；
    # 有线网卡（以太网）可能是另一张网，手机到不了。
    # 之前按「内网段优先」挑，选中了以太网的 172.18.174.139，
    # 结果隧道指向一个手机根本连不上的地址。
    $wifi = $cands | Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-?Fi|无线|Wireless' } | Select-Object -First 1
    $pref = if ($wifi) { $wifi } else {
        $cands | Where-Object {
            $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or
            $_.IPAddress -match '^172\.(1[6-9]|2\d|3[01])\.'
        } | Select-Object -First 1
    }
    $chosen = if ($pref) { $pref } else { $cands | Select-Object -First 1 }
    if (-not $chosen) { Write-Err '找不到可用的本机 IPv4'; exit 1 }
    $bindIp = $chosen.IPAddress

    # 用计划任务启动（独立于本脚本，脚本退出不影响它）
    $dshExe = Get-DshPath
    if (-not $dshExe) { Write-Err '找不到 dsh'; exit 1 }

    $taskName0 = "DSH-Web-$Port"
    $a0 = "--profile web --no-open --host $bindIp --port $Port"

    # 生成批处理再由计划任务调用。
    # 直接在 /TR 里写重定向（cmd /c ""..."" > ""...""）引号嵌套太深，
    # schtasks 会解析失败 —— 任务建了但一跑就报「系统找不到指定的文件」。
    $batPath = Join-Path $env:TEMP "dsh-web-$Port-start.bat"
    $dshLog0 = Join-Path $env:TEMP "dsh-web-$Port.log"
    if (Test-Path $dshLog0) { Remove-Item $dshLog0 -Force -ErrorAction SilentlyContinue }
    $batLines = @(
        '@echo off',
        "`"$dshExe`" $a0 > `"$dshLog0`" 2>&1"
    )
    Set-Content -Path $batPath -Value $batLines -Encoding ASCII

    # 先删旧任务再建，否则 /F 有时不会覆盖
    $null = cmd /c "schtasks /Delete /TN `"$taskName0`" /F >nul 2>&1"
    $null = cmd /c "schtasks /Create /TN `"$taskName0`" /TR `"`"`"$batPath`"`"`" /SC ONCE /ST 00:00 /F >nul 2>&1"
    $null = cmd /c "schtasks /Run /TN `"$taskName0`" >nul 2>&1"

    # 等它起来
    $waitUntil = (Get-Date).AddSeconds(60)
    $l = $null
    while ((Get-Date) -lt $waitUntil) {
        Start-Sleep -Seconds 2
        $l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($l) { break }
    }
    if (-not $l) {
        Write-Err 'DSH 启动失败'
        # 打印诊断信息，别让用户对着「启动失败」干瞪眼
        Write-Step "任务名: $taskName0"
        Write-Step "批处理: $batPath"
        if (Test-Path $batPath) {
            Write-Step '批处理内容:'
            Get-Content $batPath -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        } else {
            Write-Step '批处理文件没生成（脚本在生成前就退出了）'
        }
        $q = cmd /c "schtasks /Query /TN `"$taskName0`" /FO LIST /V 2>&1"
        if ($q) {
            Write-Step '任务状态:'
            $q | Select-String -Pattern 'Task To Run|Status|Last Result|Scheduled Task State' | ForEach-Object { Write-Host "      $($_.Line.Trim())" -ForegroundColor DarkGray }
        }
        if (Test-Path "$dshLog") {
            Write-Step 'DSH 日志:'
            Get-Content "$dshLog" -ErrorAction SilentlyContinue | Select-Object -Last 5 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        }
        exit 1
    }
    Write-Step "DSH 已启动：$bindIp`:$Port"
}

# 重新查一次监听状态
#
# 上面的「未运行」分支会启动 DSH，但那个分支里的 $listening 还是启动前
# 查到的空值。这里必须重查，否则会误判成「无法确定监听地址」。
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

# 排除回环和通配地址；优先真实网卡地址
$real = $listening | Where-Object {
    $_.LocalAddress -ne '0.0.0.0' -and
    $_.LocalAddress -ne '::' -and
    $_.LocalAddress -notlike '127.*'
} | Select-Object -First 1

$bindIp = if ($real) { $real.LocalAddress } elseif ($listening.Count -gt 0) { $listening[0].LocalAddress } else { $null }

if (-not $bindIp -or $bindIp -eq '0.0.0.0') {
    Write-Err '无法确定 DSH 的监听地址'
    exit 1
}

# 找这个地址对应的网卡名，纯为显示
$nic = Get-NetIPAddress -IPAddress $bindIp -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty InterfaceAlias
Write-Ok "$bindIp  $(if ($nic) { "($nic)" } else { '' })"

$target = "http://${bindIp}:$Port"
Write-Step "目标：$target"

# 3. 启动 cloudflared
Write-Step '启动 cloudflared（http2 协议，QUIC 会被代理软件干扰）...'
if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }

$proc = Start-Process -FilePath $Cloudflared `
    -ArgumentList @('tunnel', '--url', $target, '--protocol', 'http2', '--no-autoupdate') `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError "$LogFile.err" `
    -WindowStyle Hidden -PassThru

if (-not $proc) {
    Write-Err '启动 cloudflared 失败'
    exit 1
}

$proc.Id | Set-Content $PidFile -Encoding UTF8
Write-Step "cloudflared PID: $($proc.Id)"

# 4. 等域名
Write-Step '等待 Cloudflare 分配域名（最多 60 秒）...'
$domain = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
        Write-Err "cloudflared 提前退出（code $($proc.ExitCode)）"
        Get-Content "$LogFile.err" -ErrorAction SilentlyContinue | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        exit 1
    }
    $txt = ''
    if (Test-Path $LogFile)       { $txt += (Get-Content $LogFile -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path "$LogFile.err") { $txt += (Get-Content "$LogFile.err" -Raw -ErrorAction SilentlyContinue) }
    $m = [regex]::Match($txt, 'https://([a-z0-9-]+\.trycloudflare\.com)')
    if ($m.Success) { $domain = $m.Groups[1].Value; break }
    Start-Sleep -Milliseconds 700
}

if (-not $domain) {
    Write-Err '60 秒内没拿到域名'
    Write-Step '常见原因：代理软件（Mihomo/Clash）劫持了到 Cloudflare 的连接'
    Get-Content "$LogFile.err" -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

$url = "https://$domain"
Write-Ok "域名：$url"

# 5. 重启 DSH，把隧道域名加进 --trusted-host
#
# 这一步是关键。DSH 的 Host/Origin 校验默认只接受「绑定的那个 IP」，
# 通过隧道访问时 Host 是 xxx.trycloudflare.com，不在信任列表里 → 403。
# 官方给反向代理场景的解法就是 --trusted-host，但它只做精确匹配，
# 不支持通配符，所以必须拿到域名之后才能重启服务。
#
# 代价：每次开隧道都会重启一次 DSH，已配对的手机 cookie 会失效
# （cookie 绑定了 authority，重启后端口/域名变了要重配）。
Write-Step '重启 DSH 并信任隧道域名 ...'

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$bindIp = if ($listener) { $listener.LocalAddress } else { $null }
if (-not $bindIp) {
    Write-Err '找不到 DSH 监听地址'
    exit 1
}

# 停掉旧 DSH
if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

$dshLog = Join-Path $env:TEMP "dsh-web-$Port.log"
if (Test-Path $dshLog) { Remove-Item $dshLog -Force -ErrorAction SilentlyContinue }

# 找 dsh 可执行文件
$dsh = Get-DshPath
if (-not $dsh) {
    Write-Err '找不到 dsh'
    exit 1
}

$env:DSH_PERMISSION_MODE = if ($env:DSH_PERMISSION_MODE) { $env:DSH_PERMISSION_MODE } else { 'workspace-write' }
$dshArgs = @('--profile', 'web', '--no-open', '--host', $bindIp, '--port', "$Port", '--trusted-host', $domain)

# 用计划任务启动 DSH，而不是 Start-Process。
# 原因：Start-Process 起的进程是脚本的子进程，脚本退出时可能被一起带走，
# 表现为「服务莫名其妙消失、手机连不上」。计划任务由 Task Scheduler 拉起，
# 完全独立于当前会话。
$taskName = "DSH-Web-$Port"
$argString = ($dshArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$action = "`"$dsh`" $argString"
# 让计划任务把 DSH 的输出重定向到日志文件。
#
# 为什么必须重定向：DSH 启动时会把带 token 的配对链接打到 stdout，
# 脚本要读它才知道新 token（没有 API 能查）。计划任务本身不保存输出，
# 所以要用 cmd /c 包一层做重定向。
#
# 注意路径里有空格，要整体加引号。
# 生成一个启动批处理，再由计划任务调用它。
#
# 为什么不直接在 /TR 里写重定向：schtasks 的 /TR 参数对引号嵌套极其挑剔，
# 三层引号（cmd /c ""..."" > ""...""）基本一定会被解析错，
# 表现是任务创建成功但一跑就报「系统找不到指定的文件」。
# 写成 .bat 之后 /TR 只需要指向一个没有空格歧义的路径。
$batPath = Join-Path $env:TEMP "dsh-web-$Port-start.bat"
$batLines = @(
    '@echo off',
    "`"$dsh`" $argString > `"$dshLog`" 2>&1"
)
Set-Content -Path $batPath -Value $batLines -Encoding ASCII

# 先删旧任务再建，否则 /F 有时不会覆盖
$null = cmd /c "schtasks /Delete /TN `"$taskName`" /F >nul 2>&1"
$null = cmd /c "schtasks /Create /TN `"$taskName`" /TR `"`"`"$batPath`"`"`" /SC ONCE /ST 00:00 /F >nul 2>&1"
$null = cmd /c "schtasks /Run /TN `"$taskName`" >nul 2>&1"

# 等 DSH 起来并抓新 token
#
# 注意：DSH 会独占锁定日志文件，直接 ReadAllBytes / Get-Content 会抛
# 「文件正由另一进程使用」。用 FileShare.ReadWrite 打开才能读。
$newToken = ''
$deadline2 = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline2) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path $dshLog)) { continue }
    $txt = ''
    try {
        $fs = [System.IO.File]::Open($dshLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs)
            $txt = $sr.ReadToEnd()
            $sr.Dispose()
        } finally {
            $fs.Dispose()
        }
    } catch {
        # 文件还没写好或被占用，下一轮再试
        continue
    }
    $tm = [regex]::Match($txt, '[?&]token=([A-Za-z0-9_\-]+)')
    if ($tm.Success) { $newToken = $tm.Groups[1].Value; break }
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Err 'DSH 重启失败'
    Get-Content "$dshLog.err" -ErrorAction SilentlyContinue | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    exit 1
}
Write-Ok "DSH 已重启（计划任务 $taskName）"

# 6. 验证隧道能通（用新 token）
Write-Step '验证隧道 ...'
$pairUrl = if ($newToken) { "$url/?token=$newToken" } else { $url }
$verified = $false
try {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(8)
    for ($i = 0; $i -lt 6; $i++) {
        try {
            $resp = $client.GetAsync($pairUrl).GetAwaiter().GetResult()
            $code = [int]$resp.StatusCode
            if ($code -eq 401 -or $code -eq 302 -or $code -eq 303 -or $code -eq 200) {
                $verified = $true
                break
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    $client.Dispose()
} catch { }
if ($verified) { Write-Ok '隧道连通' } else { Write-Warn2 '暂时没验证通（隧道可能还在生效，稍等再试）' }
# 6. 写状态文件给插件读
$state = [ordered]@{
    url       = $url
    domain    = $domain
    target    = $target
    pid       = $proc.Id
    startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    port      = $Port
    token     = $newToken
    pairUrl   = $pairUrl
}
$state | ConvertTo-Json -Depth 4 | Set-Content $StateFile -Encoding UTF8

# 同步更新 pairing.json，让插件两个二维码都带 token
try {
    $pairFile = $PairingFile
    $pair = [ordered]@{
        url       = "http://${bindIp}:$Port/?token=$newToken"
        token     = $newToken
        host      = $bindIp
        port      = $Port
        writtenAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    }
    $pair | ConvertTo-Json -Depth 3 | Set-Content $pairFile -Encoding UTF8
} catch { }

Write-Host ''
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host '  隧道已就绪' -ForegroundColor Green
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  手机配对地址（带 token，扫码或粘贴都行）：' -ForegroundColor White
Write-Host "  $pairUrl" -ForegroundColor Yellow
Write-Host ''
Write-Host '  在 DSH Outpost 里粘贴上面这个地址即可配对。' -ForegroundColor Gray
Write-Host '  也可以打开 DSH 网页 → 侧边栏「手机连接」扫二维码。' -ForegroundColor Gray
Write-Host ''
Write-Host '  注意：快速隧道每次重启域名都会变，手机需要重新配对。' -ForegroundColor DarkYellow
Write-Host '  另外 DSH 已用 --trusted-host 重启，之前的配对 cookie 会失效。' -ForegroundColor DarkYellow
Write-Host "  停止隧道：$PSCommandPath -Stop" -ForegroundColor DarkGray
Write-Host ''
