//! Aura desktop shell. Thin: ensures the daemon runs, hands the webview a
//! connection token, and owns native concerns (windows, tray, hotkey,
//! notifications, badge). All session logic lives in `aurad`.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub port: u16,
    pub token: String,
    pub data_dir: String,
    pub daemon_pid: u32,
    pub version: String,
}

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
    std::env::split_paths(&path).map(|p| p.join(name)).find(|p| p.exists())
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
    if s.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.is_err() {
        return false;
    }
    let mut buf = vec![0u8; 256];
    match tokio::time::timeout(std::time::Duration::from_millis(700), s.read(&mut buf)).await {
        Ok(Ok(n)) => String::from_utf8_lossy(&buf[..n]).contains("200"),
        _ => false,
    }
}

fn spawn_daemon(dir: &Path) -> Result<()> {
    let bin = find_daemon_binary().ok_or_else(|| anyhow!("aurad binary not found"))?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--data-dir").arg(dir);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
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
        cmd.creation_flags(0x00000008 | 0x00000200);
    }
    cmd.spawn().with_context(|| format!("spawn {}", bin.display()))?;
    Ok(())
}

/// The app's version. `aurad` reports its own from the same workspace version,
/// so the daemon bundled with this app reports exactly this.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Connecting and restarting run one at a time: windows opening together would
/// otherwise each replace the daemon, the second stopping the first's new one.
static DAEMON_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn connection(info: aura_rpc::DaemonInfo) -> Connection {
    Connection {
        port: info.port,
        token: info.token,
        data_dir: info.data_dir,
        daemon_pid: info.pid,
        version: info.version,
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
/// their state and resume on the next daemon.
async fn stop_daemon(dir: &Path, info: &aura_rpc::DaemonInfo) {
    let Ok(c) = aura_rpc::client::RpcClient::connect(info.port, &info.token).await else {
        return;
    };
    let _ = c.call("daemon.shutdown", serde_json::json!({})).await;
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !daemon_alive(info.port).await && matches!(aura_rpc::lock_data_dir(dir), Ok(Some(_))) {
            return;
        }
    }
    tracing::warn!(pid = info.pid, "daemon did not stop within 15s");
}

async fn ensure_daemon() -> Result<Connection> {
    let _guard = DAEMON_LOCK.lock().await;
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    if let Some(info) = aura_rpc::read_daemon_info(&dir) {
        if daemon_alive(info.port).await {
            if !replace_daemon(&info.version) {
                return Ok(connection(info));
            }
            tracing::info!(daemon = %info.version, app = VERSION, "replacing a daemon of another version");
            stop_daemon(&dir, &info).await;
        }
    }
    spawn_and_connect(&dir).await
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

#[tauri::command]
async fn connect_daemon() -> Result<Connection, String> {
    ensure_daemon().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn restart_daemon() -> Result<Connection, String> {
    {
        let _guard = DAEMON_LOCK.lock().await;
        let dir = data_dir();
        if let Some(info) = aura_rpc::read_daemon_info(&dir) {
            stop_daemon(&dir, &info).await;
        }
    }
    ensure_daemon().await.map_err(|e| format!("{e:#}"))
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
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?session={session_id}&window=session").into()))
        .title("Aura")
        .inner_size(1000.0, 700.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
        .invoke_handler(tauri::generate_handler![connect_daemon, restart_daemon, set_badge, open_session_window, show_main])
        .setup(|app| {
            // Tray. Built here rather than via the `trayIcon` config block: Tauri
            // creates one tray per source and keeps them in a list, so declaring it
            // in both places put two identical icons in the menu bar.
            let show = MenuItem::with_id(app, "show", "Show Aura", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Aura (daemon keeps running)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .icon_as_template(true)
                .tooltip("Aura")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        focus_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global summon hotkey (configurable later from the UI via re-register).
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let shortcut = if cfg!(target_os = "macos") { "Cmd+Shift+A" } else { "Ctrl+Shift+A" };
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
        .run(tauri::generate_context!())
        .expect("error while running Aura");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An app update replaces the daemon the previous version left running.
    /// Run by hand, in release mode with the release `aurad` built:
    /// `AURA_TEST_OLD_DAEMON=<aurad of another version> cargo test --release -p aura-desktop -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn replaces_a_daemon_of_another_version() {
        let old = std::env::var("AURA_TEST_OLD_DAEMON").expect("AURA_TEST_OLD_DAEMON");
        let dir = std::env::temp_dir().join(format!("aura-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("AURA_DATA_DIR", &dir);
        let mut old = std::process::Command::new(old).arg("--data-dir").arg(&dir).arg("--providers").arg("terminal").spawn().unwrap();
        let mut info = None;
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            info = aura_rpc::read_daemon_info(&dir).filter(|i| i.version != VERSION);
            if info.is_some() {
                break;
            }
        }
        let info = info.expect("old daemon started");
        let c = aura_rpc::client::RpcClient::connect(info.port, &info.token).await.unwrap();
        let session = c
            .call("session.create", serde_json::json!({"provider": "terminal", "cwd": dir, "command": ["sleep", "600"]}))
            .await
            .unwrap();

        let conn = ensure_daemon().await.unwrap();
        assert_eq!(conn.version, VERSION);
        assert_ne!(conn.daemon_pid, info.pid);
        assert!(old.try_wait().unwrap().is_some(), "old daemon exited");
        let c = aura_rpc::client::RpcClient::connect(conn.port, &conn.token).await.unwrap();
        let after = c.call("session.get", serde_json::json!({"id": session["id"]})).await.unwrap();
        assert_eq!(after["status"], "exited", "{after}");
        let _ = c.call("daemon.shutdown", serde_json::json!({})).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
