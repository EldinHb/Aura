//! Remote access over the wire: a TLS WebSocket client that pins the
//! certificate's fingerprint pairs, authenticates and calls methods, as the
//! Android app does. Every daemon here uses a temporary data directory.

use anyhow::Result;
use aura_core::*;
use aura_rpc::client::RpcClient;
use aura_rpc::server::RpcServer;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// A structured agent that does nothing, so sessions can be created.

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
// The client side.

/// Accepts exactly the certificate whose SHA-256 is `fp`, whatever its name.
#[derive(Debug)]
struct Pinned {
    fp: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use sha2::Digest;
        let got: String = sha2::Sha256::digest(end_entity.as_ref())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if got == self.fp {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "fingerprint {got} is not the pinned one"
            )))
        }
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

struct Remote {
    ws: Ws,
    next: u64,
}

async fn try_connect(port: u16, fp: &str) -> Result<Remote> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            fp: fp.to_string(),
            provider,
        }))
        .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(rustls::pki_types::ServerName::try_from("aura.local")?, tcp)
        .await?;
    let (ws, _) = tokio_tungstenite::client_async(format!("wss://127.0.0.1:{port}/"), tls).await?;
    Ok(Remote { ws, next: 1 })
}

async fn connect(port: u16, fp: &str) -> Remote {
    try_connect(port, fp).await.expect("remote connection")
}

impl Remote {
    /// The full response to a call; notifications on the way are skipped.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.ws
            .send(Message::Text(
                json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
            ))
            .await
            .unwrap();
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), self.ws.next())
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

    async fn ok(&mut self, method: &str, params: Value) -> Value {
        let v = self.call(method, params).await;
        assert!(v.get("error").is_none(), "{method}: {v}");
        v["result"].clone()
    }

    async fn err(&mut self, method: &str, params: Value) -> i64 {
        let v = self.call(method, params).await;
        v["error"]["code"]
            .as_i64()
            .unwrap_or_else(|| panic!("{method} should fail: {v}"))
    }

    /// The server closes the connection soon.
    async fn closed(&mut self) {
        let end = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match self.ws.next().await {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(end.is_ok(), "the server should close the connection");
    }
}

// ---------------------------------------------------------------------------
// The daemon side.

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Daemon {
    server: RpcServer,
    local: RpcClient,
    manager: Manager,
}

async fn daemon(dir: &std::path::Path) -> Daemon {
    let manager = Manager::new(Arc::new(MemoryStore::default()), vec![Arc::new(Fake)], None);
    let server = RpcServer::start(manager.clone(), dir, None).await.unwrap();
    let local = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    Daemon {
        server,
        local,
        manager,
    }
}

/// Remote access on, on loopback at a free port. Returns (port, fingerprint).
async fn enable(d: &Daemon) -> (u16, String) {
    let port = free_port();
    let status = d
        .local
        .call(
            "remote.configure",
            json!({"enabled": true, "bindAddress": "127.0.0.1", "port": port}),
        )
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(true), "{status}");
    (port, status["fingerprint"].as_str().unwrap().to_string())
}

