//! WebSocket JSON-RPC client used by the CLI and by integration tests.

use crate::*;
use anyhow::{anyhow, bail, Result};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone)]
pub struct RpcClient {
    out: mpsc::Sender<Message>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    next_id: Arc<AtomicU64>,
    events: broadcast::Sender<aura_core::Event>,
    pty: broadcast::Sender<(String, Vec<u8>)>,
    notifications: broadcast::Sender<Notification>,
}

impl RpcClient {
    pub async fn connect(port: u16, token: &str) -> Result<Self> {
        let url = format!("ws://127.0.0.1:{port}/ws?token={token}");
        let (ws, _) = tokio_tungstenite::connect_async(&url).await?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = mpsc::channel::<Message>(1024);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> = Default::default();
        let (events, _) = broadcast::channel(4096);
        let (pty, _) = broadcast::channel(4096);
        let (notifications, _) = broadcast::channel(1024);
        tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        let p2 = pending.clone();
        let ev2 = events.clone();
        let pty2 = pty.clone();
        let n2 = notifications.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                match msg {
                    Message::Text(t) => {
                        let v: Value = match serde_json::from_str(&t) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if v.get("method").is_some() {
                            if let Ok(n) = serde_json::from_value::<Notification>(v) {
                                if n.method == "event" {
                                    if let Ok(ev) = serde_json::from_value::<aura_core::Event>(n.params.clone()) {
                                        let _ = ev2.send(ev);
                                    }
                                }
                                let _ = n2.send(n);
                            }
                        } else if let Ok(r) = serde_json::from_value::<Response>(v) {
                            if let Some(id) = r.id.as_u64() {
                                if let Some(tx) = p2.lock().remove(&id) {
                                    let _ = tx.send(r);
                                }
                            }
                        }
                    }
                    Message::Binary(b) => {
                        if let Some((FRAME_PTY_OUTPUT, sid, data)) = decode_pty_frame(&b) {
                            let _ = pty2.send((sid, data.to_vec()));
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        Ok(Self { out, pending, next_id: Arc::new(AtomicU64::new(1)), events, pty, notifications })
    }

    /// Connect using `<data_dir>/daemon.json`.
    pub async fn connect_from_dir(data_dir: &std::path::Path) -> Result<Self> {
        let info = read_daemon_info(data_dir).ok_or_else(|| anyhow!("daemon not running (no daemon.json)"))?;
        Self::connect(info.port, &info.token).await
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let req = Request { id: Some(Value::from(id)), method: method.into(), params };
        self.out.send(Message::Text(serde_json::to_string(&req)?)).await.map_err(|_| anyhow!("connection closed"))?;
        let resp = tokio::time::timeout(std::time::Duration::from_secs(120), rx)
            .await
            .map_err(|_| anyhow!("rpc timeout for {method}"))?
            .map_err(|_| anyhow!("connection closed"))?;
        if let Some(e) = resp.error {
            bail!("{} ({})", e.message, e.code);
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    pub async fn call_as<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        Ok(serde_json::from_value(self.call(method, params).await?)?)
    }

    pub async fn pty_input(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let frame = encode_pty_frame(FRAME_PTY_INPUT, session_id, data);
        self.out.send(Message::Binary(frame)).await.map_err(|_| anyhow!("connection closed"))
    }

    pub fn events(&self) -> broadcast::Receiver<aura_core::Event> {
        self.events.subscribe()
    }

    pub fn pty_output(&self) -> broadcast::Receiver<(String, Vec<u8>)> {
        self.pty.subscribe()
    }

    pub fn notifications(&self) -> broadcast::Receiver<Notification> {
        self.notifications.subscribe()
    }
}
