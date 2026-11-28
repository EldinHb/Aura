//! The desktop's bridge to another Aura installation, end to end: a real
//! daemon (in process, on a temporary data directory, remote access enabled
//! on loopback the way aura-rpc's wire tests do), paired through the hub, and
//! reached the way the webview reaches it: a plain WebSocket to 127.0.0.1.

use anyhow::Result;
use aura_core::*;
use aura_remote_client::{HubConfig, LinkState, MemorySecrets, PairRequest, RemoteHub, Secrets};
use aura_rpc::client::RpcClient;
use aura_rpc::server::RpcServer;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// A provider whose sessions do nothing, so sessions can be created.

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
        vec!["true".into()]
    }
}

// ---------------------------------------------------------------------------
// The remote computer.

struct Daemon {
    server: RpcServer,
    local: RpcClient,
}

async fn daemon(dir: &Path) -> Daemon {
    let manager = Manager::new(Arc::new(MemoryStore::default()), vec![Arc::new(Fake)], None);
    let server = RpcServer::start(manager, dir, None).await.unwrap();
    let local = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    Daemon { server, local }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Remote access on, on loopback. Returns (port, fingerprint).
async fn enable(d: &Daemon, port: u16) -> (u16, String) {
    let status = d
        .local
        .call(
            "remote.configure",
            json!({"enabled": true, "bindAddress": "127.0.0.1", "port": port, "serverName": "Home server"}),
        )
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(true), "{status}");
    (port, status["fingerprint"].as_str().unwrap().to_string())
}

async fn pair_request(d: &Daemon) -> PairRequest {
    let p = d
        .local
        .call("remote.startPairing", json!({}))
        .await
        .unwrap();
    PairRequest {
        host: "127.0.0.1".into(),
        port: p["uri"]
            .as_str()
            .and_then(|u| u.split("port=").nth(1))
            .and_then(|r| r.split('&').next())
            .unwrap()
            .parse()
            .unwrap(),
        fingerprint: p["fingerprint"].as_str().unwrap().into(),
        code: p["code"].as_str().unwrap().into(),
        alt: vec![],
        replaces: None,
    }
}

// ---------------------------------------------------------------------------
// The webview's side: a plain WebSocket to the bridge.

type Local =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open(hub: &RemoteHub, id: &str) -> Result<Local> {
    let b = hub.bridge(id)?;
    let (ws, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/ws?token={}", b.port, b.token))
            .await?;
    Ok(ws)
}

async fn call(ws: &mut Local, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::Text(
        json!({"id": id, "method": method, "params": params}).to_string(),
    ))
    .await
    .unwrap();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("an answer in time")
            .expect("the connection to stay open")
            .unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v.get("id") == Some(&json!(id)) {
                return v;
            }
        }
    }
}

async fn closed(ws: &mut Local) {
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(end.is_ok(), "the bridge should close the connection");
}

fn state(hub: &RemoteHub, id: &str) -> LinkState {
    hub.list()
        .into_iter()
        .find(|v| v.entry.id == id)
        .expect("the remote is listed")
        .state
}

async fn wait_for(hub: &RemoteHub, id: &str, pred: impl Fn(&LinkState) -> bool) -> LinkState {
    let mut changes = hub.subscribe();
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let s = state(hub, id);
            if pred(&s) {
                return s;
            }
            changes.changed().await.unwrap();
        }
    })
    .await;
    end.unwrap_or_else(|_| panic!("state never matched; last {:?}", state(hub, id)))
}

