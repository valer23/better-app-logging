//! Embedded HTTP server.
//!
//! Serves `applogs-viewer.html` (embedded at compile time so the Tauri bundle
//! is self-contained, and there is exactly one source of truth on disk under
//! `viewer/`).
//!
//! Routes on port 8780:
//! - `GET /` — viewer HTML
//! - `GET /devices/{android,ios}`, `GET /ios-driver-status` — device discovery
//! - `POST /ios/{pair,unpair,repair}` — iOS pairing actions
//! - `POST /window/glass-mode` — toggle macOS NSVisualEffectView material
//!
//! `Cache-Control: no-store` for fast iteration.

use std::sync::mpsc::Sender;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tauri::AppHandle;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::tooling;

/// Port the Tauri window is configured to load (`tauri.conf.json:13`).
pub const HTTP_PORT: u16 = 8780;

/// Embedded viewer HTML — single source of truth lives under `viewer/`.
const VIEWER_HTML: &str = include_str!("../../viewer/applogs-viewer.html");

/// Bind axum on `127.0.0.1:HTTP_PORT`, signal ready via `ready_tx`, then serve forever.
pub async fn serve(app: AppHandle, ready_tx: Sender<()>) -> Result<(), String> {
    // Lock CORS to the two loopback origins the Tauri window can present.
    // Native (no Origin header, e.g. direct curl / IPC) is not blocked by
    // CORS — the browser is the enforcer; tower-http only acts when an
    // Origin header is present.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "http://localhost:8780".parse().expect("static origin"),
            "http://127.0.0.1:8780".parse().expect("static origin"),
        ]))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let router: Router<AppHandle> = Router::new()
        .route("/", get(serve_index))
        .route("/devices/android", get(android_devices))
        .route("/devices/ios", get(ios_devices))
        .route("/ios-driver-status", get(ios_driver_status))
        .route("/ios/unpair", post(ios_unpair))
        .route("/ios/pair", post(ios_pair))
        .route("/ios/repair", post(ios_repair))
        .route("/window/glass-mode", post(set_glass_mode))
        .layer(cors);
    let app_router = router.with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", HTTP_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{HTTP_PORT}: {e}"))?;
    tracing::info!("http server listening on http://127.0.0.1:{HTTP_PORT}");
    if ready_tx.send(()).is_err() {
        tracing::warn!("http ready receiver already dropped — startup will hang");
    }
    axum::serve(listener, app_router)
        .await
        .map_err(|e| format!("axum::serve: {e}"))?;
    Ok(())
}

async fn serve_index() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(
            header::CACHE_CONTROL,
            "no-store, no-cache, must-revalidate, max-age=0",
        )
        .header(header::PRAGMA, "no-cache")
        .header(header::EXPIRES, "0")
        .body(Body::from(VIEWER_HTML))
        .expect("static response")
}

// ─── Device discovery ──────────────────────────────────────────────────────

async fn android_devices() -> Json<serde_json::Value> {
    let mut list: Vec<serde_json::Value> = vec![];
    let cmd = tooling::tokio_command("adb")
        .args(["devices", "-l"])
        .output()
        .await;
    if let Ok(out) = cmd {
        let text = String::from_utf8_lossy(&out.stdout);
        // Skip the "List of devices attached" header.
        // Each device line: "<id>  <status>  usb:X-Y  product:P  model:M  device:D  transport_id:T"
        for line in text.lines().skip(1) {
            let mut parts = line.split_whitespace();
            let Some(id) = parts.next() else { continue };
            let Some(status) = parts.next() else { continue };
            if status != "device" {
                continue;
            }
            let mut model = String::new();
            let mut product = String::new();
            for tok in parts {
                if let Some(v) = tok.strip_prefix("model:") {
                    model = v.to_string();
                } else if let Some(v) = tok.strip_prefix("product:") {
                    product = v.to_string();
                }
            }
            // Pretty name: model with underscores -> spaces; fallback to product, then id.
            let name = if !model.is_empty() {
                model.replace('_', " ")
            } else if !product.is_empty() {
                product.clone()
            } else {
                id.to_string()
            };
            list.push(serde_json::json!({
                "id":      id,
                "name":    name,
                "model":   model,
                "product": product,
                "status":  status,
            }));
        }
    }
    Json(serde_json::json!({ "devices": list }))
}

