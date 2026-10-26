param(
    [string]$Path,
    [switch]$Recurse,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# ═══════════════════════════════════════════════════════════════════
#  修复 Windows「低完整性」标记
#
#  ## 为什么需要
#
#  如果程序装在一个继承了 Low 完整性标记的目录里，Windows 会把
#  进程降级到 Low。Low 进程不能写 Medium 级别的文件 —— 而 Electron
#  启动时要写缓存、crashpad、用户数据，于是一启动就崩，且：
#
#    · 没有窗口
#    · 没有托盘
#    · 没有崩溃日志（写日志本身就失败了）
#
#  ## 为什么只修 exe 不够（关键）
#
#  第一版只对 exe 执行 `icacls /setintegritylevel M`，结果还是打不开。
#
#  原因：**目录的完整性标记会传递给从它启动的进程**。
#  exe 是 Medium 了，但它所在的目录还是 Low，进程仍然跑在 Low 下。
#
#  所以必须把**整条目录链**（从 exe 所在目录一直到盘符根）都提升到
#  Medium —— 至少到 exe 的直接父目录。
#
#  ## 为什么不能只改 exe 的父目录
#
#  因为父目录的 Low 是从更上层继承来的。只改一层的话，下次有文件
#  写进去（或者目录被重建）又会继承回 Low。
#
#  所以这里往上走到第一个「不是 Low」的目录为止。
# ═══════════════════════════════════════════════════════════════════

function Get-IntegrityRid {
    param([string]$Target)

    if (-not ('DSHOutpostIntegrity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DSHOutpostIntegrity {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetNamedSecurityInfoW(string name, int type,
        uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl,
        out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static int GetIntegrityRid(string path) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetNamedSecurityInfoW(path, 1, 0x10,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception((int)result);
        try {
            if (sacl == IntPtr.Zero) return -1;
            int count = (ushort)Marshal.ReadInt16(sacl, 4);
            int lowest = Int32.MaxValue;
            for (int index = 0; index < count; index++) {
                IntPtr ace;
                if (!GetAce(sacl, index, out ace))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Marshal.ReadByte(ace) != 0x11) continue;
                int subAuthorities = Marshal.ReadByte(ace, 9);
                if (subAuthorities < 1)
                    throw new InvalidOperationException("Invalid integrity label SID.");
                int rid = Marshal.ReadInt32(ace, 16 + (subAuthorities - 1) * 4);
                lowest = Math.Min(lowest, rid);
            }
            return lowest == Int32.MaxValue ? -1 : lowest;
        } finally {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }
}
'@
    }

    return [DSHOutpostIntegrity]::GetIntegrityRid($Target)
}

# 完整性 RID：0=Untrusted 4096=Low 8192=Medium 12288=High 16384=System
function Test-IsLow {
    param([int]$Rid)
    return ($Rid -ge 0 -and $Rid -lt 8192)
}

function Get-LevelName {
    param([int]$Rid)
    if ($Rid -lt 0) { return 'none' }
    if ($Rid -lt 4096) { return 'Untrusted' }
    if ($Rid -lt 8192) { return 'Low' }
    if ($Rid -lt 12288) { return 'Medium' }
    return 'High+'
}

function Repair-Integrity {
    param([string]$Target)

    $rid = Get-IntegrityRid -Target $Target
    $name = Get-LevelName -Rid $rid

    if (-not (Test-IsLow -Rid $rid)) {
        Write-Host "  [ok]   $name  $Target"
        return $false
    }

    if ($WhatIf) {
        Write-Host "  [low]  $name  $Target  (would repair)"
        return $true
    }

    try {
        $result = & "$env:SystemRoot\System32\icacls.exe" $Target /setintegritylevel M 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [fail] $name  $Target"
            Write-Host "         icacls: $($result -join ' ')"
            return $false
        }
        $after = Get-IntegrityRid -Target $Target
        $afterName = Get-LevelName -Rid $after
        if (Test-IsLow -Rid $after) {
            Write-Host "  [fail] $name -> $afterName  $Target  (still low)"
            return $false
        }
        Write-Host "  [fixed] $name -> $afterName  $Target"
        return $true
    } catch {
        Write-Host "  [fail] $name  $Target"
        Write-Host "         $($_.Exception.Message)"
        return $false
    }
}

try {
    if (-not $Path) {
        $here = $PSScriptRoot
        foreach ($candidate in @(
            (Join-Path $here 'win-unpacked\DSH Outpost.exe'),
            (Join-Path $here 'DSH Outpost.exe')
        )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $Path = $candidate
                break
            }
        }
    }
    if (-not $Path) {
        throw 'Cannot find DSH Outpost.exe. Pass -Path to its location.'
    }

    $exe = (Get-Item -LiteralPath $Path -Force).FullName
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
        [System.IO.Path]::GetExtension($exe) -ine '.exe') {
        throw "Not an .exe file: $exe"
    }

    Write-Host 'Repairing Windows integrity labels'
    Write-Host ''

    $fixedCount = 0

    # 1. exe 本身
    if (Repair-Integrity -Target $exe) { $fixedCount++ }

    # 2. 往上遍历目录链，直到遇到不是 Low 的目录为止。
    #
    # 为什么要往上走：Low 是「继承」来的，只改 exe 的父目录，
    # 下次目录重建/文件写入还是会继承回 Low。
    # 走到盘符根或者遇到第一个非 Low 的目录就停。
    $dir = Split-Path -Parent $exe
    $guard = 0
    while ($dir -and $guard -lt 12) {
        $guard++

        # 到盘符根（D:\ 这种）就停 —— 不要改盘根
        if ($dir -match '^[A-Za-z]:\\?$') {
            Write-Host "  [skip] drive root  $dir"
            break
        }

        $dirRid = Get-IntegrityRid -Target $dir
        if (-not (Test-IsLow -Rid $dirRid)) {
            Write-Host "  [stop] $(Get-LevelName -Rid $dirRid)  $dir  (already fine, stop walking up)"
            break
        }

        if (Repair-Integrity -Target $dir) { $fixedCount++ }

        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }

    # 3. -Recurse：把目录里所有文件也修一遍。
    #
    # 打包出来的目录里有几十个 dll / pak / dat，它们各自也可能带着
    # Low 标记。Electron 加载 dll 时如果遇到 Low 依赖，同样会出问题。
    if ($Recurse) {
        Write-Host ''
        Write-Host 'Repairing files inside the folder'
        $folder = Split-Path -Parent $exe
        $items = Get-ChildItem -LiteralPath $folder -Recurse -File -Force -ErrorAction SilentlyContinue
        foreach ($item in $items) {
            if (Repair-Integrity -Target $item.FullName) { $fixedCount++ }
        }
    }

    Write-Host ''
    if ($fixedCount -eq 0) {
        Write-Host '[OK] Nothing to repair - integrity labels are already correct.'
    } else {
        Write-Host "[OK] Repaired $fixedCount item(s)."
    }
    exit 0
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)"
    exit 1
}
