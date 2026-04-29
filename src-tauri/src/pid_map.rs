//! PID → package-name map for Android. Refreshed every 5 s by running
//! `adb shell ps -A -o PID=,NAME=` and parsing two-column output.
//!
//! Direct port of `launcher.py:_android_pid_map_loop` (lines 82-97).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;

use crate::tooling;

pub type PidMap = Arc<RwLock<HashMap<u32, String>>>;

/// Spawn the refresh loop, return the shared map. Each tick re-runs adb;
/// failures (adb missing, no device) are logged and tolerated — the last
/// good map is kept.
pub fn spawn(refresh: Duration) -> PidMap {
    let map: PidMap = Arc::new(RwLock::new(HashMap::new()));
    let map_for_task = map.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(refresh);
        loop {
            interval.tick().await;
            match refresh_once().await {
                Ok(new_map) if !new_map.is_empty() => {
                    let mut guard = map_for_task.write().await;
                    *guard = new_map;
                }
                Ok(_) => {} // empty result: device unplugged or shell failure — keep last
                Err(e) => tracing::debug!("[pid-map] refresh error: {e}"),
            }
        }
    });
    map
}

async fn refresh_once() -> Result<HashMap<u32, String>, String> {
    let output = tooling::tokio_command("adb")
        .args(["shell", "ps", "-A", "-o", "PID=,NAME="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("spawn adb shell ps: {e}"))?;
    if !output.status.success() {
        return Err(format!("adb shell ps exit={:?}", output.status.code()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid_str) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        if let Ok(pid) = pid_str.parse::<u32>() {
            map.insert(pid, name.to_string());
        }
    }
    Ok(map)
}
