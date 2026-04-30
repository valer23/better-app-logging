# better-app-logging

[![CI](https://github.com/valer23/better-app-logging/actions/workflows/ci.yml/badge.svg)](https://github.com/valer23/better-app-logging/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)](https://v2.tauri.app/)
[![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-000000.svg?logo=apple)](#install)
[![Windows](https://img.shields.io/badge/Windows-x64-0078D6.svg?logo=windows)](#install)

A native cross-platform desktop app that streams Android (`adb logcat`) and iOS
(`idevicesyslog`) device logs into a single unified viewer. Tauri v2 (Rust) host,
zero-install device tooling on Android, drag-and-drop bundling on macOS.

---

## Features

- **Multi-device, dual-platform** — connect Android phones (`adb`) and iPhones / iPads
  (`idevicesyslog`) at the same time, see all their logs merged in one view
- **Per-device filtering** — toggle Android-only / iOS-only / specific device
- **Live + file-import modes** — stream from a connected device, or drop a `.logcat` /
  `.log` / `.txt` / `.json` export to inspect offline
- **Rich filtering** — message search (with case-sensitive and regex toggles), tag /
  process filter, PID / app filter, log-level toggles (V/D/I/W/E), platform toggles
- **PID → package mapping (Android)** — `adb logcat` only emits PIDs; the viewer
  shows the actual app name by polling `adb shell ps` every 5 s
- **Pause / resume / clear / auto-scroll**, plus dark theme
- **Export** — save filtered view or full log buffer as `.logcat` / `.json`
- **Bundled tooling** — `adb` + `libimobiledevice` ship inside the installer.
  End users do **not** need `brew install` or `winget install` anything for Android.
  iOS on Windows additionally requires Apple's free
  [Apple Devices](https://apps.microsoft.com/detail/9NP83LWLPZ9K) app from the
  Microsoft Store (provides Apple's closed-source kernel USB driver, which we are
  not legally allowed to redistribute).

---

## Install

### macOS (Apple Silicon)

1. Download `AppLogsViewer_<version>_aarch64.dmg` from the
   [Releases](https://github.com/valer23/better-app-logging/releases) page
2. Open the `.dmg` and drag `AppLogsViewer.app` into `/Applications`
3. **First launch** (unsigned build): macOS shows
   *"AppLogsViewer.app is damaged and can't be opened"* because the `.dmg`
   is downloaded from the web and the app is ad-hoc signed (not Developer ID).
   Strip the quarantine flag once, then launch normally:
   ```bash
   xattr -d com.apple.quarantine /Applications/AppLogsViewer.app
   open /Applications/AppLogsViewer.app
   ```
   Subsequent launches are normal — no need to repeat.

> Intel Macs are not currently shipped as a prebuilt artifact. Build from source
> on an Intel host — see [src-tauri/README.md](src-tauri/README.md).

### Windows (x64)

1. Download `AppLogsViewer_<version>_x64-setup.exe` from the
   [Releases](https://github.com/valer23/better-app-logging/releases) page
2. Run the installer
3. **First launch** (unsigned build): SmartScreen warns →
   **More info** → **Run anyway**. Subsequent launches are normal
4. **For iOS device support** *(Android-only users can skip this)*: install
   [Apple Devices](https://apps.microsoft.com/detail/9NP83LWLPZ9K) from the
   Microsoft Store — provides the kernel USB driver and the Apple Mobile Device
   Service that bundled `idevicesyslog.exe` connects to. The installer detects
   missing driver and shows a soft warning before proceeding

| OS use-case | What you need to install |
|---|---|
| **macOS, Android** | Just the `.dmg` |
| **macOS, iOS** | Just the `.dmg` |
| **Windows, Android** | Just the `.exe` (Windows Update provides generic ADB USB driver) |
| **Windows, iOS** | The `.exe` **and** Apple Devices (or iTunes) from the Microsoft Store |

---

## Usage

1. **Plug in a device** via USB
   - **Android**: enable Developer options → USB debugging on the device. Accept the
     RSA fingerprint prompt the first time you plug it in. The phone must be
     unlocked when accepting the prompt
   - **iOS**: tap **Trust This Computer** when iOS prompts. iPhone must be unlocked
2. **Open the app** (`AppLogsViewer`)
3. **Switch panels** between **📱 Live Devices** (default) and **📂 File Import**
4. **Pick your device** from the platform dropdown(s) — Android and iOS lists are
   independent; you can stream from one or both at the same time
5. **Logs stream live** into the table, newest at the bottom by default
6. **Filter** as needed:
   - 🔍 search box (toggle `Aa` for case-sensitive, `.*` for regex)
   - tag / PID / app filters
   - level toggle group (V / D / I / W / E)
   - platform toggle group (Android / iOS)
7. **Pause** the live stream to scroll back without new lines pushing the view down
8. **Auto-scroll** keeps the latest line in view; toggles off automatically if you
   scroll up by hand
9. **Clear** wipes the in-memory buffer (the device keeps logging — clearing only
   affects the viewer)
10. **Export** the filtered view or the full buffer to `.logcat` (text) or `.json`
11. **File-import mode**: drop a previously-exported log file onto the dropzone, or
    use the file picker. Same filters work offline

### Troubleshooting

| Symptom | Fix |
|---|---|
| Android device doesn't appear | Re-plug, accept the RSA prompt on the phone (must be unlocked). On Windows, install OEM USB driver if Windows Update did not |
| iOS device doesn't appear (Windows) | Install **Apple Devices** from the Microsoft Store. Re-plug, tap **Trust** on the iPhone |
| iOS device doesn't appear (macOS) | Re-plug, tap **Trust** on the iPhone, ensure the device is unlocked |
| App says `adb not found` | Should never happen — `adb` ships inside the app. Reinstall, or build from source if you customised the bundle |
| macOS says "AppLogsViewer.app is damaged" | Run `xattr -d com.apple.quarantine /Applications/AppLogsViewer.app` once. The app is ad-hoc signed; macOS flags quarantined ad-hoc apps as "damaged" — misleading message, app is fine. |
| App won't launch on Windows (SmartScreen) | **More info** → **Run anyway** the first time |

---

## Build from source

See [`src-tauri/README.md`](src-tauri/README.md) for prerequisites, run-from-source,
and per-platform build wrappers (`src-tauri/build-tauri.sh` for macOS,
`src-tauri/build-tauri.bat` for Windows).

TL;DR (macOS):

```bash
git clone git@github.com:valer23/better-app-logging.git
cd better-app-logging/src-tauri
bash build-tauri.sh
open target/release/bundle/macos/AppLogsViewer.app
```

---

## Architecture

```
src-tauri/    Rust Tauri v2 host. Embedded axum HTTP server (:8780) + two
              WebSocket servers (Android :8765, iOS :8766) inside one binary.
              Vendored adb + libimobiledevice in vendor/<triple>/.
viewer/       Standalone HTML/CSS/JS UI (applogs-viewer.html). Embedded into
              the Rust binary at compile time via `include_str!` — single
              source of truth, no separate frontend build step.
.github/      CI: stale-ref grep, cargo fmt, cargo check, cargo clippy.
LICENSE       MIT.
```

The host process spawns `adb logcat` and `idevicesyslog` as subprocesses,
parses each line into a typed `LogFrame` (serde), broadcasts as JSON over
the WebSocket fan-out. The HTML viewer connects to both WebSockets, merges
the streams, and renders into a virtualised table.

---

## License

[MIT](LICENSE).
