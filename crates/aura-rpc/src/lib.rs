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
/// The caller may not use this method: a session's tools asked for something
/// that is the user's, or for another session.
pub const ERR_FORBIDDEN: i64 = -32003;

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
    let id = std::str::from_utf8(&frame[1..1 + SESSION_ID_LEN])
        .ok()?
        .trim_end()
        .to_string();
    Some((kind, id, &frame[1 + SESSION_ID_LEN..]))
}

/// Default data directory: `~/.aura` (override with `AURA_DATA_DIR`).
pub fn default_data_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("AURA_DATA_DIR") {
        return std::path::PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".aura")
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
        Err(std::fs::TryLockError::Error(e)) => {
            Err(anyhow::Error::from(e).context(format!("lock {}", path.display())))
        }
    }
}

pub fn daemon_info_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("daemon.json")
}

/// Stop the aurad that holds `data_dir` but does not answer, such as one that
/// ran out of open files and cannot take a connection: SIGTERM, which it
/// handles by stopping its sessions' agents and exiting, then SIGKILL after
/// 15 s. Only the daemon `info` describes is signalled (see [`is_daemon`]),
/// checked again before each signal. True once the data directory is free.
pub async fn stop_unresponsive_daemon(data_dir: &std::path::Path, info: &DaemonInfo) -> bool {
    stop_unresponsive_daemon_within(
        data_dir,
        info,
        std::time::Duration::from_secs(15),
        std::time::Duration::from_secs(5),
    )
    .await
}

/// [`stop_unresponsive_daemon`], waiting `term` after SIGTERM and `kill`
/// after SIGKILL.
pub async fn stop_unresponsive_daemon_within(
    data_dir: &std::path::Path,
    info: &DaemonInfo,
    term: std::time::Duration,
    kill: std::time::Duration,
) -> bool {
    let free = || matches!(lock_data_dir(data_dir), Ok(Some(_)));
    if free() {
        return true;
    }
    let tick = std::time::Duration::from_millis(100);
    for (force, wait) in [(false, term), (true, kill)] {
        // Checked before each signal: the daemon may have exited meanwhile
        // and its pid gone to another process.
        if !is_daemon(info) {
            tracing::warn!(
                pid = info.pid,
                "not signalled: no longer the aurad of daemon.json"
            );
            return free();
        }
        if force {
            tracing::warn!(pid = info.pid, "aurad did not stop in time; killing it");
        } else {
            tracing::warn!(pid = info.pid, "aurad does not answer; asking it to stop");
        }
        if !aura_core::process::terminate(info.pid, force) {
            return free();
        }
        let mut waited = std::time::Duration::ZERO;
        while waited < wait {
            tokio::time::sleep(tick).await;
            waited += tick;
            if free() {
                return true;
            }
        }
    }
    free()
}

/// Whether process `info.pid` is the daemon `info` describes: its executable
/// is named exactly `aurad` (`aurad.exe` on Windows), and it started no later
/// than the daemon wrote `daemon.json`. A pid that went to another process
/// after the daemon exited fails the second test, a process that only
/// happens to be named like it (`aurad-something`) the first.
pub fn is_daemon(info: &DaemonInfo) -> bool {
    let named = aura_core::process::process_name(info.pid).is_some_and(|n| is_daemon_name(&n));
    // `ps` gives whole seconds, and the daemon writes daemon.json after it started.
    named
        && aura_core::process::process_started(info.pid)
            .is_some_and(|t| t <= info.started_at + chrono::Duration::seconds(2))
}

/// Whether `exe` (a path, or the name alone) is the daemon's executable.
pub fn is_daemon_name(exe: &str) -> bool {
    std::path::Path::new(exe)
        .file_name()
        .is_some_and(|f| f == "aurad" || f == "aurad.exe")
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

        assert!(
            lock_data_dir(dir.path()).unwrap().is_none(),
            "second caller is refused while the first holds it"
        );

        drop(first);
        assert!(
            lock_data_dir(dir.path()).unwrap().is_some(),
            "lock is available again once the holder goes away"
        );
    }

    #[test]
    fn lock_is_independent_of_daemon_json() {
        // The exact failure: daemon.json is gone, so the advisory check passes —
        // the lock is what still has to refuse the second daemon.
        let dir = tempfile::tempdir().unwrap();
        let held = lock_data_dir(dir.path()).unwrap();
        assert!(held.is_some());
        assert!(
            read_daemon_info(dir.path()).is_none(),
            "no daemon.json in play"
        );
        assert!(
            lock_data_dir(dir.path()).unwrap().is_none(),
            "still refused without daemon.json"
        );
    }
}

