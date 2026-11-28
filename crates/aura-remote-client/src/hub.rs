//! The remote computers this desktop paired with, and the bridge the webview
//! reaches them through.
//!
//! The webview cannot pin a self-signed certificate, so it never talks TLS to
//! a remote itself. The hub listens on `127.0.0.1` (a random port) and gives
//! each remote its own random secret; the webview opens
//! `ws://127.0.0.1:<port>/ws?token=<secret>` exactly as it opens the local
//! daemon. For each such connection the hub opens `wss://` to the remote,
//! pinning its fingerprint, authenticates with the device token from the
//! keychain (`remote.auth`), and only then completes the WebSocket upgrade.
//! From there it copies text frames both ways. The device token never reaches
//! the webview.
//!
//! The hub owns each remote's connection state, and paces attempts: a remote
//! that cannot be reached is retried with backoff (1 s doubling to 30 s);
//! until then, the webview's reconnects are refused here without touching the
//! network. A changed certificate or a refused device token is final until
//! the user pairs again: never retried, never accepted silently.

use crate::pin::{self, ConnectError, RemoteWs};
use crate::store::{Registry, RemoteEntry, Secrets};
use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message as LocalMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as RemoteMsg;

/// JSON-RPC errors of the remote listener (docs/design/remote.md §5).
pub const ERR_AUTH_FAILED: i64 = -32011;
pub const ERR_PAIR_CODE: i64 = -32012;
pub const ERR_RATE_LIMITED: i64 = -32013;

/// How often a live connection pings the remote, and how long without
/// anything from it before the connection counts as lost (a sleeping laptop,
/// a network that changed under it).
const PING_EVERY: Duration = Duration::from_secs(15);
const DEAD_AFTER: Duration = Duration::from_secs(45);
/// How long `remote.pair` / `remote.auth` may take to answer.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// The webview's messages are passed on up to the listener's own limit.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
/// A remote's name, as the user sets it.
const MAX_LABEL: usize = 64;

/// Where the connection to a remote stands, as the webview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LinkState {
    /// Nothing asked for a connection yet, or every one was closed.
    Idle,
    Connecting,
    Online {
        server_name: String,
        version: String,
    },
    /// The last attempt failed; the next one is not made before `retry_at`
    /// (epoch milliseconds), unless the user retries now.
    Retrying {
        reason: String,
        retry_at: u64,
    },
    /// The remote no longer accepts this computer (it was removed there), or
    /// its token is gone from the keychain. Pair again.
    Revoked {
        reason: String,
    },
    /// The remote showed another certificate than the one paired with. Never
    /// accepted; pairing again is the only way to trust a new one.
    CertMismatch {
        expected: String,
        actual: String,
    },
}

impl LinkState {
    fn is_final(&self) -> bool {
        matches!(
            self,
            LinkState::Revoked { .. } | LinkState::CertMismatch { .. }
        )
    }
}

/// A paired computer and its connection state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    #[serde(flatten)]
    pub entry: RemoteEntry,
    /// The label, or the computer's own name.
    pub name: String,
    pub state: LinkState,
}

/// What the webview connects to for one remote, as it does to the local
/// daemon: `ws://127.0.0.1:<port>/ws?token=<token>`.
#[derive(Debug, Clone, Serialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
}

/// What the user gives to pair: the pairing link's parts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub code: String,
    #[serde(default)]
    pub alt: Vec<String>,
    /// Pairing again for this remote: should the computer turn out to have
    /// another id (reinstalled), the old entry goes.
    #[serde(default)]
    pub replaces: Option<String>,
}

pub struct HubConfig {
    /// The paired computers' file (no secrets in it).
    pub registry_path: PathBuf,
    pub secrets: Arc<dyn Secrets>,
    /// How this computer introduces itself when pairing: its host name.
    pub device_name: String,
}

struct Link {
    /// The webview's secret for this remote on the bridge.
    secret: String,
    state: LinkState,
    /// Failed attempts in a row.
    attempt: u32,
    retry_at: Option<Instant>,
    /// Bridged connections open now.
    live: usize,
    /// The index (in `RemoteEntry::addresses`) that answered last.
    preferred: usize,
    /// Bumped to end every bridged connection (removed, paired again).
    kill: watch::Sender<u64>,
}

