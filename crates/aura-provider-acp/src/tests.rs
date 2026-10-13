//! Driver tests against an in-process fake agent speaking ACP over a duplex
//! pipe, so they need no agent installed and run on every platform.

use super::*;
use tokio::io::{AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::io::{DuplexStream, Lines};

struct FakeAgent {
    lines: Lines<BufReader<ReadHalf<DuplexStream>>>,
    w: WriteHalf<DuplexStream>,
}

impl FakeAgent {
    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line()).await.expect("agent read timed out").unwrap().expect("client closed");
        serde_json::from_str(&line).unwrap()
    }

    /// Next message, which must be a request for `method`. Returns its id and params.
    async fn expect(&mut self, method: &str) -> (Value, Value) {
        let msg = self.recv().await;
        assert_eq!(msg["method"], method, "{msg}");
        (msg["id"].clone(), msg["params"].clone())
    }

    async fn send(&mut self, v: Value) {
        self.w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }

    async fn respond(&mut self, id: Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
    }

    async fn update(&mut self, update: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "acp-1", "update": update } })).await;
    }
}

fn link() -> (Link, FakeAgent) {
    let (a, b) = tokio::io::duplex(256 * 1024);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let (conn, incoming) = Connection::new(ar, aw);
    (Link { conn, incoming, child: None, group: None, stderr: Arc::new(Mutex::new(VecDeque::new())) }, FakeAgent { lines: BufReader::new(br).lines(), w: bw })
}

fn spec() -> AgentSpec {
    AgentSpec { id: "fake".into(), display_name: "Fake Agent".into(), command: vec!["fake".into()], env: Default::default(), source: "builtin" }
}

fn session(native_id: Option<&str>, model: Option<&str>) -> Session {
    let mut s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Acp,
        agent: Some("fake".into()),
        cwd: ".".into(),
        model: model.map(str::to_string),
        ..Default::default()
    });
    s.native_id = native_id.map(str::to_string);
    s
}

fn connect(link: Link, session: Session) -> (tokio::task::JoinHandle<Result<AcpDriver>>, mpsc::UnboundedReceiver<Event>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(async move { AcpDriver::connect(link, &spec(), &session, tx).await });
    (handle, rx)
}

/// Events until (and including) the first one matching `done`.
async fn until(rx: &mut mpsc::UnboundedReceiver<Event>, done: impl Fn(&Event) -> bool) -> Vec<Event> {
    let mut out = vec![];
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event timed out").expect("sink closed");
        let stop = done(&ev);
        out.push(ev);
        if stop {
            return out;
        }
    }
}

fn init_result(caps: Value) -> Value {
    json!({ "protocolVersion": 1, "agentCapabilities": caps, "agentInfo": { "name": "fake", "version": "1.0" }, "authMethods": [] })
}

fn model_option(current: &str) -> Value {
    json!({ "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": current,
        "options": [{ "value": "smart", "name": "Smart" }, { "value": "fast", "name": "Fast" }] })
}

