//! Codex provider: drives `codex app-server` (JSON-RPC 2.0 over stdio JSONL)
//! and maps its threads/turns/items onto Aura's unified model.
//!
//! Protocol typing decision: the app-server schema bundle
//! (`docs/protocol/codex/codex_app_server_protocol.v2.schemas.json`, 600+
//! definitions) is *not* code-generated. We hand-type the subset Aura uses and
//! read everything else through `serde_json::Value`, so unknown fields, new
//! item types and new notifications degrade to `System` items / `ProviderInfo`
//! events instead of parse failures. The schema is checked in as the reference
//! for field names; `docs/protocol/codex/traffic.jsonl` is a real capture used
//! by the replay test.

mod client;
mod mapper;

pub use client::{Client, Incoming};
pub use mapper::ThreadMapper;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use aura_core::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

pub const APPROVAL_POLICIES: &[&str] = &["untrusted", "on-request", "never"];
pub const SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

/// "codex-cli 0.155.0" -> "0.155.0"
fn parse_version(stdout: &str) -> Option<String> {
    let v = stdout.trim();
    if v.is_empty() {
        return None;
    }
    Some(v.strip_prefix("codex-cli ").unwrap_or(v).to_string())
}

fn sandbox_policy(mode: &str) -> Value {
    match mode {
        "read-only" => json!({ "type": "readOnly" }),
        "workspace-write" => json!({ "type": "workspaceWrite" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        other => json!({ "type": other }),
    }
}

// ------------------------------------------------------------------ provider

pub struct CodexProvider {
    probe: aura_core::which::BinaryProbe,
    client: tokio::sync::Mutex<Option<Client>>,
}

impl CodexProvider {
    /// Detects the `codex` binary: `AURA_CODEX_BIN`, then `PATH`, then the
    /// usual install directories (Homebrew, npm/volta/bun globals, `~/.local/bin`).
    /// Re-detected later by `Provider::refresh` when the cached probe goes stale.
    pub fn new() -> Self {
        Self::from_probe(aura_core::which::BinaryProbe::search("codex", "AURA_CODEX_BIN", vec![], parse_version))
    }

    pub fn with_binary(binary: &str) -> Self {
        Self::from_probe(aura_core::which::BinaryProbe::pinned(binary, parse_version))
    }

    fn from_probe(probe: aura_core::which::BinaryProbe) -> Self {
        probe.probe_blocking();
        Self { probe, client: tokio::sync::Mutex::new(None) }
    }

    /// The detected path, or the bare name so error messages stay readable.
    fn binary(&self) -> String {
        self.probe.binary().unwrap_or_else(|| "codex".into())
    }

    pub fn is_available(&self) -> bool {
        self.probe.version().is_some()
    }

    /// The shared app-server connection, started on first use and restarted
    /// after it exits.
    pub async fn client(&self) -> Result<Client> {
        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            if !c.is_closed() {
                return Ok(c.clone());
            }
        }
        if !self.is_available() {
            bail!("codex CLI not found (looked for `{}`); install Codex or set AURA_CODEX_BIN", self.binary());
        }
        let client = Client::spawn(&self.binary()).await?;
        let init = client
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "aura", "title": "Aura", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await
            .context("codex initialize")?;
        tracing::info!("codex app-server ready: {}", init.get("userAgent").and_then(|u| u.as_str()).unwrap_or("?"));
        client.notify("initialized", json!({})).await?;
        let mut global = client.set_global();
        tokio::spawn(async move {
            while let Some(m) = global.recv().await {
                if m.method == client::CLOSED {
                    break;
                }
                tracing::debug!("codex global notification {}: {}", m.method, m.params);
            }
        });
        *guard = Some(client.clone());
        Ok(client)
    }

    pub async fn shutdown(&self) {
        if let Some(c) = self.client.lock().await.take() {
            c.shutdown().await;
        }
    }
}

impl Default for CodexProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for CodexProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn info(&self) -> ProviderInfo {
        let d = self.probe.cached();
        ProviderInfo {
            kind: ProviderKind::Codex,
            display_name: "Codex".into(),
            available: d.version.is_some(),
            version: d.version,
            binary: d.binary,
            capabilities: CapabilitySet {
                structured: true,
                models: true,
                effort: true,
                permission_modes: APPROVAL_POLICIES.iter().map(|s| s.to_string()).collect(),
                sandbox_modes: SANDBOX_MODES.iter().map(|s| s.to_string()).collect(),
                fork: true,
                steer: true,
                interrupt: true,
                review: true,
                compact: true,
                mcp_status: true,
                skills_list: true,
                slash_commands: true,
                images: true,
                diff_stream: true,
                plan_stream: true,
                native_sessions: true,
                rename: true,
                terminal_mode: true,
            },
            agents: vec![],
        }
    }

    async fn refresh(&self) {
        self.probe.refresh().await;
    }

    async fn list_native(&self) -> Result<Vec<NativeSession>> {
        let client = self.client().await?;
        let res = client.request("thread/list", json!({ "limit": 100 })).await?;
        let mut out = vec![];
        for t in res.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
            let id = match t.get("id").and_then(|i| i.as_str()) {
                Some(i) => i.to_string(),
                None => continue,
            };
            let preview = t.get("preview").and_then(|p| p.as_str()).map(|s| s.to_string()).filter(|s| !s.is_empty());
            let name = t.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()).filter(|s| !s.is_empty());
            let title = name.or_else(|| preview.as_ref().map(|p| truncate(p, 80)));
            out.push(NativeSession {
                provider: ProviderKind::Codex,
                native_id: id,
                cwd: t.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string()),
                title,
                updated_at: t.get("updatedAt").and_then(|u| u.as_i64()).and_then(|u| chrono::DateTime::from_timestamp(u, 0)),
                preview,
            });
        }
        Ok(out)
    }

    async fn start(&self, session: &Session, fork: bool, sink: EventSink) -> Result<Box<dyn Driver>> {
        let client = self.client().await?;
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), json!(session.cwd));
        if let Some(m) = &session.model {
            params.insert("model".into(), json!(m));
        }
        if let Some(p) = &session.permission_mode {
            params.insert("approvalPolicy".into(), json!(p));
        }
        if let Some(sb) = &session.sandbox_mode {
            params.insert("sandbox".into(), json!(sb));
        }
        let (method, thread_hint) = match (&session.native_id, fork) {
            (Some(id), true) => {
                params.insert("threadId".into(), json!(id));
                ("thread/fork", None)
            }
            (Some(id), false) => {
                params.insert("threadId".into(), json!(id));
                ("thread/resume", Some(id.clone()))
            }
            (None, _) => ("thread/start", None),
        };
        // Register early so notifications emitted during the request are not lost.
        let temp_key = thread_hint.clone().unwrap_or_else(|| format!("pending-{}", session.id));
        let rx = client.register(&temp_key);
        let res = match client.request(method, Value::Object(params)).await {
            Ok(r) => r,
            Err(e) => {
                client.unregister(&temp_key);
                return Err(e);
            }
        };
        let thread = res.get("thread").cloned().unwrap_or(Value::Null);
        let thread_id = thread
            .get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("{method}: response without thread id"))?;
        if thread_id != temp_key {
            client.rekey(&temp_key, &thread_id);
        }
        let mut mapper = ThreadMapper::new(&session.id, &thread_id);
        let mut initial = mapper.replay_thread(&thread);
        // Effective settings reported by the server.
        if let Some(m) = res.get("model").and_then(|m| m.as_str()) {
            initial.push(Event::SettingChanged { session_id: session.id.clone(), setting: Setting::Model(m.into()) });
        }
        if let Some(e) = res.get("reasoningEffort").and_then(|m| m.as_str()) {
            initial.push(Event::SettingChanged { session_id: session.id.clone(), setting: Setting::Effort(e.into()) });
        }
        if let Some(p) = res.get("approvalPolicy").and_then(|m| m.as_str()) {
            initial.push(Event::SettingChanged { session_id: session.id.clone(), setting: Setting::PermissionMode(p.into()) });
        }
        for ev in initial {
            let _ = sink.send(ev);
        }
        let driver = CodexDriver {
            client: client.clone(),
            thread_id: thread_id.clone(),
            session_id: session.id.clone(),
            sink: sink.clone(),
            state: Arc::new(Mutex::new(DriverState {
                mapper,
                model: session.model.clone(),
                effort: session.effort.clone(),
                approval_policy: session.permission_mode.clone(),
                sandbox_mode: session.sandbox_mode.clone(),
                dirty_policy: false,
            })),
        };
        driver.spawn_pump(rx);
        Ok(Box::new(driver))
    }

    fn terminal_command(&self, session: &Session) -> Vec<String> {
        match &session.native_id {
            Some(id) => vec![self.binary(), "resume".into(), id.clone()],
            None => vec![self.binary()],
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let client = self.client().await?;
        let res = client.request("model/list", json!({})).await?;
        let mut out = vec![];
        for m in res.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
            if m.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) {
                continue;
            }
            let id = m.get("id").or_else(|| m.get("model")).and_then(|i| i.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            out.push(ModelInfo {
                display_name: m.get("displayName").and_then(|d| d.as_str()).unwrap_or(&id).to_string(),
                description: m.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                efforts: m
                    .get("supportedReasoningEfforts")
                    .and_then(|e| e.as_array())
                    .map(|es| es.iter().filter_map(|e| e.get("reasoningEffort").and_then(|r| r.as_str()).map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                default_effort: m.get("defaultReasoningEffort").and_then(|d| d.as_str()).map(|s| s.to_string()),
                is_default: m.get("isDefault").and_then(|d| d.as_bool()).unwrap_or(false),
                id,
            });
        }
        Ok(out)
    }

    async fn list_commands(&self, cwd: &str) -> Result<Vec<SlashCommand>> {
        let client = self.client().await?;
        let res = client.request("skills/list", json!({ "cwds": [cwd] })).await?;
        let mut out = vec![];
        for entry in res.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
            for sk in entry.get("skills").and_then(|s| s.as_array()).into_iter().flatten() {
                if sk.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
                    continue;
                }
                let Some(name) = sk.get("name").and_then(|n| n.as_str()) else { continue };
                out.push(SlashCommand {
                    name: name.to_string(),
                    description: sk
                        .get("shortDescription")
                        .and_then(|d| d.as_str())
                        .filter(|d| !d.is_empty())
                        .or_else(|| sk.get("description").and_then(|d| d.as_str()))
                        .map(|s| s.to_string()),
                    source: Some("skill".into()),
                });
            }
        }
        Ok(out)
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

// -------------------------------------------------------------------- driver

struct DriverState {
    mapper: ThreadMapper,
    model: Option<String>,
    effort: Option<String>,
    approval_policy: Option<String>,
    sandbox_mode: Option<String>,
    /// Policy changed since the last turn; include it in the next turn/start.
    dirty_policy: bool,
}

pub struct CodexDriver {
    client: Client,
    thread_id: String,
    session_id: String,
    sink: EventSink,
    state: Arc<Mutex<DriverState>>,
}

impl CodexDriver {
    fn spawn_pump(&self, mut rx: tokio::sync::mpsc::UnboundedReceiver<Incoming>) {
        let state = self.state.clone();
        let sink = self.sink.clone();
        let client = self.client.clone();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let closed = msg.method == client::CLOSED;
                let outcome = state.lock().mapper.handle(&msg);
                for ev in outcome.events {
                    if sink.send(ev).is_err() {
                        return;
                    }
                }
                if let Some((id, result)) = outcome.reply {
                    if let Err(e) = client.reply(id, result).await {
                        tracing::warn!("codex reply failed: {e}");
                    }
                }
                if closed {
                    break;
                }
            }
        });
    }

    fn turn_params(&self, input: &Input) -> Value {
        let mut inputs: Vec<Value> = vec![];
        if !input.text.is_empty() {
            inputs.push(json!({ "type": "text", "text": input.text }));
        }
        for img in &input.images {
            if let Some(p) = &img.path {
                inputs.push(json!({ "type": "localImage", "path": p }));
            } else if let Some(d) = &img.data {
                let mt = img.media_type.clone().unwrap_or_else(|| "image/png".into());
                inputs.push(json!({ "type": "image", "url": format!("data:{mt};base64,{d}") }));
            }
        }
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(self.thread_id));
        params.insert("input".into(), Value::Array(inputs));
        let mut st = self.state.lock();
        if let Some(m) = &st.model {
            params.insert("model".into(), json!(m));
        }
        if let Some(e) = &st.effort {
            params.insert("effort".into(), json!(e));
        }
        if st.dirty_policy {
            if let Some(p) = &st.approval_policy {
                params.insert("approvalPolicy".into(), json!(p));
            }
            if let Some(sb) = &st.sandbox_mode {
                params.insert("sandboxPolicy".into(), sandbox_policy(sb));
            }
            st.dirty_policy = false;
        }
        Value::Object(params)
    }
}

