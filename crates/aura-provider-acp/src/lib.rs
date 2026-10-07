//! ACP provider: runs any agent that speaks the Agent Client Protocol
//! (agentclientprotocol.com, protocol version 1) and maps its sessions onto
//! Aura's unified model, so Gemini CLI, OpenCode, goose and the rest get the
//! structured view instead of only a terminal.
//!
//! Each Aura session gets its own agent process. Aura advertises no client
//! capabilities (no `fs/*`, no `terminal/*`): agents read and write files and
//! run commands themselves, and ask before doing so through
//! `session/request_permission`, which becomes an Aura approval.
//!
//! Like the Codex adapter, the protocol is hand-typed over `serde_json::Value`
//! rather than generated, so new or unknown fields degrade instead of failing
//! to parse. Field names follow `schema/v1/schema.json` in
//! github.com/agentclientprotocol/agent-client-protocol.

pub mod agents;
mod mapper;
mod rpc;

pub use agents::{AgentSpec, ResolvedAgent, CONFIG_FILE};
pub use mapper::{SessionMapper, TurnOutcome};
pub use rpc::{Connection, Incoming};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use aura_core::*;
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

pub const PROTOCOL_VERSION: u64 = 1;

/// How long an agent may take to answer `initialize` and create a session.
/// npx-installed agents can spend a while resolving packages on first start.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
/// Agent lists are re-read (config file and binary lookup) at most this often.
const AGENTS_TTL: Duration = Duration::from_secs(5);
const STDERR_LINES: usize = 40;

// ------------------------------------------------------------------ provider

pub struct AcpProvider {
    config: Option<PathBuf>,
    agents: Mutex<(Vec<ResolvedAgent>, Instant)>,
}

impl AcpProvider {
    /// Built-in agents plus those in `<data_dir>/acp-agents.json`.
    pub fn new(data_dir: &Path) -> Self {
        Self::with_config(Some(data_dir.join(CONFIG_FILE)))
    }

    pub fn with_config(config: Option<PathBuf>) -> Self {
        let agents = agents::load(config.as_deref());
        Self { config, agents: Mutex::new((agents, Instant::now())) }
    }

    pub fn agents(&self) -> Vec<ResolvedAgent> {
        self.agents.lock().0.clone()
    }

    fn agent(&self, id: &str) -> Option<ResolvedAgent> {
        self.agents.lock().0.iter().find(|a| a.spec.id == id).cloned()
    }
}

#[async_trait]
impl Provider for AcpProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Acp
    }

    fn info(&self) -> ProviderInfo {
        let agents: Vec<AgentInfo> = self.agents.lock().0.iter().map(ResolvedAgent::info).collect();
        ProviderInfo {
            kind: ProviderKind::Acp,
            display_name: "ACP agents".into(),
            available: agents.iter().any(|a| a.available),
            version: None,
            binary: None,
            // What any ACP agent can do. Per-agent choices (models, modes,
            // effort) are only known once a session exists and are published
            // as `acp_session` provider info.
            capabilities: CapabilitySet {
                structured: true,
                interrupt: true,
                images: true,
                plan_stream: true,
                diff_stream: true,
                models: true,
                effort: true,
                // Agents announce their commands in `available_commands_update`.
                slash_commands: true,
                ..Default::default()
            },
            agents,
        }
    }

    async fn refresh(&self) {
        if self.agents.lock().1.elapsed() < AGENTS_TTL {
            return;
        }
        let config = self.config.clone();
        match tokio::task::spawn_blocking(move || agents::load(config.as_deref())).await {
            Ok(agents) => *self.agents.lock() = (agents, Instant::now()),
            Err(e) => tracing::warn!("acp agent detection failed: {e}"),
        }
    }

    async fn list_native(&self) -> Result<Vec<NativeSession>> {
        Ok(vec![])
    }

    async fn start(&self, session: &Session, fork: bool, sink: EventSink) -> Result<Box<dyn Driver>> {
        if fork {
            bail!("ACP agents cannot fork sessions");
        }
        let id = session.agent.as_deref().ok_or_else(|| anyhow!("session has no ACP agent"))?;
        self.refresh().await;
        let agent = self.agent(id).ok_or_else(|| {
            anyhow!("unknown ACP agent `{id}`; add it to {}", self.config.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| CONFIG_FILE.into()))
        })?;
        let Some(binary) = agent.binary.clone() else {
            bail!("{} is not installed (looked for `{}`)", agent.spec.display_name, agent.spec.command[0]);
        };
        let driver = AcpDriver::start(&agent.spec, &binary, session, sink).await?;
        Ok(Box::new(driver))
    }

    /// No terminal mode: an ACP session id means nothing to the agent's own
    /// TUI, so switching would silently start an unrelated conversation.
    fn terminal_command(&self, _session: &Session) -> Vec<String> {
        vec![]
    }
}

