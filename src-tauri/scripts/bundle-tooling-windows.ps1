# Bundle adb + libimobiledevice (idevice_id, ideviceinfo, idevicesyslog) and
# their DLL dependencies into `vendor\windows-x86_64\` as a self-contained
# tooling drop. Tauri's bundle.resources picks the directory up and copies
# it next to the installed `applogs-viewer.exe` at build time.
#
# Unlike the macOS sibling, no install_name patching is needed - Windows
# resolves DLLs from the executable's own directory by default, so dropping
# every required .dll alongside the .exe is enough.
#
# Each tool is resolved in this order; first hit wins:
#   1. env var override (APPLOGS_VENDOR_ADB_DIR / APPLOGS_VENDOR_IMD_DIR)
#   2. local install on PATH or in well-known directories
#   3. network download (Google platform-tools / imobiledevice-net release)
#
# Run on a Windows host (PowerShell 5.1 or 7+) before `build-tauri.bat`.
# Re-run whenever you bump android-platform-tools / libimobiledevice-win32
# versions; the script clears the vendor folder each invocation.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # speeds up Invoke-WebRequest

$root    = Split-Path -Parent $PSScriptRoot
$vendor  = Join-Path $root 'vendor\windows-x86_64'
$staging = Join-Path $env:TEMP ("applogs-vendor-" + [guid]::NewGuid().ToString('N'))

if (Test-Path $vendor)  { Remove-Item -Recurse -Force $vendor }
New-Item -ItemType Directory -Path $vendor  | Out-Null
New-Item -ItemType Directory -Path $staging | Out-Null

# GitHub's API requires TLS 1.2 on PowerShell 5.1 (older default is TLS 1.0/1.1).
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ─── Pinned download artifacts ────────────────────────────────────────────────
# Supply-chain hardening (issue H3): every network download is verified against
# a SHA-256 known to this script. A mismatch aborts the build LOUDLY instead of
# silently shipping a tampered binary inside the installer.
#
# How to bump a pinned version:
#   1. Update the URL / tag below.
#   2. Run the script once with $env:APPLOGS_BUNDLER_TRUST_ON_FIRST_USE='1' to
#      compute and print the new SHA-256 (the script will refuse to copy any
#      files; it only records the hash).
#   3. Paste the printed hash into the corresponding *Sha256 constant below
#      and commit alongside the URL/tag bump in the same commit so reviewers
#      can inspect both halves of the change together.
#   4. Cross-check the hash against an independent source (vendor's release
#      page, GitHub release web UI, second machine on a different network)
#      before merging. The whole point is that a single host being MITM'd
#      cannot poison the pin.

# Google does not host versioned ZIPs at predictable URLs — only the rolling
# `platform-tools-latest-windows.zip` URL works (versioned URLs all 404).
# Trade-off: when Google rotates `latest`, the recorded SHA-256 below stops
# matching and the build fails loud. Recovery: re-run with
# APPLOGS_BUNDLER_TRUST_ON_FIRST_USE=1 — Assert-Sha256 will print the new
# hash on mismatch (no need to first reset the constant to placeholder zeros).
# Cross-check against an independent source, paste the printed hash here, commit.
$script:AdbZipUrl    = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
$script:AdbZipSha256 = '4fe305812db074cea32903a489d061eb4454cbc90a49e8fea677f4b7af764918'  # platform-tools (rolling 'latest' as of 2026-04-30)

# Pin to a concrete release tag (NOT 'latest') so the asset URL is stable and
# the recorded SHA-256 below means something. Bump the tag + hash together.
$script:ImdReleaseTag   = 'v20260426-74585f8'
$script:ImdAssetPattern = '^libimobile-suite-.*_w64\.zip$'
$script:ImdZipSha256    = '2985634c50c62b36630d610b6acf3caf5b7f1e6b7480a8877a936965f9810eac'  # libimobile-suite-latest_w64.zip from v20260426-74585f8 (10999780 bytes)

