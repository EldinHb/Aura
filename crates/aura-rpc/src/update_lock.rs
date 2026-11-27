//! The cross-process guard of an app update. While Aura installs a new
//! version, nothing may start `aurad` or run `aura`: on Windows a running
//! `.exe` is locked, and the installer would leave the old binary in place
//! next to a new app (or fail). The process that installs (the app, or on
//! Windows the helper that runs the installer) holds an OS lock on
//! `update.lock` in the data directory for the whole install, and writes
//! what it installs to `update.json`.
//!
//! What is guaranteed:
//!
//! - **A held lock always means an install runs**, however long it takes.
//!   The holder bounds its own install (the Windows helper stops an
//!   installer after 30 minutes and releases the lock only once its whole
//!   process tree has stopped).
//! - **A dead holder never blocks Aura**: the lock lives on the file
//!   descriptor and the OS releases it when its holder exits, however it exits.
//! - **An installer that outlives its holder still counts.** The marker
//!   names the installer process (its pid and start time). An installer in
//!   the helper's job dies with the helper; an elevated one (started through
//!   the UAC prompt, outside any job) does not, so while the process the
//!   marker names still runs, the install counts as running, lock or not.
//! - A marker whose lock is free and whose installer has stopped is left
//!   over from a crash, and is removed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallMarker {
    /// The version being installed.
    pub version: String,
    /// Unix seconds when the install started.
    pub started_at: u64,
    /// The process holding the lock.
    pub pid: u32,
    /// The installer, once it runs.
    #[serde(default)]
    pub installer: Option<RunningProcess>,
}

/// A process, told apart from any later one with its pid (see `aura_contain::identity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningProcess {
    pub pid: u32,
    pub identity: String,
}

impl RunningProcess {
    /// Process `pid` as it runs now, if it does.
    pub fn of(pid: u32) -> Option<Self> {
        Some(Self {
            pid,
            identity: aura_contain::identity(pid)?,
        })
    }

