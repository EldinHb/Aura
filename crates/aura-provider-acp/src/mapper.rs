//! Translates one ACP session's `session/update` notifications and
//! `session/request_permission` requests into Aura events. Pure state, no I/O:
//! the driver feeds it messages in arrival order and forwards what comes out.
//!
//! ACP streams message and thought text as chunks with no explicit end, so a
//! message item stays open until something else happens (a tool call, a plan,
//! a different kind of chunk, or the end of the turn) and is completed then.
//! Tool calls arrive as `tool_call` and are revised by `tool_call_update`
//! messages whose fields replace the earlier ones; the merged raw object is
//! kept per tool call and the Aura item is rebuilt from it every time.

use anyhow::{anyhow, Result};
use aura_core::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// How a `session/prompt` request ended.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    /// The agent answered with this `stopReason`.
    Stopped(String),
    /// The request failed (agent error or the process died).
    Failed(String),
}

struct Stream {
    item: Item,
    message_id: Option<String>,
}

struct Tool {
    raw: Map<String, Value>,
    item: Item,
}

struct PendingPermission {
    rpc_id: Value,
    /// (optionId, kind) as offered by the agent.
    options: Vec<(String, String)>,
}

#[derive(Default)]
struct AgentState {
    agent: Value,
    modes: Option<Value>,
    config_options: Vec<Value>,
    commands: Vec<Value>,
    title: Option<String>,
}

pub struct SessionMapper {
    session_id: String,
    turn: Option<Turn>,
    stream: Option<Stream>,
    tools: HashMap<String, Tool>,
    plan: Option<Item>,
    approvals: HashMap<String, PendingPermission>,
    usage: Usage,
    /// Session usage when the open turn began, to tell what it spent.
    turn_start_usage: Usage,
    state: AgentState,
    /// True while `session/load` replays history Aura already has: content
    /// updates are dropped, session state (modes, options, commands) is kept.
    pub replaying: bool,
}