/// `/model X` or `/effort X` (single-word argument) as a [`Setting`].
fn setting_from_slash(text: &str) -> Option<Setting> {
    let rest = text.trim().strip_prefix('/')?;
    let (name, arg) = rest.split_once(char::is_whitespace)?;
    let arg = arg.trim();
    if arg.is_empty() || arg.contains(char::is_whitespace) {
        return None;
    }
    match name {
        "model" => Some(Setting::Model(arg.to_string())),
        "effort" => Some(Setting::Effort(arg.to_string())),
        _ => None,
    }
}

#[async_trait]
impl Driver for CodexDriver {
    async fn send(&self, input: Input) -> Result<()> {
        // Codex has no text-level slash commands; `/model X` and `/effort X`
        // typed in the composer are applied as settings for the next turn,
        // mirroring what the picker does through `Driver::set`.
        if let Some(setting) = setting_from_slash(&input.text) {
            if input.images.is_empty() {
                return self.set(setting).await;
            }
        }
        let active = self.state.lock().mapper.active_turn().map(|s| s.to_string());
        if input.steer {
            if let Some(turn_id) = active {
                let mut inputs = vec![json!({ "type": "text", "text": input.text })];
                for img in &input.images {
                    if let Some(p) = &img.path {
                        inputs.push(json!({ "type": "localImage", "path": p }));
                    }
                }
                self.client
                    .request("turn/steer", json!({ "threadId": self.thread_id, "expectedTurnId": turn_id, "input": inputs }))
                    .await?;
                return Ok(());
            }
        }
        let params = self.turn_params(&input);
        self.client.request("turn/start", params).await?;
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let active = self.state.lock().mapper.active_turn().map(|s| s.to_string());
        if let Some(turn_id) = active {
            self.client.request("turn/interrupt", json!({ "threadId": self.thread_id, "turnId": turn_id })).await?;
        }
        Ok(())
    }

