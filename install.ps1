# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# One-shot Windows installer that downloads the matching caracal binary from a GitHub Release and verifies it against SHA256SUMS.

[CmdletBinding()]
param(
    [string]$Version = $env:CARACAL_VERSION,
    [string]$InstallDir = $env:CARACAL_INSTALL_DIR
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = 'Garudex-Labs/caracal'
if ([string]::IsNullOrEmpty($Version)) { $Version = 'latest' }
if ([string]::IsNullOrEmpty($InstallDir)) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\caracal'
}

$arch = (Get-CimInstance Win32_OperatingSystem).OSArchitecture
switch -Wildcard ($arch) {
    '64-bit*' { $target = 'caracal-windows-x64.exe'; $tuiTarget = 'caracal-tui-windows-x64.exe' }
    default   { throw "unsupported architecture: $arch (only x64 binaries are published for Windows)" }
}

if ($Version -eq 'latest') {
    $base = "https://github.com/$repo/releases/latest/download"
} else {
    $base = "https://github.com/$repo/releases/download/$Version"
}

$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "caracal-install-$([guid]::NewGuid())")
try {
    $sumsPath = Join-Path $tmp.FullName 'SHA256SUMS'
    Write-Host "caracal-install: downloading SHA256SUMS"
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing

    $sums = @{}
    foreach ($line in Get-Content $sumsPath) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            $sums[$Matches[2]] = $Matches[1].ToLower()
        }
    }

    function Verify-Hash([string]$Path, [string]$Name) {
        if (-not $sums.ContainsKey($Name)) { throw "no checksum for $Name in SHA256SUMS" }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
        if ($actual -ne $sums[$Name]) { throw "checksum mismatch for $Name (expected $($sums[$Name]), got $actual)" }
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $dest = Join-Path $InstallDir 'caracal.exe'
    $tuiDest = Join-Path $InstallDir 'caracal-tui.exe'

    $tmpBin = Join-Path $tmp.FullName $target
    Write-Host "caracal-install: downloading $base/$target"
    Invoke-WebRequest -Uri "$base/$target" -OutFile $tmpBin -UseBasicParsing
    Verify-Hash $tmpBin $target
    Move-Item -Force $tmpBin $dest

    if ($env:CARACAL_SKIP_TUI -ne '1') {
        $tmpTui = Join-Path $tmp.FullName $tuiTarget
        Write-Host "caracal-install: downloading $base/$tuiTarget"
        try {
            Invoke-WebRequest -Uri "$base/$tuiTarget" -OutFile $tmpTui -UseBasicParsing
            Verify-Hash $tmpTui $tuiTarget
            Move-Item -Force $tmpTui $tuiDest
        } catch {
            Write-Warning "caracal-install: optional caracal-tui binary not available for this release; skipping ($_)"
        }
    }
} finally {
    Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -ieq $InstallDir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Host "caracal-install: added $InstallDir to user PATH (open a new shell to pick it up)"
}

Write-Host 'caracal-install: installed. Next steps:'
Write-Host '  caracal up         # start stack (Docker Desktop required)'
Write-Host '  caracal init       # provision local zone'
Write-Host '  caracal run -- cmd # smoke test ambient tokens'
Write-Host '  caracal-tui        # interactive TUI to inspect zones, audit, agents'
Write-Host "caracal-install: to uninstall, remove $InstallDir and the user PATH entry."