function Assert-Sha256 {
    # Verifies that $Path hashes to $Expected (case-insensitive). Modes:
    #   - Expected is a real 64-hex-char hash AND matches → success.
    #   - Expected is the all-zero placeholder AND APPLOGS_BUNDLER_TRUST_ON_FIRST_USE='1'
    #     → print the actual hash and throw (operator pastes it into the script).
    #   - Expected is a real hash AND mismatches AND APPLOGS_BUNDLER_TRUST_ON_FIRST_USE='1'
    #     → print the actual hash with mismatch context and throw (re-pin path,
    #     e.g. when Google rotates `platform-tools-latest`). Caller does NOT need
    #     to first reset the constant to placeholder zeros.
    #   - Anything else → throw immediately. We never silently accept an
    #     unverified download.
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Expected,
        [Parameter(Mandatory = $true)] [string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "[$Label] cannot verify SHA-256: file not found at $Path"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    $expectedNorm  = $Expected.ToLowerInvariant()
    $isPlaceholder = ($expectedNorm -eq ('0' * 64))
    $trustOnFirstUse = ($env:APPLOGS_BUNDLER_TRUST_ON_FIRST_USE -eq '1')

    if ($isPlaceholder) {
        if ($trustOnFirstUse) {
            Write-Host ""
            Write-Warning ("[$Label] TRUST-ON-FIRST-USE: computed SHA-256 = {0}" -f $actual)
            Write-Warning ("[$Label] Cross-check against an independent source, then paste this")
            Write-Warning ("[$Label] value into bundle-tooling-windows.ps1 and re-run.")
            Write-Host ""
            throw "[$Label] pinned hash not yet recorded; aborting so build cannot ship an unverified artifact"
        }
        throw "[$Label] pinned SHA-256 is the placeholder zeros; refusing to use unverified download. Set APPLOGS_BUNDLER_TRUST_ON_FIRST_USE=1, run once to print the hash, paste it into the script, then re-run."
    }

    if ($actual -ne $expectedNorm) {
        if ($trustOnFirstUse) {
            Write-Host ""
            Write-Warning ("[$Label] HASH MISMATCH + TRUST-ON-FIRST-USE: re-pinning")
            Write-Warning ("[$Label]   expected (current pin): {0}" -f $expectedNorm)
            Write-Warning ("[$Label]   actual   (downloaded):  {0}" -f $actual)
            Write-Warning ("[$Label] If this is an expected upstream rotation (e.g. Google bumped")
            Write-Warning ("[$Label] platform-tools-latest), cross-check against an independent source")
            Write-Warning ("[$Label] then paste the actual hash into bundle-tooling-windows.ps1 and re-run.")
            Write-Warning ("[$Label] If you did NOT expect a rotation, treat this as tampering and investigate.")
            Write-Host ""
            throw "[$Label] pinned hash mismatch; aborting so build cannot ship an unverified artifact"
        }
        throw ("[$Label] SHA-256 MISMATCH - refusing to use download.`n  expected: {0}`n  actual:   {1}`n  file:     {2}`nSomeone may be tampering with the download (CDN compromise / MITM). Do NOT bypass this check; investigate first.`nIf this is a legitimate upstream rotation, re-run with APPLOGS_BUNDLER_TRUST_ON_FIRST_USE=1 to print the new hash for review." -f $expectedNorm, $actual, $Path)
    }
    Write-Host ("[$Label] SHA-256 OK ({0})" -f $actual)
}

function Test-DirHasFiles {
    param([string]$Dir, [string[]]$Required)
    if (-not $Dir -or -not (Test-Path $Dir)) { return $false }
    foreach ($f in $Required) {
        if (-not (Test-Path (Join-Path $Dir $f))) { return $false }
    }
    return $true
}

function Resolve-AdbSource {
    $required = @('adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll')
    if ($env:APPLOGS_VENDOR_ADB_DIR) {
        if (Test-DirHasFiles $env:APPLOGS_VENDOR_ADB_DIR $required) {
            return @{ Dir = $env:APPLOGS_VENDOR_ADB_DIR; Source = 'env:APPLOGS_VENDOR_ADB_DIR' }
        }
        Write-Warning "APPLOGS_VENDOR_ADB_DIR='$env:APPLOGS_VENDOR_ADB_DIR' missing one of: $($required -join ', ')"
    }
    $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $dir = Split-Path -Parent $cmd.Source
        if (Test-DirHasFiles $dir $required) {
            return @{ Dir = $dir; Source = 'PATH (' + $cmd.Source + ')' }
        }
    }
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools'
    if (Test-DirHasFiles $winget $required) {
        return @{ Dir = $winget; Source = 'winget Google.PlatformTools' }
    }
    return $null
}

