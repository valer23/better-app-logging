//! iOS bridge — spawns `idevicesyslog --no-colors`, parses each line into
//! a `Frame::Log`, broadcasts JSON to WS subscribers.
//!
//! Auto-respawns on subprocess exit (2 s backoff) so unplugging + replugging
//! the iPhone resumes streaming without restarting the app.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use chrono::Datelike;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, Notify};

use crate::frame::{DevicesFrame, ErrorFrame, Frame, LogFrame};
use crate::parser::{ios_level, ANSI_RE, IOS_RE};
use crate::tooling;

/// Seconds of silence on the syslog stream before we treat it as stalled and
/// force a respawn. iOS 17+ `syslog_relay` can go quiet while the socket stays
/// open (device sleeps, lockdownd throttles, usbmuxd tunnel hiccups). Killing
/// the child lets the outer `spawn` loop reconnect from scratch.
const STREAM_STALL_TIMEOUT_SECS: u64 = 15;

const STALL_HINT: &str = concat!(
    "iOS log stream stalled — restarting idevicesyslog. ",
    "If this repeats, the pair record is usually stale: ",
    "(1) `idevicepair unpair && idevicepair pair`, then re-Trust on the device, ",
    "(2) unlock the iPhone and disable Auto-Lock while debugging, ",
    "(3) `sudo launchctl kickstart -k system/com.apple.usbmuxd` on the Mac.",
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

    // Activity pings: each parsed line and each `[connected:...]` marker
    // notifies the watchdog. The watchdog only arms after the first ping,
    // so an unplugged device doesn't cause a respawn loop.
    let activity = Arc::new(Notify::new());

    let read_loop = read_lines(stdout, tx.clone(), activity.clone());
    let stall_watch = watch_for_stall(activity.clone());

    let outcome = tokio::select! {
        r = read_loop => r,
        r = stall_watch => r,
    };

    // Kill + reap before returning, in all branches, so we never leak a zombie
    // across respawns. `wait()` is harmless if the child has already exited
    // (`ReaderEof`); on stall / reader error it ensures the SIGKILL is reaped.
    let _ = child.kill().await;
    let _ = child.wait().await;

    match outcome {
        StreamOutcome::Stalled => {
            tracing::warn!("[ios] stream stalled after {STREAM_STALL_TIMEOUT_SECS}s — respawning");
            emit_error(tx, STALL_HINT);
            // Return Ok so the outer `spawn` loop respawns silently without
            // also emitting a generic "ios bridge error: stream stalled" frame
            // — that would overwrite the actionable hint above in the UI.
            Ok(())
        }
        StreamOutcome::ReaderEof => Err("idevicesyslog exited (EOF)".into()),
        StreamOutcome::ReaderErr(e) => Err(e),
    }
}

enum StreamOutcome {
    Stalled,
    ReaderEof,
    ReaderErr(String),
}

async fn read_lines(
    stdout: tokio::process::ChildStdout,
    tx: broadcast::Sender<String>,
    activity: Arc<Notify>,
) -> StreamOutcome {
    let year = chrono::Local::now().year();
    let mut reader = BufReader::new(stdout).lines();
    loop {
        let next = reader.next_line().await;
        let raw = match next {
            Ok(Some(line)) => line,
            Ok(None) => return StreamOutcome::ReaderEof,
            Err(e) => return StreamOutcome::ReaderErr(e.to_string()),
        };

        let line = ANSI_RE.replace_all(&raw, "").trim_end().to_string();
        if line.is_empty() {
            continue;
        }

        // Lifecycle markers: idevicesyslog emits e.g. [connected:UDID].
        if line.starts_with('[') && line.ends_with(']') {
            let inner = &line[1..line.len() - 1];
            push(
                &tx,
                &Frame::Devices(DevicesFrame {
                    data: inner.to_string(),
                }),
            );
            if inner.starts_with("connected:") {
                activity.notify_one();
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
        push(&tx, &Frame::Log(log_frame));
        activity.notify_one();
    }
}

/// Arms only after the first ping, then fires if no ping arrives within
/// `STREAM_STALL_TIMEOUT_SECS`. Caller respawns the child on return.
async fn watch_for_stall(activity: Arc<Notify>) -> StreamOutcome {
    activity.notified().await;
    loop {
        match tokio::time::timeout(
            Duration::from_secs(STREAM_STALL_TIMEOUT_SECS),
            activity.notified(),
        )
        .await
        {
            Ok(()) => continue,
            Err(_) => return StreamOutcome::Stalled,
        }
    }
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
