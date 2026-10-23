param([string]$Path)

$ErrorActionPreference = 'Stop'

# Node may inherit PowerShell 7's PSModulePath while starting Windows
# PowerShell 5.1. Load this host's own security module by absolute path.
try {
    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    if (-not (Test-Path -LiteralPath $securityModule -PathType Leaf)) {
        throw "Built-in security module was not found: $securityModule"
    }
    Import-Module -Name $securityModule -ErrorAction Stop
} catch {
    Write-Output "[ERROR] Could not load the built-in security module: $($_.Exception.Message)"
    exit 1
}

# Read only the mandatory integrity label; reading the audit SACL requires
# privileges that an ordinary file owner does not need for this repair.
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

try {
    if (-not $Path) {
        foreach ($candidate in @(
            (Join-Path $PSScriptRoot 'win-unpacked\DSH Outpost.exe'),
            (Join-Path $PSScriptRoot 'DSH Outpost.exe')
        )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $Path = $candidate
                break
            }
        }
    }
    if (-not $Path) { throw 'Cannot find DSH Outpost.exe. Specify -Path to its executable.' }
    $target = (Get-Item -LiteralPath $Path -Force).FullName
    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
        [System.IO.Path]::GetExtension($target) -ine '.exe') {
        throw 'The target must be one existing .exe file.'
    }

    $rid = [DSHOutpostIntegrity]::GetIntegrityRid($target)
    if ($rid -lt 0 -or $rid -ge 8192) {
        Write-Output "[OK] Executable integrity is already suitable: $target"
        exit 0
    }

    $originalAcl = Get-Acl -LiteralPath $target
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($originalAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentUser.Value) {
        throw 'The current user must own this executable. Run this repair as its owner.'
    }
    $accessSection = [System.Security.AccessControl.AccessControlSections]::Access
    $originalDacl = $originalAcl.GetSecurityDescriptorSddlForm($accessSection)
    $temporaryAcl = Get-Acl -LiteralPath $target
    $temporaryRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $currentUser,
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $temporaryAcl.AddAccessRule($temporaryRule)
    $restoreRequired = $false
    try {
        $restoreRequired = $true
        Set-Acl -LiteralPath $target -AclObject $temporaryAcl
        $result = & "$env:SystemRoot\System32\icacls.exe" $target /setintegritylevel M 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not set executable integrity to Medium: $($result -join ' ')"
        }
        $repairedRid = [DSHOutpostIntegrity]::GetIntegrityRid($target)
        if ($repairedRid -ge 0 -and $repairedRid -lt 8192) {
            throw 'The executable still has a Low integrity label after repair.'
        }
    } finally {
        if ($restoreRequired) {
            # Restore only the exact original DACL, preserving the new label.
            $restoredAcl = Get-Acl -LiteralPath $target
            $restoredAcl.SetSecurityDescriptorSddlForm($originalDacl, $accessSection)
            Set-Acl -LiteralPath $target -AclObject $restoredAcl
        }
    }
    Write-Output "[OK] Repaired Low integrity on this executable: $target"
    exit 0
} catch {
    Write-Output "[ERROR] Startup repair failed: $($_.Exception.Message)"
    exit 1
}
