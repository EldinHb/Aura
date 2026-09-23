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
}

#[async_trait::async_trait]
impl Driver for FakeDriver {
    async fn send(&self, input: Input) -> anyhow::Result<()> {
        self.calls.lock().push(format!("send:{}", input.text));
        let turn = Turn { id: new_id(), session_id: self.session_id.clone(), status: TurnStatus::Running, started_at: now(), ended_at: None, usage: None, error: None };
        let _ = self.sink.send(Event::TurnStarted { session_id: self.session_id.clone(), turn: turn.clone() });
        let item = Item::new(&self.session_id, Some(turn.id.clone()), ItemKind::AgentMessage);
        let _ = self.sink.send(Event::ItemStarted { session_id: self.session_id.clone(), item: item.clone() });
        let _ = self.sink.send(Event::ItemDelta { session_id: self.session_id.clone(), item_id: item.id.clone(), delta: ItemDelta::Text { text: "hel".into() } });
        let _ = self.sink.send(Event::ItemDelta { session_id: self.session_id.clone(), item_id: item.id.clone(), delta: ItemDelta::Text { text: "lo".into() } });
        if input.text.contains("approve") {
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
            let _ = self.sink.send(Event::ApprovalRequested { session_id: self.session_id.clone(), approval });
        } else {
            let _ = self.sink.send(Event::ItemCompleted { session_id: self.session_id.clone(), item: item.with_text("hello").completed() });
            let _ = self.sink.send(Event::TurnCompleted { session_id: self.session_id.clone(), turn: Turn { status: TurnStatus::Completed, ended_at: Some(now()), usage: Some(Usage { input_tokens: 10, output_tokens: 5, ..Default::default() }), ..turn } });
        }
        Ok(())
    }
    async fn interrupt(&self) -> anyhow::Result<()> {
        self.calls.lock().push("interrupt".into());
        Ok(())
    }
    async fn respond_approval(&self, approval_id: &str, decision: ApprovalDecision) -> anyhow::Result<()> {
        self.calls.lock().push(format!("approve:{approval_id}:{:?}", decision.option));
        let _ = self.sink.send(Event::TurnCompleted {
            session_id: self.session_id.clone(),
            turn: Turn { id: "t".into(), session_id: self.session_id.clone(), status: TurnStatus::Completed, started_at: now(), ended_at: Some(now()), usage: None, error: None },
        });
        Ok(())
    }
    async fn respond_input(&self, _r: UserInputResponse) -> anyhow::Result<()> {
        Ok(())
    }
    async fn set(&self, setting: Setting) -> anyhow::Result<()> {
        self.calls.lock().push(format!("set:{setting:?}"));
        Ok(())
    }
    async fn stop(&self) -> anyhow::Result<()> {
        self.calls.lock().push("stop".into());
        Ok(())
    }
}