async fn ios_devices() -> Json<serde_json::Value> {
    let mut list: Vec<serde_json::Value> = vec![];
    let listing = tooling::tokio_command("idevice_id")
        .arg("-l")
        .output()
        .await;
    let Ok(listing) = listing else {
        return Json(serde_json::json!({ "devices": list }));
    };
    let udids: Vec<String> = String::from_utf8_lossy(&listing.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| valid_udid(s))
        .collect();
    for udid in udids {
        let name = ideviceinfo(&udid, "DeviceName").await.unwrap_or_default();
        let version = ideviceinfo(&udid, "ProductVersion")
            .await
            .unwrap_or_default();
        list.push(serde_json::json!({
            "id":      udid,
            "name":    if name.is_empty() { udid.as_str() } else { name.as_str() },
            "version": version,
        }));
    }
    Json(serde_json::json!({ "devices": list }))
}

/// Probe whether Apple Mobile Device Service (the kernel driver shim that
/// libimobiledevice talks to) is reachable on Windows. AMDS listens on
/// `127.0.0.1:27015` while running, so a successful TCP connect is the
/// cheapest reliable signal that the user has iTunes / Apple Devices
/// installed AND the service is up.
///
/// Always returns `available: true` on non-Windows hosts — there is no
/// equivalent prerequisite outside Windows.
async fn ios_driver_status() -> Json<serde_json::Value> {
    if !cfg!(windows) {
        return Json(serde_json::json!({
            "available": true,
            "reason":    "not_applicable",
        }));
    }
    let connect = tokio::net::TcpStream::connect(("127.0.0.1", 27015));
    let res = tokio::time::timeout(std::time::Duration::from_millis(500), connect).await;
    match res {
        Ok(Ok(_)) => Json(serde_json::json!({ "available": true,  "reason": "ok" })),
        _ => Json(serde_json::json!({ "available": false, "reason": "no_amds" })),
    }
}

