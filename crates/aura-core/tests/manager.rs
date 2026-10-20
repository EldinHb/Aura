//! Manager behaviour with a scripted fake provider.

use aura_core::*;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// A driver that records calls and lets the test push events into the sink.
type Calls = Arc<Mutex<Vec<String>>>;
type Starts = Arc<Mutex<Vec<(Option<String>, bool)>>>;

struct FakeDriver {
    sink: EventSink,
    session_id: String,
    calls: Calls,
    knobs: Knobs,
}

/// What a test makes the fake provider do besides the usual.
#[derive(Default)]
struct Knob {
    /// The sink of the last driver started, for tests that send events in their own order.
    sink: Option<EventSink>,
    /// `stop` ends with the process killed and this message, like Claude after its grace period.
    exit_on_stop: Option<String>,
    /// Starting an agent fails.
    fail_start: bool,
    /// A resumed agent replays a failed turn from its history.
    replay_failed_turn: bool,
}
type Knobs = Arc<Mutex<Knob>>;

#[async_trait::async_trait]
impl Driver for FakeDriver {
    async fn send(&self, input: Input) -> anyhow::Result<()> {
        self.calls.lock().push(format!("send:{}", input.text));
        let turn = Turn {
            id: new_id(),
            session_id: self.session_id.clone(),
            status: TurnStatus::Running,
            started_at: now(),
            ended_at: None,
            usage: None,
            error: None,
        };
        let _ = self.sink.send(Event::TurnStarted {
            session_id: self.session_id.clone(),
            turn: turn.clone(),
        });
        // Like the real providers, the user's message is an item of the turn.
        let _ = self.sink.send(Event::ItemCompleted {
            session_id: self.session_id.clone(),
            item: Item::new(
                &self.session_id,
                Some(turn.id.clone()),
                ItemKind::UserMessage,
            )
            .with_text(input.text.clone())
            .completed(),
        });
        let item = Item::new(
            &self.session_id,
            Some(turn.id.clone()),
            ItemKind::AgentMessage,
        );
        let _ = self.sink.send(Event::ItemStarted {
            session_id: self.session_id.clone(),
            item: item.clone(),
        });
        let _ = self.sink.send(Event::ItemDelta {
            session_id: self.session_id.clone(),
            item_id: item.id.clone(),
            delta: ItemDelta::Text { text: "hel".into() },
        });
        let _ = self.sink.send(Event::ItemDelta {
            session_id: self.session_id.clone(),
            item_id: item.id.clone(),
            delta: ItemDelta::Text { text: "lo".into() },
        });
        if input.text.contains("question") {
            let _ = self.sink.send(Event::UserInputRequested {
                session_id: self.session_id.clone(),
                request: UserInputRequest {
                    id: "q1".into(),
                    session_id: self.session_id.clone(),
                    turn_id: Some(turn.id.clone()),
                    item_id: None,
                    questions: if input.text.contains("secret") {
                        vec![Question {
                            id: "pw".into(),
                            header: None,
                            question: "Password?".into(),
                            options: vec![],
                            multi_select: false,
                            allow_free_text: true,
                            secret: true,
                        }]
                    } else {
                        vec![]
                    },
                    created_at: now(),
                },
            });
        } else if input.text.contains("crash") {
            let _ = self.sink.send(Event::ProcessExited {
                session_id: self.session_id.clone(),
                exit_code: Some(1),
                message: Some("crashed".into()),
            });
        } else if input.text.contains("fail") {
            let _ = self.sink.send(Event::TurnCompleted {
                session_id: self.session_id.clone(),
                turn: Turn {
                    status: TurnStatus::Failed,
                    ended_at: Some(now()),
                    error: Some("overloaded".into()),
                    ..turn
                },
            });
        } else if input.text.contains("approve") {
            let approval = Approval {
                id: "ap1".into(),
                session_id: self.session_id.clone(),
                turn_id: Some(turn.id.clone()),
                item_id: None,
                kind: ApprovalKind::Command,
                title: "ls".into(),
                description: None,
                payload: serde_json::json!({"command": "ls"}),
                options: vec![ApprovalOption::Accept, ApprovalOption::Decline],
                created_at: now(),
            };
            let _ = self.sink.send(Event::ApprovalRequested {
                session_id: self.session_id.clone(),
                approval,
            });
        } else {
            let _ = self.sink.send(Event::ItemCompleted {
                session_id: self.session_id.clone(),
                item: item.with_text("hello").completed(),
            });
            let _ = self.sink.send(Event::TurnCompleted {
                session_id: self.session_id.clone(),
                turn: Turn {
                    status: TurnStatus::Completed,
                    ended_at: Some(now()),
                    usage: Some(Usage {
                        input_tokens: 10,
                        output_tokens: 5,
                        ..Default::default()
                    }),
                    ..turn
                },
            });
        }
        Ok(())
    }
    async fn interrupt(&self) -> anyhow::Result<()> {
        self.calls.lock().push("interrupt".into());
        Ok(())
    }
    async fn respond_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> anyhow::Result<()> {
        self.calls
            .lock()
            .push(format!("approve:{approval_id}:{:?}", decision.option));
        let _ = self.sink.send(Event::TurnCompleted {
            session_id: self.session_id.clone(),
            turn: Turn {
                id: "t".into(),
                session_id: self.session_id.clone(),
                status: TurnStatus::Completed,
                started_at: now(),
                ended_at: Some(now()),
                usage: None,
                error: None,
            },
        });
        Ok(())
    }
    async fn respond_input(&self, r: UserInputResponse) -> anyhow::Result<()> {
        self.calls.lock().push(format!(
            "respond_input:{}:declined={}",
            r.request_id, r.declined
        ));
        Ok(())
    }
    async fn set(&self, setting: Setting) -> anyhow::Result<()> {
        self.calls.lock().push(format!("set:{setting:?}"));
        Ok(())
    }
    async fn stop(&self) -> anyhow::Result<()> {
        self.calls.lock().push("stop".into());
        if let Some(message) = self.knobs.lock().exit_on_stop.clone() {
            let _ = self.sink.send(Event::ProcessExited {
                session_id: self.session_id.clone(),
                exit_code: None,
                message: Some(message),
            });
        }
        Ok(())
    }
}

struct FakeProvider {
    calls: Calls,
    starts: Starts,
    /// The system prompt each start was given.
    prompts: Arc<Mutex<Vec<Option<String>>>>,
    /// The MCP servers each start was given.
    mcp: Arc<Mutex<Vec<Vec<McpServer>>>>,
    knobs: Knobs,
}

#[async_trait::async_trait]
impl Provider for FakeProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Claude
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Claude,
            display_name: "Fake".into(),
            available: true,
            version: None,
            binary: None,
            capabilities: CapabilitySet {
                structured: true,
                fork: true,
                terminal_mode: true,
                ..Default::default()
            },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(
        &self,
        session: &Session,
        fork: bool,
        sink: EventSink,
    ) -> anyhow::Result<Box<dyn Driver>> {
        if self.knobs.lock().fail_start {
            anyhow::bail!("agent not found");
        }
        self.starts.lock().push((session.native_id.clone(), fork));
        self.prompts.lock().push(session.instructions.clone());
        self.mcp.lock().push(session.mcp_servers.clone());
        let _ = sink.send(Event::NativeId {
            session_id: session.id.clone(),
            native_id: format!("native-{}", if fork { "fork" } else { "1" }),
        });
        if self.knobs.lock().replay_failed_turn && session.native_id.is_some() && !fork {
            let _ = sink.send(Event::TurnCompleted {
                session_id: session.id.clone(),
                turn: turn(&session.id, "replayed", TurnStatus::Failed),
            });
        }
        self.knobs.lock().sink = Some(sink.clone());
        Ok(Box::new(FakeDriver {
            sink,
            session_id: session.id.clone(),
            calls: self.calls.clone(),
            knobs: self.knobs.clone(),
        }))
    }
    fn terminal_command(&self, _s: &Session) -> Vec<String> {
        vec!["/bin/sh".into()]
    }
}