    async fn respond_approval(&self, approval_id: &str, decision: ApprovalDecision) -> Result<()> {
        let (id, result) = self.state.lock().mapper.approval_reply(approval_id, &decision)?;
        self.client.reply(id, result).await
    }

    async fn respond_input(&self, response: UserInputResponse) -> Result<()> {
        let (id, result) = self.state.lock().mapper.input_reply(&response)?;
        self.client.reply(id, result).await
    }

    async fn set(&self, setting: Setting) -> Result<()> {
        {
            let mut st = self.state.lock();
            match &setting {
                Setting::Model(m) => st.model = Some(m.clone()),
                Setting::Effort(e) => st.effort = Some(e.clone()),
                Setting::PermissionMode(p) => {
                    if !APPROVAL_POLICIES.contains(&p.as_str()) {
                        bail!("unknown Codex approval policy `{p}` (expected one of {APPROVAL_POLICIES:?})");
                    }
                    st.approval_policy = Some(p.clone());
                    st.dirty_policy = true;
                }
                Setting::SandboxMode(sb) => {
                    if !SANDBOX_MODES.contains(&sb.as_str()) {
                        bail!("unknown Codex sandbox mode `{sb}` (expected one of {SANDBOX_MODES:?})");
                    }
                    st.sandbox_mode = Some(sb.clone());
                    st.dirty_policy = true;
                }
            }
        }
        let _ = self.sink.send(Event::SettingChanged { session_id: self.session_id.clone(), setting });
        Ok(())
    }