async fn pair(d: &Daemon, port: u16, fp: &str) -> (Remote, String, String) {
    let pairing = d
        .local
        .call("remote.startPairing", json!({}))
        .await
        .unwrap();
    let code = pairing["code"].as_str().unwrap().to_lowercase();
    let mut r = connect(port, fp).await;
    let paired = r
        .ok("remote.pair", json!({"code": code, "deviceName": "Pixel"}))
        .await;
    (
        r,
        paired["deviceId"].as_str().unwrap().to_string(),
        paired["token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn pair_then_auth_then_list_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;

    // Off by default; no certificate yet.
    let status = d.local.call("remote.status", json!({})).await.unwrap();
    assert_eq!(status["enabled"], json!(false));
    assert_eq!(status["listening"], json!(false));
    assert_eq!(status["fingerprint"], Value::Null);
    assert_eq!(status["port"], json!(7443));
    assert_eq!(status["bindAddress"], json!("0.0.0.0"));
    assert!(
        d.local
            .call("remote.startPairing", json!({}))
            .await
            .is_err(),
        "needs remote access on"
    );

    let (port, fp) = enable(&d).await;
    assert_eq!(fp.len(), 64);
    let pairing = d
        .local
        .call("remote.startPairing", json!({}))
        .await
        .unwrap();
    let code = pairing["code"].as_str().unwrap();
    assert_eq!(code.len(), 8);
    assert_eq!(pairing["fingerprint"], json!(fp));
    assert_eq!(pairing["addresses"], json!(["127.0.0.1"]));
    let uri = pairing["uri"].as_str().unwrap();
    assert!(
        uri.starts_with(&format!(
            "aura://pair?host=127.0.0.1&port={port}&fp={fp}&code={code}&name="
        )),
        "{uri}"
    );
    // Bound to one address, there is nothing to fall back to.
    assert!(!uri.contains("alt="), "{uri}");

    // A wrong fingerprint is refused by the client.
    assert!(try_connect(port, &"0".repeat(64)).await.is_err());

    // Before authentication, nothing else works, and the connection closes.
    let mut r = connect(port, &fp).await;
    assert_eq!(
        r.err("session.list", json!({})).await,
        aura_rpc::ERR_NOT_AUTHENTICATED
    );
    r.closed().await;

    // Pair: lower case and a dash are fine. A long name is cut to 64.
    let mut r = connect(port, &fp).await;
    let spaced = format!("{}-{}", &code[..4].to_lowercase(), &code[4..]);
    let paired = r
        .ok(
            "remote.pair",
            json!({"code": spaced, "deviceName": "x".repeat(100)}),
        )
        .await;
    let device = paired["deviceId"].as_str().unwrap().to_string();
    let token = paired["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    assert_eq!(paired["serverId"], status["serverId"]);
    assert_eq!(paired["version"], json!(env!("CARGO_PKG_VERSION")));
    // The pairing connection is authenticated.
    assert_eq!(r.ok("daemon.ping", json!({})).await, json!("pong"));
    drop(r);

    let devices = d.local.call("remote.listDevices", json!({})).await.unwrap();
    assert_eq!(devices.as_array().unwrap().len(), 1);
    assert_eq!(devices[0]["name"].as_str().unwrap().chars().count(), 64);
    assert_eq!(devices[0]["lastAddress"], json!("127.0.0.1"));

    // The code worked once.
    let mut r = connect(port, &fp).await;
    assert_eq!(
        r.err("remote.pair", json!({"code": code, "deviceName": "Other"}))
            .await,
        aura_rpc::ERR_PAIR_CODE
    );
    r.closed().await;

    // Auth on a new connection, then the methods a phone needs.
    let project = tempfile::tempdir().unwrap();
    let local_session: Session = d
        .local
        .call_as(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    let mut r = connect(port, &fp).await;
    let authed = r
        .ok("remote.auth", json!({"deviceId": device, "token": token}))
        .await;
    assert_eq!(authed["serverId"], status["serverId"]);
    let sessions: Vec<Session> =
        serde_json::from_value(r.ok("session.list", json!({})).await).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, local_session.id);
    r.ok("session.get", json!({"id": local_session.id})).await;
    r.ok("session.history", json!({"id": local_session.id}))
        .await;
    r.ok("session.pending", json!({})).await;
    r.ok("provider.list", json!({})).await;
    let projects = r.ok("orchestrator.projects", json!({})).await;
    assert_eq!(projects.as_array().unwrap().len(), 1, "{projects}");

    // daemon.info leaves out the loopback token.
    let info = r.ok("daemon.info", json!({})).await;
    assert!(
        info.get("token").is_none() && info.get("data_dir").is_none(),
        "{info}"
    );
    assert_eq!(info["version"], json!(env!("CARGO_PKG_VERSION")));

    // A session in a known project; with a live event for it.
    let project_dir = projects[0]["path"].as_str().unwrap().to_string();
    let created = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": project_dir, "title": "from the phone"}),
        )
        .await;
    assert_eq!(created["title"], json!("from the phone"));
    let created_id = created["id"].as_str().unwrap().to_string();
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Text(t))) = r.ws.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["method"] == json!("event")
                    && v["params"]["type"] == json!("session_created")
                    && v["params"]["session"]["id"] == json!(created_id)
                {
                    return v;
                }
            }
        }
    })
    .await;
    assert!(event.is_ok(), "the remote client gets events");
    r.ok(
        "session.send",
        json!({"id": created_id, "input": {"text": "hello"}}),
    )
    .await;
    r.ok("session.mark_seen", json!({"id": created_id})).await;
    r.ok("session.interrupt", json!({"id": created_id})).await;
    r.ok("session.stop", json!({"id": created_id})).await;
    assert_eq!(d.manager.list_sessions().len(), 2);

    // Outside known projects, terminals and extra options are refused.
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": outside.path().to_string_lossy()})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": format!("{project_dir}/../..")})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": project_dir, "worktree": {"branch": "../../escape"}})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "terminal", "cwd": project_dir})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": project_dir, "command": ["sh"]})
        )
        .await,
        aura_rpc::ERR_PARAMS
    );

    // Images go by value, never as a path on the daemon's machine.
    assert_eq!(
        r.err(
            "session.send",
            json!({"id": created_id, "input": {"text": "look", "images": [{"path": "/etc/hosts"}]}}),
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );

    // WebSocket pings are answered.
    r.ws.send(Message::Ping(b"hi".to_vec())).await.unwrap();
    let pong = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Pong(p))) = r.ws.next().await {
                return p;
            }
        }
    })
    .await
    .expect("a pong");
    assert_eq!(pong, b"hi");
}

