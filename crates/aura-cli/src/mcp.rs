//! `aura mcp`: the orchestration tools as a stdio MCP server. Aura starts it
//! for every orchestrator session, whatever its agent, and it forwards each
//! tool call to the daemon's `orchestrator.*` methods. A feature owner's
//! server (`--feature-owner`) has the owner's tools too, which call `owner.*`.
//! A worker on a feature owner's team gets a server of its own (`--worker`)
//! with only the team's tools, which call `team.*`.
//!
//! It connects with the session token Aura made for its session (`--token`),
//! not the daemon's own token: the daemon lets it act for that session only.

use anyhow::{anyhow, bail, Result};
use aura_core::*;
use aura_rpc::client::RpcClient;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// Whom the server's tools act for.
#[derive(Debug, Clone)]
pub enum Role {
    /// An orchestrator; one that owns a feature gets the owner's tools too.
    Orchestrator { id: String, feature_owner: bool },
    /// A worker on a feature owner's team: the team's tools only.
    Worker { id: String },
}

struct Server {
    data_dir: PathBuf,
    /// The session the tools act for.
    orchestrator: String,
    /// The orchestrator owns a feature: it gets the owner's tools.
    feature_owner: bool,
    /// The session is a worker on a feature owner's team.
    worker: bool,
    /// The session token the daemon made for this session's tools.
    token: String,
    client: Mutex<Option<RpcClient>>,
}

pub async fn run(data_dir: PathBuf, role: Role, token: String) -> Result<()> {
    let (orchestrator, feature_owner, worker) = match role {
        Role::Orchestrator { id, feature_owner } => (id, feature_owner, false),
        Role::Worker { id } => (id, false, true),
    };
    let server = Arc::new(Server {
        data_dir,
        orchestrator,
        feature_owner,
        token,
        worker,
        client: Mutex::new(None),
    });
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = out_rx.recv().await {
            let mut line = msg.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = out_tx.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } }));
                continue;
            }
        };
        // Requests run concurrently: `wait_for_sessions` may block for long.
        let server = server.clone();
        let out = out_tx.clone();
        tokio::spawn(async move {
            let Some(id) = msg.get("id").cloned() else {
                return;
            }; // a notification
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let reply = match server.handle(method, params).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                }
            };
            let _ = out.send(reply);
        });
    }
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

