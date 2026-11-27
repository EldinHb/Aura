//! Aura desktop shell. Thin: ensures the daemon runs, hands the webview a
//! connection token, and owns native concerns (windows, tray, hotkey,
//! notifications, badge). All session logic lives in `aurad`.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub mod log_file;
mod update;
pub mod update_helper;

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub port: u16,
    pub token: String,
    pub data_dir: String,
    pub daemon_pid: u32,
    pub version: String,
    /// The window secret of a daemon this app process spawned, which the
    /// webview presents (`daemon.window_hello`) to be allowed to grant
    /// approvals. None for a daemon this process did not spawn (one the CLI
    /// started, or one an earlier run of the app left running): no window can
    /// approve there until the app restarts it (`restart_daemon`).
    pub window_secret: Option<String>,
}

/// The daemon this process spawned and the window secret it was handed on
/// stdin. Memory only: the secret is never in argv, the environment or a file.
static SPAWNED: std::sync::Mutex<Option<(u32, String)>> = std::sync::Mutex::new(None);

fn data_dir() -> PathBuf {
    aura_rpc::default_data_dir()
}

/// Locate `aurad`: bundled sidecar next to the app binary, then the cargo
/// target dir (dev), then PATH.
fn find_daemon_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "aurad.exe" } else { "aurad" };
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(name);
        if sibling.exists() {
            return Some(sibling);
        }
        // macOS bundle: Contents/MacOS/aurad next to the app binary is the sibling above;
        // dev: target/debug/aurad from target/debug/aura-desktop
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join(name), dir.join("..").join(name)] {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Ok(p) = std::env::var("AURA_DAEMON_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    which(name)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join(name))
        .find(|p| p.exists())
}

async fn daemon_alive(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok(Ok(mut s)) = tokio::time::timeout(
        std::time::Duration::from_millis(700),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    else {
        return false;
    };
    if s.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .is_err()
    {
        return false;
    }
    let mut buf = vec![0u8; 256];
    match tokio::time::timeout(std::time::Duration::from_millis(700), s.read(&mut buf)).await {
        Ok(Ok(n)) => String::from_utf8_lossy(&buf[..n]).contains("200"),
        _ => false,
    }
}

/// Whether the daemon answers within `tries` health checks a second apart,
/// so a busy one is not taken for a dead one.
async fn answers_within(port: u16, tries: u32) -> bool {
    for _ in 0..tries {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if daemon_alive(port).await {
            return true;
        }
    }
    false
}

fn spawn_daemon(dir: &Path) -> Result<()> {
    let bin = find_daemon_binary().ok_or_else(|| anyhow!("aurad binary not found"))?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--data-dir").arg(dir).arg("--window-secret-stdin");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                extern "C" {
                    fn setsid() -> i32;
                }
                setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP. Not DETACHED_PROCESS: a
        // daemon with no console makes Windows open a new console window for
        // every console program it starts (git, gh, claude). With a hidden
        // console that children inherit, none of them show a window.
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", bin.display()))?;
    let secret = aura_rpc::server::random_secret();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().context("aurad's stdin")?;
        stdin.write_all(format!("{secret}\n").as_bytes())?;
        // Dropped here: aurad sees the end of its stdin.
    }
    *SPAWNED.lock().unwrap() = Some((child.id(), secret));
    Ok(())
}

/// The app's version. `aurad` reports its own from the same workspace version,
/// so the daemon bundled with this app reports exactly this.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Connecting and restarting run one at a time: windows opening together would
/// otherwise each replace the daemon, the second stopping the first's new one.
static DAEMON_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn connection(info: aura_rpc::DaemonInfo) -> Connection {
    let window_secret = SPAWNED
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(pid, _)| *pid == info.pid)
        .map(|(_, s)| s.clone());
    Connection {
        port: info.port,
        token: info.token,
        data_dir: info.data_dir,
        daemon_pid: info.pid,
        version: info.version,
        window_secret,
    }
}

/// Whether a running daemon of `version` should give way to the bundled one.
/// An update leaves the previous daemon running, and its replies lack what the
/// new UI reads. Dev builds keep it: their version may differ from an installed
/// app's daemon, and replacing that would stop the installed app's sessions.
fn replace_daemon(version: &str) -> bool {
    version != VERSION && !cfg!(debug_assertions) && find_daemon_binary().is_some()
}

