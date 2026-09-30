//! Translates Codex app-server notifications and server requests for one
//! thread into Aura events. Pure state machine: no I/O, so it can be replayed
//! from captured traffic in tests.

use crate::client::{fallback_reply, Incoming, CLOSED};
use anyhow::{anyhow, Result};
use aura_core::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

struct PendingApproval {
    rpc_id: Value,
    method: String,
    available: Vec<Value>,
    proposed_amendment: Option<Value>,
    permissions: Option<Value>,
}

pub struct ThreadMapper {
    session_id: String,
    pub thread_id: String,
    active_turn: Option<String>,
    started_items: HashSet<String>,
    /// Last known fileChange item payloads, used to enrich approval requests.
    file_changes: HashMap<String, Value>,
    approvals: HashMap<String, PendingApproval>,
    inputs: HashMap<String, Value>,
    last_usage: Option<Usage>,
    approval_seq: u64,
}

/// Result of feeding one message: events to publish and an optional immediate
/// reply for a server request the mapper answered on its own.
pub struct Outcome {
    pub events: Vec<Event>,
    pub reply: Option<(Value, Value)>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}

fn epoch_secs(v: &Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    v.get(key).and_then(|x| x.as_i64()).and_then(|t| chrono::DateTime::from_timestamp(t, 0))
}

