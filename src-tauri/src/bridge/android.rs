//! Android bridge — spawns `adb logcat -v year,threadtime -T 500`,
//! parses each line into a `Frame::Log`, broadcasts JSON to WS subscribers.
//!
//! The `app` field is filled from a PID → package map maintained by
//! `pid_map.rs` (`adb shell ps -A` polled every 5 s).
//!
//! Auto-respawns on subprocess exit (2 s backoff).

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::broadcast;

use crate::frame::{ErrorFrame, Frame, LogFrame};
use crate::parser::{android_level, ANDROID_RE};
use crate::pid_map::{self, PidMap};
use crate::tooling;

/// Spawn the Android bridge worker. Returns immediately; runs forever in a
/// tokio task on the Tauri runtime.
pub fn spawn(tx: broadcast::Sender<String>) {
    // PID map task lives independently of the bridge respawn loop.
    let pid_map = pid_map::spawn(Duration::from_secs(5));
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = run_once(&tx, &pid_map).await {
                tracing::warn!("[android] bridge error: {e}");
                emit_error(&tx, &format!("android bridge error: {e}"));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn run_once(tx: &broadcast::Sender<String>, pid_map: &PidMap) -> Result<(), String> {
    tracing::info!("[android] spawning adb logcat -v year,threadtime -T 500");
    let mut child = tooling::tokio_command("adb")
        .args(["logcat", "-v", "year,threadtime", "-T", "500"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn adb logcat: {e} (is adb on PATH?)"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Forward stderr as ErrorFrame.
    let stderr_tx = tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            tracing::debug!("[android][stderr] {line}");
            emit_error(&stderr_tx, &line);
        }
    });

    let mut reader = BufReader::new(stdout).lines();
    while let Some(raw) = reader.next_line().await.map_err(|e| e.to_string())? {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(caps) = ANDROID_RE.captures(line) else {
            continue;
        };
        let ts = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let pid: u32 = caps
            .get(2)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        let tid: u32 = caps
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        let lvl_char = caps
            .get(4)
            .and_then(|m| m.as_str().chars().next())
            .unwrap_or('V');
        let tag = caps.get(5).map(|m| m.as_str().trim()).unwrap_or_default();
        let msg = caps.get(6).map(|m| m.as_str()).unwrap_or_default();

        let app = pid_map.read().await.get(&pid).cloned().unwrap_or_default();

        let log_frame = LogFrame {
            ts: ts.to_string(),
            pid,
            tid,
            lvl: android_level(lvl_char).to_string(),
            tag: tag.to_string(),
            app,
            msg: msg.to_string(),
        };
        push(tx, &Frame::Log(log_frame));
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Err(format!("adb logcat exited with status: {status}"))
}

fn push(tx: &broadcast::Sender<String>, frame: &Frame) {
    match serde_json::to_string(frame) {
        Ok(json) => {
            let _ = tx.send(json);
        }
        Err(e) => tracing::error!("[android] serialize: {e}"),
    }
}

fn emit_error(tx: &broadcast::Sender<String>, text: &str) {
    push(
        tx,
        &Frame::Error(ErrorFrame {
            data: text.to_string(),
        }),
    );
}