#[tokio::test]
async fn forbidden_methods_on_the_remote_listener() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;
    for method in [
        "daemon.shutdown",
        "daemon.window_hello",
        "settings.get",
        "settings.set",
        "fs.list_dir",
        "fs.read_image",
        "fs.home",
        "pty.attach",
        "pty.input",
        "session.delete",
        "session.delete_many",
        "session.set_system_prompt",
        "workspace.delete",
        "workspace.touch",
        "mods.list",
        "git.status",
        "remote.status",
        "remote.configure",
        "remote.startPairing",
        "remote.listDevices",
        "remote.revokeDevice",
        "remote.pair",
        "remote.auth",
        "orchestrator.start",
        "update.check",
    ] {
        assert_eq!(
            r.err(method, json!({})).await,
            aura_rpc::ERR_FORBIDDEN,
            "{method}"
        );
    }
    // Still connected and working after refusals.
    assert_eq!(r.ok("daemon.ping", json!({})).await, json!("pong"));
    // The daemon is still up.
    assert_eq!(
        d.local.call("daemon.ping", json!({})).await.unwrap(),
        json!("pong")
    );

    // And the other way round: pair/auth are not for the loopback listener.
    let e = d
        .local
        .call("remote.auth", json!({"deviceId": "x", "token": "y"}))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("remote listener"), "{e}");
}