impl Server {
    async fn handle(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = if PROTOCOL_VERSIONS.contains(&asked) {
                    asked
                } else {
                    PROTOCOL_VERSIONS[0]
                };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "aura", "title": "Aura", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": if self.worker {
                        "Work with your team in Aura: see who is on it, and ask a teammate or the feature owner a question. Answers come back as messages from Aura."
                    } else if self.feature_owner {
                        "Own a feature in Aura: hire specialists as worker sessions, direct and follow them, hold meetings, put the user's decisions to them, and deliver a report. Workers are normal Aura sessions the user can open and message too."
                    } else {
                        "Start, direct and follow Aura worker sessions. Workers are normal Aura sessions the user can open and message too."
                    },
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(
                json!({ "tools": if self.worker { worker_tools() } else { tools(self.feature_owner) } }),
            ),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Ok(match self.call(&name, &args).await {
                    Ok(text) => {
                        json!({ "content": [{ "type": "text", "text": text }], "isError": false })
                    }
                    Err(e) => {
                        json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true })
                    }
                })
            }
            _ => Err((-32601, format!("method not found: {method}"))),
        }
    }

    /// The daemon connection, with this session's token, re-established
    /// when it drops. The daemon that started this server is the one it
    /// talks to: a daemon started since knows no such token, and says so.
    async fn connected(&self) -> Result<RpcClient> {
        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
        let info = aura_rpc::read_daemon_info(&self.data_dir)
            .ok_or_else(|| anyhow!("the Aura daemon is not running"))?;
        let c = RpcClient::connect(info.port, &self.token)
            .await
            .map_err(|e| anyhow!("could not connect to the Aura daemon with this session's token ({e}); the daemon may have restarted, which restarts this session's tools on its next message"))?;
        *guard = Some(c.clone());
        Ok(c)
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        // Above the longest `orchestrator.wait` the daemon allows.
        let timeout = Duration::from_secs(3700);
        match self
            .connected()
            .await?
            .call_with_timeout(method, params.clone(), timeout)
            .await
        {
            Err(e) if e.to_string() == "connection closed" => {
                *self.client.lock().await = None;
                self.connected()
                    .await?
                    .call_with_timeout(method, params, timeout)
                    .await
            }
            result => result,
        }
    }

    async fn call(&self, tool: &str, a: &Value) -> Result<String> {
        if self.worker {
            return self.call_teammate(tool, a).await;
        }
        let o = &self.orchestrator;
        match tool {
            "list_agents" => self.list_agents().await,
            "list_projects" => {
                let projects: Vec<Project> = serde_json::from_value(
                    self.rpc("orchestrator.projects", json!({ "orchestrator": o }))
                        .await?,
                )?;
                Ok(if projects.is_empty() {
                    "Aura knows no folders yet. Ask the user where the work is and pass the absolute path as `cwd` to start_session.".into()
                } else {
                    format!(
                        "Folders and repositories the user's sessions work in, most recently used first (pass one as `cwd` to start_session):\n{}",
                        describe_projects(&projects)
                    )
                })
            }
            "start_session" => {
                let mut p = json!({ "orchestrator": o, "agent": req(a, "agent")?, "prompt": req(a, "prompt")? });
                for key in ["title", "cwd", "branch", "base", "model", "effort"] {
                    if let Some(v) = a
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                    {
                        p[key] = json!(v);
                    }
                }
                let s: Session = serde_json::from_value(self.rpc("orchestrator.start", p).await?)?;
                Ok(format!(
                    "Started {} (`{}`) with {} in {}{}. It is working on the task; you get a worker report when it stops, or call wait_for_sessions.",
                    s.title,
                    s.id,
                    agent_line(
                        s.agent.as_deref().unwrap_or(s.provider.as_str()),
                        s.model.as_deref(),
                        s.effort.as_deref()
                    ),
                    s.cwd,
                    s.worktree.as_ref().map(|w| format!(" on branch `{}`", w.branch)).unwrap_or_default()
                ))
            }
            "send_message" => {
                let s: Session = serde_json::from_value(
                    self.rpc("orchestrator.send", json!({ "orchestrator": o, "worker": req(a, "session")?, "text": req(a, "text")? })).await?,
                )?;
                Ok(format!("Sent to {} (`{}`).", s.title, s.id))
            }
            "list_sessions" => {
                let workers: Vec<WorkerReport> = serde_json::from_value(
                    self.rpc("orchestrator.workers", json!({ "orchestrator": o }))
                        .await?,
                )?;
                Ok(if workers.is_empty() {
                    "You have no workers yet.".into()
                } else {
                    describe_workers(&workers)
                })
            }
            "read_session" => {
                let turns = a.get("turns").and_then(Value::as_u64).unwrap_or(1);
                let v = self
                    .rpc(
                        "orchestrator.read",
                        json!({ "orchestrator": o, "worker": req(a, "session")?, "turns": turns }),
                    )
                    .await?;
                Ok(v.as_str().unwrap_or_default().to_string())
            }
            "wait_for_sessions" => {
                let sessions: Vec<String> = a
                    .get("sessions")
                    .and_then(Value::as_array)
                    .map(|s| {
                        s.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let any = a.get("mode").and_then(Value::as_str) == Some("any");
                let timeout = a
                    .get("timeout_seconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(600);
                let r: WaitResult = serde_json::from_value(
                    self.rpc("orchestrator.wait", json!({ "orchestrator": o, "workers": sessions, "any": any, "timeout_secs": timeout })).await?,
                )?;
                if r.workers.is_empty() {
                    return Ok("You have no workers to wait for.".into());
                }
                let head = if r.timed_out {
                    "Timed out; some workers are still working."
                } else {
                    "Done waiting."
                };
                Ok(format!("{head}\n\n{}", describe_workers(&r.workers)))
            }
            "interrupt_session" => {
                self.rpc(
                    "orchestrator.interrupt",
                    json!({ "orchestrator": o, "worker": req(a, "session")? }),
                )
                .await?;
                Ok("Interrupted.".into())
            }
            "stop_session" => {
                self.rpc(
                    "orchestrator.stop",
                    json!({ "orchestrator": o, "worker": req(a, "session")? }),
                )
                .await?;
                Ok("Stopped. The session is kept; a new message resumes it.".into())
            }
            "delete_session" => {
                let deleted: Vec<Session> = serde_json::from_value(
                    self.rpc(
                        "orchestrator.delete",
                        json!({ "orchestrator": o, "worker": req(a, "session")? }),
                    )
                    .await?,
                )?;
                let Some(w) = deleted.first() else {
                    bail!("nothing was deleted");
                };
                Ok(match deleted.len() - 1 {
                    0 => format!("Deleted {} (`{}`) and its history.", w.title, w.id),
                    1 => format!(
                        "Deleted {} (`{}`) and its history, with the 1 worker it started.",
                        w.title, w.id
                    ),
                    n => format!(
                        "Deleted {} (`{}`) and its history, with the {n} workers it started.",
                        w.title, w.id
                    ),
                })
            }
            _ if self.feature_owner => self.call_owner(tool, a).await,
            _ => bail!("unknown tool {tool}"),
        }
    }

    /// The feature owner's own tools.
    async fn call_owner(&self, tool: &str, a: &Value) -> Result<String> {
        let o = &self.orchestrator;
        match tool {
            "list_specialists" => {
                let mut p = json!({ "owner": o });
                if let Some(cwd) = opt(a, "cwd") {
                    p["cwd"] = json!(cwd);
                }
                let list: Vec<Specialist> =
                    serde_json::from_value(self.rpc("owner.specialists", p).await?)?;
                Ok(if list.is_empty() {
                    "There are no specialists: the user deleted them all. Use start_session for ad-hoc workers, and propose_specialist for roles you need again.".into()
                } else {
                    format!(
                        "Specialists you can hire (pass the id as `specialist` to hire):\n{}",
                        aura_core::specialists::describe(&list)
                    )
                })
            }
            "hire" => {
                let mut p = json!({ "owner": o, "specialist": req(a, "specialist")?, "prompt": req(a, "prompt")? });
                for key in ["agent", "title", "cwd", "branch", "base", "model", "effort"] {
                    if let Some(v) = opt(a, key) {
                        p[key] = json!(v);
                    }
                }
                let s: Session = serde_json::from_value(self.rpc("owner.hire", p).await?)?;
                Ok(format!(
                    "Hired {} (`{}`) as {} with {} in {}{}. It is working on the task; you get a worker report when it stops, or call wait_for_sessions.",
                    s.title,
                    s.id,
                    s.specialist_name.as_deref().unwrap_or("a specialist"),
                    agent_line(
                        s.agent.as_deref().unwrap_or(s.provider.as_str()),
                        s.model.as_deref(),
                        s.effort.as_deref()
                    ),
                    s.cwd,
                    s.worktree.as_ref().map(|w| format!(" on branch `{}`", w.branch)).unwrap_or_default()
                ))
            }
            "ask_user" => {
                let mut p = json!({ "owner": o, "question": req(a, "question")? });
                for key in ["context", "recommended", "kind"] {
                    if let Some(v) = opt(a, key) {
                        p[key] = json!(v);
                    }
                }
                if let Some(options) = a.get("options").and_then(Value::as_array) {
                    p["options"] = json!(options
                        .iter()
                        .map(|o| match o {
                            Value::String(label) => json!({ "label": label }),
                            other => other.clone(),
                        })
                        .collect::<Vec<_>>());
                }
                let q: UserQuestion = serde_json::from_value(self.rpc("owner.ask_user", p).await?)?;
                Ok(format!(
                    "Asked the user (question `{}`); they see it as a card in your chat. End your turn now rather than wait: Aura sends you their answer in a message that starts with `[Aura] Decision from the user`. Meanwhile, keep the team on work that does not depend on it.",
                    q.id
                ))
            }
            "record_decision" => {
                let mut p = json!({ "owner": o, "decision": req(a, "decision")?, "rationale": req(a, "rationale")? });
                if let Some(m) = opt(a, "meeting") {
                    p["meeting"] = json!(m);
                }
                let d: Decision =
                    serde_json::from_value(self.rpc("owner.record_decision", p).await?)?;
                Ok(format!("Recorded decision `{}`.", d.id))
            }
            "hold_meeting" => {
                let mut p =
                    json!({ "owner": o, "topic": req(a, "topic")?, "agenda": req(a, "agenda")? });
                for key in ["context", "cwd", "mode"] {
                    if let Some(v) = opt(a, key) {
                        p[key] = json!(v);
                    }
                }
                for key in ["attendees", "guests"] {
                    p[key] = json!(strings(a, key));
                }
                for key in ["timeout_minutes", "rounds"] {
                    if let Some(t) = a.get(key).and_then(Value::as_u64) {
                        p[key] = json!(t);
                    }
                }
                let m: Meeting = serde_json::from_value(self.rpc("owner.hold_meeting", p).await?)?;
                let names: Vec<String> = m
                    .attendees
                    .iter()
                    .map(|a| match a.status {
                        AttendeeStatus::Missing => format!(
                            "{} (missing: {})",
                            a.name,
                            a.missing.as_deref().unwrap_or("no answer")
                        ),
                        _ if a.guest => format!("{} (`{}`, guest)", a.name, a.worker_id),
                        _ => format!("{} (`{}`)", a.name, a.worker_id),
                    })
                    .collect();
                let minutes = m.minutes();
                if m.live() {
                    return Ok(match m.status {
                        MeetingStatus::Collecting => format!(
                            "Live meeting `{}` started with {}, who speak in that order, each in about {} words. Aura brings you each round in a message that starts with `[Aura] Live meeting notes`, at the latest {minutes} minutes after it starts; then `continue_meeting` (at most {} rounds) or `close_meeting`. End your turn now rather than wait.",
                            m.id,
                            names.join(", "),
                            m.turn_words,
                            m.max_rounds
                        ),
                        _ => format!(
                            "Live meeting `{}` could not start: {}. Decide yourself or hold another one.",
                            m.id,
                            names.join(", ")
                        ),
                    });
                }
                Ok(format!(
                    "Meeting `{}` started with {}. Aura sends each the question and brings you every answer in one message that starts with `[Aura] Meeting notes`, at the latest in {minutes} minutes. End your turn now rather than wait.",
                    m.id,
                    names.join(", ")
                ))
            }
            "continue_meeting" => {
                let m: Meeting = serde_json::from_value(
                    self.rpc(
                        "owner.continue_meeting",
                        json!({ "owner": o, "meeting": req(a, "meeting")?, "steer": req(a, "steer")? }),
                    )
                    .await?,
                )?;
                Ok(format!(
                    "Round {} of meeting `{}` started (at most {}). Aura brings you the round in a message that starts with `[Aura] Live meeting notes`. End your turn now rather than wait.",
                    m.round, m.id, m.max_rounds
                ))
            }
            "close_meeting" => {
                let m: Meeting = serde_json::from_value(
                    self.rpc(
                        "owner.close_meeting",
                        json!({ "owner": o, "meeting": req(a, "meeting")?, "outcome": req(a, "outcome")? }),
                    )
                    .await?,
                )?;
                Ok(format!(
                    "Closed meeting `{}` with its outcome. Record the decisions it led to with `record_decision` and `meeting: \"{}\"`, then brief the team.",
                    m.id, m.id
                ))
            }
            "suggest_specialists" => {
                let r: SuggestionRun = serde_json::from_value(
                    self.rpc("owner.suggest_specialists", json!({ "owner": o }))
                        .await?,
                )?;
                Ok(if r.suggestions.is_empty() {
                    r.note
                } else {
                    format!(
                        "{} They show as cards in your chat; you need not wait for the user.",
                        r.note
                    )
                })
            }
            "reply_to_teammate" => {
                let r: OneOnOne = serde_json::from_value(
                    self.rpc(
                        "owner.reply_to_teammate",
                        json!({ "owner": o, "question": req(a, "question")?, "answer": req(a, "answer")? }),
                    )
                    .await?,
                )?;
                Ok(format!("Sent your answer to {}.", r.from_name))
            }
            "checkpoint" => {
                let r: CheckpointOutcome = serde_json::from_value(
                    self.rpc(
                        "owner.checkpoint",
                        json!({ "owner": o, "checkpoint": req(a, "checkpoint")?, "summary": req(a, "summary")? }),
                    )
                    .await?,
                )?;
                Ok(match r.review {
                    Some(q) => format!(
                        "The user wants to review this checkpoint ({}), so Aura asked them (question `{}`). End your turn and do not go past it until their answer comes in a message that starts with `[Aura] Checkpoint review from the user`.",
                        r.checkpoint.label(),
                        q.id
                    ),
                    None => format!(
                        "Recorded the checkpoint {}. The user's autonomy setting does not stop here: carry on.",
                        r.checkpoint.label()
                    ),
                })
            }
            "propose_specialist" => {
                let mut specialist =
                    json!({ "name": req(a, "name")?, "instructions": req(a, "instructions")? });
                for key in ["id", "role", "description", "agent", "model", "effort"] {
                    if let Some(v) = opt(a, key) {
                        specialist[key] = json!(v);
                    }
                }
                let s: SpecialistSuggestion = serde_json::from_value(
                    self.rpc(
                        "owner.propose_specialist",
                        json!({ "owner": o, "specialist": specialist, "reason": req(a, "reason")? }),
                    )
                    .await?,
                )?;
                Ok(format!(
                    "Proposed \"{}\" (suggestion `{}`). The user accepts, edits or dismisses it in your chat; Aura tells you which. Until then, use start_session for that role if you need it now.",
                    s.specialist.name, s.id
                ))
            }
            "deliver_report" => {
                let mut p = json!({ "owner": o });
                for key in ["what", "why", "how_to_test", "where_to_test"] {
                    p[key] = json!(req(a, key)?);
                }
                if let Some(v) = opt(a, "notes") {
                    p["notes"] = json!(v);
                }
                self.rpc("owner.deliver_report", p).await?;
                Ok("Delivered. The user sees your report as a card in your chat; tell them in a line or two that the feature is ready and where to try it.".into())
            }
            "feature_status" => {
                #[derive(serde::Deserialize)]
                struct Status {
                    feature: Feature,
                    autonomy: Autonomy,
                    #[serde(default)]
                    meeting_mode: MeetingMode,
                }
                let s: Status =
                    serde_json::from_value(self.rpc("owner.status", json!({ "owner": o })).await?)?;
                Ok(aura_core::features::describe(
                    &s.feature,
                    &s.autonomy,
                    s.meeting_mode,
                ))
            }
            _ => bail!("unknown tool {tool}"),
        }
    }

    /// A team member's tools.
    async fn call_teammate(&self, tool: &str, a: &Value) -> Result<String> {
        let w = &self.orchestrator;
        match tool {
            "list_team" => {
                let v = self.rpc("team.list", json!({ "worker": w })).await?;
                Ok(v.as_str().unwrap_or_default().to_string())
            }
            "ask_teammate" => {
                let r: OneOnOne = serde_json::from_value(
                    self.rpc(
                        "team.ask",
                        json!({ "worker": w, "to": req(a, "teammate")?, "question": req(a, "question")? }),
                    )
                    .await?,
                )?;
                Ok(format!(
                    "Asked {} (question `{}`). It answers in its next turn and Aura brings you the answer in a message that starts with `[Aura] Answer from a teammate`. Go on with what does not depend on it, or end your turn.",
                    r.to_name, r.id
                ))
            }
            "ask_owner" => {
                let r: OneOnOne = serde_json::from_value(
                    self.rpc(
                        "team.ask_owner",
                        json!({ "worker": w, "question": req(a, "question")? }),
                    )
                    .await?,
                )?;
                Ok(format!(
                    "Asked the feature owner (question `{}`). Aura brings you the answer in a message that starts with `[Aura] Answer from the feature owner`. Go on with what does not depend on it, or end your turn.",
                    r.id
                ))
            }
            _ => bail!("unknown tool {tool}"),
        }
    }

    async fn list_agents(&self) -> Result<String> {
        let providers: Vec<ProviderInfo> =
            serde_json::from_value(self.rpc("provider.list", json!({})).await?)?;
        let mut out =
            String::from("Agents you can start (pass the id as `agent` to start_session):\n");
        for p in &providers {
            match p.kind {
                ProviderKind::Claude | ProviderKind::Codex if p.available => {
                    out.push_str(&format!(
                        "- `{}`: {}{}\n",
                        p.kind.as_str(),
                        p.display_name,
                        p.version
                            .as_deref()
                            .map(|v| format!(" {v}"))
                            .unwrap_or_default()
                    ));
                    let models: Vec<ModelInfo> = self
                        .rpc("provider.models", json!({ "provider": p.kind }))
                        .await
                        .ok()
                        .and_then(|v| serde_json::from_value(v).ok())
                        .unwrap_or_default();
                    out.push_str(&describe_models(&models));
                }
                ProviderKind::Acp => {
                    for agent in p.agents.iter().filter(|a| a.available) {
                        out.push_str(&format!("- `{}`: {} (ACP)\n", agent.id, agent.display_name));
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }
}

/// An agent's models for `list_agents`, one per line with what start_session
/// can pass for them.
fn describe_models(models: &[ModelInfo]) -> String {
    let mut out = String::new();
    for m in models {
        out.push_str(&format!("  - model `{}`", m.id));
        if !m.display_name.is_empty() && m.display_name != m.id {
            out.push_str(&format!(" ({})", m.display_name));
        }
        if m.is_default {
            out.push_str(", the default");
        }
        if let Some(d) = m.description.as_deref().filter(|d| !d.trim().is_empty()) {
            out.push_str(&format!(": {}", d.trim()));
        }
        if !m.efforts.is_empty() {
            out.push_str(&format!("; efforts: {}", m.efforts.join(", ")));
            if let Some(e) = &m.default_effort {
                out.push_str(&format!(" (default {e})"));
            }
        }
        out.push('\n');
    }
    out
}

fn req<'a>(a: &'a Value, key: &str) -> Result<&'a str> {
    a.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| anyhow!("`{key}` is required"))
}

/// A list of strings argument; a single string is a list of one.
fn strings(a: &Value, key: &str) -> Vec<String> {
    match a.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(Value::String(one)) if !one.trim().is_empty() => vec![one.clone()],
        _ => vec![],
    }
}

/// An optional string argument, when given and not blank.
fn opt<'a>(a: &'a Value, key: &str) -> Option<&'a str> {
    a.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
}

