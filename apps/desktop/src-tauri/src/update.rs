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
//! the relaunched app's `ensure_daemon` starts the new one. From before the
//! daemon stops until the new binaries are in place, the update lock in the
//! data dir (`aura_rpc::update_lock`) keeps `aurad` and `aura` from starting,
//! from any process; on Windows the installer helper (`update_helper`) holds
//! it until the installer has finished.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, Runtime};
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
    /// The first automatic check is already due (the page was reloaded after
    /// it), so the page checks at once instead of waiting for the next tick.
    pub first_check_passed: bool,
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
    /// macOS: the path Aura was started by goes through a symbolic link (`/tmp`
    /// is one), which Tauri refuses to resolve the app by, for installing and
    /// for relaunching.
    pub symlinked: bool,
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
            if f.symlinked {
                return manual("Aura was opened through a symbolic link, so it cannot replace itself safely. Open Aura.app from its real location (for example Applications) to get updates automatically.");
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
    // Tauri's own: what the updater and the relaunch resolve the app by.
    let exe = tauri::utils::platform::current_exe().ok();
    let mut f = Facts {
        bundle: bundle(),
        ..Default::default()
    };
    #[cfg(target_os = "macos")]
    {
        f.os = Os::Mac;
        // Tauri rejects a path through a symlink; the path as started still shows the bundle.
        f.symlinked = exe.is_none();
        f.app_bundle = exe
            .or_else(|| std::env::current_exe().ok())
            .as_deref()
            .and_then(app_bundle_of);
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

/// The first automatic check, after the app starts, and how often after that.
pub const FIRST_CHECK: Duration = Duration::from_secs(10);
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Call `tick` after `first`, then every `every`.
pub async fn schedule(first: Duration, every: Duration, mut tick: impl FnMut()) {
    tokio::time::sleep(first).await;
    loop {
        tick();
        tokio::time::sleep(every).await;
    }
}

/// Tell the main window when to check, from here rather than from its own
/// timers: WebKit throttles or suspends the timers of a page it takes to be
/// hidden (Aura closed to the tray, or covered by other windows), and the
/// 6-hourly check then never came. Events reach the page as IPC, which runs.
/// The webview decides whether to check (the setting, development builds).
pub fn start_schedule<R: Runtime>(app: &AppHandle<R>) {
    STARTED.get_or_init(std::time::Instant::now);
    let app = app.clone();
    tauri::async_runtime::spawn(schedule(FIRST_CHECK, CHECK_EVERY, move || {
        let _ = app.emit_to("main", "aura://update-tick", ());
    }));
}

/// The identifier of the end-to-end test app (`scripts/test-update-macos.sh`).
pub const TEST_IDENTIFIER: &str = "nl.havick.aura.updatetest";

/// Whether the end-to-end test hooks (`AURA_UPDATER_ENDPOINT`,
/// `AURA_UPDATER_TEST_AUTO_RESTART`) apply. They are compiled in only with the
/// `updater-test` feature, which the release workflow never enables, and even
/// then honoured only by the test app's identifier: a build of Aura itself
/// that got the feature by mistake still ignores them.
fn test_hooks<R: Runtime>(app: &AppHandle<R>) -> bool {
    cfg!(feature = "updater-test") && app.config().identifier == TEST_IDENTIFIER
}

/// How long the network may take before an update counts as failed, so a
/// stalled request never leaves the app checking or downloading for good.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// The manifest request, from connecting to the last byte.
    pub check: Duration,
    /// The whole package download.
    pub download: Duration,
    /// The download with no bytes arriving.
    pub stall: Duration,
}

pub const TIMEOUTS: Timeouts = Timeouts {
    check: Duration::from_secs(30),
    download: Duration::from_secs(30 * 60),
    stall: Duration::from_secs(60),
};

fn updater<R: Runtime>(
    app: &AppHandle<R>,
    timeouts: Timeouts,
) -> Result<tauri_plugin_updater::Updater, UpdateError> {
    let mut builder = app.updater_builder().timeout(timeouts.check);
    if test_hooks(app) {
        if let Ok(raw) = std::env::var("AURA_UPDATER_ENDPOINT") {
            tracing::warn!("update test build: checking {raw}");
            let url = raw.parse::<url::Url>().map_err(|e| {
                UpdateError::new(ErrorKind::Other, format!("AURA_UPDATER_ENDPOINT: {e}"))
            })?;
            builder = builder.endpoints(vec![url])?;
        }
    }
    Ok(builder.build()?)
}

/// The manifest URLs: the configured ones, or the test endpoint.
fn endpoints<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    if test_hooks(app) {
        if let Ok(raw) = std::env::var("AURA_UPDATER_ENDPOINT") {
            return vec![raw];
        }
    }
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|u| u.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// A copy that cannot replace itself only needs to know there is a newer
/// version, to offer the release page: read the manifest's version without
/// the plugin. The plugin's `Updater::build` resolves the app through
/// Tauri's `current_exe` even when given a path, and that fails for a path
/// through a symbolic link (macOS), which is one of the reasons a copy
/// cannot replace itself.
async fn check_manifest_only(
    endpoints: &[String],
    current: &semver::Version,
    support: Support,
    timeouts: Timeouts,
) -> Result<Option<UpdateInfo>, UpdateError> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        version: String,
        notes: Option<String>,
        pub_date: Option<String>,
    }
    let network = |e: &dyn std::fmt::Display| {
        UpdateError::new(
            ErrorKind::Network,
            format!("Could not reach the update server: {e}"),
        )
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
        .timeout(timeouts.check)
        .build()
        .map_err(|e| network(&e))?;
    let mut last = None;
    for url in endpoints {
        let manifest = match client.get(url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(body) => serde_json::from_slice::<Manifest>(&body).map_err(|e| network(&e)),
                Err(e) => Err(network(&e)),
            },
            Ok(res) => Err(network(&format!("{url} answered {}", res.status()))),
            Err(e) => Err(network(&e)),
        };
        let manifest = match manifest {
            Ok(m) => m,
            Err(e) => {
                last = Some(e);
                continue;
            }
        };
        let version = semver::Version::parse(manifest.version.trim_start_matches('v'))
            .map_err(|e| network(&format!("the manifest's version: {e}")))?;
        if &version <= current {
            return Ok(None);
        }
        return Ok(Some(UpdateInfo {
            release_url: release_url(&version.to_string()),
            version: version.to_string(),
            current_version: current.to_string(),
            notes: manifest.notes.filter(|n| !n.trim().is_empty()),
            date: manifest.pub_date,
            support,
        }));
    }
    Err(last.unwrap_or_else(|| network(&"no update endpoint is configured")))
}