// -------------------------------------------------------------------- driver

pub struct AcpDriver {
    conn: Connection,
    acp_session: String,
    session_id: String,
    agent_name: String,
    sink: EventSink,
    mapper: Arc<Mutex<SessionMapper>>,
    prompts: mpsc::UnboundedSender<Input>,
    /// `agentCapabilities` from `initialize`.
    caps: Value,
    life: Arc<AtomicU8>,
    /// Dropping it kills the agent and everything it started.
    group: Mutex<Option<aura_core::process::ProcessGroup>>,
}

type Stderr = Arc<Mutex<VecDeque<String>>>;

/// Driver lifecycle, read when the connection closes to decide what to report.
const RUNNING: u8 = 0;
/// `stop()` was called: the exit is expected, not an error.
const STOPPING: u8 = 1;
/// The handshake failed and `start` returned the error itself; reporting the
/// exit as well would overwrite that error with a generic one.
const FAILED_START: u8 = 2;

/// A started agent process (or, in tests, an in-process fake).
pub(crate) struct Link {
    pub conn: Connection,
    pub incoming: mpsc::UnboundedReceiver<Incoming>,
    pub child: Option<tokio::process::Child>,
    pub group: Option<aura_core::process::ProcessGroup>,
    pub stderr: Stderr,
}