impl SessionMapper {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            turn: None,
            stream: None,
            tools: HashMap::new(),
            plan: None,
            approvals: HashMap::new(),
            usage: Usage::default(),
            turn_start_usage: Usage::default(),
            state: AgentState::default(),
            replaying: false,
        }
    }

    fn sid(&self) -> String {
        self.session_id.clone()
    }

    fn turn_id(&self) -> Option<String> {
        self.turn.as_ref().map(|t| t.id.clone())
    }

    pub fn turn_active(&self) -> bool {
        self.turn.is_some()
    }

    // ------------------------------------------------------------------ turns

    /// A prompt is about to be sent: open a turn and record the user message.
    pub fn begin_turn(&mut self, text: &str, images: usize) -> Vec<Event> {
        let mut out = self.close_stream();
        let turn = Turn {
            id: new_id(),
            session_id: self.sid(),
            status: TurnStatus::Running,
            started_at: now(),
            ended_at: None,
            usage: None,
            error: None,
        };
        self.turn = Some(turn.clone());
        self.turn_start_usage = self.usage.clone();
        out.push(Event::TurnStarted {
            session_id: self.sid(),
            turn,
        });
        let mut item =
            Item::new(&self.session_id, self.turn_id(), ItemKind::UserMessage).with_text(text);
        if images > 0 {
            item.data = json!({ "images": images });
        }
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.completed(),
        });
        out
    }

    pub fn end_turn(&mut self, outcome: TurnOutcome) -> Vec<Event> {
        let mut out = self.close_stream();
        let (status, error) = match &outcome {
            TurnOutcome::Stopped(r) if r == "cancelled" => (TurnStatus::Interrupted, None),
            TurnOutcome::Stopped(_) => (TurnStatus::Completed, None),
            TurnOutcome::Failed(e) => (TurnStatus::Failed, Some(e.clone())),
        };
        let clean = status == TurnStatus::Completed;
        if let Some(plan) = self.plan.take() {
            out.push(Event::ItemCompleted {
                session_id: self.sid(),
                item: plan.completed(),
            });
        }
        let mut open: Vec<Tool> = self
            .tools
            .drain()
            .map(|(_, t)| t)
            .filter(|t| t.item.status == ItemStatus::InProgress)
            .collect();
        open.sort_by_key(|t| t.item.started_at);
        for t in open {
            let item = if clean {
                t.item.completed()
            } else {
                t.item.failed()
            };
            out.push(Event::ItemCompleted {
                session_id: self.sid(),
                item,
            });
        }
        if let TurnOutcome::Stopped(reason) = &outcome {
            let note = match reason.as_str() {
                "max_tokens" => Some("The agent stopped: it reached its token limit."),
                "max_turn_requests" => {
                    Some("The agent stopped: it reached its limit of model requests for one turn.")
                }
                "refusal" => Some("The agent refused to continue."),
                _ => None,
            };
            if let Some(message) = note {
                out.push(Event::Notice {
                    session_id: self.sid(),
                    level: NoticeLevel::Warn,
                    message: message.into(),
                });
            }
        }
        if let Some(mut turn) = self.turn.take() {
            turn.status = status;
            turn.ended_at = Some(now());
            turn.error = error;
            turn.usage = Some(self.usage.since(&self.turn_start_usage));
            out.push(Event::TurnCompleted {
                session_id: self.sid(),
                turn,
            });
        }
        out
    }

    fn close_stream(&mut self) -> Vec<Event> {
        match self.stream.take() {
            Some(s) => vec![Event::ItemCompleted {
                session_id: self.sid(),
                item: s.item.completed(),
            }],
            None => vec![],
        }
    }

    // ---------------------------------------------------------------- updates

    /// One `session/update` payload (the `update` object).
    pub fn handle_update(&mut self, update: &Value) -> Vec<Event> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "available_commands_update" => {
                self.state.commands = arr(update, "availableCommands");
                vec![self.info_event()]
            }
            "current_mode_update" => {
                let Some(id) = str_of(update, "currentModeId") else {
                    return vec![];
                };
                if let Some(Value::Object(m)) = self.state.modes.as_mut() {
                    m.insert("currentModeId".into(), json!(id));
                }
                vec![self.setting(Setting::PermissionMode(id)), self.info_event()]
            }
            "config_option_update" => self.set_config_options(arr(update, "configOptions")),
            "session_info_update" => {
                if let Some(t) = str_of(update, "title") {
                    self.state.title = Some(t);
                }
                vec![self.info_event()]
            }
            "usage_update" => {
                self.usage.context_used = update.get("used").and_then(Value::as_u64);
                self.usage.context_window = update.get("size").and_then(Value::as_u64);
                if let Some(cost) = update
                    .get("cost")
                    .filter(|c| c.get("currency").and_then(Value::as_str) == Some("USD"))
                {
                    self.usage.total_cost_usd = cost.get("amount").and_then(Value::as_f64);
                }
                vec![Event::Usage {
                    session_id: self.sid(),
                    usage: self.usage.clone(),
                }]
            }
            _ if self.replaying => vec![],
            "agent_message_chunk" => self.chunk(ItemKind::AgentMessage, update),
            "agent_thought_chunk" => self.chunk(ItemKind::Reasoning, update),
            // Echoes of what the user typed. Aura records the prompt itself in
            // `begin_turn`; outside a replay these carry nothing new.
            "user_message_chunk" => vec![],
            "tool_call" | "tool_call_update" => {
                let mut out = self.close_stream();
                out.extend(self.tool_update(update).1);
                out
            }
            "plan" => {
                let mut out = self.close_stream();
                out.push(self.plan_update(update));
                out
            }
            other => {
                tracing::debug!("acp: unhandled session update {other}");
                vec![]
            }
        }
    }

    fn chunk(&mut self, kind: ItemKind, update: &Value) -> Vec<Event> {
        let text = update.get("content").map(content_text).unwrap_or_default();
        if text.is_empty() {
            return vec![];
        }
        let message_id = str_of(update, "messageId");
        let continues = self
            .stream
            .as_ref()
            .map(|s| s.item.kind == kind && (message_id.is_none() || s.message_id == message_id))
            .unwrap_or(false);
        if continues {
            let s = self.stream.as_mut().expect("checked above");
            s.item.text.push_str(&text);
            let item_id = s.item.id.clone();
            return vec![Event::ItemDelta {
                session_id: self.sid(),
                item_id,
                delta: ItemDelta::Text { text },
            }];
        }
        let mut out = self.close_stream();
        let item = Item::new(&self.session_id, self.turn_id(), kind).with_text(text);
        out.push(Event::ItemStarted {
            session_id: self.sid(),
            item: item.clone(),
        });
        self.stream = Some(Stream { item, message_id });
        out
    }

    fn plan_update(&mut self, update: &Value) -> Event {
        let steps: Vec<Value> = arr(update, "entries")
            .iter()
            .map(|e| json!({ "step": str_of(e, "content").unwrap_or_default(), "status": str_of(e, "status").unwrap_or_else(|| "pending".into()) }))
            .collect();
        match self.plan.as_mut() {
            Some(plan) => {
                plan.data = json!({ "steps": steps });
                Event::ItemDelta {
                    session_id: self.session_id.clone(),
                    item_id: plan.id.clone(),
                    delta: ItemDelta::Data {
                        data: json!({ "steps": steps }),
                    },
                }
            }
            None => {
                let item = Item::new(&self.session_id, self.turn_id(), ItemKind::Plan)
                    .with_title("Plan")
                    .with_data(json!({ "steps": steps }));
                self.plan = Some(item.clone());
                Event::ItemStarted {
                    session_id: self.sid(),
                    item,
                }
            }
        }
    }

    /// Apply a `tool_call` / `tool_call_update` (or the `toolCall` of a
    /// permission request). Returns the tool call id and the events.
    fn tool_update(&mut self, update: &Value) -> (String, Vec<Event>) {
        let Some(id) = str_of(update, "toolCallId") else {
            return (String::new(), vec![]);
        };
        let fields = update.as_object().cloned().unwrap_or_default();
        let known = self.tools.contains_key(&id);
        let turn_id = self.turn_id();
        let tool = self.tools.entry(id.clone()).or_insert_with(|| Tool {
            raw: Map::new(),
            item: Item::new(&self.session_id, turn_id, ItemKind::ToolCall).with_id(id.clone()),
        });
        for (k, v) in fields {
            // Absent or null fields in an update leave the earlier value alone.
            if k != "sessionUpdate" && !v.is_null() {
                tool.raw.insert(k, v);
            }
        }
        let was_done = tool.item.status != ItemStatus::InProgress;
        rebuild_tool_item(&tool.raw, &mut tool.item);
        let item = tool.item.clone();
        let sid = self.session_id.clone();
        let events = if item.status != ItemStatus::InProgress {
            vec![Event::ItemCompleted {
                session_id: sid,
                item,
            }]
        } else if !known || was_done {
            vec![Event::ItemStarted {
                session_id: sid,
                item,
            }]
        } else {
            vec![Event::ItemDelta {
                session_id: sid,
                item_id: id.clone(),
                delta: ItemDelta::Data {
                    data: item.data.clone(),
                },
            }]
        };
        (id, events)
    }

    // ------------------------------------------------------------ permissions

    pub fn permission_request(&mut self, rpc_id: Value, params: &Value) -> Vec<Event> {
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let mut out = self.close_stream();
        let (item_id, events) = self.tool_update(&tool_call);
        out.extend(events);
        let options: Vec<(String, String)> = arr(params, "options")
            .iter()
            .filter_map(|o| {
                Some((
                    str_of(o, "optionId")?,
                    str_of(o, "kind").unwrap_or_default(),
                ))
            })
            .collect();
        let has = |k: &str| options.iter().any(|(_, kind)| kind == k);
        let mut offered = vec![];
        if has("allow_once") || has("allow_always") {
            offered.push(ApprovalOption::Accept);
        }
        if has("allow_always") {
            offered.push(ApprovalOption::AcceptForSession);
        }
        if has("reject_once") || has("reject_always") {
            offered.push(ApprovalOption::Decline);
        }
        offered.push(ApprovalOption::Cancel);

        let tool = self.tools.get(&item_id);
        let (kind, payload) = match tool.map(|t| (&t.item.kind, &t.item.data)) {
            Some((ItemKind::CommandExec, d)) => (
                ApprovalKind::Command,
                json!({ "command": d["command"], "cwd": d["cwd"] }),
            ),
            Some((ItemKind::FileChange, d)) => {
                (ApprovalKind::FileChange, json!({ "changes": d["changes"] }))
            }
            Some((_, d)) => (
                ApprovalKind::Tool,
                json!({ "tool_name": d["tool_name"], "input": d["input"] }),
            ),
            None => (ApprovalKind::Generic, json!({})),
        };
        let title = tool
            .and_then(|t| t.item.title.clone())
            .unwrap_or_else(|| "Permission requested".into());
        let description = (!options.is_empty()).then(|| {
            arr(params, "options")
                .iter()
                .filter_map(|o| str_of(o, "name"))
                .collect::<Vec<_>>()
                .join(" · ")
        });
        let approval = Approval {
            id: new_id(),
            session_id: self.sid(),
            turn_id: self.turn_id(),
            item_id: (!item_id.is_empty()).then_some(item_id),
            kind,
            title,
            description,
            payload,
            options: offered,
            created_at: now(),
        };
        self.approvals
            .insert(approval.id.clone(), PendingPermission { rpc_id, options });
        out.push(Event::ApprovalRequested {
            session_id: self.sid(),
            approval,
        });
        out
    }

    /// The JSON-RPC id and result answering a permission request.
    pub fn approval_reply(
        &mut self,
        approval_id: &str,
        decision: &ApprovalDecision,
    ) -> Result<(Value, Value)> {
        let pending = self
            .approvals
            .get(approval_id)
            .ok_or_else(|| anyhow!("unknown approval {approval_id}"))?;
        let pick = |kinds: &[&str]| {
            kinds.iter().find_map(|k| {
                pending
                    .options
                    .iter()
                    .find(|(_, kind)| kind == k)
                    .map(|(id, _)| id.clone())
            })
        };
        let option = match decision.option {
            ApprovalOption::Accept => pick(&["allow_once", "allow_always"]),
            ApprovalOption::AcceptForSession => pick(&["allow_always", "allow_once"]),
            ApprovalOption::Decline => pick(&["reject_once", "reject_always"]),
            ApprovalOption::Cancel => None,
            ApprovalOption::EditInput => {
                anyhow::bail!("ACP agents do not accept edited tool input")
            }
        };
        if option.is_none() && decision.option != ApprovalOption::Cancel {
            anyhow::bail!("the agent did not offer that choice");
        }
        let pending = self.approvals.remove(approval_id).expect("checked above");
        let outcome = match option {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        Ok((pending.rpc_id, json!({ "outcome": outcome })))
    }

    /// Every unanswered permission request, removed. ACP requires answering
    /// them with `cancelled` once the turn is cancelled.
    pub fn take_approvals(&mut self) -> Vec<(String, Value)> {
        self.approvals
            .drain()
            .map(|(id, p)| (id, p.rpc_id))
            .collect()
    }

    // ---------------------------------------------------------- session state

    pub fn set_agent(&mut self, agent: Value) -> Event {
        self.state.agent = agent;
        self.info_event()
    }

    /// Modes and config options from a `session/new`, `session/load` or
    /// `session/resume` response.
    pub fn session_state(&mut self, res: &Value) -> Vec<Event> {
        let mut out = vec![];
        if let Some(modes) = res.get("modes").filter(|m| m.is_object()) {
            self.state.modes = Some(modes.clone());
            if let Some(id) = str_of(modes, "currentModeId") {
                out.push(self.setting(Setting::PermissionMode(id)));
            }
        }
        if res
            .get("configOptions")
            .map(Value::is_array)
            .unwrap_or(false)
        {
            out.extend(self.set_config_options(arr(res, "configOptions")));
        } else {
            out.push(self.info_event());
        }
        out
    }

    pub fn set_config_options(&mut self, options: Vec<Value>) -> Vec<Event> {
        self.state.config_options = options;
        let mut out = vec![];
        for (category, setting) in [
            ("model", Setting::Model as fn(String) -> Setting),
            ("thought_level", Setting::Effort),
        ] {
            if let Some(v) = self
                .config_option(category)
                .and_then(|o| str_of(o, "currentValue"))
            {
                out.push(self.setting(setting(v)));
            }
        }
        if self.state.modes.is_none() {
            if let Some(v) = self
                .config_option("mode")
                .and_then(|o| str_of(o, "currentValue"))
            {
                out.push(self.setting(Setting::PermissionMode(v)));
            }
        }
        out.push(self.info_event());
        out
    }

    /// The first select option in `category` (`model`, `thought_level`, `mode`).
    pub fn config_option(&self, category: &str) -> Option<&Value> {
        self.state.config_options.iter().find(|o| {
            str_of(o, "category").as_deref() == Some(category)
                && str_of(o, "type").as_deref() == Some("select")
        })
    }

    pub fn has_modes(&self) -> bool {
        self.state.modes.is_some()
    }

    fn setting(&self, setting: Setting) -> Event {
        Event::SettingChanged {
            session_id: self.sid(),
            setting,
        }
    }

    /// Everything the UI needs for pickers and the inspector, under
    /// `kind: "acp_session"` (the transcript keeps the latest per kind).
    fn info_event(&self) -> Event {
        let modes = self.state.modes.as_ref();
        Event::ProviderInfo {
            session_id: self.sid(),
            info: json!({
                "kind": "acp_session",
                "agent": self.state.agent,
                "current_mode": modes.and_then(|m| m.get("currentModeId")).cloned().unwrap_or(Value::Null),
                "modes": modes.and_then(|m| m.get("availableModes")).cloned().unwrap_or(json!([])),
                "config_options": self.state.config_options,
                "commands": self.state.commands.iter().map(|c| json!({
                    "name": c.get("name"),
                    "description": c.get("description"),
                    "hint": c.get("input").and_then(|i| i.get("hint")),
                })).collect::<Vec<_>>(),
                "title": self.state.title,
            }),
        }
    }
}

