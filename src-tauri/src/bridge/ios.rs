//! iOS bridge — spawns `idevicesyslog --no-colors`, parses each line into
//! a `Frame::Log`, broadcasts JSON to WS subscribers.
//!
//! Auto-respawns on subprocess exit (2 s backoff) so unplugging + replugging
//! the iPhone resumes streaming without restarting the app.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Datelike;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::broadcast;

use crate::frame::{DevicesFrame, ErrorFrame, Frame, LogFrame};
use crate::parser::{ios_level, ANSI_RE, IOS_RE};
use crate::tooling;

/// Seconds to wait after `[connected:UDID]` before flagging a silent stream.
/// iOS 17+ `syslog_relay` can stall: the channel is open but `syslogd` stops
/// feeding it. We surface that as an actionable error instead of leaving the
/// UI looking healthy with zero output.
const STREAM_STALL_TIMEOUT_SECS: u64 = 8;

const STALL_HINT: &str = concat!(
    "iOS device connected but no logs are streaming. ",
    "iOS 17+ syslog_relay can stall — try (in order): ",
    "(1) reboot the iPhone, ",
    "(2) `sudo killall usbmuxd` on the Mac, ",
    "(3) `idevicepair unpair && idevicepair pair` then re-Trust on the device.",
);

/// Spawn the iOS bridge worker. Returns immediately; runs forever in a tokio task.
pub fn spawn(tx: broadcast::Sender<String>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = run_once(&tx).await {
                tracing::warn!("[ios] bridge error: {e}");
                emit_error(&tx, &format!("ios bridge error: {e}"));
            }
            // Respawn delay — gives the device a chance to come back if it was unplugged.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

async fn run_once(tx: &broadcast::Sender<String>) -> Result<(), String> {
    tracing::info!("[ios] spawning idevicesyslog --no-colors");
    let mut child = tooling::tokio_command("idevicesyslog")
        .arg("--no-colors")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true) // do not orphan subprocess if our task is dropped
        .spawn()
        .map_err(|e| format!("spawn idevicesyslog: {e} (is libimobiledevice installed?)"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Drain stderr in a sibling task — forwarded as ErrorFrame.
    let stderr_tx = tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            tracing::debug!("[ios][stderr] {line}");
            emit_error(&stderr_tx, &line);
        }
    });

    // True once we've seen at least one parsed log line on this connection;
    // the stall watchdog reads this to decide whether to fire.
    let saw_log = Arc::new(AtomicBool::new(false));

    // Year prefix for ts (idevicesyslog omits year).
    let year = chrono::Local::now().year();
    let mut reader = BufReader::new(stdout).lines();
    while let Some(raw) = reader.next_line().await.map_err(|e| e.to_string())? {
        let line = ANSI_RE.replace_all(&raw, "").trim_end().to_string();
        if line.is_empty() {
            continue;
        }

        // Lifecycle markers: idevicesyslog emits e.g. [connected:UDID].
        if line.starts_with('[') && line.ends_with(']') {
            let inner = &line[1..line.len() - 1];
            push(
                tx,
                &Frame::Devices(DevicesFrame {
                    data: inner.to_string(),
                }),
            );
            // On (re)connect, reset the watchdog and arm a fresh timer.
            if inner.starts_with("connected:") {
                saw_log.store(false, Ordering::Relaxed);
                arm_stall_watchdog(tx.clone(), saw_log.clone());
            }
            continue;
        }

        let Some(caps) = IOS_RE.captures(&line) else {
            continue;
        };
        let ts_raw = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let process = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
        let subsystem = caps.get(3).map(|m| m.as_str());
        let pid: u32 = caps
            .get(4)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        let level = caps.get(5).map(|m| m.as_str());
        let msg = caps.get(6).map(|m| m.as_str()).unwrap_or_default();

        let tag = match subsystem {
            Some(sub) => format!("{process}({sub})"),
            None => process.to_string(),
        };
        let app = subsystem.unwrap_or_default().to_string();

        let log_frame = LogFrame {
            ts: format!("{year} {ts_raw}"),
            pid,
            tid: 0, // idevicesyslog has no TID
            lvl: ios_level(level).to_string(),
            tag,
            app,
            msg: msg.to_string(),
        };
        saw_log.store(true, Ordering::Relaxed);
        push(tx, &Frame::Log(log_frame));
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Err(format!("idevicesyslog exited with status: {status}"))
}

/// Spawn a one-shot timer that fires after `STREAM_STALL_TIMEOUT_SECS` and,
/// if no log line has been seen by then, emits an `ErrorFrame` with the
/// recovery hint. The timer task exits on its own — no cancellation needed,
/// since `saw_log` is checked only once at deadline.
fn arm_stall_watchdog(tx: broadcast::Sender<String>, saw_log: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(STREAM_STALL_TIMEOUT_SECS)).await;
        if !saw_log.load(Ordering::Relaxed) {
            tracing::warn!(
                "[ios] stream stall: no logs in {STREAM_STALL_TIMEOUT_SECS}s post-connect"
            );
            emit_error(&tx, STALL_HINT);
        }
    });
}

fn push(tx: &broadcast::Sender<String>, frame: &Frame) {
    match serde_json::to_string(frame) {
        Ok(json) => {
            let _ = tx.send(json); // "no receivers" is fine — bridge runs even with zero clients
        }
        Err(e) => tracing::error!("[ios] serialize: {e}"),
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
