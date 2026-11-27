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
//!   The installer runs in the helper's job and dies with it (only per-user
//!   installs, which need no elevation, update in place).
//! - A marker whose lock is free is left over from a crash, and is removed,
//!   under the probe's own hold on the lock, so it is never a new holder's.
//! - Markers and results are written whole: to a temporary file, then renamed.

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

/// Write `bytes` to `path` whole: into a temporary file next to it, then
/// renamed over it, so a reader never sees half of it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
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
}

impl InstallGuard {
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

    let marker = InstallMarker {
        version: version.to_string(),
        started_at: now(),
        pid: std::process::id(),
    };
    if let Err(e) = write_atomic(&marker_path(data_dir), &serde_json::to_vec(&marker)?) {
        let _ = file.unlock();
        return Err(anyhow::Error::from(e).context("record the install in update.json"));
    }
    Ok(InstallGuard {
        file: Some(file),
        data_dir: data_dir.to_path_buf(),
    })
}

/// The install under way, if one is: its lock is held.
pub fn install_in_progress(data_dir: &Path) -> Option<InstallMarker> {
    install_in_progress_probing(data_dir, || {})
}

/// [`install_in_progress`], calling `while_held` while the probe holds the
/// lock (tests: another process trying to start an install right then).
fn install_in_progress_probing(
    data_dir: &Path,
    while_held: impl FnOnce(),
) -> Option<InstallMarker> {
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
            },
        )),
        Err(std::fs::TryLockError::Error(_)) => None,
        // Free: its holder is gone. A marker is a crash's leftover; it is
        // removed while this probe still holds the lock, so no new holder can
        // have written it meanwhile. Then unlocked explicitly, not on close: a
        // process another thread forks meanwhile shares this descriptor until
        // it execs, and would keep the lock held past our return.
        Ok(()) => {
            while_held();
            if marker_path(data_dir).exists() {
                let _ = std::fs::remove_file(marker_path(data_dir));
            }
            let _ = file.unlock();
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
    write_atomic(&result_path(data_dir), &serde_json::to_vec(result)?)
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
        };
        std::fs::write(marker_path(&d), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(install_in_progress(&d), None);
        assert!(!marker_path(&d).exists(), "removed");
    }

    #[test]
    fn a_probe_never_removes_the_marker_of_an_install_that_starts_meanwhile() {
        // A crash's leftover marker, and a probe that finds the lock free.
        let d = dir("race");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(lock_path(&d), b"").unwrap();
        std::fs::write(
            marker_path(&d),
            br#"{"version":"0.4.0","started_at":1,"pid":1}"#,
        )
        .unwrap();
        let mut started = None;
        let seen = install_in_progress_probing(&d, || {
            // Another process starts an install right then: it cannot until
            // the probe is done with the leftover.
            started = Some(begin_install(&d, "0.5.0").is_err());
        });
        assert_eq!(seen, None);
        assert_eq!(
            started,
            Some(true),
            "the probe held the lock through its clean-up"
        );
        // Once the probe is done, a new install starts and keeps its marker.
        let guard = begin_install(&d, "0.5.0").unwrap();
        assert_eq!(
            install_in_progress(&d).map(|m| m.version),
            Some("0.5.0".into())
        );
        assert!(marker_path(&d).exists());
        guard.release();
    }

    #[test]
    fn writes_whole_files_and_leaves_no_temporary_one() {
        let d = dir("atomic");
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join("update-result.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let names: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["update-result.json"]);
        // A failed write says so and leaves nothing behind.
        let missing = d.join("no-such-dir").join("x.json");
        assert!(write_atomic(&missing, b"x").is_err());
    }

    #[test]
    fn a_marker_that_cannot_be_written_is_no_install() {
        let d = dir("unwritable");
        std::fs::create_dir_all(&d).unwrap();
        // update.json is a directory: the marker cannot be written there.
        std::fs::create_dir_all(marker_path(&d)).unwrap();
        let err = begin_install(&d, "0.5.0").unwrap_err();
        assert!(format!("{err:#}").contains("update.json"), "{err:#}");
        // And the lock it took is released.
        std::fs::remove_dir(marker_path(&d)).unwrap();
        drop(begin_install(&d, "0.5.0").unwrap());
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
