//! WebSocket frame schemas. The frontend HTML parses these shapes verbatim.
//!
//! Four top-level types via the `type` discriminator:
//!   {"type":"log",     "ts","pid","tid","lvl","tag","app","msg"}
//!   {"type":"devices", "data":"<string>"}
//!   {"type":"error",   "data":"<string>"}
//!   {"type":"dropped", "count":<u64>}
//!
//! `dropped` is emitted per client by ws_server when that client's broadcast
//! receiver lagged; `count` = broadcast frames that client will never receive (mostly
//! log lines, but any devices/error frames in the gap are included).
//!
//! `lvl` ∈ VERBOSE | DEBUG | INFO | WARN | ERROR | ASSERT.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase", tag = "type")]
pub enum Frame {
    Log(LogFrame),
    Devices(DevicesFrame),
    Error(ErrorFrame),
    Dropped(DroppedFrame),
}

#[derive(Debug, Clone, Serialize)]
pub struct LogFrame {
    pub ts: String,
    pub pid: u32,
    pub tid: u32,
    pub lvl: String,
    pub tag: String,
    pub app: String,
    pub msg: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DevicesFrame {
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorFrame {
    pub data: String,
}

/// u64 matches `RecvError::Lagged`. Realistic values are far below 2^53, so
/// the number is exact when parsed as a JS double.
#[derive(Debug, Clone, Serialize)]
pub struct DroppedFrame {
    pub count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_frame_serializes_with_type_tag() {
        let v = serde_json::to_value(Frame::Dropped(DroppedFrame { count: 42 })).unwrap();
        assert_eq!(v, serde_json::json!({"type":"dropped","count":42}));
    }

    #[test]
    fn log_frame_keeps_type_tag() {
        let v = serde_json::to_value(Frame::Log(LogFrame {
            ts: String::new(),
            pid: 1,
            tid: 2,
            lvl: "INFO".into(),
            tag: String::new(),
            app: String::new(),
            msg: String::new(),
        }))
        .unwrap();
        assert_eq!(v["type"], "log");
    }
}
