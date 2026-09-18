use aura_core::*;
use aura_rpc::client::RpcClient;
use aura_rpc::server::RpcServer;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// A provider that has no structured mode; only terminal sessions.
struct TerminalOnly;
#[async_trait::async_trait]
impl Provider for TerminalOnly {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Terminal
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Terminal,
            display_name: "Terminal".into(),
            available: true,
            version: None,
            binary: None,
            capabilities: CapabilitySet { terminal_mode: true, ..Default::default() },
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(&self, _s: &Session, _f: bool, _sink: EventSink) -> anyhow::Result<Box<dyn Driver>> {
        anyhow::bail!("no structured mode")
    }
    fn terminal_command(&self, _s: &Session) -> Vec<String> {
        aura_pty::default_shell()
    }
}

#[tokio::test]
async fn terminal_session_roundtrip_over_ws() {
    let dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
    let manager = Manager::new(store, vec![Arc::new(TerminalOnly)], None);
    let server = RpcServer::start(manager.clone(), dir.path(), None).await.unwrap();
    let client = RpcClient::connect(server.info.port, &server.info.token).await.unwrap();

    // bad token is refused
    assert!(RpcClient::connect(server.info.port, "nope").await.is_err());

    let pong: String = client.call_as("daemon.ping", json!({})).await.unwrap();
    assert_eq!(pong, "pong");

    let providers: Vec<ProviderInfo> = client.call_as("provider.list", json!({})).await.unwrap();
    assert_eq!(providers.len(), 1);

    let mut events = client.events();
    let mut pty = client.pty_output();
    let session: Session = client
        .call_as(
            "session.create",
            json!({
                "provider": "terminal",
                "cwd": dir.path().to_string_lossy(),
                "command": ["/bin/sh"],
                "title": "shell"
            }),
        )
        .await
        .unwrap();
    assert_eq!(session.mode, SessionMode::Terminal);
    assert_eq!(session.status, SessionStatus::Running);

    // SessionCreated arrives
    let ev = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap();
    assert!(matches!(ev, Event::SessionCreated { .. }));

    client.call("pty.attach", json!({ "id": session.id })).await.unwrap();
    client.pty_input(&session.id, b"echo marker_$((40+2))\n").await.unwrap();

    let mut out = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.contains("marker_42") && tokio::time::Instant::now() < deadline {
        if let Ok(Ok((sid, data))) = tokio::time::timeout(Duration::from_millis(500), pty.recv()).await {
            assert_eq!(sid, session.id);
            out.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(out.contains("marker_42"), "pty output was {out:?}");

    // scrollback via attach contains the marker too
    let att = client.call("pty.attach", json!({ "id": session.id })).await.unwrap();
    let sb = att["scrollback"].as_str().unwrap();
    assert!(!sb.is_empty());

    // exit the shell -> ProcessExited + status Exited
    client.pty_input(&session.id, b"exit 7\n").await.unwrap();
    let mut exited = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !exited && tokio::time::Instant::now() < deadline {
        if let Ok(Ok(Event::ProcessExited { exit_code, .. })) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            assert_eq!(exit_code, Some(7));
            exited = true;
        }
    }
    assert!(exited);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let s: Session = client.call_as("session.get", json!({ "id": session.id })).await.unwrap();
    assert_eq!(s.status, SessionStatus::Exited);

    // restart and delete
    let s: Session = client.call_as("session.restart", json!({ "id": session.id })).await.unwrap();
    assert_eq!(s.status, SessionStatus::Running);
    client.call("session.delete", json!({ "id": session.id })).await.unwrap();
    let list: Vec<Session> = client.call_as("session.list", json!({})).await.unwrap();
    assert!(list.is_empty());

    // unknown method
    assert!(client.call("nope.nothing", json!({})).await.is_err());

    // fs helpers
    let home: Option<String> = client.call_as("fs.home", json!({})).await.unwrap();
    assert!(home.is_some());
    let _ = server.shutdown.send(());
}
