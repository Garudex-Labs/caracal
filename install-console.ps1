# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Standalone Windows Console installer that downloads, verifies, and extracts Caracal release archives.

[CmdletBinding()]
param(
    [string]$Version = $env:CARACAL_VERSION,
    [string]$Prefix = $env:CARACAL_PREFIX,
    [string]$InstallDir = $env:CARACAL_INSTALL_DIR,
    [string]$Color = $env:CARACAL_INSTALL_COLOR,
    [string]$Progress = $env:CARACAL_INSTALL_PROGRESS,
    [switch]$Uninstall,
    [switch]$NoVerifyProvenance
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = 'Garudex-Labs/caracal'
if ([string]::IsNullOrEmpty($Version)) { $Version = 'latest' }
if ([string]::IsNullOrEmpty($InstallDir)) {
    if ([string]::IsNullOrEmpty($Prefix)) {
        $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\caracal'
    } else {
        $InstallDir = Join-Path $Prefix 'bin'
    }
}
$VerifyProvenance = $true
$RequireProvenance = $true
if ($env:CARACAL_REQUIRE_PROVENANCE -eq '0') {
    $RequireProvenance = $false
}
if ($env:CARACAL_VERIFY_PROVENANCE -eq '0' -or $NoVerifyProvenance) {
    $VerifyProvenance = $false
    $RequireProvenance = $false
}

if ([string]::IsNullOrEmpty($Color)) { $Color = 'default' }
$UseColor = switch ($Color.ToLowerInvariant()) {
    'always' { $true; break }
    'never' { $false; break }
    'default' { [string]::IsNullOrEmpty($env:NO_COLOR) -and $env:CI -ne 'true'; break }
    'auto' { -not [Console]::IsOutputRedirected -and [string]::IsNullOrEmpty($env:NO_COLOR); break }
    default { throw "unsupported color mode: $Color (use default, auto, always, or never)" }
}
if ([string]::IsNullOrEmpty($Progress)) { $Progress = 'default' }
$UseProgress = switch ($Progress.ToLowerInvariant()) {
    'always' { $true; break }
    'never' { $false; break }
    'default' { $env:CI -ne 'true'; break }
    'auto' { -not [Console]::IsErrorRedirected -and $env:CI -ne 'true'; break }
    default { throw "unsupported progress mode: $Progress (use default, auto, always, or never)" }
}
$ProgressPreference = if ($UseProgress) { 'Continue' } else { 'SilentlyContinue' }

function Write-CaracalMessage([string]$Label, [string]$Message, [ConsoleColor]$Color) {
    if ($UseColor) {
        Write-Host 'caracal-install' -NoNewline -ForegroundColor White
        Write-Host " $Label " -NoNewline -ForegroundColor $Color
        Write-Host $Message
    } else {
        Write-Host "caracal-install $Label $Message"
    }
}

function Write-Step([string]$Message) {
    Write-CaracalMessage '==>' $Message Cyan
}

function Write-Ok([string]$Message) {
    Write-CaracalMessage '[OK]' $Message Green
}

function Write-Info([string]$Message) {
    Write-CaracalMessage '[INFO]' $Message Cyan
}

function Write-CaracalWarning([string]$Message) {
    Write-CaracalMessage '[WARN]' $Message Yellow
}

function Write-Section([string]$Title) {
    Write-Host ''
    if ($UseColor) {
        Write-Host 'caracal-install ' -NoNewline -ForegroundColor White
        Write-Host $Title -ForegroundColor White
    } else {
        Write-Host "caracal-install $Title"
    }
}

if ($Uninstall) {
    $removed = $false
    foreach ($name in @('caracal.exe', 'caracal-console.exe')) {
        $path = Join-Path $InstallDir $name
        if (Test-Path $path) {
            Remove-Item -Force $path
            Write-Ok "Removed $path"
            $removed = $true
        }
    }
    if (-not $removed) {
        Write-Info "No Caracal binaries found in $InstallDir"
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not [string]::IsNullOrEmpty($userPath)) {
        $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -ine $InstallDir })
        $nextPath = $entries -join ';'
        if ($nextPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')
            Write-Info "Removed $InstallDir from user PATH. Open a new shell to pick it up."
        }
    }
    exit 0
}

$osArch = (Get-CimInstance Win32_OperatingSystem).OSArchitecture
switch -Wildcard ($osArch) {
    '64-bit*' { $arch = 'amd64' }
    default   { throw "unsupported architecture: $osArch (only amd64 binaries are published for Windows)" }
}

if ($Version -eq 'latest') {
    $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name
    if ([string]::IsNullOrEmpty($tag)) { throw 'could not resolve latest release tag from GitHub API' }
} else {
    $tag = $Version
}
if ($tag -notmatch '^v\d{4}\.\d{2}\.\d{2}(\.\d+)?(-rc\.(sha[0-9A-Za-z]+|\d+))?$') {
    throw "release tag $tag is not a supported Caracal release tag"
}
$base = "https://github.com/$repo/releases/download/$tag"