impl ThreadMapper {
    pub fn new(session_id: &str, thread_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            thread_id: thread_id.to_string(),
            active_turn: None,
            started_items: HashSet::new(),
            file_changes: HashMap::new(),
            approvals: HashMap::new(),
            inputs: HashMap::new(),
            last_usage: None,
            approval_seq: 0,
        }
    }

    pub fn active_turn(&self) -> Option<&str> {
        self.active_turn.as_deref()
    }

    pub fn pending_approval_ids(&self) -> Vec<String> {
        self.approvals.keys().cloned().collect()
    }

    fn sid(&self) -> String {
        self.session_id.clone()
    }

    /// Events describing the history of an already existing thread (resume).
    pub fn replay_thread(&mut self, thread: &Value) -> Vec<Event> {
        let mut out = vec![];
        if let Some(id) = s(thread, "id") {
            self.thread_id = id.clone();
            out.push(Event::NativeId { session_id: self.sid(), native_id: id });
        }
        out.push(Event::ProviderInfo {
            session_id: self.sid(),
            info: json!({ "kind": "thread", "thread": strip_turns(thread) }),
        });
        for turn in thread.get("turns").and_then(|t| t.as_array()).into_iter().flatten() {
            let turn_id = s(turn, "id");
            for item in turn.get("items").and_then(|i| i.as_array()).into_iter().flatten() {
                let mut it = self.map_item(item, turn_id.clone());
                if it.status == ItemStatus::InProgress {
                    it.status = ItemStatus::Completed;
                }
                it.ended_at = Some(it.started_at);
                out.push(Event::ItemCompleted { session_id: self.sid(), item: it });
            }
        }
        out
    }

    pub fn handle(&mut self, msg: &Incoming) -> Outcome {
        let mut ev = vec![];
        let mut reply = None;
        let p = &msg.params;
        let sid = self.sid();
        let turn_id = s(p, "turnId").or_else(|| self.active_turn.clone());
        match msg.method.as_str() {
            CLOSED => {
                self.active_turn = None;
                self.approvals.clear();
                self.inputs.clear();
                ev.push(Event::ProcessExited {
                    session_id: sid,
                    exit_code: None,
                    message: Some("codex app-server exited".into()),
                });
            }
            "thread/started" => {
                if let Some(thread) = p.get("thread") {
                    if let Some(id) = s(thread, "id") {
                        self.thread_id = id.clone();
                        ev.push(Event::NativeId { session_id: sid.clone(), native_id: id });
                    }
                    ev.push(Event::ProviderInfo {
                        session_id: sid,
                        info: json!({ "kind": "thread", "thread": strip_turns(thread) }),
                    });
                }
            }
            "turn/started" => {
                let turn = p.get("turn").cloned().unwrap_or(Value::Null);
                let id = s(&turn, "id").unwrap_or_else(aura_core::new_id);
                self.active_turn = Some(id.clone());
                ev.push(Event::TurnStarted {
                    session_id: sid,
                    turn: Turn {
                        id,
                        session_id: self.session_id.clone(),
                        status: TurnStatus::Running,
                        started_at: epoch_secs(&turn, "startedAt").unwrap_or_else(aura_core::now),
                        ended_at: None,
                        usage: None,
                        error: None,
                    },
                });
            }
            "turn/completed" => {
                let turn = p.get("turn").cloned().unwrap_or(Value::Null);
                let id = s(&turn, "id").or_else(|| self.active_turn.clone()).unwrap_or_else(aura_core::new_id);
                let status = match s(&turn, "status").as_deref() {
                    Some("interrupted") => TurnStatus::Interrupted,
                    Some("failed") => TurnStatus::Failed,
                    _ => TurnStatus::Completed,
                };
                let error = turn.get("error").filter(|e| !e.is_null()).map(|e| {
                    s(e, "message").unwrap_or_else(|| e.to_string())
                });
                // Items included in the completed turn are authoritative.
                for item in turn.get("items").and_then(|i| i.as_array()).into_iter().flatten() {
                    let iid = s(item, "id").unwrap_or_default();
                    if !self.started_items.contains(&iid) {
                        continue; // already delivered via item/completed or never streamed
                    }
                }
                self.active_turn = None;
                self.started_items.clear();
                ev.push(Event::TurnCompleted {
                    session_id: sid,
                    turn: Turn {
                        id,
                        session_id: self.session_id.clone(),
                        status,
                        started_at: epoch_secs(&turn, "startedAt").unwrap_or_else(aura_core::now),
                        ended_at: Some(epoch_secs(&turn, "completedAt").unwrap_or_else(aura_core::now)),
                        usage: self.last_usage.clone(),
                        error,
                    },
                });
            }
            "item/started" => {
                if let Some(item) = p.get("item") {
                    let it = self.map_item(item, turn_id);
                    self.started_items.insert(it.id.clone());
                    if it.kind == ItemKind::FileChange {
                        self.file_changes.insert(it.id.clone(), it.data.clone());
                    }
                    ev.push(Event::ItemStarted { session_id: sid, item: it });
                }
            }
            "item/completed" => {
                if let Some(item) = p.get("item") {
                    let mut it = self.map_item(item, turn_id);
                    if it.kind == ItemKind::FileChange {
                        self.file_changes.insert(it.id.clone(), it.data.clone());
                    }
                    if !self.started_items.contains(&it.id) {
                        let mut started = it.clone();
                        started.status = ItemStatus::InProgress;
                        started.ended_at = None;
                        ev.push(Event::ItemStarted { session_id: sid.clone(), item: started });
                    }
                    self.started_items.remove(&it.id);
                    if it.status == ItemStatus::InProgress {
                        it.status = ItemStatus::Completed;
                    }
                    it.ended_at = Some(aura_core::now());
                    ev.push(Event::ItemCompleted { session_id: sid, item: it });
                }
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                let kind = if msg.method == "item/plan/delta" { ItemKind::Plan } else { ItemKind::AgentMessage };
                self.delta(&mut ev, p, turn_id, kind, |text| ItemDelta::Text { text });
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                self.delta(&mut ev, p, turn_id, ItemKind::Reasoning, |text| ItemDelta::Text { text });
            }
            "item/reasoning/summaryPartAdded" => {
                if let Some(iid) = s(p, "itemId") {
                    if self.started_items.contains(&iid) {
                        ev.push(Event::ItemDelta {
                            session_id: sid,
                            item_id: iid,
                            delta: ItemDelta::Text { text: "\n\n".into() },
                        });
                    }
                }
            }
            "item/commandExecution/outputDelta" => {
                self.delta(&mut ev, p, turn_id, ItemKind::CommandExec, |text| ItemDelta::Output { text });
            }
            "item/fileChange/outputDelta" => {
                self.delta(&mut ev, p, turn_id, ItemKind::FileChange, |text| ItemDelta::Output { text });
            }
            "item/fileChange/patchUpdated" => {
                if let Some(iid) = s(p, "itemId") {
                    let changes = p.get("changes").cloned().unwrap_or(Value::Null);
                    let data = json!({ "changes": map_changes(&changes) });
                    self.file_changes.insert(iid.clone(), data.clone());
                    ev.push(Event::ItemDelta { session_id: sid, item_id: iid, delta: ItemDelta::Data { data } });
                }
            }
            "item/commandExecution/terminalInteraction" => {
                if let Some(iid) = s(p, "itemId") {
                    if let Some(stdin) = s(p, "stdin") {
                        ev.push(Event::ItemDelta {
                            session_id: sid,
                            item_id: iid,
                            delta: ItemDelta::Output { text: stdin },
                        });
                    }
                }
            }
            "item/mcpToolCall/progress" => {
                if let Some(iid) = s(p, "itemId") {
                    ev.push(Event::ItemDelta {
                        session_id: sid,
                        item_id: iid,
                        delta: ItemDelta::Data { data: json!({ "progress": p.get("message").cloned().unwrap_or(Value::Null) }) },
                    });
                }
            }
            "item/commandExecution/requestApproval" => {
                let id = self.next_approval_id();
                let command = s(p, "command").unwrap_or_default();
                let available = p.get("availableDecisions").and_then(|a| a.as_array()).cloned().unwrap_or_default();
                let options = decisions_to_options(&available);
                self.approvals.insert(
                    id.clone(),
                    PendingApproval {
                        rpc_id: msg.id.clone().unwrap_or(Value::Null),
                        method: msg.method.clone(),
                        available: available.clone(),
                        proposed_amendment: p.get("proposedExecpolicyAmendment").cloned().filter(|v| !v.is_null()),
                        permissions: None,
                    },
                );
                ev.push(Event::ApprovalRequested {
                    session_id: sid,
                    approval: Approval {
                        id,
                        session_id: self.session_id.clone(),
                        turn_id,
                        item_id: s(p, "itemId"),
                        kind: ApprovalKind::Command,
                        title: command.clone(),
                        description: s(p, "reason"),
                        payload: json!({
                            "command": command,
                            "cwd": p.get("cwd").cloned().unwrap_or(Value::Null),
                            "commandActions": p.get("commandActions").cloned().unwrap_or(json!([])),
                            "proposedExecpolicyAmendment": p.get("proposedExecpolicyAmendment").cloned().unwrap_or(Value::Null),
                            "availableDecisions": available,
                        }),
                        options,
                        created_at: aura_core::now(),
                    },
                });
            }
            "item/fileChange/requestApproval" => {
                let id = self.next_approval_id();
                let item_id = s(p, "itemId");
                let changes = item_id
                    .as_ref()
                    .and_then(|i| self.file_changes.get(i))
                    .and_then(|d| d.get("changes").cloned())
                    .unwrap_or(json!([]));
                let n = changes.as_array().map(|a| a.len()).unwrap_or(0);
                let first = changes.get(0).and_then(|c| s(c, "path"));
                let title = match (n, first) {
                    (1, Some(path)) => format!("Apply changes to {path}"),
                    (0, _) => "Apply file changes".to_string(),
                    (n, Some(path)) => format!("Apply changes to {path} and {} more", n - 1),
                    (n, None) => format!("Apply changes to {n} files"),
                };
                self.approvals.insert(
                    id.clone(),
                    PendingApproval {
                        rpc_id: msg.id.clone().unwrap_or(Value::Null),
                        method: msg.method.clone(),
                        available: vec![],
                        proposed_amendment: None,
                        permissions: None,
                    },
                );
                ev.push(Event::ApprovalRequested {
                    session_id: sid,
                    approval: Approval {
                        id,
                        session_id: self.session_id.clone(),
                        turn_id,
                        item_id,
                        kind: ApprovalKind::FileChange,
                        title,
                        description: s(p, "reason"),
                        payload: json!({ "changes": changes, "grantRoot": p.get("grantRoot").cloned().unwrap_or(Value::Null) }),
                        options: vec![
                            ApprovalOption::Accept,
                            ApprovalOption::AcceptForSession,
                            ApprovalOption::Decline,
                            ApprovalOption::Cancel,
                        ],
                        created_at: aura_core::now(),
                    },
                });
            }
            "item/permissions/requestApproval" => {
                let id = self.next_approval_id();
                let perms = p.get("permissions").cloned().unwrap_or(json!({}));
                self.approvals.insert(
                    id.clone(),
                    PendingApproval {
                        rpc_id: msg.id.clone().unwrap_or(Value::Null),
                        method: msg.method.clone(),
                        available: vec![],
                        proposed_amendment: None,
                        permissions: Some(perms.clone()),
                    },
                );
                ev.push(Event::ApprovalRequested {
                    session_id: sid,
                    approval: Approval {
                        id,
                        session_id: self.session_id.clone(),
                        turn_id,
                        item_id: s(p, "itemId"),
                        kind: ApprovalKind::Permission,
                        title: "Grant additional permissions".into(),
                        description: s(p, "reason"),
                        payload: json!({ "permissions": perms, "cwd": p.get("cwd").cloned().unwrap_or(Value::Null) }),
                        options: vec![ApprovalOption::Accept, ApprovalOption::AcceptForSession, ApprovalOption::Decline],
                        created_at: aura_core::now(),
                    },
                });
            }
            "item/tool/requestUserInput" => {
                let id = format!("codex-input-{}", msg.id.clone().unwrap_or(Value::Null));
                self.inputs.insert(id.clone(), msg.id.clone().unwrap_or(Value::Null));
                let questions = p
                    .get("questions")
                    .and_then(|q| q.as_array())
                    .map(|qs| {
                        qs.iter()
                            .map(|q| Question {
                                id: s(q, "id").unwrap_or_else(aura_core::new_id),
                                header: s(q, "header"),
                                question: s(q, "question").unwrap_or_default(),
                                options: q
                                    .get("options")
                                    .and_then(|o| o.as_array())
                                    .map(|os| {
                                        os.iter()
                                            .map(|o| QuestionOption { label: s(o, "label").unwrap_or_default(), description: s(o, "description") })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                multi_select: false,
                                allow_free_text: q.get("isOther").and_then(|b| b.as_bool()).unwrap_or(false)
                                    || q.get("options").map(|o| o.is_null()).unwrap_or(true),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                ev.push(Event::UserInputRequested {
                    session_id: sid,
                    request: UserInputRequest {
                        id,
                        session_id: self.session_id.clone(),
                        turn_id,
                        item_id: s(p, "itemId"),
                        questions,
                        created_at: aura_core::now(),
                    },
                });
            }
            "mcpServer/elicitation/request" => {
                ev.push(Event::Notice {
                    session_id: sid,
                    level: NoticeLevel::Warn,
                    message: format!(
                        "MCP server {} asked for input ({}); Aura declined it. Use terminal mode for MCP elicitations.",
                        s(p, "serverName").unwrap_or_default(),
                        s(p, "message").unwrap_or_default()
                    ),
                });
                if let Some(id) = &msg.id {
                    reply = Some((id.clone(), json!({ "action": "decline" })));
                }
            }
            "turn/diff/updated" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "turn_diff", "turn_id": turn_id, "diff": p.get("diff").cloned().unwrap_or(Value::Null) }),
            }),
            "turn/plan/updated" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "plan", "turn_id": turn_id, "plan": p.get("plan").cloned().unwrap_or(Value::Null), "explanation": p.get("explanation").cloned().unwrap_or(Value::Null) }),
            }),
            "thread/tokenUsage/updated" => {
                if let Some(tu) = p.get("tokenUsage") {
                    let total = tu.get("total").cloned().unwrap_or(Value::Null);
                    let usage = Usage {
                        input_tokens: total.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        output_tokens: total.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        cached_input_tokens: total.get("cachedInputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        total_cost_usd: None,
                        context_window: tu.get("modelContextWindow").and_then(|v| v.as_u64()),
                        context_used: tu.get("last").and_then(|l| l.get("totalTokens")).and_then(|v| v.as_u64()),
                    };
                    self.last_usage = Some(usage.clone());
                    ev.push(Event::Usage { session_id: sid, usage });
                }
            }
            "account/rateLimits/updated" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "rate_limits", "rateLimits": p.get("rateLimits").cloned().unwrap_or(Value::Null) }),
            }),
            "thread/status/changed" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "thread_status", "status": p.get("status").cloned().unwrap_or(Value::Null) }),
            }),
            "thread/name/updated" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "name", "name": p.get("name").cloned().unwrap_or(Value::Null) }),
            }),
            "hook/started" | "hook/completed" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "hook", "phase": msg.method.rsplit('/').next().unwrap_or(""), "run": p.get("run").cloned().unwrap_or(Value::Null) }),
            }),
            "mcpServer/startupStatus/updated" => ev.push(Event::ProviderInfo {
                session_id: sid,
                info: json!({ "kind": "mcp_status", "name": p.get("name").cloned().unwrap_or(Value::Null), "status": p.get("status").cloned().unwrap_or(Value::Null), "error": p.get("error").cloned().unwrap_or(Value::Null) }),
            }),
            "model/rerouted" | "warning" | "configWarning" | "model/verification" => {
                let message = s(p, "message")
                    .or_else(|| s(p, "summary"))
                    .or_else(|| p.get("toModel").and_then(|m| m.as_str()).map(|m| format!("Rerouted to model {m}")))
                    .unwrap_or_else(|| format!("{}: {}", msg.method, p));
                ev.push(Event::Notice { session_id: sid, level: NoticeLevel::Warn, message });
            }
            "serverRequest/resolved" | "thread/archived" | "thread/unarchived" | "thread/closed"
            | "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" | "model/safetyBuffering/updated" => {
                ev.push(Event::ProviderInfo {
                    session_id: sid,
                    info: json!({ "kind": msg.method, "params": p }),
                });
            }
            other => {
                if let Some(id) = &msg.id {
                    tracing::warn!("codex: unhandled server request {other}; answering safely");
                    reply = Some((id.clone(), fallback_reply(other)));
                } else {
                    tracing::trace!("codex: unhandled notification {other}");
                }
            }
        }
        Outcome { events: ev, reply }
    }

    fn delta(
        &mut self,
        ev: &mut Vec<Event>,
        p: &Value,
        turn_id: Option<String>,
        kind: ItemKind,
        make: impl Fn(String) -> ItemDelta,
    ) {
        let Some(iid) = s(p, "itemId") else { return };
        let text = s(p, "delta").unwrap_or_default();
        if !self.started_items.contains(&iid) {
            self.started_items.insert(iid.clone());
            ev.push(Event::ItemStarted {
                session_id: self.sid(),
                item: Item::new(&self.session_id, turn_id, kind).with_id(iid.clone()),
            });
        }
        ev.push(Event::ItemDelta { session_id: self.sid(), item_id: iid, delta: make(text) });
    }

    fn next_approval_id(&mut self) -> String {
        self.approval_seq += 1;
        format!("codex-approval-{}-{}", self.approval_seq, aura_core::new_id())
    }

    /// Build the JSON-RPC reply for an approval decision. Returns (rpc id, result).
    pub fn approval_reply(&mut self, approval_id: &str, d: &ApprovalDecision) -> Result<(Value, Value)> {
        let pa = self.approvals.remove(approval_id).ok_or_else(|| anyhow!("unknown approval {approval_id}"))?;
        let result = match pa.method.as_str() {
            "item/permissions/requestApproval" => match d.option {
                ApprovalOption::Accept | ApprovalOption::EditInput => {
                    json!({ "permissions": pa.permissions.clone().unwrap_or(json!({})), "scope": "turn" })
                }
                ApprovalOption::AcceptForSession => {
                    json!({ "permissions": pa.permissions.clone().unwrap_or(json!({})), "scope": "session" })
                }
                ApprovalOption::Decline | ApprovalOption::Cancel => json!({ "permissions": {} }),
            },
            _ => {
                let has = |name: &str| pa.available.iter().any(|v| v.as_str() == Some(name));
                let amendment = pa
                    .available
                    .iter()
                    .find(|v| v.get("acceptWithExecpolicyAmendment").is_some())
                    .cloned()
                    .or_else(|| {
                        pa.proposed_amendment
                            .clone()
                            .map(|a| json!({ "acceptWithExecpolicyAmendment": { "execpolicy_amendment": a } }))
                    });
                let decision = match d.option {
                    ApprovalOption::Accept | ApprovalOption::EditInput => json!("accept"),
                    ApprovalOption::AcceptForSession => {
                        if pa.available.is_empty() || has("acceptForSession") {
                            json!("acceptForSession")
                        } else if let Some(a) = amendment {
                            a
                        } else {
                            json!("accept")
                        }
                    }
                    ApprovalOption::Decline => {
                        if pa.available.is_empty() || has("decline") {
                            json!("decline")
                        } else {
                            json!("cancel")
                        }
                    }
                    ApprovalOption::Cancel => json!("cancel"),
                };
                json!({ "decision": decision })
            }
        };
        Ok((pa.rpc_id, result))
    }

    pub fn input_reply(&mut self, resp: &UserInputResponse) -> Result<(Value, Value)> {
        let rpc_id = self.inputs.remove(&resp.request_id).ok_or_else(|| anyhow!("unknown input request {}", resp.request_id))?;
        let answers: serde_json::Map<String, Value> = resp
            .answers
            .iter()
            .map(|(k, v)| (k.clone(), json!({ "answers": v })))
            .collect();
        Ok((rpc_id, json!({ "answers": answers })))
    }

    pub fn map_item(&self, item: &Value, turn_id: Option<String>) -> Item {
        let id = s(item, "id").unwrap_or_else(aura_core::new_id);
        let ty = s(item, "type").unwrap_or_default();
        let status_of = |key_status: Option<&str>| match key_status {
            Some("inProgress") => ItemStatus::InProgress,
            Some("failed") | Some("declined") => ItemStatus::Failed,
            _ => ItemStatus::Completed,
        };
        let st = s(item, "status");
        let mut it = Item::new(&self.session_id, turn_id, ItemKind::System).with_id(id);
        match ty.as_str() {
            "userMessage" => {
                it.kind = ItemKind::UserMessage;
                it.text = item
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|cs| cs.iter().filter_map(|c| s(c, "text")).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                it.data = json!({ "content": item.get("content").cloned().unwrap_or(json!([])) });
                it.status = ItemStatus::Completed;
            }
            "agentMessage" => {
                it.kind = ItemKind::AgentMessage;
                it.text = s(item, "text").unwrap_or_default();
                it.data = json!({ "phase": item.get("phase").cloned().unwrap_or(Value::Null) });
                it.status = ItemStatus::Completed;
            }
            "reasoning" => {
                it.kind = ItemKind::Reasoning;
                let join = |k: &str| {
                    item.get(k)
                        .and_then(|a| a.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n\n"))
                        .unwrap_or_default()
                };
                let summary = join("summary");
                it.text = if summary.is_empty() { join("content") } else { summary };
                it.status = ItemStatus::Completed;
            }
            "commandExecution" => {
                it.kind = ItemKind::CommandExec;
                let command = s(item, "command").unwrap_or_default();
                it.title = Some(command.clone());
                it.data = json!({
                    "command": command,
                    "cwd": item.get("cwd").cloned().unwrap_or(Value::Null),
                    "output": item.get("aggregatedOutput").and_then(|o| o.as_str()).unwrap_or(""),
                    "exit_code": item.get("exitCode").cloned().unwrap_or(Value::Null),
                    "duration_ms": item.get("durationMs").cloned().unwrap_or(Value::Null),
                    "command_actions": item.get("commandActions").cloned().unwrap_or(json!([])),
                    "status": st,
                });
                it.status = status_of(st.as_deref());
            }
            "fileChange" => {
                it.kind = ItemKind::FileChange;
                let changes = map_changes(item.get("changes").unwrap_or(&Value::Null));
                let n = changes.as_array().map(|a| a.len()).unwrap_or(0);
                it.title = Some(if n == 1 {
                    changes[0].get("path").and_then(|p| p.as_str()).unwrap_or("1 file").to_string()
                } else {
                    format!("{n} files")
                });
                it.data = json!({ "changes": changes, "status": st });
                it.status = status_of(st.as_deref());
            }
            "plan" => {
                it.kind = ItemKind::Plan;
                it.text = s(item, "text").unwrap_or_default();
                it.status = ItemStatus::Completed;
            }
            "mcpToolCall" => {
                it.kind = ItemKind::McpCall;
                let server = s(item, "server").unwrap_or_default();
                let tool = s(item, "tool").unwrap_or_default();
                it.title = Some(format!("{server}.{tool}"));
                let is_error = item.get("error").map(|e| !e.is_null()).unwrap_or(false);
                it.data = json!({
                    "server": server,
                    "tool": tool,
                    "input": item.get("arguments").cloned().unwrap_or(Value::Null),
                    "result": item.get("result").cloned().unwrap_or(Value::Null),
                    "error": item.get("error").cloned().unwrap_or(Value::Null),
                    "is_error": is_error,
                });
                it.status = if is_error { ItemStatus::Failed } else { status_of(st.as_deref()) };
            }
            "dynamicToolCall" => {
                it.kind = ItemKind::ToolCall;
                let tool = s(item, "tool").unwrap_or_default();
                it.title = Some(tool.clone());
                let is_error = item.get("success").and_then(|b| b.as_bool()) == Some(false);
                it.data = json!({
                    "tool_name": tool,
                    "input": item.get("arguments").cloned().unwrap_or(Value::Null),
                    "result": item.get("contentItems").cloned().unwrap_or(Value::Null),
                    "is_error": is_error,
                });
                it.status = if is_error { ItemStatus::Failed } else { status_of(st.as_deref()) };
            }
            "collabAgentToolCall" => {
                it.kind = ItemKind::ToolCall;
                let tool = item.get("tool").and_then(|t| t.as_str()).unwrap_or("collab").to_string();
                it.title = Some(tool.clone());
                it.data = json!({
                    "tool_name": tool,
                    "input": { "prompt": item.get("prompt").cloned().unwrap_or(Value::Null), "receiverThreadIds": item.get("receiverThreadIds").cloned().unwrap_or(Value::Null) },
                    "result": item.get("agentsStates").cloned().unwrap_or(Value::Null),
                    "is_error": false,
                });
                it.status = status_of(st.as_deref());
            }
            "subAgentActivity" => {
                it.kind = ItemKind::Subagent;
                it.title = s(item, "agentPath");
                it.data = json!({ "description": item.get("kind").cloned().unwrap_or(Value::Null), "agent_thread_id": item.get("agentThreadId").cloned().unwrap_or(Value::Null) });
                it.status = ItemStatus::Completed;
            }
            "imageView" => {
                it.kind = ItemKind::ToolCall;
                it.title = Some("view image".into());
                it.data = json!({ "tool_name": "image_view", "input": { "path": item.get("path").cloned().unwrap_or(Value::Null) }, "is_error": false });
                it.status = ItemStatus::Completed;
            }
            "webSearch" => {
                it.kind = ItemKind::WebSearch;
                let q = s(item, "query").unwrap_or_default();
                it.title = Some(q.clone());
                it.data = json!({ "query": q, "results": item.get("results").cloned().unwrap_or(Value::Null), "action": item.get("action").cloned().unwrap_or(Value::Null) });
                it.status = ItemStatus::Completed;
            }
            "error" => {
                it.kind = ItemKind::Error;
                it.text = s(item, "message").unwrap_or_default();
                it.data = json!({ "message": it.text });
                it.status = ItemStatus::Failed;
            }
            "contextCompaction" => {
                it.title = Some("Context compacted".into());
                it.data = json!({ "boundary": "compact", "message": "Context compacted" });
                it.status = ItemStatus::Completed;
            }
            "enteredReviewMode" | "exitedReviewMode" => {
                let label = if ty == "enteredReviewMode" { "Entered review mode" } else { "Exited review mode" };
                it.title = Some(label.into());
                it.text = s(item, "review").unwrap_or_default();
                it.data = json!({ "message": label, "review": it.text });
                it.status = ItemStatus::Completed;
            }
            _ => {
                it.title = Some(ty.clone());
                it.data = json!({ "message": format!("Unsupported Codex item `{ty}`"), "raw": item });
                it.status = status_of(st.as_deref());
            }
        }
        if it.status != ItemStatus::InProgress {
            it.ended_at = Some(aura_core::now());
        }
        it
    }
}

