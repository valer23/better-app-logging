//! AppLogsViewer — Tauri v2 host process.
//!
//! Spawns an embedded axum HTTP server that serves
//! `viewer/logcat-viewer.html` (embedded at compile time via `include_str!`)
//! on `http://localhost:8780`. The Tauri main window's URL points at that
//! local server, so the self-contained HTML/JS/CSS viewer renders inside a
//! native window with no browser needed.

mod bridge;
mod frame;
mod http_server;
mod parser;
mod pid_map;
mod tooling;
mod ws_server;

use std::sync::Arc;

const IOS_WS_PORT: u16 = 8766;
const ANDROID_WS_PORT: u16 = 8765;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,applogs_viewer_lib=debug")
            }),
        )
        .init();

    // The bundled .app launched via Finder / `open` inherits a minimal PATH
    // (typically `/usr/bin:/bin:/usr/sbin:/sbin`), so `adb`, `idevice_id`,
    // `idevicesyslog` etc. installed under Homebrew are not found and all
    // subprocess spawns silently fail with ENOENT. Prepend the standard
    // Homebrew directories so every subsequent `Command::new("adb")` lookup
    // succeeds.
    ensure_tooling_path();

    tauri::Builder::default()
        // Second launch focuses the existing window instead of opening
        // a duplicate (which would also fail to bind the localhost ports).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // All async tasks must spawn inside `setup` — that is when the
            // Tauri-managed Tokio runtime is live and `tokio::spawn` works.

            // Vendored tooling lookup: `Contents/Resources/vendor/<triple>/`
            // contains adb + libimobiledevice binaries + their dylibs (see
            // `scripts/bundle-tooling-macos.sh`). When that directory is
            // present, all `Command::new(...)` calls below resolve to the
            // bundled copy via `tooling::resolve(name)`. Falls back to
            // system PATH for `cargo run` and unbundled platforms.
            {
                use tauri::Manager;
                let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                    "macos-aarch64"
                } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                    "macos-x86_64"
                } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
                    "windows-x86_64"
                } else {
                    ""
                };
                let bundled = if !triple.is_empty() {
                    app.path()
                        .resource_dir()
                        .ok()
                        .map(|p| p.join("vendor").join(triple))
                        .filter(|p| p.is_dir())
                } else {
                    None
                };
                if let Some(p) = &bundled {
                    tracing::info!("vendored tooling: {}", p.display());
                } else {
                    tracing::info!("no vendored tooling — falling back to system PATH");
                }
                tooling::init(bundled);
            }

            // HTTP server (axum) — bind synchronously so the window does
            // not race the page load.
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = http_server::serve(ready_tx).await {
                    tracing::error!("http server failed: {err:?}");
                }
            });
            if ready_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                tracing::warn!("http server did not signal ready within 5s");
            }

            // iOS bridge → broadcast → WS on :8766.
            let (ios_tx, _) = tokio::sync::broadcast::channel::<String>(2048);
            bridge::ios::spawn(ios_tx.clone());
            let ios_ws_state = ws_server::WsState {
                tx: ios_tx,
                greeting: Arc::new(ios_device_info),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(err) = ws_server::serve(IOS_WS_PORT, ios_ws_state).await {
                    tracing::error!("ios ws server failed: {err:?}");
                }
            });

            // Android bridge → broadcast → WS on :8765.
            let (android_tx, _) = tokio::sync::broadcast::channel::<String>(4096);
            bridge::android::spawn(android_tx.clone());
            let android_ws_state = ws_server::WsState {
                tx: android_tx,
                greeting: Arc::new(adb_devices),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(err) = ws_server::serve(ANDROID_WS_PORT, android_ws_state).await {
                    tracing::error!("android ws server failed: {err:?}");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AppLogsViewer");
}

/// Best-effort device info string (one-shot `ideviceinfo -k` calls).
fn ios_device_info() -> String {
    fn run(arg: &str) -> Option<String> {
        let out = tooling::command("ideviceinfo")
            .args(["-k", arg])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
    let name = run("DeviceName");
    let version = run("ProductVersion");
    match (name, version) {
        (Some(n), Some(v)) => format!("{n}\n{v}"),
        (Some(n), None) => n,
        (None, _) => "iOS device (ideviceinfo unavailable)".to_string(),
    }
}

/// `adb devices` output for the connect greeting.
fn adb_devices() -> String {
    match tooling::command("adb").arg("devices").output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Ok(out) => format!("adb error (exit {:?})", out.status.code()),
        Err(_) => "adb not found - install Android platform-tools and add to PATH".to_string(),
    }
}

/// Augment `PATH` with the directories Homebrew + common Linux package
/// managers install platform tools into, so that subprocess lookups for
/// `adb`, `idevice_id`, `ideviceinfo`, `idevicesyslog` succeed when the
/// app is launched via Finder / `open` / Spotlight (which inherit a
/// stripped-down PATH).
fn ensure_tooling_path() {
    const EXTRA: &[&str] = &[
        "/opt/homebrew/bin", // macOS Apple Silicon Homebrew
        "/opt/homebrew/sbin",
        "/usr/local/bin", // macOS Intel Homebrew + Linux user installs
        "/usr/local/sbin",
        "/opt/local/bin", // MacPorts
    ];
    let separator = if cfg!(windows) { ';' } else { ':' };
    let current = std::env::var_os("PATH").unwrap_or_default();
    let current_str = current.to_string_lossy().to_string();
    let mut parts: Vec<String> = current_str
        .split(separator)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let mut added = false;
    for p in EXTRA.iter().rev() {
        if !parts.iter().any(|x| x == p) && std::path::Path::new(p).is_dir() {
            parts.insert(0, (*p).to_string());
            added = true;
        }
    }
    if added {
        let new_path = parts.join(&separator.to_string());
        tracing::info!("PATH augmented for subprocess lookups: {new_path}");
        // SAFETY: `set_var` is unsound in multi-threaded processes (and
        // `unsafe` from Rust 1.81+). `ensure_tooling_path()` is invoked
        // exactly once from `run()` BEFORE `tauri::Builder::default()`
        // spins up the Tokio runtime / app threads, and the preceding
        // `tracing_subscriber::fmt().init()` only registers a global
        // subscriber (no thread spawn). Therefore at this single call
        // site the process is still single-threaded and the mutation
        // is race-free.
        #[allow(deprecated)]
        // `set_var` is not yet `unsafe` on stable, but will be — keep
        // the call compiling on both old and new toolchains.
        std::env::set_var("PATH", new_path);
    }
}