impl Link {
    fn new() -> Self {
        Self {
            secret: random_hex(32),
            state: LinkState::Idle,
            attempt: 0,
            retry_at: None,
            live: 0,
            preferred: 0,
            kill: watch::channel(0).0,
        }
    }
}

struct Inner {
    registry: Mutex<Registry>,
    secrets: Arc<dyn Secrets>,
    device_name: String,
    links: Mutex<HashMap<String, Link>>,
    port: u16,
    changes: watch::Sender<u64>,
}

/// The paired computers and the bridge. Cheap to clone; the bridge stops
/// when the last clone is dropped.
#[derive(Clone)]
pub struct RemoteHub {
    inner: Arc<Inner>,
    _server: Arc<AbortOnDrop>,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl RemoteHub {
    /// Load the paired computers and start the bridge on `127.0.0.1`.
    pub async fn start(config: HubConfig) -> Result<Self> {
        let registry = Registry::load(&config.registry_path)?;
        let links = registry
            .entries()
            .iter()
            .map(|e| (e.id.clone(), Link::new()))
            .collect();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("starting the remote computers' bridge on 127.0.0.1")?;
        let port = listener.local_addr()?.port();
        let inner = Arc::new(Inner {
            registry: Mutex::new(registry),
            secrets: config.secrets,
            device_name: config.device_name,
            links: Mutex::new(links),
            port,
            changes: watch::channel(0).0,
        });
        let app = axum::Router::new()
            .route("/ws", axum::routing::get(bridge_handler))
            .with_state(inner.clone());
        let server = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("remote computers' bridge stopped: {e}");
            }
        });
        Ok(Self {
            inner,
            _server: Arc::new(AbortOnDrop(server)),
        })
    }

    /// The bridge's port.
    pub fn port(&self) -> u16 {
        self.inner.port
    }

    /// Changes whenever a remote is added, renamed, removed or its connection
    /// state moves; read [`RemoteHub::list`] then.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.inner.changes.subscribe()
    }

    /// Every paired computer, in the order they were added.
    pub fn list(&self) -> Vec<RemoteView> {
        self.inner.list()
    }

    /// Where the webview connects for remote `id`.
    pub fn bridge(&self, id: &str) -> Result<BridgeInfo> {
        let links = self.inner.links.lock();
        let link = links
            .get(id)
            .ok_or_else(|| anyhow!("no remote computer {id}"))?;
        Ok(BridgeInfo {
            port: self.inner.port,
            token: link.secret.clone(),
        })
    }

    /// Try again at the next connection, without waiting out the backoff.
    /// A changed certificate or a refused device stays as it is.
    pub fn retry(&self, id: &str) {
        if let Some(link) = self.inner.links.lock().get_mut(id) {
            link.retry_at = None;
        }
    }

    /// Give remote `id` a name of the user's own; empty goes back to its own name.
    pub fn rename(&self, id: &str, name: &str) -> Result<RemoteView> {
        let name = name.trim();
        if name.chars().count() > MAX_LABEL {
            return Err(anyhow!("A name has at most {MAX_LABEL} characters"));
        }
        let label = (!name.is_empty()).then(|| name.to_string());
        self.inner.registry.lock().set_label(id, label)?;
        self.inner.notify();
        self.inner
            .list()
            .into_iter()
            .find(|v| v.entry.id == id)
            .ok_or_else(|| anyhow!("no remote computer {id}"))
    }

    /// Forget remote `id`: its connections end, its token leaves the keychain.
    /// The remote itself still lists this computer until it is removed there.
    pub async fn remove(&self, id: &str) -> Result<()> {
        let secrets = self.inner.secrets.clone();
        let key = id.to_string();
        tokio::task::spawn_blocking(move || secrets.delete(&key)).await??;
        let removed = self.inner.registry.lock().remove(id)?;
        if let Some(link) = self.inner.links.lock().remove(id) {
            link.kill.send_modify(|g| *g += 1);
        }
        if !removed {
            return Err(anyhow!("no remote computer {id}"));
        }
        self.inner.notify();
        Ok(())
    }

    /// Pair with a computer: `remote.pair` on the first of its addresses that
    /// shows the pinned certificate. The token goes to the keychain. Pairing
    /// again with a known computer replaces its token and fingerprint and ends
    /// its connections, which then come back with the new ones.
    pub async fn pair(&self, req: PairRequest) -> Result<RemoteView, String> {
        let fingerprint = pin::normalize_fingerprint(&req.fingerprint).ok_or(
            "The fingerprint is 64 hexadecimal characters (the SHA-256 of the certificate)",
        )?;
        let host = req.host.trim().to_string();
        if host.is_empty() {
            return Err("Enter the computer's address".into());
        }
        if req.port == 0 {
            return Err("Enter a port between 1 and 65535".into());
        }
        let code: String = req
            .code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        if code.is_empty() {
            return Err("Enter the pairing code".into());
        }
        let mut addresses = vec![host.clone()];
        for a in &req.alt {
            let a = a
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            if !a.is_empty() && !addresses.contains(&a) {
                addresses.push(a);
            }
        }

        let mut failures = Vec::new();
        let mut mismatch = None;
        for addr in &addresses {
            let mut ws = match pin::connect(addr, req.port, &fingerprint).await {
                Ok(ws) => ws,
                Err(ConnectError::CertMismatch { actual, .. }) => {
                    mismatch = Some((addr.clone(), actual));
                    continue;
                }
                Err(ConnectError::Network(m)) => {
                    failures.push(m);
                    continue;
                }
            };
            let result = call(
                &mut ws,
                "remote.pair",
                json!({"code": code, "deviceName": self.inner.device_name}),
            )
            .await;
            let _ = ws.close(None).await;
            let result = match result {
                Ok(v) => v,
                Err(CallError::Rpc {
                    code,
                    message,
                    data,
                }) => {
                    return Err(match code {
                        ERR_PAIR_CODE => "The pairing code is wrong, has expired or was already used. Start pairing again on that computer and use the new code.".to_string(),
                        ERR_RATE_LIMITED => format!(
                            "Too many failed attempts from this computer; try again in {} seconds.",
                            data.get("retryAfterSecs").and_then(Value::as_u64).unwrap_or(60)
                        ),
                        _ => format!("The computer refused pairing: {message}"),
                    });
                }
                Err(CallError::Transport(m)) => {
                    failures.push(m);
                    continue;
                }
            };
            return self
                .paired(&req, addr, &addresses, &fingerprint, result)
                .await
                .map_err(|e| format!("Paired, but could not save it: {e:#}"));
        }
        if let Some((addr, actual)) = mismatch {
            return Err(format!(
                "The computer at {addr} shows certificate {actual}, not the fingerprint {fingerprint} you were given. Nothing was paired. Check the link or fingerprint on that computer (Settings → Remote access)."
            ));
        }
        Err(format!(
            "Could not reach the computer: {}",
            failures.join("; ")
        ))
    }

    async fn paired(
        &self,
        req: &PairRequest,
        answered: &str,
        addresses: &[String],
        fingerprint: &str,
        result: Value,
    ) -> Result<RemoteView> {
        let field = |k: &str| {
            result
                .get(k)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("the answer to remote.pair has no {k}"))
        };
        let id = field("serverId")?;
        let token = field("token")?;
        // The address that answered first next time; the rest after it.
        let mut alt: Vec<String> = addresses
            .iter()
            .filter(|a| *a != answered)
            .cloned()
            .collect();
        alt.dedup();
        let entry = RemoteEntry {
            id: id.clone(),
            label: None,
            server_name: field("serverName")?,
            host: answered.to_string(),
            alt,
            port: req.port,
            fingerprint: fingerprint.to_string(),
            device_id: field("deviceId")?,
            paired_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        };
        let secrets = self.inner.secrets.clone();
        let (key, value) = (id.clone(), token);
        tokio::task::spawn_blocking(move || secrets.set(&key, &value)).await??;
        let saved = self.inner.registry.lock().upsert(entry);
        if let Err(e) = saved {
            let secrets = self.inner.secrets.clone();
            let key = id.clone();
            let _ = tokio::task::spawn_blocking(move || secrets.delete(&key)).await;
            return Err(e);
        }
        {
            let mut links = self.inner.links.lock();
            let link = links.entry(id.clone()).or_insert_with(Link::new);
            link.state = LinkState::Idle;
            link.attempt = 0;
            link.retry_at = None;
            link.preferred = 0;
            // Connections on the old token or certificate end; the webview
            // reconnects on the new ones.
            link.kill.send_modify(|g| *g += 1);
        }
        if let Some(old) = req.replaces.as_deref().filter(|old| *old != id) {
            if let Err(e) = self.remove(old).await {
                tracing::warn!(
                    "re-paired {old} as {id}, but could not remove the old entry: {e:#}"
                );
            }
        }
        self.inner.notify();
        self.inner
            .list()
            .into_iter()
            .find(|v| v.entry.id == id)
            .ok_or_else(|| anyhow!("{id} vanished"))
    }
}

