//! Per-platform device-log bridges. Each spawns a long-running
//! subprocess (`adb logcat`, `idevicesyslog`), parses its stdout into
//! `frame::LogFrame` JSON strings, and pushes them to a tokio broadcast
//! channel that the WS server fans out to connected viewers.

pub mod android;
pub mod ios;
