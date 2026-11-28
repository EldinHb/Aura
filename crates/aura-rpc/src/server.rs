use crate::*;
use anyhow::{anyhow, Result};
use aura_core::*;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use base64::Engine;
use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

/// One call to an [`ExtHandler`].
#[derive(Debug, Clone)]
pub struct ExtCall {
    pub method: String,
    pub params: Value,
    /// The session whose tools made the call, when the connection holds a
    /// session token; None for the user (the app, the CLI).
    pub session: Option<String>,
    /// The connection proved it is Aura's own window: it presented the window
    /// secret (`daemon.window_hello`) that the desktop shell gave this daemon
    /// on stdin when it spawned it. Only such a connection may grant approvals.
    pub window: bool,
}

/// A fresh random secret (64 hex characters), for tokens and the window secret.
pub fn random_secret() -> String {
    random_token()
}

/// Constant-time comparison, so a wrong guess learns nothing from timing.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Extra method handler registered by the daemon (git, mods, etc.). Return
/// `Ok(None)` when the method is not yours.
pub type ExtHandler =
    Arc<dyn Fn(ExtCall) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;

/// An extension's error with a stable string code and optional data, sent to
/// the client as the error's `data: {code, data}`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ExtError {
    pub code: String,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Clone)]
pub struct AppState {
    pub manager: Manager,
    pub token: String,
    pub info: Arc<DaemonInfo>,
    pub ext: Option<ExtHandler>,
    pub notifications: Option<broadcast::Sender<Value>>,
    pub shutdown: broadcast::Sender<()>,
    /// The window secret, when the desktop shell spawned this daemon. Kept in
    /// memory only: never written to daemon.json, argv, the environment or a log.
    pub window_secret: Option<Arc<String>>,
    /// Remote access: the opt-in TLS listener for paired devices.
    pub remote: Arc<crate::remote::RemoteService>,
}

pub struct RpcServer {
    pub info: DaemonInfo,
    pub shutdown: broadcast::Sender<()>,
    /// Remote access (see [`crate::remote`]).
    pub remote: Arc<crate::remote::RemoteService>,
    handle: tokio::task::JoinHandle<()>,
}

impl RpcServer {
    /// Bind to a random loopback port, write `daemon.json`, serve.
    pub async fn start(
        manager: Manager,
        data_dir: &std::path::Path,
        ext: Option<ExtHandler>,
    ) -> Result<RpcServer> {
        Self::start_with_notifications(manager, data_dir, ext, None).await
    }

    pub async fn start_with_notifications(
        manager: Manager,
        data_dir: &std::path::Path,
        ext: Option<ExtHandler>,
        notifications: Option<broadcast::Sender<Value>>,
    ) -> Result<RpcServer> {
        Self::start_full(manager, data_dir, ext, notifications, None).await
    }

