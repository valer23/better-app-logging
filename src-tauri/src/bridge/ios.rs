//! iOS bridge — spawns `idevicesyslog --no-colors`, parses each line into
//! a `Frame::Log`, broadcasts JSON to WS subscribers.
//!
//! Auto-respawns on subprocess exit (2 s backoff) so unplugging + replugging
//! the iPhone resumes streaming without restarting the app.
//!
//! "Quiet system noise" (`set_quiet`, `POST /ios/quiet`) adds `-q` and
//! `-e <QUIET_EXTRA_EXCLUDES>`: idevicesyslog then drops those processes'
//! lines before they reach us. A change kills the running child and respawns
//! it at once with the new arguments.

use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::Datelike;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, watch, Notify};

use crate::children::{self, Registry};
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

/// Processes "Quiet system noise" excludes on top of idevicesyslog's own `-q`
/// list (`idevicesyslog --quiet-list`). Measured on an iPhone streaming 6-13k
/// lines/s: `-q` alone cut 10 s from 8 387 lines to 545, and these five led
/// what was left (IntelligencePlatformComputeService bursts reach 13k/s).
/// The only copy of the list; not user-editable until P14's Settings.
pub(crate) const QUIET_EXTRA_EXCLUDES: &[&str] = &[
    "PerfPowerServices",
    "IntelligencePlatformComputeService",
    "wirelessinsightsd",
    "cameracaptured",
    "searchpartyd",
];

/// The "Quiet system noise" setting, process-wide (precedent: `children::GLOBAL`).
/// Off at launch; the page re-sends a saved "on" when it loads. A watch channel
/// rather than an atomic, so a change wakes the running stream at once.
static QUIET: LazyLock<watch::Sender<bool>> = LazyLock::new(|| watch::Sender::new(false));

/// Sets "Quiet system noise" (`POST /ios/quiet`); returns the stored value.
pub fn set_quiet(on: bool) -> bool {
    store_quiet(&QUIET, on)
}

/// Notifies the bridge only on a real change, so the same value sent again
/// (every page load) never restarts idevicesyslog.
fn store_quiet(quiet: &watch::Sender<bool>, on: bool) -> bool {
    if quiet.send_if_modified(|v| std::mem::replace(v, on) != on) {
        tracing::info!("[ios] quiet system noise {}", if on { "on" } else { "off" });
    }
    *quiet.borrow()
}

/// idevicesyslog's arguments. Quiet adds `-q -e "a|b|…"`, the form measured
/// above (one `-e`, names joined by `|`). No shell is involved, so `|` is
/// literal on Windows too. Never add `-p`: idevicesyslog refuses it with `-e`/`-q`.
fn syslog_args(quiet: bool) -> Vec<String> {
    let mut args = vec!["--no-colors".to_string()];
    if quiet {
        args.extend([
            "-q".to_string(),
            "-e".to_string(),
            QUIET_EXTRA_EXCLUDES.join("|"),
        ]);
    }
    args
}

/// Spawn the iOS bridge worker. Returns immediately; runs forever in a tokio task.
pub fn spawn(tx: broadcast::Sender<String>) {
    tauri::async_runtime::spawn(async move {
        let mut quiet = QUIET.subscribe();
        loop {
            let on = *quiet.borrow_and_update();
            let res = run_once(&tx, on, &mut quiet).await;
            // App is exiting (children already killed): stop instead of
            // surfacing the resulting EOF as a bridge error and respawning.
            if children::is_shutting_down() {
                tracing::debug!("[ios] shutdown — bridge loop exit");
                break;
            }
            match res {
                // Quiet changed: respawn now with the new arguments, without an
                // error frame or the backoff.
                Ok(Respawn::Now) => continue,
                Ok(Respawn::AfterBackoff) => {}
                Err(e) => {
                    tracing::warn!("[ios] bridge error: {e}");
                    emit_error(&tx, &format!("ios bridge error: {e}"));
                }
            }
            // Respawn delay — gives the device a chance to come back if it was
            // unplugged. A quiet change ends it early.
            backoff(&mut quiet).await;
        }
    });
}

/// When the loop spawns the next child after a run that was not an error.
#[derive(Debug)]
enum Respawn {
    Now,
    AfterBackoff,
}

async fn run_once(
    tx: &broadcast::Sender<String>,
    quiet: bool,
    changed: &mut watch::Receiver<bool>,
) -> Result<Respawn, String> {
    let args = syslog_args(quiet);
    tracing::info!("[ios] spawning idevicesyslog {}", args.join(" "));
    let mut cmd = tooling::tokio_command("idevicesyslog");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    stream_child(tx, &children::GLOBAL, &mut cmd, changed).await
}