fn stderr_tail(buf: &Stderr) -> Option<String> {
    let lines = buf.lock();
    let text = lines.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// `err`, with what the agent last wrote to stderr when that explains more.
/// Flattened into one message: callers show errors with `to_string()`, which
/// would print only the outermost `context`.
fn explain(err: anyhow::Error, stderr: &Stderr) -> anyhow::Error {
    match stderr_tail(stderr) {
        Some(tail) => anyhow!("{err:#}\n\nagent stderr:\n{tail}"),
        None => err,
    }
}

async fn with_timeout<T>(what: &str, fut: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(STARTUP_TIMEOUT, fut).await.map_err(|_| anyhow!("{what}: the agent did not answer within {}s", STARTUP_TIMEOUT.as_secs()))?
}

impl AcpDriver {
    async fn start(spec: &AgentSpec, binary: &str, session: &Session, sink: EventSink) -> Result<Self> {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.args(&spec.command[1..])
            .envs(&spec.env)
            .current_dir(&session.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let (mut child, group) = aura_core::process::spawn_job(&mut cmd).with_context(|| format!("start {}", spec.command.join(" ")))?;
        let stdin = child.stdin.take().context("agent stdin")?;
        let stdout = child.stdout.take().context("agent stdout")?;
        let stderr: Stderr = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(err) = child.stderr.take() {
            let buf = stderr.clone();
            let name = spec.id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("acp {name} stderr: {line}");
                    let mut b = buf.lock();
                    if b.len() == STDERR_LINES {
                        b.pop_front();
                    }
                    b.push_back(line);
                }
            });
        }

        let (conn, incoming) = Connection::new(stdout, stdin);
        Self::connect(Link { conn, incoming, child: Some(child), group: Some(group), stderr }, spec, session, sink).await
    }

    pub(crate) async fn connect(link: Link, spec: &AgentSpec, session: &Session, sink: EventSink) -> Result<Self> {
        let Link { conn, incoming, child, group, stderr } = link;
        let mapper = Arc::new(Mutex::new(SessionMapper::new(&session.id)));
        let life = Arc::new(AtomicU8::new(RUNNING));
        tokio::spawn(process_incoming(conn.clone(), incoming, mapper.clone(), sink.clone(), session.id.clone(), stderr.clone(), life.clone(), child));

        let started = Self::handshake(&conn, spec, session, &mapper, &sink).await;
        let (acp_session, caps, fresh) = match started {
            Ok(v) => v,
            Err(e) => {
                life.store(FAILED_START, Ordering::SeqCst);
                drop(group);
                return Err(explain(e, &stderr));
            }
        };

        let (prompts, rx) = mpsc::unbounded_channel();
        let driver = Self {
            conn,
            acp_session,
            session_id: session.id.clone(),
            agent_name: spec.display_name.clone(),
            sink,
            mapper,
            prompts,
            caps,
            life,
            group: Mutex::new(group),
        };
        // ACP has no system prompt, so the first prompt of a new conversation
        // carries it; resumed conversations already have it.
        driver.spawn_turns(rx, session.instructions.clone().filter(|_| fresh));
        driver.apply_initial_settings(session).await;
        Ok(driver)
    }

    /// `initialize`, then a new, resumed or loaded session. Returns the ACP
    /// session id, the agent's capabilities and whether the session is new.
    async fn handshake(conn: &Connection, spec: &AgentSpec, session: &Session, mapper: &Arc<Mutex<SessionMapper>>, sink: &EventSink) -> Result<(String, Value, bool)> {
        let init = with_timeout(
            "initialize",
            conn.request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "aura", "title": "Aura", "version": env!("CARGO_PKG_VERSION") },
                }),
            ),
        )
        .await
        .map_err(|e| anyhow!("initialize failed: {e:#}"))?;
        let version = init.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0);
        if version != PROTOCOL_VERSION {
            bail!("{} speaks ACP version {version}; Aura supports version {PROTOCOL_VERSION}", spec.display_name);
        }
        let caps = init.get("agentCapabilities").cloned().unwrap_or(json!({}));
        let agent = json!({
            "id": spec.id,
            "name": spec.display_name,
            "info": init.get("agentInfo").cloned().unwrap_or(Value::Null),
        });
        let _ = sink.send(mapper.lock().set_agent(agent));

        let failed = |what: &str, e: anyhow::Error| -> anyhow::Error {
            if rpc::error_code(&e) != Some(rpc::AUTH_REQUIRED) {
                return anyhow!("{what} failed: {e:#}");
            }
            let methods: Vec<String> = init
                .get("authMethods")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|m| m.get("name").and_then(Value::as_str).map(str::to_string))
                .collect();
            let how = if methods.is_empty() { String::new() } else { format!(" ({})", methods.join(", ")) };
            anyhow!("{} needs you to sign in{how}. Run `{}` in a terminal once to log in, then start the session again.", spec.display_name, spec.command[0])
        };

        let cwd = session.cwd.clone();
        let session_caps = caps.get("sessionCapabilities").cloned().unwrap_or(Value::Null);
        let can_resume = session_caps.get("resume").map(Value::is_object).unwrap_or(false);
        let can_load = caps.get("loadSession").and_then(Value::as_bool).unwrap_or(false);
        let native = session.native_id.clone();

        if let Some(id) = native.as_ref().filter(|_| can_resume || can_load) {
            let params = json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] });
            let method = if can_resume { "session/resume" } else { "session/load" };
            let res = if can_resume {
                with_timeout(method, conn.request(method, params)).await
            } else {
                // `session/load` replays the whole conversation, which Aura
                // already has in its own history.
                mapper.lock().replaying = true;
                let res = with_timeout(method, conn.request(method, params)).await;
                conn.inject("__replay_end", Value::Null);
                res
            };
            let res = res.map_err(|e| failed(method, e))?;
            for ev in mapper.lock().session_state(&res) {
                let _ = sink.send(ev);
            }
            return Ok((id.clone(), caps, false));
        }
        if native.is_some() {
            let _ = sink.send(Event::Notice {
                session_id: session.id.clone(),
                level: NoticeLevel::Warn,
                message: format!("{} cannot resume sessions, so this is a new conversation. The transcript above is Aura's copy; the agent does not remember it.", spec.display_name),
            });
        }
        let res = with_timeout("session/new", conn.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))).await.map_err(|e| failed("session/new", e))?;
        let id = res.get("sessionId").and_then(Value::as_str).ok_or_else(|| anyhow!("session/new returned no sessionId"))?.to_string();
        let _ = sink.send(Event::NativeId { session_id: session.id.clone(), native_id: id.clone() });
        for ev in mapper.lock().session_state(&res) {
            let _ = sink.send(ev);
        }
        Ok((id, caps, true))
    }

    /// Model and mode chosen when the session was created. A choice the agent
    /// does not offer is reported, not fatal: the session still works.
    async fn apply_initial_settings(&self, session: &Session) {
        let wanted = [session.model.clone().map(Setting::Model), session.permission_mode.clone().map(Setting::PermissionMode)];
        for setting in wanted.into_iter().flatten() {
            if let Err(e) = self.apply(setting).await {
                let _ = self.sink.send(Event::Notice { session_id: self.session_id.clone(), level: NoticeLevel::Warn, message: e.to_string() });
            }
        }
    }

    /// Prompts run one at a time: ACP has no queue of its own, and a second
    /// `session/prompt` during a turn is an error for most agents.
    fn spawn_turns(&self, mut rx: mpsc::UnboundedReceiver<Input>, mut instructions: Option<String>) {
        let conn = self.conn.clone();
        let acp_session = self.acp_session.clone();
        tokio::spawn(async move {
            while let Some(input) = rx.recv().await {
                let prompt = prompt_blocks(&input).await.map(|mut p| {
                    if let Some(i) = instructions.take() {
                        p.insert(0, json!({ "type": "text", "text": format!("<system-instructions>\n{i}\n</system-instructions>") }));
                    }
                    p
                });
                let prompt = match prompt {
                    Ok(p) => p,
                    Err(e) => {
                        conn.inject("__turn_start", json!({ "text": input.text, "images": input.images.len() }));
                        conn.inject("__turn_end", json!({ "error": e.to_string() }));
                        continue;
                    }
                };
                conn.inject("__turn_start", json!({ "text": input.text, "images": input.images.len() }));
                let end = match conn.request("session/prompt", json!({ "sessionId": acp_session, "prompt": prompt })).await {
                    Ok(res) => json!({ "stopReason": res.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn") }),
                    Err(e) => json!({ "error": e.to_string() }),
                };
                conn.inject("__turn_end", end);
                if conn.is_closed() {
                    break;
                }
            }
        });
    }

    fn session_caps(&self, name: &str) -> bool {
        self.caps.get("sessionCapabilities").and_then(|c| c.get(name)).map(Value::is_object).unwrap_or(false)
    }

    async fn set_config(&self, category: &str, value: &str, what: &str) -> Result<()> {
        let option = self.mapper.lock().config_option(category).cloned();
        let Some(option) = option else { bail!("{} does not offer a choice of {what}", self.agent_name) };
        let config_id = option.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let res = self
            .conn
            .request("session/set_config_option", json!({ "sessionId": self.acp_session, "configId": config_id, "value": value }))
            .await
            .map_err(|e| anyhow!("could not set {what} to `{value}`: {e:#}"))?;
        if let Some(opts) = res.get("configOptions").and_then(Value::as_array) {
            for ev in self.mapper.lock().set_config_options(opts.clone()) {
                let _ = self.sink.send(ev);
            }
        }
        Ok(())
    }

    async fn apply(&self, setting: Setting) -> Result<()> {
        match setting {
            Setting::Model(m) => self.set_config("model", &m, "model").await,
            Setting::Effort(e) => self.set_config("thought_level", &e, "effort").await,
            Setting::PermissionMode(mode) => {
                if !self.mapper.lock().has_modes() {
                    return self.set_config("mode", &mode, "mode").await;
                }
                self.conn
                    .request("session/set_mode", json!({ "sessionId": self.acp_session, "modeId": mode }))
                    .await
                    .map_err(|e| anyhow!("could not set mode to `{mode}`: {e:#}"))?;
                let events = self.mapper.lock().handle_update(&json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode }));
                for ev in events {
                    let _ = self.sink.send(ev);
                }
                Ok(())
            }
            Setting::SandboxMode(_) => bail!("ACP agents have no sandbox setting"),
        }
    }
}

