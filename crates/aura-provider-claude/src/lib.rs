//! Claude Code provider: drives `claude -p --input-format stream-json` and maps
//! its protocol onto the unified `aura_core` model.
//!
//! Protocol notes and a real traffic capture live in `docs/protocol/claude/`.

pub mod driver;
pub mod models;
pub mod native;
pub mod parser;
pub mod provider;

pub use driver::ClaudeDriver;
pub use parser::Parser;
pub use provider::ClaudeProvider;

use std::sync::Arc;

/// Convenience constructor returning the provider as a trait object.
pub fn provider() -> Arc<dyn aura_core::Provider> {
    Arc::new(ClaudeProvider::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_core::*;
    use serde_json::Value;

    fn fixture_lines() -> Vec<(String, Value)> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/protocol/claude/traffic.jsonl"
        );
        let text = std::fs::read_to_string(path).expect("fixture traffic.jsonl");
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                (v["dir"].as_str().unwrap().to_string(), v["msg"].clone())
            })
            .collect()
    }

    /// Replays the capture: `out` user messages call start_turn (as the driver
    /// does), `out` control requests are noted, `in` lines go to handle_line.
    fn replay() -> Vec<Event> {
        let mut p = Parser::new("sess-1");
        let mut events = vec![];
        for (dir, msg) in fixture_lines() {
            match dir.as_str() {
                "out" => match msg.get("type").and_then(Value::as_str) {
                    Some("user") => {
                        let text = msg
                            .pointer("/message/content/0/text")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        events.extend(p.start_turn(text));
                    }
                    Some("control_request") => {
                        let id = msg["request_id"].as_str().unwrap();
                        let kind = match msg.pointer("/request/subtype").and_then(Value::as_str) {
                            Some("interrupt") => parser::OutboundControl::Interrupt,
                            Some("set_permission_mode") => {
                                parser::OutboundControl::SetPermissionMode(
                                    msg.pointer("/request/mode")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .into(),
                                )
                            }
                            _ => parser::OutboundControl::Other,
                        };
                        p.note_outbound(id, kind);
                    }
                    Some("control_response") => {
                        // The driver would have built this via approval_response / input_response.
                        let rid = msg
                            .pointer("/response/request_id")
                            .and_then(Value::as_str)
                            .unwrap();
                        let pending = p
                            .pending_approvals
                            .get(rid)
                            .cloned()
                            .expect("pending approval");
                        if pending.is_question {
                            let mut answers = std::collections::HashMap::new();
                            answers.insert(
                                "Do you prefer red or blue?".to_string(),
                                vec!["Red".to_string()],
                            );
                            let resp = p
                                .input_response(&UserInputResponse {
                                    request_id: rid.into(),
                                    answers,
                                    declined: false,
                                })
                                .unwrap();
                            assert_eq!(resp.pointer("/response/response/updatedInput/answers/Do you prefer red or blue?"), Some(&Value::String("Red".into())));
                        } else {
                            let resp = p
                                .approval_response(
                                    rid,
                                    &ApprovalDecision {
                                        option: ApprovalOption::Accept,
                                        updated_input: None,
                                        message: None,
                                    },
                                )
                                .unwrap();
                            assert_eq!(
                                resp.pointer("/response/response/behavior"),
                                Some(&Value::String("allow".into()))
                            );
                        }
                    }
                    _ => {}
                },
                "in" if msg.is_object() => {
                    events.extend(p.handle_line(&msg));
                }
                _ => {}
            }
        }
        assert!(p.pending_approvals.is_empty(), "all approvals answered");
        events
    }

    #[test]
    fn replay_capture_produces_expected_events() {
        let events = replay();

        let approvals: Vec<&Approval> = events
            .iter()
            .filter_map(|e| {
                if let Event::ApprovalRequested { approval, .. } = e {
                    Some(approval)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(approvals.len(), 1, "exactly one approval");
        assert_eq!(approvals[0].kind, ApprovalKind::Command);
        assert!(approvals[0].payload["command"]
            .as_str()
            .unwrap()
            .contains("hello.txt"));
        assert!(
            approvals[0]
                .options
                .contains(&ApprovalOption::AcceptForSession),
            "addRules suggestion present"
        );

        let inputs: Vec<&UserInputRequest> = events
            .iter()
            .filter_map(|e| {
                if let Event::UserInputRequested { request, .. } = e {
                    Some(request)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].questions.len(), 1);
        let labels: Vec<&str> = inputs[0].questions[0]
            .options
            .iter()
            .map(|o| o.label.as_str())
            .collect();
        assert_eq!(labels, vec!["Red", "Blue"]);

        let turns: Vec<&Turn> = events
            .iter()
            .filter_map(|e| {
                if let Event::TurnCompleted { turn, .. } = e {
                    Some(turn)
                } else {
                    None
                }
            })
            .collect();
        assert!(turns.len() >= 4, "got {} turns", turns.len());
        assert!(turns[0].usage.as_ref().unwrap().total_cost_usd.unwrap() > 0.0);
        assert_eq!(turns[0].status, TurnStatus::Completed);
        assert_eq!(
            turns[2].status,
            TurnStatus::Interrupted,
            "third turn was interrupted"
        );
        assert!(turns[0].usage.as_ref().unwrap().context_window.unwrap() > 0);

        let native: Vec<&str> = events
            .iter()
            .filter_map(|e| {
                if let Event::NativeId { native_id, .. } = e {
                    Some(native_id.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(native, vec!["6bd613c3-559c-4cb9-b53c-5b1196062f48"]);

        let completed: Vec<&Item> = events
            .iter()
            .filter_map(|e| {
                if let Event::ItemCompleted { item, .. } = e {
                    Some(item)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            completed.iter().any(|i| i.kind == ItemKind::Reasoning),
            "reasoning item"
        );
        let cmd = completed
            .iter()
            .find(|i| i.kind == ItemKind::CommandExec)
            .expect("command exec item");
        assert_eq!(cmd.status, ItemStatus::Completed);
        assert_eq!(cmd.data["is_error"], Value::Bool(false));
        assert!(cmd.data["command"].as_str().unwrap().contains("hello.txt"));
        assert_eq!(cmd.data["exit_code"], Value::from(0));

        // Streamed agent text ends up complete.
        let done = completed
            .iter()
            .find(|i| i.kind == ItemKind::AgentMessage && i.text == "done.")
            .expect("agent message 'done.'");
        assert_eq!(done.status, ItemStatus::Completed);
        // Text deltas were streamed for it before completion.
        assert!(events.iter().any(|e| matches!(e, Event::ItemDelta { item_id, delta: ItemDelta::Text { .. }, .. } if item_id == &done.id)));

        // Synthetic /model response arrives without stream events and shows as the command's output.
        let model = completed
            .iter()
            .find(|i| i.text.starts_with("Current model:"))
            .expect("/model output");
        assert_eq!(model.kind, ItemKind::System);
        assert_eq!(model.data["command"], "model");
        assert_eq!(model.title.as_deref(), Some("/model"));

        // User messages: 4 sent, none duplicated by the replay echo.
        let users = completed
            .iter()
            .filter(|i| i.kind == ItemKind::UserMessage)
            .count();
        assert_eq!(users, 4);

        // Settings observed.
        assert!(events.iter().any(|e| matches!(e, Event::SettingChanged { setting: Setting::Model(m), .. } if m == "claude-fable-5-1")));
        assert!(events.iter().any(|e| matches!(e, Event::SettingChanged { setting: Setting::PermissionMode(m), .. } if m == "acceptEdits")));

        // No item left open after the last result.
        assert!(events.iter().any(|e| matches!(e, Event::Usage { .. })));
    }

    #[test]
    fn approval_decline_and_edit_payloads() {
        let mut p = Parser::new("s");
        let req = serde_json::json!({
            "type": "control_request", "request_id": "r1",
            "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "rm -rf x"}}
        });
        let evs = p.handle_line(&req);
        assert!(matches!(evs[0], Event::ApprovalRequested { .. }));
        let deny = p
            .approval_response(
                "r1",
                &ApprovalDecision {
                    option: ApprovalOption::Decline,
                    updated_input: None,
                    message: Some("no".into()),
                },
            )
            .unwrap();
        assert_eq!(deny.pointer("/response/response/behavior").unwrap(), "deny");
        assert_eq!(deny.pointer("/response/response/message").unwrap(), "no");
        assert!(p
            .approval_response(
                "r1",
                &ApprovalDecision {
                    option: ApprovalOption::Accept,
                    updated_input: None,
                    message: None
                }
            )
            .is_none());

        p.handle_line(&serde_json::json!({
            "type": "control_request", "request_id": "r2",
            "request": {"subtype": "can_use_tool", "tool_name": "Write", "input": {"file_path": "/tmp/aura-nope/a.txt", "content": "hi"}}
        }));
        let edit = p
            .approval_response(
                "r2",
                &ApprovalDecision {
                    option: ApprovalOption::EditInput,
                    updated_input: Some(
                        serde_json::json!({"file_path": "/tmp/aura-nope/b.txt", "content": "hi"}),
                    ),
                    message: None,
                },
            )
            .unwrap();
        assert_eq!(
            edit.pointer("/response/response/updatedInput/file_path")
                .unwrap(),
            "/tmp/aura-nope/b.txt"
        );
    }

    #[test]
    fn declined_question_is_denied_to_the_model() {
        let mut p = Parser::new("s");
        let evs = p.handle_line(&serde_json::json!({
            "type": "control_request", "request_id": "q1",
            "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": {"questions": [
                {"question": "Red or blue?", "header": "Color", "multiSelect": false, "options": [{"label": "Red"}, {"label": "Blue"}]}
            ]}}
        }));
        assert!(matches!(evs[0], Event::UserInputRequested { .. }));
        let resp = p
            .input_response(&UserInputResponse {
                request_id: "q1".into(),
                answers: Default::default(),
                declined: true,
            })
            .unwrap();
        assert_eq!(resp.pointer("/response/request_id").unwrap(), "q1");
        assert_eq!(resp.pointer("/response/response/behavior").unwrap(), "deny");
        assert!(resp
            .pointer("/response/response/message")
            .and_then(Value::as_str)
            .is_some_and(|m| m.contains("dismissed")));
        assert!(p.pending_approvals.is_empty());
    }

    #[test]
    fn file_change_classification_builds_diff() {
        let (kind, _title, data) = parser::classify_tool(
            "Edit",
            &serde_json::json!({"file_path": "src/a.rs", "old_string": "let a = 1;", "new_string": "let a = 2;"}),
        );
        assert_eq!(kind, ItemKind::FileChange);
        let diff = data["changes"][0]["diff"].as_str().unwrap();
        assert!(diff.contains("-let a = 1;"));
        assert!(diff.contains("+let a = 2;"));
        let (kind, _, data) =
            parser::classify_tool("mcp__github__list_prs", &serde_json::json!({"repo": "x"}));
        assert_eq!(kind, ItemKind::McpCall);
        assert_eq!(data["server"], "github");
        assert_eq!(data["tool"], "list_prs");
    }

    #[test]
    fn typed_slash_settings_update_session_state() {
        let mut p = Parser::new("s1");
        let ev = p.start_turn("/effort medium");
        assert!(ev.iter().any(|e| matches!(e, Event::SettingChanged { setting: Setting::Effort(v), .. } if v == "medium")));
        // Same value again is a no-op.
        assert!(!p
            .start_turn("/effort medium")
            .iter()
            .any(|e| matches!(e, Event::SettingChanged { .. })));
        let ev = p.start_turn("/model claude-opus-5");
        assert!(ev.iter().any(|e| matches!(e, Event::SettingChanged { setting: Setting::Model(v), .. } if v == "claude-opus-5")));
        // Ordinary text and bare or multi-word commands do not.
        for t in [
            "hello /effort low",
            "/effort",
            "/compact keep the summary short",
        ] {
            assert!(
                !p.start_turn(t)
                    .iter()
                    .any(|e| matches!(e, Event::SettingChanged { .. })),
                "{t}"
            );
        }
    }

    fn items_completed(events: &[Event]) -> Vec<Item> {
        events
            .iter()
            .filter_map(|e| match e {
                Event::ItemCompleted { item, .. } => Some(item.clone()),
                _ => None,
            })
            .collect()
    }

    fn zero_result(local_command: &str, session_id: &str) -> Value {
        serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false, "session_id": session_id,
            "total_cost_usd": 0.03, "num_turns": 0, "result": "", "local_command": local_command,
            "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "iterations": []},
            "modelUsage": {}
        })
    }

    fn model_result() -> Value {
        serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false, "session_id": "n1", "total_cost_usd": 0.02,
            "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0,
                      "iterations": [{"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 25000, "cache_creation_input_tokens": 0}]},
            "modelUsage": {"claude-haiku-4-5": {"inputTokens": 10, "outputTokens": 5, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 0, "contextWindow": 200000}}
        })
    }

    /// A stream event of one API call, in the main thread or a subagent's.
    fn call_event(parent: Option<&str>, event: Value) -> Value {
        serde_json::json!({"type": "stream_event", "parent_tool_use_id": parent, "event": event})
    }

    fn message_start(parent: Option<&str>, id: &str, model: &str, cache_read: u64) -> Value {
        call_event(
            parent,
            serde_json::json!({"type": "message_start", "message": {"id": id, "model": model, "usage": {
                "input_tokens": 2, "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": 100, "output_tokens": 1}}}),
        )
    }

    fn turn_of(events: &[Event]) -> Turn {
        events
            .iter()
            .find_map(|e| match e {
                Event::TurnCompleted { turn, .. } => Some(turn.clone()),
                _ => None,
            })
            .expect("turn completed")
    }

    fn usage_of(events: &[Event]) -> Option<Usage> {
        events.iter().find_map(|e| match e {
            Event::Usage { usage, .. } => Some(usage.clone()),
            _ => None,
        })
    }

    #[test]
    fn local_command_output_is_not_an_agent_reply() {
        let mut p = Parser::new("s");
        p.start_turn("/cost");
        let ev = p.handle_line(&serde_json::json!({
            "type": "assistant", "parent_tool_use_id": null,
            "message": {"id": "m1", "model": "<synthetic>", "role": "assistant", "content": [{"type": "text", "text": "Total cost: $0.03"}]},
            "local_command_source": "<local-command-stdout>Total cost: $0.03</local-command-stdout>",
            "local_command_run": {"command": "cost", "args": ""}
        }));
        let items = items_completed(&ev);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, ItemKind::System);
        assert_eq!(items[0].text, "Total cost: $0.03");
        assert_eq!(items[0].data["command"], "cost");

        // Commands unavailable in -p mode reply without `local_command_run`;
        // the name comes from what we sent.
        p.start_turn("/status");
        let ev = p.handle_line(&serde_json::json!({
            "type": "assistant",
            "message": {"id": "m2", "model": "<synthetic>", "content": [{"type": "text", "text": "/status isn't available in this environment."}]},
            "local_command_source": "<local-command-stdout>/status isn't available in this environment.</local-command-stdout>"
        }));
        assert_eq!(items_completed(&ev)[0].data["command"], "status");

        // Aliases are labelled as typed, not by the command Claude ran.
        p.start_turn("/cost");
        let ev = p.handle_line(&serde_json::json!({
            "type": "assistant",
            "message": {"id": "m3", "model": "<synthetic>", "content": [{"type": "text", "text": "Current session: 8% used"}]},
            "local_command_source": "<local-command-stdout>Current session: 8% used</local-command-stdout>",
            "local_command_run": {"command": "usage", "args": ""}
        }));
        assert_eq!(items_completed(&ev)[0].data["command"], "cost");
    }

    #[test]
    fn clear_marks_a_context_boundary_and_resets_context_usage() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        let ev = p.handle_line(&model_result());
        assert_eq!(usage_of(&ev).unwrap().context_used, Some(25015));

        p.start_turn("/clear");
        let ev = p.handle_line(&serde_json::json!({"type": "conversation_reset", "new_conversation_id": "c2", "session_id": "n1"}));
        let items = items_completed(&ev);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, ItemKind::System);
        assert_eq!(items[0].data["boundary"], "clear");
        let ev = p.handle_line(&zero_result("clear", "n2"));
        let usage = usage_of(&ev).expect("usage after clear");
        assert_eq!(usage.context_used, None);
        assert!(ev
            .iter()
            .any(|e| matches!(e, Event::NativeId { native_id, .. } if native_id == "n2")));
        let turn = ev
            .iter()
            .find_map(|e| match e {
                Event::TurnCompleted { turn, .. } => Some(turn.clone()),
                _ => None,
            })
            .unwrap();
        assert!(turn.usage.is_none(), "local command turns carry no usage");
    }

    #[test]
    fn other_local_commands_keep_the_last_usage() {
        let mut p = Parser::new("s");
        // Before any model turn there is nothing to keep, so usage is left alone.
        p.start_turn("/cost");
        assert!(usage_of(&p.handle_line(&zero_result("cost", "n1"))).is_none());

        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("/context");
        let usage = usage_of(&p.handle_line(&zero_result("context", "n1"))).unwrap();
        assert_eq!(usage.context_used, Some(25015));
        assert_eq!(usage.context_window, Some(200000));
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.total_cost_usd, Some(0.03));
    }

    #[test]
    fn compaction_shows_progress_then_a_boundary() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("/compact");
        let ev = p.handle_line(
            &serde_json::json!({"type": "system", "subtype": "status", "status": "compacting"}),
        );
        let started = ev
            .iter()
            .find_map(|e| match e {
                Event::ItemStarted { item, .. } => Some(item.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(started.status, ItemStatus::InProgress);
        assert_eq!(started.data["boundary"], "compact");
        assert!(p.handle_line(&serde_json::json!({"type": "system", "subtype": "status", "status": null, "compact_result": "success"})).is_empty());
        let ev = p.handle_line(&serde_json::json!({
            "type": "system", "subtype": "compact_boundary",
            "compact_metadata": {"trigger": "manual", "pre_tokens": 25865, "post_tokens": 4470}
        }));
        let done = items_completed(&ev);
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0].id, started.id,
            "the progress item becomes the boundary"
        );
        assert_eq!(done[0].status, ItemStatus::Completed);
        assert_eq!(done[0].data["pre_tokens"], 25865);
        assert_eq!(done[0].data["post_tokens"], 4470);
        let usage = usage_of(&p.handle_line(&zero_result("compact", "n1"))).unwrap();
        assert_eq!(usage.context_used, Some(4470));

        // Messages the compaction kept are emitted again; they are already shown.
        let kept = serde_json::json!({
            "type": "assistant", "uuid": "kept-1",
            "message": {"id": "m9", "model": "<synthetic>", "content": [{"type": "text", "text": "Usage: /effort <low|medium>"}]},
            "local_command_source": "<local-command-stdout>Usage: /effort <low|medium></local-command-stdout>",
            "local_command_run": {"command": "effort", "args": ""}
        });
        p.handle_line(&serde_json::json!({
            "type": "system", "subtype": "compact_boundary",
            "compact_metadata": {"trigger": "manual", "post_tokens": 4000, "preserved_messages": {"uuids": ["kept-1"]}}
        }));
        assert!(p.handle_line(&kept).is_empty());
        // Only once: a later message with that uuid is not swallowed.
        assert!(!items_completed(&p.handle_line(&kept)).is_empty());

        // Auto compaction mid-turn has no progress status first.
        let ev = p.handle_line(&serde_json::json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto"}}));
        assert_eq!(
            items_completed(&ev)[0].data["message"],
            "Context compacted automatically"
        );
    }

    #[test]
    fn failed_compaction_is_shown_once() {
        let mut p = Parser::new("s");
        p.start_turn("/compact");
        p.handle_line(
            &serde_json::json!({"type": "system", "subtype": "status", "status": "compacting"}),
        );
        let ev = p.handle_line(&serde_json::json!({
            "type": "system", "subtype": "status", "status": null,
            "compact_result": "failed", "compact_error": "Not enough messages to compact."
        }));
        let done = items_completed(&ev);
        assert_eq!(done[0].status, ItemStatus::Failed);
        assert_eq!(
            done[0].data["message"],
            "Compaction failed: Not enough messages to compact."
        );
        // Claude repeats the error as command output; drop the duplicate.
        let ev = p.handle_line(&serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "model": "<synthetic>", "content": [{"type": "text", "text": "Not enough messages to compact."}]},
            "local_command_source": "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
            "local_command_run": {"command": "compact", "args": ""}
        }));
        assert!(items_completed(&ev).is_empty());
    }

    #[test]
    fn unknown_messages_are_ignored() {
        let mut p = Parser::new("s");
        assert!(p
            .handle_line(&serde_json::json!({"type": "something_new", "x": 1}))
            .is_empty());
        assert!(p.handle_line(&serde_json::json!({"nope": true})).is_empty());
        assert!(p
            .handle_line(&serde_json::json!({"type": "system", "subtype": "brand_new"}))
            .is_empty());
    }

    #[test]
    fn provider_info_reports_binary() {
        let p = ClaudeProvider::new();
        let info = p.info();
        assert_eq!(info.kind, ProviderKind::Claude);
        assert!(info.capabilities.structured);
        if info.available {
            assert!(info.version.is_some(), "version parsed when binary present");
        }
    }

    /// Live test against the real CLI. Run with:
    /// `AURA_LIVE_TESTS=1 cargo test -p aura-provider-claude -- --ignored live_`
    #[tokio::test]
    #[ignore]
    async fn live_roundtrip_pong() {
        if std::env::var("AURA_LIVE_TESTS").is_err() {
            eprintln!("AURA_LIVE_TESTS not set; skipping");
            return;
        }
        let provider = ClaudeProvider::new();
        assert!(provider.binary().is_some(), "claude binary required");
        let tmp = tempfile::tempdir().unwrap();
        let opts = CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: tmp.path().to_string_lossy().to_string(),
            ..Default::default()
        };
        let session = Session::new(&opts);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let driver = provider.start(&session, false, tx).await.unwrap();
        driver
            .send(Input {
                text: "Reply with exactly: pong".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        let mut completed = None;
        let mut native = None;
        while tokio::time::Instant::now() < deadline {
            let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await else {
                break;
            };
            match ev {
                Event::TurnCompleted { turn, .. } => {
                    completed = Some(turn);
                    break;
                }
                Event::NativeId { native_id, .. } => native = Some(native_id),
                _ => {}
            }
        }
        let turn = completed.expect("turn completed");
        assert_eq!(turn.status, TurnStatus::Completed);
        assert!(native.is_some());
        driver.stop().await.unwrap();
    }

    #[test]
    fn context_follows_each_main_thread_call() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("go on");
        // Each API call reports its context as it starts, long before the result.
        let usage = usage_of(&p.handle_line(&message_start(None, "m1", "claude-haiku-4-5", 30000)))
            .unwrap();
        assert_eq!(usage.context_used, Some(30103));
        assert_eq!(usage.context_window, Some(200000), "the window is kept");
        assert_eq!(usage.input_tokens, 10, "the totals are kept");
        // Its end adds the final output count.
        let delta = call_event(
            None,
            serde_json::json!({"type": "message_delta", "usage": {"output_tokens": 400}}),
        );
        assert_eq!(
            usage_of(&p.handle_line(&delta)).unwrap().context_used,
            Some(30502)
        );
        // A subagent's calls fill its own context, not this one.
        assert!(usage_of(&p.handle_line(&message_start(
            Some("toolu_1"),
            "m2",
            "claude-haiku-4-5",
            90000
        )))
        .is_none());
        let delta = call_event(
            Some("toolu_1"),
            serde_json::json!({"type": "message_delta", "usage": {"output_tokens": 9}}),
        );
        assert!(usage_of(&p.handle_line(&delta)).is_none());
        // Recent CLIs repeat the input side at the end; it is the final count.
        let delta = call_event(
            None,
            serde_json::json!({"type": "message_delta", "usage": {
            "input_tokens": 2, "cache_read_input_tokens": 31000, "cache_creation_input_tokens": 0, "output_tokens": 10}}),
        );
        assert_eq!(
            usage_of(&p.handle_line(&delta)).unwrap().context_used,
            Some(31012)
        );
    }

    #[test]
    fn session_totals_span_turns_and_a_turn_gets_its_share() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        let ev = p.handle_line(&model_result());
        let turn = turn_of(&ev);
        assert_eq!(turn.usage.as_ref().unwrap().input_tokens, 10);
        assert_eq!(turn.usage.as_ref().unwrap().total_cost_usd, Some(0.02));

        // `usage` covers this turn's main thread only; `modelUsage` and the cost
        // are totals for the conversation, a subagent's model included.
        p.start_turn("again");
        let ev = p.handle_line(&serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false, "session_id": "n1", "total_cost_usd": 0.05,
            "usage": {"input_tokens": 4, "output_tokens": 7, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 50,
                      "iterations": [{"input_tokens": 2, "output_tokens": 3, "cache_read_input_tokens": 26000, "cache_creation_input_tokens": 50}]},
            "modelUsage": {
                "claude-haiku-4-5": {"inputTokens": 14, "outputTokens": 12, "cacheReadInputTokens": 400, "cacheCreationInputTokens": 50, "contextWindow": 200000},
                "claude-sonnet-4-5": {"inputTokens": 6, "outputTokens": 8, "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 0, "contextWindow": 200000}
            }
        }));
        let usage = usage_of(&ev).unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_input_tokens
            ),
            (20, 20, 1450)
        );
        assert_eq!(usage.total_cost_usd, Some(0.05));
        assert_eq!(usage.context_used, Some(26055));
        let turn = turn_of(&ev).usage.unwrap();
        assert_eq!(
            (
                turn.input_tokens,
                turn.output_tokens,
                turn.cached_input_tokens
            ),
            (10, 15, 1350)
        );
        assert!(
            (turn.total_cost_usd.unwrap() - 0.03).abs() < 1e-9,
            "{:?}",
            turn.total_cost_usd
        );
    }

    #[test]
    fn a_resumed_session_measures_turns_from_its_stored_usage() {
        // Claude restores the totals on resume; the host seeds what it stored.
        let mut p = Parser::new("s");
        p.usage = Some(Usage {
            input_tokens: 8,
            output_tokens: 4,
            cached_input_tokens: 90,
            total_cost_usd: Some(0.015),
            context_window: Some(200000),
            context_used: Some(20000),
            running_totals: true,
        });
        p.start_turn("/context");
        let mut result = zero_result("context", "n1");
        result["total_cost_usd"] = serde_json::json!(0.015);
        let usage = usage_of(&p.handle_line(&result)).expect("kept");
        assert_eq!(usage.context_used, Some(20000));
        p.start_turn("hi");
        let turn = turn_of(&p.handle_line(&model_result())).usage.unwrap();
        assert_eq!((turn.input_tokens, turn.output_tokens), (2, 1));
        assert!((turn.total_cost_usd.unwrap() - 0.005).abs() < 1e-9);
    }

    #[test]
    fn an_interrupted_turn_keeps_the_context() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("write an essay");
        p.handle_line(&message_start(None, "m1", "claude-haiku-4-5", 26000));
        // An aborted call is not in the result: no iterations, totals unchanged.
        let ev = p.handle_line(&serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_streaming",
            "session_id": "n1", "total_cost_usd": 0.02,
            "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "iterations": []},
            "modelUsage": {"claude-haiku-4-5": {"inputTokens": 10, "outputTokens": 5, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 0, "contextWindow": 200000}}
        }));
        let usage = usage_of(&ev).unwrap();
        assert_eq!(usage.context_used, Some(26103));
        assert_eq!(usage.context_window, Some(200000));
        assert_eq!(turn_of(&ev).status, TurnStatus::Interrupted);
        assert_eq!(turn_of(&ev).usage.unwrap().total_cost_usd, Some(0.0));
    }

    #[test]
    fn the_context_window_is_the_model_in_use() {
        let mut p = Parser::new("s");
        // The session was started with an alias; the API names the real model.
        p.model = Some("opus".into());
        p.start_turn("hi");
        p.handle_line(&message_start(None, "m1", "claude-opus-4-6", 20000));
        // A subagent on another model must not decide the window.
        p.handle_line(&message_start(
            Some("toolu_1"),
            "m2",
            "claude-haiku-4-5",
            1000,
        ));
        let mut result = model_result();
        result["modelUsage"] = serde_json::json!({
            "claude-haiku-4-5": {"inputTokens": 1, "contextWindow": 200000},
            "claude-opus-4-6[1m]": {"inputTokens": 1, "contextWindow": 1000000}
        });
        assert_eq!(
            usage_of(&p.handle_line(&result)).unwrap().context_window,
            Some(1000000)
        );

        // Switched to a smaller model: its window, though a larger one is listed.
        p.start_turn("more");
        p.handle_line(&message_start(None, "m3", "claude-sonnet-4-5", 20000));
        result["modelUsage"]["claude-sonnet-4-5"] =
            serde_json::json!({"inputTokens": 1, "contextWindow": 200000});
        assert_eq!(
            usage_of(&p.handle_line(&result)).unwrap().context_window,
            Some(200000)
        );
    }

    #[test]
    fn compaction_drops_the_context_at_its_boundary_and_adds_its_cost() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("big task");
        p.handle_line(&message_start(None, "m1", "claude-haiku-4-5", 150000));
        // Auto compaction mid-turn: the context is small again right away.
        let ev = p.handle_line(
            &serde_json::json!({"type": "system", "subtype": "compact_boundary",
            "compact_metadata": {"trigger": "auto", "pre_tokens": 150103, "post_tokens": 9000}}),
        );
        assert_eq!(usage_of(&ev).unwrap().context_used, Some(9000));

        // A manual compaction calls the model too; its result counts that.
        p.start_turn("/compact");
        p.handle_line(
            &serde_json::json!({"type": "system", "subtype": "compact_boundary",
            "compact_metadata": {"trigger": "manual", "pre_tokens": 30000, "post_tokens": 5000}}),
        );
        let mut result = zero_result("compact", "n1");
        result["total_cost_usd"] = serde_json::json!(0.09);
        result["modelUsage"] = serde_json::json!({"claude-haiku-4-5": {"inputTokens": 4800, "outputTokens": 1000, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 0, "contextWindow": 200000}});
        let usage = usage_of(&p.handle_line(&result)).unwrap();
        assert_eq!(usage.context_used, Some(5000));
        assert_eq!((usage.input_tokens, usage.output_tokens), (4800, 1000));
        assert_eq!(usage.total_cost_usd, Some(0.09));
    }

    #[test]
    fn clear_starts_the_totals_over_but_keeps_the_window() {
        let mut p = Parser::new("s");
        p.start_turn("hi");
        p.handle_line(&model_result());
        p.start_turn("/clear");
        let mut result = zero_result("clear", "n2");
        result["total_cost_usd"] = serde_json::json!(0);
        let usage = usage_of(&p.handle_line(&result)).unwrap();
        assert_eq!(
            usage,
            Usage {
                total_cost_usd: Some(0.0),
                context_window: Some(200000),
                running_totals: true,
                ..Default::default()
            }
        );
        // The next call shows its context against that window before the result.
        let usage = usage_of(&p.handle_line(&message_start(None, "m1", "claude-haiku-4-5", 12000)))
            .unwrap();
        assert_eq!(
            (usage.context_used, usage.context_window),
            (Some(12103), Some(200000))
        );
    }

    #[test]
    fn the_first_turn_after_an_upgrade_is_not_measured_against_old_usage() {
        // An older Aura stored one turn's main-thread tokens, not totals.
        let mut p = Parser::new("s");
        p.usage = Some(Usage {
            input_tokens: 2,
            output_tokens: 5,
            cached_input_tokens: 29293,
            total_cost_usd: Some(0.015),
            context_window: Some(200000),
            context_used: Some(20000),
            running_totals: false,
        });
        p.start_turn("hi");
        let mut result = model_result();
        result["modelUsage"]["claude-haiku-4-5"] = serde_json::json!({"inputTokens": 40, "outputTokens": 900, "cacheReadInputTokens": 150000, "cacheCreationInputTokens": 30000, "contextWindow": 200000});
        let ev = p.handle_line(&result);
        let usage = usage_of(&ev).unwrap();
        assert!(usage.running_totals);
        assert_eq!(usage.input_tokens, 40);
        // The turn's own tokens, not the totals less an unrelated number.
        let turn = turn_of(&ev).usage.unwrap();
        assert_eq!(
            (
                turn.input_tokens,
                turn.output_tokens,
                turn.cached_input_tokens
            ),
            (10, 5, 100)
        );
        assert!((turn.total_cost_usd.unwrap() - 0.005).abs() < 1e-9);
        assert!(!turn.running_totals);

        // From then on the stored totals are a baseline.
        p.start_turn("again");
        result["total_cost_usd"] = serde_json::json!(0.03);
        result["modelUsage"]["claude-haiku-4-5"]["inputTokens"] = serde_json::json!(55);
        let turn = turn_of(&p.handle_line(&result)).usage.unwrap();
        assert_eq!(turn.input_tokens, 15);
    }
}