// ---------------------------------------------------------------- helpers

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn arr(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Readable text for an ACP content block.
pub fn content_text(block: &Value) -> String {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => str_of(block, "text").unwrap_or_default(),
        Some("resource_link") => {
            let uri = str_of(block, "uri").unwrap_or_default();
            let name = str_of(block, "title")
                .or_else(|| str_of(block, "name"))
                .unwrap_or_else(|| uri.clone());
            format!("[{name}]({uri})")
        }
        Some("resource") => {
            let r = block.get("resource").cloned().unwrap_or(Value::Null);
            match str_of(&r, "text") {
                Some(text) => text,
                None => str_of(&r, "uri").unwrap_or_default(),
            }
        }
        Some("image") => "[image]".into(),
        Some("audio") => "[audio]".into(),
        _ => String::new(),
    }
}

/// Plain text of a tool call's `content` blocks (diffs and terminals excluded).
fn tool_text(raw: &Map<String, Value>) -> String {
    raw.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|c| c.get("content").map(content_text))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn command_of(raw: &Map<String, Value>) -> Option<String> {
    let input = raw.get("rawInput")?;
    match input.get("command").or_else(|| input.get("cmd"))? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn exit_code_of(raw: &Map<String, Value>) -> Option<i64> {
    let out = raw.get("rawOutput")?;
    ["exit_code", "exitCode", "code"]
        .iter()
        .find_map(|k| out.get(*k).and_then(Value::as_i64))
}

/// Recompute an Aura item from a tool call's merged ACP fields.
fn rebuild_tool_item(raw: &Map<String, Value>, item: &mut Item) {
    let s = |k: &str| raw.get(k).and_then(Value::as_str);
    let acp_kind = s("kind").unwrap_or("other");
    let title = s("title").unwrap_or("Tool call").to_string();
    let diffs: Vec<&Value> = raw
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("diff"))
        .collect();
    let text = tool_text(raw);
    let failed = s("status") == Some("failed");

    if acp_kind == "execute" {
        item.kind = ItemKind::CommandExec;
        let output = if text.is_empty() {
            raw.get("rawOutput")
                .and_then(|o| o.get("output").or_else(|| o.get("stdout")))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            text
        };
        item.data = json!({
            "command": command_of(raw).unwrap_or_else(|| title.clone()),
            "cwd": raw.get("rawInput").and_then(|i| i.get("cwd")).cloned().unwrap_or(Value::Null),
            "output": output,
            "exit_code": exit_code_of(raw),
        });
    } else if !diffs.is_empty() || matches!(acp_kind, "edit" | "delete" | "move") {
        item.kind = ItemKind::FileChange;
        let changes: Vec<Value> = if diffs.is_empty() {
            raw.get("locations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|l| l.get("path").and_then(Value::as_str))
                .map(|p| json!({ "path": p, "kind": if acp_kind == "delete" { "delete" } else { "modify" } }))
                .collect()
        } else {
            diffs
                .iter()
                .map(|d| {
                    let path = d.get("path").and_then(Value::as_str).unwrap_or("");
                    let old = d.get("oldText").and_then(Value::as_str);
                    let new = d.get("newText").and_then(Value::as_str).unwrap_or("");
                    let kind = match old {
                        None => "add",
                        Some(_) if acp_kind == "delete" => "delete",
                        Some(_) => "modify",
                    };
                    json!({ "path": path, "kind": kind, "diff": unified_diff(old.unwrap_or(""), new, path) })
                })
                .collect()
        };
        item.data = json!({ "changes": changes });
        item.text = text;
    } else {
        item.kind = ItemKind::ToolCall;
        let result = raw
            .get("rawOutput")
            .cloned()
            .filter(|v| !v.is_null())
            .or_else(|| (!text.is_empty()).then(|| json!(text)));
        item.data = json!({
            "tool_name": s("name").unwrap_or(&title),
            "input": raw.get("rawInput").cloned().unwrap_or(Value::Null),
            "result": result,
            "is_error": failed,
            "acp_kind": acp_kind,
        });
    }
    item.title = Some(title);
    match s("status") {
        Some("completed") if item.status == ItemStatus::InProgress => {
            *item = item.clone().completed()
        }
        Some("failed") if item.status == ItemStatus::InProgress => *item = item.clone().failed(),
        Some("pending") | Some("in_progress") => {
            item.status = ItemStatus::InProgress;
            item.ended_at = None;
        }
        _ => {}
    }
}

pub fn unified_diff(old: &str, new: &str, path: &str) -> String {
    let with_nl = |s: &str| {
        if s.is_empty() || s.ends_with('\n') {
            s.to_string()
        } else {
            format!("{s}\n")
        }
    };
    let (old, new) = (with_nl(old), with_nl(new));
    let diff = similar::TextDiff::from_lines(&old, &new);
    format!(
        "--- a/{path}\n+++ b/{path}\n{}",
        diff.unified_diff().context_radius(3)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(v: Value) -> Value {
        v
    }

    fn items_completed(events: &[Event]) -> Vec<Item> {
        events
            .iter()
            .filter_map(|e| {
                if let Event::ItemCompleted { item, .. } = e {
                    Some(item.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn streams_message_chunks_into_one_item_and_closes_it_at_turn_end() {
        let mut m = SessionMapper::new("s");
        let ev = m.begin_turn("hello", 0);
        assert!(matches!(ev[0], Event::TurnStarted { .. }));
        assert!(
            matches!(&ev[1], Event::ItemCompleted { item, .. } if item.kind == ItemKind::UserMessage && item.text == "hello")
        );

        let ev = m.handle_update(&up(json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}})));
        assert!(
            matches!(&ev[0], Event::ItemStarted { item, .. } if item.kind == ItemKind::Reasoning)
        );
        let ev = m.handle_update(&up(
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi "}}),
        ));
        assert!(
            matches!(&ev[0], Event::ItemCompleted { item, .. } if item.kind == ItemKind::Reasoning),
            "switching kinds closes the thought"
        );
        assert!(
            matches!(&ev[1], Event::ItemStarted { item, .. } if item.kind == ItemKind::AgentMessage && item.text == "Hi ")
        );
        let ev = m.handle_update(&up(
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"there"}}),
        ));
        assert!(
            matches!(&ev[0], Event::ItemDelta { delta: ItemDelta::Text { text }, .. } if text == "there")
        );

        let ev = m.end_turn(TurnOutcome::Stopped("end_turn".into()));
        let done = items_completed(&ev);
        assert_eq!(done[0].text, "Hi there");
        assert!(
            matches!(ev.last(), Some(Event::TurnCompleted { turn, .. }) if turn.status == TurnStatus::Completed)
        );
        assert!(!m.turn_active());
    }

    #[test]
    fn a_new_message_id_starts_a_new_item() {
        let mut m = SessionMapper::new("s");
        m.handle_update(&json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":"one"}}));
        let ev = m.handle_update(&json!({"sessionUpdate":"agent_message_chunk","messageId":"b","content":{"type":"text","text":"two"}}));
        assert!(matches!(&ev[0], Event::ItemCompleted { item, .. } if item.text == "one"));
        assert!(matches!(&ev[1], Event::ItemStarted { item, .. } if item.text == "two"));
    }

    #[test]
    fn maps_execute_tool_calls_to_commands_through_their_updates() {
        let mut m = SessionMapper::new("s");
        m.begin_turn("run it", 0);
        m.handle_update(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Running"}}));
        let ev = m.handle_update(&json!({"sessionUpdate":"tool_call","toolCallId":"t1","title":"List files","kind":"execute","status":"pending","rawInput":{"command":["ls","-la"]}}));
        assert!(
            matches!(&ev[0], Event::ItemCompleted { item, .. } if item.kind == ItemKind::AgentMessage),
            "a tool call closes the message"
        );
        match &ev[1] {
            Event::ItemStarted { item, .. } => {
                assert_eq!(item.id, "t1");
                assert_eq!(item.kind, ItemKind::CommandExec);
                assert_eq!(item.data["command"], "ls -la");
            }
            e => panic!("{e:?}"),
        }
        let ev = m.handle_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"a.txt"}}]}));
        assert!(
            matches!(&ev[0], Event::ItemDelta { delta: ItemDelta::Data { data }, .. } if data["output"] == "a.txt" && data["command"] == "ls -la")
        );
        let ev = m.handle_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":{"exit_code":0}}));
        match &ev[0] {
            Event::ItemCompleted { item, .. } => {
                assert_eq!(item.status, ItemStatus::Completed);
                assert_eq!(item.data["exit_code"], 0);
                assert_eq!(
                    item.data["output"], "a.txt",
                    "content from an earlier update is kept"
                );
                assert_eq!(item.title.as_deref(), Some("List files"));
            }
            e => panic!("{e:?}"),
        }
        let ev = m.end_turn(TurnOutcome::Stopped("end_turn".into()));
        assert!(
            items_completed(&ev).is_empty(),
            "finished tools are not completed twice"
        );
    }

    #[test]
    fn maps_diffs_to_file_changes() {
        let mut m = SessionMapper::new("s");
        let ev = m.handle_update(&json!({"sessionUpdate":"tool_call","toolCallId":"e","title":"Edit a.rs","kind":"edit","status":"completed",
            "content":[{"type":"diff","path":"/w/a.rs","oldText":"a\nb\n","newText":"a\nc\n"},{"type":"diff","path":"/w/new.rs","newText":"x"}]}));
        let item = items_completed(&ev).remove(0);
        assert_eq!(item.kind, ItemKind::FileChange);
        let changes = item.data["changes"].as_array().unwrap();
        assert_eq!(changes[0]["kind"], "modify");
        let diff = changes[0]["diff"].as_str().unwrap();
        assert!(diff.starts_with("--- a//w/a.rs\n+++ b//w/a.rs\n"), "{diff}");
        assert!(diff.contains("-b\n") && diff.contains("+c\n"), "{diff}");
        assert_eq!(changes[1]["kind"], "add");
    }

    #[test]
    fn other_tools_keep_input_and_result() {
        let mut m = SessionMapper::new("s");
        let ev = m.handle_update(&json!({"sessionUpdate":"tool_call","toolCallId":"f","title":"Fetch docs","kind":"fetch","status":"failed","rawInput":{"url":"https://x"},"rawOutput":{"error":"404"}}));
        let item = items_completed(&ev).remove(0);
        assert_eq!(item.kind, ItemKind::ToolCall);
        assert_eq!(item.status, ItemStatus::Failed);
        assert_eq!(item.data["input"]["url"], "https://x");
        assert_eq!(item.data["result"]["error"], "404");
        assert_eq!(item.data["is_error"], true);
    }

    #[test]
    fn plan_updates_replace_the_steps_of_one_item() {
        let mut m = SessionMapper::new("s");
        m.begin_turn("plan", 0);
        let ev = m.handle_update(&json!({"sessionUpdate":"plan","entries":[{"content":"a","priority":"high","status":"pending"}]}));
        assert!(
            matches!(&ev[0], Event::ItemStarted { item, .. } if item.kind == ItemKind::Plan && item.data["steps"][0]["step"] == "a")
        );
        let ev = m.handle_update(&json!({"sessionUpdate":"plan","entries":[{"content":"a","priority":"high","status":"completed"},{"content":"b","priority":"low","status":"in_progress"}]}));
        assert!(
            matches!(&ev[0], Event::ItemDelta { delta: ItemDelta::Data { data }, .. } if data["steps"][1]["status"] == "in_progress")
        );
        let ev = m.end_turn(TurnOutcome::Stopped("end_turn".into()));
        assert_eq!(
            items_completed(&ev)[0].data["steps"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn permission_requests_become_approvals_answered_with_the_agents_option_ids() {
        let mut m = SessionMapper::new("s");
        m.begin_turn("go", 0);
        let params = json!({"sessionId":"x","toolCall":{"toolCallId":"t9","title":"Run rm","kind":"execute","status":"pending","rawInput":{"command":"rm -rf build"}},
            "options":[{"optionId":"yes","name":"Allow","kind":"allow_once"},{"optionId":"always","name":"Always allow","kind":"allow_always"},{"optionId":"no","name":"Reject","kind":"reject_once"}]});
        let ev = m.permission_request(json!(7), &params);
        assert!(
            matches!(&ev[0], Event::ItemStarted { item, .. } if item.id == "t9"),
            "an unannounced tool call is created"
        );
        let approval = match ev.last() {
            Some(Event::ApprovalRequested { approval, .. }) => approval.clone(),
            e => panic!("{e:?}"),
        };
        assert_eq!(approval.kind, ApprovalKind::Command);
        assert_eq!(approval.payload["command"], "rm -rf build");
        assert_eq!(approval.item_id.as_deref(), Some("t9"));
        assert_eq!(
            approval.options,
            vec![
                ApprovalOption::Accept,
                ApprovalOption::AcceptForSession,
                ApprovalOption::Decline,
                ApprovalOption::Cancel
            ]
        );

        let decide = |option| ApprovalDecision {
            option,
            updated_input: None,
            message: None,
        };
        assert!(m
            .approval_reply(&approval.id, &decide(ApprovalOption::EditInput))
            .is_err());
        let (id, res) = m
            .approval_reply(&approval.id, &decide(ApprovalOption::AcceptForSession))
            .unwrap();
        assert_eq!(id, json!(7));
        assert_eq!(
            res,
            json!({ "outcome": { "outcome": "selected", "optionId": "always" } })
        );
        assert!(
            m.approval_reply(&approval.id, &decide(ApprovalOption::Accept))
                .is_err(),
            "answered once"
        );
    }

    #[test]
    fn decline_falls_back_to_reject_always_and_missing_choices_are_refused() {
        let mut m = SessionMapper::new("s");
        let params = json!({"toolCall":{"toolCallId":"t","title":"Write"},"options":[{"optionId":"r","name":"Never","kind":"reject_always"}]});
        let ev = m.permission_request(json!("abc"), &params);
        let approval = match ev.last() {
            Some(Event::ApprovalRequested { approval, .. }) => approval.clone(),
            e => panic!("{e:?}"),
        };
        assert_eq!(
            approval.options,
            vec![ApprovalOption::Decline, ApprovalOption::Cancel]
        );
        let decide = |option| ApprovalDecision {
            option,
            updated_input: None,
            message: None,
        };
        assert!(m
            .approval_reply(&approval.id, &decide(ApprovalOption::Accept))
            .is_err());
        let (_, res) = m
            .approval_reply(&approval.id, &decide(ApprovalOption::Decline))
            .unwrap();
        assert_eq!(res["outcome"]["optionId"], "r");
    }

    #[test]
    fn cancelled_turns_are_interrupted_and_fail_open_tools() {
        let mut m = SessionMapper::new("s");
        m.begin_turn("go", 0);
        m.handle_update(&json!({"sessionUpdate":"tool_call","toolCallId":"t","title":"Long","kind":"execute","status":"in_progress"}));
        m.permission_request(json!(1), &json!({"toolCall":{"toolCallId":"t"},"options":[{"optionId":"y","name":"Yes","kind":"allow_once"}]}));
        assert_eq!(m.take_approvals().len(), 1);
        let ev = m.end_turn(TurnOutcome::Stopped("cancelled".into()));
        assert_eq!(items_completed(&ev)[0].status, ItemStatus::Failed);
        assert!(
            matches!(ev.last(), Some(Event::TurnCompleted { turn, .. }) if turn.status == TurnStatus::Interrupted)
        );
        let ev = {
            m.begin_turn("again", 0);
            m.end_turn(TurnOutcome::Failed("agent exited".into()))
        };
        assert!(
            matches!(ev.last(), Some(Event::TurnCompleted { turn, .. }) if turn.status == TurnStatus::Failed && turn.error.as_deref() == Some("agent exited"))
        );
    }

    #[test]
    fn replay_keeps_session_state_but_drops_content() {
        let mut m = SessionMapper::new("s");
        m.replaying = true;
        assert!(m.handle_update(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}})).is_empty());
        assert!(m
            .handle_update(&json!({"sessionUpdate":"tool_call","toolCallId":"t","title":"x"}))
            .is_empty());
        let ev = m.handle_update(&json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"init","description":"Create AGENTS.md","input":{"hint":"path"}}]}));
        match &ev[0] {
            Event::ProviderInfo { info, .. } => assert_eq!(
                info["commands"][0],
                json!({"name":"init","description":"Create AGENTS.md","hint":"path"})
            ),
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn a_turn_carries_the_cost_it_added() {
        let mut m = SessionMapper::new("s");
        let cost = |m: &mut SessionMapper, amount: f64| {
            m.handle_update(&json!({"sessionUpdate":"usage_update","used":1200,"size":200000,"cost":{"amount":amount,"currency":"USD"}}));
        };
        let turn_cost = |events: Vec<Event>| {
            events
                .into_iter()
                .find_map(|e| match e {
                    Event::TurnCompleted { turn, .. } => turn.usage?.total_cost_usd,
                    _ => None,
                })
                .unwrap()
        };
        m.begin_turn("one", 0);
        cost(&mut m, 0.25);
        assert_eq!(
            turn_cost(m.end_turn(TurnOutcome::Stopped("end_turn".into()))),
            0.25
        );
        m.begin_turn("two", 0);
        cost(&mut m, 0.4);
        let second = turn_cost(m.end_turn(TurnOutcome::Stopped("end_turn".into())));
        assert!((second - 0.15).abs() < 1e-9, "{second}");
    }

    #[test]
    fn session_state_reports_modes_models_and_usage() {
        let mut m = SessionMapper::new("s");
        let ev = m.session_state(&json!({
            "sessionId":"x",
            "modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"},{"id":"yolo","name":"YOLO"}]},
            "configOptions":[
                {"id":"model","name":"Model","category":"model","type":"select","currentValue":"pro","options":[{"value":"pro","name":"Pro"}]},
                {"id":"think","name":"Thinking","category":"thought_level","type":"select","currentValue":"high","options":[]}
            ]
        }));
        let settings: Vec<&Setting> = ev
            .iter()
            .filter_map(|e| {
                if let Event::SettingChanged { setting, .. } = e {
                    Some(setting)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            settings,
            vec![
                &Setting::PermissionMode("default".into()),
                &Setting::Model("pro".into()),
                &Setting::Effort("high".into())
            ]
        );
        assert!(m.has_modes());
        assert_eq!(m.config_option("model").unwrap()["id"], "model");

        let ev =
            m.handle_update(&json!({"sessionUpdate":"current_mode_update","currentModeId":"yolo"}));
        assert!(
            matches!(&ev[0], Event::SettingChanged { setting: Setting::PermissionMode(p), .. } if p == "yolo")
        );
        assert!(
            matches!(&ev[1], Event::ProviderInfo { info, .. } if info["current_mode"] == "yolo")
        );

        let ev = m.handle_update(&json!({"sessionUpdate":"usage_update","used":1200,"size":200000,"cost":{"amount":0.25,"currency":"USD"}}));
        match &ev[0] {
            Event::Usage { usage, .. } => {
                assert_eq!(
                    (
                        usage.context_used,
                        usage.context_window,
                        usage.total_cost_usd
                    ),
                    (Some(1200), Some(200000), Some(0.25))
                );
            }
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn content_blocks_render_as_text() {
        assert_eq!(
            content_text(&json!({"type":"resource_link","name":"a.rs","uri":"file:///a.rs"})),
            "[a.rs](file:///a.rs)"
        );
        assert_eq!(
            content_text(&json!({"type":"resource","resource":{"uri":"file:///b","text":"body"}})),
            "body"
        );
        assert_eq!(
            content_text(&json!({"type":"image","data":"..","mimeType":"image/png"})),
            "[image]"
        );
        assert_eq!(content_text(&json!({"type":"mystery"})), "");
    }
}