#[tokio::test]
async fn bad_token_and_revoked_device_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    let (mut live, device, token) = pair(&d, port, &fp).await;

    let mut r = connect(port, &fp).await;
    assert_eq!(
        r.err(
            "remote.auth",
            json!({"deviceId": device, "token": "0".repeat(64)})
        )
        .await,
        aura_rpc::ERR_AUTH_FAILED
    );
    r.closed().await;

    // Revoking closes its live connection and refuses its token.
    assert_eq!(live.ok("daemon.ping", json!({})).await, json!("pong"));
    d.local
        .call("remote.revokeDevice", json!({"deviceId": device}))
        .await
        .unwrap();
    live.closed().await;
    let mut r = connect(port, &fp).await;
    assert_eq!(
        r.err("remote.auth", json!({"deviceId": device, "token": token}))
            .await,
        aura_rpc::ERR_AUTH_FAILED
    );
    r.closed().await;
    assert!(d
        .local
        .call("remote.listDevices", json!({}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert!(d
        .local
        .call("remote.revokeDevice", json!({"deviceId": device}))
        .await
        .is_err());
}

#[tokio::test]
async fn failed_attempts_are_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    let pairing = d
        .local
        .call("remote.startPairing", json!({}))
        .await
        .unwrap();
    for _ in 0..5 {
        let mut r = connect(port, &fp).await;
        assert_eq!(
            r.err(
                "remote.pair",
                json!({"code": "AAAAAAAA", "deviceName": "x"})
            )
            .await,
            aura_rpc::ERR_PAIR_CODE
        );
        r.closed().await;
    }
    // Now even the right code is refused, and the connection closed.
    let mut r = connect(port, &fp).await;
    let v = r
        .call(
            "remote.pair",
            json!({"code": pairing["code"], "deviceName": "x"}),
        )
        .await;
    assert_eq!(v["error"]["code"], json!(aura_rpc::ERR_RATE_LIMITED), "{v}");
    assert!(v["error"]["data"]["retryAfterSecs"].as_u64().unwrap() >= 1);
    r.closed().await;
}

#[tokio::test]
async fn config_devices_and_certificate_survive_a_restart_and_apply_live() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    let (_live, device, token) = pair(&d, port, &fp).await;
    let server_id = d.local.call("remote.status", json!({})).await.unwrap()["serverId"].clone();
    #[cfg(unix)]
    for f in ["cert.pem", "key.pem", "config.json", "devices.json"] {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("remote").join(f))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{f}");
    }

    // Moving it to another port drops connections and listens there.
    let port2 = free_port();
    let status = d
        .local
        .call(
            "remote.configure",
            json!({"port": port2, "serverName": "Studio"}),
        )
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(true), "{status}");
    assert_eq!(status["serverName"], json!("Studio"));
    assert!(
        try_connect(port, &fp).await.is_err(),
        "the old port is closed"
    );
    let mut r = connect(port2, &fp).await;
    let authed = r
        .ok("remote.auth", json!({"deviceId": device, "token": token}))
        .await;
    assert_eq!(authed["serverName"], json!("Studio"));
    drop(r);

    // Bad input says what to fix and changes nothing.
    for bad in [
        json!({"bindAddress": "everywhere"}),
        json!({"port": 0}),
        json!({"serverName": "  "}),
        json!({"colour": 1}),
    ] {
        assert!(
            d.local.call("remote.configure", bad.clone()).await.is_err(),
            "{bad}"
        );
    }

    // Restart on the same data directory.
    let _ = d.server.shutdown.send(());
    d.server.wait().await;
    let d = daemon(dir.path()).await;
    let status = d.local.call("remote.status", json!({})).await.unwrap();
    assert_eq!(status["listening"], json!(true), "{status}");
    assert_eq!(status["fingerprint"], json!(fp));
    assert_eq!(status["serverId"], server_id);
    let mut r = connect(port2, &fp).await;
    r.ok("remote.auth", json!({"deviceId": device, "token": token}))
        .await;
    drop(r);

    // Off: the listener goes away.
    let status = d
        .local
        .call("remote.configure", json!({"enabled": false}))
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(false));
    assert!(try_connect(port2, &fp).await.is_err());
}

#[tokio::test]
async fn a_taken_port_shows_as_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let status = d
        .local
        .call(
            "remote.configure",
            json!({"enabled": true, "bindAddress": "127.0.0.1", "port": port}),
        )
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(false));
    assert!(
        status["error"]
            .as_str()
            .unwrap()
            .contains(&port.to_string()),
        "{status}"
    );
    drop(taken);
    // Applying again (any configure) retries.
    let status = d
        .local
        .call("remote.configure", json!({"port": port}))
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(true), "{status}");
}