async fn hub(dir: &Path, secrets: Arc<MemorySecrets>) -> RemoteHub {
    RemoteHub::start(HubConfig {
        registry_path: dir.join("remotes.json"),
        secrets,
        device_name: "Test Mac".into(),
    })
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn pair_then_use_the_remote_through_the_bridge() {
    let remote_dir = tempfile::tempdir().unwrap();
    let desk_dir = tempfile::tempdir().unwrap();
    let d = daemon(remote_dir.path()).await;
    enable(&d, free_port()).await;
    let secrets = Arc::new(MemorySecrets::default());
    let hub = hub(desk_dir.path(), secrets.clone()).await;

    // A wrong code says so, and pairs nothing.
    let mut bad = pair_request(&d).await;
    bad.code = "AAAAAAAA".into();
    let err = hub.pair(bad).await.unwrap_err();
    assert!(err.contains("pairing code"), "{err}");
    assert!(hub.list().is_empty());

    // A wrong fingerprint: nothing is sent, the real one is named.
    let req = pair_request(&d).await;
    let mut wrong = req.clone();
    wrong.fingerprint = "0".repeat(64);
    let err = hub.pair(wrong).await.unwrap_err();
    assert!(err.contains(&req.fingerprint), "{err}");
    assert!(hub.list().is_empty());

    // Pair: the token goes to the secret store, never the file.
    let view = hub.pair(req.clone()).await.unwrap();
    let id = view.entry.id.clone();
    assert_eq!(view.name, "Home server");
    assert_eq!(view.state, LinkState::Idle);
    let token = secrets.get(&id).unwrap().expect("a token in the keychain");
    let file = std::fs::read_to_string(desk_dir.path().join("remotes.json")).unwrap();
    assert!(!file.contains(&token), "{file}");
    let devices = d.local.call("remote.listDevices", json!({})).await.unwrap();
    assert_eq!(devices[0]["name"], json!("Test Mac"));

    // A wrong bridge secret gets nothing.
    let b = hub.bridge(&id).unwrap();
    assert!(tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/ws?token={}",
        b.port,
        "f".repeat(64)
    ))
    .await
    .is_err());

    // Through the bridge: the remote's sessions, and its live events.
    let mut ws = open(&hub, &id).await.unwrap();
    assert!(matches!(
        state(&hub, &id),
        LinkState::Online { ref server_name, .. } if server_name == "Home server"
    ));
    let listed = call(&mut ws, 1, "session.list", json!({})).await;
    assert_eq!(listed["result"], json!([]), "{listed}");
    let project = tempfile::tempdir().unwrap();
    let created: Session = d
        .local
        .call_as(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["method"] == json!("event") && v["params"]["type"] == json!("session_created")
                {
                    return v;
                }
            }
        }
    })
    .await
    .expect("the event came through the bridge");
    assert_eq!(event["params"]["session"]["id"], json!(created.id));
    // The remote's own rules still hold: no settings, no terminals.
    let refused = call(&mut ws, 2, "settings.get", json!({"key": "x"})).await;
    assert_eq!(refused["error"]["code"], json!(-32003), "{refused}");

    // A second window: its own connection, the same state.
    let mut ws2 = open(&hub, &id).await.unwrap();
    assert_eq!(
        call(&mut ws2, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );
    drop(ws2);
    // Closing one leaves the other online.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(matches!(state(&hub, &id), LinkState::Online { .. }));
    assert_eq!(
        call(&mut ws, 3, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );

    // Closing the last connection: idle, not an error.
    ws.close(None).await.unwrap();
    wait_for(&hub, &id, |s| *s == LinkState::Idle).await;

    // Renamed here; the list and the file say so.
    let renamed = hub.rename(&id, "  Attic  ").unwrap();
    assert_eq!(renamed.name, "Attic");
    assert_eq!(hub.rename(&id, "").unwrap().name, "Home server");

    // A new hub on the same file (an app restart) knows the remote.
    drop(hub);
    let hub = self::hub(desk_dir.path(), secrets.clone()).await;
    assert_eq!(hub.list().len(), 1);
    let mut ws = open(&hub, &id).await.unwrap();
    assert_eq!(
        call(&mut ws, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );

    // Removed: its connections end and its token leaves the keychain.
    hub.remove(&id).await.unwrap();
    closed(&mut ws).await;
    assert!(hub.list().is_empty());
    assert_eq!(secrets.get(&id).unwrap(), None);
    assert!(hub.bridge(&id).is_err());
    drop(d.server);
}

#[tokio::test]
async fn a_revoked_device_stops_and_pairing_again_brings_it_back() {
    let remote_dir = tempfile::tempdir().unwrap();
    let desk_dir = tempfile::tempdir().unwrap();
    let d = daemon(remote_dir.path()).await;
    enable(&d, free_port()).await;
    let hub = hub(desk_dir.path(), Arc::new(MemorySecrets::default())).await;
    let view = hub.pair(pair_request(&d).await).await.unwrap();
    let id = view.entry.id.clone();
    let mut ws = open(&hub, &id).await.unwrap();

    // Removed on the remote: the live connection drops; the next attempt is
    // refused there, and from then on the bridge does not try again.
    d.local
        .call(
            "remote.revokeDevice",
            json!({"deviceId": view.entry.device_id}),
        )
        .await
        .unwrap();
    closed(&mut ws).await;
    wait_for(&hub, &id, |s| matches!(s, LinkState::Retrying { .. })).await;
    hub.retry(&id);
    assert!(open(&hub, &id).await.is_err());
    let s = wait_for(&hub, &id, |s| matches!(s, LinkState::Revoked { .. })).await;
    let LinkState::Revoked { reason } = s else {
        unreachable!()
    };
    assert!(reason.contains("Pair again"), "{reason}");
    hub.retry(&id);
    assert!(open(&hub, &id).await.is_err());
    assert!(matches!(state(&hub, &id), LinkState::Revoked { .. }));

    // Pairing again (same computer): back in business.
    let mut req = pair_request(&d).await;
    req.replaces = Some(id.clone());
    let again = hub.pair(req).await.unwrap();
    assert_eq!(again.entry.id, id);
    assert_eq!(again.state, LinkState::Idle);
    assert_eq!(hub.list().len(), 1);
    let mut ws = open(&hub, &id).await.unwrap();
    assert_eq!(
        call(&mut ws, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );
}

#[tokio::test]
async fn an_unreachable_remote_backs_off_and_a_changed_certificate_is_never_accepted() {
    let remote_dir = tempfile::tempdir().unwrap();
    let desk_dir = tempfile::tempdir().unwrap();
    let d = daemon(remote_dir.path()).await;
    let (port, fp) = enable(&d, free_port()).await;
    let hub = hub(desk_dir.path(), Arc::new(MemorySecrets::default())).await;
    let id = hub.pair(pair_request(&d).await).await.unwrap().entry.id;
    let mut ws = open(&hub, &id).await.unwrap();

    // The remote goes away: the bridge closes the webview's connection, and
    // backs off rather than trying on every reconnect.
    let _ = d.server.shutdown.send(());
    d.server.wait().await;
    closed(&mut ws).await;
    let s = wait_for(&hub, &id, |s| matches!(s, LinkState::Retrying { .. })).await;
    let LinkState::Retrying { retry_at, .. } = s else {
        unreachable!()
    };
    assert!(retry_at > 0);
    // Within the backoff: refused without trying.
    assert!(open(&hub, &id).await.is_err());
    // Retried now: tried, failed, backing off longer.
    hub.retry(&id);
    assert!(open(&hub, &id).await.is_err());
    let s = wait_for(&hub, &id, |s| matches!(s, LinkState::Retrying { .. })).await;
    let LinkState::Retrying { reason, .. } = s else {
        unreachable!()
    };
    assert!(!reason.is_empty());

    // It comes back on the same port with a new certificate (its data was
    // reset, or someone else answers there): refused, and it stays refused.
    for f in ["cert.pem", "key.pem"] {
        std::fs::remove_file(remote_dir.path().join("remote").join(f)).unwrap();
    }
    let d = daemon(remote_dir.path()).await;
    let status = d.local.call("remote.status", json!({})).await.unwrap();
    assert_eq!(status["port"], json!(port));
    assert_eq!(status["listening"], json!(true), "{status}");
    let new_fp = status["fingerprint"].as_str().unwrap().to_string();
    assert_ne!(new_fp, fp);
    hub.retry(&id);
    assert!(open(&hub, &id).await.is_err());
    let s = wait_for(&hub, &id, |s| matches!(s, LinkState::CertMismatch { .. })).await;
    assert_eq!(
        s,
        LinkState::CertMismatch {
            expected: fp.clone(),
            actual: new_fp.clone()
        }
    );
    hub.retry(&id);
    assert!(open(&hub, &id).await.is_err());
    assert!(matches!(state(&hub, &id), LinkState::CertMismatch { .. }));

    // Only pairing again trusts the new certificate. (The device itself is
    // still known there: only the certificate changed.)
    let view = hub.pair(pair_request(&d).await).await.unwrap();
    assert_eq!(view.entry.fingerprint, new_fp);
    let mut ws = open(&hub, &id).await.unwrap();
    assert_eq!(
        call(&mut ws, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );
}

#[tokio::test]
async fn other_addresses_are_tried_when_the_first_does_not_answer() {
    let remote_dir = tempfile::tempdir().unwrap();
    let desk_dir = tempfile::tempdir().unwrap();
    let d = daemon(remote_dir.path()).await;
    enable(&d, free_port()).await;
    let hub = hub(desk_dir.path(), Arc::new(MemorySecrets::default())).await;
    let mut req = pair_request(&d).await;
    // Nothing answers on ::1 (the daemon is bound to 127.0.0.1 only): refused,
    // or unreachable where there is no IPv6.
    req.alt = vec![req.host.clone()];
    req.host = "::1".into();
    let view = hub.pair(req).await.unwrap();
    // The address that answered goes first from now on.
    assert_eq!(view.entry.host, "127.0.0.1");
    assert_eq!(view.entry.alt, vec!["::1".to_string()]);
    let mut ws = open(&hub, &view.entry.id).await.unwrap();
    assert_eq!(
        call(&mut ws, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );
}

/// A TCP forwarder to `to` on 127.0.0.1 that holds connection number
/// `slow` (1-based) for `delay` before passing it on.
async fn forwarder(to: u16, slow: usize, delay: Duration) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut n = 0;
        while let Ok((mut inbound, _)) = listener.accept().await {
            n += 1;
            let hold = n == slow;
            tokio::spawn(async move {
                if hold {
                    tokio::time::sleep(delay).await;
                }
                if let Ok(mut out) = tokio::net::TcpStream::connect(("127.0.0.1", to)).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn an_attempt_under_way_when_paired_again_is_called_off() {
    let remote_dir = tempfile::tempdir().unwrap();
    let desk_dir = tempfile::tempdir().unwrap();
    let d = daemon(remote_dir.path()).await;
    let (port, _) = enable(&d, free_port()).await;
    // Connection 1 pairs; connection 2 (the webview's) hangs a while; 3 pairs again.
    let via = forwarder(port, 2, Duration::from_secs(2)).await;
    let hub = hub(desk_dir.path(), Arc::new(MemorySecrets::default())).await;
    let mut req = pair_request(&d).await;
    req.port = via;
    let id = hub.pair(req).await.unwrap().entry.id;

    let pending = {
        let hub = hub.clone();
        let id = id.clone();
        tokio::spawn(async move { open(&hub, &id).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(state(&hub, &id), LinkState::Connecting);
    let mut again = pair_request(&d).await;
    again.port = via;
    again.replaces = Some(id.clone());
    hub.pair(again).await.unwrap();

    // The attempt made with the old token is dropped at once, not made usable,
    // and leaves the state as pairing set it.
    let r = tokio::time::timeout(Duration::from_millis(1000), pending)
        .await
        .expect("called off without waiting for the old connection")
        .unwrap();
    assert!(
        r.is_err(),
        "an attempt from before pairing again must not connect"
    );
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(state(&hub, &id), LinkState::Idle);

    // The next one uses the new pairing.
    let mut ws = open(&hub, &id).await.unwrap();
    assert_eq!(
        call(&mut ws, 1, "daemon.ping", json!({})).await["result"],
        json!("pong")
    );
}