#[tauri::command]
pub fn update_config(app: AppHandle) -> UpdateConfig {
    UpdateConfig {
        current_version: app.package_info().version.to_string(),
        auto_check: !cfg!(debug_assertions),
        support: support(&app),
        releases_url: RELEASES_URL.into(),
        test_auto_restart: test_hooks(&app)
            && std::env::var_os("AURA_UPDATER_TEST_AUTO_RESTART").is_some(),
        first_check_passed: STARTED.get().is_some_and(|t| t.elapsed() >= FIRST_CHECK),
    }
}

/// How the last install that ran without the app (Windows: the installer
/// helper) ended, once. Also removes what earlier installs left in the temp folder.
#[tauri::command]
pub fn update_last_result() -> Option<aura_rpc::update_lock::InstallResult> {
    crate::update_helper::clean_up(&std::env::temp_dir());
    aura_rpc::update_lock::take_result(&crate::data_dir())
}

/// Ask the release manifest for a newer stable version. `None` when this is
/// the latest. A package already downloaded for the same version is kept.
async fn check<R: Runtime>(
    app: &AppHandle<R>,
    pending: &Pending,
    support: Support,
    timeouts: Timeouts,
) -> Result<Option<UpdateInfo>, UpdateError> {
    if matches!(support, Support::Manual { .. }) {
        // Nothing can be installed, so nothing is kept to install.
        *pending.0.lock().await = None;
        let current = app.package_info().version.clone();
        let found = check_manifest_only(&endpoints(app), &current, support, timeouts).await?;
        if let Some(info) = &found {
            tracing::info!(version = %info.version, in_place = false, "update available");
        }
        return Ok(found);
    }
    let found = updater(app, timeouts)?.check().await?;
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
        support: support.clone(),
    };
    let bytes = slot
        .take()
        .filter(|p| p.update.version == update.version)
        .and_then(|p| p.bytes);
    *slot = Some(PendingUpdate { update, bytes });
    tracing::info!(version = %info.version, in_place = matches!(support, Support::InPlace), "update available");
    Ok(Some(info))
}