function Resolve-ImdSource {
    # Heuristic: the directory needs the three .exes we ship; we'll grab
    # every .dll next to them, whatever the libimd version names them.
    $required = @('idevice_id.exe', 'ideviceinfo.exe', 'idevicesyslog.exe')
    if ($env:APPLOGS_VENDOR_IMD_DIR) {
        if (Test-DirHasFiles $env:APPLOGS_VENDOR_IMD_DIR $required) {
            return @{ Dir = $env:APPLOGS_VENDOR_IMD_DIR; Source = 'env:APPLOGS_VENDOR_IMD_DIR' }
        }
        Write-Warning "APPLOGS_VENDOR_IMD_DIR='$env:APPLOGS_VENDOR_IMD_DIR' missing one of: $($required -join ', ')"
    }
    $cmd = Get-Command idevicesyslog.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $dir = Split-Path -Parent $cmd.Source
        if (Test-DirHasFiles $dir $required) {
            return @{ Dir = $dir; Source = 'PATH (' + $cmd.Source + ')' }
        }
    }
    # Standard well-known install locations for libimobiledevice-win32
    # tarballs the user unzipped to C:\.
    $candidates = @()
    $candidates += Get-ChildItem -Path 'C:\' -Directory -Filter 'libimobiledevice-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { $_.FullName }
    foreach ($c in $candidates) {
        if (Test-DirHasFiles $c $required) {
            return @{ Dir = $c; Source = 'local install' }
        }
    }
    return $null
}

function Get-AdbViaDownload {
    param([string]$Staging)
    $url = $script:AdbZipUrl
    $zip = Join-Path $Staging 'platform-tools.zip'
    $dir = Join-Path $Staging 'platform-tools-extracted'
    Write-Host ("[adb] downloading {0}..." -f $url)
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    # SHA-256 verification (issue H3): refuses to extract a tampered/MITM'd zip.
    Assert-Sha256 -Path $zip -Expected $script:AdbZipSha256 -Label 'adb'
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    return (Join-Path $dir 'platform-tools')
}

function Get-ImdViaDownload {
    param([string]$Staging)
    # jrjr/libimobiledevice-windows tracks upstream libimobiledevice 1.4+
    # and ships a single flat-layout `libimobile-suite-latest_w64.zip`
    # asset per release (tag format `v<date>-<sha>`). This is the same
    # build linked from libimobiledevice.org's Downloads page.
    #
    # We pin to a specific release tag (NOT 'releases/latest') so that the
    # asset URL resolves to a SHA-256 we have recorded. Bumping the tag
    # without bumping the hash will fail the Assert-Sha256 check loudly.
    $tag     = $script:ImdReleaseTag
    $api     = "https://api.github.com/repos/jrjr/libimobiledevice-windows/releases/tags/$tag"
    $headers = @{ 'User-Agent' = 'applogs-viewer-bundler' }
    Write-Host ("[imd] querying GitHub for jrjr/libimobiledevice-windows release {0}..." -f $tag)
    $release = Invoke-RestMethod -Uri $api -Headers $headers
    $asset = $release.assets |
        Where-Object { $_.name -match $script:ImdAssetPattern } |
        Select-Object -First 1
    if (-not $asset) {
        $assetNames = ($release.assets | ForEach-Object { $_.name }) -join ', '
        throw "no asset matching $($script:ImdAssetPattern) in release $($release.tag_name); assets were: $assetNames"
    }
    $zip = Join-Path $Staging 'libimobile-suite-w64.zip'
    $dir = Join-Path $Staging 'libimobile-suite-extracted'
    Write-Host ("[imd] downloading {0} from release {1}..." -f $asset.name, $release.tag_name)
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers -UseBasicParsing
    # SHA-256 verification (issue H3): refuses to extract a tampered/MITM'd zip.
    Assert-Sha256 -Path $zip -Expected $script:ImdZipSha256 -Label 'imd'
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    return $dir
}