#[tokio::test]
async fn runs_a_session_end_to_end() {
    let (pipe, mut agent) = link();
    let (handle, mut rx) = connect(pipe, session(None, Some("fast")));

    let (id, params) = agent.expect("initialize").await;
    assert_eq!(params["protocolVersion"], 1);
    assert_eq!(params["clientCapabilities"]["terminal"], false);
    agent.respond(id, init_result(json!({ "sessionCapabilities": { "close": {} } }))).await;

    let (id, params) = agent.expect("session/new").await;
    assert_eq!(params["mcpServers"], json!([]));
    agent.update(json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "init", "description": "Set up" }] })).await;
    agent
        .respond(id, json!({ "sessionId": "acp-1",
            "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "Ask" }, { "id": "auto", "name": "Auto" }] },
            "configOptions": [model_option("smart")] }))
        .await;

    // The model picked in the new-session dialog is applied once the session exists.
    let (id, params) = agent.expect("session/set_config_option").await;
    assert_eq!((params["sessionId"].as_str(), params["configId"].as_str(), params["value"].as_str()), (Some("acp-1"), Some("model"), Some("fast")));
    agent.respond(id, json!({ "configOptions": [model_option("fast")] })).await;
    let driver = handle.await.unwrap().unwrap();

    let setup = until(&mut rx, |e| matches!(e, Event::SettingChanged { setting: Setting::Model(m), .. } if m == "fast")).await;
    assert!(setup.iter().any(|e| matches!(e, Event::NativeId { native_id, .. } if native_id == "acp-1")));
    assert!(setup.iter().any(|e| matches!(e, Event::SettingChanged { setting: Setting::PermissionMode(p), .. } if p == "ask")));
    assert!(setup.iter().any(|e| matches!(e, Event::ProviderInfo { info, .. } if info["commands"][0]["name"] == "init")));

    // A turn with a tool call that needs permission.
    driver.send(Input { text: "list files".into(), ..Default::default() }).await.unwrap();
    let (prompt_id, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"], json!([{ "type": "text", "text": "list files" }]));
    agent.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hel" } })).await;
    agent.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "lo" } })).await;
    agent.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "ls", "kind": "execute", "status": "pending", "rawInput": { "command": "ls" } })).await;
    agent
        .send(json!({ "jsonrpc": "2.0", "id": 50, "method": "session/request_permission", "params": { "sessionId": "acp-1",
            "toolCall": { "toolCallId": "t1" }, "options": [{ "optionId": "ok", "name": "Allow", "kind": "allow_once" }, { "optionId": "no", "name": "Reject", "kind": "reject_once" }] } }))
        .await;
    let events = until(&mut rx, |e| matches!(e, Event::ApprovalRequested { .. })).await;
    let approval = match events.last() {
        Some(Event::ApprovalRequested { approval, .. }) => approval.clone(),
        _ => unreachable!(),
    };
    assert_eq!(approval.kind, ApprovalKind::Command);
    assert_eq!(approval.payload["command"], "ls");
    driver.respond_approval(&approval.id, ApprovalDecision { option: ApprovalOption::Accept, updated_input: None, message: None }).await.unwrap();
    let reply = agent.recv().await;
    assert_eq!(reply["id"], 50);
    assert_eq!(reply["result"], json!({ "outcome": { "outcome": "selected", "optionId": "ok" } }));

    // Updates sent right before the prompt response still land inside the turn.
    agent.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "a.txt" } }] })).await;
    agent.respond(prompt_id, json!({ "stopReason": "end_turn" })).await;
    let mut turn = events;
    turn.extend(until(&mut rx, |e| matches!(e, Event::TurnCompleted { .. })).await);
    let started = turn.iter().position(|e| matches!(e, Event::TurnStarted { .. })).unwrap();
    assert!(matches!(&turn[started + 1], Event::ItemCompleted { item, .. } if item.kind == ItemKind::UserMessage && item.text == "list files"));
    let message = turn.iter().find_map(|e| match e {
        Event::ItemCompleted { item, .. } if item.kind == ItemKind::AgentMessage => Some(item.text.clone()),
        _ => None,
    });
    assert_eq!(message.as_deref(), Some("Hello"));
    let tool = turn.iter().position(|e| matches!(e, Event::ItemCompleted { item, .. } if item.id == "t1" && item.data["output"] == "a.txt")).expect("tool completed");
    let end = turn.iter().position(|e| matches!(e, Event::TurnCompleted { turn, .. } if turn.status == TurnStatus::Completed)).unwrap();
    assert!(tool < end);

    // This agent did not declare image support.
    let with_image = Input { text: "look".into(), images: vec![ImageInput { path: None, data: Some("AA==".into()), media_type: None }], steer: false };
    assert!(driver.send(with_image).await.unwrap_err().to_string().contains("does not accept images"));

    // Modes go through session/set_mode.
    let d = Arc::new(driver);
    let d2 = d.clone();
    let setting = tokio::spawn(async move { d2.set(Setting::PermissionMode("auto".into())).await });
    let (id, params) = agent.expect("session/set_mode").await;
    assert_eq!(params["modeId"], "auto");
    agent.respond(id, json!({})).await;
    setting.await.unwrap().unwrap();
    until(&mut rx, |e| matches!(e, Event::SettingChanged { setting: Setting::PermissionMode(p), .. } if p == "auto")).await;
    assert!(d.set(Setting::Effort("high".into())).await.unwrap_err().to_string().contains("does not offer"));

    // Interrupting answers the open permission request with `cancelled`.
    d.send(Input { text: "delete everything".into(), ..Default::default() }).await.unwrap();
    let (prompt_id, _) = agent.expect("session/prompt").await;
    agent
        .send(json!({ "jsonrpc": "2.0", "id": 60, "method": "session/request_permission", "params": { "sessionId": "acp-1",
            "toolCall": { "toolCallId": "t2", "title": "rm -rf /", "kind": "execute" }, "options": [{ "optionId": "ok", "name": "Allow", "kind": "allow_once" }] } }))
        .await;
    until(&mut rx, |e| matches!(e, Event::ApprovalRequested { .. })).await;
    d.interrupt().await.unwrap();
    let cancel = agent.recv().await;
    assert_eq!(cancel["method"], "session/cancel");
    assert!(cancel.get("id").is_none(), "session/cancel is a notification");
    let reply = agent.recv().await;
    assert_eq!((reply["id"].clone(), reply["result"].clone()), (json!(60), json!({ "outcome": { "outcome": "cancelled" } })));
    agent.respond(prompt_id, json!({ "stopReason": "cancelled" })).await;
    let events = until(&mut rx, |e| matches!(e, Event::TurnCompleted { .. })).await;
    assert!(events.iter().any(|e| matches!(e, Event::ApprovalResolved { decision, .. } if decision.option == ApprovalOption::Cancel)));
    assert!(matches!(events.last(), Some(Event::TurnCompleted { turn, .. }) if turn.status == TurnStatus::Interrupted));

    // Client methods Aura did not advertise are refused, not left hanging.
    agent.send(json!({ "jsonrpc": "2.0", "id": 70, "method": "fs/read_text_file", "params": { "sessionId": "acp-1", "path": "/etc/passwd" } })).await;
    let reply = agent.recv().await;
    assert_eq!((reply["id"].clone(), reply["error"]["code"].clone()), (json!(70), json!(-32601)));

    // Stopping closes the session and is not reported as a failure.
    let d2 = d.clone();
    let stop = tokio::spawn(async move { d2.stop().await });
    let (id, _) = agent.expect("session/close").await;
    agent.respond(id, json!({})).await;
    stop.await.unwrap().unwrap();
    drop(agent);
    let events = until(&mut rx, |e| matches!(e, Event::ProcessExited { .. })).await;
    assert!(matches!(events.last(), Some(Event::ProcessExited { message: None, .. })));
}

