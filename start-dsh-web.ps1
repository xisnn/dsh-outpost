#requires -Version 5.1
<#
.SYNOPSIS
  一键启动 DSH Web 服务，供手机端 App 配对使用。

.DESCRIPTION
  自动挑选一个手机能访问的地址来绑定：
    1. -Host 显式指定（最优先）
    2. Tailscale 内网 IP（装了并已登录 Tailscale 时）
    3. 局域网 IP（同一 WiFi 下可用，不需要 Tailscale）

  启动后从日志里抓出带 token 的 URL，打印出来并可选渲染二维码。

.EXAMPLE
  .\start-dsh-web.ps1
  默认：有 Tailscale 就用 tailnet IP，没有就用局域网 IP。

.EXAMPLE
  .\start-dsh-web.ps1 -Bind lan
  强制走局域网（只在同一 WiFi 下可用）。

.EXAMPLE
  .\start-dsh-web.ps1 -Host 0.0.0.0 -Port 3095
  绑定所有网卡，适合自己配了 frp / 反向隧道的情况。

.PARAMETER Port
  监听端口，默认 3095。

.PARAMETER Bind
  auto（默认，有 Tailscale 就用它）/ lan（强制局域网）/ tailscale（强制内网）。

.PARAMETER Host_
  显式指定绑定地址，优先级最高，如 0.0.0.0。

.PARAMETER PermissionMode
  read-only / workspace-write（默认）/ danger-full-access。
  danger-full-access 会同时关闭审批，不要在开放网络上使用。

.PARAMETER NoQr
  不输出终端二维码。

.PARAMETER AllowFirewall
  局域网模式下自动添加 Windows 防火墙放行规则（需要管理员权限）。
  不加时只检测并提示，不修改系统设置。
