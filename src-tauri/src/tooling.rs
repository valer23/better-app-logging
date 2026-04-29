//! Resolve external tools (`adb`, `idevice_id`, `ideviceinfo`,
//! `idevicesyslog`) to either:
//!
//! 1. a vendored copy bundled inside the .app's `Contents/Resources/`
//!    (set up by `scripts/bundle-tooling-macos.sh` before the Tauri build), or
//! 2. the system `PATH` — fallback for `cargo run`, dev builds without
//!    bundled binaries, and for any tool we haven't vendored on the
//!    current platform.
//!
//! Set the bundle directory once from Tauri's `setup` hook via `init()`,
//! then call `resolve(name)` from anywhere. Returns a string suitable for
//! `Command::new(...)`.

use std::path::PathBuf;
use std::sync::OnceLock;

static TOOLING_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Record the directory holding bundled binaries. Idempotent — only the
/// first call wins. `None` disables the bundled-tooling lookup entirely.
pub fn init(dir: Option<PathBuf>) {
    let _ = TOOLING_DIR.set(dir);
}

/// Return either the bundled binary path (when present) or the bare name
/// for system `PATH` resolution. Always succeeds; the caller's
/// `Command::new` is responsible for surfacing missing-binary errors.
pub fn resolve(name: &str) -> String {
    if let Some(Some(dir)) = TOOLING_DIR.get() {
        // Windows requires the .exe suffix when launching by full path —
        // CreateProcessW does not auto-append it the way PATH search does.
        // Try `name.exe` first, then bare `name` for parity with the macOS
        // / Linux drops where binaries have no extension.
        if cfg!(windows) {
            let exe = dir.join(format!("{name}.exe"));
            if exe.exists() {
                return exe.to_string_lossy().into_owned();
            }
        }
        let candidate = dir.join(name);
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

/// `std::process::Command` for the resolved binary, with `CREATE_NO_WINDOW`
/// applied on Windows. Without that flag a Tauri GUI process spawning a
/// console child (`adb`, `ideviceinfo`, …) flashes a transient cmd window
/// for every invocation. On macOS / Linux this is a plain `Command::new`.
pub fn command(name: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(resolve(name));
    apply_no_window_std(&mut cmd);
    cmd
}

/// Tokio counterpart of `command()` — same `CREATE_NO_WINDOW` behaviour
/// for async spawn sites (long-running streamers + one-shot device
/// queries from the HTTP/WS handlers).
pub fn tokio_command(name: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(resolve(name));
    apply_no_window_tokio(&mut cmd);
    cmd
}

#[cfg(windows)]
fn apply_no_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window_std(_: &mut std::process::Command) {}

#[cfg(windows)]
fn apply_no_window_tokio(cmd: &mut tokio::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window_tokio(_: &mut tokio::process::Command) {}