#[cfg(all(test, unix))]
mod daemon_stop_tests {
    use super::*;
    use std::process::{Child, Command};
    use std::time::Duration;

    /// A long sleep run as an executable named `name` (a link to sleep, so
    /// `ps` shows that name). With `ignore_term` it ignores SIGTERM, as a
    /// daemon too stuck to act on it.
    fn named(dir: &std::path::Path, name: &str, ignore_term: bool) -> Child {
        let exe = dir.join(name);
        std::os::unix::fs::symlink("/bin/sleep", &exe).unwrap();
        let mut c = if ignore_term {
            let mut c = Command::new("/bin/sh");
            // An ignored signal stays ignored across exec.
            c.arg("-c")
                .arg(format!("trap '' TERM; exec '{}' 30", exe.display()));
            c
        } else {
            let mut c = Command::new(&exe);
            c.arg("30");
            c
        };
        let child = c.spawn().unwrap();
        // Until `ps` shows it under its name (the shell execs first).
        for _ in 0..50 {
            if aura_core::process::process_name(child.id()).is_some_and(|n| n.ends_with(name)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        child
    }

    fn info(
        dir: &std::path::Path,
        pid: u32,
        started_at: chrono::DateTime<chrono::Utc>,
    ) -> DaemonInfo {
        DaemonInfo {
            port: 1,
            token: "t".into(),
            pid,
            version: "0".into(),
            started_at,
            data_dir: dir.to_string_lossy().into_owned(),
        }
    }

    async fn stop(dir: &std::path::Path, info: &DaemonInfo) -> bool {
        stop_unresponsive_daemon_within(
            dir,
            info,
            Duration::from_millis(300),
            Duration::from_millis(300),
        )
        .await
    }

    fn alive(c: &mut Child) -> bool {
        c.try_wait().unwrap().is_none()
    }

    #[test]
    fn only_the_daemon_binary_name_counts() {
        assert!(is_daemon_name("aurad"));
        assert!(is_daemon_name(
            "/Applications/Aura.app/Contents/MacOS/aurad"
        ));
        assert!(is_daemon_name("aurad.exe"));
        assert!(!is_daemon_name("aurad-unrelated"));
        assert!(!is_daemon_name("/usr/local/bin/aurad-aarch64-apple-darwin"));
        assert!(!is_daemon_name("aurad2"));
        assert!(!is_daemon_name("xaurad"));
    }

    #[tokio::test]
    async fn a_process_only_named_like_the_daemon_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let _held = lock_data_dir(dir.path()).unwrap().unwrap();
        let mut other = named(dir.path(), "aurad-unrelated", false);
        let info = info(
            dir.path(),
            other.id(),
            chrono::Utc::now() + chrono::Duration::minutes(1),
        );
        assert!(!is_daemon(&info));
        assert!(!stop(dir.path(), &info).await);
        assert!(alive(&mut other), "it got no signal");
        other.kill().unwrap();
        other.wait().unwrap();
    }

    #[tokio::test]
    async fn a_pid_reused_after_the_daemon_wrote_daemon_json_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let _held = lock_data_dir(dir.path()).unwrap().unwrap();
        let mut later = named(dir.path(), "aurad", false);
        // The daemon of daemon.json started an hour ago; this one just now.
        let info = info(
            dir.path(),
            later.id(),
            chrono::Utc::now() - chrono::Duration::hours(1),
        );
        assert!(!is_daemon(&info));
        assert!(!stop(dir.path(), &info).await);
        assert!(alive(&mut later), "it got no signal");
        later.kill().unwrap();
        later.wait().unwrap();
    }

    #[tokio::test]
    async fn the_daemon_is_killed_when_it_ignores_the_request_to_stop() {
        let dir = tempfile::tempdir().unwrap();
        // Held by the test: the fake daemon never frees the directory.
        let _held = lock_data_dir(dir.path()).unwrap().unwrap();
        let mut daemon = named(dir.path(), "aurad", true);
        let info = info(
            dir.path(),
            daemon.id(),
            chrono::Utc::now() + chrono::Duration::minutes(1),
        );
        assert!(is_daemon(&info));
        assert!(
            !stop(dir.path(), &info).await,
            "the test still holds the lock"
        );
        let status = daemon.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(9),
            "SIGTERM was ignored, SIGKILL was not"
        );
    }
}