    /// Like [`start_with_notifications`](Self::start_with_notifications), with
    /// the window secret the desktop shell handed over (see [`AppState::window_secret`]).
    pub async fn start_full(
        manager: Manager,
        data_dir: &std::path::Path,
        ext: Option<ExtHandler>,
        notifications: Option<broadcast::Sender<Value>>,
        window_secret: Option<String>,
    ) -> Result<RpcServer> {
        std::fs::create_dir_all(data_dir)?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let info = DaemonInfo {
            port,
            token: token.clone(),
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            started_at: aura_core::now(),
            data_dir: data_dir.to_string_lossy().to_string(),
            birth: aura_core::process::process_birth(std::process::id()),
        };
        write_daemon_info(data_dir, &info)?;
        let (shutdown, _) = broadcast::channel(1);
        let state = AppState {
            manager,
            token,
            info: Arc::new(info.clone()),
            ext,
            notifications,
            shutdown: shutdown.clone(),
            window_secret: window_secret.map(Arc::new),
            remote: crate::remote::RemoteService::load(data_dir),
        };
        // Off unless the user turned it on; a failure shows in `remote.status`.
        state.remote.apply(&state).await;
        let remote = state.remote.clone();
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/healthz", get(|| async { "ok" }))
            .with_state(state);
        let mut rx = shutdown.subscribe();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.recv().await;
                })
                .await;
        });
        Ok(RpcServer {
            info,
            shutdown,
            remote,
            handle,
        })
    }

    pub async fn wait(self) {
        let _ = self.handle.await;
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn write_daemon_info(data_dir: &std::path::Path, info: &DaemonInfo) -> Result<()> {
    let path = daemon_info_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(info)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

/// Who a connection acts for, by the token it connected with.
#[derive(Debug, Clone)]
enum Caller {
    /// The daemon's own token, from `daemon.json`: the app, the CLI. The user.
    User,
    /// The token of one session's tools (`Manager::session_token`), which
    /// Aura hands that session's `aura mcp` and nobody else. Checked again
    /// on every request: once the daemon revokes it, the connection closes.
    Session { id: String, token: String },
    /// A connection to the remote listener: a paired device once it has
    /// paired or authenticated, nobody before that.
    Remote(Arc<RemoteConn>),
}

/// A connection to the remote listener, as the listener hands it to the
/// WebSocket handler.
#[derive(Debug, Clone)]
pub(crate) struct RemotePeer {
    pub addr: std::net::SocketAddr,
    /// When it must have authenticated, counted from the TCP accept: the TLS
    /// handshake, the upgrade and `remote.pair`/`remote.auth` all fit in it.
    pub deadline: tokio::time::Instant,
    /// Its place among the unauthenticated connections, given up once it
    /// authenticates (or when it closes).
    pub slot: Arc<parking_lot::Mutex<Option<crate::remote::UnauthSlot>>>,
}

#[derive(Debug)]
struct RemoteConn {
    peer: std::net::SocketAddr,
    /// The device it authenticated as; None until then.
    device: parking_lot::Mutex<Option<String>>,
    /// Closed if not authenticated by then.
    deadline: tokio::time::Instant,
    /// Held until it authenticates.
    slot: parking_lot::Mutex<Option<crate::remote::UnauthSlot>>,
    /// Its `session.git_*` reads running now (see [`REMOTE_GIT_READS_PER_CONNECTION`]).
    git_reads: Arc<tokio::sync::Semaphore>,
}

/// `session.git_*` reads one remote connection may run at once; more are
/// refused until one finishes.
const REMOTE_GIT_READS_PER_CONNECTION: usize = 2;
/// The same, for all remote connections together.
static REMOTE_GIT_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

impl RemoteConn {
    fn device(&self) -> Option<String> {
        self.device.lock().clone()
    }
}

/// Whether `caller` may call `method` with `params`. A session's tools may
/// only use the orchestrator's and feature owner's tools for that session,
/// or a team member's (`team.*`) for that worker, and read the agents;
/// nothing that is the user's (answers, settings, sessions, history, the
/// daemon's own token). The user's token cannot act as a session's tools.
/// Whom a team member may reach is up to the manager: its own team only.
fn authorize(caller: &Caller, method: &str, params: &Value) -> Result<(), DispatchError> {
    let session_tool = method.starts_with("owner.")
        || method.starts_with("team.")
        || (method.starts_with("orchestrator.") && method != "orchestrator.projects");
    let forbidden = |message: String| DispatchError {
        code: ERR_FORBIDDEN,
        message,
        data: None,
    };
    match caller {
        Caller::Remote(_) if crate::remote::REMOTE_ALLOWED_METHODS.contains(&method) => Ok(()),
        Caller::Remote(_) if method == "remote.pair" || method == "remote.auth" => Err(forbidden(
            "this connection is already authenticated".into(),
        )),
        Caller::Remote(_) => Err(forbidden(format!(
            "{method} is not available to remote devices; use Aura on the computer for it"
        ))),
        Caller::User if session_tool => Err(forbidden(format!(
            "{method} acts for a session's tools and needs that session's own session token, which Aura hands only to its `aura mcp`"
        ))),
        Caller::User => Ok(()),
        Caller::Session { id, .. } => {
            let acts_for = |key: &str| params.get(key).and_then(Value::as_str) == Some(id.as_str());
            let allowed = match method {
                "daemon.ping" | "provider.list" | "provider.models" | "orchestrator.projects" => true,
                // Closing remote access is anyone's; opening it is refused in
                // `dispatch` (see `remote.configure`).
                "remote.configure" | "remote.revokeDevice" => true,
                // Mods' orchestrator tools act for the calling session, which the host is told.
                "mods.tools.list" | "mods.tools.call" => true,
                m if m.starts_with("orchestrator.") => acts_for("orchestrator"),
                m if m.starts_with("owner.") => acts_for("owner"),
                m if m.starts_with("team.") => acts_for("worker"),
                _ => false,
            };
            if allowed {
                Ok(())
            } else {
                Err(forbidden(format!(
                    "{method} is not allowed: this connection holds the session token of {} and may only use that session's own tools",
                    &id[..id.len().min(8)]
                )))
            }
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let caller = match q.token.as_deref() {
        Some(t) if t == state.token => Caller::User,
        Some(t) => match state.manager.session_for_token(t) {
            Some(id) => Caller::Session {
                id,
                token: t.to_string(),
            },
            None => return (axum::http::StatusCode::UNAUTHORIZED, "bad token").into_response(),
        },
        None => return (axum::http::StatusCode::UNAUTHORIZED, "bad token").into_response(),
    };
    ws.max_message_size(64 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, caller))
        .into_response()
}

/// The remote listener's routes: the WebSocket at `/` (and `/ws`, as on
/// loopback). Who connects proves it with `remote.pair` / `remote.auth`.
pub(crate) fn remote_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(remote_ws_handler))
        .route("/ws", get(remote_ws_handler))
        .with_state(state)
}

async fn remote_ws_handler(
    ws: WebSocketUpgrade,
    axum::Extension(peer): axum::Extension<RemotePeer>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let conn = Arc::new(RemoteConn {
        peer: peer.addr,
        device: parking_lot::Mutex::new(None),
        deadline: peer.deadline,
        slot: parking_lot::Mutex::new(peer.slot.lock().take()),
        git_reads: Arc::new(tokio::sync::Semaphore::new(REMOTE_GIT_READS_PER_CONNECTION)),
    });
    // Images go as base64 in the message: 16 MB holds a few.
    ws.max_message_size(crate::remote::MAX_MESSAGE)
        .max_frame_size(crate::remote::MAX_MESSAGE)
        .on_upgrade(move |socket| handle_socket(socket, state, Caller::Remote(conn)))
}

/// `session.create` as a remote device may call it: what the desktop's
/// new-session dialog offers, an agent session in a known project, an
/// orchestrator or a feature owner (with no folder of its own if it likes).
/// No terminals, commands, resumed or forked sessions, workers of another
/// session, or worktree paths of its choosing.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteCreateSession {
    provider: ProviderKind,
    #[serde(default)]
    agent: Option<String>,
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    initial_prompt: Option<String>,
    #[serde(default)]
    worktree: Option<RemoteWorktree>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    sandbox_mode: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    /// Only `structured`: a terminal-mode session is a terminal.
    #[serde(default)]
    mode: Option<SessionMode>,
    #[serde(default)]
    orchestrator: bool,
    #[serde(default)]
    feature_owner: bool,
    #[serde(default)]
    feature_goal: Option<String>,
    #[serde(default)]
    autonomy: Option<Autonomy>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorktree {
    branch: String,
    #[serde(default)]
    base: Option<String>,
}

/// The read-only git methods a remote device has, for one session's folder.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteGitParams {
    id: String,
    /// One file, relative to the session's folder (passed after `--`).
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    staged: bool,
    /// A ref to diff against instead of HEAD (`main`, `origin/main`, `HEAD~3`).
    #[serde(default)]
    base: Option<String>,
}

/// Whether `r` is a plain ref name, which git cannot take for an option or a
/// range: letters, digits and `/ . _ - ~ ^`, not starting with `-`.
fn is_plain_ref(r: &str) -> bool {
    !r.is_empty()
        && !r.starts_with('-')
        && !r.contains("..")
        && r.len() <= 200
        && r.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-~^".contains(c))
}

/// `cwd` with every symlink resolved, when that lies in one of `projects`'
/// folders (resolved the same way) or is one; None otherwise, and for a
/// folder that does not exist. Touches the file system: call it off the
/// async runtime.
fn in_known_project(cwd: &str, projects: &[Project]) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    if !real.is_dir() {
        return None;
    }
    projects
        .iter()
        .filter_map(|p| std::fs::canonicalize(&p.path).ok())
        .any(|root| real.starts_with(&root))
        .then_some(real)
}