/// Download the update found by the last check and verify its signature,
/// within `timeouts`: as a whole, and without bytes arriving.
async fn download(
    pending: &Pending,
    on_event: impl Fn(DownloadEvent) + Send + Sync,
    timeouts: Timeouts,
) -> Result<(), UpdateError> {
    let mut update = {
        let slot = pending.0.lock().await;
        let p = slot.as_ref().ok_or_else(|| {
            UpdateError::new(
                ErrorKind::Other,
                "No update to download; check for updates first.",
            )
        })?;
        if p.bytes.is_some() {
            on_event(DownloadEvent::Finished);
            return Ok(());
        }
        p.update.clone()
    };
    // The plugin's own client timeout, for the whole download.
    update.timeout = Some(timeouts.download);
    let start = std::time::Instant::now();
    let last_bytes = AtomicU64::new(0);
    let mut downloaded = 0u64;
    let mut last_sent = 0u64;
    // `download` verifies the signature before it returns the bytes.
    let fetch = update.download(
        |chunk, total| {
            last_bytes.store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
            downloaded += chunk as u64;
            // A message per chunk floods the webview; one per 256 KiB is plenty.
            if downloaded - last_sent >= 256 * 1024 || Some(downloaded) == total {
                last_sent = downloaded;
                on_event(DownloadEvent::Progress { downloaded, total });
            }
        },
        || {},
    );
    tokio::pin!(fetch);
    let mut tick = tokio::time::interval((timeouts.stall / 4).max(Duration::from_millis(10)));
    let bytes = loop {
        tokio::select! {
            result = &mut fetch => break result?,
            _ = tick.tick() => {
                let quiet = start.elapsed().as_millis() as u64 - last_bytes.load(Ordering::Relaxed);
                if quiet > timeouts.stall.as_millis() as u64 {
                    return Err(UpdateError::new(
                        ErrorKind::Network,
                        format!(
                            "The download of Aura {} stalled: nothing arrived for {} s.",
                            update.version,
                            timeouts.stall.as_secs_f32()
                        ),
                    ));
                }
            }
        }
    };
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
    on_event(DownloadEvent::Finished);
    Ok(())
}

/// Start the daemon again after an install that did not happen, and tell
/// every window where it now listens.
async fn recover<R: Runtime>(app: &AppHandle<R>) {
    match crate::ensure_daemon().await {
        Ok(conn) => crate::announce(app, &conn),
        Err(e) => tracing::error!("restarting the daemon after a failed update: {e:#}"),
    }
}

/// Stop the daemon and install the downloaded update. Windows: the installer
/// helper takes over and this process exits; the helper starts Aura again
/// however the installer ends. Elsewhere it returns and the webview
/// relaunches the app. When the install fails here, the daemon is started
/// again before the error is returned.
async fn install(app: AppHandle, pending: &Pending) -> Result<(), UpdateError> {
    if let Support::Manual { reason } = support(&app) {
        return Err(UpdateError::new(ErrorKind::Permission, reason));
    }
    let (update, bytes) = {
        let slot = pending.0.lock().await;
        match slot.as_ref() {
            Some(PendingUpdate {
                update,
                bytes: Some(bytes),
            }) => (update.clone(), bytes.clone()),
            _ => {
                return Err(UpdateError::new(
                    ErrorKind::Other,
                    "The update has not been downloaded yet.",
                ))
            }
        }
    };
    // Verify before stopping anything: a bad package must not cost the
    // sessions a restart. The install verifies again.
    update.verify(&bytes)?;
    let dir = crate::data_dir();
    if cfg!(windows) {
        install_with_helper(&app, &update, &bytes, &dir).await
    } else {
        install_in_place(&app, update, bytes, &dir).await
    }
}

/// macOS and Linux: replace the app from this process, holding the update
/// lock (so neither `aurad` nor `aura` starts) from stopping the daemon until
/// the new app is in place.
async fn install_in_place<R: Runtime>(
    app: &AppHandle<R>,
    update: Update,
    bytes: Vec<u8>,
    dir: &Path,
) -> Result<(), UpdateError> {
    let guard = crate::DAEMON_LOCK.lock().await;
    let lock = aura_rpc::update_lock::begin_install(dir, &update.version)
        .map_err(|e| UpdateError::new(ErrorKind::Other, format!("{e:#}")))?;
    INSTALLING.store(true, Ordering::SeqCst);
    if let Err(e) = crate::stop_daemon_for_update().await {
        INSTALLING.store(false, Ordering::SeqCst);
        lock.release();
        drop(guard);
        // It may have stopped part way; make sure one runs again.
        recover(app).await;
        return Err(UpdateError::new(ErrorKind::Daemon, format!("{e:#}")));
    }
    tracing::info!(version = %update.version, "daemon stopped, installing the update");
    // Unpacking and moving the app takes a moment; keep it off the async workers.
    let result = tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| UpdateError::new(ErrorKind::Other, format!("the install stopped: {e}")))
        .and_then(|r| r.map_err(UpdateError::from));
    // The new binaries are in place (or the old ones still are): `aura` may run again.
    lock.release();
    if let Err(e) = result {
        INSTALLING.store(false, Ordering::SeqCst);
        drop(guard);
        recover(app).await;
        return Err(e);
    }
    // `INSTALLING` stays set until the relaunch: this process must not start
    // a daemon again.
    drop(guard);
    Ok(())
}