/// UDID format guard: iOS UDIDs are 25 chars (modern, e.g.
/// `00008110-001E75E00E9B801E`) or 40 hex chars (legacy). Reject anything
/// that could carry shell metacharacters or arg-injection payloads before
/// it reaches `ideviceinfo -u <udid>`.
fn valid_udid(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

async fn ideviceinfo(udid: &str, key: &str) -> Option<String> {
    if !valid_udid(udid) {
        return None;
    }
    let out = tooling::tokio_command("ideviceinfo")
        .args(["-u", udid, "-k", key])
        .output()
        .await
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

// ─── iOS pairing ───────────────────────────────────────────────────────────
//
// `idevicepair unpair` deletes the pair record stored on the host; `pair`
// rewrites it after the user taps "Trust This Computer" on the phone. The
// stale-pair-record path is the most common cause of `idevicesyslog` going
// silent on iOS 17+, so we expose both as one-click UI actions.
//
// These endpoints are state-changing and run privileged platform tools, so we
// gate them with an Origin allowlist that mirrors `ws_server` — a malicious
// page in the user's regular browser must not be able to trigger an unpair
// via loopback CSRF.

/// `idevicepair pair` blocks while waiting for the Trust dialog tap. Cap it
/// so a forgotten/cancelled tap doesn't hang the HTTP handler indefinitely.
const PAIR_TIMEOUT_SECS: u64 = 30;
/// `unpair` is local-only — should be near-instant. Bound it anyway so a
/// stuck `lockdownd` can't wedge the request.
const UNPAIR_TIMEOUT_SECS: u64 = 5;

/// Origins allowed to invoke state-changing POST endpoints. The viewer is
/// served from `http://localhost:8780`, so a `fetch('/ios/repair', ...)`
/// from inside it sends one of these two Origin values. Any other Origin
/// — or a missing Origin (non-browser caller) — is rejected with HTTP 403.
const ALLOWED_POST_ORIGINS: &[&str] = &["http://localhost:8780", "http://127.0.0.1:8780"];

/// Returns `Err((status, message))` on rejection. The small `Err` shape keeps
/// `Result` slim — Clippy's `result_large_err` lint fires if the Err carries
/// a full `axum::Response` (~128 bytes), so we defer `into_response()` to the
/// call site instead.
fn require_browser_origin(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    match origin {
        Some(o) if ALLOWED_POST_ORIGINS.contains(&o) => Ok(()),
        _ => {
            tracing::warn!("[ios] POST rejected: Origin = {origin:?}");
            Err((StatusCode::FORBIDDEN, "forbidden origin"))
        }
    }
}

async fn ios_unpair(headers: HeaderMap) -> Response {
    if let Err(e) = require_browser_origin(&headers) {
        return e.into_response();
    }
    Json(run_idevicepair("unpair", UNPAIR_TIMEOUT_SECS).await).into_response()
}

async fn ios_pair(headers: HeaderMap) -> Response {
    if let Err(e) = require_browser_origin(&headers) {
        return e.into_response();
    }
    Json(run_idevicepair("pair", PAIR_TIMEOUT_SECS).await).into_response()
}

/// Combo flow: unpair, pair, then kill any stale `idevicesyslog` left over
/// from a prior connect attempt. The kill step is a cleanup — its result is
/// reported but never fails the overall repair, since "no matching process"
/// is the common case on a healthy host.
async fn ios_repair(headers: HeaderMap) -> Response {
    if let Err(e) = require_browser_origin(&headers) {
        return e.into_response();
    }
    let unpair = run_idevicepair("unpair", UNPAIR_TIMEOUT_SECS).await;
    if !unpair["ok"].as_bool().unwrap_or(false) {
        // Unpair failure with "ERROR: Device ... is not paired" is benign — fall through to pair.
        let stderr = unpair["stderr"].as_str().unwrap_or("");
        if !stderr.to_lowercase().contains("not paired") {
            return Json(serde_json::json!({
                "ok": false,
                "step": "unpair",
                "stdout": unpair["stdout"],
                "stderr": unpair["stderr"],
                "error": unpair["error"],
            }))
            .into_response();
        }
    }
    let pair = run_idevicepair("pair", PAIR_TIMEOUT_SECS).await;
    let kill = kill_stale_idevicesyslog().await;
    Json(serde_json::json!({
        "ok": pair["ok"],
        "step": "pair",
        "stdout": pair["stdout"],
        "stderr": pair["stderr"],
        "error": pair["error"],
        "unpair_stdout": unpair["stdout"],
        "unpair_stderr": unpair["stderr"],
        "kill_stale": kill,
    }))
    .into_response()
}

/// Kill any leftover `idevicesyslog` processes still holding the device
/// after a prior connect attempt. On Unix this is `pkill -f idevicesyslog`;
/// on Windows it's `taskkill /F /IM idevicesyslog.exe`.
///
/// Best-effort: "no matching process" is benign (pkill exit 1, taskkill exit
/// 128) and is reported as `ok: true` so the UI does not flag a healthy host
/// as broken. Anything else is surfaced verbatim alongside the pair output.
async fn kill_stale_idevicesyslog() -> serde_json::Value {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, &[&str]) = ("taskkill", &["/F", "/IM", "idevicesyslog.exe"]);
    #[cfg(not(target_os = "windows"))]
    let (cmd, args): (&str, &[&str]) = ("pkill", &["-f", "idevicesyslog"]);

    tracing::info!("[ios] {cmd} {}", args.join(" "));
    let mut child = match tokio::process::Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "stdout": "",
                "stderr": "",
                "error": format!("spawn {cmd}: {e}"),
            });
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout.map(|mut s| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf).await;
            buf
        })
    });
    let stderr_task = stderr.map(|mut s| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf).await;
            buf
        })
    });

    let status_opt =
        match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
            Ok(Ok(s)) => Some(s),
            _ => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                None
            }
        };

    let so = match stdout_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let se = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let exit_code = status_opt.and_then(|s| s.code());
    // pkill: 0 = killed at least one, 1 = no matches. taskkill: 0 = killed,
    // 128 = no matching task. Treat all three as success — the post-condition
    // ("no idevicesyslog running") holds in every case.
    let ok = matches!(exit_code, Some(0) | Some(1) | Some(128));
    serde_json::json!({
        "ok": ok,
        "exit": exit_code,
        "stdout": String::from_utf8_lossy(&so).trim(),
        "stderr": String::from_utf8_lossy(&se).trim(),
    })
}

