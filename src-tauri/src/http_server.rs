//! Embedded HTTP server.
//!
//! Serves `logcat-viewer.html` (embedded at compile time so the Tauri bundle
//! is self-contained, and there is exactly one source of truth on disk under
//! `viewer/`).
//!
//! Single `GET /` route on port 8780, `Cache-Control: no-store` for fast
//! iteration.

use std::sync::mpsc::Sender;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::tooling;

/// Port the Tauri window is configured to load (`tauri.conf.json:13`).
pub const HTTP_PORT: u16 = 8780;

/// Embedded viewer HTML — single source of truth lives under `viewer/`.
const VIEWER_HTML: &str = include_str!("../../viewer/logcat-viewer.html");

/// Bind axum on `127.0.0.1:HTTP_PORT`, signal ready via `ready_tx`, then serve forever.
pub async fn serve(ready_tx: Sender<()>) -> Result<(), String> {
    // Lock CORS to the two loopback origins the Tauri window can present.
    // Native (no Origin header, e.g. direct curl / IPC) is not blocked by
    // CORS — the browser is the enforcer; tower-http only acts when an
    // Origin header is present.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "http://localhost:8780".parse().expect("static origin"),
            "http://127.0.0.1:8780".parse().expect("static origin"),
        ]))
        .allow_methods([Method::GET])
        .allow_headers([header::CONTENT_TYPE]);
    let app = Router::new()
        .route("/", get(serve_index))
        .route("/devices/android", get(android_devices))
        .route("/devices/ios", get(ios_devices))
        .route("/ios-driver-status", get(ios_driver_status))
        .layer(cors);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", HTTP_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{HTTP_PORT}: {e}"))?;
    tracing::info!("http server listening on http://127.0.0.1:{HTTP_PORT}");
    if ready_tx.send(()).is_err() {
        tracing::warn!("http ready receiver already dropped — startup will hang");
    }
    axum::serve(listener, app)
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
        let version = ideviceinfo(&udid, "ProductVersion").await.unwrap_or_default();
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
        _         => Json(serde_json::json!({ "available": false, "reason": "no_amds" })),
    }
}

/// UDID format guard: iOS UDIDs are 25 chars (modern, e.g.
/// `00008110-001E75E00E9B801E`) or 40 hex chars (legacy). Reject anything
/// that could carry shell metacharacters or arg-injection payloads before
/// it reaches `ideviceinfo -u <udid>`.
fn valid_udid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
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
