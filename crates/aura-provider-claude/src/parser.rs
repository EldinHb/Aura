//! Pure (no IO) translation of Claude Code stream-json lines into `aura_core::Event`s.
//!
//! The [`Parser`] keeps the per-session state needed to correlate streaming
//! content blocks, tool results and control requests. It is driven by
//! [`Parser::handle_line`] (one parsed stdout line) and [`Parser::start_turn`]
//! (called when the host writes a user message).

use aura_core::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// A `can_use_tool` request we still owe an answer for.
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    /// Raw `permission_suggestions` from the request.
    pub suggestions: Vec<Value>,
    /// True when the request was surfaced as a `UserInputRequest` (AskUserQuestion).
    pub is_question: bool,
}

/// What we asked claude for via `control_request`, keyed by our request id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboundControl {
    Interrupt,
    SetPermissionMode(String),
    Other,
}

#[derive(Debug, Default)]
pub struct Parser {
    pub session_id: String,
    pub native_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub current_turn: Option<Turn>,
    /// (message id, block index) -> item id
    blocks: HashMap<(String, u64), String>,
    /// live items by id
    items: HashMap<String, Item>,
    /// message id -> item ids in order (for matching `assistant` blocks)
    message_items: HashMap<String, Vec<String>>,
    pub pending_approvals: HashMap<String, PendingApproval>,
    pub outbound: HashMap<String, OutboundControl>,
    interrupt_requested: bool,
    pub commands: Vec<SlashCommand>,
    /// Text of the user message we most recently wrote, to drop its replay echo.
    sent_texts: Vec<String>,
    /// parent_tool_use_id -> id of the message currently streaming in that lane.
    current_message: HashMap<Option<String>, String>,
    /// Name of the slash command we most recently wrote, to label its output.
    last_command: Option<String>,
    /// Id of the "compacting" boundary item while a compaction runs.
    compacting: Option<String>,
    /// Error of a failed compaction. Claude repeats it as command output,
    /// which the failed boundary item already shows.
    compact_error: Option<String>,
    /// Context size right after the last compaction.
    compacted_to: Option<u64>,
    /// Uuids of messages a compaction kept. Claude emits them again after the
    /// boundary; they are already in the transcript.
    preserved: HashSet<String>,
    /// Usage from the last model turn. Local commands report zero usage, so
    /// their results reuse this instead of wiping the session's numbers.
    last_usage: Option<Usage>,
}