/// A remote device's request, once [`authorize`] let it through: four
/// methods are narrowed (see `REMOTE_ALLOWED_METHODS`), the rest is the
/// user's [`dispatch`].
async fn remote_dispatch(
    state: &AppState,
    conn: &RemoteConn,
    attached: &Arc<parking_lot::Mutex<HashSet<String>>>,
    req: Request,
    window: &std::sync::atomic::AtomicBool,
) -> Result<Value, DispatchError> {
    let forbidden = |message: String| DispatchError {
        code: ERR_FORBIDDEN,
        message,
        data: None,
    };
    match req.method.as_str() {
        // Without the loopback token, port and data directory.
        "daemon.info" => ok(json!({
            "version": state.info.version,
            "pid": state.info.pid,
            "started_at": state.info.started_at,
        })),
        // Images by value only: a path would have the daemon read any file
        // on this machine for the device (and keep it as an attachment).
        // A terminal-mode session's input is a shell (or a TUI) on this
        // machine: typing into it is not something a device may do.
        "session.send" | "session.interrupt" => {
            let IdParams { id } = params(&req.params)?;
            if state.manager.get_session(&id)?.mode == SessionMode::Terminal {
                return Err(forbidden(format!(
                    "{} is not available for terminal sessions from a remote device",
                    req.method
                )));
            }
            if req.method == "session.interrupt" {
                return dispatch(state, attached, req, None, window).await;
            }
            let by_path = req.params["input"]["images"]
                .as_array()
                .is_some_and(|images| images.iter().any(|i| !i["path"].is_null()));
            if by_path {
                return Err(forbidden(
                    "remote devices send images as `data` (base64), not as a `path` on this machine".into(),
                ));
            }
            dispatch(state, attached, req, None, window).await
        }
        // Read through aura_git::safe, never plain `git status`/`git diff`:
        // those run whatever the repository's config says (fsmonitor,
        // filters, diff drivers, hooks), and the repository is the agent's.
        "session.git_status" | "session.git_diff" | "session.git_diff_stat" => {
            let p: RemoteGitParams = params(&req.params)?;
            if let Some(base) = &p.base {
                if !is_plain_ref(base) {
                    return Err(forbidden(format!(
                        "`{base}` is not a ref a remote device may diff against"
                    )));
                }
            }
            if let Some(path) = &p.path {
                if aura_git::safe::check_path(path).is_err() {
                    return Err(forbidden(format!(
                        "`{path}` is not a plain path inside the session's folder (no `..`, no absolute path, no `:` pathspec magic)"
                    )));
                }
            }
            let busy = || {
                DispatchError {
                code: ERR_INTERNAL,
                message: format!(
                    "at most {REMOTE_GIT_READS_PER_CONNECTION} change reads at a time: try again when one has finished"
                ),
                data: Some(json!({"code": "busy"})),
            }
            };
            let _mine = conn
                .git_reads
                .clone()
                .try_acquire_owned()
                .map_err(|_| busy())?;
            let _all = REMOTE_GIT_READS.try_acquire().map_err(|_| busy())?;
            let session = state.manager.get_session(&p.id)?;
            // The session's own folder: its worktree when it has one. Nothing else.
            let cwd = session.worktree.map(|w| w.path).unwrap_or(session.cwd);
            let method = req.method.clone();
            let out =
                tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
                    let limits = aura_git::safe::Limits::default();
                    let dir = std::path::Path::new(&cwd);
                    // A folderless orchestrator has no changes of its own.
                    if cwd.is_empty() {
                        return Ok(match method.as_str() {
                            "session.git_diff" => json!(""),
                            "session.git_status" => json!(aura_git::safe::SafeStatus::default()),
                            _ => json!(aura_git::safe::SafeDiffStat::default()),
                        });
                    }
                    Ok(match method.as_str() {
                        "session.git_status" => {
                            serde_json::to_value(aura_git::safe::status(dir, &limits)?)?
                        }
                        "session.git_diff_stat" => serde_json::to_value(
                            aura_git::safe::diff_stat(dir, p.base.as_deref(), &limits)?,
                        )?,
                        _ => json!(
                            aura_git::safe::diff(
                                dir,
                                &aura_git::ops::DiffOpts {
                                    path: p.path,
                                    staged: p.staged,
                                    base: p.base
                                },
                                &limits,
                            )?
                            .text
                        ),
                    })
                })
                .await
                .map_err(|e| anyhow!(e))??;
            ok(out)
        }
        "session.create" => {
            let o: RemoteCreateSession = params(&req.params)?;
            if o.provider == ProviderKind::Terminal || o.mode == Some(SessionMode::Terminal) {
                return Err(forbidden(
                    "remote devices cannot start terminal sessions: pick claude, codex or acp"
                        .into(),
                ));
            }
            // An orchestrator (a feature owner is one) may have no folder:
            // the daemon makes one of its own for it, as for the desktop.
            let orchestrates = o.orchestrator || o.feature_owner;
            let folderless = orchestrates && o.cwd.is_empty();
            if folderless && o.worktree.is_some() {
                return Err(forbidden(
                    "a worktree needs a folder in a known project".into(),
                ));
            }
            let m = state.manager.clone();
            let cwd = o.cwd.clone();
            let real = if folderless {
                Some(std::path::PathBuf::new())
            } else {
                tokio::task::spawn_blocking(move || {
                    m.projects()
                        .map(|projects| in_known_project(&cwd, &projects))
                })
                .await
                .map_err(|e| anyhow!(e))??
            };
            // The worktree's folder is named after the branch.
            if let Some(w) = &o.worktree {
                let b = w.branch.trim();
                if b.is_empty() || b.contains("..") || b.starts_with(['/', '\\', '-']) {
                    return Err(forbidden(format!(
                        "`{}` is not a branch name a remote device may use",
                        w.branch
                    )));
                }
            }
            let Some(real) = real else {
                return Err(forbidden(format!(
                    "`{}` is not a folder in a known project: pick a path from orchestrator.projects",
                    o.cwd
                )));
            };
            let opts = CreateSessionOpts {
                provider: o.provider,
                agent: o.agent,
                // Resolved: what was checked is where it runs.
                cwd: real.to_string_lossy().into_owned(),
                title: o.title,
                workspace: o.workspace,
                model: o.model,
                effort: o.effort,
                permission_mode: o.permission_mode,
                initial_prompt: o.initial_prompt,
                worktree: o.worktree.map(|w| WorktreeOpts {
                    branch: w.branch,
                    base: w.base,
                    path: None,
                }),
                group: o.group,
                sandbox_mode: o.sandbox_mode,
                system_prompt: o.system_prompt,
                mode: Some(SessionMode::Structured),
                orchestrator: orchestrates,
                feature_owner: o.feature_owner,
                feature_goal: o.feature_goal,
                autonomy: o.autonomy,
                ..Default::default()
            };
            ok(state.manager.create_session(opts).await?)
        }
        _ => dispatch(state, attached, req, None, window).await,
    }
}

/// Core events to one connection, as `event` notifications.
fn spawn_event_feed(state: &AppState, ev_tx: mpsc::Sender<Message>) -> tokio::task::JoinHandle<()> {
    let mut events = state.manager.subscribe();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    let n = Notification {
                        method: "event".into(),
                        params: serde_json::to_value(&ev).unwrap_or(Value::Null),
                    };
                    if ev_tx
                        .send(Message::Text(serde_json::to_string(&n).unwrap()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("client lagged {n} events");
                    let n = Notification {
                        method: "lagged".into(),
                        params: json!({ "count": n }),
                    };
                    let _ = ev_tx
                        .send(Message::Text(serde_json::to_string(&n).unwrap()))
                        .await;
                }
                Err(_) => break,
            }
        }
    })
}

fn response(id: Value, result: Result<Value, DispatchError>) -> Message {
    let resp = match result {
        Ok(v) => Response {
            id,
            result: Some(v),
            error: None,
        },
        Err(e) => Response {
            id,
            result: None,
            error: Some(RpcError {
                code: e.code,
                message: e.message,
                data: e.data,
            }),
        },
    };
    Message::Text(serde_json::to_string(&resp).unwrap())
}

/// Resolves when a remote connection has to close: its device was revoked,
/// the listener stopped, or it did not authenticate in time. Never for
/// other connections.
async fn remote_closed(
    conn: Option<&Arc<RemoteConn>>,
    kill: &mut Option<broadcast::Receiver<crate::remote::Kill>>,
) {
    let (Some(conn), Some(kill)) = (conn, kill.as_mut()) else {
        return std::future::pending().await;
    };
    let deadline = async {
        if conn.device().is_some() {
            std::future::pending::<()>().await
        } else {
            tokio::time::sleep_until(conn.deadline).await
        }
    };
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                tracing::info!(peer = %conn.peer, "remote client did not authenticate in time");
                return;
            }
            k = kill.recv() => match k {
                Ok(crate::remote::Kill::All) | Err(broadcast::error::RecvError::Closed) => return,
                Ok(crate::remote::Kill::Device(d)) if conn.device().as_deref() == Some(d.as_str()) => return,
                _ => continue,
            }
        }
    }
}

