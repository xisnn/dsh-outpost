# Shared installer checks. No services or CLI commands run when dot-sourced.
function Invoke-ButlerCli {
    param([string]$Cli, [string[]]$CliArguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Native stderr is diagnostic output, not the success criterion (PS 5.1).
        # Native commands update the global automatic variable. A local null
        # would shadow their result and incorrectly reject successful commands.
        $global:LASTEXITCODE = $null
        $output = (& $Cli @CliArguments 2>&1 | Out-String)
        $code = $global:LASTEXITCODE
        if ($null -eq $code) { $code = 1 }
        return [pscustomobject]@{ ExitCode = [int]$code; Output = [string]$output }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-ButlerComposedConfig {
    param([string]$Text)
    # DSH --dump-config emits a flat YAML plugin list. Accept only its explicit
    # id/name form. Unknown formats and dynamic/true disabled values fail closed.
    # A comment, error message, bundle header, or similarly named plugin is not proof.
    $entries = [regex]::Matches($Text, '(?m)^- id:[^\r\n]*(?:\r?\n(?!- |# == )[^\r\n]*)*')
    $found = @()
    foreach ($entry in $entries) {
        if ($entry.Value -match '(?m)^- id:\s*[''"]?outpost-butler[''"]?\s*(?:#.*)?$') {
            $found += $entry.Value
        }
    }
    if ($found.Count -ne 1) { return $false }
    $block = $found[0]
    $names = [regex]::Matches($block, '(?m)^  name:[^\r\n]*')
    if ($names.Count -ne 1 -or $names[0].Value -notmatch '^  name:\s*[''"]?@local/dsh-outpost-butler[''"]?\s*(?:#.*)?$') {
        return $false
    }
    $disabled = [regex]::Matches($block, '(?m)^  disabled:[^\r\n]*')
    if ($disabled.Count -gt 1) { return $false }
    if ($disabled.Count -eq 1 -and $disabled[0].Value -notmatch '^  disabled:\s*false\s*(?:#.*)?$') { return $false }
    # Reject YAML aliases/merge keys and multiline scalar ambiguity in this entry.
    if ($block -match '(?m)^  <<:|^  (?:name|disabled):\s*[>|&*!]') { return $false }
    return $true
}

function Get-ButlerInstallFiles {
    # Also record generated configuration and package-manager metadata that the
    # CLI may write. Absent files are recorded so rollback removes new ones.
    return @('package.json', 'pnpm-lock.yaml', 'package-lock.json',
        'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
        'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml',
        'node_modules/.package-lock.json', 'node_modules/.modules.yaml',
        'node_modules/.pnpm/lock.yaml')
}

function Backup-ButlerInstallFiles {
    param([string]$ProfileDir, [string]$BackupDir)
    New-Item -ItemType Directory -Path $BackupDir -ErrorAction Stop | Out-Null
    $records = @(foreach ($relative in (Get-ButlerInstallFiles)) {
        $source = Join-Path $ProfileDir $relative
        $exists = Test-Path -LiteralPath $source -PathType Leaf
        if ($exists) {
            $destination = Join-Path $BackupDir $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        }
        [pscustomobject]@{ Path = $relative; Existed = $exists }
    })
    $records | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BackupDir 'snapshot.json') -Encoding UTF8
    return $records
}

function Restore-ButlerInstallFiles {
    param([string]$ProfileDir, [string]$BackupDir, [object[]]$Records)
    $errors = @()
    foreach ($record in $Records) {
        try {
            $destination = Join-Path $ProfileDir $record.Path
            if ($record.Existed) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force -ErrorAction Stop | Out-Null
                [IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes((Join-Path $BackupDir $record.Path)))
            } elseif (Test-Path -LiteralPath $destination) {
                Remove-Item -LiteralPath $destination -Force -ErrorAction Stop
            }
        } catch { $errors += "$($record.Path): $($_.Exception.Message)" }
    }
    if ($errors.Count) { throw ($errors -join '; ') }
}