impl Parser {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            ..Default::default()
        }
    }

    fn sid(&self) -> String {
        self.session_id.clone()
    }

    /// Called right before the host writes a user message. Emits the turn start
    /// and the user item so the UI reflects the message immediately.
    pub fn start_turn(&mut self, text: &str) -> Vec<Event> {
        let mut out = vec![];
        if self.current_turn.is_none() {
            let turn = Turn {
                id: aura_core::new_id(),
                session_id: self.sid(),
                status: TurnStatus::Running,
                started_at: aura_core::now(),
                ended_at: None,
                usage: None,
                error: None,
            };
            self.current_turn = Some(turn.clone());
            self.interrupt_requested = false;
            out.push(Event::TurnStarted {
                session_id: self.sid(),
                turn,
            });
        }
        let turn_id = self.current_turn.as_ref().map(|t| t.id.clone());
        let item = Item::new(&self.session_id, turn_id, ItemKind::UserMessage).with_text(text);
        out.push(Event::ItemStarted {
            session_id: self.sid(),
            item: item.clone(),
        });
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.completed(),
        });
        self.sent_texts.push(text.to_string());
        self.last_command = slash_name(text);
        out.extend(self.setting_from_slash(text));
        out
    }

    /// `/effort X` and `/model X` are handled locally by Claude Code with no
    /// structured acknowledgement, so mirror them into the session state here.
    /// This keeps a typed command in sync with the picker, which goes through
    /// `Manager::set`.
    fn setting_from_slash(&mut self, text: &str) -> Option<Event> {
        let rest = text.trim().strip_prefix('/')?;
        let (name, arg) = rest.split_once(char::is_whitespace)?;
        let arg = arg.trim();
        if arg.is_empty() || arg.contains(char::is_whitespace) {
            return None;
        }
        let setting = match name {
            "effort" => {
                if self.effort.as_deref() == Some(arg) {
                    return None;
                }
                self.effort = Some(arg.to_string());
                Setting::Effort(arg.to_string())
            }
            "model" => {
                if self.model.as_deref() == Some(arg) {
                    return None;
                }
                self.model = Some(arg.to_string());
                Setting::Model(arg.to_string())
            }
            _ => return None,
        };
        Some(Event::SettingChanged {
            session_id: self.sid(),
            setting,
        })
    }

    pub fn note_outbound(&mut self, request_id: &str, kind: OutboundControl) {
        if kind == OutboundControl::Interrupt {
            self.interrupt_requested = true;
        }
        self.outbound.insert(request_id.to_string(), kind);
    }

    fn turn_id(&self) -> Option<String> {
        self.current_turn.as_ref().map(|t| t.id.clone())
    }

    /// Translate one stdout line.
    pub fn handle_line(&mut self, v: &Value) -> Vec<Event> {
        let mut out = vec![];
        let Some(ty) = v.get("type").and_then(Value::as_str) else {
            tracing::debug!("claude: line without type: {}", v);
            return out;
        };
        match ty {
            "system" => self.handle_system(v, &mut out),
            "stream_event" => self.handle_stream_event(v, &mut out),
            "assistant" | "user" if self.is_preserved(v) => {}
            "assistant" => self.handle_assistant(v, &mut out),
            "user" => self.handle_user(v, &mut out),
            "conversation_reset" => self.handle_conversation_reset(&mut out),
            "result" => self.handle_result(v, &mut out),
            "control_request" => self.handle_control_request(v, &mut out),
            "control_response" => self.handle_control_response(v, &mut out),
            "rate_limit_event" => {
                let mut info = v.clone();
                if let Some(o) = info.as_object_mut() {
                    o.insert("kind".into(), json!("rate_limit"));
                }
                out.push(Event::ProviderInfo {
                    session_id: self.sid(),
                    info,
                });
            }
            other => tracing::debug!("claude: ignoring message type {other}"),
        }
        out
    }

    // ------------------------------------------------------------- system

    fn handle_system(&mut self, v: &Value, out: &mut Vec<Event>) {
        let sub = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        match sub {
            "init" => {
                if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                    if self.native_id.as_deref() != Some(id) {
                        self.native_id = Some(id.to_string());
                        out.push(Event::NativeId {
                            session_id: self.sid(),
                            native_id: id.to_string(),
                        });
                    }
                }
                let mut info = v.clone();
                if let Some(o) = info.as_object_mut() {
                    o.insert("kind".into(), json!("init"));
                }
                out.push(Event::ProviderInfo {
                    session_id: self.sid(),
                    info,
                });
                if let Some(m) = v.get("model").and_then(Value::as_str) {
                    if self.model.as_deref() != Some(m) {
                        self.model = Some(m.to_string());
                        out.push(Event::SettingChanged {
                            session_id: self.sid(),
                            setting: Setting::Model(m.into()),
                        });
                    }
                }
                if let Some(p) = v.get("permissionMode").and_then(Value::as_str) {
                    if self.permission_mode.as_deref() != Some(p) {
                        self.permission_mode = Some(p.to_string());
                        out.push(Event::SettingChanged {
                            session_id: self.sid(),
                            setting: Setting::PermissionMode(p.into()),
                        });
                    }
                }
                if self.commands.is_empty() {
                    if let Some(list) = v.get("slash_commands").and_then(Value::as_array) {
                        self.commands = list
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|n| SlashCommand {
                                name: n.to_string(),
                                description: None,
                                source: None,
                            })
                            .collect();
                    }
                }
            }
            "commands_changed" => {
                if let Some(list) = v.get("commands").and_then(Value::as_array) {
                    self.commands = list
                        .iter()
                        .filter_map(|c| {
                            Some(SlashCommand {
                                name: c.get("name")?.as_str()?.to_string(),
                                description: c
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .map(String::from),
                                source: c
                                    .get("argumentHint")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .map(String::from),
                            })
                        })
                        .collect();
                }
            }
            "status" => {
                if let Some(p) = v.get("permissionMode").and_then(Value::as_str) {
                    if self.permission_mode.as_deref() != Some(p) {
                        self.permission_mode = Some(p.to_string());
                        out.push(Event::SettingChanged {
                            session_id: self.sid(),
                            setting: Setting::PermissionMode(p.into()),
                        });
                    }
                }
                if v.get("status").and_then(Value::as_str) == Some("compacting") {
                    self.start_compacting(out);
                }
                if v.get("compact_result").and_then(Value::as_str) == Some("failed") {
                    let err = v
                        .get("compact_error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string();
                    self.fail_compacting(&err, out);
                }
            }
            "compact_boundary" => self.handle_compact_boundary(v, out),
            "api_retry" => {
                let attempt = v.get("attempt").and_then(Value::as_u64).unwrap_or(0);
                let max = v.get("max_retries").and_then(Value::as_u64).unwrap_or(0);
                let err = v.get("error").and_then(Value::as_str).unwrap_or("unknown");
                out.push(Event::Notice {
                    session_id: self.sid(),
                    level: NoticeLevel::Warn,
                    message: format!("API retry {attempt}/{max}: {err}"),
                });
            }
            "permission_denied" => {
                let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
                out.push(Event::Notice {
                    session_id: self.sid(),
                    level: NoticeLevel::Warn,
                    message: format!("Permission denied for {tool}"),
                });
            }
            "hook_started" | "hook_response" | "hook_progress" | "thinking_tokens"
            | "plugin_install" => {}
            other => tracing::debug!("claude: ignoring system/{other}"),
        }
    }

    // -------------------------------------------------------- stream_event

    fn handle_stream_event(&mut self, v: &Value, out: &mut Vec<Event>) {
        let Some(ev) = v.get("event") else { return };
        let ev_type = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let parent = v
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .map(String::from);
        match ev_type {
            "message_start" => {
                if let Some(id) = ev.pointer("/message/id").and_then(Value::as_str) {
                    self.current_message.insert(parent.clone(), id.to_string());
                }
            }
            "content_block_start" => {
                let Some(msg_id) = self.stream_message_id(&parent) else {
                    return;
                };
                let index = ev.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(block) = ev.get("content_block") else {
                    return;
                };
                let item = self.item_for_block(block, parent.clone());
                let Some(item) = item else { return };
                self.blocks.insert((msg_id.clone(), index), item.id.clone());
                self.message_items
                    .entry(msg_id)
                    .or_default()
                    .push(item.id.clone());
                self.items.insert(item.id.clone(), item.clone());
                out.push(Event::ItemStarted {
                    session_id: self.sid(),
                    item,
                });
            }
            "content_block_delta" => {
                let Some(msg_id) = self.stream_message_id(&parent) else {
                    return;
                };
                let index = ev.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(item_id) = self.blocks.get(&(msg_id, index)).cloned() else {
                    return;
                };
                let Some(delta) = ev.get("delta") else { return };
                let dt = delta.get("type").and_then(Value::as_str).unwrap_or("");
                let text = match dt {
                    "text_delta" => delta.get("text").and_then(Value::as_str),
                    "thinking_delta" => delta.get("thinking").and_then(Value::as_str),
                    _ => None,
                };
                if let Some(text) = text.filter(|t| !t.is_empty()) {
                    if let Some(item) = self.items.get_mut(&item_id) {
                        item.text.push_str(text);
                    }
                    out.push(Event::ItemDelta {
                        session_id: self.sid(),
                        item_id,
                        delta: ItemDelta::Text {
                            text: text.to_string(),
                        },
                    });
                }
            }
            _ => {}
        }
    }

    /// Stream events don't repeat the message id, so we use the id from the
    /// most recent `message_start` in the same lane (main or a subagent).
    fn stream_message_id(&self, parent: &Option<String>) -> Option<String> {
        self.current_message.get(parent).cloned()
    }

    fn item_for_block(&self, block: &Value, parent: Option<String>) -> Option<Item> {
        let bt = block.get("type").and_then(Value::as_str)?;
        let turn_id = self.turn_id();
        let mut item = match bt {
            "text" => Item::new(&self.session_id, turn_id, ItemKind::AgentMessage)
                .with_text(block.get("text").and_then(Value::as_str).unwrap_or("")),
            "thinking" => Item::new(&self.session_id, turn_id, ItemKind::Reasoning)
                .with_text(block.get("thinking").and_then(Value::as_str).unwrap_or("")),
            "tool_use" => {
                let id = block.get("id").and_then(Value::as_str)?;
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or(json!({}));
                tool_item(&self.session_id, turn_id, id, name, &input)
            }
            _ => return None,
        };
        item.parent_id = parent;
        Some(item)
    }

    // ------------------------------------------------------------ assistant

    fn handle_assistant(&mut self, v: &Value, out: &mut Vec<Event>) {
        let Some(msg) = v.get("message") else { return };
        if v.get("local_command_source").is_some() {
            self.handle_local_command_output(v, msg, out);
            return;
        }
        let msg_id = msg
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parent = v
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .map(String::from);
        let Some(content) = msg.get("content").and_then(Value::as_array) else {
            return;
        };
        for block in content {
            let bt = block.get("type").and_then(Value::as_str).unwrap_or("");
            match bt {
                "text" | "thinking" => {
                    let kind = if bt == "text" {
                        ItemKind::AgentMessage
                    } else {
                        ItemKind::Reasoning
                    };
                    let full = block
                        .get(if bt == "text" { "text" } else { "thinking" })
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // Find the first live item of this kind for this message.
                    let existing = self.message_items.get(&msg_id).and_then(|ids| {
                        ids.iter()
                            .find(|id| self.items.get(*id).map(|i| i.kind == kind).unwrap_or(false))
                            .cloned()
                    });
                    let mut item = match existing {
                        Some(id) => {
                            if let Some(ids) = self.message_items.get_mut(&msg_id) {
                                ids.retain(|x| x != &id);
                            }
                            self.items.remove(&id).unwrap_or_else(|| {
                                Item::new(&self.session_id, self.turn_id(), kind).with_id(id)
                            })
                        }
                        None => {
                            // Synthetic messages (e.g. `/model`) have no stream events.
                            let item = Item::new(&self.session_id, self.turn_id(), kind);
                            out.push(Event::ItemStarted {
                                session_id: self.sid(),
                                item: item.clone(),
                            });
                            item
                        }
                    };
                    if !full.is_empty() {
                        item.text = full;
                    }
                    if item.parent_id.is_none() {
                        item.parent_id = parent.clone();
                    }
                    let item = item.completed();
                    self.blocks.retain(|_, id| id != &item.id);
                    out.push(Event::ItemCompleted {
                        session_id: self.sid(),
                        item,
                    });
                }
                "tool_use" => {
                    let Some(id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    let sid = self.sid();
                    let fresh = tool_item(&sid, None, id, name, &input);
                    if let Some(item) = self.items.get_mut(id) {
                        item.data = fresh.data;
                        item.title = fresh.title;
                        if item.parent_id.is_none() {
                            item.parent_id = parent.clone();
                        }
                        let data = item.data.clone();
                        out.push(Event::ItemDelta {
                            session_id: sid,
                            item_id: id.to_string(),
                            delta: ItemDelta::Data { data },
                        });
                    } else {
                        let mut item =
                            tool_item(&self.session_id, self.turn_id(), id, name, &input);
                        item.parent_id = parent.clone();
                        self.items.insert(id.to_string(), item.clone());
                        out.push(Event::ItemStarted {
                            session_id: self.sid(),
                            item,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    // ----------------------------------------------------------------- user

    fn handle_user(&mut self, v: &Value, out: &mut Vec<Event>) {
        let Some(msg) = v.get("message") else { return };
        let parent = v
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .map(String::from);
        let is_replay = v.get("isReplay").and_then(Value::as_bool).unwrap_or(false);
        let content = msg.get("content");
        // String content: plain user text.
        if let Some(text) = content.and_then(Value::as_str) {
            self.note_user_text(text, is_replay, parent, out);
            return;
        }
        let Some(blocks) = content.and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            let bt = block.get("type").and_then(Value::as_str).unwrap_or("");
            match bt {
                "text" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    self.note_user_text(text, is_replay, parent.clone(), out);
                }
                "tool_result" => {
                    let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                        continue;
                    };
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let result_text = content_to_text(block.get("content"));
                    let tur = v.get("tool_use_result");
                    let mut item = match self.items.remove(tool_use_id) {
                        Some(i) => i,
                        None => {
                            let mut i =
                                Item::new(&self.session_id, self.turn_id(), ItemKind::ToolCall)
                                    .with_id(tool_use_id);
                            i.parent_id = parent.clone();
                            out.push(Event::ItemStarted {
                                session_id: self.sid(),
                                item: i.clone(),
                            });
                            i
                        }
                    };
                    let data = item
                        .data
                        .as_object_mut()
                        .map(|o| o.clone())
                        .unwrap_or_default();
                    let mut data = data;
                    data.insert(
                        "result".into(),
                        block.get("content").cloned().unwrap_or(json!(result_text)),
                    );
                    data.insert("is_error".into(), json!(is_error));
                    if item.kind == ItemKind::CommandExec {
                        let mut output = String::new();
                        if let Some(t) = tur {
                            if let Some(s) = t.get("stdout").and_then(Value::as_str) {
                                output.push_str(s);
                            }
                            if let Some(s) = t
                                .get("stderr")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                            {
                                if !output.is_empty() && !output.ends_with('\n') {
                                    output.push('\n');
                                }
                                output.push_str(s);
                            }
                            if let Some(code) = t
                                .get("exitCode")
                                .or(t.get("exit_code"))
                                .and_then(Value::as_i64)
                            {
                                data.insert("exit_code".into(), json!(code));
                            }
                            if t.get("interrupted").and_then(Value::as_bool) == Some(true) {
                                data.insert("interrupted".into(), json!(true));
                            }
                        }
                        if output.is_empty() {
                            output = result_text.clone();
                        }
                        data.insert("output".into(), json!(output));
                        if !data.contains_key("exit_code") {
                            data.insert("exit_code".into(), json!(if is_error { 1 } else { 0 }));
                        }
                    }
                    item.data = Value::Object(data);
                    let item = if is_error {
                        item.failed()
                    } else {
                        item.completed()
                    };
                    out.push(Event::ItemCompleted {
                        session_id: self.sid(),
                        item,
                    });
                }
                _ => {}
            }
        }
    }

    fn note_user_text(
        &mut self,
        text: &str,
        is_replay: bool,
        parent: Option<String>,
        out: &mut Vec<Event>,
    ) {
        if text == "[Request interrupted by user]" {
            self.interrupt_requested = true;
            return;
        }
        if is_replay {
            // Echo of something we wrote; already emitted in start_turn.
            if let Some(pos) = self.sent_texts.iter().position(|t| t == text) {
                self.sent_texts.remove(pos);
            }
            return;
        }
        if parent.is_some() {
            // Subagent prompt: show it as a user message nested under the subagent.
            let mut item =
                Item::new(&self.session_id, self.turn_id(), ItemKind::UserMessage).with_text(text);
            item.parent_id = parent;
            out.push(Event::ItemStarted {
                session_id: self.sid(),
                item: item.clone(),
            });
            out.push(Event::ItemCompleted {
                session_id: self.sid(),
                item: item.completed(),
            });
        }
    }

    // --------------------------------------------------------------- result

    fn handle_result(&mut self, v: &Value, out: &mut Vec<Event>) {
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        let terminal = v
            .get("terminal_reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        let interrupted = self.interrupt_requested || terminal == "aborted_streaming";
        let status = if interrupted {
            TurnStatus::Interrupted
        } else if is_error {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        };
        let local_command = v.get("local_command").and_then(Value::as_str);
        let usage = match local_command {
            None => {
                let usage = usage_from_result(v, self.model.as_deref());
                self.last_usage = Some(usage.clone());
                Some(usage)
            }
            Some(cmd) => self.usage_after_local_command(cmd, v),
        };
        if let Some(id) = v.get("session_id").and_then(Value::as_str) {
            if self.native_id.as_deref() != Some(id) {
                self.native_id = Some(id.to_string());
                out.push(Event::NativeId {
                    session_id: self.sid(),
                    native_id: id.to_string(),
                });
            }
        }
        // Any items still open belong to the finished turn; close them.
        let open: Vec<Item> = self.items.drain().map(|(_, i)| i).collect();
        self.blocks.clear();
        self.message_items.clear();
        for item in open {
            let item = if interrupted || is_error {
                item.failed()
            } else {
                item.completed()
            };
            out.push(Event::ItemCompleted {
                session_id: self.sid(),
                item,
            });
        }
        let error = if is_error && !interrupted {
            let errs = v
                .get("errors")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .filter(|s| !s.is_empty());
            Some(errs.unwrap_or_else(|| {
                v.get("result")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| subtype.to_string())
            }))
        } else {
            None
        };
        let mut turn = self.current_turn.take().unwrap_or_else(|| Turn {
            id: aura_core::new_id(),
            session_id: self.sid(),
            status: TurnStatus::Running,
            started_at: aura_core::now(),
            ended_at: None,
            usage: None,
            error: None,
        });
        turn.status = status;
        turn.ended_at = Some(aura_core::now());
        // A local command made no model call, so its zero usage is noise.
        turn.usage = if local_command.is_none() {
            usage.clone()
        } else {
            None
        };
        turn.error = error;
        self.interrupt_requested = false;
        if let Some(usage) = usage {
            out.push(Event::Usage {
                session_id: self.sid(),
                usage,
            });
        }
        out.push(Event::TurnCompleted {
            session_id: self.sid(),
            turn,
        });
    }

    // ------------------------------------------------------- control_request

    fn handle_control_request(&mut self, v: &Value, out: &mut Vec<Event>) {
        let Some(request_id) = v.get("request_id").and_then(Value::as_str) else {
            return;
        };
        let Some(req) = v.get("request") else { return };
        let sub = req.get("subtype").and_then(Value::as_str).unwrap_or("");
        if sub != "can_use_tool" {
            tracing::debug!("claude: unhandled control_request subtype {sub}");
            return;
        }
        let tool_name = req
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let display = req
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(&tool_name)
            .to_string();
        let input = req.get("input").cloned().unwrap_or(json!({}));
        let suggestions: Vec<Value> = req
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let tool_use_id = req
            .get("tool_use_id")
            .and_then(Value::as_str)
            .map(String::from);
        let description = req
            .get("description")
            .and_then(Value::as_str)
            .map(String::from);

        if tool_name == "AskUserQuestion" {
            let questions: Vec<Question> = input
                .get("questions")
                .and_then(Value::as_array)
                .map(|qs| {
                    qs.iter()
                        .enumerate()
                        .map(|(i, q)| {
                            let text = q
                                .get("question")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            Question {
                                id: if text.is_empty() {
                                    i.to_string()
                                } else {
                                    text.clone()
                                },
                                header: q.get("header").and_then(Value::as_str).map(String::from),
                                question: text,
                                options: q
                                    .get("options")
                                    .and_then(Value::as_array)
                                    .map(|os| {
                                        os.iter()
                                            .map(|o| QuestionOption {
                                                label: o
                                                    .get("label")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("")
                                                    .to_string(),
                                                description: o
                                                    .get("description")
                                                    .and_then(Value::as_str)
                                                    .map(String::from),
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                multi_select: q
                                    .get("multiSelect")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                allow_free_text: true,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            self.pending_approvals.insert(
                request_id.to_string(),
                PendingApproval {
                    request_id: request_id.to_string(),
                    tool_name,
                    input,
                    suggestions,
                    is_question: true,
                },
            );
            out.push(Event::UserInputRequested {
                session_id: self.sid(),
                request: UserInputRequest {
                    id: request_id.to_string(),
                    session_id: self.sid(),
                    turn_id: self.turn_id(),
                    item_id: tool_use_id,
                    questions,
                    created_at: aura_core::now(),
                },
            });
            return;
        }

        let (kind, mut payload) = approval_payload(&tool_name, &input);
        if let Some(o) = payload.as_object_mut() {
            if !suggestions.is_empty() {
                o.insert(
                    "permission_suggestions".into(),
                    Value::Array(suggestions.clone()),
                );
            }
            if let Some(bp) = req.get("blocked_path") {
                o.insert("blocked_path".into(), bp.clone());
            }
            o.insert("tool_name".into(), json!(tool_name));
        }
        let has_rules = suggestions
            .iter()
            .any(|s| s.get("type").and_then(Value::as_str) == Some("addRules"));
        let mut options = vec![ApprovalOption::Accept];
        if has_rules {
            options.push(ApprovalOption::AcceptForSession);
        }
        options.push(ApprovalOption::Decline);
        options.push(ApprovalOption::EditInput);
        self.pending_approvals.insert(
            request_id.to_string(),
            PendingApproval {
                request_id: request_id.to_string(),
                tool_name: tool_name.clone(),
                input,
                suggestions,
                is_question: false,
            },
        );
        out.push(Event::ApprovalRequested {
            session_id: self.sid(),
            approval: Approval {
                id: request_id.to_string(),
                session_id: self.sid(),
                turn_id: self.turn_id(),
                item_id: tool_use_id,
                kind,
                title: display,
                description,
                payload,
                options,
                created_at: aura_core::now(),
            },
        });
    }

    fn handle_control_response(&mut self, v: &Value, out: &mut Vec<Event>) {
        let Some(resp) = v.get("response") else {
            return;
        };
        let Some(request_id) = resp.get("request_id").and_then(Value::as_str) else {
            return;
        };
        let Some(kind) = self.outbound.remove(request_id) else {
            // Echo of our own control_response; nothing to do.
            return;
        };
        let sub = resp.get("subtype").and_then(Value::as_str).unwrap_or("");
        if sub == "error" {
            let msg = resp
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("control request failed");
            out.push(Event::Notice {
                session_id: self.sid(),
                level: NoticeLevel::Error,
                message: msg.to_string(),
            });
            return;
        }
        if let OutboundControl::SetPermissionMode(_) = kind {
            let mode = resp
                .pointer("/response/mode")
                .and_then(Value::as_str)
                .map(String::from)
                .or_else(|| {
                    if let OutboundControl::SetPermissionMode(m) = &kind {
                        Some(m.clone())
                    } else {
                        None
                    }
                });
            if let Some(mode) = mode {
                if self.permission_mode.as_deref() != Some(mode.as_str()) {
                    self.permission_mode = Some(mode.clone());
                    out.push(Event::SettingChanged {
                        session_id: self.sid(),
                        setting: Setting::PermissionMode(mode),
                    });
                }
            }
        }
    }

    // ------------------------------------------------------ local commands

    /// Output of a command Claude Code runs itself (`/cost`, `/context`, ...).
    /// It arrives as a synthetic assistant message; show it as the command's
    /// output rather than as a reply from the agent.
    fn handle_local_command_output(&mut self, v: &Value, msg: &Value, out: &mut Vec<Event>) {
        let text = content_to_text(msg.get("content"));
        if self.compact_error.as_deref() == Some(text.trim()) {
            self.compact_error = None;
            return;
        }
        // Name it after what was typed: Claude reports aliases by their target
        // (`/cost` runs as `usage`), and some outputs do not name a command.
        let command = self.last_command.clone().or_else(|| {
            v.pointer("/local_command_run/command")
                .and_then(Value::as_str)
                .map(String::from)
        });
        let mut item = Item::new(&self.session_id, self.turn_id(), ItemKind::System)
            .with_text(text)
            .with_data(json!({ "command": command }));
        item.title = Some(
            command
                .map(|c| format!("/{c}"))
                .unwrap_or_else(|| "Command output".into()),
        );
        out.push(Event::ItemStarted {
            session_id: self.sid(),
            item: item.clone(),
        });
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.completed(),
        });
    }

    /// `/clear`: Claude starts a new conversation. The transcript keeps the
    /// old items, so mark where the agent's context now begins.
    fn handle_conversation_reset(&mut self, out: &mut Vec<Event>) {
        let item = Item::new(&self.session_id, self.turn_id(), ItemKind::System)
            .with_title("Context cleared")
            .with_data(json!({ "boundary": "clear", "message": "Context cleared" }));
        out.push(Event::ItemStarted {
            session_id: self.sid(),
            item: item.clone(),
        });
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.completed(),
        });
    }

    fn start_compacting(&mut self, out: &mut Vec<Event>) {
        if self.compacting.is_some() {
            return;
        }
        let item = Item::new(&self.session_id, self.turn_id(), ItemKind::System)
            .with_title("Compacting context")
            .with_data(json!({ "boundary": "compact", "message": "Compacting context" }));
        self.compacting = Some(item.id.clone());
        self.items.insert(item.id.clone(), item.clone());
        out.push(Event::ItemStarted {
            session_id: self.sid(),
            item,
        });
    }

    fn take_compacting(&mut self) -> Item {
        self.compacting
            .take()
            .and_then(|id| self.items.remove(&id))
            .unwrap_or_else(|| Item::new(&self.session_id, self.turn_id(), ItemKind::System))
    }

    fn fail_compacting(&mut self, err: &str, out: &mut Vec<Event>) {
        let message = format!("Compaction failed: {err}");
        let mut item = self.take_compacting();
        item.title = Some(message.clone());
        item.data = json!({ "boundary": "compact", "message": message });
        self.compact_error = Some(err.trim().to_string());
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.failed(),
        });
    }

    fn handle_compact_boundary(&mut self, v: &Value, out: &mut Vec<Event>) {
        let meta = v.get("compact_metadata").cloned().unwrap_or(json!({}));
        let trigger = meta
            .get("trigger")
            .and_then(Value::as_str)
            .unwrap_or("manual")
            .to_string();
        let pre = meta.get("pre_tokens").and_then(Value::as_u64);
        let post = meta.get("post_tokens").and_then(Value::as_u64);
        let message = if trigger == "auto" {
            "Context compacted automatically"
        } else {
            "Context compacted"
        };
        let mut item = self.take_compacting();
        item.title = Some(message.into());
        item.data = json!({
            "boundary": "compact",
            "message": message,
            "trigger": trigger,
            "pre_tokens": pre,
            "post_tokens": post,
        });
        self.compacted_to = post;
        self.preserved = meta
            .pointer("/preserved_messages/uuids")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        out.push(Event::ItemCompleted {
            session_id: self.sid(),
            item: item.completed(),
        });
    }

    fn is_preserved(&mut self, v: &Value) -> bool {
        v.get("uuid")
            .and_then(Value::as_str)
            .is_some_and(|u| self.preserved.remove(u))
    }

    /// Session usage after a local command. Its own result reports zeros, so
    /// keep the last model turn's numbers and adjust the context for commands
    /// that change it. None leaves the session's usage as it is.
    fn usage_after_local_command(&mut self, command: &str, v: &Value) -> Option<Usage> {
        let cost = v.get("total_cost_usd").and_then(Value::as_f64);
        match command {
            "clear" => {
                self.last_usage = None;
                self.compacted_to = None;
                Some(Usage {
                    total_cost_usd: cost,
                    ..usage_from_result(v, self.model.as_deref())
                })
            }
            _ => {
                let mut usage = self.last_usage.clone()?;
                usage.total_cost_usd = cost.or(usage.total_cost_usd);
                if command == "compact" {
                    if let Some(post) = self.compacted_to.take() {
                        usage.context_used = Some(post);
                    }
                }
                self.last_usage = Some(usage.clone());
                Some(usage)
            }
        }
    }

    /// Build the `control_response` payload for an approval decision, removing
    /// the pending entry. Returns None when the id is unknown.
    pub fn approval_response(
        &mut self,
        approval_id: &str,
        decision: &ApprovalDecision,
    ) -> Option<Value> {
        let pending = self.pending_approvals.remove(approval_id)?;
        let inner = match decision.option {
            ApprovalOption::Accept => json!({"behavior": "allow", "updatedInput": pending.input}),
            ApprovalOption::AcceptForSession => {
                let rules: Vec<Value> = pending
                    .suggestions
                    .iter()
                    .filter(|s| s.get("type").and_then(Value::as_str) == Some("addRules"))
                    .cloned()
                    .collect();
                if rules.is_empty() {
                    json!({"behavior": "allow", "updatedInput": pending.input})
                } else {
                    json!({"behavior": "allow", "updatedInput": pending.input, "updatedPermissions": rules})
                }
            }
            ApprovalOption::EditInput => json!({
                "behavior": "allow",
                "updatedInput": decision.updated_input.clone().unwrap_or(pending.input)
            }),
            ApprovalOption::Decline | ApprovalOption::Cancel => json!({
                "behavior": "deny",
                "message": decision.message.clone().unwrap_or_else(|| "Denied by user".to_string())
            }),
        };
        Some(json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": approval_id, "response": inner}
        }))
    }

    /// Build the `control_response` for an AskUserQuestion answer.
    pub fn input_response(&mut self, response: &UserInputResponse) -> Option<Value> {
        let pending = self.pending_approvals.remove(&response.request_id)?;
        let mut updated = pending.input.clone();
        let mut answers = Map::new();
        // Map question ids (question text) back to labels.
        if let Some(qs) = pending.input.get("questions").and_then(Value::as_array) {
            for (i, q) in qs.iter().enumerate() {
                let text = q
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let key = if text.is_empty() {
                    i.to_string()
                } else {
                    text.clone()
                };
                if let Some(vals) = response
                    .answers
                    .get(&key)
                    .or_else(|| response.answers.get(&i.to_string()))
                {
                    answers.insert(text, json!(vals.join(", ")));
                }
            }
        }
        for (k, vals) in &response.answers {
            if !answers.contains_key(k) && k.parse::<usize>().is_err() {
                answers.insert(k.clone(), json!(vals.join(", ")));
            }
        }
        if let Some(o) = updated.as_object_mut() {
            o.insert("answers".into(), Value::Object(answers));
        }
        Some(json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": response.request_id,
                "response": {"behavior": "allow", "updatedInput": updated}
            }
        }))
    }

    /// Items still open when the process dies.
    pub fn drain_open_items(&mut self) -> Vec<Event> {
        let mut out = vec![];
        let sid = self.sid();
        for (_, item) in self.items.drain() {
            out.push(Event::ItemCompleted {
                session_id: sid.clone(),
                item: item.failed(),
            });
        }
        self.blocks.clear();
        self.message_items.clear();
        if let Some(mut turn) = self.current_turn.take() {
            turn.status = TurnStatus::Failed;
            turn.ended_at = Some(aura_core::now());
            turn.error = Some("process exited".into());
            out.push(Event::TurnCompleted {
                session_id: self.sid(),
                turn,
            });
        }
        out
    }
}

fn tool_item(
    session_id: &str,
    turn_id: Option<String>,
    id: &str,
    name: &str,
    input: &Value,
) -> Item {
    let (kind, title, data) = classify_tool(name, input);
    let mut item = Item::new(session_id, turn_id, kind)
        .with_id(id)
        .with_data(data);
    item.title = Some(title);
    item
}

/// Map a Claude tool call to an item kind, title and structured data.
pub fn classify_tool(name: &str, input: &Value) -> (ItemKind, String, Value) {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match name {
        "Bash" => {
            let cmd = s("command");
            let desc = s("description");
            let title = if desc.is_empty() {
                cmd.clone()
            } else {
                desc.clone()
            };
            (
                ItemKind::CommandExec,
                title,
                json!({"command": cmd, "description": desc, "output": "", "tool_name": name, "input": input}),
            )
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let changes = file_changes(name, input);
            let path = changes
                .first()
                .and_then(|c| c.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            (
                ItemKind::FileChange,
                format!("{name} {path}"),
                json!({"changes": changes, "tool_name": name, "input": input}),
            )
        }
        "Task" | "Agent" => {
            let desc = s("description");
            let prompt = s("prompt");
            let title = if desc.is_empty() {
                prompt.chars().take(80).collect()
            } else {
                desc.clone()
            };
            (
                ItemKind::Subagent,
                title,
                json!({"description": desc, "prompt": prompt, "agent_type": s("subagent_type"), "tool_name": name, "input": input}),
            )
        }
        "WebSearch" | "WebFetch" => {
            let q = if name == "WebSearch" {
                s("query")
            } else {
                s("url")
            };
            (
                ItemKind::WebSearch,
                q.clone(),
                json!({"query": q, "tool_name": name, "input": input}),
            )
        }
        n if n.starts_with("mcp__") => {
            let mut parts = n.splitn(3, "__");
            parts.next();
            let server = parts.next().unwrap_or("").to_string();
            let tool = parts.next().unwrap_or("").to_string();
            (
                ItemKind::McpCall,
                format!("{server}: {tool}"),
                json!({"server": server, "tool": tool, "input": input, "tool_name": name}),
            )
        }
        _ => (
            ItemKind::ToolCall,
            name.to_string(),
            json!({"tool_name": name, "input": input}),
        ),
    }
}

fn file_changes(name: &str, input: &Value) -> Vec<Value> {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match name {
        "Write" => {
            let path = s("file_path");
            let content = s("content");
            let exists = std::path::Path::new(&path).exists();
            let old = if exists {
                std::fs::read_to_string(&path).unwrap_or_default()
            } else {
                String::new()
            };
            vec![json!({
                "path": path,
                "kind": if exists { "modify" } else { "add" },
                "diff": unified_diff(&old, &content, &path),
            })]
        }
        "Edit" => {
            let path = s("file_path");
            vec![
                json!({"path": path, "kind": "modify", "diff": unified_diff(&s("old_string"), &s("new_string"), &path)}),
            ]
        }
        "MultiEdit" => {
            let path = s("file_path");
            let mut diff = String::new();
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for e in edits {
                    let o = e.get("old_string").and_then(Value::as_str).unwrap_or("");
                    let n = e.get("new_string").and_then(Value::as_str).unwrap_or("");
                    diff.push_str(&unified_diff(o, n, &path));
                }
            }
            vec![json!({"path": path, "kind": "modify", "diff": diff})]
        }
        "NotebookEdit" => {
            let path = s("notebook_path");
            vec![
                json!({"path": path, "kind": "modify", "diff": unified_diff("", &s("new_source"), &path)}),
            ]
        }
        _ => vec![],
    }
}

pub fn unified_diff(old: &str, new: &str, path: &str) -> String {
    let old_n = if old.is_empty() || old.ends_with('\n') {
        old.to_string()
    } else {
        format!("{old}\n")
    };
    let new_n = if new.is_empty() || new.ends_with('\n') {
        new.to_string()
    } else {
        format!("{new}\n")
    };
    let diff = similar::TextDiff::from_lines(&old_n, &new_n);
    let mut out = String::new();
    out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    out.push_str(&diff.unified_diff().context_radius(3).to_string());
    out
}

fn approval_payload(tool_name: &str, input: &Value) -> (ApprovalKind, Value) {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match tool_name {
        "Bash" => (
            ApprovalKind::Command,
            json!({"command": s("command"), "description": s("description"), "cwd": Value::Null, "input": input}),
        ),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => (
            ApprovalKind::FileChange,
            json!({"changes": file_changes(tool_name, input), "input": input}),
        ),
        "ExitPlanMode" => (
            ApprovalKind::Generic,
            json!({"plan": input.get("plan").cloned().unwrap_or(Value::Null), "input": input}),
        ),
        _ => (ApprovalKind::Tool, json!({"input": input})),
    }
}

/// `"/compact keep it short"` -> `"compact"`.
fn slash_name(text: &str) -> Option<String> {
    let name = text
        .trim_start()
        .strip_prefix('/')?
        .split_whitespace()
        .next()?;
    (!name.is_empty() && !name.contains('/')).then(|| name.to_string())
}

fn content_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn usage_from_result(v: &Value, model: Option<&str>) -> Usage {
    let u = v.get("usage").cloned().unwrap_or(json!({}));
    let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = g("input_tokens");
    let cache_read = g("cache_read_input_tokens");
    let cache_create = g("cache_creation_input_tokens");
    let output = g("output_tokens");
    let mut context_window = None;
    if let Some(mu) = v.get("modelUsage").and_then(Value::as_object) {
        if let Some(m) = model.and_then(|m| mu.get(m)) {
            context_window = m.get("contextWindow").and_then(Value::as_u64);
        }
        if context_window.is_none() {
            context_window = mu
                .values()
                .filter_map(|m| m.get("contextWindow").and_then(Value::as_u64))
                .max();
        }
    }
    let context_used = u
        .get("iterations")
        .and_then(Value::as_array)
        .and_then(|it| it.last())
        .map(|last| {
            let f = |k: &str| last.get(k).and_then(Value::as_u64).unwrap_or(0);
            f("input_tokens")
                + f("cache_read_input_tokens")
                + f("cache_creation_input_tokens")
                + f("output_tokens")
        })
        .filter(|n| *n > 0);
    Usage {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cache_read + cache_create,
        total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        context_window,
        context_used,
    }
}