#[tokio::test]
async fn prompts_sent_during_a_turn_wait_for_it() {
    let (pipe, mut agent) = link();
    let (handle, mut rx) = connect(pipe, session(None, None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({}))).await;
    let (id, _) = agent.expect("session/new").await;
    agent.respond(id, json!({ "sessionId": "acp-1" })).await;
    let driver = handle.await.unwrap().unwrap();

    driver.send(Input { text: "one".into(), ..Default::default() }).await.unwrap();
    driver.send(Input { text: "two".into(), ..Default::default() }).await.unwrap();
    let (first, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"][0]["text"], "one");
    // Nothing else is sent until the first prompt is answered.
    assert!(tokio::time::timeout(Duration::from_millis(200), agent.lines.next_line()).await.is_err());
    agent.respond(first, json!({ "stopReason": "end_turn" })).await;
    let (second, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"][0]["text"], "two");
    agent.respond(second, json!({ "stopReason": "max_tokens" })).await;
    let events = until(&mut rx, |e| matches!(e, Event::Notice { .. })).await;
    assert!(matches!(events.last(), Some(Event::Notice { level: NoticeLevel::Warn, message, .. }) if message.contains("token limit")));
}

#[tokio::test]
async fn the_system_prompt_rides_on_the_first_prompt_of_a_new_session_only() {
    let (pipe, mut agent) = link();
    let mut s = session(None, None);
    s.instructions = Some("Sign your GitHub comments".into());
    let (handle, _rx) = connect(pipe, s);
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({}))).await;
    let (id, _) = agent.expect("session/new").await;
    agent.respond(id, json!({ "sessionId": "acp-1" })).await;
    let driver = handle.await.unwrap().unwrap();

    driver.send(Input { text: "one".into(), ..Default::default() }).await.unwrap();
    let (first, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"][0]["text"], "<system-instructions>\nSign your GitHub comments\n</system-instructions>");
    assert_eq!(params["prompt"][1]["text"], "one");
    agent.respond(first, json!({ "stopReason": "end_turn" })).await;
    driver.send(Input { text: "two".into(), ..Default::default() }).await.unwrap();
    let (_, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"].as_array().unwrap().len(), 1);
    assert_eq!(params["prompt"][0]["text"], "two");
}

#[tokio::test]
async fn a_resumed_session_is_not_sent_the_system_prompt_again() {
    let (pipe, mut agent) = link();
    let mut s = session(Some("old"), None);
    s.instructions = Some("Sign your GitHub comments".into());
    let (handle, _rx) = connect(pipe, s);
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({ "sessionCapabilities": { "resume": {} } }))).await;
    let (id, _) = agent.expect("session/resume").await;
    agent.respond(id, json!({})).await;
    let driver = handle.await.unwrap().unwrap();
    driver.send(Input { text: "again".into(), ..Default::default() }).await.unwrap();
    let (_, params) = agent.expect("session/prompt").await;
    assert_eq!(params["prompt"][0]["text"], "again");
}