impl Inner {
    fn notify(&self) {
        self.changes.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn list(&self) -> Vec<RemoteView> {
        let registry = self.registry.lock();
        let links = self.links.lock();
        registry
            .entries()
            .iter()
            .map(|e| RemoteView {
                name: e.name().to_string(),
                state: links
                    .get(&e.id)
                    .map(|l| l.state.clone())
                    .unwrap_or(LinkState::Idle),
                entry: e.clone(),
            })
            .collect()
    }

    /// The remote whose bridge secret is `token`. Compared in constant time.
    fn remote_for_secret(&self, token: &str) -> Option<String> {
        let links = self.links.lock();
        let mut found = None;
        for (id, link) in links.iter() {
            if constant_time_eq(link.secret.as_bytes(), token.as_bytes()) {
                found = Some(id.clone());
            }
        }
        found
    }

    fn set_state(&self, id: &str, f: impl FnOnce(&mut Link)) {
        self.set_state_if(id, None, f);
    }

    /// `set_state` for an attempt started at generation `gen` (the link's
    /// `kill` value then): nothing happens if the remote was paired again or
    /// removed since, so an obsolete attempt never touches the state. Returns
    /// whether `f` ran.
    fn set_state_if(&self, id: &str, gen: Option<u64>, f: impl FnOnce(&mut Link)) -> bool {
        let mut ran = false;
        let changed = {
            let mut links = self.links.lock();
            match links.get_mut(id) {
                Some(link) if gen.is_none_or(|g| *link.kill.borrow() == g) => {
                    ran = true;
                    let before = link.state.clone();
                    f(link);
                    link.state != before
                }
                _ => false,
            }
        };
        if changed {
            self.notify();
        }
        ran
    }

    /// Open an authenticated connection to remote `id` for the bridge, or say
    /// why not. Moves the remote's state either way. Pairing the remote again
    /// or removing it while this runs calls it off: what it found is for the
    /// old certificate and token, and is dropped.
    async fn open(self: &Arc<Self>, id: &str) -> Result<(RemoteWs, LiveGuard), Refused> {
        let (entry, preferred, connecting, gen, mut cancelled) = {
            let registry = self.registry.lock();
            let entry = registry.get(id).cloned().ok_or(Refused::Unknown)?;
            let mut links = self.links.lock();
            let link = links.get_mut(id).ok_or(Refused::Unknown)?;
            if link.state.is_final() {
                return Err(Refused::Final);
            }
            if link.retry_at.is_some_and(|at| at > Instant::now()) {
                return Err(Refused::Backoff);
            }
            // With a connection up (another window), the state stays online.
            let connecting = link.live == 0 && link.state != LinkState::Connecting;
            if connecting {
                link.state = LinkState::Connecting;
            }
            let gen = *link.kill.borrow();
            (
                entry,
                link.preferred,
                connecting,
                gen,
                link.kill.subscribe(),
            )
        };
        if connecting {
            self.notify();
        }
        tokio::select! {
            r = self.attempt(id, entry, preferred, gen) => r,
            // Paired again or removed (the sender is gone): called off.
            _ = cancelled.changed() => Err(Refused::Obsolete),
        }
    }

    /// One attempt for `open`, made at generation `gen`.
    async fn attempt(
        self: &Arc<Self>,
        id: &str,
        entry: RemoteEntry,
        preferred: usize,
        gen: u64,
    ) -> Result<(RemoteWs, LiveGuard), Refused> {
        let g = Some(gen);

        let secrets = self.secrets.clone();
        let key = id.to_string();
        let token = match tokio::task::spawn_blocking(move || secrets.get(&key)).await {
            Ok(Ok(Some(t))) => t,
            Ok(Ok(None)) => {
                self.set_state_if(id, g, |l| {
                    l.state = LinkState::Revoked {
                        reason: "This computer's key for it is gone from the keychain. Pair again."
                            .into(),
                    }
                });
                return Err(Refused::Final);
            }
            Ok(Err(e)) => return Err(self.failed(id, g, format!("{e:#}"), None)),
            Err(e) => return Err(self.failed(id, g, e.to_string(), None)),
        };

        let addresses = entry.addresses();
        let first = preferred.min(addresses.len() - 1);
        let order: Vec<usize> = std::iter::once(first)
            .chain((0..addresses.len()).filter(|i| *i != first))
            .collect();
        let mut mismatch = None;
        let mut failures = Vec::new();
        for i in order {
            let addr = &addresses[i];
            let mut ws = match pin::connect(addr, entry.port, &entry.fingerprint).await {
                Ok(ws) => ws,
                Err(ConnectError::CertMismatch { expected, actual }) => {
                    mismatch = Some((expected, actual));
                    continue;
                }
                Err(ConnectError::Network(m)) => {
                    failures.push(m);
                    continue;
                }
            };
            match call(
                &mut ws,
                "remote.auth",
                json!({"deviceId": entry.device_id, "token": token}),
            )
            .await
            {
                Ok(auth) => {
                    if auth.get("serverId").and_then(Value::as_str) != Some(entry.id.as_str()) {
                        let _ = ws.close(None).await;
                        self.set_state_if(id, g, |l| {
                            l.state = LinkState::Revoked {
                                reason: format!(
                                    "The computer at {addr} is not the one this computer paired with. Pair again."
                                ),
                            }
                        });
                        return Err(Refused::Final);
                    }
                    let online = LinkState::Online {
                        server_name: auth
                            .get("serverName")
                            .and_then(Value::as_str)
                            .unwrap_or(&entry.server_name)
                            .to_string(),
                        version: auth
                            .get("version")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    };
                    let mut kill = None;
                    // Only if this attempt is still current: checked and counted under one lock.
                    self.set_state_if(id, g, |l| {
                        l.state = online;
                        l.attempt = 0;
                        l.retry_at = None;
                        l.preferred = i;
                        l.live += 1;
                        kill = Some(l.kill.subscribe());
                    });
                    let Some(kill) = kill else {
                        // Paired again or removed while connecting.
                        let _ = ws.close(None).await;
                        return Err(Refused::Obsolete);
                    };
                    return Ok((
                        ws,
                        LiveGuard {
                            inner: self.clone(),
                            id: id.to_string(),
                            kill,
                            upstream_lost: false,
                        },
                    ));
                }
                Err(CallError::Rpc {
                    code: ERR_AUTH_FAILED,
                    message,
                    ..
                }) => {
                    tracing::warn!("remote {id} refused this device: {message}");
                    self.set_state_if(id, g, |l| {
                        l.state = LinkState::Revoked {
                            reason: format!(
                                "{} no longer accepts this computer; it was removed there. Pair again.",
                                entry.name()
                            ),
                        }
                    });
                    return Err(Refused::Final);
                }
                Err(CallError::Rpc {
                    code: ERR_RATE_LIMITED,
                    data,
                    message,
                }) => {
                    let secs = data
                        .get("retryAfterSecs")
                        .and_then(Value::as_u64)
                        .unwrap_or(60);
                    return Err(self.failed(id, g, message, Some(Duration::from_secs(secs))));
                }
                Err(CallError::Rpc { message, .. }) => failures.push(message),
                Err(CallError::Transport(m)) => failures.push(m),
            }
        }
        if let Some((expected, actual)) = mismatch {
            tracing::warn!("remote {id} showed certificate {actual}, pinned {expected}");
            self.set_state_if(id, g, |l| {
                l.state = LinkState::CertMismatch { expected, actual }
            });
            return Err(Refused::Final);
        }
        Err(self.failed(id, g, failures.join("; "), None))
    }

    /// An attempt failed for a reason worth retrying: back off.
    fn failed(
        &self,
        id: &str,
        gen: Option<u64>,
        reason: String,
        wait: Option<Duration>,
    ) -> Refused {
        self.set_state_if(id, gen, |l| {
            l.attempt += 1;
            let wait = wait.unwrap_or_else(|| backoff(l.attempt));
            if l.live == 0 && !l.state.is_final() {
                l.retry_at = Some(Instant::now() + wait);
                l.state = LinkState::Retrying {
                    reason,
                    retry_at: epoch_ms(SystemTime::now() + wait),
                };
            }
        });
        Refused::Failed
    }
}

/// One bridged connection: counted while it lives, and when the last one
/// ends the remote's state says why.
struct LiveGuard {
    inner: Arc<Inner>,
    id: String,
    kill: watch::Receiver<u64>,
    upstream_lost: bool,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        let lost = self.upstream_lost;
        self.inner.set_state(&self.id, |l| {
            l.live = l.live.saturating_sub(1);
            if l.live > 0 || l.state.is_final() {
                return;
            }
            if lost {
                // Retried after a short pause; a remote that went away for
                // good backs off from there.
                l.attempt = 1;
                let wait = backoff(1);
                l.retry_at = Some(Instant::now() + wait);
                l.state = LinkState::Retrying {
                    reason: "The connection was lost".into(),
                    retry_at: epoch_ms(SystemTime::now() + wait),
                };
            } else {
                l.state = LinkState::Idle;
            }
        });
    }
}

