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
    extract::State,
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use once_cell::sync::Lazy;

use crate::store::{LogStore, SearchMode};
use crate::tooling;

/// Port the Tauri window is configured to load (`tauri.conf.json:13`).
pub const HTTP_PORT: u16 = 8780;

/// Embedded viewer HTML — single source of truth lives under `viewer/`.
const VIEWER_HTML: &str = include_str!("../../viewer/logcat-viewer.html");

/// Inline JS shim appended to the served HTML before `</body>`. Routes
/// search through the native command via HTTP POST when the in-memory
/// log array exceeds 5_000 rows. Falls back to the original JS-side
/// filter for small arrays.
const SEARCH_SHIM: &str = include_str!("search_shim.js");

static SHIMMED_HTML: Lazy<String> = Lazy::new(|| {
    let shim = format!("<script>\n{SEARCH_SHIM}\n</script>\n</body>");
    if VIEWER_HTML.contains("</body>") {
        VIEWER_HTML.replacen("</body>", &shim, 1)
    } else {
        // Fallback: append at end of document.
        format!("{VIEWER_HTML}\n{shim}")
    }
});

/// Bind axum on `127.0.0.1:HTTP_PORT`, signal ready via `ready_tx`, then serve forever.
pub async fn serve(store: LogStore, ready_tx: Sender<()>) -> Result<(), String> {
    let app = Router::new()
        .route("/", get(serve_index))
        .route("/search", post(search_endpoint))
        .route("/devices/android", get(android_devices))
        .route("/devices/ios", get(ios_devices))
        .route("/ios-driver-status", get(ios_driver_status))
        .with_state(store);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", HTTP_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{HTTP_PORT}: {e}"))?;
    tracing::info!("http server listening on http://127.0.0.1:{HTTP_PORT}");
    let _ = ready_tx.send(());
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
        .body(Body::from(SHIMMED_HTML.as_str()))
        .expect("static response")
}

#[derive(serde::Deserialize)]
struct SearchReq {
    query: String,
    #[serde(default = "default_mode")]
    mode: SearchMode,
}

fn default_mode() -> SearchMode {
    SearchMode::Plain
}

#[derive(serde::Serialize)]
struct SearchResp {
    indices: Vec<u32>,
    total: usize,
    elapsed_ms: u64,
}

async fn search_endpoint(
    State(store): State<LogStore>,
    Json(req): Json<SearchReq>,
) -> Result<Json<SearchResp>, (StatusCode, String)> {
    let start = std::time::Instant::now();
    let total = store.len().await;
    let indices = store
        .search(req.query, req.mode)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(SearchResp {
        indices,
        total,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }))
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

async fn ideviceinfo(udid: &str, key: &str) -> Option<String> {
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