#[tokio::test]
async fn a_sessions_tools_may_close_remote_access_but_not_open_it() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let project = tempfile::tempdir().unwrap();
    let s: Session = d
        .local
        .call_as(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    let tools = RpcClient::connect(d.server.info.port, &d.manager.session_token(&s.id))
        .await
        .unwrap();
    let forbidden = |r: anyhow::Result<Value>| {
        let e = r.unwrap_err().to_string();
        assert!(e.contains(&aura_rpc::ERR_FORBIDDEN.to_string()), "{e}");
    };
    forbidden(
        tools
            .call("remote.configure", json!({"enabled": true}))
            .await,
    );
    forbidden(tools.call("remote.configure", json!({"port": 9999})).await);
    forbidden(
        tools
            .call("remote.configure", json!({"bindAddress": "0.0.0.0"}))
            .await,
    );
    forbidden(tools.call("remote.startPairing", json!({})).await);
    forbidden(tools.call("remote.listDevices", json!({})).await);

    // The user turns it on and pairs a device; the agent may close it all.
    let (port, fp) = enable(&d).await;
    let (_live, device, _) = pair(&d, port, &fp).await;
    tools
        .call("remote.revokeDevice", json!({"deviceId": device}))
        .await
        .unwrap();
    let status = tools
        .call("remote.configure", json!({"enabled": false}))
        .await
        .unwrap();
    assert_eq!(status["listening"], json!(false));
}

#[tokio::test]
async fn a_large_message_before_authentication_closes_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    let mut r = connect(port, &fp).await;
    let big = json!({"id": 1, "method": "remote.auth", "params": {"deviceId": "x".repeat(70 * 1024), "token": "t"}});
    r.ws.send(Message::Text(big.to_string())).await.unwrap();
    r.closed().await;
    // Not counted as a failed attempt, and small requests still work.
    let (mut r, _, _) = pair(&d, port, &fp).await;
    assert_eq!(r.ok("daemon.ping", json!({})).await, json!("pong"));
}

#[tokio::test]
async fn terminal_sessions_cannot_be_typed_into_remotely() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let project = tempfile::tempdir().unwrap();
    let term: Session = d
        .local
        .call_as(
            "session.create",
            json!({"provider": "claude", "mode": "terminal", "command": ["/bin/cat"], "cwd": project.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    assert_eq!(term.mode, SessionMode::Terminal);
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;
    assert_eq!(
        r.err(
            "session.send",
            json!({"id": term.id, "input": {"text": "echo pwned"}})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err("session.interrupt", json!({"id": term.id})).await,
        aura_rpc::ERR_FORBIDDEN
    );
    // Still listed, and still stoppable.
    let sessions: Vec<Session> =
        serde_json::from_value(r.ok("session.list", json!({})).await).unwrap();
    assert!(sessions.iter().any(|s| s.id == term.id));
    r.ok("session.stop", json!({"id": term.id})).await;
}

#[tokio::test]
async fn workspaces_are_made_renamed_and_filled_remotely_but_not_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let project = tempfile::tempdir().unwrap();
    let lead = d
        .local
        .call(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy(), "orchestrator": true}),
        )
        .await
        .unwrap();
    let worker = d
        .local
        .call(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy(), "orchestrator_id": lead["id"]}),
        )
        .await
        .unwrap();
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;

    let made = r.ok("workspace.create", json!({"name": "Phone"})).await;
    let id = made["id"].as_str().unwrap().to_string();
    assert_eq!(made["name"], json!("Phone"));
    // Names are checked as on the desktop: a duplicate is refused.
    assert_ne!(
        r.err("workspace.create", json!({"name": "phone"})).await,
        aura_rpc::ERR_FORBIDDEN
    );
    let renamed = r
        .ok("workspace.rename", json!({"id": id, "name": "On the go"}))
        .await;
    assert_eq!(renamed["name"], json!("On the go"));

    // A session moves with its workers; a worker alone stays with its orchestrator.
    let moved = r
        .ok(
            "session.set_workspace",
            json!({"id": lead["id"], "workspace": id}),
        )
        .await;
    let moved_ids: Vec<&str> = moved
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert!(moved_ids.contains(&lead["id"].as_str().unwrap()), "{moved}");
    assert!(
        moved_ids.contains(&worker["id"].as_str().unwrap()),
        "{moved}"
    );
    assert_eq!(
        d.manager
            .get_session(worker["id"].as_str().unwrap())
            .unwrap()
            .workspace,
        id
    );
    let other = r.ok("workspace.create", json!({"name": "Elsewhere"})).await;
    assert_ne!(
        r.err(
            "session.set_workspace",
            json!({"id": worker["id"], "workspace": other["id"]})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN,
        "refused by the manager, not the allowlist"
    );
    assert_eq!(
        d.manager
            .get_session(worker["id"].as_str().unwrap())
            .unwrap()
            .workspace,
        id
    );

    // Deleting stays the desktop's.
    assert_eq!(
        r.err("workspace.delete", json!({"id": other["id"]})).await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert!(r
        .ok("workspace.list", json!({}))
        .await
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["id"] == other["id"]));
}