#[derive(Debug)]
enum Refused {
    /// Not a remote (any more).
    Unknown,
    /// Revoked or a changed certificate: pair again.
    Final,
    /// Waiting out the backoff.
    Backoff,
    /// This attempt failed; backing off from now.
    Failed,
    /// The remote was paired again or removed while this attempt ran.
    Obsolete,
}

#[derive(Deserialize)]
struct BridgeQuery {
    token: Option<String>,
}

async fn bridge_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<BridgeQuery>,
    State(inner): State<Arc<Inner>>,
) -> Response {
    let Some(id) = q.token.as_deref().and_then(|t| inner.remote_for_secret(t)) else {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    };
    match inner.open(&id).await {
        Ok((upstream, guard)) => ws
            .max_message_size(MAX_MESSAGE)
            .on_upgrade(move |socket| bridge(socket, upstream, guard))
            .into_response(),
        // The webview's client backs off on a failed connection; the state
        // event says why.
        Err(Refused::Unknown) => (StatusCode::NOT_FOUND, "no such remote").into_response(),
        Err(Refused::Final) => (StatusCode::FORBIDDEN, "pair again").into_response(),
        Err(Refused::Backoff | Refused::Failed | Refused::Obsolete) => {
            (StatusCode::SERVICE_UNAVAILABLE, "remote not reachable").into_response()
        }
    }
}