/// A request on a remote connection that has not authenticated: only
/// `remote.pair` and `remote.auth` work. Returns the answer and whether the
/// connection is now authenticated; anything else closes it.
fn remote_pre_auth(
    state: &AppState,
    conn: &RemoteConn,
    req: &Request,
) -> (Result<Value, DispatchError>, bool) {
    let ip = conn.peer.ip();
    let refused = |e: crate::remote::RemoteError| DispatchError {
        code: e.code,
        message: e.message,
        data: e.data,
    };
    let result = match req.method.as_str() {
        "remote.pair" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                code: String,
                #[serde(default)]
                device_name: String,
            }
            params::<P>(&req.params).and_then(|P { code, device_name }| {
                let r = state
                    .remote
                    .pair(ip, &code, &device_name)
                    .map_err(refused)?;
                *conn.device.lock() = Some(r.device_id.clone());
                conn.slot.lock().take();
                ok(r)
            })
        }
        "remote.auth" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                device_id: String,
                token: String,
            }
            params::<P>(&req.params).and_then(|P { device_id, token }| {
                let r = state.remote.auth(ip, &device_id, &token).map_err(refused)?;
                *conn.device.lock() = Some(device_id);
                conn.slot.lock().take();
                ok(r)
            })
        }
        other => Err(DispatchError {
            code: ERR_NOT_AUTHENTICATED,
            message: format!("{other} needs authentication: call remote.pair or remote.auth first"),
            data: None,
        }),
    };
    let authed = result.is_ok();
    (result, authed)
}

