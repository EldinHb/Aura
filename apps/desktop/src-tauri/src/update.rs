//! Self-update through `tauri-plugin-updater`: check the release manifest,
//! download and verify the signed package in the background, then stop the
//! daemon and install. The webview drives the flow (when to check, what to
//! show); this module does the work and says whether this install can update
//! itself at all.
//!
//! The daemon outlives the app, and the installer replaces its binary: on
//! Windows a running `aurad.exe` is locked and the installer would fail. So
//! [`update_install`] stops it first through the same path a daemon restart
//! uses (sessions stop, keep their state and resume on the next daemon), and
//! the relaunched app's `ensure_daemon` starts the new one.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Where releases are published; the manual download and release notes link here.
pub const RELEASES_URL: &str = "https://github.com/EldinHb/Aura/releases";

/// Set once the daemon has been stopped for an install: from then on nothing
/// may start the old daemon again (a window reconnecting, say). Cleared when
/// the install fails and the daemon is started again.
static INSTALLING: AtomicBool = AtomicBool::new(false);

pub fn installing() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}

/// The update found by the last check, and its package once downloaded.
#[derive(Default)]
pub struct Pending(tokio::sync::Mutex<Option<PendingUpdate>>);

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

/// Whether this copy of Aura can replace itself, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Support {
    InPlace,
    /// Updating means downloading the installer by hand; `reason` says why.
    Manual {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    pub current_version: String,
    /// Release builds check by themselves; dev builds only when asked.
    pub auto_check: bool,
    pub support: Support,
    pub releases_url: String,
    /// Test builds only (`updater-test` feature): restart as soon as an update is ready.
    pub test_auto_restart: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// The release's page, with its notes and every installer.
    pub release_url: String,
    pub support: Support,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    Finished,
}

/// An error the webview can phrase: what failed, in words, and of which kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Network,
    Signature,
    Permission,
    /// The daemon could not be stopped, so installing would fail or corrupt it.
    Daemon,
    Other,
}

impl UpdateError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<tauri_plugin_updater::Error> for UpdateError {
    fn from(e: tauri_plugin_updater::Error) -> Self {
        use tauri_plugin_updater::Error as E;
        let kind = match &e {
            E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound | E::Serialization(_) => {
                ErrorKind::Network
            }
            E::Minisign(_)
            | E::Base64(_)
            | E::SignatureUtf8(_)
            | E::SignedVersionMismatch { .. }
            | E::MissingSignedVersion => ErrorKind::Signature,
            E::AuthenticationFailed | E::PackageInstallFailed | E::DebInstallFailed => {
                ErrorKind::Permission
            }
            E::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => ErrorKind::Permission,
            _ => ErrorKind::Other,
        };
        let message = match kind {
            ErrorKind::Signature => {
                format!("The update's signature is not valid, so it was not installed ({e}).")
            }
            ErrorKind::Network => format!("Could not reach the update server: {e}"),
            ErrorKind::Permission => format!("Aura is not allowed to replace itself: {e}"),
            _ => e.to_string(),
        };
        Self { kind, message }
    }
}

/// What decides whether this install can update itself. Gathered per
/// platform by [`facts`]; [`decide`] is the pure rule, tested on every host.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub os: Os,
    /// The bundle the running binary was packaged in, as the bundler recorded it.
    pub bundle: Option<Bundle>,
    /// macOS: the `.app` the binary runs from, if it runs from one.
    pub app_bundle: Option<PathBuf>,
    /// macOS: the bundle runs from a location macOS randomised (App Translocation).
    pub translocated: bool,
    /// The location the update is written to is on a read-only file system
    /// (a mounted disk image, say).
    pub read_only: bool,
    /// Linux: the AppImage and its folder can be written by this user.
    pub writable: bool,
    /// Linux: a graphical way to ask for the administrator password exists
    /// (`pkexec`, `zenity` or `kdialog`), which installing a package needs.
    pub graphical_sudo: bool,
}

// Each build constructs its own platform's; the tests construct them all.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Os {
    #[default]
    Mac,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bundle {
    App,
    Nsis,
    Msi,
    AppImage,
    Deb,
    Rpm,
}

fn manual(reason: &str) -> Support {
    Support::Manual {
        reason: reason.into(),
    }
}