#[async_trait]
impl Driver for AcpDriver {
    async fn send(&self, input: Input) -> Result<()> {
        let accepts_images = self.caps.get("promptCapabilities").and_then(|p| p.get("image")).and_then(Value::as_bool).unwrap_or(false);
        if !input.images.is_empty() && !accepts_images {
            bail!("{} does not accept images", self.agent_name);
        }
        self.prompts.send(input).map_err(|_| anyhow!("{} is not running", self.agent_name))
    }

    async fn interrupt(&self) -> Result<()> {
        self.conn.notify("session/cancel", json!({ "sessionId": self.acp_session })).await?;
        // The protocol requires answering open permission requests with
        // `cancelled` once the turn is cancelled.
        let pending = self.mapper.lock().take_approvals();
        for (approval_id, rpc_id) in pending {
            let _ = self.conn.reply(rpc_id, json!({ "outcome": { "outcome": "cancelled" } })).await;
            let _ = self.sink.send(Event::ApprovalResolved {
                session_id: self.session_id.clone(),
                approval_id,
                decision: ApprovalDecision { option: ApprovalOption::Cancel, updated_input: None, message: None },
            });
        }
        Ok(())
    }

    async fn respond_approval(&self, approval_id: &str, decision: ApprovalDecision) -> Result<()> {
        let (id, result) = self.mapper.lock().approval_reply(approval_id, &decision)?;
        self.conn.reply(id, result).await
    }

    async fn respond_input(&self, _response: UserInputResponse) -> Result<()> {
        bail!("ACP agents do not ask questions through Aura")
    }