#[tokio::test]
async fn sign_in_errors_explain_what_to_do_and_stay_the_reported_error() {
    let (pipe, mut agent) = link();
    let (handle, mut rx) = connect(pipe, session(None, None));
    let (id, _) = agent.expect("initialize").await;
    agent
        .respond(id, json!({ "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [{ "id": "oauth", "name": "Log in with Google" }] }))
        .await;
    let (id, _) = agent.expect("session/new").await;
    agent.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } })).await;
    let err = handle.await.unwrap().err().expect("start fails").to_string();
    assert!(err.contains("Fake Agent needs you to sign in (Log in with Google)"), "{err}");
    assert!(err.contains("Run `fake`"), "{err}");
    drop(agent);
    // The closed connection must not be reported on top of that error.
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(ev) = rx.try_recv() {
        assert!(!matches!(ev, Event::ProcessExited { .. }), "{ev:?}");
    }
}

#[tokio::test]
async fn rejects_other_protocol_versions() {
    let (pipe, mut agent) = link();
    let (handle, _rx) = connect(pipe, session(None, None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, json!({ "protocolVersion": 2, "agentCapabilities": {} })).await;
    let err = handle.await.unwrap().err().expect("start fails").to_string();
    assert!(err.contains("speaks ACP version 2"), "{err}");
}

#[tokio::test]
async fn loading_a_session_does_not_replay_its_history_into_the_transcript() {
    let (pipe, mut agent) = link();
    let (handle, mut rx) = connect(pipe, session(Some("old"), None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({ "loadSession": true }))).await;
    let (id, params) = agent.expect("session/load").await;
    assert_eq!(params["sessionId"], "old");
    agent.update(json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "earlier question" } })).await;
    agent.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "earlier answer" } })).await;
    agent.respond(id, json!({})).await;
    let driver = handle.await.unwrap().unwrap();

    driver.send(Input { text: "new".into(), ..Default::default() }).await.unwrap();
    let (prompt, _) = agent.expect("session/prompt").await;
    agent.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "fresh" } })).await;
    agent.respond(prompt, json!({ "stopReason": "end_turn" })).await;
    let events = until(&mut rx, |e| matches!(e, Event::TurnCompleted { .. })).await;
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::ItemStarted { item, .. } | Event::ItemCompleted { item, .. } => Some(item.text.as_str()),
            _ => None,
        })
        .collect();
    assert!(!texts.iter().any(|t| t.contains("earlier")), "{texts:?}");
    assert!(texts.contains(&"fresh"));
    assert!(!events.iter().any(|e| matches!(e, Event::NativeId { .. })), "the loaded session keeps its id");
}