/// Spawn `idevicepair <sub>`, wait up to `timeout_secs`, and return a uniform
/// JSON result.
///
/// On timeout the child is killed *and reaped* (`kill().await` then
/// `wait().await`) — `tokio::time::timeout` only drops the future, which by
/// itself does not terminate the underlying child. Without the explicit
/// kill + wait, a user who never taps "Trust This Computer" could stack up
/// stuck `idevicepair pair` processes by retrying the button.
async fn run_idevicepair(sub: &str, timeout_secs: u64) -> serde_json::Value {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    tracing::info!("[ios] idevicepair {sub}");
    let mut child = match tooling::tokio_command("idevicepair")
        .arg(sub)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true) // belt-and-braces: kill if the handler future is dropped
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "stdout": "",
                "stderr": "",
                "error": format!("spawn idevicepair {sub}: {e} (is libimobiledevice installed?)"),
            });
        }
    };

    // Drain stdout/stderr in dedicated tasks so a full pipe buffer never
    // blocks `child.wait()`. They own the readers and finish on EOF (which
    // happens naturally when the child exits or is killed below).
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout.map(|mut s| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf).await;
            buf
        })
    });
    let stderr_task = stderr.map(|mut s| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf).await;
            buf
        })
    });

    let (status_opt, timed_out, io_err) = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    )
    .await
    {
        Ok(Ok(s)) => (Some(s), false, None),
        Ok(Err(e)) => (None, false, Some(e.to_string())),
        Err(_) => {
            // Timeout: explicit kill + reap so we don't leak a zombie or
            // accumulate stuck pair processes across retries.
            let _ = child.kill().await;
            let _ = child.wait().await;
            (None, true, None)
        }
    };

    let so = match stdout_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let se = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };

    if timed_out {
        return serde_json::json!({
            "ok": false,
            "stdout": String::from_utf8_lossy(&so).trim(),
            "stderr": String::from_utf8_lossy(&se).trim(),
            "error": format!(
                "idevicepair {sub} timed out after {timeout_secs}s — \
                 if pairing, make sure the iPhone is unlocked and tap 'Trust This Computer'."
            ),
        });
    }
    if let Some(e) = io_err {
        return serde_json::json!({
            "ok": false,
            "stdout": String::from_utf8_lossy(&so).trim(),
            "stderr": String::from_utf8_lossy(&se).trim(),
            "error": format!("idevicepair {sub} I/O error: {e}"),
        });
    }
    let ok = status_opt.map(|s| s.success()).unwrap_or(false);
    serde_json::json!({
        "ok": ok,
        "stdout": String::from_utf8_lossy(&so).trim(),
        "stderr": String::from_utf8_lossy(&se).trim(),
        "error": serde_json::Value::Null,
    })
}

// ─── Window effects ─────────────────────────────────────────────────────────

/// Request body for `POST /window/glass-mode`.
#[derive(Deserialize)]
struct GlassModeReq {
    enabled: bool,
}

/// Toggle NSVisualEffectView material on the `main` window.
///
/// On non-macOS targets, Tauri's `set_effects` is a no-op for
/// macOS-specific materials, so this handler is safe to call (and reach via the
/// frontend) on any platform — the frontend, however, gates the toggle UI to
/// darwin only.
async fn set_glass_mode(
    State(app): State<AppHandle>,
    Json(req): Json<GlassModeReq>,
) -> Response {
    use tauri::utils::config::WindowEffectsConfig;
    use tauri::utils::{WindowEffect, WindowEffectState};
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "main window missing").into_response();
    };

    let result = if req.enabled {
        let cfg = WindowEffectsConfig {
            effects: vec![WindowEffect::HudWindow],
            state: Some(WindowEffectState::FollowsWindowActiveState),
            radius: None,
            color: None,
        };
        window.set_effects(cfg)
    } else {
        window.set_effects(None)
    };

    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::warn!("set_glass_mode failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response()
        }
    }
}