    async fn set(&self, setting: Setting) -> Result<()> {
        self.apply(setting).await
    }

    async fn stop(&self) -> Result<()> {
        self.life.store(STOPPING, Ordering::SeqCst);
        if self.session_caps("close") && !self.conn.is_closed() {
            let close = self.conn.request("session/close", json!({ "sessionId": self.acp_session }));
            if let Err(e) = tokio::time::timeout(Duration::from_secs(2), close).await.unwrap_or_else(|_| Err(anyhow!("timed out"))) {
                tracing::debug!("acp session/close: {e}");
            }
        }
        self.group.lock().take();
        Ok(())
    }
}

/// Everything the agent sends, in order: updates, permission requests, and
/// the driver's own turn markers.
#[allow(clippy::too_many_arguments)]
async fn process_incoming(
    conn: Connection,
    mut rx: mpsc::UnboundedReceiver<Incoming>,
    mapper: Arc<Mutex<SessionMapper>>,
    sink: EventSink,
    session_id: String,
    stderr: Stderr,
    life: Arc<AtomicU8>,
    child: Option<tokio::process::Child>,
) {
    while let Some(msg) = rx.recv().await {
        let str_param = |k: &str| msg.params.get(k).and_then(Value::as_str).map(str::to_string);
        let events = match (msg.method.as_str(), &msg.id) {
            ("session/update", None) => mapper.lock().handle_update(&msg.params["update"]),
            ("session/request_permission", Some(id)) => mapper.lock().permission_request(id.clone(), &msg.params),
            ("__turn_start", _) => {
                let images = msg.params.get("images").and_then(Value::as_u64).unwrap_or(0) as usize;
                mapper.lock().begin_turn(&str_param("text").unwrap_or_default(), images)
            }
            ("__turn_end", _) => {
                let outcome = match str_param("error") {
                    Some(e) => TurnOutcome::Failed(e),
                    None => TurnOutcome::Stopped(str_param("stopReason").unwrap_or_else(|| "end_turn".into())),
                };
                mapper.lock().end_turn(outcome)
            }
            ("__replay_end", _) => {
                mapper.lock().replaying = false;
                vec![]
            }
            (rpc::CLOSED, _) => {
                let life = life.load(Ordering::SeqCst);
                if life == FAILED_START {
                    return;
                }
                let expected = life == STOPPING;
                let exit_code = match child {
                    Some(mut child) => match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                        Ok(Ok(status)) => status.code(),
                        _ => None,
                    },
                    None => None,
                };
                let message = (!expected).then(|| {
                    let code = exit_code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
                    match stderr_tail(&stderr) {
                        Some(tail) => format!("the agent exited{code}:\n{tail}"),
                        None => format!("the agent exited{code}"),
                    }
                });
                let mut events = vec![];
                let mut m = mapper.lock();
                if m.turn_active() {
                    events.extend(m.end_turn(TurnOutcome::Failed(message.clone().unwrap_or_else(|| "stopped".into()))));
                }
                drop(m);
                events.push(Event::ProcessExited { session_id: session_id.clone(), exit_code, message });
                for ev in events {
                    let _ = sink.send(ev);
                }
                return;
            }
            (method, Some(id)) => {
                // fs/*, terminal/*, elicitation/*: none were advertised.
                let _ = conn.reply_error(id.clone(), rpc::METHOD_NOT_FOUND, &format!("Aura does not support {method}")).await;
                vec![]
            }
            (method, None) => {
                tracing::debug!("acp: ignored notification {method}");
                vec![]
            }
        };
        for ev in events {
            if sink.send(ev).is_err() {
                return;
            }
        }
    }
}

/// ACP prompt content for an Aura input.
async fn prompt_blocks(input: &Input) -> Result<Vec<Value>> {
    let mut blocks = vec![];
    if !input.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": input.text }));
    }
    for img in &input.images {
        let (data, mime) = match (&img.data, &img.path) {
            (Some(d), _) => (d.clone(), img.media_type.clone().unwrap_or_else(|| "image/png".into())),
            (None, Some(p)) => {
                let bytes = tokio::fs::read(p).await.with_context(|| format!("read image {p}"))?;
                (base64::engine::general_purpose::STANDARD.encode(bytes), img.media_type.clone().unwrap_or_else(|| guess_media_type(p)))
            }
            (None, None) => continue,
        };
        blocks.push(json!({ "type": "image", "data": data, "mimeType": mime }));
    }
    Ok(blocks)
}

fn guess_media_type(path: &str) -> String {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
    .into()
}

#[cfg(test)]
mod tests;
