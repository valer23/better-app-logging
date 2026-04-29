@echo off
REM build-tauri.bat - produce Windows release bundle via Tauri v2.
REM Output: target\release\bundle\nsis\AppLogsViewer-x86_64-setup.exe
REM
REM Usage:  build-tauri.bat
REM Prereqs: rustup + cargo + cargo-tauri (one-time install)
REM   1. https://win.rustup.rs/  -> install rustup
REM   2. cargo install tauri-cli --version "^2.0" --locked

setlocal

cd /d "%~dp0"

echo.
echo +-----------------------------------+
echo ^|   AppLogsViewer (Tauri) - release ^|
echo +-----------------------------------+
echo.

where cargo >nul 2>&1
if errorlevel 1 (
    echo [error] cargo not found. Install rustup from https://win.rustup.rs/ and re-open this shell.
    pause
    exit /b 1
)

cargo tauri --version >nul 2>&1
if errorlevel 1 (
    echo [setup] installing cargo-tauri ^(one-time^)...
    cargo install tauri-cli --version "^2.0" --locked
    if errorlevel 1 (
        echo [error] cargo-tauri install failed.
        pause
        exit /b 1
    )
)

REM Refresh the bundled adb + libimobiledevice tooling drop so the .exe
REM installer ships standalone (no extra tooling needed on QA machines).
REM The PowerShell script prefers local installs (winget Google.PlatformTools,
REM C:\libimobiledevice-*) and falls back to GitHub downloads if not present.
echo [setup] vendoring tooling for the installer...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\bundle-tooling-windows.ps1"
if errorlevel 1 (
    echo.
    echo [error] vendor script failed. See output above.
    pause
    exit /b 1
)

echo [build] cargo tauri build ^(release mode^)...
cargo tauri build
if errorlevel 1 (
    echo.
    echo [error] cargo tauri build failed. Common fixes:
    echo   * Install Visual Studio Build Tools ^(C++ workload^).
    echo   * Install WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/
    pause
    exit /b 1
)

echo.
echo +-----------------------------------+
echo ^|   Build complete!                 ^|
echo +-----------------------------------+
echo.
echo   Artifact:  target\release\bundle\nsis\
dir /b target\release\bundle\nsis\*.exe 2>nul
echo.
pause
