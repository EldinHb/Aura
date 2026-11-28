//! Other Aura computers this app connects to (a home server, another Mac), as
//! the Android app does. The work is aura-remote-client's: pairing, the pinned
//! certificate, device tokens in the OS keychain, and a loopback bridge the
//! webview opens like its own daemon. This is the webview's side of it:
//! commands, and `aura://remotes-changed` with the full list whenever a
//! remote is added, renamed, removed or its connection state moves.
//!
//! See docs/design/remote.md, "Desktop client".

use aura_remote_client::{
    BridgeInfo, HubConfig, KeyringSecrets, PairRequest, RemoteHub, RemoteView,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::OnceCell;

/// The keychain service the device tokens are kept under (account: the
/// remote's server id).
const KEYCHAIN_SERVICE: &str = "nl.havick.aura.remote";

/// Started on first use, so an app that never pairs never touches the keychain
/// or opens the bridge.
#[derive(Default)]
pub struct Remotes(OnceCell<RemoteHub>);

pub fn manage(app: &tauri::App) {
    app.manage(Remotes::default());
}

async fn hub(app: &AppHandle, state: &Remotes) -> Result<RemoteHub, String> {
    state
        .0
        .get_or_try_init(|| async {
            let hub = RemoteHub::start(HubConfig {
                registry_path: crate::data_dir().join("desktop").join("remotes.json"),
                secrets: Arc::new(KeyringSecrets::new(KEYCHAIN_SERVICE)),
                device_name: aura_rpc::remote::host_name(),
            })
            .await
            .map_err(|e| format!("{e:#}"))?;
            // Every change goes to every window, coalesced.
            let mut changes = hub.subscribe();
            let watched = hub.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                while changes.changed().await.is_ok() {
                    let _ = app.emit("aura://remotes-changed", watched.list());
                }
            });
            Ok::<_, String>(hub)
        })
        .await
        .cloned()
}

/// The paired computers and their connection state.
#[tauri::command]
pub async fn remotes_list(
    app: AppHandle,
    state: State<'_, Remotes>,
) -> Result<Vec<RemoteView>, String> {
    Ok(hub(&app, &state).await?.list())
}

/// This computer's name as remotes see it when it pairs (its host name).
#[tauri::command]
pub fn remote_device_name() -> String {
    aura_rpc::remote::host_name()
}

/// Pair with a computer from its pairing link's parts. The error says what
/// to fix (a wrong code, a fingerprint that does not match, unreachable).
#[tauri::command]
pub async fn remote_pair(
    app: AppHandle,
    state: State<'_, Remotes>,
    request: PairRequest,
) -> Result<RemoteView, String> {
    hub(&app, &state).await?.pair(request).await
}

#[tauri::command]
pub async fn remote_rename(
    app: AppHandle,
    state: State<'_, Remotes>,
    id: String,
    name: String,
) -> Result<RemoteView, String> {
    hub(&app, &state)
        .await?
        .rename(&id, &name)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn remote_remove(
    app: AppHandle,
    state: State<'_, Remotes>,
    id: String,
) -> Result<(), String> {
    hub(&app, &state)
        .await?
        .remove(&id)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Where the webview connects for remote `id`: `ws://127.0.0.1:<port>/ws?token=<token>`.
#[tauri::command]
pub async fn remote_bridge(
    app: AppHandle,
    state: State<'_, Remotes>,
    id: String,
) -> Result<BridgeInfo, String> {
    hub(&app, &state)
        .await?
        .bridge(&id)
        .map_err(|e| format!("{e:#}"))
}

/// Try remote `id` again at the next connection instead of waiting out the backoff.
#[tauri::command]
pub async fn remote_retry(
    app: AppHandle,
    state: State<'_, Remotes>,
    id: String,
) -> Result<(), String> {
    hub(&app, &state).await?.retry(&id);
    Ok(())
}