    /// Whether this very process still runs.
    pub fn running(&self) -> bool {
        aura_contain::identity(self.pid).as_deref() == Some(self.identity.as_str())
    }
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

fn read_marker(data_dir: &Path) -> Option<InstallMarker> {
    std::fs::read(marker_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// Held for the length of an install; dropping it ends the install.
#[derive(Debug)]
pub struct InstallGuard {
    file: Option<std::fs::File>,
    data_dir: PathBuf,
    marker: InstallMarker,
}

impl InstallGuard {
    /// Record the installer process, so the install still counts if it
    /// outlives this guard's process.
    pub fn set_installer(&mut self, pid: u32) -> std::io::Result<()> {
        self.marker.installer = RunningProcess::of(pid);
        std::fs::write(
            marker_path(&self.data_dir),
            serde_json::to_vec(&self.marker)?,
        )
    }

    /// End the install: remove the marker and release the lock. Call only
    /// once the installer and everything it started have stopped.
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
/// error when another install runs.
pub fn begin_install(data_dir: &Path, version: &str) -> anyhow::Result<InstallGuard> {
    let file = open_lock(data_dir)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            anyhow::bail!("another Aura update is being installed")
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
    }
    // An installer left running by a holder that died (an elevated one) is
    // still installing.
    if let Some(m) = read_marker(data_dir) {
        if m.installer.as_ref().is_some_and(RunningProcess::running) {
            let _ = file.unlock();
            anyhow::bail!("another Aura update is being installed (its installer still runs)")
        }
    }
    let marker = InstallMarker {
        version: version.to_string(),
        started_at: now(),
        pid: std::process::id(),
        installer: None,
    };
    std::fs::write(marker_path(data_dir), serde_json::to_vec(&marker)?)?;
    Ok(InstallGuard {
        file: Some(file),
        data_dir: data_dir.to_path_buf(),
        marker,
    })
}

/// The install under way, if one is: its lock is held, or the installer it
/// names still runs.
pub fn install_in_progress(data_dir: &Path) -> Option<InstallMarker> {
    // No lock file: nothing was ever installed from here.
    if !lock_path(data_dir).exists() {
        return None;
    }
    let file = open_lock(data_dir).ok()?;
    match file.try_lock() {
        // Held: an install runs, however long it has.
        Err(std::fs::TryLockError::WouldBlock) => Some(read_marker(data_dir).unwrap_or(
            // Held but not written yet: an install, of something.
            InstallMarker {
                version: String::new(),
                started_at: now(),
                pid: 0,
                installer: None,
            },
        )),
        Err(std::fs::TryLockError::Error(_)) => None,
        // Free: its holder is gone. Unlock now rather than on close: a process
        // another thread forks meanwhile shares this descriptor until it execs,
        // and would keep the lock held past our return.
        Ok(()) => {
            let _ = file.unlock();
            let marker = read_marker(data_dir)?;
            if marker
                .installer
                .as_ref()
                .is_some_and(RunningProcess::running)
            {
                return Some(marker);
            }
            // Left over from a holder that died: nothing runs any more.
            let _ = std::fs::remove_file(marker_path(data_dir));
            None
        }
    }
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
    /// The version that was being installed.
    pub version: String,
    /// The installer reported success.
    pub ok: bool,
    /// What went wrong, in words, when something did.
    pub message: Option<String>,
    /// The version the installed files report, when they all agree.
    #[serde(default)]
    pub installed_version: Option<String>,
    /// The app, `aurad` and `aura` report the same version and the app's
    /// resources are there: Aura is whole, whatever the installer did.
    #[serde(default)]
    pub complete: bool,
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
    fn a_held_lock_counts_however_old_the_install() {
        let d = dir("old");
        let _guard = begin_install(&d, "0.5.0").unwrap();
        let ancient = InstallMarker {
            version: "0.5.0".into(),
            started_at: 1,
            pid: 1,
            installer: None,
        };
        std::fs::write(marker_path(&d), serde_json::to_vec(&ancient).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), Some(ancient));
    }

    #[test]
    fn a_marker_left_behind_without_its_lock_is_cleaned_up() {
        // A crashed holder: the OS dropped its lock, the marker stayed.
        let d = dir("crashed");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(lock_path(&d), b"").unwrap();
        let marker = InstallMarker {
            version: "0.5.0".into(),
            started_at: now(),
            pid: 1,
            installer: None,
        };
        std::fs::write(marker_path(&d), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), None);
        assert!(!marker_path(&d).exists(), "removed");
    }

    #[test]
    fn a_free_lock_with_a_live_installer_counts_and_a_dead_one_does_not() {
        let d = dir("installer");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(lock_path(&d), b"").unwrap();
        let mut installer = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let marker = InstallMarker {
            version: "0.5.0".into(),
            started_at: now(),
            pid: 1,
            installer: RunningProcess::of(installer.id()),
        };
        assert!(marker.installer.is_some());
        std::fs::write(marker_path(&d), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), Some(marker));
        let err = begin_install(&d, "0.5.1").unwrap_err();
        assert!(err.to_string().contains("installer still runs"), "{err}");
        installer.kill().unwrap();
        installer.wait().unwrap();
        assert_eq!(install_in_progress(&d), None);
        assert!(!marker_path(&d).exists());
        drop(begin_install(&d, "0.5.1").unwrap());
    }

    #[test]
    fn says_what_it_installs() {
        let m = InstallMarker {
            version: "0.5.0".into(),
            started_at: 0,
            pid: 0,
            installer: None,
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
    fn the_result_is_read_once_and_old_ones_still_read() {
        let d = dir("result");
        std::fs::create_dir_all(&d).unwrap();
        let r = InstallResult {
            version: "0.5.0".into(),
            ok: false,
            message: Some("exit code 2".into()),
            installed_version: Some("0.4.0".into()),
            complete: true,
        };
        write_result(&d, &r).unwrap();
        assert_eq!(take_result(&d), Some(r));
        assert_eq!(take_result(&d), None);
        std::fs::write(
            result_path(&d),
            br#"{"version":"0.5.0","ok":true,"message":null}"#,
        )
        .unwrap();
        let old = take_result(&d).unwrap();
        assert!(old.ok && !old.complete && old.installed_version.is_none());
    }
}
