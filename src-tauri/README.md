# AppLogsViewer — build & development guide

[![CI](https://github.com/valer23/better-app-logging/actions/workflows/ci.yml/badge.svg)](https://github.com/valer23/better-app-logging/actions/workflows/ci.yml)

Build instructions and developer notes for the Tauri v2 (Rust) host. For an
end-user overview — what the tool does, how to install the prebuilt artifact,
how to use it — see the [root README](../README.md).

> The HTML/CSS/JS viewer (`viewer/applogs-viewer.html`) is embedded at compile
> time via `include_str!`, served over a localhost axum server, and rendered
> inside the Tauri WebView window. Single source of truth.

Distributions ship **unsigned** — first-launch workaround required:
- macOS: `xattr -d com.apple.quarantine /Applications/AppLogsViewer.app`
  (the right-click → Open trick does NOT work for ad-hoc signed apps;
  macOS flags them as "damaged" instead of "unidentified developer")
- Windows: SmartScreen → **More info** → **Run anyway**

To enable Developer ID / EV signing, see [Code signing](#code-signing) below.

## Prerequisites

- Rust stable (1.95+) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal`
- Tauri CLI v2 — `cargo install tauri-cli --version "^2.0" --locked`
- Platform tooling for the bridges (only needed at runtime when connecting devices):
  - Android: `adb` on `PATH` (Homebrew: `brew install --cask android-platform-tools`)
  - iOS: `idevicesyslog` on `PATH` (Homebrew: `brew install libimobiledevice`)

> **iOS 17+ live-stream stalls.** `idevicesyslog` (libimobiledevice 1.4.0)
> uses the legacy `com.apple.syslog_relay` service for live mode. On iOS
> 17+ that channel can go silent — connection succeeds, `[connected:UDID]`
> is emitted, then `syslogd` stops feeding the relay. The bridge in
> [`src/bridge/ios.rs`](src/bridge/ios.rs) arms an 8 s post-connect
> watchdog (`STREAM_STALL_TIMEOUT_SECS`) and broadcasts an `ErrorFrame`
> with recovery hints when no log line arrives. Common fixes: reboot the
> iPhone, `sudo killall usbmuxd` on the Mac, or
> `idevicepair unpair && idevicepair pair`. Longer-term we may migrate
> to `pymobiledevice3` (RemoteServiceDiscovery path) — adopt only if the
> regression keeps recurring.

## Run from source

```bash
cd src-tauri
cargo run
```

A native window labelled "AppLogsViewer" opens at 1400×900, navigates to
`http://localhost:8780`, and renders the existing viewer UI. Edit any Rust source
or `viewer/applogs-viewer.html` and re-run for an incremental ~5s rebuild.

> **Why `cargo run` instead of `cargo tauri dev`?** The HTTP server is embedded in
> the same Rust process — Tauri's CLI dev mode waits for an external frontend dev
> server on `http://localhost:8780` before launching the binary, so the two would
> deadlock. `cargo run` skips that orchestration.

## Build for distribution

The same command works on both platforms — just run it on the target OS. Each build
takes ~3–5 minutes cold, ~30s incrementally.

### macOS (`.app` + `.dmg`)

```bash
cd src-tauri
bash build-tauri.sh        # auto-runs scripts/bundle-tooling-macos.sh, then cargo tauri build
```

The wrapper auto-runs `scripts/bundle-tooling-macos.sh` first, which copies
`adb`, `idevice_id`, `ideviceinfo`, `idevicesyslog` and their non-system
dylibs out of Homebrew into `vendor/macos-aarch64/`, patches every Mach-O
to use `@loader_path/<dylib>` so they resolve relative to the binary, and
ad-hoc-codesigns the result. Tauri's `bundle.resources` then drops the
folder into `Contents/Resources/vendor/macos-aarch64/` of the .app, so
the bundle is **truly drag-and-drop** — QA users do **not** need to
`brew install` anything.

Outputs:

| Path | Size | Use |
| --- | --- | --- |
| `target/release/bundle/macos/AppLogsViewer.app` | ~37 MB | Drag-and-drop install |
| `target/release/bundle/dmg/AppLogsViewer_<version>_aarch64.dmg` | ~15 MB | Distribute to QA / users |

Open with: `open target/release/bundle/macos/AppLogsViewer.app`.

For QA: ship the `.dmg`. First-launch workaround for unsigned builds: macOS
flags the ad-hoc-signed app as *"damaged"* once it has been quarantined by
the browser-driven download. Strip the quarantine attr once:
```bash
xattr -d com.apple.quarantine /Applications/AppLogsViewer.app
```
Subsequent launches are normal.

> **Re-run the bundle script** (`bash scripts/bundle-tooling-macos.sh`) on the
> build host whenever you `brew upgrade libimobiledevice` or
> `brew upgrade --cask android-platform-tools` so the embedded copies stay in
> sync. The `vendor/` directory is git-ignored — regenerated on demand.

### Windows (`.exe` NSIS installer)

Run from cmd / PowerShell on a Windows host:

```cmd
cd src-tauri
build-tauri.bat            :: wraps `cargo tauri build`
```

The wrapper auto-runs `scripts\bundle-tooling-windows.ps1` first, which copies
`adb.exe`, `idevice_id.exe`, `ideviceinfo.exe`, `idevicesyslog.exe` plus all
their DLL dependencies into `vendor\windows-x86_64\`. The script resolves
each tool in this order — first hit wins:

1. env var override (`APPLOGS_VENDOR_ADB_DIR`, `APPLOGS_VENDOR_IMD_DIR`)
2. local install on `PATH` or in well-known locations
   (winget `Google.PlatformTools`, `C:\libimobiledevice-*\`)
3. network download (Google platform-tools zip + latest upstream
   [`jrjr/libimobiledevice-windows`](https://github.com/jrjr/libimobiledevice-windows/releases)
   release — the build linked from [libimobiledevice.org](https://libimobiledevice.org)'s Downloads page)

Tauri's `bundle.resources` then drops the folder next to the installed
`applogs-viewer.exe` (under `%LOCALAPPDATA%\AppLogsViewer\vendor\windows-x86_64\`)
so the installer is **drag-and-drop for the user-mode tooling** — QA users
do **not** need adb, libimobiledevice, or anything else on `PATH`. Windows
resolves the bundled DLLs from the binary's own directory at load time, so
no `install_name_tool` equivalent is needed.

Output:

| Path | Size | Use |
| --- | --- | --- |
| `target\release\bundle\nsis\AppLogsViewer_<version>_x64-setup.exe` | ~11 MB | Distribute to QA / users |

#### End-user requirements (Windows)

| OS use-case | What the user needs to install |
| --- | --- |
| **Android only** | Nothing extra — `adb.exe` + `AdbWin*.dll` ship inside the installer; Windows Update provides the generic ADB USB driver for most phones. OEM-specific drivers (Samsung, Xiaomi, etc.) only if your device is unrecognised. |
| **iOS** | **[Apple Devices](https://apps.microsoft.com/detail/9NP83LWLPZ9K)** from the Microsoft Store **or** iTunes. This installs the `Apple Mobile Device USB Driver` (kernel) and `Apple Mobile Device Service` (Windows service on `localhost:27015`), which our bundled `idevice_id.exe` / `idevicesyslog.exe` connect to. We are **not legally allowed to redistribute** Apple's driver — it ships only via Apple's own installers. |

The installer detects whether Apple Mobile Device Service is registered
during pre-install ([`scripts/installer-hooks.nsh`](scripts/installer-hooks.nsh))
and surfaces a soft warning before unpacking. Users can pick **Yes** to
open the Microsoft Store and re-run setup, **No** to install anyway
(Android still works), or **Cancel** to abort. The runtime app **also**
probes `127.0.0.1:27015` when the iOS panel loads ([`http_server.rs:ios_driver_status`](src/http_server.rs))
and shows an inline banner with an "Install Apple Devices" link if the
user dismissed the install-time warning and later plugs in an iPhone.
Silent installs (`/S` flag) bypass the install-time warning so unattended
deployments are unaffected.

> **Why iOS isn't fully self-contained.** libimobiledevice's user-mode
> tooling (the 24 DLLs we bundle from
> [`jrjr/libimobiledevice-windows`](https://github.com/jrjr/libimobiledevice-windows))
> speaks the Apple Mobile Device protocol over a TCP socket, but the
> kernel-level USB transport is provided by Apple's closed-source driver
> bundled with iTunes / Apple Devices. Android USB transport is open-source
> (libusb-based), which is why `AdbWinApi.dll` + `AdbWinUsbApi.dll` are
> sufficient on their own. There is a libusb-based fork of usbmuxd that
> bypasses Apple's driver entirely, but it requires rebinding the iPhone to
> WinUSB via Zadig — which breaks iTunes / Finder sync system-wide and is
> not a supported configuration here.

For QA: ship the installer **and** the Microsoft Store link to Apple Devices
for testers who'll connect iPhones. First-launch workaround for unsigned
builds: **SmartScreen warning → "More info" → "Run anyway"**. Subsequent
launches are normal.

> **Re-run the bundle script** (`powershell -ExecutionPolicy Bypass -File scripts\bundle-tooling-windows.ps1`)
> on the build host whenever you bump android-platform-tools or
> libimobiledevice. The `vendor\` directory is git-ignored — regenerated on
> demand.

> **Cannot cross-build from macOS → Windows or Linux → macOS.** Apple's licence
> bans macOS in Docker / non-Apple hardware. Tauri's NSIS bundler also needs the
> Windows toolchain. Build each platform on its own host.

### One-time toolchain (per build host)

```bash
# install Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# install Tauri v2 CLI (cached after first install)
cargo install tauri-cli --version "^2.0" --locked
```

Windows additionally needs Visual Studio Build Tools with the
**Desktop development with C++** workload (provides `cl.exe`).

### Versioning

Bump `version` in `Cargo.toml` and `tauri.conf.json` before each release; the
`<version>` placeholder in artefact names is read from `tauri.conf.json`.

### Code signing

Currently skipped — see the **Status** section above. To enable:

- **macOS**: provide an Apple Developer ID Application certificate as
  `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` env vars; Tauri's bundler
  picks them up automatically.
- **Windows**: provide an EV / OV code-signing certificate as `WINDOWS_CERT` +
  `WINDOWS_CERT_PASSWORD`.

Refer to the [Tauri v2 signing guide](https://v2.tauri.app/distribute/sign/).

## Layout

```
src-tauri/
├── Cargo.toml
├── build.rs                    # tauri_build::build()
├── tauri.conf.json             # base config (frontendDist, identifier, plugins)
├── tauri.macos.conf.json       # macOS-specific overlay (bundle resources, etc.)
├── tauri.windows.conf.json     # Windows-specific overlay (NSIS hooks, vendor dir)
├── capabilities/default.json   # capability allowlist (shell:default, scoped subset)
├── icons/                      # .icns + .ico + iOS PNGs
├── dist/index.html             # placeholder for Tauri bundler — never user-facing
├── scripts/                    # bundle-tooling-{macos.sh,windows.ps1}, installer-hooks.nsh
├── build-tauri.sh              # macOS wrapper (vendor tooling → cargo tauri build)
├── build-tauri.bat             # Windows wrapper
└── src/
    ├── main.rs                 # thin wrapper → applogs_viewer_lib::run()
    ├── lib.rs                  # Tauri builder + spawn axum + plugins
    ├── http_server.rs          # axum :8780, GET / serves embedded HTML, no-store
    ├── ws_server.rs            # WebSocket fan-out for log frames
    ├── frame.rs                # serde structs (LogFrame, DevicesFrame, ErrorFrame)
    ├── parser.rs               # IOS_RE / ANDROID_RE / level maps
    ├── pid_map.rs              # Android PID→package mapping
    ├── tooling.rs              # vendor-tooling resolution
    └── bridge/                 # ios.rs, android.rs, mod.rs
```

The `viewer/` directory at the repo root holds the standalone HTML/CSS/JS UI
(`applogs-viewer.html`) embedded at compile time via `include_str!`.