async fn wait_status(m: &Manager, id: &str, want: SessionStatus) {
    for _ in 0..100 {
        if m.get_session(id).unwrap().status == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "status never became {want:?}, is {:?}",
        m.get_session(id).unwrap().status
    );
}

async fn wait_attention(m: &Manager, id: &str, want: Option<Attention>) {
    for _ in 0..100 {
        if m.get_session(id).unwrap().attention == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "attention never became {want:?}, is {:?}",
        m.get_session(id).unwrap().attention
    );
}

async fn drain(rx: &mut broadcast::Receiver<Event>) -> Vec<Event> {
    let mut out = vec![];
    while let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
        out.push(ev);
    }
    out
}

fn setup() -> (Manager, Calls, Starts, Arc<MemoryStore>) {
    let calls = Arc::new(Mutex::new(vec![]));
    let starts = Arc::new(Mutex::new(vec![]));
    let store = Arc::new(MemoryStore::default());
    let provider = Arc::new(FakeProvider {
        calls: calls.clone(),
        starts: starts.clone(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let m = Manager::new(store.clone(), vec![provider], None);
    (m, calls, starts, store)
}

/// Like [`setup`], with the provider's knobs in hand.
fn setup_with_knobs() -> (Manager, Knobs) {
    let knobs: Knobs = Default::default();
    let provider = Arc::new(FakeProvider {
        calls: Default::default(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: knobs.clone(),
    });
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![provider], None);
    (m, knobs)
}

fn turn(session_id: &str, id: &str, status: TurnStatus) -> Turn {
    Turn {
        id: id.into(),
        session_id: session_id.into(),
        status,
        started_at: now(),
        ended_at: (status != TurnStatus::Running).then(now),
        usage: None,
        error: (status == TurnStatus::Failed).then(|| "overloaded".into()),
    }
}

fn approval(session_id: &str, id: &str) -> Approval {
    Approval {
        id: id.into(),
        session_id: session_id.into(),
        turn_id: None,
        item_id: None,
        kind: ApprovalKind::Command,
        title: "ls".into(),
        description: None,
        payload: serde_json::json!({"command": "ls"}),
        options: vec![ApprovalOption::Accept, ApprovalOption::Decline],
        created_at: now(),
    }
}

#[tokio::test]
async fn agents_start_with_the_global_agent_and_session_prompts() {
    let calls: Calls = Default::default();
    let provider = Arc::new(FakeProvider {
        calls: calls.clone(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let prompts = provider.prompts.clone();
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![provider], None);
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            model: Some("opus".into()),
            effort: Some("high".into()),
            system_prompt: Some("Session rule".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    // The default global prompt asks for attribution, filled in with the start values.
    let first = prompts.lock()[0].clone().unwrap();
    assert!(first.starts_with("You are running inside Aura"), "{first}");
    assert!(
        first.contains("Aura started you as Fake with model `opus` and reasoning effort `high`"),
        "{first}"
    );
    assert!(first.ends_with("Session rule"), "{first}");
    assert!(m.system_prompts().unwrap().global_is_default);

    // A change stops the idle agent; the next message starts it with the new prompt.
    m.set_global_prompt(Some("Global rule".into()))
        .await
        .unwrap();
    m.set_agent_prompt("claude", Some("Claude rule".into()))
        .await
        .unwrap();
    assert!(calls.lock().iter().any(|c| c == "stop"));
    m.send(
        &s.id,
        Input {
            text: "hi".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        prompts.lock().last().unwrap().as_deref(),
        Some("Global rule\n\nClaude rule\n\nSession rule")
    );

    // An empty global prompt is kept as empty; resetting brings the default back.
    m.set_global_prompt(Some(String::new())).await.unwrap();
    m.set_agent_prompt("claude", None).await.unwrap();
    m.set_session_prompt(&s.id, None).await.unwrap();
    assert_eq!(
        m.instructions_for(&m.get_session(&s.id).unwrap()).unwrap(),
        None
    );
    let reset = m.set_global_prompt(None).await.unwrap();
    assert!(reset.global_is_default && reset.agents.is_empty());
}

#[tokio::test]
async fn structured_session_flow() {
    let (m, calls, starts, _store) = setup();
    let mut rx = m.subscribe();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            initial_prompt: Some("hi".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(s.mode, SessionMode::Structured);
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    let evs = drain(&mut rx).await;
    assert!(evs
        .iter()
        .any(|e| matches!(e, Event::SessionCreated { .. })));
    assert!(evs.iter().any(|e| matches!(e, Event::TurnStarted { .. })));
    assert!(evs.iter().any(|e| matches!(e, Event::ItemDelta { .. })));
    assert!(evs.iter().any(|e| matches!(e, Event::TurnCompleted { .. })));
    let s = m.get_session(&s.id).unwrap();
    assert_eq!(s.native_id.as_deref(), Some("native-1"));
    assert_eq!(s.usage.input_tokens, 10);
    assert_eq!(starts.lock().len(), 1);
    assert_eq!(calls.lock()[0], "send:hi");

    // history has the completed item but not deltas
    let hist = m.history(&s.id, 0, 100).unwrap();
    assert!(hist
        .iter()
        .any(|e| matches!(e.event, Event::ItemCompleted { .. })));
    assert!(!hist
        .iter()
        .any(|e| matches!(e.event, Event::ItemDelta { .. })));

    // approval flow
    m.send(
        &s.id,
        Input {
            text: "please approve".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingApproval).await;
    assert_eq!(m.get_session(&s.id).unwrap().pending_count, 1);
    let (pending, _) = m.pending();
    assert_eq!(pending.len(), 1);
    // history snapshot includes the live (still streaming) item and the pending approval
    let hist = m.history(&s.id, 0, 100).unwrap();
    assert!(hist
        .iter()
        .any(|e| matches!(&e.event, Event::ItemStarted { item, .. } if item.text == "hello")));
    assert!(hist
        .iter()
        .any(|e| matches!(e.event, Event::ApprovalRequested { .. })));
    assert!(m
        .respond_approval(
            &s.id,
            "nope",
            ApprovalDecision {
                option: ApprovalOption::Accept,
                updated_input: None,
                message: None
            }
        )
        .await
        .is_err());
    m.respond_approval(
        &s.id,
        "ap1",
        ApprovalDecision {
            option: ApprovalOption::Accept,
            updated_input: None,
            message: None,
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    assert_eq!(m.get_session(&s.id).unwrap().pending_count, 0);
    assert!(calls.lock().iter().any(|c| c == "approve:ap1:Accept"));

    // settings are applied locally and forwarded
    m.set(&s.id, Setting::Model("opus".into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(m.get_session(&s.id).unwrap().model.as_deref(), Some("opus"));

    // stop keeps the session, next send resumes with the native id
    m.stop(&s.id).await.unwrap();
    assert!(calls.lock().iter().any(|c| c == "stop"));
    m.send(
        &s.id,
        Input {
            text: "again".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(starts.lock().len(), 2);
    assert_eq!(starts.lock()[1], (Some("native-1".into()), false));

    // fork
    let f = m.fork(&s.id).await.unwrap();
    assert_ne!(f.id, s.id);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        m.get_session(&f.id).unwrap().native_id.as_deref(),
        Some("native-fork")
    );
    assert_eq!(starts.lock()[2], (Some("native-1".into()), true));

    // rename / pin / group / archive / delete
    m.rename(&s.id, "renamed").unwrap();
    m.set_pinned(&s.id, true).unwrap();
    m.set_group(&s.id, Some("g".into())).unwrap();
    let s2 = m.get_session(&s.id).unwrap();
    assert_eq!(
        (s2.title.as_str(), s2.pinned, s2.group.as_deref()),
        ("renamed", true, Some("g"))
    );
    m.set_archived(&s.id, true).await.unwrap();
    assert!(m.get_session(&s.id).unwrap().archived);
    m.delete(&s.id, false).await.unwrap();
    assert!(m.get_session(&s.id).is_err());
    assert_eq!(m.list_sessions().len(), 1);
}

#[tokio::test]
async fn mode_switch_and_restore() {
    let (m, _calls, starts, store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    // to terminal: spawns the provider's terminal command in a pty
    let s = m.switch_mode(&s.id, SessionMode::Terminal).await.unwrap();
    assert_eq!(s.mode, SessionMode::Terminal);
    assert_eq!(s.status, SessionStatus::Running);
    assert_eq!(s.command.as_deref(), Some(&["/bin/sh".to_string()][..]));
    m.pty_input(&s.id, b"exit\n").unwrap();
    wait_status(&m, &s.id, SessionStatus::Exited).await;
    // back to structured resumes with the native id
    let s = m.switch_mode(&s.id, SessionMode::Structured).await.unwrap();
    assert_eq!(s.mode, SessionMode::Structured);
    assert_eq!(starts.lock().last().unwrap().0.as_deref(), Some("native-1"));

    // a terminal-only provider session cannot go structured
    let t = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            mode: Some(SessionMode::Terminal),
            command: Some(vec!["/bin/sh".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(t.status, SessionStatus::Running);
    m.pty_input(&t.id, b"echo hi_from_pty; exit\n").unwrap();
    wait_status(&m, &t.id, SessionStatus::Exited).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let sb = String::from_utf8_lossy(&m.pty_scrollback(&t.id).unwrap()).to_string();
    assert!(sb.contains("hi_from_pty"), "scrollback {sb:?}");
    assert!(store.load_scrollback(&t.id).unwrap().is_some());

    // restore from the same store: structured -> idle, terminal -> exited, scrollback kept
    let m2 = Manager::new(
        store.clone(),
        vec![Arc::new(FakeProvider {
            calls: Default::default(),
            starts: Default::default(),
            prompts: Default::default(),
            mcp: Default::default(),
            knobs: Default::default(),
        })],
        None,
    );
    assert_eq!(m2.restore().unwrap(), 2);
    assert_eq!(m2.get_session(&s.id).unwrap().status, SessionStatus::Idle);
    assert_eq!(m2.get_session(&t.id).unwrap().status, SessionStatus::Exited);
    assert!(String::from_utf8_lossy(&m2.pty_scrollback(&t.id).unwrap()).contains("hi_from_pty"));
    // restart the exited terminal session
    let t2 = m2.restart(&t.id).await.unwrap();
    assert_eq!(t2.status, SessionStatus::Running);
    m2.shutdown().await;
    assert_eq!(m2.get_session(&t.id).unwrap().status, SessionStatus::Exited);
}

#[tokio::test]
async fn bad_inputs_are_rejected() {
    let (m, _c, _s, _store) = setup();
    assert!(m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/definitely/not/here".into(),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Codex,
            cwd: "/tmp".into(),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(m.get_session("nope").is_err());
    assert!(m.send("nope", Input::default()).await.is_err());
}

/// Stands in for the ACP provider: structured only, no terminal command.
struct AcpLike;

#[async_trait::async_trait]
impl Provider for AcpLike {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Acp
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Acp,
            display_name: "ACP".into(),
            available: true,
            version: None,
            binary: None,
            capabilities: CapabilitySet {
                structured: true,
                ..Default::default()
            },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(
        &self,
        session: &Session,
        _fork: bool,
        sink: EventSink,
    ) -> anyhow::Result<Box<dyn Driver>> {
        Ok(Box::new(FakeDriver {
            sink,
            session_id: session.id.clone(),
            calls: Default::default(),
            knobs: Default::default(),
        }))
    }
    fn terminal_command(&self, _session: &Session) -> Vec<String> {
        vec![]
    }
}

#[tokio::test]
async fn acp_sessions_need_an_agent_and_have_no_terminal_mode() {
    let m = Manager::new(
        Arc::new(MemoryStore::default()),
        vec![Arc::new(AcpLike)],
        None,
    );
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let opts = |agent: Option<&str>, mode: Option<SessionMode>| CreateSessionOpts {
        provider: ProviderKind::Acp,
        agent: agent.map(str::to_string),
        cwd: cwd.clone(),
        mode,
        ..Default::default()
    };
    let err = m
        .create_session(opts(None, None))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("need an agent"), "{err}");
    let err = m
        .create_session(opts(Some("gemini"), Some(SessionMode::Terminal)))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("gemini sessions have no terminal mode"),
        "{err}"
    );

    let s = m.create_session(opts(Some("gemini"), None)).await.unwrap();
    assert_eq!(s.agent.as_deref(), Some("gemini"));
    assert!(s.title.starts_with("gemini · "), "{}", s.title);
}

#[tokio::test]
async fn clearing_notices_is_recorded_without_touching_the_sessions() {
    let (m, _calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let opts = |title: &str| CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: cwd.clone(),
        title: Some(title.into()),
        ..Default::default()
    };
    let mut rx = m.subscribe();
    let a = m.create_session(opts("a")).await.unwrap();
    let b = m.create_session(opts("b")).await.unwrap();
    // Let the sessions' own start-up updates settle first.
    drain(&mut rx).await;
    let before = (
        m.get_session(&a.id).unwrap().last_activity,
        m.get_session(&b.id).unwrap().last_activity,
    );

    m.clear_notices(Some(&a.id)).unwrap();
    let evs = drain(&mut rx).await;
    assert!(evs
        .iter()
        .any(|e| matches!(e, Event::NoticesCleared { session_id } if session_id == &a.id)));
    assert!(
        !evs.iter()
            .any(|e| matches!(e, Event::SessionUpdated { .. })),
        "clearing must not reorder the sidebar"
    );
    assert!(m
        .history(&a.id, 0, 100)
        .unwrap()
        .iter()
        .any(|e| matches!(e.event, Event::NoticesCleared { .. })));

    m.clear_notices(None).unwrap();
    drain(&mut rx).await;
    assert!(m
        .history(&b.id, 0, 100)
        .unwrap()
        .iter()
        .any(|e| matches!(e.event, Event::NoticesCleared { .. })));
    assert_eq!(
        before,
        (
            m.get_session(&a.id).unwrap().last_activity,
            m.get_session(&b.id).unwrap().last_activity
        )
    );
    assert!(m.clear_notices(Some("missing")).is_err());
}

#[tokio::test]
async fn pull_requests_are_recorded_once_and_survive_a_restart() {
    let (m, _calls, _starts, store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = m.subscribe();
    drain(&mut rx).await;
    let before = m.get_session(&s.id).unwrap().last_activity;
    let url = "https://github.com/owner/repo/pull/7";

    assert_eq!(m.record_pull(&s.id, url).unwrap().pulls, vec![url]);
    let evs = drain(&mut rx).await;
    assert!(evs.iter().any(
        |e| matches!(e, Event::SessionUpdated { session } if session.pulls == vec![url.to_string()])
    ));
    // The same PR again, in another case, changes nothing and tells no one.
    m.record_pull(&s.id, "https://github.com/Owner/Repo/pull/7")
        .unwrap();
    assert!(!drain(&mut rx)
        .await
        .iter()
        .any(|e| matches!(e, Event::SessionUpdated { .. })));
    let later = "https://github.com/owner/repo/pull/9";
    assert_eq!(m.record_pull(&s.id, later).unwrap().pulls, vec![url, later]);
    assert_eq!(
        m.get_session(&s.id).unwrap().last_activity,
        before,
        "finding a PR must not reorder the sidebar"
    );
    assert!(m.record_pull(&s.id, "not a url").is_err());
    assert!(m.record_pull("missing", url).is_err());

    let stored = store.list_sessions().unwrap();
    assert_eq!(
        stored.iter().find(|x| x.id == s.id).unwrap().pulls,
        vec![url, later]
    );
}

#[test]
fn sessions_saved_before_pulls_were_recorded_still_load() {
    let s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: "/tmp".into(),
        ..Default::default()
    });
    let mut json = serde_json::to_value(&s).unwrap();
    json.as_object_mut().unwrap().remove("pulls");
    let old: Session = serde_json::from_value(json).unwrap();
    assert!(old.pulls.is_empty());
}

#[tokio::test]
async fn sessions_want_attention_when_they_stop_until_they_are_seen() {
    let (m, _calls, _starts, store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(s.attention, None);
    let send = |text: &str| Input {
        text: text.into(),
        ..Default::default()
    };

    // A finished turn is done.
    m.send(&s.id, send("hi")).await.unwrap();
    wait_attention(&m, &s.id, Some(Attention::Done)).await;

    // Seeing it clears it, without counting as activity; seeing it again tells no one.
    let mut rx = m.subscribe();
    let before = m.get_session(&s.id).unwrap().last_activity;
    assert_eq!(m.mark_seen(&s.id).unwrap().attention, None);
    assert!(drain(&mut rx)
        .await
        .iter()
        .any(|e| matches!(e, Event::SessionUpdated { session } if session.attention.is_none())));
    m.mark_seen(&s.id).unwrap();
    assert!(!drain(&mut rx)
        .await
        .iter()
        .any(|e| matches!(e, Event::SessionUpdated { .. })));
    assert_eq!(m.get_session(&s.id).unwrap().last_activity, before);
    assert!(m.mark_seen("missing").is_err());

    // An approval waits on the user; answering it, from the inbox say, ends the wait,
    // and the turn it lets finish is done again.
    m.send(&s.id, send("please approve")).await.unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingApproval).await;
    wait_attention(&m, &s.id, Some(Attention::Waiting)).await;
    m.respond_approval(
        &s.id,
        "ap1",
        ApprovalDecision {
            option: ApprovalOption::Accept,
            updated_input: None,
            message: None,
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &s.id, Some(Attention::Done)).await;

    // A failed turn and a crashed agent are failures.
    m.send(&s.id, send("fail")).await.unwrap();
    wait_attention(&m, &s.id, Some(Attention::Failed)).await;
    m.mark_seen(&s.id).unwrap();
    m.send(&s.id, send("crash")).await.unwrap();
    wait_status(&m, &s.id, SessionStatus::Error).await;
    wait_attention(&m, &s.id, Some(Attention::Failed)).await;

    // It is kept across a restart; a wait the old daemon dropped becomes done.
    let mut stored = m.get_session(&s.id).unwrap();
    stored.attention = Some(Attention::Waiting);
    store.upsert_session(&stored).unwrap();
    let m2 = Manager::new(
        store.clone(),
        vec![Arc::new(FakeProvider {
            calls: Default::default(),
            starts: Default::default(),
            prompts: Default::default(),
            mcp: Default::default(),
            knobs: Default::default(),
        })],
        None,
    );
    m2.restore().unwrap();
    assert_eq!(
        m2.get_session(&s.id).unwrap().attention,
        Some(Attention::Done)
    );
}

#[tokio::test]
async fn a_terminal_command_that_exits_wants_attention() {
    let (m, _calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let opts = |cmd: &str| CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: dir.path().to_string_lossy().to_string(),
        mode: Some(SessionMode::Terminal),
        command: Some(vec!["/bin/sh".into(), "-c".into(), cmd.into()]),
        ..Default::default()
    };
    let ok = m.create_session(opts("exit 0")).await.unwrap();
    let bad = m.create_session(opts("exit 3")).await.unwrap();
    wait_status(&m, &ok.id, SessionStatus::Exited).await;
    wait_status(&m, &bad.id, SessionStatus::Exited).await;
    assert_eq!(
        m.get_session(&ok.id).unwrap().attention,
        Some(Attention::Done)
    );
    assert_eq!(
        m.get_session(&bad.id).unwrap().attention,
        Some(Attention::Failed)
    );
}

#[test]
fn sessions_saved_before_attention_still_load() {
    let s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: "/tmp".into(),
        ..Default::default()
    });
    let mut json = serde_json::to_value(&s).unwrap();
    json.as_object_mut().unwrap().remove("attention");
    let old: Session = serde_json::from_value(json).unwrap();
    assert_eq!(old.attention, None);
}

/// A structured session with a running fake agent, and a way to send it events in any order.
async fn session_with_sink(m: &Manager, knobs: &Knobs) -> (String, impl Fn(Event)) {
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    let sink = knobs.lock().sink.clone().unwrap();
    (s.id, move |ev| sink.send(ev).unwrap())
}

#[tokio::test]
async fn an_answer_recorded_after_its_turn_ended_leaves_the_session_done() {
    let (m, knobs) = setup_with_knobs();
    let (id, send) = session_with_sink(&m, &knobs).await;
    let session_id = id.clone();
    let resolved = |approval_id: &str| Event::ApprovalResolved {
        session_id: session_id.clone(),
        approval_id: approval_id.into(),
        decision: ApprovalDecision {
            option: ApprovalOption::Decline,
            updated_input: None,
            message: None,
        },
    };

    // The turn ends before the answer is recorded.
    send(Event::TurnStarted {
        session_id: id.clone(),
        turn: turn(&id, "t1", TurnStatus::Running),
    });
    send(Event::ApprovalRequested {
        session_id: id.clone(),
        approval: approval(&id, "a1"),
    });
    wait_attention(&m, &id, Some(Attention::Waiting)).await;
    send(Event::TurnCompleted {
        session_id: id.clone(),
        turn: turn(&id, "t1", TurnStatus::Completed),
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        m.get_session(&id).unwrap().attention,
        Some(Attention::Waiting)
    );
    send(resolved("a1"));
    wait_attention(&m, &id, Some(Attention::Done)).await;

    // The answer comes while the turn goes on: nothing to see until it ends.
    m.mark_seen(&id).unwrap();
    send(Event::TurnStarted {
        session_id: id.clone(),
        turn: turn(&id, "t2", TurnStatus::Running),
    });
    send(Event::ApprovalRequested {
        session_id: id.clone(),
        approval: approval(&id, "a2"),
    });
    wait_attention(&m, &id, Some(Attention::Waiting)).await;
    send(resolved("a2"));
    wait_attention(&m, &id, None).await;
    send(Event::TurnCompleted {
        session_id: id.clone(),
        turn: turn(&id, "t2", TurnStatus::Completed),
    });
    wait_attention(&m, &id, Some(Attention::Done)).await;
}

#[tokio::test]
async fn a_failure_stays_until_seen_and_a_running_session_is_not_done() {
    let (m, knobs) = setup_with_knobs();
    let (id, send) = session_with_sink(&m, &knobs).await;
    let started = |t: &str| Event::TurnStarted {
        session_id: id.clone(),
        turn: turn(&id, t, TurnStatus::Running),
    };
    let ended = |t: &str, status| Event::TurnCompleted {
        session_id: id.clone(),
        turn: turn(&id, t, status),
    };

    send(started("t1"));
    send(ended("t1", TurnStatus::Failed));
    wait_attention(&m, &id, Some(Attention::Failed)).await;
    // Another turn, even a good one, does not hide the failure.
    send(started("t2"));
    send(ended("t2", TurnStatus::Completed));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        m.get_session(&id).unwrap().attention,
        Some(Attention::Failed)
    );
    // Waiting on the user does.
    send(Event::ApprovalRequested {
        session_id: id.clone(),
        approval: approval(&id, "a1"),
    });
    wait_attention(&m, &id, Some(Attention::Waiting)).await;

    // Done is over once the session runs again.
    m.stop(&id).await.unwrap();
    m.mark_seen(&id).unwrap();
    m.send(
        &id,
        Input {
            text: "hi".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &id, Some(Attention::Done)).await;
    let sink = knobs.lock().sink.clone().unwrap();
    sink.send(Event::TurnStarted {
        session_id: id.clone(),
        turn: turn(&id, "t3", TurnStatus::Running),
    })
    .unwrap();
    wait_attention(&m, &id, None).await;
}

#[tokio::test]
async fn questions_wait_and_stopping_ends_the_wait() {
    let (m, _calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    m.send(
        &s.id,
        Input {
            text: "a question".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingInput).await;
    wait_attention(&m, &s.id, Some(Attention::Waiting)).await;
    m.stop(&s.id).await.unwrap();
    assert_eq!(m.get_session(&s.id).unwrap().attention, None);

    m.send(
        &s.id,
        Input {
            text: "please approve".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &s.id, Some(Attention::Waiting)).await;
    m.stop(&s.id).await.unwrap();
    assert_eq!(m.get_session(&s.id).unwrap().attention, None);
}

#[tokio::test]
async fn a_dismissed_question_stops_waiting_and_the_turn_carries_on() {
    let (m, calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    m.send(
        &s.id,
        Input {
            text: "a question".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingInput).await;
    assert_eq!(m.get_session(&s.id).unwrap().pending_count, 1);
    m.respond_input(
        &s.id,
        UserInputResponse {
            request_id: "q1".into(),
            answers: Default::default(),
            declined: true,
        },
    )
    .await
    .unwrap();
    assert!(calls
        .lock()
        .iter()
        .any(|c| c == "respond_input:q1:declined=true"));
    // The agent's turn is still going, so the session runs again instead of waiting.
    wait_status(&m, &s.id, SessionStatus::Running).await;
    assert!(m.pending().1.is_empty());
    assert_eq!(m.get_session(&s.id).unwrap().pending_count, 0);
    // Gone for good: a second dismissal has nothing to go to.
    assert!(m
        .respond_input(
            &s.id,
            UserInputResponse {
                request_id: "q1".into(),
                answers: Default::default(),
                declined: true,
            },
        )
        .await
        .is_err());
}

#[tokio::test]
async fn answers_to_secret_questions_stay_out_of_the_log() {
    let (m, _calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    m.send(
        &s.id,
        Input {
            text: "a secret question".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingInput).await;
    let mut answers = std::collections::HashMap::new();
    answers.insert("pw".to_string(), vec!["hunter2".to_string()]);
    m.respond_input(
        &s.id,
        UserInputResponse {
            request_id: "q1".into(),
            answers,
            declined: false,
        },
    )
    .await
    .unwrap();
    // The event loop stores events after the call returns.
    let mut resolved = None;
    for _ in 0..200 {
        resolved = m
            .history(&s.id, 0, 1000)
            .unwrap()
            .into_iter()
            .find_map(|e| match e.event {
                Event::UserInputResolved { response, .. } => Some(response),
                _ => None,
            });
        if resolved.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let resolved = resolved.expect("resolved event stored");
    assert_eq!(resolved.answers["pw"], vec!["(hidden)".to_string()]);
    assert!(m.pending().1.is_empty());
}

#[tokio::test]
async fn turns_a_resumed_agent_replays_are_not_news() {
    let (m, knobs) = setup_with_knobs();
    knobs.lock().replay_failed_turn = true;
    let (id, _send) = session_with_sink(&m, &knobs).await;
    m.send(
        &id,
        Input {
            text: "hi".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &id, Some(Attention::Done)).await;
    m.stop(&id).await.unwrap();
    m.mark_seen(&id).unwrap();
    // Resuming replays the failed turn first; counted, it would outlast the new one.
    m.send(
        &id,
        Input {
            text: "again".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &id, Some(Attention::Done)).await;
}

#[tokio::test]
async fn an_agent_that_fails_to_start_is_marked_failed() {
    let (m, knobs) = setup_with_knobs();
    knobs.lock().fail_start = true;
    let dir = tempfile::tempdir().unwrap();
    let err = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await;
    assert!(err.is_err());
    let s = &m.list_sessions()[0];
    assert_eq!(
        (s.status, s.attention),
        (SessionStatus::Error, Some(Attention::Failed))
    );
}

#[tokio::test]
async fn an_agent_killed_because_it_was_asked_to_stop_has_not_failed() {
    let (m, knobs) = setup_with_knobs();
    knobs.lock().exit_on_stop = Some("killed after the grace period".into());
    let (id, _send) = session_with_sink(&m, &knobs).await;
    m.send(
        &id,
        Input {
            text: "hi".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &id, Some(Attention::Done)).await;
    m.mark_seen(&id).unwrap();
    m.stop(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let s = m.get_session(&id).unwrap();
    assert_eq!(
        (s.status, s.attention, s.last_error),
        (SessionStatus::Idle, None, None)
    );
    // The flag is used up: a crash of the next agent is a failure again.
    m.send(
        &id,
        Input {
            text: "crash".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_attention(&m, &id, Some(Attention::Failed)).await;
}

/// A store that takes its time writing sessions, so overlapping writes interleave.
#[derive(Default)]
struct SlowStore {
    inner: MemoryStore,
    writes: std::sync::atomic::AtomicU64,
}

impl Store for SlowStore {
    fn upsert_session(&self, session: &Session) -> anyhow::Result<()> {
        let n = self
            .writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(Duration::from_micros(300 * (n % 3)));
        self.inner.upsert_session(session)
    }
    fn delete_session(&self, id: &str) -> anyhow::Result<()> {
        self.inner.delete_session(id)
    }
    fn list_sessions(&self) -> anyhow::Result<Vec<Session>> {
        self.inner.list_sessions()
    }
    fn append_event(&self, session_id: &str, event: &Event) -> anyhow::Result<u64> {
        self.inner.append_event(session_id, event)
    }
    fn events(
        &self,
        session_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredEvent>> {
        self.inner.events(session_id, after_seq, limit)
    }
    fn search(&self, query: &str, limit: usize) -> anyhow::Result<Vec<SearchHit>> {
        self.inner.search(query, limit)
    }
    fn get_setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        self.inner.get_setting(key)
    }
    fn set_setting(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.inner.set_setting(key, value)
    }
    fn save_scrollback(&self, session_id: &str, data: &[u8]) -> anyhow::Result<()> {
        self.inner.save_scrollback(session_id, data)
    }
    fn load_scrollback(&self, session_id: &str) -> anyhow::Result<Option<Vec<u8>>> {
        self.inner.load_scrollback(session_id)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn changes_made_at_once_are_all_stored_and_announced_in_order() {
    let store = Arc::new(SlowStore::default());
    let provider = Arc::new(FakeProvider {
        calls: Default::default(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let m = Manager::new(store.clone(), vec![provider], None);
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut rx = m.subscribe();
    for round in 0..20 {
        // Activity (rename) and bookkeeping (record_pull) at the same moment.
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|t| {
                let (m, id, barrier) = (m.clone(), s.id.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    if t == 0 {
                        m.rename(&id, &format!("title {round}")).unwrap();
                    } else {
                        m.record_pull(&id, &format!("https://github.com/o/r/pull/{round}"))
                            .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let live = m.get_session(&s.id).unwrap();
        assert_eq!(
            (live.title.clone(), live.pulls.len()),
            (format!("title {round}"), round + 1)
        );
        let stored = store
            .list_sessions()
            .unwrap()
            .into_iter()
            .find(|x| x.id == s.id)
            .unwrap();
        assert_eq!(stored, live, "round {round}: the store holds a stale copy");
        let mut announced = None;
        while let Ok(ev) = rx.try_recv() {
            if let Event::SessionUpdated { session } = ev {
                announced = Some(session);
            }
        }
        assert_eq!(
            announced.as_ref(),
            Some(&live),
            "round {round}: the app was told a stale copy"
        );
    }
}

/// Every directory is its own repository, except `not-a-repo` directories.
struct DirRepos;

impl WorktreeBackend for DirRepos {
    fn create(&self, _cwd: &str, _opts: &WorktreeOpts) -> anyhow::Result<WorktreeInfo> {
        anyhow::bail!("unused")
    }
    fn remove(&self, _info: &WorktreeInfo) -> anyhow::Result<()> {
        Ok(())
    }
    fn repo_root(&self, cwd: &str) -> Option<String> {
        (!cwd.ends_with("not-a-repo")).then(|| cwd.to_string())
    }
}

#[tokio::test]
async fn groups_are_remembered_with_their_repositories() {
    let store = Arc::new(MemoryStore::default());
    let provider = Arc::new(FakeProvider {
        calls: Default::default(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let m = Manager::new(store.clone(), vec![provider], Some(Arc::new(DirRepos)));
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let plain = tempfile::tempdir().unwrap();
    let plain_dir = plain.path().join("not-a-repo");
    std::fs::create_dir(&plain_dir).unwrap();
    let (a, b, plain) = (
        a.path().to_string_lossy().to_string(),
        b.path().to_string_lossy().to_string(),
        plain_dir.to_string_lossy().to_string(),
    );
    let create = |cwd: &str, group: Option<&str>| {
        let m = m.clone();
        let opts = CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.into(),
            group: group.map(Into::into),
            ..Default::default()
        };
        async move { m.create_session(opts).await.unwrap() }
    };

    let s1 = create(&a, Some("backend")).await;
    create(&plain, Some("backend")).await;
    let groups = m.list_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "backend");
    assert_eq!(
        groups[0]
            .repos
            .iter()
            .map(|r| r.path.as_str())
            .collect::<Vec<_>>(),
        vec![a.as_str()],
        "only repositories are linked"
    );
    assert_eq!(m.group_for_dir(&a).unwrap().as_deref(), Some("backend"));
    assert_eq!(m.group_for_dir(&b).unwrap(), None);
    assert_eq!(m.group_for_dir(&plain).unwrap(), None);

    // The group outlives its sessions.
    for s in m.list_sessions() {
        m.delete(&s.id, false).await.unwrap();
    }
    assert_eq!(m.list_groups().unwrap().len(), 1);
    assert_eq!(m.group_for_dir(&a).unwrap().as_deref(), Some("backend"));

    // The repository's most recent group wins.
    let s2 = create(&a, None).await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    m.set_group(&s2.id, Some("frontend".into())).unwrap();
    assert_eq!(m.group_for_dir(&a).unwrap().as_deref(), Some("frontend"));
    assert_ne!(s1.id, s2.id);

    // Deleting a group forgets it and ungroups its sessions.
    m.delete_group("frontend").unwrap();
    assert_eq!(m.get_session(&s2.id).unwrap().group, None);
    assert_eq!(
        m.list_groups()
            .unwrap()
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        vec!["backend"]
    );
    assert_eq!(m.group_for_dir(&a).unwrap().as_deref(), Some("backend"));

    // Blank names are not groups.
    m.set_group(&s2.id, Some("  ".into())).unwrap();
    assert_eq!(m.list_groups().unwrap().len(), 1);
}

#[tokio::test]
async fn restore_registers_groups_of_existing_sessions() {
    let store = Arc::new(MemoryStore::default());
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let mut s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Terminal,
        cwd: cwd.clone(),
        group: Some("legacy".into()),
        ..Default::default()
    });
    s.status = SessionStatus::Exited;
    store.upsert_session(&s).unwrap();
    let m = Manager::new(store.clone(), vec![], Some(Arc::new(DirRepos)));
    m.restore().unwrap();
    let groups = m.list_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].repos[0].path, cwd);
    assert_eq!(groups[0].repos[0].last_used, s.last_activity);
}

fn orchestrator_setup() -> (Manager, Calls, Arc<FakeProvider>) {
    let provider = Arc::new(FakeProvider {
        calls: Default::default(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let m = Manager::new(
        Arc::new(MemoryStore::default()),
        vec![provider.clone()],
        None,
    );
    (m, provider.calls.clone(), provider)
}

fn sent_reports(calls: &Calls) -> Vec<String> {
    calls
        .lock()
        .iter()
        .filter(|c| c.starts_with("send:[Aura] Worker report"))
        .cloned()
        .collect()
}

#[tokio::test]
async fn orchestrators_get_tools_and_workers_report_back() {
    let (m, calls, provider) = orchestrator_setup();
    m.enable_orchestration("/opt/aura/aura".into(), "/data".into());
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let orch = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.clone(),
            title: Some("Lead".into()),
            group: Some("proj".into()),
            permission_mode: Some("acceptEdits".into()),
            orchestrator: true,
            ..Default::default()
        })
        .await
        .unwrap();
    // The orchestrator starts with the tools and is told how to use them.
    let mcp = provider.mcp.lock()[0].clone();
    assert_eq!(mcp.len(), 1);
    assert_eq!(mcp[0].command, "/opt/aura/aura");
    assert_eq!(
        mcp[0].args,
        vec![
            "mcp",
            "--data-dir",
            "/data",
            "--orchestrator",
            orch.id.as_str()
        ]
    );
    let prompt = provider.prompts.lock()[0].clone().unwrap();
    assert!(prompt.contains("You are an orchestrator"), "{prompt}");
    assert!(prompt.contains(&orch.id), "{prompt}");

    // Only orchestrators start workers.
    let plain = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(m
        .start_worker(
            &plain.id,
            WorkerSpec {
                agent: "claude".into(),
                prompt: "x".into(),
                ..Default::default()
            }
        )
        .await
        .is_err());

    let worker = m
        .start_worker(
            &orch.id,
            WorkerSpec {
                agent: "claude".into(),
                prompt: "build it".into(),
                title: Some("Builder".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(worker.orchestrator_id.as_deref(), Some(orch.id.as_str()));
    assert_eq!(
        worker.group.as_deref(),
        Some("proj"),
        "workers join the orchestrator's group"
    );
    assert_eq!(
        worker.permission_mode.as_deref(),
        Some("acceptEdits"),
        "same agent inherits the mode"
    );
    assert!(calls.lock().iter().any(|c| c == "send:build it"));
    // Workers get no tools and know who they work for.
    assert!(provider.mcp.lock().last().unwrap().is_empty());
    let wprompt = provider.prompts.lock().last().cloned().flatten().unwrap();
    assert!(
        wprompt.contains("You are a worker") && wprompt.contains("\"Lead\""),
        "{wprompt}"
    );

    // The worker's turn ends; the idle orchestrator is told, with the reply.
    wait_status(&m, &worker.id, SessionStatus::Idle).await;
    for _ in 0..100 {
        if !sent_reports(&calls).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let reports = sent_reports(&calls);
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert!(
        reports[0].contains("Builder")
            && reports[0].contains(&worker.id)
            && reports[0].contains("hello"),
        "{}",
        reports[0]
    );

    // Workers are found by id prefix or title, and only among one's own.
    assert_eq!(m.worker(&orch.id, &worker.id[..6]).unwrap().id, worker.id);
    assert_eq!(m.worker(&orch.id, "Builder").unwrap().id, worker.id);
    assert!(m.worker(&orch.id, &plain.id).is_err());
    let transcript = m.worker_transcript(&orch.id, "Builder", 1).unwrap();
    assert!(
        transcript.contains("build it") && transcript.contains("hello"),
        "{transcript}"
    );
    let listed = m.worker_reports(&orch.id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].last_reply.as_deref(), Some("hello"));

    // Deleting the orchestrator deletes its worker; the plain session stays.
    m.delete(&orch.id, false).await.unwrap();
    assert!(m.get_session(&worker.id).is_err());
    assert!(m.get_session(&plain.id).is_ok());
}

async fn wait_native_id(m: &Manager, id: &str) {
    for _ in 0..100 {
        if m.get_session(id).unwrap().native_id.is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no native id");
}

#[tokio::test]
async fn orchestrators_need_no_folder_and_name_one_for_each_worker() {
    let (m, calls, provider) = orchestrator_setup();
    let data = tempfile::tempdir().unwrap();
    let base = data.path().join("orchestrators");
    m.enable_orchestrator_dirs(base.clone());
    let repo = tempfile::tempdir().unwrap();
    let repo = repo.path().to_string_lossy().to_string();

    let orch = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            orchestrator: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(orch.folderless);
    assert_eq!(orch.cwd, base.join(&orch.id).to_string_lossy());
    assert!(std::path::Path::new(&orch.cwd).is_dir());
    assert_eq!(orch.title, "claude · orchestrator");
    let prompt = provider.prompts.lock()[0].clone().unwrap();
    assert!(
        prompt.contains("You belong to no folder") && prompt.contains("list_projects"),
        "{prompt}"
    );

    // Its workers need a folder, named in full.
    let spec = |cwd: Option<&str>| WorkerSpec {
        agent: "claude".into(),
        prompt: "build it".into(),
        cwd: cwd.map(Into::into),
        ..Default::default()
    };
    let err = m.start_worker(&orch.id, spec(None)).await.unwrap_err();
    assert!(err.to_string().contains("`cwd` is required"), "{err}");
    let err = m
        .start_worker(&orch.id, spec(Some("sub")))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("absolute path"), "{err}");
    let worker = m.start_worker(&orch.id, spec(Some(&repo))).await.unwrap();
    assert_eq!(worker.cwd, repo);
    assert!(!worker.folderless);
    assert!(calls.lock().iter().any(|c| c == "send:build it"));

    // Other sessions still belong to a folder, and it cannot leave its role.
    let plain = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!plain.folderless && !std::path::Path::new(&plain.cwd).starts_with(&base));
    assert!(m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            orchestrator: true,
            worktree: Some(WorktreeOpts {
                branch: "b".into(),
                base: None,
                path: None,
            }),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(m.set_orchestrator(&orch.id, false).await.is_err());

    // A fork resumes in the same directory, which goes with the last of them.
    wait_native_id(&m, &orch.id).await;
    let fork = m.fork(&orch.id).await.unwrap();
    assert!(fork.folderless && fork.orchestrator);
    assert_eq!(fork.cwd, orch.cwd);
    m.delete(&orch.id, false).await.unwrap();
    assert!(
        m.get_session(&worker.id).is_err(),
        "its worker went with it"
    );
    assert!(std::path::Path::new(&orch.cwd).is_dir());
    m.delete(&fork.id, false).await.unwrap();
    assert!(!std::path::Path::new(&orch.cwd).exists());
    assert!(
        std::path::Path::new(&repo).is_dir(),
        "the worker's folder is the user's"
    );
}

#[tokio::test]
async fn folderless_orchestrators_restore_with_their_directory() {
    let store = Arc::new(MemoryStore::default());
    let data = tempfile::tempdir().unwrap();
    let dir = data.path().join("orchestrators").join("gone");
    let mut s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: dir.to_string_lossy().to_string(),
        orchestrator: true,
        ..Default::default()
    });
    s.folderless = true;
    store.upsert_session(&s).unwrap();
    // Saved before orchestrators could lack a folder: one with a folder.
    let old = r#"{"id":"old","provider":"claude","native_id":null,"cwd":"/tmp","worktree":null,"title":"Lead","group":null,"status":"idle","mode":"structured","model":null,"effort":null,"permission_mode":null,"sandbox_mode":null,"command":null,"created_at":"2026-01-01T00:00:00Z","last_activity":"2026-01-01T00:00:00Z","archived":false,"pinned":false,"usage":{"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"total_cost_usd":null,"context_window":null,"context_used":null},"last_error":null,"pending_count":0,"exit_code":null,"orchestrator":true}"#;
    store
        .upsert_session(&serde_json::from_str::<Session>(old).unwrap())
        .unwrap();
    let m = Manager::new(store, vec![], None);
    m.enable_orchestrator_dirs(data.path().join("orchestrators"));
    m.restore().unwrap();
    assert!(dir.is_dir());
    let old = m.get_session("old").unwrap();
    assert!(old.orchestrator && !old.folderless && old.cwd == "/tmp");
}

#[tokio::test]
async fn orchestrators_delete_only_their_own_workers() {
    let (m, _calls, _provider) = orchestrator_setup();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let lead = |title: &str| CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: cwd.clone(),
        title: Some(title.into()),
        orchestrator: true,
        ..Default::default()
    };
    let a = m.create_session(lead("A")).await.unwrap();
    let b = m.create_session(lead("B")).await.unwrap();
    let plain = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    let spec = |title: &str| WorkerSpec {
        agent: "claude".into(),
        prompt: "work".into(),
        title: Some(title.into()),
        ..Default::default()
    };
    let wa = m.start_worker(&a.id, spec("a's worker")).await.unwrap();
    let wb = m.start_worker(&b.id, spec("b's worker")).await.unwrap();

    for other in [&wb.id, &plain.id, &a.id, &b.id] {
        let err = m.delete_worker(&a.id, other).await.unwrap_err();
        assert!(
            err.to_string().contains("no worker of this orchestrator"),
            "{err}"
        );
    }
    assert!(
        m.delete_worker(&plain.id, &wa.id).await.is_err(),
        "only orchestrators delete"
    );
    assert_eq!(m.list_sessions().len(), 5, "nothing was deleted");

    let deleted = m.delete_worker(&a.id, "a's worker").await.unwrap();
    assert_eq!(
        deleted.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec![wa.id.as_str()]
    );
    assert!(m.get_session(&wa.id).is_err());
    for kept in [&a.id, &b.id, &wb.id, &plain.id] {
        assert!(m.get_session(kept).is_ok());
    }
    assert!(m.worker_reports(&a.id).unwrap().is_empty());
}

#[tokio::test]
async fn deleting_an_orchestrator_deletes_every_session_under_it() {
    let store = Arc::new(MemoryStore::default());
    let session = |id: &str, orchestrator: bool, under: Option<&str>| {
        let mut s = Session::new(&CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/tmp".into(),
            orchestrator,
            orchestrator_id: under.map(Into::into),
            ..Default::default()
        });
        s.id = id.into();
        s
    };
    let mut archived = session("archived", false, Some("lead"));
    archived.archived = true;
    for s in [
        session("lead", true, None),
        session("w1", false, Some("lead")),
        session("sub", true, Some("lead")),
        session("w2", false, Some("sub")),
        archived,
        session("other", true, None),
        session("w3", false, Some("other")),
        session("plain", false, None),
    ] {
        store.upsert_session(&s).unwrap();
    }
    let m = Manager::new(store.clone(), vec![], None);
    m.restore().unwrap();
    let mut rx = m.subscribe();

    m.delete("lead", false).await.unwrap();
    let mut left: Vec<String> = m.list_sessions().into_iter().map(|s| s.id).collect();
    left.sort();
    assert_eq!(left, vec!["other", "plain", "w3"]);
    let mut stored: Vec<String> = store
        .list_sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    stored.sort();
    assert_eq!(stored, left);
    let removed: Vec<String> = drain(&mut rx)
        .await
        .into_iter()
        .filter_map(|e| match e {
            Event::SessionRemoved { session_id } => Some(session_id),
            _ => None,
        })
        .collect();
    assert_eq!(removed.len(), 5, "{removed:?}");
    assert_eq!(removed[0], "lead", "the orchestrator goes first");
    let at = |id: &str| removed.iter().position(|r| r == id).unwrap();
    assert!(at("sub") < at("w2"));

    // A worker goes alone.
    m.delete("w3", false).await.unwrap();
    assert!(m.get_session("other").is_ok());
}

#[tokio::test]
async fn orchestrators_see_the_folders_and_repositories_aura_knows() {
    let provider = Arc::new(FakeProvider {
        calls: Default::default(),
        starts: Default::default(),
        prompts: Default::default(),
        mcp: Default::default(),
        knobs: Default::default(),
    });
    let m = Manager::new(
        Arc::new(MemoryStore::default()),
        vec![provider],
        Some(Arc::new(DirRepos)),
    );
    let data = tempfile::tempdir().unwrap();
    m.enable_orchestrator_dirs(data.path().join("orchestrators"));
    let repo = tempfile::tempdir().unwrap();
    let plain = tempfile::tempdir().unwrap();
    let plain_dir = plain.path().join("not-a-repo");
    std::fs::create_dir(&plain_dir).unwrap();
    let (repo, plain) = (
        repo.path().to_string_lossy().to_string(),
        plain_dir.to_string_lossy().to_string(),
    );
    let create = |cwd: &str, group: Option<&str>, orchestrator: bool| {
        let m = m.clone();
        let opts = CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.into(),
            group: group.map(Into::into),
            orchestrator,
            ..Default::default()
        };
        async move { m.create_session(opts).await.unwrap() }
    };
    create(&repo, Some("backend"), false).await;
    create(&repo, None, false).await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    create(&plain, None, false).await;
    create("", None, true).await;

    let projects = m.projects().unwrap();
    assert_eq!(
        projects
            .iter()
            .map(|p| (p.path.as_str(), p.repo, p.sessions))
            .collect::<Vec<_>>(),
        vec![(plain.as_str(), false, 1), (repo.as_str(), true, 2)],
        "most recent first, without the orchestrator's own directory"
    );
    assert_eq!(projects[1].groups, vec!["backend"]);
    let text = describe_projects(&projects);
    assert!(
        text.contains(&format!(
            "`{repo}` (git repository) · 2 sessions · group backend"
        )),
        "{text}"
    );
}

#[tokio::test]
async fn a_busy_orchestrator_gets_reports_once_it_is_free_and_not_for_what_it_waited_on() {
    let (m, calls, _provider) = orchestrator_setup();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let orch = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: cwd.clone(),
            orchestrator: true,
            ..Default::default()
        })
        .await
        .unwrap();
    // Without the `aura` binary there are no tools, and the prompt says so.
    let prompt = m.instructions_for(&orch).unwrap().unwrap();
    assert!(
        prompt.contains("could not give you the `aura` tools"),
        "{prompt}"
    );

    // The orchestrator is mid-turn (the fake waits on an approval).
    m.send(
        &orch.id,
        Input {
            text: "please approve".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &orch.id, SessionStatus::WaitingApproval).await;

    let a = m
        .start_worker(
            &orch.id,
            WorkerSpec {
                agent: "claude".into(),
                prompt: "task a".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let waited = m
        .wait_workers(
            &orch.id,
            std::slice::from_ref(&a.id),
            false,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(!waited.timed_out);
    assert_eq!(waited.workers[0].last_reply.as_deref(), Some("hello"));

    let b = m
        .start_worker(
            &orch.id,
            WorkerSpec {
                agent: "claude".into(),
                prompt: "task b".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_status(&m, &b.id, SessionStatus::Idle).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        sent_reports(&calls).is_empty(),
        "nothing is delivered while the orchestrator works"
    );

    // Its turn ends: one report, for the worker it did not wait on.
    m.respond_approval(
        &orch.id,
        "ap1",
        ApprovalDecision {
            option: ApprovalOption::Accept,
            updated_input: None,
            message: None,
        },
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if !sent_reports(&calls).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let reports = sent_reports(&calls);
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert!(
        reports[0].contains(&b.id) && !reports[0].contains(&a.id),
        "{}",
        reports[0]
    );

    // Waiting on a worker that is done returns at once; a timeout is reported.
    let r = m
        .wait_workers(&orch.id, &[], true, Duration::from_millis(50))
        .await
        .unwrap();
    assert!(!r.timed_out && r.workers.len() == 2);

    // Turning orchestration off detaches the workers.
    let off = m.set_orchestrator(&orch.id, false).await.unwrap();
    assert!(!off.orchestrator);
    assert_eq!(m.get_session(&a.id).unwrap().orchestrator_id, None);
}

#[tokio::test]
async fn aura_messages_wait_until_the_session_is_free() {
    let (m, calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    // Waiting on an approval, it is not free.
    m.send(
        &s.id,
        Input {
            text: "please approve".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingApproval).await;
    assert!(!m.send_when_free(&s.id, "from aura".into()).await.unwrap());
    assert!(!calls.lock().iter().any(|c| c == "send:from aura"));

    m.respond_approval(
        &s.id,
        "ap1",
        ApprovalDecision {
            option: ApprovalOption::Accept,
            updated_input: None,
            message: None,
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    assert!(m.send_when_free(&s.id, "from aura".into()).await.unwrap());
    assert!(calls.lock().iter().any(|c| c == "send:from aura"));
    let mut reply = None;
    for _ in 0..100 {
        reply = m.last_reply(&s.id);
        if reply.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(reply.as_deref(), Some("hello"));
    assert!(m.send_when_free("nope", "x".into()).await.is_err());
}

#[tokio::test]
async fn sent_images_are_kept_and_shown_on_the_user_message() {
    let (m, _calls, _starts, _store) = setup();
    let data = tempfile::tempdir().unwrap();
    m.enable_attachments(data.path().join("attachments"));
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = m.subscribe();
    m.send(
        &s.id,
        Input {
            text: "look at this".into(),
            images: vec![ImageInput {
                data: Some("iVBORw0K".into()),
                media_type: Some("image/png".into()),
                name: Some("shot.png".into()),
                thumbnail: Some("data:image/png;base64,AAAA".into()),
                width: Some(800),
                height: Some(600),
                original_width: Some(4000),
                original_height: Some(3000),
                ..Default::default()
            }],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    let evs = drain(&mut rx).await;
    let user = evs
        .iter()
        .find_map(|e| match e {
            Event::ItemCompleted { item, .. } if item.kind == ItemKind::UserMessage => {
                Some(item.clone())
            }
            _ => None,
        })
        .unwrap();
    let att = &user.data["attachments"][0];
    assert_eq!(att["name"], "shot.png");
    assert_eq!(att["width"], 800);
    assert_eq!(att["original_width"], 4000);
    assert_eq!(att["thumbnail"], "data:image/png;base64,AAAA");
    let id = att["id"].as_str().unwrap();
    assert_eq!(
        m.attachment(&s.id, id).unwrap(),
        ("iVBORw0K".to_string(), "image/png".to_string())
    );
    // Stored history carries them too, and ids cannot leave the directory.
    let hist = m.history(&s.id, 0, 100).unwrap();
    assert!(hist.iter().any(|e| matches!(&e.event, Event::ItemCompleted { item, .. } if item.data["attachments"][0]["id"] == id)));
    assert!(m.attachment(&s.id, "../aura.db").is_err());
    assert!(m.attachment("..", id).is_err());

    // A later message without images gets none.
    m.send(
        &s.id,
        Input {
            text: "look at this".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    let evs = drain(&mut rx).await;
    assert!(evs.iter().any(|e| matches!(e, Event::ItemCompleted { item, .. } if item.kind == ItemKind::UserMessage && item.data.get("attachments").is_none())));

    m.delete(&s.id, false).await.unwrap();
    assert!(!data.path().join("attachments").join(&s.id).exists());
}

#[tokio::test]
async fn terminal_sessions_refuse_images() {
    let (m, _calls, _starts, _store) = setup();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: dir.path().to_string_lossy().to_string(),
            mode: Some(SessionMode::Terminal),
            ..Default::default()
        })
        .await
        .unwrap();
    let input = Input {
        text: "x".into(),
        images: vec![ImageInput {
            data: Some("AA==".into()),
            ..Default::default()
        }],
        ..Default::default()
    };
    assert!(m
        .send(&s.id, input)
        .await
        .unwrap_err()
        .to_string()
        .contains("cannot take images"));
}
