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

/// Extra method handler registered by the daemon (git, etc.). Return
/// `Ok(None)` when the method is not yours.
pub type ExtHandler =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    pub manager: Manager,
    pub token: String,
    pub info: Arc<DaemonInfo>,
    pub ext: Option<ExtHandler>,
    pub notifications: Option<broadcast::Sender<Value>>,
    pub shutdown: broadcast::Sender<()>,
}

pub struct RpcServer {
    pub info: DaemonInfo,
    pub shutdown: broadcast::Sender<()>,
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
        };
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
#[derive(Debug, Clone, PartialEq)]
enum Caller {
    /// The daemon's own token, from `daemon.json`: the app, the CLI. The user.
    User,
    /// The token of one session's tools (`Manager::session_token`), which
    /// Aura hands that session's `aura mcp` and nobody else. Checked again
    /// on every request: once the daemon revokes it, the connection closes.
    Session { id: String, token: String },
}

/// Whether `caller` may call `method` with `params`. A session's tools may
/// only use the orchestrator's and feature owner's tools for that session,
/// and read the agents; nothing that is the user's (answers, settings,
/// sessions, history, the daemon's own token). The user's token cannot act
/// as a session's tools.
fn authorize(caller: &Caller, method: &str, params: &Value) -> Result<(), DispatchError> {
    let session_tool = method.starts_with("owner.")
        || (method.starts_with("orchestrator.") && method != "orchestrator.projects");
    let forbidden = |message: String| DispatchError {
        code: ERR_FORBIDDEN,
        message,
    };
    match caller {
        Caller::User if session_tool => Err(forbidden(format!(
            "{method} acts for a session's tools and needs that session's own session token, which Aura hands only to its `aura mcp`"
        ))),
        Caller::User => Ok(()),
        Caller::Session { id, .. } => {
            let acts_for = |key: &str| params.get(key).and_then(Value::as_str) == Some(id.as_str());
            let allowed = match method {
                "daemon.ping" | "provider.list" | "provider.models" | "orchestrator.projects" => true,
                m if m.starts_with("orchestrator.") => acts_for("orchestrator"),
                m if m.starts_with("owner.") => acts_for("owner"),
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

async fn handle_socket(socket: WebSocket, state: AppState, caller: Caller) {
    tracing::info!("rpc client connected");
    // A session's tools get answers only: no events, notifications or
    // terminal output of the user's sessions.
    let user = caller == Caller::User;
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
    let mut events = state.manager.subscribe();
    let ev_tx = out_tx.clone();
    let ev_task = user.then(|| {
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
    });

    let extra_task = state.notifications.as_ref().filter(|_| user).map(|sender| {
        let mut rx = sender.subscribe();
        let tx = out_tx.clone();
        tokio::spawn(async move {
            loop {
                let notification = match rx.recv().await {
                    Ok(value) => value,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        json!({"method":"reviews.changed","params":{}})
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

    while let Some(Ok(msg)) = stream.next().await {
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
                tokio::spawn(async move {
                    let id = req.id.clone();
                    let result = match authorize(&caller, &req.method, &req.params) {
                        Ok(()) => dispatch(&state, &attached, req).await,
                        Err(e) => Err(e),
                    };
                    if let Some(id) = id {
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
                                    data: None,
                                }),
                            },
                        };
                        let _ = out
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                    }
                });
            }
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
    drop(out_tx);
    let _ = writer.await;
    tracing::info!("rpc client disconnected");
}

struct DispatchError {
    code: i64,
    message: String,
}

impl From<anyhow::Error> for DispatchError {
    fn from(e: anyhow::Error) -> Self {
        DispatchError {
            code: ERR_INTERNAL,
            message: format!("{e:#}"),
        }
    }
}

fn params<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, DispatchError> {
    serde_json::from_value(v.clone()).map_err(|e| DispatchError {
        code: ERR_PARAMS,
        message: e.to_string(),
    })
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, DispatchError> {
    serde_json::to_value(v).map_err(|e| DispatchError {
        code: ERR_INTERNAL,
        message: e.to_string(),
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
) -> Result<Value, DispatchError> {
    let m = &state.manager;
    let p = &req.params;
    let b64 = base64::engine::general_purpose::STANDARD;
    match req.method.as_str() {
        "daemon.info" => ok(&*state.info),
        "daemon.ping" => ok("pong"),
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
            }
            let P {
                owner,
                decision,
                rationale,
            } = params(p)?;
            ok(m.record_decision(&owner, &decision, &rationale)?)
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
            ok(json!({ "feature": f, "autonomy": autonomy }))
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
        "session.set_pinned" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                pinned: bool,
            }
            let P { id, pinned } = params(p)?;
            ok(m.set_pinned(&id, pinned)?)
        }
        "session.record_pull" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                url: String,
            }
            let P { id, url } = params(p)?;
            ok(m.record_pull(&id, &url)?)
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
            m.stop(&id).await?;
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
                if let Some(v) = ext(other.to_string(), p.clone()).await? {
                    return Ok(v);
                }
            }
            Err(DispatchError {
                code: ERR_METHOD,
                message: format!("unknown method {other}"),
            })
        }
    }
}
