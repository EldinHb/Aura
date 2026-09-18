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

async fn ensure_daemon() -> Result<Connection> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    if let Some(info) = aura_rpc::read_daemon_info(&dir) {
        if daemon_alive(info.port).await {
            return Ok(Connection {
                port: info.port,
                token: info.token,
                data_dir: info.data_dir,
                daemon_pid: info.pid,
                version: info.version,
            });
        }
    }
    spawn_daemon(&dir)?;
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Some(info) = aura_rpc::read_daemon_info(&dir) {
            if daemon_alive(info.port).await {
                return Ok(Connection {
                    port: info.port,
                    token: info.token,
                    data_dir: info.data_dir,
                    daemon_pid: info.pid,
                    version: info.version,
                });
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
    let dir = data_dir();
    if let Some(info) = aura_rpc::read_daemon_info(&dir) {
        if let Ok(c) = aura_rpc::client::RpcClient::connect(info.port, &info.token).await {
            let _ = c.call("daemon.shutdown", serde_json::json!({})).await;
            for _ in 0..50 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if !daemon_alive(info.port).await {
                    break;
                }
            }
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