async fn handle_socket(socket: WebSocket, state: AppState, caller: Caller) {
    // Set once this connection presents the window secret (`daemon.window_hello`).
    let window = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // A session's tools get answers only: no events, notifications or
    // terminal output of the user's sessions. A remote device gets events
    // once it has authenticated, and never terminal output.
    let user = matches!(caller, Caller::User);
    let remote = match &caller {
        Caller::Remote(c) => Some(c.clone()),
        _ => None,
    };
    match &remote {
        Some(c) => tracing::info!(peer = %c.peer, "remote client connected"),
        None => tracing::info!("rpc client connected"),
    }
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(4096);
    let attached: Arc<parking_lot::Mutex<HashSet<String>>> = Default::default();

    // Writer task.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Event fan-out.
    let mut ev_task = user.then(|| spawn_event_feed(&state, out_tx.clone()));

    let extra_task = state.notifications.as_ref().filter(|_| user).map(|sender| {
        let mut rx = sender.subscribe();
        let tx = out_tx.clone();
        tokio::spawn(async move {
            loop {
                let notification = match rx.recv().await {
                    Ok(value) => value,
                    // Notifications were dropped: clients refresh what they show.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        json!({"method":"notifications.lagged","params":{}})
                    }
                    Err(_) => break,
                };
                if tx
                    .send(Message::Text(notification.to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        })
    });

    // PTY output fan-out (only attached sessions).
    let mut pty = state.manager.subscribe_pty();
    let pty_tx = out_tx.clone();
    let attached2 = attached.clone();
    let pty_task = user.then(|| {
        tokio::spawn(async move {
            loop {
                match pty.recv().await {
                    Ok(chunk) => {
                        if !attached2.lock().contains(&chunk.session_id) {
                            continue;
                        }
                        let frame =
                            encode_pty_frame(FRAME_PTY_OUTPUT, &chunk.session_id, &chunk.data);
                        if pty_tx.send(Message::Binary(frame)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        })
    });

    let mut kill = remote.as_ref().map(|_| state.remote.subscribe_kill());
    loop {
        let msg = tokio::select! {
            m = stream.next() => match m {
                Some(Ok(m)) => m,
                _ => break,
            },
            _ = remote_closed(remote.as_ref(), &mut kill) => break,
        };
        // Before authentication only a small pair/auth request makes sense:
        // anything bigger is not a client of ours.
        if remote.as_ref().is_some_and(|c| c.device().is_none()) {
            let size = match &msg {
                Message::Text(t) => t.len(),
                Message::Binary(b) => b.len(),
                _ => 0,
            };
            if size > crate::remote::MAX_PRE_AUTH_MESSAGE {
                tracing::warn!(
                    size,
                    "remote client sent a large message before authenticating; closing"
                );
                break;
            }
        }
        match msg {
            Message::Text(text) => {
                let req: Request = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp = Response {
                            id: Value::Null,
                            result: None,
                            error: Some(RpcError {
                                code: ERR_PARSE,
                                message: e.to_string(),
                                data: None,
                            }),
                        };
                        let _ = out_tx
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                        continue;
                    }
                };
                if let Some(conn) = &remote {
                    match conn.device() {
                        // Not authenticated: handled here, in order, so
                        // nothing else runs before it succeeds.
                        None => {
                            let (result, authed) = remote_pre_auth(&state, conn, &req);
                            if authed {
                                // Subscribed before the answer goes out, so
                                // the client misses no event after it.
                                ev_task = Some(spawn_event_feed(&state, out_tx.clone()));
                                tracing::info!(peer = %conn.peer, device = ?conn.device(), "remote client authenticated");
                            }
                            let _ = out_tx
                                .send(response(req.id.unwrap_or(Value::Null), result))
                                .await;
                            if authed {
                                continue;
                            }
                            break;
                        }
                        // Revoked since: the connection ends.
                        Some(device) if !state.remote.device_exists(&device) => {
                            let _ = out_tx
                                .send(response(
                                    req.id.unwrap_or(Value::Null),
                                    Err(DispatchError {
                                        code: ERR_AUTH_FAILED,
                                        message: "this device was revoked: pair it again".into(),
                                        data: None,
                                    }),
                                ))
                                .await;
                            break;
                        }
                        Some(_) => {}
                    }
                }
                // A revoked token (its session deleted or no longer
                // orchestrating) ends the connection, whatever it asks.
                if let Caller::Session { id, token } = &caller {
                    if state.manager.session_for_token(token).as_deref() != Some(id.as_str()) {
                        if let Some(rid) = req.id {
                            let resp = Response {
                                id: rid,
                                result: None,
                                error: Some(RpcError {
                                    code: ERR_FORBIDDEN,
                                    message: "this session token was revoked: its session was deleted or stopped orchestrating".into(),
                                    data: None,
                                }),
                            };
                            let _ = out_tx
                                .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                                .await;
                        }
                        break;
                    }
                }
                let state = state.clone();
                let out = out_tx.clone();
                let attached = attached.clone();
                let caller = caller.clone();
                let window = window.clone();
                tokio::spawn(async move {
                    let id = req.id.clone();
                    let result = match authorize(&caller, &req.method, &req.params) {
                        Ok(()) => match &caller {
                            Caller::Remote(conn) => {
                                remote_dispatch(&state, conn, &attached, req, &window).await
                            }
                            Caller::Session { id, .. } => {
                                dispatch(&state, &attached, req, Some(id.clone()), &window).await
                            }
                            Caller::User => dispatch(&state, &attached, req, None, &window).await,
                        },
                        Err(e) => Err(e),
                    };
                    if let Some(id) = id {
                        let _ = out.send(response(id, result)).await;
                    }
                });
            }
            // Never from a remote device: it gets no terminal.
            Message::Binary(frame) if user => {
                if let Some((FRAME_PTY_INPUT, sid, data)) = decode_pty_frame(&frame) {
                    if let Err(e) = state.manager.pty_input(&sid, data) {
                        tracing::debug!("pty input failed: {e}");
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    if let Some(task) = extra_task {
        task.abort();
    }
    for task in [ev_task, pty_task].into_iter().flatten() {
        task.abort();
    }
    if remote.is_some() {
        let _ = out_tx.send(Message::Close(None)).await;
    }
    drop(out_tx);
    let _ = writer.await;
    match &remote {
        Some(c) => tracing::info!(peer = %c.peer, "remote client disconnected"),
        None => tracing::info!("rpc client disconnected"),
    }
}

struct DispatchError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl From<anyhow::Error> for DispatchError {
    fn from(e: anyhow::Error) -> Self {
        // An extension's error with a code of its own (a mod's) keeps it, in `data`.
        if let Some(x) = e.downcast_ref::<ExtError>() {
            return DispatchError {
                code: ERR_INTERNAL,
                message: x.message.clone(),
                data: Some(json!({"code": x.code, "data": x.data})),
            };
        }
        DispatchError {
            code: ERR_INTERNAL,
            message: format!("{e:#}"),
            data: None,
        }
    }
}

fn params<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, DispatchError> {
    serde_json::from_value(v.clone()).map_err(|e| DispatchError {
        code: ERR_PARAMS,
        message: e.to_string(),
        data: None,
    })
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, DispatchError> {
    serde_json::to_value(v).map_err(|e| DispatchError {
        code: ERR_INTERNAL,
        message: e.to_string(),
        data: None,
    })
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

async fn dispatch(
    state: &AppState,
    attached: &Arc<parking_lot::Mutex<HashSet<String>>>,
    req: Request,
    session: Option<String>,
    window: &std::sync::atomic::AtomicBool,
) -> Result<Value, DispatchError> {
    let m = &state.manager;
    let p = &req.params;
    let b64 = base64::engine::general_purpose::STANDARD;
    match req.method.as_str() {
        "daemon.info" => ok(&*state.info),
        // The desktop shell's webview proves it is Aura's window. The secret
        // reached this daemon on stdin from the shell that spawned it and
        // reaches the webview over Tauri IPC; nothing else has it. A daemon
        // started any other way (by `aura`, or by an earlier app) has none,
        // and then nothing can grant approvals until the app restarts it.
        //
        // What this does not stop: a program running as the same user that
        // reads this process's memory (a debugger), or that starts its own
        // aurad with a secret of its choosing, or that writes Aura's database
        // directly. Those can do anything the user can; this keeps an agent
        // running `aura` commands, or a forged connection with only the token
        // from daemon.json, from approving on the user's behalf.
        "daemon.window_hello" => {
            if session.is_some() {
                return Err(DispatchError {
                    code: ERR_FORBIDDEN,
                    message: "only the user's connection may say hello".into(),
                    data: None,
                });
            }
            let Some(secret) = &state.window_secret else {
                return Err(DispatchError {
                    code: ERR_FORBIDDEN,
                    message: "this daemon was not started by the Aura app, so no window can approve here; restart it from the app".into(),
                    data: None,
                });
            };
            let given = p.get("secret").and_then(Value::as_str).unwrap_or("");
            if !same_secret(given, secret) {
                return Err(DispatchError {
                    code: ERR_FORBIDDEN,
                    message: "wrong window secret".into(),
                    data: None,
                });
            }
            window.store(true, std::sync::atomic::Ordering::SeqCst);
            ok(json!({"window": true}))
        }
        "daemon.window_status" => ok(json!({
            "secretSet": state.window_secret.is_some(),
            "window": window.load(std::sync::atomic::Ordering::SeqCst),
        })),
        "daemon.ping" => ok("pong"),
        "remote.pair" | "remote.auth" => Err(DispatchError {
            code: ERR_FORBIDDEN,
            message: format!(
                "{} is for devices on the remote listener, not this connection",
                req.method
            ),
            data: None,
        }),
        // Remote access management: the user's, on this machine. Remote
        // devices and session tools never get here (see `authorize`).
        "remote.status" => ok(state.remote.status()),
        "remote.configure" => {
            let change: crate::remote::RemoteConfigure = params(p)?;
            // An agent must not open this machine to the network: a
            // session's tools may only turn remote access off.
            if session.is_some()
                && (change.enabled == Some(true)
                    || change.bind_address.is_some()
                    || change.port.is_some())
            {
                return Err(DispatchError {
                    code: ERR_FORBIDDEN,
                    message: "a session's tools may turn remote access off, not on or move it; the user does that in Aura".into(),
                    data: None,
                });
            }
            ok(state.remote.configure(state, change).await?)
        }
        "remote.startPairing" => {
            // Unreachable for session tokens (see `authorize`); kept here too
            // so a change there cannot let an agent pair a device.
            if session.is_some() {
                return Err(DispatchError {
                    code: ERR_FORBIDDEN,
                    message: "a session's tools may not pair devices".into(),
                    data: None,
                });
            }
            ok(state.remote.start_pairing()?)
        }
        "remote.listDevices" => ok(state.remote.list_devices()),
        "remote.revokeDevice" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                device_id: String,
            }
            let P { device_id } = params(p)?;
            state.remote.revoke_device(&device_id)?;
            ok(true)
        }
        "daemon.shutdown" => {
            let _ = state.shutdown.send(());
            ok(true)
        }
        "provider.list" => ok(m.providers().await),
        "provider.native_sessions" => {
            #[derive(Deserialize)]
            struct P {
                provider: ProviderKind,
            }
            let P { provider } = params(p)?;
            ok(m.list_native(provider).await?)
        }
        "provider.models" => {
            #[derive(Deserialize)]
            struct P {
                provider: ProviderKind,
            }
            let P { provider } = params(p)?;
            ok(m.list_models(provider).await?)
        }
        "provider.commands" => {
            #[derive(Deserialize)]
            struct P {
                provider: ProviderKind,
                #[serde(default)]
                cwd: String,
            }
            let P { provider, cwd } = params(p)?;
            ok(m.list_commands(provider, &cwd).await?)
        }
        "session.list" => ok(m.list_sessions()),
        "session.get" => {
            let IdParams { id } = params(p)?;
            ok(m.get_session(&id)?)
        }
        "session.create" => {
            let opts: CreateSessionOpts = params(p)?;
            ok(m.create_session(opts).await?)
        }
        "session.fork" => {
            let IdParams { id } = params(p)?;
            ok(m.fork(&id).await?)
        }
        "session.send" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                input: Input,
            }
            let P { id, input } = params(p)?;
            m.send(&id, input).await?;
            ok(true)
        }
        "session.interrupt" => {
            let IdParams { id } = params(p)?;
            m.interrupt(&id).await?;
            ok(true)
        }
        "session.respond_approval" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                approval_id: String,
                decision: ApprovalDecision,
            }
            let P {
                id,
                approval_id,
                decision,
            } = params(p)?;
            m.respond_approval(&id, &approval_id, decision).await?;
            ok(true)
        }
        "session.respond_input" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                response: UserInputResponse,
            }
            let P { id, response } = params(p)?;
            m.respond_input(&id, response).await?;
            ok(true)
        }
        "session.set" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                setting: Setting,
            }
            let P { id, setting } = params(p)?;
            m.set(&id, setting).await?;
            ok(true)
        }
        "session.action" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                name: String,
                #[serde(default)]
                params: Value,
            }
            let P {
                id,
                name,
                params: ap,
            } = params(p)?;
            ok(m.action(&id, &name, ap).await?)
        }
        "session.clear_notices" => {
            #[derive(Deserialize)]
            struct P {
                id: Option<String>,
            }
            let P { id } = params(p)?;
            m.clear_notices(id.as_deref())?;
            ok(true)
        }
        "session.set_orchestrator" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                on: bool,
            }
            let P { id, on } = params(p)?;
            ok(m.set_orchestrator(&id, on).await?)
        }
        "orchestrator.start" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                #[serde(flatten)]
                spec: WorkerSpec,
            }
            let P { orchestrator, spec } = params(p)?;
            ok(m.start_worker(&orchestrator, spec).await?)
        }
        "orchestrator.send" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                worker: String,
                text: String,
            }
            let P {
                orchestrator,
                worker,
                text,
            } = params(p)?;
            ok(m.message_worker(&orchestrator, &worker, text).await?)
        }
        "orchestrator.workers" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
            }
            let P { orchestrator } = params(p)?;
            ok(m.worker_reports(&orchestrator)?)
        }
        "orchestrator.read" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                worker: String,
                #[serde(default)]
                turns: Option<usize>,
            }
            let P {
                orchestrator,
                worker,
                turns,
            } = params(p)?;
            ok(m.worker_transcript(&orchestrator, &worker, turns.unwrap_or(1))?)
        }
        "orchestrator.wait" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                #[serde(default)]
                workers: Vec<String>,
                #[serde(default)]
                any: bool,
                #[serde(default)]
                timeout_secs: Option<u64>,
            }
            let P {
                orchestrator,
                workers,
                any,
                timeout_secs,
            } = params(p)?;
            let timeout =
                std::time::Duration::from_secs(timeout_secs.unwrap_or(600).clamp(1, 3600));
            ok(m.wait_workers(&orchestrator, &workers, any, timeout)
                .await?)
        }
        "orchestrator.interrupt" | "orchestrator.stop" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                worker: String,
            }
            let P {
                orchestrator,
                worker,
            } = params(p)?;
            if req.method == "orchestrator.stop" {
                m.stop_worker(&orchestrator, &worker).await?;
            } else {
                m.interrupt_worker(&orchestrator, &worker).await?;
            }
            ok(true)
        }
        "orchestrator.delete" => {
            #[derive(Deserialize)]
            struct P {
                orchestrator: String,
                worker: String,
            }
            let P {
                orchestrator,
                worker,
            } = params(p)?;
            ok(m.delete_worker(&orchestrator, &worker).await?)
        }
        "orchestrator.projects" => {
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || m.projects())
                .await
                .map_err(|e| anyhow!(e))??)
        }
        "owner.specialists" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                #[serde(default)]
                cwd: Option<String>,
            }
            let P { owner, cwd } = params(p)?;
            let o = m.feature_owner_session(&owner)?;
            let dir = cwd
                .filter(|c| !c.trim().is_empty())
                .map(|c| m.worker_cwd(&o, Some(&c)))
                .transpose()?
                .or_else(|| (!o.folderless).then(|| o.cwd.clone()));
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || match dir {
                Some(d) => m.specialists_for_dir(&d),
                None => m.specialists(None),
            })
            .await
            .map_err(|e| anyhow!(e))??)
        }
        "owner.hire" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                #[serde(flatten)]
                spec: HireSpec,
            }
            let P { owner, spec } = params(p)?;
            ok(m.hire(&owner, spec).await?)
        }
        "owner.ask_user" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                #[serde(flatten)]
                ask: AskSpec,
            }
            let P { owner, ask } = params(p)?;
            ok(m.ask_user(&owner, ask)?)
        }
        "owner.record_decision" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                decision: String,
                #[serde(default)]
                rationale: String,
                #[serde(default)]
                meeting: Option<String>,
            }
            let P {
                owner,
                decision,
                rationale,
                meeting,
            } = params(p)?;
            ok(m.record_decision(&owner, &decision, &rationale, meeting.as_deref())?)
        }
        "owner.hold_meeting" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                #[serde(flatten)]
                spec: MeetingSpec,
            }
            let P { owner, spec } = params(p)?;
            ok(m.hold_meeting(&owner, spec).await?)
        }
        "owner.continue_meeting" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                meeting: String,
                #[serde(default)]
                steer: String,
            }
            let P {
                owner,
                meeting,
                steer,
            } = params(p)?;
            ok(m.continue_meeting(&owner, &meeting, &steer)?)
        }
        "owner.close_meeting" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                meeting: String,
                #[serde(default)]
                outcome: String,
            }
            let P {
                owner,
                meeting,
                outcome,
            } = params(p)?;
            ok(m.close_meeting(&owner, &meeting, &outcome)?)
        }
        "owner.suggest_specialists" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
            }
            let P { owner } = params(p)?;
            ok(m.suggest_specialists(Some(&owner)).await?)
        }
        "owner.reply_to_teammate" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                question: String,
                answer: String,
            }
            let P {
                owner,
                question,
                answer,
            } = params(p)?;
            ok(m.reply_to_teammate(&owner, &question, &answer)?)
        }
        "team.list" => {
            #[derive(Deserialize)]
            struct P {
                worker: String,
            }
            let P { worker } = params(p)?;
            ok(m.team_for(&worker)?)
        }
        "team.ask" => {
            #[derive(Deserialize)]
            struct P {
                worker: String,
                to: String,
                question: String,
            }
            let P {
                worker,
                to,
                question,
            } = params(p)?;
            ok(m.ask_teammate(&worker, &to, &question)?)
        }
        "team.ask_owner" => {
            #[derive(Deserialize)]
            struct P {
                worker: String,
                question: String,
            }
            let P { worker, question } = params(p)?;
            ok(m.ask_owner(&worker, &question)?)
        }
        "owner.checkpoint" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                checkpoint: String,
                #[serde(default)]
                summary: String,
            }
            let P {
                owner,
                checkpoint,
                summary,
            } = params(p)?;
            let c = Checkpoint::parse(&checkpoint).ok_or_else(|| {
                anyhow!("unknown checkpoint `{checkpoint}`: use `after_design`, `before_implementation` or `before_delivery`")
            })?;
            ok(m.checkpoint(&owner, c, &summary)?)
        }
        "owner.deliver_report" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                #[serde(flatten)]
                report: ReportSpec,
            }
            let P { owner, report } = params(p)?;
            ok(m.deliver_report(&owner, report)?)
        }
        "owner.propose_specialist" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
                specialist: SpecialistInput,
                #[serde(default)]
                reason: String,
            }
            let P {
                owner,
                specialist,
                reason,
            } = params(p)?;
            ok(m.propose_specialist(&owner, specialist, &reason)?)
        }
        "owner.status" => {
            #[derive(Deserialize)]
            struct P {
                owner: String,
            }
            let P { owner } = params(p)?;
            m.feature_owner_session(&owner)?;
            let f = m.feature(&owner)?;
            let autonomy = m.effective_autonomy(&f);
            let meeting_mode = m.effective_meeting_mode(&f);
            ok(json!({ "feature": f, "autonomy": autonomy, "meeting_mode": meeting_mode }))
        }
        "feature.get" => {
            let IdParams { id } = params(p)?;
            ok(m.feature(&id)?)
        }
        "feature.list" => ok(m.features()?),
        "feature.answer" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                question: String,
                #[serde(default)]
                option: Option<String>,
                #[serde(default)]
                text: String,
            }
            let P {
                id,
                question,
                option,
                text,
            } = params(p)?;
            ok(m.answer_question(&id, &question, option, text)?)
        }
        "feature.resolve_suggestion" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                suggestion: String,
                accept: bool,
                #[serde(default)]
                specialist: Option<SpecialistInput>,
            }
            let P {
                id,
                suggestion,
                accept,
                specialist,
            } = params(p)?;
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || {
                m.resolve_suggestion(&id, &suggestion, accept, specialist)
            })
            .await
            .map_err(|e| anyhow!(e))??)
        }
        "feature.set_autonomy" => {
            /// `autonomy: null` follows the setting for every feature owner again.
            #[derive(Deserialize)]
            struct P {
                id: String,
                autonomy: Option<Autonomy>,
            }
            let P { id, autonomy } = params(p)?;
            ok(m.set_feature_autonomy(&id, autonomy).await?)
        }
        "autonomy.get" => ok(m.autonomy()?),
        "autonomy.set" => ok(m.set_autonomy(params(p)?).await?),
        "feature.set_meeting_mode" => {
            /// `mode: null` follows the setting for every feature owner again.
            #[derive(Deserialize)]
            struct P {
                id: String,
                mode: Option<MeetingMode>,
            }
            let P { id, mode } = params(p)?;
            ok(m.set_feature_meeting_mode(&id, mode).await?)
        }
        "meetings.get" => ok(m.meeting_settings()),
        "meetings.set" => ok(m.set_meeting_settings(params(p)?).await?),
        "suggestions.settings" => ok(m.suggestion_settings()),
        "suggestions.set_settings" => ok(m.set_suggestion_settings(params(p)?)?),
        "suggestions.list" => ok(m.role_suggestions()?),
        "suggestions.run" => {
            /// With `owner`, the suggestions also show in that feature owner's chat.
            #[derive(Deserialize)]
            struct P {
                #[serde(default)]
                owner: Option<String>,
            }
            let P { owner } = params(p)?;
            ok(m.suggest_specialists(owner.as_deref()).await?)
        }
        "suggestions.resolve" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                accept: bool,
                #[serde(default)]
                specialist: Option<SpecialistInput>,
            }
            let P {
                id,
                accept,
                specialist,
            } = params(p)?;
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || {
                m.resolve_role_suggestion(&id, accept, specialist)
            })
            .await
            .map_err(|e| anyhow!(e))??)
        }
        "specialists.list" => {
            /// Without `project`, the global specialists; with one, those
            /// that apply there: its own and the global ones it does not override.
            #[derive(Deserialize)]
            struct P {
                #[serde(default)]
                project: Option<String>,
            }
            let P { project } = params(p)?;
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || {
                let root = project
                    .filter(|p| !p.trim().is_empty())
                    .map(|p| m.project_root(&p));
                m.specialists(root.as_deref())
            })
            .await
            .map_err(|e| anyhow!(e))??)
        }
        "specialists.hidden" => ok(m.hidden_specialists()?),
        "specialists.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                project: Option<String>,
            }
            let P { id, project } = params(p)?;
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || {
                let root = project
                    .filter(|p| !p.trim().is_empty())
                    .map(|p| m.project_root(&p));
                m.specialist(&id, root.as_deref())
            })
            .await
            .map_err(|e| anyhow!(e))??)
        }
        "specialists.save" => {
            let input: SpecialistInput = params(p)?;
            let m = m.clone();
            ok(
                tokio::task::spawn_blocking(move || m.save_specialist(input))
                    .await
                    .map_err(|e| anyhow!(e))??,
            )
        }
        "specialists.delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                scope: SpecialistScope,
                #[serde(default)]
                project: Option<String>,
            }
            let P { id, scope, project } = params(p)?;
            let m = m.clone();
            tokio::task::spawn_blocking(move || {
                m.delete_specialist(&id, scope, project.as_deref())
            })
            .await
            .map_err(|e| anyhow!(e))??;
            ok(true)
        }
        "specialists.reset" => {
            let IdParams { id } = params(p)?;
            ok(m.reset_specialist(&id)?)
        }
        "session.rename" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                title: String,
            }
            let P { id, title } = params(p)?;
            ok(m.rename(&id, &title)?)
        }
        "session.set_system_prompt" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                prompt: Option<String>,
            }
            let P { id, prompt } = params(p)?;
            ok(m.set_session_prompt(&id, prompt).await?)
        }
        "prompts.get" => ok(m.system_prompts()?),
        "prompts.set_global" => {
            /// `prompt: null` goes back to Aura's default.
            #[derive(Deserialize)]
            struct P {
                prompt: Option<String>,
            }
            let P { prompt } = params(p)?;
            ok(m.set_global_prompt(prompt).await?)
        }
        "prompts.set_agent" => {
            #[derive(Deserialize)]
            struct P {
                agent: String,
                prompt: Option<String>,
            }
            let P { agent, prompt } = params(p)?;
            ok(m.set_agent_prompt(&agent, prompt).await?)
        }
        "load_balancer.get" => ok(m.load_balancer()?),
        "load_balancer.set" => ok(m.set_load_balancer(params(p)?).await?),
        "prompts.preview" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let P { id } = params(p)?;
            let s = m.get_session(&id)?;
            ok(m.instructions_for(&s)?)
        }
        "session.set_group" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                group: Option<String>,
            }
            let P { id, group } = params(p)?;
            ok(m.set_group(&id, group)?)
        }
        "group.list" => ok(m.list_groups()?),
        "group.for_dir" => {
            #[derive(Deserialize)]
            struct P {
                cwd: String,
            }
            let P { cwd } = params(p)?;
            let m = m.clone();
            ok(tokio::task::spawn_blocking(move || m.group_for_dir(&cwd))
                .await
                .map_err(|e| anyhow!(e))??)
        }
        "group.delete" => {
            #[derive(Deserialize)]
            struct P {
                name: String,
            }
            let P { name } = params(p)?;
            m.delete_group(&name)?;
            ok(true)
        }
        "workspace.list" => ok(m.list_workspaces()?),
        "workspace.create" => {
            #[derive(Deserialize)]
            struct P {
                name: String,
            }
            let P { name } = params(p)?;
            ok(m.create_workspace(&name)?)
        }
        "workspace.rename" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                name: String,
            }
            let P { id, name } = params(p)?;
            ok(m.rename_workspace(&id, &name)?)
        }
        "workspace.delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                move_to: Option<String>,
            }
            let P { id, move_to } = params(p)?;
            ok(m.delete_workspace(&id, move_to.as_deref())?)
        }
        "workspace.touch" => {
            let IdParams { id } = params(p)?;
            m.touch_workspace(&id)?;
            ok(true)
        }
        "session.set_workspace" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                workspace: String,
            }
            let P { id, workspace } = params(p)?;
            ok(m.set_session_workspace(&id, &workspace)?)
        }
        "session.set_pinned" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                pinned: bool,
            }
            let P { id, pinned } = params(p)?;
            ok(m.set_pinned(&id, pinned)?)
        }
        "session.mark_seen" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let P { id } = params(p)?;
            ok(m.mark_seen(&id)?)
        }
        "session.set_archived" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                archived: bool,
            }
            let P { id, archived } = params(p)?;
            ok(m.set_archived(&id, archived).await?)
        }
        "session.stop" => {
            let IdParams { id } = params(p)?;
            m.stop_by_request(&id).await?;
            ok(true)
        }
        "session.restart" => {
            let IdParams { id } = params(p)?;
            ok(m.restart(&id).await?)
        }
        "session.delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                remove_worktree: bool,
            }
            let P {
                id,
                remove_worktree,
            } = params(p)?;
            // Its workers go with it; those deleted stream to this client no more.
            let tree: Vec<String> = m.with_workers(&id).into_iter().map(|s| s.id).collect();
            let result = m.delete(&id, remove_worktree).await;
            let gone: Vec<&String> = tree.iter().filter(|t| m.get_session(t).is_err()).collect();
            let mut attached = attached.lock();
            for id in gone {
                attached.remove(id);
            }
            drop(attached);
            result?;
            ok(true)
        }
        "session.delete_many" => {
            #[derive(Deserialize)]
            struct P {
                ids: Vec<String>,
                #[serde(default)]
                remove_worktree: bool,
            }
            let P {
                ids,
                remove_worktree,
            } = params(p)?;
            let result = m.delete_many(&ids, remove_worktree).await;
            // Those deleted stream to this client no more.
            let mut attached = attached.lock();
            for id in &result.deleted {
                attached.remove(id);
            }
            drop(attached);
            ok(result)
        }
        "session.switch_mode" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                mode: SessionMode,
            }
            let P { id, mode } = params(p)?;
            ok(m.switch_mode(&id, mode).await?)
        }
        "session.history" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                after_seq: u64,
                #[serde(default = "default_limit")]
                limit: usize,
            }
            fn default_limit() -> usize {
                5000
            }
            let P {
                id,
                after_seq,
                limit,
            } = params(p)?;
            ok(m.history(&id, after_seq, limit)?)
        }
        "session.attachment" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                attachment: String,
            }
            let P { id, attachment } = params(p)?;
            let (data, media_type) = m.attachment(&id, &attachment)?;
            ok(json!({ "data": data, "media_type": media_type }))
        }
        "session.pending" => {
            let (approvals, inputs) = m.pending();
            ok(json!({ "approvals": approvals, "inputs": inputs }))
        }
        "pty.attach" => {
            let IdParams { id } = params(p)?;
            let _ = m.get_session(&id)?;
            attached.lock().insert(id.clone());
            let sb = m.pty_scrollback(&id)?;
            ok(json!({ "scrollback": b64.encode(sb) }))
        }
        "pty.detach" => {
            let IdParams { id } = params(p)?;
            attached.lock().remove(&id);
            ok(true)
        }
        "pty.input" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                data: String,
            }
            let P { id, data } = params(p)?;
            let bytes = b64.decode(data).map_err(|e| anyhow!("bad base64: {e}"))?;
            m.pty_input(&id, &bytes)?;
            ok(true)
        }
        "pty.resize" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                cols: u16,
                rows: u16,
            }
            let P { id, cols, rows } = params(p)?;
            m.pty_resize(&id, cols, rows)?;
            ok(true)
        }
        "search" => {
            #[derive(Deserialize)]
            struct P {
                query: String,
                #[serde(default = "default_search_limit")]
                limit: usize,
            }
            fn default_search_limit() -> usize {
                50
            }
            let P { query, limit } = params(p)?;
            ok(m.search(&query, limit)?)
        }
        "settings.get" => {
            #[derive(Deserialize)]
            struct P {
                key: String,
            }
            let P { key } = params(p)?;
            ok(m.get_setting(&key)?)
        }
        "settings.set" => {
            #[derive(Deserialize)]
            struct P {
                key: String,
                value: String,
            }
            let P { key, value } = params(p)?;
            m.set_setting(&key, &value)?;
            ok(true)
        }
        "fs.home" => ok(dirs::home_dir().map(|p| p.to_string_lossy().to_string())),
        "fs.list_dir" => {
            #[derive(Deserialize)]
            struct P {
                #[serde(default)]
                path: String,
                #[serde(default)]
                show_hidden: bool,
            }
            let P { path, show_hidden } = params(p)?;
            ok(crate::fs::list_dir(&path, show_hidden)?)
        }
        "fs.read_image" => {
            #[derive(Deserialize)]
            struct P {
                path: String,
            }
            let P { path } = params(p)?;
            let (data, media_type) =
                tokio::task::spawn_blocking(move || crate::fs::read_image(&path))
                    .await
                    .map_err(|e| anyhow!(e))??;
            ok(json!({ "data": b64.encode(data), "media_type": media_type }))
        }
        "fs.search_files" => {
            #[derive(Deserialize)]
            struct P {
                cwd: String,
                #[serde(default)]
                query: String,
                #[serde(default = "default_files_limit")]
                limit: usize,
            }
            fn default_files_limit() -> usize {
                30
            }
            let P { cwd, query, limit } = params(p)?;
            let cwd2 = cwd.clone();
            let res =
                tokio::task::spawn_blocking(move || crate::fs::search_files(&cwd2, &query, limit))
                    .await
                    .map_err(|e| anyhow!(e))??;
            ok(res)
        }
        other => {
            if let Some(ext) = &state.ext {
                let call = ExtCall {
                    method: other.to_string(),
                    params: p.clone(),
                    session: session.clone(),
                    window: window.load(std::sync::atomic::Ordering::SeqCst),
                };
                if let Some(v) = ext(call).await? {
                    return Ok(v);
                }
            }
            Err(DispatchError {
                code: ERR_METHOD,
                message: format!("unknown method {other}"),
                data: None,
            })
        }
    }
}
