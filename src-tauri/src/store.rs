//! Native log store + search.
//!
//! Bridges push every `LogFrame` here in addition to the WebSocket
//! broadcast. The frontend's in-memory `allMessages` JS array stays in
//! lockstep order, so indices returned by `search()` map 1:1 to the
//! viewer's array — used by the M4 search shim injected into the HTML.

use std::sync::Arc;

use aho_corasick::AhoCorasick;
use regex::Regex;
use tokio::sync::RwLock;

use crate::frame::LogFrame;

/// Threshold above which `search` runs on a blocking pool to avoid
/// stalling the Tauri main loop. Below this we run inline.
const BLOCKING_THRESHOLD: usize = 10_000;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Plain,
    Regex,
}

#[derive(Clone)]
pub struct LogStore {
    inner: Arc<RwLock<Vec<LogFrame>>>,
}

impl LogStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Vec::with_capacity(8192))),
        }
    }

    /// Append one frame. Amortized O(1).
    pub async fn push(&self, frame: LogFrame) {
        self.inner.write().await.push(frame);
    }

    /// Substring/regex search across the message column. Returns matching
    /// indices into the snapshot. Push-only store means indices stay
    /// valid for as long as the caller cares.
    pub async fn search(&self, query: String, mode: SearchMode) -> Result<Vec<u32>, String> {
        if query.is_empty() {
            let snap = self.inner.read().await;
            return Ok((0..snap.len() as u32).collect());
        }

        let len = self.inner.read().await.len();

        if len < BLOCKING_THRESHOLD {
            let snap = self.inner.read().await;
            scan(&snap, &query, &mode)
        } else {
            // Heavy scan: blocking pool.
            let inner = self.inner.clone();
            tokio::task::spawn_blocking(move || {
                let snap = inner.blocking_read();
                scan(&snap, &query, &mode)
            })
            .await
            .map_err(|e| format!("search task: {e}"))?
        }
    }

    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }
}

fn scan(snap: &[LogFrame], query: &str, mode: &SearchMode) -> Result<Vec<u32>, String> {
    match mode {
        SearchMode::Plain => {
            let ac = AhoCorasick::builder()
                .ascii_case_insensitive(true)
                .build([query])
                .map_err(|e| format!("aho-corasick build: {e}"))?;
            Ok(snap
                .iter()
                .enumerate()
                .filter(|(_, f)| ac.is_match(f.msg.as_bytes()))
                .map(|(i, _)| i as u32)
                .collect())
        }
        SearchMode::Regex => {
            let re = Regex::new(&format!("(?i){query}"))
                .map_err(|e| format!("invalid regex: {e}"))?;
            Ok(snap
                .iter()
                .enumerate()
                .filter(|(_, f)| re.is_match(&f.msg))
                .map(|(i, _)| i as u32)
                .collect())
        }
    }
}