/// Copy text frames both ways until either side goes, the remote stops
/// answering, or the remote is removed or paired again.
async fn bridge(local: WebSocket, upstream: RemoteWs, mut guard: LiveGuard) {
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut lo_tx, mut lo_rx) = local.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut heard = Instant::now();
    let mut kill = guard.kill.clone();
    loop {
        tokio::select! {
            m = lo_rx.next() => match m {
                Some(Ok(LocalMsg::Text(t))) => {
                    if up_tx.send(RemoteMsg::Text(t)).await.is_err() {
                        guard.upstream_lost = true;
                        break;
                    }
                }
                // PTY frames: remote clients get no terminals, and the
                // listener ignores binary frames anyway.
                Some(Ok(LocalMsg::Binary(_) | LocalMsg::Ping(_) | LocalMsg::Pong(_))) => {}
                Some(Ok(LocalMsg::Close(_))) | Some(Err(_)) | None => break,
            },
            m = up_rx.next() => match m {
                Some(Ok(RemoteMsg::Text(t))) => {
                    heard = Instant::now();
                    if lo_tx.send(LocalMsg::Text(t)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(RemoteMsg::Close(_))) | Some(Err(_)) | None => {
                    guard.upstream_lost = true;
                    break;
                }
                Some(Ok(_)) => heard = Instant::now(),
            },
            _ = ping.tick() => {
                if heard.elapsed() > DEAD_AFTER
                    || up_tx.send(RemoteMsg::Ping(Vec::new())).await.is_err()
                {
                    guard.upstream_lost = true;
                    break;
                }
            },
            _ = kill.changed() => break,
        }
    }
    let close = async {
        let _ = up_tx.send(RemoteMsg::Close(None)).await;
        let _ = lo_tx.send(LocalMsg::Close(None)).await;
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), close).await;
    drop(guard);
}