/// Windows: hand the install to the helper (see `update_helper`), which takes
/// the update lock before the daemon stops and keeps it until the installer
/// has finished, then exit.
async fn install_with_helper<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
    bytes: &[u8],
    dir: &Path,
) -> Result<(), UpdateError> {
    use crate::update_helper::{self, InstallerKind};
    let other = |what: &str, e: &dyn std::fmt::Display| {
        UpdateError::new(ErrorKind::Other, format!("{what}: {e}"))
    };
    let kind = match bundle() {
        Some(Bundle::Nsis) => InstallerKind::Nsis,
        Some(Bundle::Msi) => InstallerKind::Msi,
        _ => {
            return Err(UpdateError::new(
                ErrorKind::Permission,
                "This copy of Aura was not installed with the Aura installer, so it cannot replace itself.",
            ))
        }
    };
    let exe = std::env::current_exe().map_err(|e| other("finding Aura's executable", &e))?;
    let (args, helper) = update_helper::prepare(
        &std::env::temp_dir(),
        dir,
        &update.version,
        kind,
        bytes,
        &exe,
    )
    .map_err(|e| other("preparing the installer", &e))?;
    let mut cmd = std::process::Command::new(&helper);
    cmd.args(args.to_args());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP: outlives the app, shows nothing.
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    let guard = crate::DAEMON_LOCK.lock().await;
    let handover =
        tokio::task::spawn_blocking(move || update_helper::start(cmd, Duration::from_secs(15)))
            .await
            .map_err(|e| other("starting the update helper", &e))?
            .map_err(|e| other("starting the update helper", &e))?;
    INSTALLING.store(true, Ordering::SeqCst);
    if let Err(e) = crate::stop_daemon_for_update().await {
        INSTALLING.store(false, Ordering::SeqCst);
        let _ = tokio::task::spawn_blocking(move || handover.abort()).await;
        drop(guard);
        recover(app).await;
        return Err(UpdateError::new(ErrorKind::Daemon, format!("{e:#}")));
    }
    tracing::info!(version = %update.version, "daemon stopped, handing the install to the helper");
    // The helper starts the installer once this process is gone.
    let _helper = handover.go(false);
    app.cleanup_before_exit();
    std::process::exit(0);
}

/// A line from the webview's side of the updater, into the app's log: its
/// console is kept nowhere, and automatic checks fail quietly.
#[tauri::command]
pub fn update_log(message: String, error: Option<String>) {
    match error {
        Some(error) => tracing::warn!("updates: {message}: {error}"),
        None => tracing::info!("updates: {message}"),
    }
}

/// Every failure is logged here: the webview shows only those the user asked for.
fn logged<T>(what: &str, result: Result<T, UpdateError>) -> Result<T, UpdateError> {
    if let Err(e) = &result {
        tracing::warn!(kind = ?e.kind, "update {what} failed: {}", e.message);
    }
    result
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: tauri::State<'_, Pending>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let support = support(&app);
    logged("check", check(&app, &pending, support, TIMEOUTS).await)
}

#[tauri::command]
pub async fn update_download(
    pending: tauri::State<'_, Pending>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), UpdateError> {
    let send = move |e: DownloadEvent| {
        let _ = on_event.send(e);
    };
    logged("download", download(&pending, send, TIMEOUTS).await)
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: tauri::State<'_, Pending>,
) -> Result<(), UpdateError> {
    logged("install", install(app, &pending).await)
}