#[tokio::test]
async fn resume_is_preferred_and_agents_without_either_start_fresh_with_a_notice() {
    let (pipe, mut agent) = link();
    let (handle, _rx) = connect(pipe, session(Some("old"), None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({ "loadSession": true, "sessionCapabilities": { "resume": {} } }))).await;
    let (id, _) = agent.expect("session/resume").await;
    agent.respond(id, json!({})).await;
    handle.await.unwrap().unwrap();

    let (pipe, mut agent) = link();
    let (handle, mut rx) = connect(pipe, session(Some("old"), None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({}))).await;
    let (id, _) = agent.expect("session/new").await;
    agent.respond(id, json!({ "sessionId": "acp-2" })).await;
    handle.await.unwrap().unwrap();
    let events = until(&mut rx, |e| matches!(e, Event::NativeId { .. })).await;
    assert!(events.iter().any(|e| matches!(e, Event::Notice { message, .. } if message.contains("cannot resume"))));
}

#[tokio::test]
async fn an_agent_crash_fails_the_turn_and_reports_the_exit() {
    let (pipe, mut agent) = link();
    let stderr = pipe.stderr.clone();
    let (handle, mut rx) = connect(pipe, session(None, None));
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({}))).await;
    let (id, _) = agent.expect("session/new").await;
    agent.respond(id, json!({ "sessionId": "acp-1" })).await;
    let driver = handle.await.unwrap().unwrap();
    driver.send(Input { text: "go".into(), ..Default::default() }).await.unwrap();
    agent.expect("session/prompt").await;
    stderr.lock().push_back("panic: out of memory".into());
    drop(agent);
    let events = until(&mut rx, |e| matches!(e, Event::ProcessExited { .. })).await;
    assert!(events.iter().any(|e| matches!(e, Event::TurnCompleted { turn, .. } if turn.status == TurnStatus::Failed)));
    match events.last() {
        Some(Event::ProcessExited { message: Some(m), .. }) => assert!(m.contains("the agent exited") && m.contains("out of memory"), "{m}"),
        e => panic!("{e:?}"),
    }
}

#[test]
fn provider_lists_agents_and_has_no_terminal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join(CONFIG_FILE);
    std::fs::write(&config, r#"{ "agents": [ { "id": "mine", "name": "Mine", "command": ["definitely-not-installed-acp-agent"] } ] }"#).unwrap();
    let provider = AcpProvider::with_config(Some(config));
    let info = provider.info();
    assert_eq!(info.kind, ProviderKind::Acp);
    let mine = info.agents.iter().find(|a| a.id == "mine").unwrap();
    assert_eq!((mine.display_name.as_str(), mine.source.as_str(), mine.available), ("Mine", "custom", false));
    assert!(info.agents.iter().any(|a| a.id == "gemini" && a.source == "builtin"));
    assert!(!info.capabilities.terminal_mode && !info.capabilities.fork);
    assert!(provider.terminal_command(&session(None, None)).is_empty());
}

#[tokio::test]
async fn starting_an_uninstalled_agent_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join(CONFIG_FILE);
    std::fs::write(&config, r#"{ "agents": [ { "id": "fake", "name": "Fake", "command": ["definitely-not-installed-acp-agent"] } ] }"#).unwrap();
    let provider = AcpProvider::with_config(Some(config));
    let (tx, _rx) = mpsc::unbounded_channel();
    let err = provider.start(&session(None, None), false, tx.clone()).await.err().unwrap().to_string();
    assert!(err.contains("Fake is not installed"), "{err}");
    let mut other = session(None, None);
    other.agent = Some("nope".into());
    assert!(provider.start(&other, false, tx.clone()).await.err().unwrap().to_string().contains("unknown ACP agent `nope`"));
    assert!(provider.start(&session(None, None), true, tx).await.err().unwrap().to_string().contains("cannot fork"));
}