/// Ask the daemon to shut down and wait until it is gone: its port closed and
/// its lock on the data dir released, after it has stopped its sessions. A new
/// daemon spawned before then finds the lock taken and exits. Sessions keep
/// their state and resume on the next daemon. An error when it does not
/// answer and cannot be confirmed to be the daemon: the user must quit it.
async fn stop_daemon(dir: &Path, info: &aura_rpc::DaemonInfo) -> Result<()> {
    if let Err(e) = aura_rpc::request_shutdown(info, aura_rpc::SHUTDOWN_ANSWER_TIMEOUT).await {
        // One that cannot take a connection or answer (out of open files,
        // say) still holds the data directory.
        tracing::warn!(
            pid = info.pid,
            "daemon did not take the shutdown request: {e:#}"
        );
        return stop_unresponsive(dir, info).await;
    }
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !daemon_alive(info.port).await && aura_rpc::data_dir_free(dir) {
            return Ok(());
        }
    }
    tracing::warn!(pid = info.pid, "daemon did not stop within 15s");
    Ok(())
}

/// Stop a daemon that holds `dir` but does not answer; an error naming its
/// pid when it cannot be confirmed to be the daemon, so nothing was signalled.
async fn stop_unresponsive(dir: &Path, info: &aura_rpc::DaemonInfo) -> Result<()> {
    match aura_rpc::stop_unresponsive_daemon(dir, info).await {
        aura_rpc::UnresponsiveStop::Unidentified => {
            Err(anyhow!(aura_rpc::unidentified_message(info.pid)))
        }
        aura_rpc::UnresponsiveStop::Freed | aura_rpc::UnresponsiveStop::StillHeld => Ok(()),
    }
}

async fn ensure_daemon() -> Result<Connection> {
    let _guard = DAEMON_LOCK.lock().await;
    // The daemon was stopped so its binary can be replaced; the relaunched
    // app starts the new one.
    if update::installing() {
        return Err(anyhow!(
            "Aura is installing an update and restarts in a moment"
        ));
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    // Another process installs an update (Aura reopened while the Windows
    // installer runs, say): aurad would refuse to start until it has finished.
    if aura_rpc::update_lock::install_in_progress(&dir).is_some() {
        tracing::info!("an update is being installed; waiting for it before starting the daemon");
        // The helper stops an installer after its limit; past that (a tree
        // Windows has not let it stop yet) aurad still refuses, and says why.
        let waited = aura_rpc::update_lock::wait_for_install(
            &dir,
            std::time::Duration::from_millis(500),
            update_helper::LIMITS.install + std::time::Duration::from_secs(5 * 60),
        )
        .await;
        if !waited {
            return Err(anyhow!(
                "an update is still being installed; open Aura again once it has finished"
            ));
        }
    }
    if let Some(info) = aura_rpc::read_daemon_info(&dir) {
        // A daemon holds the data directory (dropping the lock at once releases it).
        let held = !aura_rpc::data_dir_free(&dir);
        if daemon_alive(info.port).await || (held && answers_within(info.port, 5).await) {
            if !replace_daemon(&info.version) {
                return Ok(connection(info));
            }
            tracing::info!(daemon = %info.version, app = VERSION, "replacing a daemon of another version");
            stop_daemon(&dir, &info).await?;
        } else if held {
            // Alive yet unable to answer (out of open files, say), it would keep
            // the next one from starting.
            stop_unresponsive(&dir, &info).await?;
        }
    }
    spawn_and_connect(&dir).await
}

/// Stop the daemon so an update can replace its binary, and confirm it is
/// gone: unlike a restart, a daemon still running here makes the installer
/// fail (Windows locks a running `.exe`) or leaves the old daemon serving the
/// new app. The caller holds `DAEMON_LOCK`.
async fn stop_daemon_for_update() -> Result<()> {
    let dir = data_dir();
    if let Some(info) = aura_rpc::read_daemon_info(&dir) {
        let held = !aura_rpc::data_dir_free(&dir);
        if held || daemon_alive(info.port).await {
            stop_daemon(&dir, &info).await?;
        }
    }
    if !aura_rpc::data_dir_free(&dir) {
        return Err(anyhow!(
            "The Aura daemon did not stop, so the update was not installed. Stop it with `aura daemon stop` and try again."
        ));
    }
    #[cfg(windows)]
    wait_until_replaceable().await?;
    Ok(())
}

/// Windows refuses to overwrite a running `.exe`: wait until `aurad.exe` and
/// `aura.exe` beside the app have exited (the daemon's process lingers a
/// moment after it releases the data dir; an `aura` command may run in a
/// terminal). Built everywhere so it is type-checked on every host.
#[cfg_attr(not(windows), allow(dead_code))]
async fn wait_until_replaceable() -> Result<()> {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    else {
        return Ok(());
    };
    let locked = || {
        ["aurad.exe", "aura.exe"]
            .into_iter()
            .filter(|name| {
                // Opening for writing changes nothing, but fails while the image runs.
                matches!(
                    std::fs::OpenOptions::new().write(true).open(dir.join(name)),
                    Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION)
                )
            })
            .collect::<Vec<_>>()
    };
    for _ in 0..50 {
        if locked().is_empty() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let still = locked();
    if still.is_empty() {
        return Ok(());
    }
    Err(anyhow!(
        "{} is still running, so the installer could not replace it. Close any `aura` command in a terminal and try again.",
        still.join(" and ")
    ))
}

async fn spawn_and_connect(dir: &Path) -> Result<Connection> {
    spawn_daemon(dir)?;
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Some(info) = aura_rpc::read_daemon_info(dir) {
            if daemon_alive(info.port).await {
                return Ok(connection(info));
            }
        }
    }
    Err(anyhow!("daemon did not start within 15s"))
}

