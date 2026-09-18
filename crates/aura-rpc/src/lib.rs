//! Daemon RPC: JSON-RPC 2.0 over a loopback WebSocket, plus binary frames for
//! PTY bytes. Serves the desktop shell, the CLI and tests alike.
//!
//! Text frames carry JSON-RPC requests/responses/notifications. Binary frames
//! carry PTY data: `[kind:1][session_id:36 ascii][payload...]` where kind is
//! [`FRAME_PTY_OUTPUT`] (server->client) or [`FRAME_PTY_INPUT`] (client->server).

pub mod client;
pub mod fs;
pub mod server;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const FRAME_PTY_OUTPUT: u8 = 1;
pub const FRAME_PTY_INPUT: u8 = 2;
pub const SESSION_ID_LEN: usize = 36;

/// Written to `<data_dir>/daemon.json` so clients can find the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub method: String,
    pub params: serde_json::Value,
}

pub const ERR_PARSE: i64 = -32700;
pub const ERR_METHOD: i64 = -32601;
pub const ERR_PARAMS: i64 = -32602;
pub const ERR_INTERNAL: i64 = -32000;

pub fn encode_pty_frame(kind: u8, session_id: &str, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + SESSION_ID_LEN + data.len());
    v.push(kind);
    let mut id = [b' '; SESSION_ID_LEN];
    let b = session_id.as_bytes();
    let n = b.len().min(SESSION_ID_LEN);
    id[..n].copy_from_slice(&b[..n]);
    v.extend_from_slice(&id);
    v.extend_from_slice(data);
    v
}

pub fn decode_pty_frame(frame: &[u8]) -> Option<(u8, String, &[u8])> {
    if frame.len() < 1 + SESSION_ID_LEN {
        return None;
    }
    let kind = frame[0];
    let id = std::str::from_utf8(&frame[1..1 + SESSION_ID_LEN]).ok()?.trim_end().to_string();
    Some((kind, id, &frame[1 + SESSION_ID_LEN..]))
}

/// Default data directory: `~/.aura` (override with `AURA_DATA_DIR`).
pub fn default_data_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("AURA_DATA_DIR") {
        return std::path::PathBuf::from(p);
    }
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(".aura")
}

/// Take the single-instance lock on a data directory. `Ok(None)` means another
/// process already holds it.
///
/// `daemon.json` cannot enforce this on its own: if that file goes missing — a
/// crash, a manual delete, or an older build removing a newer daemon's copy on
/// its way out — the "already running" check passes and a second daemon opens
/// the same SQLite database. The lock lives on the file descriptor, so the OS
/// drops it when the process exits, however it exits.
pub fn lock_data_dir(data_dir: &std::path::Path) -> anyhow::Result<Option<std::fs::File>> {
    let path = data_dir.join("daemon.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| anyhow::Error::from(e).context(format!("open {}", path.display())))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(anyhow::Error::from(e).context(format!("lock {}", path.display()))),
    }
}

pub fn daemon_info_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("daemon.json")
}

pub fn read_daemon_info(data_dir: &std::path::Path) -> Option<DaemonInfo> {
    let s = std::fs::read_to_string(daemon_info_path(data_dir)).ok()?;
    serde_json::from_str(&s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pty_frame_roundtrip() {
        let id = "6bd613c3-559c-4cb9-b53c-5b1196062f48";
        let f = encode_pty_frame(FRAME_PTY_OUTPUT, id, b"hello");
        let (k, sid, data) = decode_pty_frame(&f).unwrap();
        assert_eq!(k, FRAME_PTY_OUTPUT);
        assert_eq!(sid, id);
        assert_eq!(data, b"hello");
        assert!(decode_pty_frame(b"short").is_none());
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn second_holder_is_refused_and_lock_is_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_data_dir(dir.path()).unwrap();
        assert!(first.is_some(), "first caller takes the lock");

        assert!(lock_data_dir(dir.path()).unwrap().is_none(), "second caller is refused while the first holds it");

        drop(first);
        assert!(lock_data_dir(dir.path()).unwrap().is_some(), "lock is available again once the holder goes away");
    }

    #[test]
    fn lock_is_independent_of_daemon_json() {
        // The exact failure: daemon.json is gone, so the advisory check passes —
        // the lock is what still has to refuse the second daemon.
        let dir = tempfile::tempdir().unwrap();
        let held = lock_data_dir(dir.path()).unwrap();
        assert!(held.is_some());
        assert!(read_daemon_info(dir.path()).is_none(), "no daemon.json in play");
        assert!(lock_data_dir(dir.path()).unwrap().is_none(), "still refused without daemon.json");
    }
}
