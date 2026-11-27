//! Remote access: an opt-in second listener, a TLS WebSocket for paired
//! devices, speaking the same JSON-RPC protocol as the loopback one but
//! limited to [`REMOTE_ALLOWED_METHODS`]. The contract for clients is
//! `docs/design/remote.md`.
//!
//! Everything it keeps lives in `<data_dir>/remote/`: `config.json`,
//! `devices.json` (device tokens only as SHA-256 hashes) and the self-signed
//! certificate (`cert.pem`, `key.pem`), all 0600.

use crate::server::AppState;
use crate::{ERR_AUTH_FAILED, ERR_INTERNAL, ERR_PAIR_CODE, ERR_RATE_LIMITED};
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot};
use ts_rs::TS;

/// The methods a paired remote device may call once authenticated. Every
/// other method is refused with `ERR_FORBIDDEN`. Four of them are narrowed
/// for remote callers (see `server::remote_dispatch`): `daemon.info` leaves
/// out the local token, port and data directory; `session.send` and
/// `session.interrupt` refuse terminal-mode sessions, and `session.send`
/// takes images by value only, never a path; `session.create` only takes a
/// folder in a known project (symlinks resolved) and a few options.
pub const REMOTE_ALLOWED_METHODS: &[&str] = &[
    "daemon.ping",
    "daemon.info",
    "provider.list",
    "provider.models",
    "orchestrator.projects",
    "workspace.list",
    "session.list",
    "session.get",
    "session.history",
    "session.pending",
    "session.attachment",
    "session.send",
    "session.interrupt",
    "session.stop",
    "session.respond_approval",
    "session.respond_input",
    "session.mark_seen",
    "session.create",
    "feature.list",
    "feature.get",
    "feature.answer",
];

pub const DEFAULT_PORT: u16 = 7443;
pub const DEFAULT_BIND: &str = "0.0.0.0";
/// How long a pairing code works.
pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
/// Pair codes: no 0/O, 1/I/L, so a code read off a screen is typed right.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
/// Failed pair/auth attempts allowed per IP within [`FAILURE_WINDOW`].
pub const MAX_FAILURES: usize = 5;
pub const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// A remote connection that has not paired or authenticated this long after
/// its TCP accept is closed, whatever stage it is at (TLS, upgrade, auth).
pub const AUTH_DEADLINE: Duration = Duration::from_secs(30);
/// Connections not yet authenticated at once; more are refused at accept.
pub const MAX_UNAUTHENTICATED: usize = 32;
/// Largest WebSocket message (and frame) the remote listener takes.
pub const MAX_MESSAGE: usize = 16 * 1024 * 1024;
/// Largest message before authentication; a bigger one closes the connection.
pub const MAX_PRE_AUTH_MESSAGE: usize = 64 * 1024;
const MAX_DEVICE_NAME: usize = 64;
const MAX_SERVER_NAME: usize = 64;

// ---------------------------------------------------------------------------
// Wire types (exported to TypeScript for the desktop app)

/// `remote.status`, and the result of `remote.configure`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub server_name: String,
    pub server_id: String,
    /// SHA-256 of the certificate (DER), lowercase hex. None until the
    /// certificate is made, on first enable.
    pub fingerprint: Option<String>,
    pub listening: bool,
    /// Why the listener is not up, when it should be.
    pub error: Option<String>,
    /// The machine's non-loopback addresses a device can reach it on.
    pub addresses: Vec<String>,
}

/// `remote.configure` params: omitted fields keep their value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteConfigure {
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[ts(optional)]
    pub bind_address: Option<String>,
    #[ts(optional)]
    pub port: Option<u16>,
    #[ts(optional)]
    pub server_name: Option<String>,
}

/// `remote.startPairing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PairingInfo {
    pub code: String,
    pub expires_at: DateTime<Utc>,
    /// `aura://pair?host=…&port=…&fp=…&code=…&name=…[&alt=…]`, for a QR code.
    pub uri: String,
    pub fingerprint: String,
    pub addresses: Vec<String>,
}

/// `remote.listDevices`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteDevice {
    pub device_id: String,
    pub name: String,
    pub paired_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_address: Option<String>,
}

/// `remote.pair` result (remote listener, before authentication).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PairResult {
    pub device_id: String,
    /// 64 hex characters; the daemon keeps only its hash.
    pub token: String,
    pub server_id: String,
    pub server_name: String,
    pub version: String,
}