#[tokio::test]
async fn session_create_offers_what_the_desktop_offers_and_still_refuses_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(project.path())
        .unwrap()
        .to_string_lossy()
        .to_string();
    d.local
        .call("session.create", json!({"provider": "claude", "cwd": root}))
        .await
        .unwrap();
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;

    // An agent session with the dialog's options.
    let s = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": root, "title": "Phone", "group": "web",
                   "model": "m", "effort": "high", "permission_mode": "plan", "sandbox_mode": "read-only",
                   "system_prompt": "Be brief.", "mode": "structured", "initial_prompt": "Hi"}),
        )
        .await;
    assert_eq!(s["group"], json!("web"));
    assert_eq!(s["sandbox_mode"], json!("read-only"));
    assert_eq!(s["system_prompt"], json!("Be brief."));
    assert_eq!(s["orchestrator"], json!(false));

    // An orchestrator in a project, and one with no folder of its own.
    let o = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": root, "orchestrator": true}),
        )
        .await;
    assert_eq!(o["orchestrator"], json!(true));
    let folderless = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": "", "orchestrator": true}),
        )
        .await;
    assert_eq!(folderless["folderless"], json!(true), "{folderless}");

    // A feature owner, with its goal and own autonomy.
    let f = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": "", "feature_owner": true, "feature_goal": "Ship it",
                   "autonomy": {"level": "checkpoints", "checkpoints": ["before_delivery"]}}),
        )
        .await;
    assert_eq!(f["feature_owner"], json!(true));
    assert_eq!(
        f["orchestrator"],
        json!(true),
        "a feature owner orchestrates"
    );
    let feature = r.ok("feature.get", json!({"id": f["id"]})).await;
    assert_eq!(feature["goal"], json!("Ship it"));

    // Still refused.
    for (what, params) in [
        (
            "terminal mode",
            json!({"provider": "claude", "cwd": root, "mode": "terminal"}),
        ),
        (
            "a folder outside the projects",
            json!({"provider": "claude", "cwd": outside.path().to_string_lossy()}),
        ),
        (
            "no folder for a plain session",
            json!({"provider": "claude", "cwd": ""}),
        ),
        (
            "a worktree with no folder",
            json!({"provider": "claude", "cwd": "", "orchestrator": true, "worktree": {"branch": "b"}}),
        ),
    ] {
        assert_eq!(
            r.err("session.create", params).await,
            aura_rpc::ERR_FORBIDDEN,
            "{what}"
        );
    }
    for (what, params) in [
        (
            "a custom command",
            json!({"provider": "claude", "cwd": root, "command": ["sh"]}),
        ),
        (
            "a resumed session",
            json!({"provider": "claude", "cwd": root, "resume_native_id": "x"}),
        ),
        (
            "a fork",
            json!({"provider": "claude", "cwd": root, "fork": true}),
        ),
        (
            "a worker of another session",
            json!({"provider": "claude", "cwd": root, "orchestrator_id": o["id"]}),
        ),
        (
            "a custom worktree path",
            json!({"provider": "claude", "cwd": root, "worktree": {"branch": "b", "path": "/tmp/x"}}),
        ),
    ] {
        assert_eq!(
            r.err("session.create", params).await,
            aura_rpc::ERR_PARAMS,
            "{what}"
        );
    }
}

