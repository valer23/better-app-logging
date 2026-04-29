//! Per-port WebSocket server. Each platform bridge owns one of these.
//!
//! Architecture: bridges push pre-serialized JSON strings into a
//! `tokio::sync::broadcast::Sender`. This module's WS handler subscribes
//! to that broadcast and ships each item to its client. Multiple
//! clients can connect — each gets an independent `Receiver`.
//!
//! WS contract: on connect, sends an initial device-info `devices` frame
//! (the per-platform greeting), then streams `log` / `devices` / `error`
//! frames pushed by the bridge.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;

use crate::frame::{DevicesFrame, Frame};

/// Shared state cloned per connection.
#[derive(Clone)]
pub struct WsState {
    /// Broadcast channel populated by the platform bridge.
    pub tx: broadcast::Sender<String>,
    /// Greeting frame produced lazily and sent once per new connection,
    /// before any broadcast traffic. Typically a `devices` snapshot.
    pub greeting: Arc<dyn Fn() -> String + Send + Sync>,
}

/// Bind axum on `127.0.0.1:port` and serve `/` as a WebSocket upgrade.
pub async fn serve(port: u16, state: WsState) -> Result<(), String> {
    let app = Router::new().route("/", any(ws_handler)).with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("ws bind 127.0.0.1:{port}: {e}"))?;
    tracing::info!("ws server listening on ws://127.0.0.1:{port}");
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("axum::serve ws: {e}"))?;
    Ok(())
}

/// Allowed `Origin` header values for browser-initiated WS connections.
///
/// The Tauri viewer is served at `http://localhost:8780` (or its 127.0.0.1
/// alias). Native Tauri webview connections do not send an `Origin` header,
/// so an absent header is also accepted. Any other Origin (e.g. a malicious
/// page loaded in the user's regular browser) is rejected with HTTP 403 to
/// prevent log-stream exfiltration.
const ALLOWED_ORIGINS: &[&str] = &["http://localhost:8780", "http://127.0.0.1:8780"];

fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN) {
        None => true, // native Tauri webview — no Origin sent
        Some(value) => match value.to_str() {
            Ok(s) => ALLOWED_ORIGINS.contains(&s),
            Err(_) => false, // non-ASCII / invalid header bytes
        },
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<WsState>,
) -> Response {
    if !origin_allowed(&headers) {
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<invalid>");
        tracing::warn!("ws upgrade rejected: disallowed Origin {origin}");
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    ws.on_upgrade(move |socket| handle_connection(socket, state))
        .into_response()
}

async fn handle_connection(socket: WebSocket, state: WsState) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = state.tx.subscribe();

    // Send greeting `devices` frame on connect — matches Python behaviour.
    // The greeting closure shells out to `ideviceinfo` / `adb devices`, which
    // are blocking syscalls. Run it on the blocking-IO thread pool so the
    // async runtime worker thread is not parked during process spawn/wait.
    let greeting_fn = state.greeting.clone();
    let greeting = match tokio::task::spawn_blocking(move || (greeting_fn)()).await {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!("greeting task failed: {err}");
            String::new()
        }
    };
    let greet_frame = Frame::Devices(DevicesFrame { data: greeting });
    if let Ok(json) = serde_json::to_string(&greet_frame) {
        if sink.send(Message::Text(json)).await.is_err() {
            return;
        }
    }

    // Forward broadcast → WS until the client disconnects or sends Close.
    loop {
        tokio::select! {
            recv = rx.recv() => {
                match recv {
                    Ok(json) => {
                        if sink.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("ws client lagged by {n} frames");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            client_msg = stream.next() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {} // ignore inbound — viewer is read-only
                }
            }
        }
    }
    tracing::debug!("ws client disconnected");
}