fn session_arg() -> Value {
    json!({ "type": "string", "description": "The worker's session id (a unique prefix is enough) or its exact title." })
}

/// The tools of an orchestrator's server; a feature owner's has its own too.
fn tools(feature_owner: bool) -> Value {
    let mut tools = orchestrator_tools();
    if feature_owner {
        if let (Some(all), Value::Array(own)) = (tools.as_array_mut(), owner_tools()) {
            all.extend(own);
        }
    }
    tools
}

/// Only feature owners get these.
fn owner_tools() -> Value {
    json!([
        {
            "name": "list_specialists",
            "description": "List the specialists you can hire: reusable personas (UX designer, UI designer, frontend and backend engineer, tester, code reviewer, security reviewer and the user's own) with what each is good at and the agent, model and effort it prefers. A project's own specialists replace global ones with the same id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": { "type": "string", "description": "The folder or repository the work is in, to include that project's own specialists. Defaults to your folder." },
                },
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "hire",
            "description": "Hire a specialist: start a worker session that gets the specialist's instructions in its system prompt and runs on the specialist's preferred agent, model and effort unless you name others. It starts on `prompt` right away and joins your team. The worker does not see your conversation, so the prompt must be a complete brief.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "specialist": { "type": "string", "description": "The specialist's id from list_specialists." },
                    "prompt": { "type": "string", "description": "The task, complete and self-contained: goal, context, files, constraints, how to verify and what to report." },
                    "title": { "type": "string", "description": "Short title shown in Aura's sidebar. Defaults to the specialist's name." },
                    "cwd": { "type": "string", "description": "Absolute path of the folder or repository the worker works in. Required when you have no folder of your own." },
                    "branch": { "type": "string", "description": "Run the worker in a new git worktree on this branch. Use one per worker when several change the same repository at once." },
                    "base": { "type": "string", "description": "Base ref for `branch`. Defaults to HEAD." },
                    "agent": { "type": "string", "description": "Override the specialist's agent: `claude`, `codex`, or an ACP agent id from list_agents." },
                    "model": { "type": "string", "description": "Override the specialist's model." },
                    "effort": { "type": "string", "description": "Override the specialist's reasoning effort." },
                },
                "required": ["specialist", "prompt"],
            },
        },
        {
            "name": "ask_user",
            "description": "Put a decision that is the user's to them. They see it as a card in your chat with your options and recommendation and answer there; Aura sends you the answer as a message. Returns at once: end your turn after asking. Only for decisions that are truly the user's or for irreversible and outward-facing actions; decide everything else yourself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The decision, as one clear question." },
                    "context": { "type": "string", "description": "What the user needs to know to decide: the trade-offs and what each option leads to. Markdown." },
                    "options": {
                        "type": "array",
                        "description": "The choices, two to four. The user can also answer in their own words.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string" },
                                "description": { "type": "string" },
                            },
                            "required": ["label"],
                        },
                    },
                    "recommended": { "type": "string", "description": "The label of the option you recommend." },
                    "kind": { "type": "string", "enum": ["decision", "irreversible"], "description": "`decision` (default) for a decision that is the user's; `irreversible` to ask permission for an irreversible or outward-facing action such as merging, pushing, publishing, deleting or contacting people." },
                },
                "required": ["question"],
            },
        },
        {
            "name": "record_decision",
            "description": "Record a decision you or your team made that shapes the feature, with its rationale, in the feature's decision log the user reads.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "decision": { "type": "string", "description": "What was decided, in one sentence." },
                    "rationale": { "type": "string", "description": "Why, in a line or two." },
                    "meeting": { "type": "string", "description": "The id of the meeting it came out of, such as `m2`, so the user sees it as the meeting's outcome." },
                },
                "required": ["decision", "rationale"],
            },
        },
        {
            "name": "checkpoint",
            "description": "Report that the feature reached a stage. When the user's autonomy setting stops there, Aura asks the user to review it and you must wait for their answer; otherwise it is recorded and you carry on. The answer says which.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "checkpoint": { "type": "string", "enum": ["after_design", "before_implementation", "before_delivery"] },
                    "summary": { "type": "string", "description": "What there is to review and where: designs, plan, branch or worktree, how to look at it. Markdown." },
                },
                "required": ["checkpoint", "summary"],
            },
        },
        {
            "name": "propose_specialist",
            "description": "Propose a new reusable specialist when your team needs a role no specialist covers and other features will need it too. The user accepts (choosing global or project), edits or dismisses it in your chat.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "e.g. `Data engineer`." },
                    "role": { "type": "string", "description": "What it does, in a few words." },
                    "description": { "type": "string", "description": "What it is good at, for choosing whom to hire." },
                    "instructions": { "type": "string", "description": "Markdown for its system prompt: its role, the standards it works to, what it delivers and how it reports." },
                    "agent": { "type": "string" },
                    "model": { "type": "string" },
                    "effort": { "type": "string" },
                    "id": { "type": "string", "description": "A slug; made from the name when left out." },
                    "reason": { "type": "string", "description": "Why the team needs it." },
                },
                "required": ["name", "instructions", "reason"],
            },
        },
        {
            "name": "deliver_report",
            "description": "Deliver the finished feature to the user with a short report, shown as a card in your chat. Call it once, when the work is done and verified.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": { "type": "string", "description": "What was done, in a few bullets. Markdown." },
                    "why": { "type": "string", "description": "Why it was done this way: the decisions that shaped it." },
                    "how_to_test": { "type": "string", "description": "Steps for the user to try it." },
                    "where_to_test": { "type": "string", "description": "Where: branch, worktree path, URL or screen, and the command that runs it." },
                    "notes": { "type": "string", "description": "Known limits and follow-ups the user may want." },
                },
                "required": ["what", "why", "how_to_test", "where_to_test"],
            },
        },
        {
            "name": "feature_status",
            "description": "The feature's status, autonomy level, team, the questions still open with the user, meetings collecting answers and teammates waiting on you, as Aura has them.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "hold_meeting",
            "description": "Hold a meeting. Written: Aura sends every attendee your question at once, each answers in writing in its next turn, and you get all answers in one message from Aura. Live (only when the user allows it): you chair a thread in which the attendees speak in turn, round by round; after each round you continue_meeting or close_meeting. Returns at once: end your turn after calling it. For decisions that need several roles' views; every attendee costs a turn (per round, when live), so keep it to the two to four who matter.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "What the meeting is about, in a few words." },
                    "agenda": { "type": "string", "description": "The question every attendee answers, clear and self-contained. Markdown." },
                    "attendees": { "type": "array", "items": { "type": "string" }, "description": "Team members: session id, title or specialist id." },
                    "guests": { "type": "array", "items": { "type": "string" }, "description": "Specialist ids to hire just for their input to this meeting. They join the team." },
                    "context": { "type": "string", "description": "What the attendees need to know to answer: the options, constraints, files. They do not see your conversation." },
                    "cwd": { "type": "string", "description": "Where guests work. Defaults to your folder; required for guests when you have none." },
                    "timeout_minutes": { "type": "integer", "minimum": 1, "maximum": 120, "description": "How long to wait for answers; in a live meeting, for each round. Default 20." },
                    "mode": { "type": "string", "enum": ["written", "live"], "description": "Defaults to the mode the user set for meetings. `live` is refused when the user set meetings to written." },
                    "rounds": { "type": "integer", "minimum": 1, "maximum": 5, "description": "For a live meeting: the most rounds, up to the user's cap. Fewer is cheaper." },
                },
                "required": ["topic", "agenda"],
            },
        },
        {
            "name": "continue_meeting",
            "description": "Start the next round of a live meeting you chair, after its round notes came: your steer opens the round, and each attendee speaks in turn again. Only while the round cap allows; returns at once, end your turn after calling it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "meeting": { "type": "string", "description": "The meeting's id, such as `m2`." },
                    "steer": { "type": "string", "description": "What this round should settle, in a line or two: the open question, the conflict to resolve." },
                },
                "required": ["meeting", "steer"],
            },
        },
        {
            "name": "close_meeting",
            "description": "Close a meeting with its outcome, shown to the user in the Team tab. Ends a live meeting; a written one still collecting closes with the answers in, which Aura sends you. Record the decisions with record_decision and `meeting`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "meeting": { "type": "string", "description": "The meeting's id, such as `m2`." },
                    "outcome": { "type": "string", "description": "What the meeting settled, in a line or two." },
                },
                "required": ["meeting", "outcome"],
            },
        },
        {
            "name": "suggest_specialists",
            "description": "Have Aura look for roles that feature owners keep starting ad-hoc workers for, across features, and suggest them to the user as reusable specialists. Cheap: it runs a small model only when two ad-hoc briefs look alike. The user accepts, edits or dismisses each suggestion in your chat.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "reply_to_teammate",
            "description": "Answer a question a team member asked you with ask_owner. Aura passes the answer on; the member waits for it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question's id, such as `a3`, from the message that brought it." },
                    "answer": { "type": "string", "description": "Your answer, brief. Markdown." },
                },
                "required": ["question", "answer"],
            },
        },
    ])
}

