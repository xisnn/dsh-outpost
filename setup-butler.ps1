#requires -Version 5.1
<#
.SYNOPSIS
    Install the DSH Outpost host task runner into a DSH profile.
.DESCRIPTION
    Installs the local bundle, then requires successful composition of an enabled
    outpost-butler entry. Saves profile manifests, lockfiles and configuration for
    rollback on install/compose failure. Installed dependencies cannot be fully
    rolled back; the backup is retained for recovery.
    An occupied port is never stopped: restart the selected profile manually.
.PARAMETER Profile
    DSH profile name under DSH_HOME (default: web).
.PARAMETER Port
    DSH Web port used when starting. Default: 3095.
.PARAMETER NoRestart
    Only install and verify; do not start DSH Web.
.EXAMPLE
    .\setup-butler.ps1 -Profile web -NoRestart
#>
param(
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_.-]*\z')]
    [string]$Profile = 'web',
    [ValidateRange(1, 65535)]
    [int]$Port = 3095,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\butler-installer.ps1')

$BundleName = '@local/dsh-outpost-butler'
$BundleDir = Join-Path $PSScriptRoot 'dsh-outpost-butler'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$ProfilePkg = Join-Path $ProfileDir 'package.json'

function Write-Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '  DSH Outpost - host butler task runner' -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath (Join-Path $BundleDir 'package.json'))) {
    Write-Err2 "Bundle not found: $BundleDir"
    exit 1
}
if (-not (Test-Path -LiteralPath $ProfilePkg -PathType Leaf)) {
    Write-Err2 "Profile not found: $ProfileDir"
    Write-Step 'Start the selected DSH profile once, then run this script again.'
    exit 1
}

