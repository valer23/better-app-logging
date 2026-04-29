# better-app-logging

Native cross-platform desktop app — Tauri v2 (Rust) host that streams Android
(`adb logcat`) and iOS (`idevicesyslog`) device logs into a unified web viewer,
with PID→package mapping, multi-device merge, native search, and per-platform
log-level filtering.

Runs on macOS (Apple Silicon) and Windows (x64). Drag-and-drop for the user-mode
device tooling (adb + libimobiledevice) — end users do **not** need `brew install`
or `winget install` anything for Android. iOS on Windows additionally requires
Apple's free [Apple Devices](https://apps.microsoft.com/detail/9NP83LWLPZ9K) app
from the Microsoft Store (provides the kernel USB driver Apple does not allow
redistribution of).

## Repo layout

```
src-tauri/    Rust Tauri host — embedded axum HTTP + WS servers, device bridges,
              vendored adb / libimobiledevice tooling, NSIS / DMG bundlers.
viewer/       Standalone HTML/CSS/JS UI (logcat-viewer.html). Embedded into the
              Rust binary at compile time via `include_str!` — single source of
              truth, no separate frontend build step.
LICENSE       License file.
```

## Build

See [`src-tauri/README.md`](src-tauri/README.md) for prerequisites, run-from-source,
and per-platform build instructions (`src-tauri/build-tauri.sh` for macOS,
`src-tauri/build-tauri.bat` for Windows).

## License

See [`LICENSE`](LICENSE).