/// Spawns `cmd` in `reg`, streams its stdout until EOF, a stall or a quiet
/// change, then kills and reaps it before returning, so two children never
/// overlap. `reg` is a parameter so the tests use their own registry.
async fn stream_child(
    tx: &broadcast::Sender<String>,
    reg: &'static Registry,
    cmd: &mut tokio::process::Command,
    changed: &mut watch::Receiver<bool>,
) -> Result<Respawn, String> {
    // Registered with `children` so it is killed on app exit — `kill_on_drop`
    // alone never fires there (see children.rs). The registry owns the child
    // from spawn; `kill_on_drop` only fires when `Tracked` is dropped on an
    // early return, or when `kill_all` drops a `Child` whose `start_kill` failed.
    let (child, stdout, stderr) = reg
        .spawn(cmd)
        .map_err(|e| format!("spawn idevicesyslog: {e} (is libimobiledevice installed?)"))?;

    let stdout = stdout.ok_or("no stdout")?;
    let stderr = stderr.ok_or("no stderr")?;

    // Drain stderr in a sibling task — forwarded as ErrorFrame. tokio::spawn:
    // this always runs inside a tokio runtime (Tauri's, or a test's).
    let stderr_tx = tx.clone();
    tokio::spawn(async move {
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
        () = quiet_changed(changed) => StreamOutcome::QuietChanged,
    };

    // Kill + reap before returning, in all branches, so we never leak a zombie
    // across respawns and never run two children. Harmless if the child has
    // already exited (`ReaderEof`) or `kill_all` already took it at shutdown;
    // on stall / reader error / quiet change it ensures the SIGKILL is reaped.
    child.kill_and_reap().await;

    match outcome {
        StreamOutcome::QuietChanged => {
            tracing::info!("[ios] quiet system noise changed — restarting idevicesyslog");
            Ok(Respawn::Now)
        }
        StreamOutcome::Stalled => {
            tracing::warn!("[ios] stream stalled after {STREAM_STALL_TIMEOUT_SECS}s — respawning");
            emit_error(tx, STALL_HINT);
            // Return Ok so the outer `spawn` loop respawns silently without
            // also emitting a generic "ios bridge error: stream stalled" frame
            // — that would overwrite the actionable hint above in the UI.
            Ok(Respawn::AfterBackoff)
        }
        StreamOutcome::ReaderEof => Err("idevicesyslog exited (EOF)".into()),
        StreamOutcome::ReaderErr(e) => Err(e),
    }
}

enum StreamOutcome {
    Stalled,
    QuietChanged,
    ReaderEof,
    ReaderErr(String),
}

/// The respawn delay. A quiet change ends it early, so the new setting
/// applies at once (for example while no iPhone is plugged in).
async fn backoff(changed: &mut watch::Receiver<bool>) {
    tokio::select! {
        () = tokio::time::sleep(Duration::from_secs(2)) => {}
        () = quiet_changed(changed) => {}
    }
}

/// Resolves on the next quiet change. The sender is a static and never drops;
/// if it ever did, this waits forever instead of spinning the loop.
async fn quiet_changed(changed: &mut watch::Receiver<bool>) {
    if changed.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_off_are_the_plain_stream() {
        assert_eq!(syslog_args(false), ["--no-colors"]);
    }

    #[test]
    fn args_on_add_quiet_and_one_joined_exclude() {
        let a = syslog_args(true);
        assert_eq!(a[..3], ["--no-colors", "-q", "-e"]);
        assert_eq!(a.len(), 4, "one -e: the extra list is joined, not repeated");
        assert_eq!(a[3], QUIET_EXTRA_EXCLUDES.join("|"));
        assert!(
            !a.iter().any(|s| s == "-p"),
            "-p conflicts with -e/-q in idevicesyslog"
        );
        for p in QUIET_EXTRA_EXCLUDES {
            assert!(
                !p.is_empty() && !p.contains('|') && !p.contains(char::is_whitespace),
                "{p}"
            );
        }
    }

    #[test]
    fn store_quiet_notifies_only_on_a_real_change() {
        let (q, mut rx) = watch::channel(false);
        assert!(!store_quiet(&q, false));
        assert!(
            !rx.has_changed().unwrap(),
            "the same value (each page load) must not restart the stream"
        );
        assert!(store_quiet(&q, true));
        assert!(rx.has_changed().unwrap());
        rx.borrow_and_update();
        assert!(store_quiet(&q, true));
        assert!(!rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn backoff_ends_early_on_a_quiet_change() {
        let (q, mut rx) = watch::channel(false);
        store_quiet(&q, true);
        tokio::time::timeout(Duration::from_millis(500), backoff(&mut rx))
            .await
            .expect("backoff ignored the change");
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::process::Stdio;

        fn leaked() -> &'static Registry {
            Box::leak(Box::new(Registry::new()))
        }

        #[tokio::test]
        async fn quiet_change_restarts_now_and_reaps_the_old_child() {
            let reg = leaked();
            let (q, mut rx) = watch::channel(false);
            let (tx, _keep) = broadcast::channel::<String>(16);
            let run = tokio::spawn(async move {
                let mut cmd = tokio::process::Command::new("sleep");
                cmd.arg("30")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                stream_child(&tx, reg, &mut cmd, &mut rx).await
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(reg.len(), 1, "the child runs");
            store_quiet(&q, true);
            let res = tokio::time::timeout(Duration::from_secs(2), run)
                .await
                .expect("restart not prompt")
                .expect("task");
            assert!(matches!(res, Ok(Respawn::Now)), "{res:?}");
            assert_eq!(
                reg.len(),
                0,
                "killed and reaped before returning: never two children"
            );
        }

        #[tokio::test]
        async fn child_exit_is_an_error_and_is_reaped() {
            let reg = leaked();
            let (_q, mut rx) = watch::channel(false);
            let (tx, _keep) = broadcast::channel::<String>(16);
            let mut cmd = tokio::process::Command::new("true");
            cmd.stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let res = tokio::time::timeout(
                Duration::from_secs(2),
                stream_child(&tx, reg, &mut cmd, &mut rx),
            )
            .await
            .expect("EOF not seen");
            assert_eq!(res.unwrap_err(), "idevicesyslog exited (EOF)");
            assert_eq!(reg.len(), 0);
        }
    }
}
