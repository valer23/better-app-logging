//! Native log store.
//!
//! Bridges push every `LogFrame` here in addition to the WebSocket
//! broadcast. Kept as a shared in-memory store; current consumers only
//! call `push` and `len`.

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::frame::LogFrame;

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

    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }
}
