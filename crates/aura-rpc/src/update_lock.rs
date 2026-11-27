//! The cross-process guard of an app update. While Aura installs a new
//! version, nothing may start `aurad` or run `aura`: on Windows a running
//! `.exe` is locked, and the installer would leave the old binary in place
//! next to a new app (or fail). The process that installs (the app, or on
//! Windows the helper that runs the installer) holds an OS lock on
//! `update.lock` in the data directory for the whole install, and writes
//! what it installs to `update.json`.
//!
//! The lock lives on the file descriptor, so the OS releases it when its
//! holder exits however it exits: a crashed install never blocks Aura. An
//! install that hangs is bounded too: a lock older than [`STALE_AFTER`] is
//! ignored.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// An install still running after this long is taken to hang and no longer
/// keeps anything from starting.
pub const STALE_AFTER: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallMarker {
    /// The version being installed.
    pub version: String,
    /// Unix seconds when the install started.
    pub started_at: u64,
    /// The process holding the lock.
    pub pid: u32,
}

pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join("update.lock")
}

pub fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("update.json")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn open_lock(data_dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path(data_dir))
}

/// Held for the length of an install; dropping it ends the install.
#[derive(Debug)]
pub struct InstallGuard {
    file: Option<std::fs::File>,
    data_dir: PathBuf,
}

impl InstallGuard {
    /// End the install: remove the marker and release the lock.
    pub fn release(mut self) {
        self.finish();
    }

    fn finish(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = std::fs::remove_file(marker_path(&self.data_dir));
            let _ = file.unlock();
        }
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Start an install of `version`: take the lock and write the marker. An
/// error when another install holds it.
pub fn begin_install(data_dir: &Path, version: &str) -> anyhow::Result<InstallGuard> {
    let file = open_lock(data_dir)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            anyhow::bail!("another Aura update is being installed")
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
    }
    let marker = InstallMarker {
        version: version.to_string(),
        started_at: now(),
        pid: std::process::id(),
    };
    std::fs::write(marker_path(data_dir), serde_json::to_vec(&marker)?)?;
    Ok(InstallGuard {
        file: Some(file),
        data_dir: data_dir.to_path_buf(),
    })
}

/// The install under way, if one is: its lock is held and it is not stale.
pub fn install_in_progress(data_dir: &Path) -> Option<InstallMarker> {
    // No lock file: nothing was ever installed from here.
    if !lock_path(data_dir).exists() {
        return None;
    }
    let file = open_lock(data_dir).ok()?;
    match file.try_lock() {
        // Free: no install runs (the lock goes with this handle).
        Ok(()) => None,
        Err(std::fs::TryLockError::Error(_)) => None,
        Err(std::fs::TryLockError::WouldBlock) => {
            let marker = std::fs::read(marker_path(data_dir))
                .ok()
                .and_then(|b| serde_json::from_slice::<InstallMarker>(&b).ok())
                // Held but unreadable (being written): an install, of something.
                .unwrap_or(InstallMarker {
                    version: String::new(),
                    started_at: now(),
                    pid: 0,
                });
            fresh(&marker, now()).then_some(marker)
        }
    }
}

/// Whether an install that started at `marker.started_at` may still run at `now`.
pub fn fresh(marker: &InstallMarker, now: u64) -> bool {
    now.saturating_sub(marker.started_at) < STALE_AFTER.as_secs()
}

/// What `aurad` and `aura` say when they refuse to run during an install.
pub fn installing_message(marker: &InstallMarker) -> String {
    if marker.version.is_empty() {
        "Aura is installing an update; try again when it has restarted.".into()
    } else {
        format!(
            "Aura is installing version {}; try again when it has restarted.",
            marker.version
        )
    }
}

/// Wait until no install runs, polling every `every`, at most `max`. True
/// when none runs any more.
pub async fn wait_for_install(data_dir: &Path, every: Duration, max: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        if install_in_progress(data_dir).is_none() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(every).await;
    }
}

/// How the last install ended, written by whoever finished it so the next
/// app start can say so (the installer ran without the app).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallResult {
    pub version: String,
    pub ok: bool,
    /// What went wrong, in words, when it did not succeed.
    pub message: Option<String>,
}

pub fn result_path(data_dir: &Path) -> PathBuf {
    data_dir.join("update-result.json")
}

pub fn write_result(data_dir: &Path, result: &InstallResult) -> std::io::Result<()> {
    std::fs::write(result_path(data_dir), serde_json::to_vec(result)?)
}

/// The result of the last install, removed once read.
pub fn take_result(data_dir: &Path) -> Option<InstallResult> {
    let path = result_path(data_dir);
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("aura-update-lock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn nothing_runs_without_a_lock() {
        let d = dir("none");
        assert_eq!(install_in_progress(&d), None);
    }

    #[test]
    fn an_install_is_seen_until_released() {
        let d = dir("held");
        let guard = begin_install(&d, "0.5.0").unwrap();
        let seen = install_in_progress(&d).expect("in progress");
        assert_eq!(seen.version, "0.5.0");
        assert_eq!(seen.pid, std::process::id());
        // A second install is refused.
        assert!(begin_install(&d, "0.5.1").is_err());
        guard.release();
        assert_eq!(install_in_progress(&d), None);
        assert!(!marker_path(&d).exists());
        // And can start again.
        drop(begin_install(&d, "0.5.1").unwrap());
        assert_eq!(install_in_progress(&d), None);
    }

    #[test]
    fn a_marker_left_behind_without_its_lock_means_nothing() {
        // A crashed holder: the OS dropped its lock, the marker stayed.
        let d = dir("crashed");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(lock_path(&d), b"").unwrap();
        let marker = InstallMarker {
            version: "0.5.0".into(),
            started_at: now(),
            pid: 1,
        };
        std::fs::write(marker_path(&d), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), None);
    }

    #[test]
    fn a_hanging_install_goes_stale() {
        let m = InstallMarker {
            version: "0.5.0".into(),
            started_at: 1_000,
            pid: 1,
        };
        assert!(fresh(&m, 1_000 + STALE_AFTER.as_secs() - 1));
        assert!(!fresh(&m, 1_000 + STALE_AFTER.as_secs()));
        // A stale lock still held is ignored.
        let d = dir("stale");
        let _guard = begin_install(&d, "0.5.0").unwrap();
        let old = InstallMarker {
            version: "0.5.0".into(),
            started_at: 1,
            pid: 1,
        };
        std::fs::write(marker_path(&d), serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), None);
    }

    #[test]
    fn says_what_it_installs() {
        let m = InstallMarker {
            version: "0.5.0".into(),
            started_at: 0,
            pid: 0,
        };
        assert!(installing_message(&m).contains("0.5.0"));
    }

    #[tokio::test]
    async fn waits_for_the_install_to_end() {
        let d = dir("wait");
        let guard = begin_install(&d, "0.5.0").unwrap();
        assert!(!wait_for_install(&d, Duration::from_millis(10), Duration::from_millis(50)).await);
        let releaser = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            guard.release();
        });
        assert!(wait_for_install(&d, Duration::from_millis(10), Duration::from_secs(5)).await);
        releaser.await.unwrap();
    }

    #[test]
    fn the_result_is_read_once() {
        let d = dir("result");
        std::fs::create_dir_all(&d).unwrap();
        let r = InstallResult {
            version: "0.5.0".into(),
            ok: false,
            message: Some("exit code 2".into()),
        };
        write_result(&d, &r).unwrap();
        assert_eq!(take_result(&d), Some(r));
        assert_eq!(take_result(&d), None);
    }
}