/// Round trip with a real agent. The agent's argv is a JSON array, e.g.
/// `AURA_ACP_LIVE_AGENT='["gemini","--acp"]'` or
/// `AURA_ACP_LIVE_AGENT='["npx","-y","@agentclientprotocol/claude-agent-acp"]'`.
#[tokio::test]
#[ignore = "starts a real ACP agent; set AURA_LIVE_TESTS=1 and AURA_ACP_LIVE_AGENT"]
async fn live_round_trip() {
    let (Ok(_), Ok(argv)) = (std::env::var("AURA_LIVE_TESTS"), std::env::var("AURA_ACP_LIVE_AGENT")) else { return };
    let command: Vec<String> = serde_json::from_str(&argv).expect("AURA_ACP_LIVE_AGENT must be a JSON array of strings");
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join(CONFIG_FILE);
    std::fs::write(&config, json!({ "agents": [{ "id": "live", "name": "Live agent", "command": command }] }).to_string()).unwrap();
    let provider = AcpProvider::with_config(Some(config));
    let work = tempfile::tempdir().unwrap();
    let mut s = session(None, None);
    s.agent = Some("live".into());
    s.cwd = work.path().to_string_lossy().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let driver = provider.start(&s, false, tx).await.expect("agent starts");
    driver.send(Input { text: "Reply with exactly the word pong and nothing else. Do not use any tools.".into(), ..Default::default() }).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let mut text = String::new();
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("sink closed");
        match &ev {
            Event::ProviderInfo { info, .. } => eprintln!("provider info: {info}"),
            Event::SettingChanged { setting, .. } => eprintln!("setting: {setting:?}"),
            Event::ItemCompleted { item, .. } if item.kind == ItemKind::AgentMessage => text.push_str(&item.text),
            Event::TurnCompleted { turn, .. } => {
                assert_eq!(turn.status, TurnStatus::Completed, "{turn:?}");
                break;
            }
            Event::ProcessExited { message, .. } => panic!("agent exited: {message:?}"),
            _ => {}
        }
    }
    assert!(text.to_lowercase().contains("pong"), "got {text:?}");

    // A file edit: whatever permission the agent asks for is granted once.
    driver.send(Input { text: "Create a file named hello.txt in the current directory containing exactly: hi".into(), ..Default::default() }).await.unwrap();
    let mut tools = vec![];
    loop {
        let ev = tokio::time::timeout_at(deadline + Duration::from_secs(180), rx.recv()).await.expect("timeout").expect("sink closed");
        match ev {
            Event::ApprovalRequested { approval, .. } => {
                eprintln!("approval: {:?} {} {}", approval.kind, approval.title, approval.payload);
                let option = if approval.options.contains(&ApprovalOption::Accept) { ApprovalOption::Accept } else { ApprovalOption::Cancel };
                driver.respond_approval(&approval.id, ApprovalDecision { option, updated_input: None, message: None }).await.unwrap();
            }
            Event::ItemCompleted { item, .. } if !matches!(item.kind, ItemKind::AgentMessage | ItemKind::Reasoning | ItemKind::UserMessage) => {
                eprintln!("tool: {:?} {:?} {:?} {}", item.kind, item.status, item.title, item.data);
                tools.push(item);
            }
            Event::TurnCompleted { turn, .. } => {
                assert_eq!(turn.status, TurnStatus::Completed, "{turn:?}");
                break;
            }
            Event::ProcessExited { message, .. } => panic!("agent exited: {message:?}"),
            _ => {}
        }
    }
    assert!(!tools.is_empty(), "the edit should appear as a tool item");
    assert_eq!(std::fs::read_to_string(work.path().join("hello.txt")).unwrap().trim(), "hi");
    driver.stop().await.unwrap();
}

#[tokio::test]
async fn new_sessions_get_the_mcp_servers() {
    let (pipe, mut agent) = link();
    let mut s = session(None, None);
    s.mcp_servers = vec![McpServer { name: "aura".into(), command: "/bin/aura".into(), args: vec!["mcp".into()] }];
    let (_handle, _rx) = connect(pipe, s);
    let (id, _) = agent.expect("initialize").await;
    agent.respond(id, init_result(json!({}))).await;
    let (_, params) = agent.expect("session/new").await;
    assert_eq!(params["mcpServers"], json!([{ "name": "aura", "command": "/bin/aura", "args": ["mcp"], "env": [] }]));
}