#>
[CmdletBinding()]
param(
  [int]$Port = 3095,
  [ValidateSet('auto', 'lan', 'tailscale')]
  [string]$Bind = 'auto',
  [string]$Host_ = '',
  [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
  [string]$PermissionMode = 'workspace-write',
  [switch]$NoQr,
  # 局域网模式下自动添加防火墙放行规则（需要管理员权限）
  [switch]$AllowFirewall,
# 跳过「网关管理接口认证补丁」完整性检查。
#
# 默认会检查：插件已安装时，补丁必须处于已应用状态，否则拒绝启动。
# 只有在你确认不用手机审批（不需要 /mgw/* 管理接口）时才该跳过。
[switch]$SkipGatewayPatchCheck,
[switch]$Foreground
)

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
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---- 定位 dsh ----
$dsh = $null
foreach ($c in @(
    $env:DSH_CLI,
    'E:\DSH\resources\runtime\cli\bin\dsh.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )) {
  if (-not $c) { continue }
  if (Test-Path $c) { $dsh = $c; break }
}
if (-not $dsh) {
  $g = Get-Command dsh -ErrorAction SilentlyContinue
  if ($g) { $dsh = $g.Source }
}
if (-not $dsh) {
  Write-Host '[X] 找不到 dsh。请先安装 DeepSeek Harness，或用 $env:DSH_CLI 指定路径。' -ForegroundColor Red
  exit 1
}
Write-Host "DSH: $dsh" -ForegroundColor DarkGray

# ---- 网关管理接口认证补丁完整性门禁 ----
#
# 为什么放在这里（而不是只在 setup-gateway.ps1 里查）：
#
# `/mgw/*` 管理接口（含能铸造配对码的 POST /mgw/pair）的访问控制，
# 依赖 patches/mobile-gateway-mgmt-auth/ 这个补丁。而补丁是打在
# ~/.dsh/profiles/web/node_modules/dsh-plugin-mobile-gateway/lib/index.mjs
# 上的 —— 一次插件升级或 npm install 就会把它抹掉。
#
# 如果只在 setup-gateway.ps1 里检查，那么：
#   用户装好一切 -> 上游插件更新 -> 用户只是正常重启 DSH ->
#   补丁已经没了，但 adminLoopbackOnly 仍是 false（配置还在）
#   -> 管理接口无认证地暴露在局域网上，而没人会察觉。
#
# 所以日常启动路径也必须查。查不到时：
#   - 默认拒绝启动（fail-closed）：宁可不能用，也不能裸奔
#   - 用 -SkipGatewayPatchCheck 可显式跳过（仅用于你确认不用手机审批时）
$patchScript = Join-Path $PSScriptRoot 'patches\mobile-gateway-mgmt-auth\apply.mjs'
$gatewayInstalled = Test-Path (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-plugin-mobile-gateway\package.json')

if (-not $SkipGatewayPatchCheck -and $gatewayInstalled -and (Test-Path $patchScript)) {
    # 两个坑必须一起避开：
    #   1. 脚本全局设了 ErrorActionPreference='Stop'，node 往 stderr 写东西时
    #      会被当成终止错误直接抛出，导致下面的 if 根本执行不到。
    #   2. 因此必须临时改回 Continue，并用 LASTEXITCODE 判断。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $patchOut = (& node $patchScript --check 2>&1 | Out-String)
        $patchExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }

    if ($patchExit -ne 0) {
        Write-Host ''
        Write-Host '[!] 网关管理接口认证补丁未生效 —— 拒绝启动。' -ForegroundColor Red
        Write-Host $patchOut.Trim() -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '    原因：插件可能刚被升级/重装，补丁被覆盖掉了。' -ForegroundColor Yellow
        Write-Host '    此时 /mgw/* 管理接口没有认证，配对码铸造对同网段可达。' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '    修复：node patches\mobile-gateway-mgmt-auth\apply.mjs --apply' -ForegroundColor Cyan
        Write-Host '    或重跑：.\setup-gateway.ps1' -ForegroundColor Cyan
        Write-Host ''
        Write-Host '    确认不需要手机审批、想强行启动：加 -SkipGatewayPatchCheck' -ForegroundColor DarkGray
        exit 1
    }
    Write-Host '网关认证补丁：已生效' -ForegroundColor DarkGray
}

# ---- 选绑定地址 ----
function Get-TailnetIp {
  $ts = 'C:\Program Files\Tailscale\tailscale.exe'
  if (-not (Test-Path $ts)) {
    $g = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($g) { $ts = $g.Source }
  }
  if (-not (Test-Path $ts)) { return $null }
  $ip = (& $ts ip -4 2>$null | Select-Object -First 1)
  if ($null -eq $ip) { return $null }
  $ip = ([string]$ip).Trim()
  if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { return $ip }
  return $null
}

function Get-LanIp {
  # 虚拟网卡特别多（WSL / VMware / Hyper-V / Mihomo TUN / 蓝牙 / 热点），
  # 光看 IP 段会挑到 198.18.x（Mihomo 的假地址）之类，必须按网卡类型和名字排掉。
  $virtualPattern = 'vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Mihomo|Clash|TUN|TAP|Tailscale|ZeroTier|WSL|Bluetooth|蓝牙|Npcap'
  try {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -ne '127.0.0.1' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.IPAddress -notlike '100.*' -and
        $_.InterfaceAlias -notmatch $virtualPattern
      } |
      Sort-Object -Property InterfaceMetric

    # 优先真正的内网段（192.168 / 10 / 172.16-31），其它网段放后面
    foreach ($wantPrivate in @($true, $false)) {
      foreach ($a in $candidates) {
        $ip = $a.IPAddress
        $isPrivate =
          $ip -like '192.168.*' -or
          $ip -like '10.*' -or
          ($ip -match '^172\.(1[6-9]|2\d|3[01])\.')
        if ($isPrivate -eq $wantPrivate) { return $ip }
      }
    }
  } catch { }
  return $null
}

$tailnetIp = Get-TailnetIp
$lanIp = Get-LanIp

$bindIp = $null
$via = ''
switch ($Bind) {
  'tailscale' {
    if (-not $tailnetIp) {
      Write-Host '[X] -Bind tailscale 但没读到 Tailscale IP，先确认 tailscale 已登录。' -ForegroundColor Red
      exit 1
    }
    $bindIp = $tailnetIp; $via = 'Tailscale'
  }
  'lan' {
    if (-not $lanIp) {
      Write-Host '[X] -Bind lan 但没读到局域网 IP。' -ForegroundColor Red
      exit 1
    }
    $bindIp = $lanIp; $via = '局域网'
  }
  default {
    if ($Host_) { $bindIp = $Host_; $via = '指定地址' }
    elseif ($tailnetIp) { $bindIp = $tailnetIp; $via = 'Tailscale（装了就用它，外网也能连）' }
    elseif ($lanIp) { $bindIp = $lanIp; $via = '局域网（同一 WiFi 可用）' }
  }
}
if (-not $bindIp) {
  Write-Host '[X] 没找到可用地址，用 -Host 手动指定。' -ForegroundColor Red
  exit 1
}
Write-Host "绑定地址: $bindIp  [$via]" -ForegroundColor Green
if ($lanIp -and $bindIp -ne $lanIp) {
  Write-Host "局域网地址: $lanIp（同一 WiFi 下也可用）" -ForegroundColor DarkGray
}

# ---- 端口检查 ----
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "[X] 端口 $Port 已被占用 (PID $($busy.OwningProcess))，换一个：-Port $($Port + 1)" -ForegroundColor Red
  exit 1
}