    async fn action(&self, name: &str, params: Value) -> Result<Value> {
        match name {
            "compact" => self.client.request("thread/compact/start", json!({ "threadId": self.thread_id })).await,
            "review" => {
                let target = params.get("target").cloned().unwrap_or(json!({ "type": "uncommittedChanges" }));
                self.client.request("review/start", json!({ "threadId": self.thread_id, "target": target })).await
            }
            "rename" => {
                let name = params.get("name").and_then(|n| n.as_str()).ok_or_else(|| anyhow!("rename requires `name`"))?;
                self.client.request("thread/name/set", json!({ "threadId": self.thread_id, "name": name })).await
            }
            "archive" => self.client.request("thread/archive", json!({ "threadId": self.thread_id })).await,
            "mcp_status" => self.client.request("mcpServerStatus/list", json!({})).await,
            "rate_limits" => self.client.request("account/rateLimits/read", json!({})).await,
            "account" => self.client.request("account/read", json!({})).await,
            "file_search" => {
                let q = params.get("query").and_then(|q| q.as_str()).unwrap_or("");
                self.client
                    .request("fuzzyFileSearch", json!({ "query": q, "roots": params.get("roots").cloned().unwrap_or(json!([])), "cancellationToken": params.get("cancellationToken").cloned().unwrap_or(json!(null)) }))
                    .await
            }
            other => bail!("action `{other}` not supported by Codex"),
        }
    }