fn strip_turns(thread: &Value) -> Value {
    let mut t = thread.clone();
    if let Some(o) = t.as_object_mut() {
        o.remove("turns");
    }
    t
}

fn map_changes(changes: &Value) -> Value {
    let arr = changes
        .as_array()
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    let kind = c.get("kind");
                    let kind_str = kind
                        .and_then(|k| k.as_str().map(|s| s.to_string()).or_else(|| s(k, "type")))
                        .unwrap_or_else(|| "update".into());
                    let kind_norm = match kind_str.as_str() {
                        "add" => "add",
                        "delete" => "delete",
                        _ => "modify",
                    };
                    json!({
                        "path": c.get("path").cloned().unwrap_or(Value::Null),
                        "kind": kind_norm,
                        "diff": c.get("diff").cloned().unwrap_or(Value::Null),
                        "move_path": kind.and_then(|k| k.get("move_path")).cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(arr)
}

fn decisions_to_options(available: &[Value]) -> Vec<ApprovalOption> {
    let mut opts: Vec<ApprovalOption> = vec![];
    fn push(opts: &mut Vec<ApprovalOption>, o: ApprovalOption) {
        if !opts.contains(&o) {
            opts.push(o);
        }
    }
    for d in available {
        match d.as_str() {
            Some("accept") => push(&mut opts, ApprovalOption::Accept),
            Some("acceptForSession") => push(&mut opts, ApprovalOption::AcceptForSession),
            Some("decline") => push(&mut opts, ApprovalOption::Decline),
            Some("cancel") => push(&mut opts, ApprovalOption::Cancel),
            None if d.get("acceptWithExecpolicyAmendment").is_some() => push(&mut opts, ApprovalOption::AcceptForSession),
            _ => {}
        }
    }
    if opts.is_empty() {
        push(&mut opts, ApprovalOption::Accept);
        push(&mut opts, ApprovalOption::AcceptForSession);
    }
    push(&mut opts, ApprovalOption::Decline);
    push(&mut opts, ApprovalOption::Cancel);
    // Stable, user-friendly ordering.
    let order = [
        ApprovalOption::Accept,
        ApprovalOption::AcceptForSession,
        ApprovalOption::EditInput,
        ApprovalOption::Decline,
        ApprovalOption::Cancel,
    ];
    let mut sorted = vec![];
    for o in order {
        if opts.contains(&o) {
            sorted.push(o);
        }
    }
    sorted
}