# ---- 防火墙检查（只对局域网绑定有意义）----
# Tailscale 走自己的虚拟网卡，不受 Windows 防火墙入站规则影响；
# 局域网直连则必须放行端口，否则手机连不上、而且报错很难懂（就是超时）。
function Test-LanFirewall {
  param([int]$Port)

  try {
    $profiles = Get-NetFirewallProfile -ErrorAction Stop
  } catch {
    return @{ Status = 'unknown'; Detail = '读不到防火墙配置（可能没有管理员权限）' }
  }

  $blocking = $profiles | Where-Object { $_.Enabled -and $_.DefaultInboundAction -eq 'Block' }
  if (-not $blocking) {
    return @{ Status = 'open'; Detail = '防火墙未开启入站拦截' }
  }

  # 已经放行过就不再重复提示
  $existing = @()
  try {
    $existing = @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like "DSH Mobile*$Port*" -and $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' })
  } catch {
    # 读不到就当没有，不影响主流程
  }
  if ($existing.Count -gt 0) {
    return @{ Status = 'allowed'; Detail = "已有放行规则：$($existing[0].DisplayName)" }
  }

  $names = ($blocking | ForEach-Object { $_.Name }) -join ' / '
  return @{
    Status  = 'blocked'
    Detail  = "入站默认拦截（$names），且没有放行 TCP $Port 的规则"
    Profile = $names
  }
}

$fw = Test-LanFirewall -Port $Port
$needFirewall = $false
if ($fw.Status -eq 'blocked') {
  # 只有绑到真实局域网地址时才需要放行
  $isLanBind = $bindIp -eq $lanIp -and $bindIp -notlike '100.*'
  if ($isLanBind) {
    $needFirewall = $true
    Write-Host ''
    Write-Host '[!] 防火墙可能挡住手机访问' -ForegroundColor Yellow
    Write-Host "    $($fw.Detail)" -ForegroundColor DarkYellow
    Write-Host '    手机连同一个 WiFi 时会一直卡在「连接失败 / 超时」。' -ForegroundColor DarkYellow
    if ($AllowFirewall) {
      Write-Host '    正在添加放行规则 ...' -ForegroundColor Cyan
      try {
        $ruleName = "DSH Mobile Web (TCP $Port)"
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
          -LocalPort $Port -Action Allow -Profile Private -ErrorAction Stop | Out-Null
        Write-Host "    [OK] 已添加：$ruleName（仅专用网络）" -ForegroundColor Green
        $needFirewall = $false
      } catch {
        Write-Host "    [X] 添加失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host '        需要以管理员身份运行，或手动放行。' -ForegroundColor DarkYellow
      }
    } else {
      Write-Host ''
      Write-Host '    手动放行（管理员 PowerShell，执行一次即可）：' -ForegroundColor White
      Write-Host "      New-NetFirewallRule -DisplayName 'DSH Mobile Web (TCP $Port)' ``" -ForegroundColor Gray
      Write-Host '        -Direction Inbound -Protocol TCP -LocalPort ' -NoNewline -ForegroundColor Gray
      Write-Host "$Port -Action Allow -Profile Private" -ForegroundColor Gray
      Write-Host ''
      Write-Host '    或者加 -AllowFirewall 参数让脚本自己加（需管理员）。' -ForegroundColor DarkGray
      Write-Host '    只在家里/自己的网络用的话，这一步可以跳过先试试。' -ForegroundColor DarkGray
    }
  }
} elseif ($fw.Status -eq 'allowed') {
  Write-Host "防火墙: $($fw.Detail)" -ForegroundColor DarkGray
} elseif ($fw.Status -eq 'open') {
  Write-Host '防火墙: 未拦截入站' -ForegroundColor DarkGray
}

