//! Native log store.
//!
//! Bridges push every `LogFrame` here in addition to the WebSocket
//! broadcast. Kept as a shared in-memory store; current consumers only
//! call `push` and `len`.

use std::collections::VecDeque;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::frame::LogFrame;

/// Hard cap on retained frames. `adb logcat` on a busy device can emit
/// thousands of lines/sec; without a ceiling, long-lived sessions would
/// grow the buffer until host RAM is exhausted. At ~200B/frame this is
/// roughly 40 MB worst-case — a comfortable upper bound for an in-memory
/// rolling window.
const MAX_STORE_FRAMES: usize = 200_000;

#[derive(Clone)]
pub struct LogStore {
    inner: Arc<RwLock<VecDeque<LogFrame>>>,
}

impl LogStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(VecDeque::with_capacity(8192))),
        }
    }

    /// Append one frame, evicting the oldest entries when the buffer
    /// exceeds [`MAX_STORE_FRAMES`]. Eviction uses `VecDeque::pop_front`
    /// (O(1)) to keep amortized push cost constant under sustained
    /// high-throughput logcat streams.
    pub async fn push(&self, frame: LogFrame) {
        let mut buf = self.inner.write().await;
        buf.push_back(frame);
        while buf.len() > MAX_STORE_FRAMES {
            buf.pop_front();
        }
    }

    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }
}