$dsh = $env:DSH_CLI
if (-not $dsh -or -not (Test-Path -LiteralPath $dsh)) {
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($onPath) {
        $dsh = $onPath.Source
    } else {
        $cands = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
            (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
            'E:\DSH\resources\runtime\cli\bin\dsh.cmd'
        )
        $dsh = $cands | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $dsh) {
    Write-Err2 'Cannot find dsh. Set DSH_CLI or add dsh to PATH.'
    exit 1
}
Write-Step "dsh: $dsh"
Write-Step "profile: $ProfileDir"

$installLock = $null
$records = $null
$backupDir = Join-Path $ProfileDir ('.butler-install-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
try {
    # Hold an exclusive, automatically deleted lock through composition. Refuse
    # concurrent installers instead of letting one roll back the other's edits.
    $lockPath = Join-Path $ProfileDir '.butler-install.lock'
    $installLock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    $beforePkg = Get-Content -LiteralPath $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    $records = @(Backup-ButlerInstallFiles -ProfileDir $ProfileDir -BackupDir $backupDir)
    Write-Step "backup: $backupDir"

    Write-Step "packaging $BundleName ..."
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required to package the local bundle. Install Node.js/npm, then retry.' }
    # A directory install becomes an external symlink under pnpm. DSH's shared
    # runtime imports resolve correctly only when the package lives in its profile.
    $pack = Invoke-ButlerCli -Cli $npm.Source -CliArguments @('pack', $BundleDir,
        '--ignore-scripts', '--silent', '--pack-destination', $backupDir)
    if ($pack.ExitCode -ne 0) { throw "npm pack failed (exit $($pack.ExitCode)). $($pack.Output.TrimEnd())" }
    $archives = @(Get-ChildItem -LiteralPath $backupDir -Filter '*.tgz' -File)
    if ($archives.Count -ne 1) { throw 'npm pack did not produce exactly one bundle archive.' }
    # pnpm can retain an old link: resolution when replacing a source directory
    # with an archive of the same version. Remove only this dependency first.
    $wasInstalled = @('dependencies', 'devDependencies', 'optionalDependencies') | Where-Object {
        $beforePkg.$_ -and ($beforePkg.$_.PSObject.Properties.Name -ccontains $BundleName)
    }
    if ($wasInstalled) {
        $remove = Invoke-ButlerCli -Cli $dsh -CliArguments @('plugin', '--profile', $Profile, 'remove', $BundleName)
        if ($remove.ExitCode -ne 0) { throw "dsh plugin remove failed (exit $($remove.ExitCode)). $($remove.Output.TrimEnd())" }
    }
    Write-Step "installing $BundleName ..."
    $add = Invoke-ButlerCli -Cli $dsh -CliArguments @('plugin', '--profile', $Profile, 'add', $archives[0].FullName)
    if ($add.Output) { Write-Step $add.Output.TrimEnd() }
    if ($add.ExitCode -ne 0) { throw "dsh plugin add failed (exit $($add.ExitCode))" }

    $pkg = Get-Content -LiteralPath $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg -isnot [pscustomobject]) { throw 'Profile manifest must be a JSON object.' }
    foreach ($field in @('dsh', 'profile')) {
        $parent = if ($field -eq 'dsh') { $pkg } else { $pkg.dsh }
        if ($null -eq $parent.$field) {
            $parent | Add-Member -NotePropertyName $field -NotePropertyValue ([pscustomobject]@{}) -Force
        } elseif ($parent.$field -isnot [pscustomobject]) {
            throw "Profile manifest $field must be an object."
        }
    }
    $bundles = @($pkg.dsh.profile.bundles | Where-Object { $null -ne $_ })
    foreach ($bundle in $bundles) {
        if ($bundle -isnot [string]) { throw 'Profile bundles must be package names.' }
    }
    # Normalize only this bundle; preserve all other entries and their order.
    $bundles = @($bundles | Where-Object { $_ -cne $BundleName }) + @($BundleName)
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($bundles) -Force
    [IO.File]::WriteAllText($ProfilePkg, ($pkg | ConvertTo-Json -Depth 100), (New-Object System.Text.UTF8Encoding($false)))

    $installedPkg = Join-Path $ProfileDir 'node_modules\@local\dsh-outpost-butler\package.json'
    if (-not (Test-Path -LiteralPath $installedPkg -PathType Leaf) -or
        (Get-Content -LiteralPath $installedPkg -Raw -Encoding UTF8 | ConvertFrom-Json).name -cne $BundleName) {
        throw 'CLI did not install the expected bundle package; no fallback link was created.'
    }

    Write-Step 'verifying composed profile ...'
    $dump = Invoke-ButlerCli -Cli $dsh -CliArguments @('--profile', $Profile, '--dump-config')
    if ($dump.ExitCode -ne 0) { throw "dsh dump-config failed (exit $($dump.ExitCode)). $($dump.Output.TrimEnd())" }
    if (-not (Test-ButlerComposedConfig -Text $dump.Output)) {
        throw 'dump-config did not contain exactly one enabled outpost-butler entry with the expected package name.'
    }
    Write-Ok 'Profile installed and composition verified (runtime health not checked).'
} catch {
    Write-Err2 $_.Exception.Message
    if ($records) {
        try {
            Restore-ButlerInstallFiles -ProfileDir $ProfileDir -BackupDir $backupDir -Records $records
            Write-Warn2 'Restored recorded profile manifests, lockfiles and configuration.'
        } catch {
            Write-Err2 "Profile file rollback incomplete: $($_.Exception.Message)"
        }
        Write-Warn2 'Dependencies/node_modules may have changed; full dependency rollback is not available.'
        Write-Step "Recovery backup: $backupDir"
        Write-Step "Review dependencies and run: dsh plugin --profile $Profile install (with the same DSH_HOME)."
    }
    exit 1
} finally {
    if ($installLock) { $installLock.Dispose() }
}

# Installation is now committed. Startup failure does not undo a valid install.
if ($NoRestart) {
    Write-Warn2 "NoRestart set; restart profile '$Profile' manually with the same DSH_HOME to load the bundle."
    exit 0
}

try {
    # Without authenticated profile + DSH_HOME identity, even a DSH-looking PID
    # is not safe to stop. Never pass -Restart to the launcher here.
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
    # Get-NetTCPConnection reports an error when no connections match. Query
    # the full table instead; a genuine query failure must prevent startup.
    try {
        $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port })
    } catch {
        Write-Warn2 'Cannot inspect listeners; installed successfully, but no service was started. Restart manually.'
        exit 0
    }
}
if ($connections.Count) {
    Write-Warn2 "Port $Port is occupied; left its listener running. Restart profile '$Profile' manually with the same DSH_HOME to load the bundle."
    exit 0
}

$startScript = Join-Path $PSScriptRoot 'start-dsh-web.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    Write-Err2 'Installed, but start-dsh-web.ps1 is missing; restart manually.'
    exit 1
}
Write-Step "starting DSH Web profile '$Profile' ..."
# Calling with an argument array preserves paths containing spaces and inherits
# DSH_HOME. Await the launcher's result instead of trusting a port listener.
$launch = Invoke-ButlerCli -Cli 'powershell.exe' -CliArguments @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $startScript,
    '-Profile', $Profile, '-Bind', 'lan', '-Port', "$Port", '-NoQr'
)
if ($launch.Output) { Write-Step $launch.Output.TrimEnd() }
if ($launch.ExitCode -ne 0) {
    Write-Err2 'Installed, but DSH Web startup failed; check the launcher log and restart manually.'
    exit 1
}
Write-Ok 'Launcher completed. TaskApi runtime health has not been checked.'
exit 0
