//! `aura mcp`: the orchestration tools as a stdio MCP server. Aura starts it
//! for every orchestrator session, whatever its agent, and it forwards each
//! tool call to the daemon's `orchestrator.*` methods.

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

struct Server {
    data_dir: PathBuf,
    orchestrator: String,
    client: Mutex<Option<RpcClient>>,
}

pub async fn run(data_dir: PathBuf, orchestrator: String) -> Result<()> {
    let server = Arc::new(Server {
        data_dir,
        orchestrator,
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
                    "instructions": "Start, direct and follow Aura worker sessions. Workers are normal Aura sessions the user can open and message too.",
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
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

    /// The daemon connection, re-established after the daemon restarts.
    async fn connected(&self) -> Result<RpcClient> {
        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
        let c = crate::connect_or_start(&self.data_dir).await?;
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

fn session_arg() -> Value {
    json!({ "type": "string", "description": "The worker's session id (a unique prefix is enough) or its exact title." })
}

fn tools() -> Value {
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
