//! WebSocket frame schemas. The frontend HTML parses these shapes verbatim.
//!
//! Three top-level types via the `type` discriminator:
//!   {"type":"log",     "ts","pid","tid","lvl","tag","app","msg"}
//!   {"type":"devices", "data":"<string>"}
//!   {"type":"error",   "data":"<string>"}
//!
//! `lvl` ∈ VERBOSE | DEBUG | INFO | WARN | ERROR | ASSERT.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "type")]
pub enum Frame {
    Log(LogFrame),
    Devices(DevicesFrame),
    Error(ErrorFrame),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFrame {
    pub ts: String,
    pub pid: u32,
    pub tid: u32,
    pub lvl: String,
    pub tag: String,
    pub app: String,
    pub msg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicesFrame {
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorFrame {
    pub data: String,
}