/// The daemon the windows were last told about.
static ANNOUNCED: std::sync::Mutex<Option<(u16, String)>> = std::sync::Mutex::new(None);

/// Whether `conn` is another daemon than the one last announced (and remember it).
fn daemon_changed(last: &mut Option<(u16, String)>, conn: &Connection) -> bool {
    let now = (conn.port, conn.token.clone());
    let changed = last.as_ref().is_some_and(|l| *l != now);
    *last = Some(now);
    changed
}

/// Tell every window when the daemon changed (a restart, a recovery after a
/// failed update, one window starting a new daemon after the old one died):
/// each holds a client for the old port and token, and would otherwise stay
/// disconnected.
fn announce<R: tauri::Runtime>(app: &tauri::AppHandle<R>, conn: &Connection) {
    let changed = daemon_changed(
        &mut ANNOUNCED.lock().unwrap_or_else(|e| e.into_inner()),
        conn,
    );
    if changed {
        tracing::info!(port = conn.port, "the daemon changed; telling every window");
        let _ = app.emit("aura://daemon-changed", conn);
    }
}

#[tauri::command]
async fn connect_daemon(app: AppHandle) -> Result<Connection, String> {
    let conn = ensure_daemon().await.map_err(|e| format!("{e:#}"))?;
    announce(&app, &conn);
    Ok(conn)
}

#[tauri::command]
async fn restart_daemon(app: AppHandle) -> Result<Connection, String> {
    {
        let _guard = DAEMON_LOCK.lock().await;
        let dir = data_dir();
        if let Some(info) = aura_rpc::read_daemon_info(&dir) {
            stop_daemon(&dir, &info)
                .await
                .map_err(|e| format!("{e:#}"))?;
        }
    }
    let conn = ensure_daemon().await.map_err(|e| format!("{e:#}"))?;
    announce(&app, &conn);
    Ok(conn)
}

/// Log to stderr (a terminal, in development) and to the rotating log file in
/// the data directory (see `log_file`), which is what is kept: an app opened
/// from Finder or the Start menu has nowhere for stderr to go.
fn init_logging() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let file = match log_file::open(&data_dir()) {
        Ok(file) => Some(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file)),
        ),
        Err(e) => {
            eprintln!("Aura: cannot write its log file: {e}");
            None
        }
    };
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(file)
        .init();
    log_file::log_panics();
    tracing::info!(version = VERSION, "Aura started");
}

/// A line from the webview into the app's log: its console is kept nowhere.
/// Render errors, uncaught errors and the updater's own lines come here.
#[tauri::command]
fn webview_log(level: String, message: String) {
    let message: String = message.chars().take(8_000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "webview", "{message}"),
        "warn" => tracing::warn!(target: "webview", "{message}"),
        _ => tracing::info!(target: "webview", "{message}"),
    }
}

