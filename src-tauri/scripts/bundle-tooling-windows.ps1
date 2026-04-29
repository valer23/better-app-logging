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
    $url = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
    $zip = Join-Path $Staging 'platform-tools.zip'
    $dir = Join-Path $Staging 'platform-tools-extracted'
    Write-Host "[adb] downloading platform-tools from Google..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    return (Join-Path $dir 'platform-tools')
}

function Get-ImdViaDownload {
    param([string]$Staging)
    # jrjr/libimobiledevice-windows tracks upstream libimobiledevice 1.4+
    # and ships a single flat-layout `libimobile-suite-latest_w64.zip`
    # asset per release (tag format `v<date>-<sha>`). This is the same
    # build linked from libimobiledevice.org's Downloads page.
    Write-Host "[imd] querying GitHub for latest jrjr/libimobiledevice-windows release..."
    $api     = 'https://api.github.com/repos/jrjr/libimobiledevice-windows/releases/latest'
    $headers = @{ 'User-Agent' = 'applogs-viewer-bundler' }
    $release = Invoke-RestMethod -Uri $api -Headers $headers
    $asset = $release.assets |
        Where-Object { $_.name -match '^libimobile-suite-.*_w64\.zip$' } |
        Select-Object -First 1
    if (-not $asset) {
        $assetNames = ($release.assets | ForEach-Object { $_.name }) -join ', '
        throw "no libimobile-suite-*_w64.zip asset in release $($release.tag_name); assets were: $assetNames"
    }
    $zip = Join-Path $Staging 'libimobile-suite-w64.zip'
    $dir = Join-Path $Staging 'libimobile-suite-extracted'
    Write-Host ("[imd] downloading {0} from release {1}..." -f $asset.name, $release.tag_name)
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers -UseBasicParsing
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