$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "caracal-install-$([guid]::NewGuid())")
try {
    Write-Section 'Caracal Console Installer'
    Write-Host "  Release:     $tag"
    Write-Host "  Platform:    windows-$arch"
    Write-Host "  Install dir: $InstallDir"
    if ($RequireProvenance) {
        Write-Host '  Provenance:  required'
    } elseif ($VerifyProvenance) {
        Write-Host '  Provenance:  verify when available'
    } else {
        Write-Host '  Provenance:  disabled'
    }
    Write-Host ''

    $sumsPath = Join-Path $tmp.FullName 'SHA256SUMS'
    Write-Step 'Downloading release manifest'
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing

    $sums = @{}
    foreach ($line in Get-Content $sumsPath) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            $sums[$Matches[2]] = $Matches[1].ToLower()
        }
    }

    function Stage-Archive([string]$Kind, [string]$BinName) {
        $archive = "caracal-$Kind-windows-$arch-$tag.zip"
        if (-not $sums.ContainsKey($archive)) { throw "no checksum for $archive in SHA256SUMS" }
        $archivePath = Join-Path $tmp.FullName $archive
        Write-Step "Downloading $archive"
        Invoke-WebRequest -Uri "$base/$archive" -OutFile $archivePath -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLower()
        if ($actual -ne $sums[$archive]) {
            throw "checksum mismatch for $archive (expected $($sums[$archive]), got $actual)"
        }
        Write-Ok "Checksum verified: $archive"
        if ($VerifyProvenance) {
            $gh = Get-Command gh -ErrorAction SilentlyContinue
            if (-not $gh) {
                if ($RequireProvenance) { throw 'gh is required for provenance verification' }
                Write-CaracalWarning "gh not found; skipping provenance verification for $archive"
            } else {
                & gh attestation verify $archivePath --repo $repo | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "provenance verification failed for $archive" }
                Write-Ok "Provenance verified: $archive"
            }
        }
        Expand-Archive -Path $archivePath -DestinationPath $tmp.FullName -Force
        $src = Join-Path $tmp.FullName "$BinName.exe"
        if (-not (Test-Path $src)) { throw "expected $BinName.exe inside $archive, not found" }
        $stagePath = Join-Path $stage.FullName "$BinName.exe"
        Move-Item -Force $src $stagePath
        return $stagePath
    }

    function Test-Archive([string]$Kind) {
        $archive = "caracal-$Kind-windows-$arch-$tag.zip"
        return $sums.ContainsKey($archive)
    }

    $stage = New-Item -ItemType Directory -Force -Path (Join-Path $tmp.FullName 'stage')
    $backup = New-Item -ItemType Directory -Force -Path (Join-Path $tmp.FullName 'backup')
    $staged = @{}
    $installedRuntime = $false
    if (Test-Archive -Kind 'runtime') {
        $installedRuntime = $true
        $staged['caracal.exe'] = Stage-Archive -Kind 'runtime' -BinName 'caracal'
    }
    $staged['caracal-console.exe'] = Stage-Archive -Kind 'console' -BinName 'caracal-console'

    $installPath = New-Item -ItemType Directory -Force -Path $InstallDir
    if (-not $installPath) { throw "failed to create or access install directory: $InstallDir" }
    $committed = $false
    $installed = @()
    try {
        foreach ($name in $staged.Keys) {
            $dest = Join-Path $InstallDir $name
            $backupPath = Join-Path $backup.FullName $name
            if (Test-Path $dest) {
                Move-Item -Force $dest $backupPath
            }
            Move-Item -Force $staged[$name] $dest
            $installed += $name
            Write-Ok "Installed $dest"
        }
        $committed = $true
    } finally {
        if (-not $committed) {
            foreach ($name in $staged.Keys) {
                $backupPath = Join-Path $backup.FullName $name
                if (Test-Path $backupPath) {
                    Move-Item -Force $backupPath (Join-Path $InstallDir $name)
                } elseif (($installed -contains $name) -and (Test-Path (Join-Path $InstallDir $name))) {
                    Remove-Item -Force (Join-Path $InstallDir $name)
                }
            }
        }
    }
} finally {
    Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -ieq $InstallDir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Info "Added $InstallDir to user PATH. Open a new shell to pick it up."
}

$mode = if ($tag -like '*-rc.*') { 'rc' } else { 'stable' }
Write-Ok 'Caracal Console is installed'
Write-Section 'Next steps'
Write-Host "  Release: $tag ($mode)"
if ($installedRuntime) {
    Write-Host '  Launch through runtime: caracal console'
}
Write-Host '  Launch directly: caracal-console'
Write-Section 'Uninstall'
if ($installedRuntime) {
    Write-Host "  Remove caracal.exe and caracal-console.exe from $InstallDir and the user PATH entry."
} else {
    Write-Host "  Remove caracal-console.exe from $InstallDir and the user PATH entry."
}