# ---- 启动 ----
Write-Host ''
Write-Host "启动 dsh web（权限模式：$PermissionMode）..." -ForegroundColor Cyan
$env:DSH_PERMISSION_MODE = $PermissionMode

# 状态目录：日志、pairing.json、tunnel.json 都放这里。
# 这里含 token，权限要比 %TEMP% 严 —— 见下面的 ACL 收紧。
# （和 start-tunnel.ps1 / tunnel-service.mjs 保持一致）
$stateDir = if ($env:DSH_STATE_DIR) {
  $env:DSH_STATE_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'dsh-pocket'
}

# ⚠️ 这个日志里**含明文 token**（dsh 启动时会把配对 URL 打出来）。
#
# 原来放 %TEMP% 下，继承的 ACL 是 Modify —— 本机其他用户能读能改，
# 等于把 DSH 的钥匙放在公共目录。实测确认过 `%TEMP%\dsh-web-3095.log`
# 里有明文 token。
#
# 改成：状态目录下的 logs/，并收紧到只有当前用户可读。
$logDir = Join-Path $stateDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir ("dsh-web-" + $Port + ".log")
if (Test-Path $logFile) { Remove-Item $logFile -Force }

# 预建文件并收紧权限（Start-Process 重定向时会沿用已有文件的 ACL）
try {
  New-Item -ItemType File -Path $logFile -Force | Out-Null
  New-Item -ItemType File -Path "$logFile.err" -Force | Out-Null
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($f in @($logFile, "$logFile.err")) {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in @($me, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
      $acl.AddAccessRule(
        (New-Object System.Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow'))
      )
    }
    Set-Acl -Path $f -AclObject $acl
  }
} catch {
  Write-Host "  [提示] 日志文件权限收紧失败，该文件含 token，建议手动检查。" -ForegroundColor DarkYellow
}

$dshArgs = @('--profile', 'web', '--no-open', '--host', $bindIp, '--port', "$Port")

# 用 Start-Process + -PassThru，并且**不加 -Wait**：
# 这样 dsh 是独立进程，脚本退出不会把它带走。
# 之前用 ProcessStartInfo(UseShellExecute=false) 起 cmd.exe，子进程挂在
# 父进程的作业对象上，脚本被终止时服务跟着消失 —— 这就是
# 「服务莫名其妙自己退出、手机连不上」的根因。
$proc = Start-Process -FilePath $dsh -ArgumentList $dshArgs `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
  -WindowStyle Hidden -PassThru
if (-not $proc) { Write-Host "[X] 启动 dsh 失败" -ForegroundColor Red; exit 1 }

$url = $null
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-Path $logFile) {
    $text = Get-Content -Raw -Path $logFile -ErrorAction SilentlyContinue
    if ($text) {
      $m = [regex]::Match($text, 'https?://\S+\?token=\S+')
      if ($m.Success) { $url = $m.Value.Trim(); break }
    }
  }
  Start-Sleep -Milliseconds 400
}

if (-not $url) {
  Write-Host ''
  Write-Host "[X] 120 秒内没等到 token URL。日志：$logFile" -ForegroundColor Red
  Get-Content $logFile -ErrorAction SilentlyContinue | Select-Object -Last 25 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
  if (-not $proc.HasExited) { $proc.Kill() }
  exit 1
}

# ---- 把配对信息写成文件，供 DSH 插件读取 ----
#
# 插件在浏览器里，拿不到启动日志，也没有 API 能取 token。
# 所以这里主动把 { url, token, host, port } 落到一个固定位置，
# 插件用 /api/file 读它 —— 这样二维码里才能带上 token，
# 手机扫码才会被识别为「DSH 配对链接」。
try {
  # $stateDir 已在上面（日志那一段）定义过，这里直接用
  $pairFile = Join-Path $stateDir 'pairing.json'
  $pairDir = Split-Path $pairFile -Parent
  if (-not (Test-Path $pairDir)) { New-Item -ItemType Directory -Path $pairDir -Force | Out-Null }
  $tokMatch = [regex]::Match($url, '[?&]token=([A-Za-z0-9_\-]+)')
  $pair = [ordered]@{
    url   = $url
    token = if ($tokMatch.Success) { $tokMatch.Groups[1].Value } else { '' }
    host  = $bindIp
    port  = $Port
    writtenAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
  $pair | ConvertTo-Json -Depth 3 | Set-Content $pairFile -Encoding UTF8

  # 收紧权限：pairing.json 里有明文 token，等于这台 DSH 的钥匙。
  #
  # 默认继承的 ACL 会让本机其他用户（以及某些沙箱账号）能读它 ——
  # 实测发现 `XIS\CodexSandboxUsers` 有 ReadAndExecute。
  # 这里改成只有「当前用户 + SYSTEM + Administrators」可访问。
  #
  # 失败不影响主流程：某些文件系统（FAT32、网络盘）不支持 ACL。
  try {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)  # 断开继承，清空已有规则
    foreach ($id in @($me, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
      $acl.AddAccessRule(
        (New-Object System.Security.AccessControl.FileSystemAccessRule(
          $id, 'FullControl', 'Allow'
        ))
      )
    }
    Set-Acl -Path $pairFile -AclObject $acl
  } catch {
    Write-Host "  [提示] pairing.json 权限收紧失败（$($_.Exception.Message)）" -ForegroundColor DarkYellow
    Write-Host "         这个文件含明文 token，建议手动检查它的访问权限。" -ForegroundColor DarkYellow
  }
} catch {
  # 写不进去不影响主流程
}

# ---- 输出 ----
Write-Host ''
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host "  DSH 已启动 · $via" -ForegroundColor Green
Write-Host ('=' * 68) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  手机配对地址（含一次性 token，只给自己的手机看）：' -ForegroundColor White
Write-Host "  $url" -ForegroundColor Yellow
Write-Host ''
Write-Host '  手机端：' -ForegroundColor White
Write-Host '    1. 装 DSH Mobile（GitHub Releases 里的 APK）'
Write-Host '    2. 打开 App -> 扫码，对着下面这个二维码'
Write-Host '    3. 未装 Tailscale 时，手机和电脑需在同一个 WiFi'
Write-Host ''
Write-Host '  token 属于本次进程：重启服务会换一个，但已配对的手机不受影响（cookie 30 天）。' -ForegroundColor DarkYellow
Write-Host '  按 Ctrl+C 停止。' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoQr) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if ($py) {
    Write-Host '  QR:' -ForegroundColor White
    $env:DSH_QR_URL = $url
    $qr = 'import os,qrcode' + "`n" +
          'q=qrcode.QRCode(border=1)' + "`n" +
          'q.add_data(os.environ["DSH_QR_URL"])' + "`n" +
          'q.make(fit=True)' + "`n" +
          'for row in q.get_matrix():' + "`n" +
          '    print("    "+"".join("##" if c else "  " for c in row))'
    $qr | python -
    Write-Host ''
  } else {
    Write-Host '  （没装 python，跳过二维码；直接手输上面的地址也行）' -ForegroundColor DarkGray
    Write-Host ''
  }
}

# ---- 收尾 ----
#
# 默认**不等**服务结束：脚本打印完信息就退出，dsh 作为独立进程继续跑。
# 这样即使启动它的窗口/终端关掉，服务也不会跟着消失。
#
# 需要前台观察日志时加 -Foreground（比如排查启动失败）。
if ($Foreground) {
  Write-Host "  前台模式：按 Ctrl+C 停止服务（日志：$logFile）" -ForegroundColor DarkGray
  Write-Host ""
  try {
    while (-not $proc.HasExited) { Start-Sleep -Seconds 1 }
    Write-Host "服务已退出（code $($proc.ExitCode)）；日志：$logFile" -ForegroundColor DarkYellow
  } finally {
    if (-not $proc.HasExited) {
      Write-Host "正在停止..." -ForegroundColor DarkGray
      try { $proc.Kill($true) } catch { try { $proc.Kill() } catch {} }
    }
  }
} else {
  Write-Host "  服务在后台运行（PID $($proc.Id)），关闭这个窗口不影响它。" -ForegroundColor DarkGray
  Write-Host "  停止服务：Stop-Process -Id $($proc.Id)" -ForegroundColor DarkGray
  Write-Host ""
}