    async fn stop(&self) -> Result<()> {
        if !self.client.is_closed() {
            if let Err(e) = self.client.request("thread/unsubscribe", json!({ "threadId": self.thread_id })).await {
                tracing::debug!("thread/unsubscribe: {e}");
            }
        }
        self.client.unregister(&self.thread_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    const THREAD: &str = "01a0ae9a-efcf-7150-8940-8dd2fea0cbf2";

    fn capture() -> Vec<Value> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocol/codex/traffic.jsonl");
        let text = std::fs::read_to_string(path).expect("traffic capture");
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|o| o["dir"] == "in")
            .map(|o| o["msg"].clone())
            .collect()
    }

    #[test]
    fn replays_captured_traffic() {
        let mut mapper = ThreadMapper::new("sess", THREAD);
        let mut events = vec![];
        let mut replies = vec![];
        for msg in capture() {
            let Some(method) = msg.get("method").and_then(|m| m.as_str()) else { continue };
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            if client::thread_id_of(&params).as_deref() != Some(THREAD) {
                continue;
            }
            let inc = Incoming { id: msg.get("id").cloned(), method: method.to_string(), params };
            let out = mapper.handle(&inc);
            events.extend(out.events);
            if let Some(r) = out.reply {
                replies.push(r);
            }
        }
        let approvals: Vec<&Approval> = events
            .iter()
            .filter_map(|e| match e {
                Event::ApprovalRequested { approval, .. } => Some(approval),
                _ => None,
            })
            .collect();
        // The capture holds six command approvals: the spike passed a relative cwd, Codex's
        // exec failed and it retried with different commands, each needing approval.
        assert_eq!(approvals.len(), 6, "expected the six approvals present in the capture");
        assert!(approvals.iter().all(|a| a.kind == ApprovalKind::Command));
        let a = approvals[0];
        assert_eq!(a.payload["command"].as_str().unwrap(), "/bin/zsh -lc 'echo hi > hello2.txt'");
        assert!(a.options.contains(&ApprovalOption::Accept));
        assert!(a.options.contains(&ApprovalOption::Cancel));
        // The approval reply carries the server request id and a valid decision.
        let (rpc_id, result) = mapper
            .approval_reply(&a.id, &ApprovalDecision { option: ApprovalOption::AcceptForSession, updated_input: None, message: None })
            .unwrap();
        assert_eq!(rpc_id, json!(0));
        assert!(result["decision"].get("acceptWithExecpolicyAmendment").is_some(), "{result}");

        let turns: Vec<&Turn> = events
            .iter()
            .filter_map(|e| match e {
                Event::TurnCompleted { turn, .. } => Some(turn),
                _ => None,
            })
            .collect();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].status, TurnStatus::Completed);
        // The capture shows Codex reported the second (interrupted) turn as `completed`
        // too: the interrupt landed after the turn had already finished.
        assert_eq!(turns[1].status, TurnStatus::Completed);
        assert_eq!(events.iter().filter(|e| matches!(e, Event::TurnStarted { .. })).count(), 2);

        let started_msgs = events
            .iter()
            .filter(|e| matches!(e, Event::ItemStarted { item, .. } if item.kind == ItemKind::AgentMessage))
            .count();
        assert!(started_msgs >= 1);
        let deltas = events
            .iter()
            .filter(|e| matches!(e, Event::ItemDelta { delta: ItemDelta::Text { .. }, .. }))
            .count();
        assert!(deltas >= 1, "expected agent message deltas");
        let usage = events.iter().find_map(|e| match e {
            Event::Usage { usage, .. } => Some(usage.clone()),
            _ => None,
        });
        assert_eq!(usage.unwrap().context_window, Some(258400));
        assert!(events.iter().any(|e| matches!(e, Event::NativeId { native_id, .. } if native_id == THREAD)));
        assert!(events.iter().any(|e| matches!(e, Event::ItemCompleted { item, .. } if item.kind == ItemKind::UserMessage)));
        assert!(events.iter().any(|e| matches!(e, Event::ItemDelta { delta: ItemDelta::Output { .. }, .. })), "command output delta");
        assert!(replies.is_empty(), "mapper should not auto-answer approvals");
    }

    #[test]
    fn maps_file_change_and_approval() {
        let mut mapper = ThreadMapper::new("sess", "t");
        let item = json!({
            "type": "fileChange", "id": "fc1", "status": "inProgress",
            "changes": [{ "path": "src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "--- a\n+++ b\n" }]
        });
        let out = mapper.handle(&Incoming { id: None, method: "item/started".into(), params: json!({ "threadId": "t", "turnId": "u", "item": item }) });
        match &out.events[0] {
            Event::ItemStarted { item, .. } => {
                assert_eq!(item.kind, ItemKind::FileChange);
                assert_eq!(item.data["changes"][0]["kind"], "modify");
            }
            e => panic!("{e:?}"),
        }
        let out = mapper.handle(&Incoming {
            id: Some(json!(42)),
            method: "item/fileChange/requestApproval".into(),
            params: json!({ "threadId": "t", "turnId": "u", "itemId": "fc1", "reason": "writes outside sandbox", "startedAtMs": 1 }),
        });
        let approval = match &out.events[0] {
            Event::ApprovalRequested { approval, .. } => approval.clone(),
            e => panic!("{e:?}"),
        };
        assert_eq!(approval.kind, ApprovalKind::FileChange);
        assert_eq!(approval.payload["changes"][0]["path"], "src/a.rs");
        assert!(approval.title.contains("src/a.rs"));
        let (id, res) = mapper
            .approval_reply(&approval.id, &ApprovalDecision { option: ApprovalOption::Decline, updated_input: None, message: None })
            .unwrap();
        assert_eq!(id, json!(42));
        assert_eq!(res, json!({ "decision": "decline" }));
        assert!(mapper.approval_reply(&approval.id, &ApprovalDecision { option: ApprovalOption::Accept, updated_input: None, message: None }).is_err());
    }

    #[test]
    fn maps_user_input_request() {
        let mut mapper = ThreadMapper::new("sess", "t");
        let out = mapper.handle(&Incoming {
            id: Some(json!(9)),
            method: "item/tool/requestUserInput".into(),
            params: json!({ "threadId": "t", "turnId": "u", "itemId": "i", "isBlocking": true,
                "questions": [{ "id": "q1", "header": "Color", "question": "Red or blue?", "options": [{"label":"Red","description":"r"},{"label":"Blue","description":"b"}] }] }),
        });
        let req = match &out.events[0] {
            Event::UserInputRequested { request, .. } => request.clone(),
            e => panic!("{e:?}"),
        };
        assert_eq!(req.questions[0].options.len(), 2);
        let mut answers = std::collections::HashMap::new();
        answers.insert("q1".to_string(), vec!["Red".to_string()]);
        let (id, res) = mapper.input_reply(&UserInputResponse { request_id: req.id, answers }).unwrap();
        assert_eq!(id, json!(9));
        assert_eq!(res, json!({ "answers": { "q1": { "answers": ["Red"] } } }));
    }

    #[test]
    fn closed_connection_becomes_process_exited() {
        let mut mapper = ThreadMapper::new("sess", "t");
        let out = mapper.handle(&Incoming { id: None, method: client::CLOSED.into(), params: Value::Null });
        assert!(matches!(out.events[0], Event::ProcessExited { .. }));
    }

    #[test]
    fn unknown_item_types_become_system_items() {
        let mapper = ThreadMapper::new("sess", "t");
        let it = mapper.map_item(&json!({ "type": "somethingNew", "id": "x", "foo": 1 }), None);
        assert_eq!(it.kind, ItemKind::System);
        assert_eq!(it.data["raw"]["foo"], 1);
    }

    #[test]
    fn context_compaction_is_a_boundary() {
        let mapper = ThreadMapper::new("sess", "t");
        let it = mapper.map_item(&json!({ "type": "contextCompaction", "id": "c" }), None);
        assert_eq!(it.kind, ItemKind::System);
        assert_eq!(it.data["boundary"], "compact");
    }

    fn live() -> bool {
        std::env::var("AURA_LIVE_TESTS").is_ok()
    }

    #[tokio::test]
    #[ignore = "starts a real codex app-server; set AURA_LIVE_TESTS=1"]
    async fn live_models_and_pong() {
        if !live() {
            return;
        }
        let provider = CodexProvider::new();
        assert!(provider.is_available(), "codex not installed");
        let models = provider.list_models().await.unwrap();
        assert!(!models.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let opts = CreateSessionOpts {
            provider: ProviderKind::Codex,
            cwd: dir.path().to_string_lossy().to_string(),
            permission_mode: Some("never".into()),
            sandbox_mode: Some("read-only".into()),
            ..Default::default()
        };
        let session = Session::new(&opts);
        let driver = provider.start(&session, false, tx).await.unwrap();
        driver.send(Input { text: "Reply with exactly: pong".into(), ..Default::default() }).await.unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut got_native = false;
        let mut text = String::new();
        loop {
            let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("sink closed");
            match ev {
                Event::NativeId { .. } => got_native = true,
                Event::ItemCompleted { item, .. } if item.kind == ItemKind::AgentMessage => text.push_str(&item.text),
                Event::TurnCompleted { turn, .. } => {
                    assert_eq!(turn.status, TurnStatus::Completed, "{turn:?}");
                    break;
                }
                _ => {}
            }
        }
        assert!(got_native);
        assert!(text.to_lowercase().contains("pong"), "got {text:?}");
        driver.stop().await.unwrap();
        let natives = provider.list_native().await.unwrap();
        assert!(!natives.is_empty());
        provider.shutdown().await;
    }
}