struct FakeProvider {
    calls: Calls,
    starts: Starts,
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
            capabilities: CapabilitySet { structured: true, fork: true, terminal_mode: true, ..Default::default() },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(&self, session: &Session, fork: bool, sink: EventSink) -> anyhow::Result<Box<dyn Driver>> {
        self.starts.lock().push((session.native_id.clone(), fork));
        let _ = sink.send(Event::NativeId { session_id: session.id.clone(), native_id: format!("native-{}", if fork { "fork" } else { "1" }) });
        Ok(Box::new(FakeDriver { sink, session_id: session.id.clone(), calls: self.calls.clone() }))
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
    panic!("status never became {want:?}, is {:?}", m.get_session(id).unwrap().status);
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
    let provider = Arc::new(FakeProvider { calls: calls.clone(), starts: starts.clone() });
    let m = Manager::new(store.clone(), vec![provider], None);
    (m, calls, starts, store)
}

#[tokio::test]
async fn structured_session_flow() {
    let (m, calls, starts, _store) = setup();
    let mut rx = m.subscribe();
    let dir = tempfile::tempdir().unwrap();
    let s = m
        .create_session(CreateSessionOpts { provider: ProviderKind::Claude, cwd: dir.path().to_string_lossy().to_string(), initial_prompt: Some("hi".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(s.mode, SessionMode::Structured);
    wait_status(&m, &s.id, SessionStatus::Idle).await;
    let evs = drain(&mut rx).await;
    assert!(evs.iter().any(|e| matches!(e, Event::SessionCreated { .. })));
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
    assert!(hist.iter().any(|e| matches!(e.event, Event::ItemCompleted { .. })));
    assert!(!hist.iter().any(|e| matches!(e.event, Event::ItemDelta { .. })));

    // approval flow
    m.send(&s.id, Input { text: "please approve".into(), ..Default::default() }).await.unwrap();
    wait_status(&m, &s.id, SessionStatus::WaitingApproval).await;
    assert_eq!(m.get_session(&s.id).unwrap().pending_count, 1);
    let (pending, _) = m.pending();
    assert_eq!(pending.len(), 1);
    // history snapshot includes the live (still streaming) item and the pending approval
    let hist = m.history(&s.id, 0, 100).unwrap();
    assert!(hist.iter().any(|e| matches!(&e.event, Event::ItemStarted { item, .. } if item.text == "hello")));
    assert!(hist.iter().any(|e| matches!(e.event, Event::ApprovalRequested { .. })));
    assert!(m.respond_approval(&s.id, "nope", ApprovalDecision { option: ApprovalOption::Accept, updated_input: None, message: None }).await.is_err());
    m.respond_approval(&s.id, "ap1", ApprovalDecision { option: ApprovalOption::Accept, updated_input: None, message: None }).await.unwrap();
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
    m.send(&s.id, Input { text: "again".into(), ..Default::default() }).await.unwrap();
    assert_eq!(starts.lock().len(), 2);
    assert_eq!(starts.lock()[1], (Some("native-1".into()), false));

    // fork
    let f = m.fork(&s.id).await.unwrap();
    assert_ne!(f.id, s.id);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(m.get_session(&f.id).unwrap().native_id.as_deref(), Some("native-fork"));
    assert_eq!(starts.lock()[2], (Some("native-1".into()), true));

    // rename / pin / group / archive / delete
    m.rename(&s.id, "renamed").unwrap();
    m.set_pinned(&s.id, true).unwrap();
    m.set_group(&s.id, Some("g".into())).unwrap();
    let s2 = m.get_session(&s.id).unwrap();
    assert_eq!((s2.title.as_str(), s2.pinned, s2.group.as_deref()), ("renamed", true, Some("g")));
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
        .create_session(CreateSessionOpts { provider: ProviderKind::Claude, cwd: dir.path().to_string_lossy().to_string(), ..Default::default() })
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
        .create_session(CreateSessionOpts { provider: ProviderKind::Claude, cwd: dir.path().to_string_lossy().to_string(), mode: Some(SessionMode::Terminal), command: Some(vec!["/bin/sh".into()]), ..Default::default() })
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
    let m2 = Manager::new(store.clone(), vec![Arc::new(FakeProvider { calls: Default::default(), starts: Default::default() })], None);
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
    assert!(m.create_session(CreateSessionOpts { provider: ProviderKind::Claude, cwd: "/definitely/not/here".into(), ..Default::default() }).await.is_err());
    assert!(m.create_session(CreateSessionOpts { provider: ProviderKind::Codex, cwd: "/tmp".into(), ..Default::default() }).await.is_err());
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
            capabilities: CapabilitySet { structured: true, ..Default::default() },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(&self, session: &Session, _fork: bool, sink: EventSink) -> anyhow::Result<Box<dyn Driver>> {
        Ok(Box::new(FakeDriver { sink, session_id: session.id.clone(), calls: Default::default() }))
    }
    fn terminal_command(&self, _session: &Session) -> Vec<String> {
        vec![]
    }
}

#[tokio::test]
async fn acp_sessions_need_an_agent_and_have_no_terminal_mode() {
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![Arc::new(AcpLike)], None);
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let opts = |agent: Option<&str>, mode: Option<SessionMode>| CreateSessionOpts {
        provider: ProviderKind::Acp,
        agent: agent.map(str::to_string),
        cwd: cwd.clone(),
        mode,
        ..Default::default()
    };
    let err = m.create_session(opts(None, None)).await.unwrap_err().to_string();
    assert!(err.contains("need an agent"), "{err}");
    let err = m.create_session(opts(Some("gemini"), Some(SessionMode::Terminal))).await.unwrap_err().to_string();
    assert!(err.contains("gemini sessions have no terminal mode"), "{err}");

    let s = m.create_session(opts(Some("gemini"), None)).await.unwrap();
    assert_eq!(s.agent.as_deref(), Some("gemini"));
    assert!(s.title.starts_with("gemini · "), "{}", s.title);
}