#[tokio::test]
async fn a_sessions_changes_are_readable_in_its_own_folder_only() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let repo = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(repo.path().join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "first"]);
    std::fs::write(repo.path().join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.path().join("new.txt"), "hello\n").unwrap();
    let s = d
        .local
        .call(
            "session.create",
            json!({"provider": "claude", "cwd": repo.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;
    let id = s["id"].clone();

    let status = r.ok("session.git_status", json!({"id": id})).await;
    assert_eq!(status["truncated"], json!(false), "{status}");
    let paths: Vec<&str> = status["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(
        paths.contains(&"a.txt") && paths.contains(&"new.txt"),
        "{status}"
    );
    let stat = r.ok("session.git_diff_stat", json!({"id": id})).await;
    assert!(
        stat["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "a.txt" && f["added"] == 1),
        "{stat}"
    );
    let diff = r.ok("session.git_diff", json!({"id": id})).await;
    let diff = diff.as_str().unwrap();
    assert!(diff.contains("+two") && diff.contains("+hello"), "{diff}");
    let one = r
        .ok("session.git_diff", json!({"id": id, "path": "a.txt"}))
        .await;
    assert!(!one.as_str().unwrap().contains("hello"));

    // Never another folder, an option, or a write.
    for (what, params) in [
        (
            "a path outside the folder",
            json!({"id": id, "path": "../etc/passwd"}),
        ),
        ("an absolute path", json!({"id": id, "path": "/etc/passwd"})),
        ("pathspec magic", json!({"id": id, "path": ":(top)a.txt"})),
        (
            "an option for a base",
            json!({"id": id, "base": "--output=/tmp/x"}),
        ),
        (
            "a range for a base",
            json!({"id": id, "base": "main..HEAD"}),
        ),
    ] {
        assert_eq!(
            r.err("session.git_diff", params).await,
            aura_rpc::ERR_FORBIDDEN,
            "{what}"
        );
    }
    assert_eq!(
        r.err("session.git_diff", json!({"id": id, "cwd": "/"}))
            .await,
        aura_rpc::ERR_PARAMS,
        "no folder of the device's choosing"
    );
    for method in ["git.status", "git.diff", "git.commit", "git.push"] {
        assert_eq!(
            r.err(method, json!({"cwd": repo.path().to_string_lossy()}))
                .await,
            aura_rpc::ERR_FORBIDDEN,
            "{method}"
        );
    }
}

#[tokio::test]
async fn session_create_resolves_symlinks_before_checking_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(project.path().join("sub")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), project.path().join("escape")).unwrap();
    d.local
        .call(
            "session.create",
            json!({"provider": "claude", "cwd": project.path().to_string_lossy()}),
        )
        .await
        .unwrap();
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;
    let root = project.path().to_string_lossy().to_string();

    #[cfg(unix)]
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": format!("{root}/escape")})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN,
        "a symlink out of the project"
    );
    assert_eq!(
        r.err(
            "session.create",
            json!({"provider": "claude", "cwd": format!("{root}/missing")})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN,
        "a folder that does not exist"
    );
    // Inside: it runs in the resolved folder.
    let created = r
        .ok(
            "session.create",
            json!({"provider": "claude", "cwd": format!("{root}/sub/../sub")}),
        )
        .await;
    let real = std::fs::canonicalize(project.path().join("sub")).unwrap();
    assert_eq!(created["cwd"], json!(real.to_string_lossy()));
}

#[tokio::test]
async fn slow_or_idle_connections_are_dropped_and_capped() {
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let (port, fp) = enable(&d).await;
    d.server
        .remote
        .set_connection_limits(Duration::from_millis(500), 3);

    // Paired before the others: an authenticated connection holds no place
    // and outlives the deadline.
    let (mut authed, _, _) = pair(&d, port, &fp).await;

    // Gone at the deadline: no TLS at all, TLS but no upgrade, upgraded but
    // never authenticated.
    let mut raw = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(3), raw.read(&mut buf))
        .await
        .expect("closed by the deadline");
    assert!(matches!(n, Ok(0) | Err(_)), "{n:?}");
    let mut idle_ws = connect(port, &fp).await;
    idle_ws.closed().await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(authed.ok("daemon.ping", json!({})).await, json!("pong"));

    // At most 3 still authenticating: the 4th is refused at once.
    let mut held = vec![];
    for _ in 0..3 {
        held.push(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap(),
        );
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(try_connect(port, &fp).await.is_err(), "over the cap");
    // Their places free up when they go (here: at the deadline).
    drop(held);
    tokio::time::sleep(Duration::from_millis(700)).await;
    let (mut again, _, _) = pair(&d, port, &fp).await;
    assert_eq!(again.ok("daemon.ping", json!({})).await, json!("pong"));
}

#[tokio::test]
async fn a_remote_diff_runs_nothing_the_repository_configures_and_stays_in_the_session_folder() {
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(dir.path()).await;
    let tmp = tempfile::tempdir().unwrap();
    let repo = std::fs::canonicalize(tmp.path()).unwrap().join("repo");
    let markers = std::fs::canonicalize(tmp.path()).unwrap().join("markers");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    std::fs::create_dir_all(&markers).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("sub/a.txt"), "one\n").unwrap();
    std::fs::write(repo.join("outside.txt"), "root\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "first"]);
    let m = markers.display();
    git(&[
        "config",
        "core.fsmonitor",
        &format!("touch {m}/fsmonitor; false"),
    ]);
    git(&[
        "config",
        "filter.evil.clean",
        &format!("touch {m}/clean; cat"),
    ]);
    git(&[
        "config",
        "filter.evil.process",
        &format!("touch {m}/process"),
    ]);
    git(&["config", "diff.external", &format!("touch {m}/external")]);
    git(&[
        "config",
        "diff.evil.textconv",
        &format!("touch {m}/textconv; cat"),
    ]);
    std::fs::write(repo.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
    std::fs::write(repo.join("sub/a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("outside.txt"), "root changed\n").unwrap();

    let s = d
        .local
        .call(
            "session.create",
            json!({"provider": "claude", "cwd": repo.join("sub").to_string_lossy()}),
        )
        .await
        .unwrap();
    let (port, fp) = enable(&d).await;
    let (mut r, _, _) = pair(&d, port, &fp).await;
    let id = s["id"].clone();
    let status = r.ok("session.git_status", json!({"id": id})).await;
    let stat = r.ok("session.git_diff_stat", json!({"id": id})).await;
    let diff = r.ok("session.git_diff", json!({"id": id})).await;
    let diff = diff.as_str().unwrap();
    assert!(
        diff.contains("diff --git a/a.txt b/a.txt") && diff.contains("+two"),
        "{diff}"
    );
    for text in [status.to_string(), stat.to_string(), diff.to_string()] {
        assert!(
            !text.contains("outside") && !text.contains("root"),
            "{text}"
        );
    }
    assert_eq!(
        r.err(
            "session.git_diff",
            json!({"id": id, "path": "../outside.txt"})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    assert_eq!(
        r.err(
            "session.git_diff",
            json!({"id": id, "path": ":(top)outside.txt"})
        )
        .await,
        aura_rpc::ERR_FORBIDDEN
    );
    let ran: Vec<_> = std::fs::read_dir(&markers).unwrap().collect();
    assert!(ran.is_empty(), "the repository's commands ran: {ran:?}");
}