/// Register the managed state the commands use, and start the check schedule.
pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    app.manage(Pending::default());
    start_schedule(app.handle());
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
        let linked = Facts {
            symlinked: true,
            ..mac(true)
        };
        assert!(
            matches!(decide(&linked), Support::Manual { reason } if reason.contains("symbolic link"))
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

    /// The updater plugin itself, on Tauri's mock runtime, against a local
    /// server: what the commands do, short of the webview.
    #[tokio::test(start_paused = true)]
    async fn ticks_after_ten_seconds_then_every_six_hours() {
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = ticks.clone();
        tokio::spawn(schedule(FIRST_CHECK, CHECK_EVERY, move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let count = || ticks.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert_eq!(count(), 0);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(count(), 1);
        tokio::time::sleep(CHECK_EVERY - Duration::from_secs(2)).await;
        assert_eq!(count(), 1);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(count(), 2);
    }

    mod plugin {
        use super::super::*;
        use std::collections::HashMap;
        use std::sync::Mutex;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        const PUBKEY: &str = include_str!("../../../../scripts/fixtures/updater/test.key.pub");
        const ARTIFACT: &[u8] = include_bytes!("../../../../scripts/fixtures/updater/artifact.bin");
        const SIGNATURE: &str =
            include_str!("../../../../scripts/fixtures/updater/artifact.bin.v9.9.9.sig");

        #[derive(Clone)]
        enum Reply {
            Body(Vec<u8>),
            /// Accept, never answer.
            Silent,
            /// Headers and the first bytes of a body, then nothing.
            Stall,
        }

        async fn bind() -> (tokio::net::TcpListener, u16) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            (listener, port)
        }

        fn serve(listener: tokio::net::TcpListener, routes: HashMap<&'static str, Reply>) {
            tokio::spawn(async move {
                while let Ok((mut sock, _)) = listener.accept().await {
                    let routes = routes.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let mut req = Vec::new();
                        while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                            match sock.read(&mut buf).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => req.extend_from_slice(&buf[..n]),
                            }
                        }
                        let req = String::from_utf8_lossy(&req).to_string();
                        let path = req.split_whitespace().nth(1).unwrap_or("");
                        match routes.get(path).cloned() {
                            Some(Reply::Body(body)) => {
                                let head = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = sock.write_all(head.as_bytes()).await;
                                let _ = sock.write_all(&body).await;
                            }
                            Some(Reply::Silent) => {
                                tokio::time::sleep(Duration::from_secs(3600)).await
                            }
                            Some(Reply::Stall) => {
                                let head = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                                    ARTIFACT.len()
                                );
                                let _ = sock.write_all(head.as_bytes()).await;
                                let _ = sock.write_all(&ARTIFACT[..4]).await;
                                tokio::time::sleep(Duration::from_secs(3600)).await;
                            }
                            None => {
                                let _ = sock
                                    .write_all(
                                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                                    )
                                    .await;
                            }
                        }
                    });
                }
            });
        }

        fn app(endpoint: String) -> tauri::App<tauri::test::MockRuntime> {
            let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
            ctx.config_mut().plugins.0.insert(
                "updater".into(),
                serde_json::json!({
                    "pubkey": PUBKEY.trim(),
                    "endpoints": [endpoint],
                    "dangerousInsecureTransportProtocol": true,
                    "requireSignedVersion": true,
                }),
            );
            tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(ctx)
                .unwrap()
        }

        const QUICK: Timeouts = Timeouts {
            check: Duration::from_millis(500),
            download: Duration::from_secs(10),
            stall: Duration::from_millis(300),
        };

        type Checked = (
            tauri::App<tauri::test::MockRuntime>,
            Pending,
            Result<Option<UpdateInfo>, UpdateError>,
        );

        /// Check a server announcing 9.9.9 (signed for 9.9.9) with `package` as its package.
        async fn checked(package: Reply, support: Support) -> Checked {
            let (listener, port) = bind().await;
            let manifest = serde_json::json!({
                "version": "9.9.9",
                "notes": "Fixes",
                "platforms": {
                    tauri_plugin_updater::target().unwrap(): {
                        "url": format!("http://127.0.0.1:{port}/pkg"),
                        "signature": SIGNATURE.trim(),
                    }
                }
            });
            let routes = HashMap::from([
                (
                    "/latest.json",
                    Reply::Body(manifest.to_string().into_bytes()),
                ),
                ("/pkg", package),
            ]);
            serve(listener, routes);
            let app = app(format!("http://127.0.0.1:{port}/latest.json"));
            let pending = Pending::default();
            let found = check(app.handle(), &pending, support, QUICK).await;
            (app, pending, found)
        }

        #[tokio::test]
        async fn checks_downloads_and_verifies_a_signed_update() {
            let (_app, pending, found) =
                checked(Reply::Body(ARTIFACT.to_vec()), Support::InPlace).await;
            let info = found.unwrap().expect("an update");
            assert_eq!(info.version, "9.9.9");
            assert_eq!(info.support, Support::InPlace);
            let events = Mutex::new(Vec::new());
            download(&pending, |e| events.lock().unwrap().push(e), QUICK)
                .await
                .unwrap();
            assert!(matches!(
                events.lock().unwrap().last(),
                Some(DownloadEvent::Finished)
            ));
            let slot = pending.0.lock().await;
            assert_eq!(slot.as_ref().unwrap().bytes.as_deref(), Some(ARTIFACT));
        }

        #[tokio::test]
        async fn a_copy_that_cannot_replace_itself_still_learns_of_the_update() {
            let manual = Support::Manual {
                reason: "opened through a symbolic link".into(),
            };
            let (_app, _pending, found) = checked(Reply::Body(ARTIFACT.to_vec()), manual).await;
            let info = found.unwrap().expect("an update to offer");
            assert_eq!(info.version, "9.9.9");
            assert!(matches!(info.support, Support::Manual { .. }));
        }

        #[tokio::test]
        async fn a_tampered_package_is_refused() {
            let mut bad = ARTIFACT.to_vec();
            bad[0] ^= 1;
            let (_app, pending, found) = checked(Reply::Body(bad), Support::InPlace).await;
            found.unwrap().unwrap();
            let err = download(&pending, |_| {}, QUICK).await.unwrap_err();
            assert_eq!(err.kind, ErrorKind::Signature, "{err:?}");
            assert!(pending.0.lock().await.as_ref().unwrap().bytes.is_none());
        }

        #[tokio::test]
        async fn a_stalled_download_fails() {
            let (_app, pending, found) = checked(Reply::Stall, Support::InPlace).await;
            found.unwrap().unwrap();
            let started = std::time::Instant::now();
            let err = download(&pending, |_| {}, QUICK).await.unwrap_err();
            assert_eq!(err.kind, ErrorKind::Network, "{err:?}");
            assert!(err.message.contains("stalled"), "{err:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[tokio::test]
        async fn a_copy_that_cannot_replace_itself_hears_of_nothing_older_and_times_out() {
            let manual = Support::Manual { reason: "r".into() };
            let (listener, port) = bind().await;
            let manifest = serde_json::json!({ "version": "0.0.1", "platforms": {} });
            serve(
                listener,
                HashMap::from([
                    ("/old.json", Reply::Body(manifest.to_string().into_bytes())),
                    ("/silent.json", Reply::Silent),
                ]),
            );
            let current = semver::Version::new(0, 1, 0);
            let old = format!("http://127.0.0.1:{port}/old.json");
            assert!(check_manifest_only(&[old], &current, manual.clone(), QUICK)
                .await
                .unwrap()
                .is_none());
            let started = std::time::Instant::now();
            let silent = format!("http://127.0.0.1:{port}/silent.json");
            let err = check_manifest_only(&[silent], &current, manual, QUICK)
                .await
                .unwrap_err();
            assert_eq!(err.kind, ErrorKind::Network, "{err:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[test]
        fn test_hooks_need_the_feature_and_the_test_app() {
            // Aura's own identifier never honours them, feature or not.
            let ours = app("https://example.com/latest.json".into());
            assert!(!test_hooks(ours.handle()));
            let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
            ctx.config_mut().identifier = TEST_IDENTIFIER.into();
            ctx.config_mut().plugins.0.insert(
                "updater".into(),
                serde_json::json!({ "pubkey": PUBKEY.trim(), "endpoints": ["https://example.com/latest.json"] }),
            );
            let test_app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(ctx)
                .unwrap();
            assert_eq!(
                test_hooks(test_app.handle()),
                cfg!(feature = "updater-test")
            );
        }

        #[tokio::test]
        async fn a_check_that_gets_no_answer_times_out() {
            let (listener, port) = bind().await;
            serve(listener, HashMap::from([("/latest.json", Reply::Silent)]));
            let app = app(format!("http://127.0.0.1:{port}/latest.json"));
            let started = std::time::Instant::now();
            let err = check(app.handle(), &Pending::default(), Support::InPlace, QUICK)
                .await
                .unwrap_err();
            assert_eq!(err.kind, ErrorKind::Network, "{err:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }
}
