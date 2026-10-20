<#
.SYNOPSIS
    配置开机自启：DSH Web 服务 + 隧道控制服务。

.DESCRIPTION
    用「启动文件夹」而不是计划任务，原因：
      - 计划任务的 /SC ONLOGON 需要管理员权限，普通用户会拿到「访问被拒绝」
      - 启动文件夹对当前用户无需提权，登录即运行

    会创建三个快捷方式：
      DSH-Web.lnk              → 启动 DSH Web（自动挑当前 WLAN 地址）
      DSH-Tunnel-Service.lnk   → 启动隧道控制服务（127.0.0.1:3199）

    两个快捷方式都指向 powershell.exe 并带 -WindowStyle Hidden 参数。
    注意不能把 TargetPath 直接设成 .ps1 —— Windows 会用记事本打开它。

.PARAMETER Remove
    移除开机自启。

.PARAMETER Show
    查看当前配置。

.EXAMPLE
    .\setup-autostart.ps1
    .\setup-autostart.ps1 -Show
    .\setup-autostart.ps1 -Remove
#>
param(
    [switch]$Remove,
    [switch]$Show
)

$ErrorActionPreference = 'Stop'

$RepoRoot = 'E:\work\dsBot'
$StartupDir = [Environment]::GetFolderPath('Startup')

# 自启项定义
$Items = @(
    @{
        Name    = 'DSH-Web'
        Script  = Join-Path $RepoRoot 'start-dsh-web.ps1'
        Args    = '-Bind lan -Port 3095 -NoQr'
        Desc    = 'DSH Web 服务（手机连接用）'
    },
    @{
        Name    = 'DSH-Tunnel-Service'
        Script  = Join-Path $RepoRoot 'start-tunnel-service.ps1'
        Args    = ''
        Desc    = '隧道控制服务（插件「启动隧道」按钮的后端）'
    }
)

function Write-Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Off($m)  { Write-Host "  [-] $m" -ForegroundColor DarkGray }
function Write-Err2($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  DSH Pocket 开机自启' -ForegroundColor Cyan
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''

# ── 查看 ──
if ($Show) {
    Write-Step "启动文件夹：$StartupDir"
    Write-Host ''
    foreach ($it in $Items) {
        $lnk = Join-Path $StartupDir ($it.Name + '.lnk')
        if (Test-Path $lnk) {
            $ws = New-Object -ComObject WScript.Shell
            $s = $ws.CreateShortcut($lnk)
            Write-Ok "$($it.Name)"
            Write-Host "      目标: $($s.TargetPath)" -ForegroundColor DarkGray
            Write-Host "      参数: $($s.Arguments)" -ForegroundColor DarkGray
        } else {
            Write-Off "$($it.Name)（未配置）"
        }
    }
    Write-Host ''
    exit 0
}

# ── 移除 ──
if ($Remove) {
    foreach ($it in $Items) {
        $lnk = Join-Path $StartupDir ($it.Name + '.lnk')
        if (Test-Path $lnk) {
            Remove-Item $lnk -Force
            Write-Ok "已移除 $($it.Name)"
        } else {
            Write-Off "$($it.Name)（本来就没有）"
        }
    }
    Write-Host ''
    Write-Host '  开机不会再自动启动了。' -ForegroundColor Gray
    Write-Host ''
    exit 0
}

# ── 配置 ──
$psExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }

foreach ($it in $Items) {
    $script = $it.Script
    if (-not (Test-Path $script)) {
        Write-Err2 "找不到脚本：$script"
        continue
    }

    $lnk = Join-Path $StartupDir ($it.Name + '.lnk')
    $args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
    if ($it.Args) { $args += ' ' + $it.Args }

    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $psExe
    $s.Arguments = $args
    $s.WindowStyle = 7   # 最小化
    $s.Description = $it.Desc
    $s.Save()

    # 读回来验证
    $v = $ws.CreateShortcut($lnk)
    if ($v.TargetPath -like '*powershell.exe') {
        Write-Ok "$($it.Name)"
        Write-Host "      $($it.Desc)" -ForegroundColor DarkGray
    } else {
        Write-Err2 "$($it.Name) 配置失败（目标不是 powershell.exe）"
    }
}

Write-Host ''
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host '  配置完成' -ForegroundColor Green
Write-Host ('=' * 62) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  下次登录 Windows 时会自动启动：' -ForegroundColor White
Write-Host '    - DSH Web（自动挑当前 WLAN 地址，IP 变了也不会失败）' -ForegroundColor Gray
Write-Host '    - 隧道控制服务（插件「启动隧道」按钮的后端）' -ForegroundColor Gray
Write-Host ''
Write-Host "  查看：$PSCommandPath -Show" -ForegroundColor DarkGray
Write-Host "  取消：$PSCommandPath -Remove" -ForegroundColor DarkGray
Write-Host ''
