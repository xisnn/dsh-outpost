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
  [switch]$AllowFirewall
)

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

$logFile = Join-Path $env:TEMP ("dsh-web-" + $Port + ".log")
if (Test-Path $logFile) { Remove-Item $logFile -Force }

$argLine = '/c ""' + $dsh + '" --profile web --no-open --host ' + $bindIp + ' --port ' + $Port + ' > "' + $logFile + '" 2>&1"'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = $argLine
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

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

try {
  while (-not $proc.HasExited) { Start-Sleep -Seconds 1 }
  Write-Host "服务已退出（code $($proc.ExitCode)）；日志：$logFile" -ForegroundColor DarkYellow
} finally {
  if (-not $proc.HasExited) {
    Write-Host '正在停止...' -ForegroundColor DarkGray
    try { $proc.Kill($true) } catch { try { $proc.Kill() } catch {} }
  }
}