#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    #[cfg(target_os = "macos")]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_badge_count(if count == 0 { None } else { Some(count as i64) });
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, count);
    }
}

#[tauri::command]
fn open_session_window(app: AppHandle, session_id: String) -> Result<(), String> {
    let label = format!("session-{}", session_id.replace('-', ""));
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?session={session_id}&window=session").into()),
    )
    .title("Aura")
    .inner_size(1000.0, 700.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Notifications waiting for a click, each on its own thread. Past the limit, a
/// notification is only shown: clicking it brings Aura forward and opens nothing.
static WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const MAX_WAITING: usize = 24;

/// Show a notification whose click shows the main window and emits
/// `aura://notification-clicked` with `target`. The notification plugin cannot:
/// on desktop it shows the notification and drops the handle that reports clicks.
#[tauri::command]
fn notify_with_target(
    app: AppHandle,
    title: String,
    body: String,
    target: serde_json::Value,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let mut n = notify_rust::Notification::new();
    n.summary(&title).body(&body);
    let identifier = app.config().identifier.clone();
    #[cfg(target_os = "macos")]
    {
        // An app run outside its bundle cannot post as itself (as the plugin does).
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });
    }
    #[cfg(windows)]
    {
        if !tauri::is_dev() {
            n.app_id(&identifier);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // The freedesktop server reports a click on the body as the "default" action.
        n.appname("Aura").action("default", "Open");
    }
    let _ = identifier;
    if WAITING.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
        WAITING.fetch_sub(1, Ordering::SeqCst);
        return n.show().map(drop).map_err(|e| e.to_string());
    }
    std::thread::Builder::new()
        .name("notification".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            // Blocks until the notification is clicked, dismissed or cleared.
            let shown = n.show().map_err(|e| e.to_string()).and_then(|handle| {
                handle
                    .wait_for_response(|response: &notify_rust::NotificationResponse| {
                        if matches!(
                            response,
                            notify_rust::NotificationResponse::Default
                                | notify_rust::NotificationResponse::Action(_)
                        ) {
                            focus_main(&app);
                            let _ = app.emit("aura://notification-clicked", target);
                        }
                    })
                    .map_err(|e| e.to_string())
            });
            if let Err(e) = shown {
                tracing::warn!("notification failed: {e}");
            }
            WAITING.fetch_sub(1, Ordering::SeqCst);
        })
        .map(drop)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    focus_main(&app);
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    init_logging();
    // Launched from Finder the app gets a soft limit of 256 open files, and
    // the aurad it starts inherits it; raise it first (aurad raises its own too).
    aura_core::process::raise_open_file_limit();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        focus_main(app);
                        let _ = app.emit("aura://summon", ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            connect_daemon,
            restart_daemon,
            set_badge,
            open_session_window,
            show_main,
            notify_with_target,
            update::update_config,
            update::update_last_result,
            webview_log,
            update::update_check,
            update::update_download,
            update::update_install
        ])
        .setup(|app| {
            update::manage(app);
            // Tray. Built here rather than via the `trayIcon` config block: Tauri
            // creates one tray per source and keeps them in a list, so declaring it
            // in both places put two identical icons in the menu bar.
            let show = MenuItem::with_id(app, "show", "Show Aura", true, None::<&str>)?;
            let updates = MenuItem::with_id(
                app,
                "check-updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit Aura (daemon keeps running)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &updates, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .icon_as_template(true)
                .tooltip("Aura")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => focus_main(app),
                    // The main window runs the check and shows the result.
                    "check-updates" => {
                        focus_main(app);
                        let _ = app.emit_to("main", "aura://check-updates", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        focus_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global summon hotkey (configurable later from the UI via re-register).
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let shortcut = if cfg!(target_os = "macos") {
                "Cmd+Shift+A"
            } else {
                "Ctrl+Shift+A"
            };
            if let Err(e) = app.global_shortcut().register(shortcut) {
                tracing::warn!("global shortcut not registered: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it (daemon and sessions keep running).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Aura")
        .run(|app, event| {
            // The main window hides when closed; reopening the app (its Dock icon, a
            // notification) shows it again.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                focus_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An app update replaces the daemon the previous version left running.
    /// Run by hand, in release mode with the release `aurad` built:
    /// `AURA_TEST_OLD_DAEMON=<aurad of another version> cargo test --release -p aura-desktop -- --ignored`
    fn conn(port: u16, token: &str) -> Connection {
        Connection {
            port,
            token: token.into(),
            data_dir: String::new(),
            daemon_pid: 1,
            version: VERSION.into(),
            window_secret: None,
        }
    }

    #[test]
    fn announces_only_another_daemon() {
        let mut last = None;
        // The first connection is no change: every window connects by itself.
        assert!(!daemon_changed(&mut last, &conn(1000, "a")));
        assert!(!daemon_changed(&mut last, &conn(1000, "a")));
        // A restart: new port and token.
        assert!(daemon_changed(&mut last, &conn(2000, "b")));
        assert!(!daemon_changed(&mut last, &conn(2000, "b")));
        // Same port reused, new token.
        assert!(daemon_changed(&mut last, &conn(2000, "c")));
    }

    #[tokio::test]
    #[ignore]
    async fn replaces_a_daemon_of_another_version() {
        let old = std::env::var("AURA_TEST_OLD_DAEMON").expect("AURA_TEST_OLD_DAEMON");
        let dir = std::env::temp_dir().join(format!("aura-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("AURA_DATA_DIR", &dir);
        let mut old = std::process::Command::new(old)
            .arg("--data-dir")
            .arg(&dir)
            .arg("--providers")
            .arg("terminal")
            .spawn()
            .unwrap();
        let mut info = None;
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            info = aura_rpc::read_daemon_info(&dir).filter(|i| i.version != VERSION);
            if info.is_some() {
                break;
            }
        }
        let info = info.expect("old daemon started");
        let c = aura_rpc::client::RpcClient::connect(info.port, &info.token)
            .await
            .unwrap();
        let session = c
            .call("session.create", serde_json::json!({"provider": "terminal", "cwd": dir, "command": ["sleep", "600"]}))
            .await
            .unwrap();

        let conn = ensure_daemon().await.unwrap();
        assert_eq!(conn.version, VERSION);
        assert_ne!(conn.daemon_pid, info.pid);
        assert!(old.try_wait().unwrap().is_some(), "old daemon exited");
        let c = aura_rpc::client::RpcClient::connect(conn.port, &conn.token)
            .await
            .unwrap();
        let after = c
            .call("session.get", serde_json::json!({"id": session["id"]}))
            .await
            .unwrap();
        assert_eq!(after["status"], "exited", "{after}");
        let _ = c.call("daemon.shutdown", serde_json::json!({})).await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The daemon this process spawns gets a window secret on stdin, never in
    /// argv; the webview's connection that presents it is the window, and a
    /// daemon this process did not spawn hands out none.
    #[tokio::test]
    async fn a_spawned_daemon_gets_its_window_secret_on_stdin_only() {
        let dir = tempfile::tempdir().unwrap();
        spawn_daemon(dir.path()).unwrap();
        let (pid, secret) = SPAWNED.lock().unwrap().clone().unwrap();
        let mut info = None;
        for _ in 0..150 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            info = aura_rpc::read_daemon_info(dir.path()).filter(|i| i.pid == pid);
            if info.is_some() {
                break;
            }
        }
        let info = info.expect("daemon started");
        let conn = connection(info.clone());
        assert_eq!(conn.window_secret.as_deref(), Some(secret.as_str()));
        #[cfg(unix)]
        {
            let ps = std::process::Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            let argv = String::from_utf8_lossy(&ps.stdout);
            assert!(
                argv.contains("--window-secret-stdin") && !argv.contains(&secret),
                "{argv}"
            );
        }
        assert!(
            !std::fs::read_to_string(aura_rpc::daemon_info_path(dir.path()))
                .unwrap()
                .contains(&secret)
        );
        let c = aura_rpc::client::RpcClient::connect(info.port, &info.token)
            .await
            .unwrap();
        c.call("daemon.window_hello", serde_json::json!({"secret": secret}))
            .await
            .unwrap();
        // Another daemon (not spawned here) gets no secret from this process.
        let mut other = info.clone();
        other.pid += 1;
        assert_eq!(connection(other).window_secret, None);
        let _ = c.call("daemon.shutdown", serde_json::json!({})).await;
    }
}