#[derive(Debug)]
enum CallError {
    /// The remote answered with an error.
    Rpc {
        code: i64,
        message: String,
        data: Value,
    },
    /// No answer: the connection closed or timed out.
    Transport(String),
}

/// One JSON-RPC call on a fresh connection; notifications are skipped.
async fn call(ws: &mut RemoteWs, method: &str, params: Value) -> Result<Value, CallError> {
    ws.send(RemoteMsg::Text(
        json!({"id": 1, "method": method, "params": params}).to_string(),
    ))
    .await
    .map_err(|e| CallError::Transport(e.to_string()))?;
    let answer = tokio::time::timeout(CALL_TIMEOUT, async {
        loop {
            match ws.next().await {
                Some(Ok(RemoteMsg::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(&t) else {
                        continue;
                    };
                    if v.get("id") == Some(&json!(1)) {
                        return Ok(v);
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(CallError::Transport(e.to_string())),
                None => return Err(CallError::Transport("the connection closed".into())),
            }
        }
    })
    .await
    .map_err(|_| CallError::Transport(format!("{method} got no answer in time")))??;
    if let Some(err) = answer.get("error") {
        return Err(CallError::Rpc {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string(),
            data: err.get("data").cloned().unwrap_or(Value::Null),
        });
    }
    Ok(answer.get("result").cloned().unwrap_or(Value::Null))
}

/// How long to wait before attempt `attempt` (1 is the first retry): doubling
/// from 1 s to 30 s, ±20 % jitter. The Android app does the same.
pub fn backoff(attempt: u32) -> Duration {
    let base = 1_000u64 << attempt.max(1).saturating_sub(1).min(5);
    let capped = base.min(30_000) as f64;
    let jitter = capped * 0.2 * rand::thread_rng().gen_range(-1.0..=1.0);
    Duration::from_millis((capped + jitter) as u64)
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill(buf.as_mut_slice());
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_thirty_seconds() {
        for (attempt, base) in [
            (1, 1_000u64),
            (2, 2_000),
            (3, 4_000),
            (6, 30_000),
            (20, 30_000),
        ] {
            let ms = backoff(attempt).as_millis() as u64;
            assert!(
                ms >= base * 8 / 10 && ms <= base * 12 / 10,
                "attempt {attempt}: {ms}"
            );
        }
    }

    #[test]
    fn states_serialize_for_the_webview() {
        let v = serde_json::to_value(LinkState::Retrying {
            reason: "x".into(),
            retry_at: 5,
        })
        .unwrap();
        assert_eq!(v, json!({"kind": "retrying", "reason": "x", "retryAt": 5}));
        let v = serde_json::to_value(LinkState::CertMismatch {
            expected: "a".into(),
            actual: "b".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"kind": "cert_mismatch", "expected": "a", "actual": "b"})
        );
        assert_eq!(
            serde_json::to_value(LinkState::Idle).unwrap(),
            json!({"kind": "idle"})
        );
    }

    #[test]
    fn secrets_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