pub fn decide(f: &Facts) -> Support {
    match f.os {
        Os::Mac => {
            if f.app_bundle.is_none() {
                return manual("This copy of Aura does not run from an app bundle, so it cannot replace itself.");
            }
            if f.translocated {
                return manual("macOS runs Aura from a temporary read-only copy. Move Aura.app to Applications and open it from there to get updates automatically.");
            }
            if f.read_only {
                return manual("Aura runs from a read-only disk. Copy Aura.app to Applications and open it from there to get updates automatically.");
            }
            // A folder this user cannot write to (/Applications for a standard
            // user) is fine: the updater asks for an administrator's password.
            Support::InPlace
        }
        Os::Windows => match f.bundle {
            Some(Bundle::Nsis) | Some(Bundle::Msi) => Support::InPlace,
            _ => manual("This copy of Aura was not installed with the Aura installer, so it cannot replace itself."),
        },
        Os::Linux => match f.bundle {
            Some(Bundle::AppImage) if f.read_only => {
                manual("The AppImage is on a read-only disk, so it cannot be replaced.")
            }
            Some(Bundle::AppImage) if !f.writable => manual(
                "You cannot write to the AppImage or its folder, so it cannot be replaced.",
            ),
            Some(Bundle::AppImage) => Support::InPlace,
            Some(Bundle::Deb) | Some(Bundle::Rpm) if f.graphical_sudo => Support::InPlace,
            Some(Bundle::Deb) | Some(Bundle::Rpm) => manual("Installing the package needs your administrator password, and no way to ask for it was found (pkexec, zenity or kdialog). Install it with your package manager."),
            _ => manual("This copy of Aura was not installed from an AppImage, .deb or .rpm, so it cannot replace itself."),
        },
    }
}

fn bundle() -> Option<Bundle> {
    use tauri::utils::config::BundleType as B;
    Some(match tauri::utils::platform::bundle_type()? {
        B::App | B::Dmg => Bundle::App,
        B::Nsis => Bundle::Nsis,
        B::Msi => Bundle::Msi,
        B::AppImage => Bundle::AppImage,
        B::Deb => Bundle::Deb,
        B::Rpm => Bundle::Rpm,
    })
}

/// The `.app` holding `exe`, when it sits at `X.app/Contents/MacOS/exe`.
pub fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then(|| app.to_path_buf())
}

#[cfg(unix)]
fn read_only(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    unsafe { libc::statvfs(c.as_ptr(), &mut s) == 0 && s.f_flag & libc::ST_RDONLY != 0 }
}

#[cfg(unix)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

fn facts<R: Runtime>(_app: &AppHandle<R>) -> Facts {
    let exe = tauri::utils::platform::current_exe().ok();
    let mut f = Facts {
        bundle: bundle(),
        ..Default::default()
    };
    #[cfg(target_os = "macos")]
    {
        f.os = Os::Mac;
        f.app_bundle = exe.as_deref().and_then(app_bundle_of);
        if let Some(app) = &f.app_bundle {
            f.translocated = app.to_string_lossy().contains("/AppTranslocation/");
            f.read_only = app.parent().is_some_and(read_only);
        }
    }
    #[cfg(windows)]
    {
        let _ = exe;
        f.os = Os::Windows;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = exe;
        f.os = Os::Linux;
        if let Some(image) = _app.env().appimage.map(PathBuf::from) {
            // The bundler records the AppImage type, but trust where it runs from.
            f.bundle = Some(Bundle::AppImage);
            let dir = image.parent().map(Path::to_path_buf).unwrap_or_default();
            f.read_only = read_only(&image);
            f.writable = writable(&image) && writable(&dir);
        }
        f.graphical_sudo = ["pkexec", "zenity", "kdialog"]
            .iter()
            .any(|tool| crate::which(tool).is_some());
    }
    f
}

pub fn support<R: Runtime>(app: &AppHandle<R>) -> Support {
    decide(&facts(app))
}

fn release_url(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{version}")
}

/// Test builds only: the manifest URL from `AURA_UPDATER_ENDPOINT`, so an
/// end-to-end test can serve its own. Release builds never compile this in.
#[cfg(feature = "updater-test")]
fn test_endpoint() -> Option<tauri_plugin_updater::Result<Vec<url::Url>>> {
    let raw = std::env::var("AURA_UPDATER_ENDPOINT").ok()?;
    Some(raw.parse::<url::Url>().map(|u| vec![u]).map_err(Into::into))
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_updater::Updater, UpdateError> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    #[cfg(feature = "updater-test")]
    if let Some(endpoints) = test_endpoint() {
        tracing::warn!(
            "updater-test build: checking {:?}",
            std::env::var("AURA_UPDATER_ENDPOINT")
        );
        builder = builder.endpoints(endpoints?)?;
    }
    Ok(builder.build()?)
}