try {
    # ──────────────────────────────────────────────────────────────────────
    # 1. adb.exe + AdbWin*.dll (Google Platform-Tools)
    # ──────────────────────────────────────────────────────────────────────
    $adbSrc = Resolve-AdbSource
    if (-not $adbSrc) {
        $adbSrc = @{ Dir = (Get-AdbViaDownload -Staging $staging); Source = 'download' }
    }
    Write-Host ("[adb] source: {0}" -f $adbSrc.Source)
    Write-Host ("[adb]      :  {0}" -f $adbSrc.Dir)
    foreach ($f in @('adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll')) {
        $src = Join-Path $adbSrc.Dir $f
        if (-not (Test-Path $src)) { throw "adb source missing $f at $src" }
        Copy-Item -LiteralPath $src -Destination (Join-Path $vendor $f) -Force
        Write-Host ("[adb]   + {0}" -f $f)
    }

    # ──────────────────────────────────────────────────────────────────────
    # 2. idevice_id.exe / ideviceinfo.exe / idevicesyslog.exe + every DLL
    #    next to them (libimobiledevice-win32 ships flat - Windows DLL
    #    search resolves siblings of the .exe at load time, so shipping the
    #    full set keeps us safe across libimd version bumps that add or
    #    rename a transitive dep.)
    # ──────────────────────────────────────────────────────────────────────
    $imdSrc = Resolve-ImdSource
    if (-not $imdSrc) {
        $imdSrc = @{ Dir = (Get-ImdViaDownload -Staging $staging); Source = 'download' }
    }
    Write-Host ("[imd] source: {0}" -f $imdSrc.Source)
    Write-Host ("[imd]      :  {0}" -f $imdSrc.Dir)
    foreach ($e in @('idevice_id.exe', 'ideviceinfo.exe', 'idevicesyslog.exe')) {
        $src = Join-Path $imdSrc.Dir $e
        if (-not (Test-Path $src)) { throw "libimobiledevice source missing $e at $src" }
        Copy-Item -LiteralPath $src -Destination (Join-Path $vendor $e) -Force
        Write-Host ("[imd]   + {0}" -f $e)
    }
    Get-ChildItem -LiteralPath $imdSrc.Dir -Filter '*.dll' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $vendor $_.Name) -Force
        Write-Host ("[imd]   + {0}" -f $_.Name)
    }

    # ──────────────────────────────────────────────────────────────────────
    # 3. Final listing
    # ──────────────────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host ("Vendored tooling at {0}\:" -f $vendor)
    $files = Get-ChildItem -LiteralPath $vendor | Sort-Object Name
    foreach ($f in $files) {
        $kb = [int]([math]::Ceiling($f.Length / 1024))
        Write-Host ("   {0,8} KB  {1}" -f $kb, $f.Name)
    }
    $totalKb = [int]([math]::Ceiling(($files | Measure-Object -Sum Length).Sum / 1024))
    Write-Host ""
    Write-Host ("Total: {0} KB across {1} files" -f $totalKb, $files.Count)
    Write-Host ""
    Write-Host 'Next: run "build-tauri.bat" - Tauri will copy this folder into'
    Write-Host '      the NSIS installer payload at bundle time.'
}
finally {
    if (Test-Path $staging) {
        Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    }
}
