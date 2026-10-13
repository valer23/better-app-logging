//! AppLogsViewer — Tauri v2 host process.
//!
//! Spawns an embedded axum HTTP server that serves
//! `viewer/applogs-viewer.html` (embedded at compile time via `include_str!`)
//! on `http://localhost:8780`. The Tauri main window's URL points at that
//! local server, so the self-contained HTML/JS/CSS viewer renders inside a
//! native window with no browser needed.

mod bridge;
mod children;
mod frame;
mod http_server;
mod parser;
mod pid_map;
mod tooling;
mod ws_server;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const IOS_WS_PORT: u16 = 8766;
const ANDROID_WS_PORT: u16 = 8765;

/// Set once `RunEvent::Exit` fires: the process is already in its own exit path
/// (tao `process::exit` / C `exit()`), so the signal task's backstop must not
/// start a second concurrent `exit()` (atexit handlers and static destructors
/// would run twice).
static EXITING: AtomicBool = AtomicBool::new(false);

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

            // Before any bridge spawns: SIGTERM/SIGINT/SIGHUP must reap the
            // tool children instead of killing us outright and orphaning them.
            #[cfg(unix)]
            install_signal_handlers(app.handle().clone());

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

            // Enforce a sensible minimum window size on startup. macOS auto-
            // restores the last-used NSWindow geometry from its Saved
            // Application State, which can be smaller than `minWidth`/
            // `minHeight` from the conf (those constraints only gate user
            // resize, not OS-side restoration). Without this clamp, a user
            // who once shrank the window keeps reopening into a cropped UI.
            {
                use tauri::{LogicalSize, Manager};
                if let Some(w) = app.get_webview_window("main") {
                    let scale = w.scale_factor().unwrap_or(1.0);
                    if let Ok(size) = w.inner_size() {
                        let logical_w = size.width as f64 / scale;
                        let logical_h = size.height as f64 / scale;
                        const MIN_W: f64 = 1100.0;
                        const MIN_H: f64 = 700.0;
                        const DEFAULT_W: f64 = 1400.0;
                        const DEFAULT_H: f64 = 900.0;
                        if logical_w < MIN_W || logical_h < MIN_H {
                            let target_w = logical_w.max(DEFAULT_W);
                            let target_h = logical_h.max(DEFAULT_H);
                            let _ = w.set_size(LogicalSize::new(target_w, target_h));
                        }
                    }
                }
            }

            // HTTP server (axum) — bind synchronously so the window does
            // not race the page load.
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
            let http_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = http_server::serve(http_handle, ready_tx).await {
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
            // Sized to ride out ~1.2s of viewer main-thread stall at iOS's ~27k/s burst peak
            // (e.g. a full 6000-row tail rebuild) without RecvError::Lagged dropping frames.
            let (ios_tx, _) = tokio::sync::broadcast::channel::<String>(32768);
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
        .build(tauri::generate_context!())
        .expect("error while building AppLogsViewer")
        .run(|_app, event| {
            // Cmd+Q / menu Quit / last-window close / app.exit() all end in
            // RunEvent::Exit, then the process exits without dropping tokio
            // tasks — kill_on_drop alone never fires. (ExitRequested is NOT
            // emitted on Cmd+Q, so it is the wrong hook.)
            if let tauri::RunEvent::Exit = event {
                EXITING.store(true, Ordering::SeqCst);
                let n = children::kill_all();
                tracing::info!("exit: signalled {n} tracked child process(es)");
            }
        });
}

/// Reap tracked children on SIGTERM / SIGINT / SIGHUP, then exit through
/// Tauri so the normal `RunEvent::Exit` path runs. Without a handler SIGTERM
/// kills the process instantly and orphans `idevicesyslog` / `adb logcat`.
#[cfg(unix)]
fn install_signal_handlers(app: tauri::AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};

    // Register synchronously so the handlers are live before any bridge spawns
    // a child (a signal in that window would otherwise take the default action
    // and orphan it). `setup` runs on the main thread, outside the runtime, so
    // `block_on` is allowed; `signal()` needs the runtime context to register.
    let (term, int, hup) = tauri::async_runtime::block_on(async {
        (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()).ok(),
            signal(SignalKind::hangup()).ok(),
        )
    });
    // SIGTERM is required; if it fails nothing is installed and the default
    // action stays in place. INT/HUP are optional — once SIGTERM is installed
    // we must not bail, or SIGTERM would be swallowed forever.
    let mut term = match term {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("could not install SIGTERM handler ({e}) — children may be orphaned");
            return;
        }
    };
    let (mut int, mut hup) = (int, hup);

    tauri::async_runtime::spawn(async move {
        // 128 + signo; only the backstop `process::exit` below honours it.
        let (name, code) = tokio::select! {
            _ = term.recv() => ("SIGTERM", 143),
            _ = recv_opt(&mut int) => ("SIGINT", 130),
            _ = recv_opt(&mut hup) => ("SIGHUP", 129),
        };
        let n = children::kill_all();
        tracing::info!("{name} received — signalled {n} child process(es), exiting");
        // -> RunEvent::Exit -> kill_all (no-op) -> single-instance socket
        // cleanup -> process exit. tauri/tao end the loop with status 0 here
        // whatever code is passed, so the graceful path always exits 0.
        app.exit(0);

        // Backstop: event loop wedged, or a second signal arrives.
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}
            _ = term.recv() => {}
            _ = recv_opt(&mut int) => {}
            _ = recv_opt(&mut hup) => {}
        }
        // If Exit already fired the process is in its own exit path; a second
        // concurrent `exit()` would run destructors twice, so just stand down.
        if !EXITING.load(Ordering::SeqCst) {
            std::process::exit(code);
        }
    });
}

/// `recv()` on an optional signal; pends forever when it could not be installed.
#[cfg(unix)]
async fn recv_opt(s: &mut Option<tokio::signal::unix::Signal>) {
    match s {
        Some(s) => {
            s.recv().await;
        }
        None => std::future::pending().await,
    }
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