/// A worker's tools when it is on a feature owner's team.
fn worker_tools() -> Value {
    json!([
        {
            "name": "list_team",
            "description": "List your team: the feature owner and your teammates, with their roles and whether they are working.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "ask_teammate",
            "description": "Ask a teammate a question, such as the designer about a state or the backend engineer about an API. It answers in its next turn and Aura brings you the answer as a message. Returns at once. Ask only what you cannot go on well without, and briefly.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "teammate": { "type": "string", "description": "The teammate's title, specialist id or session id, from list_team." },
                    "question": { "type": "string", "description": "One clear question with the context it needs; the teammate does not see your conversation." },
                },
                "required": ["teammate", "question"],
            },
        },
        {
            "name": "ask_owner",
            "description": "Ask the feature owner a question, for what only it can decide: scope, priorities, trade-offs between roles. Aura brings you its answer as a message. Returns at once.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "One clear question with the context it needs." },
                },
                "required": ["question"],
            },
        },
    ])
}

/// Every orchestrator's tools.
fn orchestrator_tools() -> Value {
    json!([
        {
            "name": "list_agents",
            "description": "List the coding agents you can start workers with: Claude Code, Codex and installed ACP agents, with their models and the reasoning efforts each model takes.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "list_projects",
            "description": "List the folders and git repositories the user's Aura sessions work in and the user's groups are linked to, most recently used first. Use one as `cwd` when you start a worker.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "start_session",
            "description": "Start a worker: a new Aura session running the given agent in a folder or repository, which starts on `prompt` right away. Workers can each work in a different repository. The worker does not see your conversation, so the prompt must be a complete brief. The user can open and message the worker too.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "`claude`, `codex`, or an ACP agent id from list_agents." },
                    "prompt": { "type": "string", "description": "The task, complete and self-contained." },
                    "title": { "type": "string", "description": "Short title shown in Aura's sidebar." },
                    "cwd": { "type": "string", "description": "Absolute path of the folder or repository the worker works in; list_projects shows the ones Aura knows. Required when you have no folder of your own; otherwise it defaults to your folder, and relative paths resolve against it." },
                    "branch": { "type": "string", "description": "Run the worker in a new git worktree of the repository at `cwd`, on this branch. Use one per worker when several change the same repository at once." },
                    "base": { "type": "string", "description": "Base ref for `branch` in that repository. Defaults to its HEAD." },
                    "model": { "type": "string", "description": "Model id from list_agents. Defaults to the agent's default." },
                    "effort": { "type": "string", "description": "Reasoning effort from list_agents, for models that have it." },
                },
                "required": ["agent", "prompt"],
            },
        },
        {
            "name": "send_message",
            "description": "Send one of your workers a message: a follow-up task, an answer or a correction. A worker that is busy gets it after its current step.",
            "inputSchema": {
                "type": "object",
                "properties": { "session": session_arg(), "text": { "type": "string" } },
                "required": ["session", "text"],
            },
        },
        {
            "name": "list_sessions",
            "description": "List your workers with their status, what they wait on and their last reply.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "read_session",
            "description": "Read a worker's recent conversation: the messages, its replies, and the commands it ran and files it changed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "turns": { "type": "integer", "minimum": 1, "description": "How many of the latest exchanges to show. Default 1." },
                },
                "required": ["session"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "wait_for_sessions",
            "description": "Wait until workers stop working (done, failed, or waiting on the user) and return their status and last replies. Workers returned here are not reported to you again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessions": { "type": "array", "items": { "type": "string" }, "description": "Workers to wait for. Default: all of yours." },
                    "mode": { "type": "string", "enum": ["all", "any"], "description": "`all` (default) waits for every one; `any` returns when the first stops." },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 3600, "description": "Default 600." },
                },
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "interrupt_session",
            "description": "Interrupt a worker's current turn.",
            "inputSchema": { "type": "object", "properties": { "session": session_arg() }, "required": ["session"] },
        },
        {
            "name": "stop_session",
            "description": "Stop a worker's agent process. The session and its history are kept; a new message resumes it.",
            "inputSchema": { "type": "object", "properties": { "session": session_arg() }, "required": ["session"] },
        },
        {
            "name": "delete_session",
            "description": "Delete one of your workers, as the user deletes a session in Aura: it is stopped and removed with its history, and so are the workers it started. Its git worktree and branch are kept. Only your own workers can be deleted.",
            "inputSchema": { "type": "object", "properties": { "session": session_arg() }, "required": ["session"] },
            "annotations": { "destructiveHint": true },
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(tools: &Value) -> Vec<&str> {
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn plain_orchestrators_keep_their_tools_and_only_feature_owners_get_the_owners() {
        assert_eq!(
            names(&tools(false)),
            [
                "list_agents",
                "list_projects",
                "start_session",
                "send_message",
                "list_sessions",
                "read_session",
                "wait_for_sessions",
                "interrupt_session",
                "stop_session",
                "delete_session"
            ]
        );
        let owner = tools(true);
        let owner = names(&owner);
        assert_eq!(&owner[..10], names(&tools(false)).as_slice());
        assert_eq!(
            &owner[10..],
            [
                "list_specialists",
                "hire",
                "ask_user",
                "record_decision",
                "checkpoint",
                "propose_specialist",
                "deliver_report",
                "feature_status",
                "hold_meeting",
                "continue_meeting",
                "close_meeting",
                "suggest_specialists",
                "reply_to_teammate"
            ]
        );
        assert_eq!(
            names(&worker_tools()),
            ["list_team", "ask_teammate", "ask_owner"]
        );
    }

    #[tokio::test]
    async fn a_plain_orchestrator_cannot_call_the_owners_tools() {
        let server = Server {
            data_dir: PathBuf::from("/nonexistent"),
            orchestrator: "o".into(),
            feature_owner: false,
            token: "t".into(),
            worker: false,
            client: Mutex::new(None),
        };
        let err = server.call("hire", &json!({})).await.unwrap_err();
        assert_eq!(err.to_string(), "unknown tool hire");
        let err = server.call("ask_teammate", &json!({})).await.unwrap_err();
        assert_eq!(err.to_string(), "unknown tool ask_teammate");
    }

    #[tokio::test]
    async fn a_teammate_has_only_the_teams_tools() {
        let server = Server {
            data_dir: PathBuf::from("/nonexistent"),
            orchestrator: "w".into(),
            feature_owner: false,
            worker: true,
            token: "t".into(),
            client: Mutex::new(None),
        };
        for tool in ["start_session", "hire", "hold_meeting"] {
            let err = server.call(tool, &json!({})).await.unwrap_err();
            assert_eq!(err.to_string(), format!("unknown tool {tool}"));
        }
        // Arguments are checked before the daemon is called.
        let err = server
            .call("ask_teammate", &json!({ "question": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "`teammate` is required");
    }

    #[test]
    fn list_arguments_take_a_single_string_too() {
        let a = json!({ "one": "tester", "many": ["a", "b"], "blank": " " });
        assert_eq!(strings(&a, "one"), ["tester"]);
        assert_eq!(strings(&a, "many"), ["a", "b"]);
        assert!(strings(&a, "blank").is_empty() && strings(&a, "none").is_empty());
    }

    #[test]
    fn models_are_listed_with_their_efforts_and_defaults() {
        let models = vec![
            ModelInfo {
                id: "big".into(),
                display_name: "Big".into(),
                description: Some("Strongest".into()),
                efforts: vec!["low".into(), "high".into()],
                default_effort: Some("high".into()),
                is_default: true,
            },
            ModelInfo {
                id: "small".into(),
                display_name: "small".into(),
                description: None,
                efforts: vec![],
                default_effort: None,
                is_default: false,
            },
        ];
        assert_eq!(
            describe_models(&models),
            "  - model `big` (Big), the default: Strongest; efforts: low, high (default high)\n  - model `small`\n"
        );
    }
}