#[tauri::command]
pub fn update_config(app: AppHandle) -> UpdateConfig {
    UpdateConfig {
        current_version: app.package_info().version.to_string(),
        auto_check: !cfg!(debug_assertions),
        support: support(&app),
        releases_url: RELEASES_URL.into(),
        test_auto_restart: cfg!(feature = "updater-test")
            && std::env::var_os("AURA_UPDATER_TEST_AUTO_RESTART").is_some(),
    }
}

/// Ask the release manifest for a newer stable version. `None` when this is
/// the latest. A package already downloaded for the same version is kept.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: tauri::State<'_, Pending>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let found = updater(&app)?.check().await?;
    let mut slot = pending.0.lock().await;
    let Some(update) = found else {
        *slot = None;
        return Ok(None);
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
        date: update.date.map(|d| d.to_string()),
        release_url: release_url(&update.version),
        support: support(&app),
    };
    let bytes = slot
        .take()
        .filter(|p| p.update.version == update.version)
        .and_then(|p| p.bytes);
    *slot = Some(PendingUpdate { update, bytes });
    tracing::info!(version = %info.version, "update available");
    Ok(Some(info))
}

/// Download the update found by the last check and verify its signature.
#[tauri::command]
pub async fn update_download(
    pending: tauri::State<'_, Pending>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), UpdateError> {
    let update = {
        let slot = pending.0.lock().await;
        let p = slot.as_ref().ok_or_else(|| {
            UpdateError::new(
                ErrorKind::Other,
                "No update to download; check for updates first.",
            )
        })?;
        if p.bytes.is_some() {
            let _ = on_event.send(DownloadEvent::Finished);
            return Ok(());
        }
        p.update.clone()
    };
    let mut downloaded = 0u64;
    let mut last_sent = 0u64;
    // `download` verifies the signature before it returns the bytes.
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // A message per chunk floods the webview; one per 256 KiB is plenty.
                if downloaded - last_sent >= 256 * 1024 || Some(downloaded) == total {
                    last_sent = downloaded;
                    let _ = on_event.send(DownloadEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await?;
    tracing::info!(version = %update.version, bytes = bytes.len(), "update downloaded and verified");
    let mut slot = pending.0.lock().await;
    match slot.as_mut() {
        Some(p) if p.update.version == update.version => p.bytes = Some(bytes),
        _ => {
            return Err(UpdateError::new(
                ErrorKind::Other,
                "A newer update was found while this one downloaded; it will download next.",
            ))
        }
    }
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(())
}

/// Stop the daemon and install the downloaded update. On Windows the
/// installer takes over and this process exits (the installer starts Aura
/// again); elsewhere it returns and the webview relaunches the app. When the
/// install fails, the daemon is started again before the error is returned.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: tauri::State<'_, Pending>,
) -> Result<(), UpdateError> {
    if let Support::Manual { reason } = support(&app) {
        return Err(UpdateError::new(ErrorKind::Permission, reason));
    }
    let slot = pending.0.lock().await;
    let Some(PendingUpdate {
        update,
        bytes: Some(bytes),
    }) = slot.as_ref()
    else {
        return Err(UpdateError::new(
            ErrorKind::Other,
            "The update has not been downloaded yet.",
        ));
    };
    // Verify before stopping anything: a bad package must not cost the
    // sessions a restart. `install` verifies again.
    update.verify(bytes)?;

    let guard = crate::DAEMON_LOCK.lock().await;
    INSTALLING.store(true, Ordering::SeqCst);
    if let Err(e) = crate::stop_daemon_for_update().await {
        INSTALLING.store(false, Ordering::SeqCst);
        drop(guard);
        // It may have stopped part way; make sure one runs again.
        let _ = crate::ensure_daemon().await;
        return Err(UpdateError::new(ErrorKind::Daemon, format!("{e:#}")));
    }
    tracing::info!(version = %update.version, "daemon stopped, installing the update");
    // Unpacking and moving the app takes a moment; keep it off the async
    // workers. Windows: launches the installer and exits the process.
    let (update, bytes) = (update.clone(), bytes.clone());
    let result = tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| UpdateError::new(ErrorKind::Other, format!("the install stopped: {e}")))
        .and_then(|r| r.map_err(UpdateError::from));
    if let Err(e) = result {
        tracing::error!("installing the update failed: {}", e.message);
        INSTALLING.store(false, Ordering::SeqCst);
        drop(guard);
        if let Err(e) = crate::ensure_daemon().await {
            tracing::error!("restarting the daemon after a failed update: {e:#}");
        }
        return Err(e);
    }
    // Hold `INSTALLING` until the relaunch: the old daemon must not come back.
    drop(guard);
    Ok(())
}

