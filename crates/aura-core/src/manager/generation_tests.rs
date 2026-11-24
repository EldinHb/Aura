//! An event of a driver the session has moved on from never lands on the
//! driver after it, however late it is applied.

use super::*;

struct Quiet;

#[async_trait::async_trait]
impl Driver for Quiet {
    async fn send(&self, _: Input) -> Result<()> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<()> {
        Ok(())
    }
    async fn respond_approval(&self, _: &str, _: ApprovalDecision) -> Result<()> {
        Ok(())
    }
    async fn respond_input(&self, _: UserInputResponse) -> Result<()> {
        Ok(())
    }
    async fn set(&self, _: Setting) -> Result<()> {
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        Ok(())
    }
}

struct Fake;

#[async_trait::async_trait]
impl Provider for Fake {
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
                ..Default::default()
            },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(&self, _: &Session, _: bool, _: EventSink) -> Result<Box<dyn Driver>> {
        Ok(Box::new(Quiet))
    }
    fn terminal_command(&self, _: &Session) -> Vec<String> {
        vec![]
    }
}

async fn session(m: &Manager, dir: &tempfile::TempDir) -> String {
    m.create_session(CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: dir.path().to_string_lossy().into_owned(),
        ..Default::default()
    })
    .await
    .unwrap()
    .id
}

fn generation(m: &Manager, id: &str) -> u64 {
    m.inner.runtimes.lock()[id].generation
}

fn approval_requested(id: &str) -> Event {
    Event::ApprovalRequested {
        session_id: id.into(),
        approval: Approval {
            id: "old".into(),
            session_id: id.into(),
            turn_id: None,
            item_id: None,
            kind: ApprovalKind::Command,
            title: "rm -rf build".into(),
            description: None,
            payload: serde_json::json!({}),
            options: vec![ApprovalOption::Accept],
            created_at: crate::now(),
        },
    }
}

/// Stop the session's agent and start the next with a message.
async fn restart(m: &Manager, id: &str) {
    m.stop(id).await.unwrap();
    m.send(
        id,
        Input {
            text: "go on".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
}

fn assert_clean(m: &Manager, id: &str) {
    let s = m.get_session(id).unwrap();
    assert_eq!(s.pending_count, 0);
    assert_ne!(s.status, SessionStatus::WaitingApproval);
    assert!(m.pending().0.is_empty(), "{:?}", m.pending().0);
}

#[tokio::test]
async fn an_old_drivers_event_applied_after_the_next_driver_started_is_dropped() {
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![Arc::new(Fake)], None);
    let dir = tempfile::tempdir().unwrap();
    let id = session(&m, &dir).await;
    let old = generation(&m, &id);
    // The event passed its check, then waited while the session was stopped
    // and its next agent started; only now is it applied.
    restart(&m, &id).await;
    assert_ne!(generation(&m, &id), old);
    let mut heard = m.subscribe();
    let before = m.get_session(&id).unwrap();
    m.handle_event(approval_requested(&id), Some(old));
    // Nor a turn's end (which tells an orchestrator its worker is done) or usage.
    m.handle_event(
        Event::TurnCompleted {
            session_id: id.clone(),
            turn: Turn {
                id: "t-old".into(),
                session_id: id.clone(),
                status: TurnStatus::Failed,
                started_at: crate::now(),
                ended_at: Some(crate::now()),
                usage: None,
                error: Some("killed".into()),
            },
        },
        Some(old),
    );
    m.handle_event(
        Event::Usage {
            session_id: id.clone(),
            usage: Usage {
                input_tokens: 99,
                ..Default::default()
            },
        },
        Some(old),
    );
    assert_clean(&m, &id);
    let after = m.get_session(&id).unwrap();
    assert_eq!(after.usage, before.usage);
    assert_eq!(after.last_error, before.last_error);
    assert_eq!(after.attention, before.attention);
    assert!(heard.try_recv().is_err(), "nothing announced");
    let kept = m.history(&id, 0, 1000).unwrap();
    assert!(
        !kept
            .iter()
            .any(|e| matches!(e.event, Event::ApprovalRequested { .. })),
        "not stored either"
    );
}

#[tokio::test]
async fn what_an_old_drivers_event_left_after_its_stop_is_not_the_next_drivers() {
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![Arc::new(Fake)], None);
    let dir = tempfile::tempdir().unwrap();
    let id = session(&m, &dir).await;
    let old = generation(&m, &id);
    m.stop(&id).await.unwrap();
    // The stopped agent's last event comes in after its stop: still its own.
    m.handle_event(approval_requested(&id), Some(old));
    assert_eq!(m.get_session(&id).unwrap().pending_count, 1);
    // The next agent starts without it.
    m.send(
        &id,
        Input {
            text: "go on".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_clean(&m, &id);
}