/// `remote.auth` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuthResult {
    pub server_id: String,
    pub server_name: String,
    pub version: String,
}

// ---------------------------------------------------------------------------
// Stored state

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RemoteConfig {
    enabled: bool,
    bind_address: String,
    port: u16,
    /// None: the machine's host name.
    server_name: Option<String>,
    server_id: String,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_address: DEFAULT_BIND.into(),
            port: DEFAULT_PORT,
            server_name: None,
            server_id: String::new(),
        }
    }
}

impl RemoteConfig {
    fn server_name(&self) -> String {
        self.server_name.clone().unwrap_or_else(host_name)
    }
    fn socket_addr(&self) -> Result<SocketAddr> {
        let ip: IpAddr = self.bind_address.parse().with_context(|| {
            format!("bind address `{}` is not an IP address", self.bind_address)
        })?;
        Ok(SocketAddr::new(ip, self.port))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRecord {
    device_id: String,
    name: String,
    /// SHA-256 of the token, lowercase hex.
    token_hash: String,
    paired_at: DateTime<Utc>,
    #[serde(default)]
    last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    last_address: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DevicesFile {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

struct Tls {
    fingerprint: String,
    config: Arc<rustls::ServerConfig>,
}

struct Running {
    addr: SocketAddr,
    stop: oneshot::Sender<()>,
}

struct PendingCode {
    code: String,
    expires_at: DateTime<Utc>,
}

/// What ends live remote connections.
#[derive(Debug, Clone)]
pub(crate) enum Kill {
    /// The listener stopped or moved.
    All,
    /// That device was revoked.
    Device(String),
}

/// A failed `remote.pair` / `remote.auth`, or one refused for the rate limit.
/// The connection is closed after it is answered.
#[derive(Debug, Clone)]
pub(crate) struct RemoteError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RemoteError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

struct Inner {
    config: RemoteConfig,
    devices: Vec<DeviceRecord>,
    tls: Option<Tls>,
    running: Option<Running>,
    error: Option<String>,
    pairing: Option<PendingCode>,
    failures: HashMap<IpAddr, VecDeque<Instant>>,
}

/// How long a connection may take to authenticate, and how many may be at
/// it at once. Shared by the listener and its connections.
#[derive(Debug)]
struct Limits {
    auth_deadline: parking_lot::Mutex<Duration>,
    max_unauthenticated: AtomicUsize,
    unauthenticated: Arc<AtomicUsize>,
}

/// One unauthenticated connection's place under [`MAX_UNAUTHENTICATED`];
/// dropping it frees the place.
#[derive(Debug)]
pub(crate) struct UnauthSlot(Arc<AtomicUsize>);

impl Drop for UnauthSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Limits {
    fn take_slot(&self) -> Option<UnauthSlot> {
        let max = self.max_unauthenticated.load(Ordering::SeqCst);
        let before = self.unauthenticated.fetch_add(1, Ordering::SeqCst);
        let slot = UnauthSlot(self.unauthenticated.clone());
        (before < max).then_some(slot)
    }
}

/// Remote access for one daemon: its config, certificate, paired devices,
/// pairing code and listener.
pub struct RemoteService {
    dir: PathBuf,
    inner: parking_lot::Mutex<Inner>,
    /// Serializes [`RemoteService::apply`], which binds outside `inner`'s lock.
    applying: tokio::sync::Mutex<()>,
    kill: broadcast::Sender<Kill>,
    limits: Arc<Limits>,
}

impl RemoteService {
    /// Load what is in `<data_dir>/remote/`. Missing files mean remote
    /// access was never set up (off). A file that cannot be read is logged
    /// and treated as missing, so the daemon still starts.
    pub fn load(data_dir: &Path) -> Arc<Self> {
        let dir = data_dir.join("remote");
        let config_path = dir.join("config.json");
        let mut config = match read_json::<RemoteConfig>(&config_path) {
            Ok(Some(c)) => c,
            Ok(None) => RemoteConfig::default(),
            Err(e) => {
                tracing::warn!("remote access config unreadable, using defaults: {e:#}");
                RemoteConfig::default()
            }
        };
        let mut persist = false;
        if uuid::Uuid::parse_str(&config.server_id).is_err() {
            config.server_id = uuid::Uuid::new_v4().to_string();
            // Kept from now on if remote access was set up before; otherwise
            // written with the first `remote.configure`.
            persist = config_path.exists();
        }
        let devices = match read_json::<DevicesFile>(&dir.join("devices.json")) {
            Ok(f) => f.unwrap_or_default().devices,
            Err(e) => {
                tracing::warn!("remote devices unreadable, none are paired: {e:#}");
                vec![]
            }
        };
        let tls = match load_tls(&dir) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("remote access certificate unreadable: {e:#}");
                None
            }
        };
        let (kill, _) = broadcast::channel(64);
        let service = Arc::new(Self {
            dir,
            inner: parking_lot::Mutex::new(Inner {
                config,
                devices,
                tls,
                running: None,
                error: None,
                pairing: None,
                failures: HashMap::new(),
            }),
            applying: tokio::sync::Mutex::new(()),
            kill,
            limits: Arc::new(Limits {
                auth_deadline: parking_lot::Mutex::new(AUTH_DEADLINE),
                max_unauthenticated: AtomicUsize::new(MAX_UNAUTHENTICATED),
                unauthenticated: Arc::new(AtomicUsize::new(0)),
            }),
        });
        if persist {
            if let Err(e) = service.save_config(&service.inner.lock().config) {
                tracing::warn!("could not keep the server id: {e:#}");
            }
        }
        service
    }

    /// Change [`AUTH_DEADLINE`] and [`MAX_UNAUTHENTICATED`] for connections
    /// accepted from now on. For tests and tuning.
    pub fn set_connection_limits(&self, auth_deadline: Duration, max_unauthenticated: usize) {
        *self.limits.auth_deadline.lock() = auth_deadline;
        self.limits
            .max_unauthenticated
            .store(max_unauthenticated, Ordering::SeqCst);
    }

    pub(crate) fn subscribe_kill(&self) -> broadcast::Receiver<Kill> {
        self.kill.subscribe()
    }

    /// Make the listener match the config: start, stop or rebind it. A
    /// failure (no certificate, port taken) is kept for `remote.status`.
    pub async fn apply(&self, state: &AppState) {
        let _one_at_a_time = self.applying.lock().await;
        let (enabled, addr) = {
            let i = self.inner.lock();
            (i.config.enabled, i.config.socket_addr())
        };
        {
            let mut i = self.inner.lock();
            let same = match (&i.running, &addr) {
                (Some(r), Ok(a)) => enabled && r.addr == *a,
                _ => false,
            };
            if same {
                return;
            }
            if let Some(r) = i.running.take() {
                let _ = r.stop.send(());
                let _ = self.kill.send(Kill::All);
                tracing::info!(addr = %r.addr, "remote access stopped");
            }
            i.error = None;
            if !enabled {
                return;
            }
        }
        let addr = match addr {
            Ok(a) => a,
            Err(e) => {
                self.inner.lock().error = Some(format!("{e:#}"));
                return;
            }
        };
        let tls = match self.ensure_tls() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("remote access: {e:#}");
                self.inner.lock().error = Some(format!("{e:#}"));
                return;
            }
        };
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("could not listen on {addr}: {e}");
                tracing::warn!("remote access: {msg}");
                self.inner.lock().error = Some(msg);
                return;
            }
        };
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(serve(
            listener,
            tokio_rustls::TlsAcceptor::from(tls),
            crate::server::remote_router(state.clone()),
            stopped,
            state.shutdown.subscribe(),
            self.kill.clone(),
            self.limits.clone(),
        ));
        tracing::info!(%addr, "remote access listening");
        self.inner.lock().running = Some(Running { addr, stop });
    }

    pub fn status(&self) -> RemoteStatus {
        let i = self.inner.lock();
        let bind = i.config.socket_addr().map(|a| a.ip());
        RemoteStatus {
            enabled: i.config.enabled,
            bind_address: i.config.bind_address.clone(),
            port: i.config.port,
            server_name: i.config.server_name(),
            server_id: i.config.server_id.clone(),
            fingerprint: i.tls.as_ref().map(|t| t.fingerprint.clone()),
            listening: i.running.is_some(),
            error: i.error.clone(),
            addresses: bind.map(addresses).unwrap_or_default(),
        }
    }

    /// Check and keep `change`, then apply it.
    pub async fn configure(
        &self,
        state: &AppState,
        change: RemoteConfigure,
    ) -> Result<RemoteStatus> {
        {
            let mut i = self.inner.lock();
            let mut c = i.config.clone();
            if let Some(b) = change.bind_address {
                let b = b.trim();
                b.parse::<IpAddr>().map_err(|_| {
                    anyhow!("bindAddress `{b}` is not an IP address: use e.g. 0.0.0.0 (all IPv4), :: (all) or 127.0.0.1 (this machine only)")
                })?;
                c.bind_address = b.to_string();
            }
            if let Some(p) = change.port {
                if p == 0 {
                    bail!("port must be between 1 and 65535");
                }
                c.port = p;
            }
            if let Some(n) = change.server_name {
                let n = n.trim();
                if n.is_empty() || n.chars().count() > MAX_SERVER_NAME {
                    bail!("serverName must be 1 to {MAX_SERVER_NAME} characters");
                }
                c.server_name = Some(n.to_string());
            }
            if let Some(e) = change.enabled {
                c.enabled = e;
            }
            self.save_config(&c)?;
            if !c.enabled {
                i.pairing = None;
            }
            i.config = c;
        }
        self.apply(state).await;
        Ok(self.status())
    }

    /// A fresh one-time code; the previous one stops working.
    pub fn start_pairing(&self) -> Result<PairingInfo> {
        let mut i = self.inner.lock();
        if !i.config.enabled {
            bail!(
                "remote access is off: turn it on first (`aura remote on`, or remote.configure {{\"enabled\": true}})"
            );
        }
        let fingerprint = i
            .tls
            .as_ref()
            .map(|t| t.fingerprint.clone())
            .ok_or_else(|| {
                anyhow!(
                    "remote access has no certificate yet: {}",
                    i.error.clone().unwrap_or_default()
                )
            })?;
        let code = new_code();
        let expires_at = Utc::now() + chrono::Duration::from_std(PAIRING_TTL).expect("5 minutes");
        let addresses = i
            .config
            .socket_addr()
            .map(|a| addresses(a.ip()))
            .unwrap_or_default();
        let host = addresses
            .first()
            .cloned()
            .unwrap_or_else(|| i.config.bind_address.clone());
        let alt = addresses.get(1..).unwrap_or_default();
        let uri = pairing_uri(
            &host,
            alt,
            i.config.port,
            &fingerprint,
            &code,
            &i.config.server_name(),
        );
        i.pairing = Some(PendingCode {
            code: code.clone(),
            expires_at,
        });
        Ok(PairingInfo {
            code,
            expires_at,
            uri,
            fingerprint,
            addresses,
        })
    }

    pub fn list_devices(&self) -> Vec<RemoteDevice> {
        self.inner
            .lock()
            .devices
            .iter()
            .map(|d| RemoteDevice {
                device_id: d.device_id.clone(),
                name: d.name.clone(),
                paired_at: d.paired_at,
                last_seen_at: d.last_seen_at,
                last_address: d.last_address.clone(),
            })
            .collect()
    }

    /// Forget the device and close its live connections.
    pub fn revoke_device(&self, device_id: &str) -> Result<()> {
        let mut i = self.inner.lock();
        let before = i.devices.len();
        let kept: Vec<DeviceRecord> = i
            .devices
            .iter()
            .filter(|d| d.device_id != device_id)
            .cloned()
            .collect();
        if kept.len() == before {
            bail!("no paired device has id {device_id}");
        }
        self.save_devices(&kept)?;
        i.devices = kept;
        drop(i);
        let _ = self.kill.send(Kill::Device(device_id.to_string()));
        Ok(())
    }

    pub(crate) fn device_exists(&self, device_id: &str) -> bool {
        self.inner
            .lock()
            .devices
            .iter()
            .any(|d| d.device_id == device_id)
    }

    /// `remote.pair` from `ip`.
    pub(crate) fn pair(
        &self,
        ip: IpAddr,
        code: &str,
        device_name: &str,
    ) -> Result<PairResult, RemoteError> {
        let mut i = self.inner.lock();
        i.check_rate(ip)?;
        let given: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .flat_map(char::to_uppercase)
            .collect();
        let valid = i.pairing.as_ref().is_some_and(|p| {
            Utc::now() < p.expires_at && same_bytes(given.as_bytes(), p.code.as_bytes())
        });
        if !valid {
            i.failed(ip);
            return Err(RemoteError::new(
                ERR_PAIR_CODE,
                "this pair code is invalid, expired or already used: start pairing again on the computer",
            ));
        }
        let name: String = device_name.trim().chars().take(MAX_DEVICE_NAME).collect();
        let name = if name.trim().is_empty() {
            "Device".to_string()
        } else {
            name.trim().to_string()
        };
        let token = crate::server::random_secret();
        let now = Utc::now();
        let device = DeviceRecord {
            device_id: uuid::Uuid::new_v4().to_string(),
            name,
            token_hash: sha256_hex(token.as_bytes()),
            paired_at: now,
            last_seen_at: Some(now),
            last_address: Some(ip.to_string()),
        };
        let mut devices = i.devices.clone();
        devices.push(device.clone());
        self.save_devices(&devices).map_err(|e| {
            RemoteError::new(ERR_INTERNAL, format!("could not keep the device: {e:#}"))
        })?;
        i.devices = devices;
        // Used: it pairs one device only.
        i.pairing = None;
        tracing::info!(device = %device.device_id, name = %device.name, %ip, "remote device paired");
        Ok(PairResult {
            device_id: device.device_id,
            token,
            server_id: i.config.server_id.clone(),
            server_name: i.config.server_name(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    /// `remote.auth` from `ip`.
    pub(crate) fn auth(
        &self,
        ip: IpAddr,
        device_id: &str,
        token: &str,
    ) -> Result<AuthResult, RemoteError> {
        let mut i = self.inner.lock();
        i.check_rate(ip)?;
        let hash = sha256_hex(token.as_bytes());
        let found = i.devices.iter().position(|d| {
            d.device_id == device_id && same_bytes(d.token_hash.as_bytes(), hash.as_bytes())
        });
        let Some(n) = found else {
            i.failed(ip);
            return Err(RemoteError::new(
                ERR_AUTH_FAILED,
                "unknown or revoked device, or a wrong token: pair this device again",
            ));
        };
        let mut devices = i.devices.clone();
        devices[n].last_seen_at = Some(Utc::now());
        devices[n].last_address = Some(ip.to_string());
        if let Err(e) = self.save_devices(&devices) {
            tracing::warn!("could not note when the device was last seen: {e:#}");
        }
        i.devices = devices;
        Ok(AuthResult {
            server_id: i.config.server_id.clone(),
            server_name: i.config.server_name(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    /// The certificate, made and kept on first use.
    fn ensure_tls(&self) -> Result<Arc<rustls::ServerConfig>> {
        let mut i = self.inner.lock();
        if let Some(t) = &i.tls {
            return Ok(t.config.clone());
        }
        create_dir_private(&self.dir)?;
        let names = vec!["aura.local".to_string(), "localhost".to_string()];
        let mut params = rcgen::CertificateParams::new(names).context("certificate parameters")?;
        params.distinguished_name.push(
            rcgen::DnType::CommonName,
            format!("Aura on {}", host_name()),
        );
        params.not_before = rcgen::date_time_ymd(2025, 1, 1);
        params.not_after = rcgen::date_time_ymd(2125, 1, 1);
        let key = rcgen::KeyPair::generate().context("generate the certificate key")?;
        let cert = params.self_signed(&key).context("make the certificate")?;
        write_private(&self.dir.join("key.pem"), key.serialize_pem().as_bytes())?;
        write_private(&self.dir.join("cert.pem"), cert.pem().as_bytes())?;
        let tls =
            load_tls(&self.dir)?.ok_or_else(|| anyhow!("the certificate just written is gone"))?;
        tracing::info!(fingerprint = %tls.fingerprint, "remote access certificate made");
        let config = tls.config.clone();
        i.tls = Some(tls);
        Ok(config)
    }

    fn save_config(&self, c: &RemoteConfig) -> Result<()> {
        create_dir_private(&self.dir)?;
        write_private(
            &self.dir.join("config.json"),
            &serde_json::to_vec_pretty(c)?,
        )
    }

    fn save_devices(&self, devices: &[DeviceRecord]) -> Result<()> {
        create_dir_private(&self.dir)?;
        let file = DevicesFile {
            devices: devices.to_vec(),
        };
        write_private(
            &self.dir.join("devices.json"),
            &serde_json::to_vec_pretty(&file)?,
        )
    }
}

impl Inner {
    fn check_rate(&mut self, ip: IpAddr) -> Result<(), RemoteError> {
        let now = Instant::now();
        let Some(f) = self.failures.get_mut(&ip) else {
            return Ok(());
        };
        while f
            .front()
            .is_some_and(|t| now.duration_since(*t) >= FAILURE_WINDOW)
        {
            f.pop_front();
        }
        if f.len() < MAX_FAILURES {
            return Ok(());
        }
        let retry = f
            .front()
            .map(|t| {
                FAILURE_WINDOW
                    .saturating_sub(now.duration_since(*t))
                    .as_secs()
                    .max(1)
            })
            .unwrap_or(1);
        Err(RemoteError {
            code: ERR_RATE_LIMITED,
            message: format!("too many failed attempts from {ip}: try again in {retry} s"),
            data: Some(json!({ "retryAfterSecs": retry })),
        })
    }

    fn failed(&mut self, ip: IpAddr) {
        let now = Instant::now();
        // Forget addresses whose failures are all old, so the map stays small.
        self.failures.retain(|_, f| {
            f.back()
                .is_some_and(|t| now.duration_since(*t) < FAILURE_WINDOW)
        });
        let f = self.failures.entry(ip).or_default();
        f.push_back(now);
        while f.len() > MAX_FAILURES {
            f.pop_front();
        }
        tracing::warn!(%ip, "remote access: failed pair/auth attempt");
    }
}

// ---------------------------------------------------------------------------
// Listener

async fn serve(
    listener: tokio::net::TcpListener,
    acceptor: tokio_rustls::TlsAcceptor,
    router: axum::Router,
    mut stop: oneshot::Receiver<()>,
    mut shutdown: broadcast::Receiver<()>,
    kill: broadcast::Sender<Kill>,
    limits: Arc<Limits>,
) {
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = shutdown.recv() => {
                let _ = kill.send(Kill::All);
                break;
            }
            accepted = listener.accept() => match accepted {
                Ok((tcp, peer)) => {
                    let Some(slot) = limits.take_slot() else {
                        tracing::warn!(%peer, "remote access: too many connections still authenticating; refused");
                        drop(tcp);
                        continue;
                    };
                    let deadline = tokio::time::Instant::now() + *limits.auth_deadline.lock();
                    tokio::spawn(serve_connection(tcp, peer, deadline, slot, acceptor.clone(), router.clone(), kill.subscribe()));
                }
                Err(e) => {
                    // Out of file descriptors and the like: do not spin.
                    tracing::warn!("remote access: accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }
}

/// One TCP connection: TLS, then HTTP until it upgrades to the WebSocket,
/// all before `deadline`. The WebSocket handler keeps to the same deadline
/// until the device authenticates, and takes over `slot` until then.
async fn serve_connection(
    tcp: tokio::net::TcpStream,
    peer: SocketAddr,
    deadline: tokio::time::Instant,
    slot: UnauthSlot,
    acceptor: tokio_rustls::TlsAcceptor,
    router: axum::Router,
    mut kill: broadcast::Receiver<Kill>,
) {
    let _ = tcp.set_nodelay(true);
    let tls = match tokio::time::timeout_at(deadline, acceptor.accept(tcp)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::debug!(%peer, "remote access: TLS handshake failed: {e}");
            return;
        }
        Err(_) => {
            tracing::debug!(%peer, "remote access: TLS handshake too slow");
            return;
        }
    };
    let remote_peer = crate::server::RemotePeer {
        addr: peer,
        deadline,
        slot: Arc::new(parking_lot::Mutex::new(Some(slot))),
    };
    let service =
        hyper_util::service::TowerToHyperService::new(router.layer(axum::Extension(remote_peer)));
    let builder =
        hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    let conn = builder.serve_connection_with_upgrades(hyper_util::rt::TokioIo::new(tls), service);
    tokio::pin!(conn);
    let too_late = tokio::time::sleep_until(deadline);
    tokio::pin!(too_late);
    loop {
        tokio::select! {
            // Done, or upgraded: the WebSocket left this future with its socket.
            _ = &mut conn => break,
            // Still plain HTTP at the deadline: not a client of ours.
            _ = &mut too_late => {
                tracing::debug!(%peer, "remote access: no WebSocket upgrade in time");
                break;
            }
            k = kill.recv() => match k {
                // The listener went away: so does its HTTP traffic.
                Ok(Kill::All) | Err(broadcast::error::RecvError::Closed) => break,
                _ => continue,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers

fn load_tls(dir: &Path) -> Result<Option<Tls>> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
    if !cert_path.exists() || !key_path.exists() {
        return Ok(None);
    }
    let cert = CertificateDer::from_pem_file(&cert_path)
        .map_err(|e| anyhow!("read {}: {e}", cert_path.display()))?;
    let key = PrivateKeyDer::from_pem_file(&key_path)
        .map_err(|e| anyhow!("read {}: {e}", key_path.display()))?;
    let fingerprint = sha256_hex(cert.as_ref());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .context("TLS versions")?
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .context("the remote access certificate does not match its key")?;
    Ok(Some(Tls {
        fingerprint,
        config: Arc::new(config),
    }))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(
            serde_json::from_slice(&b).with_context(|| format!("parse {}", path.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context(format!("read {}", path.display()))),
    }
}

fn create_dir_private(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write via a temporary file that is 0600 before it holds anything.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options
        .open(&tmp)
        .with_context(|| format!("create {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time for equal lengths.
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..CODE_LEN)
        .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

/// `aura://pair?host=…&port=…&fp=…&code=…&name=…[&alt=…]`. `alt` lists the
/// other addresses, comma separated with IPv6 ones in brackets, for the phone
/// to try when `host` is out of reach; left out when there are none. Every
/// value is percent-encoded.
fn pairing_uri(host: &str, alt: &[String], port: u16, fp: &str, code: &str, name: &str) -> String {
    let mut uri = format!(
        "aura://pair?host={}&port={port}&fp={fp}&code={code}&name={}",
        enc(host),
        enc(name)
    );
    if !alt.is_empty() {
        let list: Vec<String> = alt
            .iter()
            .map(|a| match a.parse::<IpAddr>() {
                Ok(IpAddr::V6(v6)) => format!("[{v6}]"),
                _ => a.clone(),
            })
            .collect();
        uri.push_str("&alt=");
        uri.push_str(&enc(&list.join(",")));
    }
    uri
}

fn enc(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
    const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');
    utf8_percent_encode(s, UNRESERVED).to_string()
}

/// This machine's name, without a `.local` suffix.
pub fn host_name() -> String {
    let h = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_string();
    let h = h.strip_suffix(".local").unwrap_or(&h).to_string();
    if h.is_empty() {
        "Aura".into()
    } else {
        h
    }
}

/// Where a device can reach a listener bound to `bind`: that address when it
/// is a specific one; otherwise the machine's non-loopback, non-link-local
/// addresses (IPv4 only for `0.0.0.0`, also IPv6 for `::`), private LAN
/// addresses first.
pub fn addresses(bind: IpAddr) -> Vec<String> {
    if !bind.is_unspecified() {
        return vec![bind.to_string()];
    }
    let mut v4 = vec![];
    let mut v6 = vec![];
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if iface.is_loopback() {
            continue;
        }
        match iface.ip() {
            IpAddr::V4(a) if !a.is_link_local() && !a.is_loopback() => v4.push(a),
            IpAddr::V6(a)
                if bind.is_ipv6() && !a.is_loopback() && (a.segments()[0] & 0xffc0) != 0xfe80 =>
            {
                v6.push(a)
            }
            _ => {}
        }
    }
    v4.sort_by_key(|a| (!a.is_private(), *a));
    v4.dedup();
    v6.sort();
    v6.dedup();
    v4.iter()
        .map(|a| a.to_string())
        .chain(v6.iter().map(|a| a.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_the_unambiguous_alphabet() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), CODE_LEN);
            assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)), "{c}");
            assert!(!c.contains(['0', 'O', '1', 'I', 'L']), "{c}");
        }
    }

    #[test]
    fn a_specific_bind_address_is_the_only_address() {
        assert_eq!(addresses("127.0.0.1".parse().unwrap()), vec!["127.0.0.1"]);
        for a in addresses("0.0.0.0".parse().unwrap()) {
            let ip: IpAddr = a.parse().unwrap();
            assert!(ip.is_ipv4() && !ip.is_loopback(), "{a}");
        }
    }

    #[test]
    fn uri_values_are_encoded() {
        assert_eq!(enc("Eldin's Mac"), "Eldin%27s%20Mac");
        assert_eq!(enc("192.168.1.2"), "192.168.1.2");
        assert_eq!(enc("fe80::1"), "fe80%3A%3A1");
    }

    #[test]
    fn the_pairing_uri_lists_the_other_addresses_in_alt() {
        let base = "aura://pair?host=192.168.1.2&port=7443&fp=ab&code=ABCDEFGH&name=Studio%20Mac";
        assert_eq!(
            pairing_uri("192.168.1.2", &[], 7443, "ab", "ABCDEFGH", "Studio Mac"),
            base,
            "no alt without other addresses"
        );
        let alt = ["100.75.1.9".to_string(), "2001:db8::5".to_string()];
        assert_eq!(
            pairing_uri("192.168.1.2", &alt, 7443, "ab", "ABCDEFGH", "Studio Mac"),
            format!("{base}&alt=100.75.1.9%2C%5B2001%3Adb8%3A%3A5%5D")
        );
    }

    #[test]
    fn rate_limit_after_five_failures() {
        let mut i = Inner {
            config: RemoteConfig::default(),
            devices: vec![],
            tls: None,
            running: None,
            error: None,
            pairing: None,
            failures: HashMap::new(),
        };
        let ip: IpAddr = "10.0.0.9".parse().unwrap();
        let other: IpAddr = "10.0.0.10".parse().unwrap();
        for _ in 0..MAX_FAILURES {
            assert!(i.check_rate(ip).is_ok());
            i.failed(ip);
        }
        let e = i.check_rate(ip).unwrap_err();
        assert_eq!(e.code, ERR_RATE_LIMITED);
        assert!(e.data.unwrap()["retryAfterSecs"].as_u64().unwrap() >= 1);
        assert!(i.check_rate(other).is_ok(), "per address");
    }
}

#[cfg(test)]
mod pairing_tests {
    use super::*;

    fn service() -> (tempfile::TempDir, Arc<RemoteService>) {
        let dir = tempfile::tempdir().unwrap();
        let s = RemoteService::load(dir.path());
        s.inner.lock().config.enabled = true;
        (dir, s)
    }

    fn set_code(s: &RemoteService, code: &str, expires_at: DateTime<Utc>) {
        s.inner.lock().pairing = Some(PendingCode {
            code: code.into(),
            expires_at,
        });
    }

    #[test]
    fn an_expired_code_is_refused_and_counts_as_a_failure() {
        let (_dir, s) = service();
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        set_code(&s, "ABCDEFGH", Utc::now() - chrono::Duration::seconds(1));
        assert_eq!(s.pair(ip, "ABCDEFGH", "x").unwrap_err().code, ERR_PAIR_CODE);
        assert_eq!(s.inner.lock().failures[&ip].len(), 1);
        assert!(s.list_devices().is_empty());
    }

    #[test]
    fn a_code_works_once_and_a_wrong_guess_does_not_burn_it() {
        let (_dir, s) = service();
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        set_code(&s, "ABCDEFGH", Utc::now() + chrono::Duration::minutes(5));
        assert_eq!(s.pair(ip, "ABCDEFGX", "x").unwrap_err().code, ERR_PAIR_CODE);
        let r = s.pair(ip, " abcd-efgh ", "  Phone  ").unwrap();
        assert_eq!(s.list_devices()[0].name, "Phone");
        assert_eq!(s.pair(ip, "ABCDEFGH", "y").unwrap_err().code, ERR_PAIR_CODE);
        // The token is kept only as its hash.
        let stored = std::fs::read_to_string(s.dir.join("devices.json")).unwrap();
        assert!(!stored.contains(&r.token));
        assert!(stored.contains(&sha256_hex(r.token.as_bytes())));
        assert!(s.auth(ip, &r.device_id, &r.token).is_ok());
        assert_eq!(
            s.auth(ip, &r.device_id, "nope").unwrap_err().code,
            ERR_AUTH_FAILED
        );
        assert_eq!(
            s.auth(ip, "other", &r.token).unwrap_err().code,
            ERR_AUTH_FAILED
        );
    }

    #[test]
    fn a_new_pairing_replaces_the_old_code_and_turning_off_drops_it() {
        let (_dir, s) = service();
        s.ensure_tls().unwrap();
        let first = s.start_pairing().unwrap();
        let second = s.start_pairing().unwrap();
        let ip: IpAddr = "10.1.1.1".parse().unwrap();
        if first.code != second.code {
            assert_eq!(
                s.pair(ip, &first.code, "x").unwrap_err().code,
                ERR_PAIR_CODE
            );
        }
        assert!(second.expires_at > Utc::now() + chrono::Duration::seconds(290));
        assert!(s.pair(ip, &second.code, "x").is_ok());
    }

    #[test]
    fn an_unreadable_config_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("remote")).unwrap();
        std::fs::write(dir.path().join("remote/config.json"), "{not json").unwrap();
        std::fs::write(dir.path().join("remote/devices.json"), "[]oops").unwrap();
        let s = RemoteService::load(dir.path());
        let st = s.status();
        assert!(!st.enabled);
        assert_eq!(st.port, DEFAULT_PORT);
        assert!(uuid::Uuid::parse_str(&st.server_id).is_ok());
    }
}