/// Register the managed state the commands use.
pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    app.manage(Pending::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac(app: bool) -> Facts {
        Facts {
            os: Os::Mac,
            bundle: Some(Bundle::App),
            app_bundle: app.then(|| PathBuf::from("/Applications/Aura.app")),
            ..Default::default()
        }
    }

    #[test]
    fn macos_updates_an_app_bundle_in_place() {
        assert_eq!(decide(&mac(true)), Support::InPlace);
    }

    #[test]
    fn macos_without_a_bundle_translocated_or_read_only_is_manual() {
        assert!(matches!(decide(&mac(false)), Support::Manual { .. }));
        let translocated = Facts {
            translocated: true,
            ..mac(true)
        };
        assert!(
            matches!(decide(&translocated), Support::Manual { reason } if reason.contains("Applications"))
        );
        let dmg = Facts {
            read_only: true,
            ..mac(true)
        };
        assert!(matches!(decide(&dmg), Support::Manual { reason } if reason.contains("read-only")));
    }

    #[test]
    fn windows_updates_installer_installs_only() {
        let win = |bundle| Facts {
            os: Os::Windows,
            bundle,
            ..Default::default()
        };
        assert_eq!(decide(&win(Some(Bundle::Nsis))), Support::InPlace);
        assert_eq!(decide(&win(Some(Bundle::Msi))), Support::InPlace);
        assert!(matches!(decide(&win(None)), Support::Manual { .. }));
    }

    #[test]
    fn linux_appimage_needs_a_writable_location() {
        let image = |writable, read_only| Facts {
            os: Os::Linux,
            bundle: Some(Bundle::AppImage),
            writable,
            read_only,
            ..Default::default()
        };
        assert_eq!(decide(&image(true, false)), Support::InPlace);
        assert!(
            matches!(decide(&image(false, false)), Support::Manual { reason } if reason.contains("cannot write"))
        );
        assert!(
            matches!(decide(&image(true, true)), Support::Manual { reason } if reason.contains("read-only"))
        );
    }

    #[test]
    fn linux_packages_need_a_graphical_password_prompt() {
        for bundle in [Bundle::Deb, Bundle::Rpm] {
            let pkg = |graphical_sudo| Facts {
                os: Os::Linux,
                bundle: Some(bundle),
                graphical_sudo,
                ..Default::default()
            };
            assert_eq!(decide(&pkg(true)), Support::InPlace);
            assert!(
                matches!(decide(&pkg(false)), Support::Manual { reason } if reason.contains("pkexec"))
            );
        }
        let unknown = Facts {
            os: Os::Linux,
            graphical_sudo: true,
            ..Default::default()
        };
        assert!(matches!(decide(&unknown), Support::Manual { .. }));
    }

    #[test]
    fn finds_the_app_bundle_of_its_binary() {
        assert_eq!(
            app_bundle_of(Path::new("/tmp/x/Aura.app/Contents/MacOS/aura-desktop")),
            Some(PathBuf::from("/tmp/x/Aura.app"))
        );
        assert_eq!(
            app_bundle_of(Path::new("/repo/target/release/aura-desktop")),
            None
        );
        assert_eq!(
            app_bundle_of(Path::new("/x/Contents/MacOS/aura-desktop")),
            None
        );
    }

    #[test]
    fn classifies_updater_errors() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(
            UpdateError::from(E::Network("timed out".into())).kind,
            ErrorKind::Network
        );
        assert_eq!(
            UpdateError::from(E::ReleaseNotFound).kind,
            ErrorKind::Network
        );
        assert_eq!(
            UpdateError::from(E::MissingSignedVersion).kind,
            ErrorKind::Signature
        );
        assert_eq!(
            UpdateError::from(E::SignatureUtf8("x".into())).kind,
            ErrorKind::Signature
        );
        assert_eq!(
            UpdateError::from(E::AuthenticationFailed).kind,
            ErrorKind::Permission
        );
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(UpdateError::from(E::Io(denied)).kind, ErrorKind::Permission);
        assert_eq!(UpdateError::from(E::TempDirNotFound).kind, ErrorKind::Other);
    }

    #[test]
    fn serializes_for_the_webview() {
        let v = serde_json::to_value(Support::Manual { reason: "r".into() }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "manual", "reason": "r"}));
        let v = serde_json::to_value(DownloadEvent::Progress {
            downloaded: 1,
            total: Some(2),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"event": "progress", "downloaded": 1, "total": 2})
        );
        let v = serde_json::to_value(UpdateError::new(ErrorKind::Signature, "bad")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "signature", "message": "bad"})
        );
    }
}
