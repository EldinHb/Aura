//! Who is Aura's window: only a connection that presents the window secret the
//! desktop shell gave the daemon. The Origin header proves nothing.
use aura_core::*;
use aura_rpc::client::RpcClient;
use aura_rpc::server::{ExtCall, ExtHandler, RpcServer};
use serde_json::{json, Value};
use std::sync::Arc;

/// An extension that answers whether the call came from the window.
fn ext() -> ExtHandler {
    Arc::new(|call: ExtCall| {
        Box::pin(async move { Ok((call.method == "test.window").then(|| json!(call.window))) })
    })
}

async fn server(secret: Option<&str>) -> (RpcServer, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let m = Manager::new(Arc::new(MemoryStore::default()), vec![], None);
    let s = RpcServer::start_full(m, dir.path(), Some(ext()), None, secret.map(str::to_string))
        .await
        .unwrap();
    (s, dir)
}

async fn is_window(c: &RpcClient) -> Value {
    c.call("test.window", json!({})).await.unwrap()
}

#[tokio::test]
async fn the_window_is_who_holds_the_secret() {
    let secret = aura_rpc::server::random_secret();
    let (s, _dir) = server(Some(&secret)).await;
    let c = RpcClient::connect(s.info.port, &s.info.token)
        .await
        .unwrap();
    assert_eq!(
        is_window(&c).await,
        json!(false),
        "the user's token alone is not the window"
    );
    assert!(c
        .call("daemon.window_hello", json!({"secret": "0".repeat(64)}))
        .await
        .is_err());
    assert!(c.call("daemon.window_hello", json!({})).await.is_err());
    assert_eq!(is_window(&c).await, json!(false));
    assert_eq!(
        c.call("daemon.window_status", json!({})).await.unwrap(),
        json!({"secretSet": true, "window": false})
    );
    c.call("daemon.window_hello", json!({"secret": secret}))
        .await
        .unwrap();
    assert_eq!(is_window(&c).await, json!(true));
    // Per connection: another one with the same token is not the window.
    let other = RpcClient::connect(s.info.port, &s.info.token)
        .await
        .unwrap();
    assert_eq!(is_window(&other).await, json!(false));
    // The secret is never in daemon.json.
    let info = std::fs::read_to_string(aura_rpc::daemon_info_path(_dir.path())).unwrap();
    assert!(!info.contains(&secret));
}

#[tokio::test]
async fn a_forged_origin_is_not_the_window() {
    // The re-review's case: the user token from daemon.json plus Origin: tauri://localhost.
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let (s, _dir) = server(Some(&aura_rpc::server::random_secret())).await;
    let mut req = format!("ws://127.0.0.1:{}/ws?token={}", s.info.port, s.info.token)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Origin", "tauri://localhost".parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "test.window", "params": {}}).to_string(),
    ))
    .await
    .unwrap();
    loop {
        let Some(Ok(Message::Text(t))) = ws.next().await else {
            panic!("no answer")
        };
        let v: Value = serde_json::from_str(&t).unwrap();
        if v["id"] == json!(1) {
            assert_eq!(v["result"], json!(false), "{v}");
            break;
        }
    }
}

#[tokio::test]
async fn a_daemon_the_app_did_not_start_has_no_window() {
    let (s, _dir) = server(None).await;
    let c = RpcClient::connect(s.info.port, &s.info.token)
        .await
        .unwrap();
    let e = c
        .call("daemon.window_hello", json!({"secret": "x"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(e.contains("not started by the Aura app"), "{e}");
    assert_eq!(
        c.call("daemon.window_status", json!({})).await.unwrap(),
        json!({"secretSet": false, "window": false})
    );
    assert_eq!(is_window(&c).await, json!(false));
}
