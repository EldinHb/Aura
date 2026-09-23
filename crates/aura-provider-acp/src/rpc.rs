//! JSON-RPC 2.0 over newline-delimited JSON on the agent's stdio, as ACP
//! specifies. One connection serves one Aura session, so there is no routing:
//! every agent notification and agent-initiated request goes to a single
//! channel, in the order it was read.
//!
//! Responses resolve the waiting [`Connection::request`] directly. Anything the
//! caller does after a response arrives and then [`Connection::inject`]s is
//! queued behind every message read before that response, which is how the
//! driver keeps "turn ended" after the turn's last `session/update`.

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

/// Pseudo method delivered once the connection closes.
pub const CLOSED: &str = "__closed";

/// JSON-RPC error codes ACP gives a meaning to.
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const AUTH_REQUIRED: i64 = -32000;

/// An agent -> client message: a notification (`id == None`), a request, or a
/// pseudo message injected by the driver (method starting with `__`).
#[derive(Debug, Clone)]
pub struct Incoming {
    pub id: Option<Value>,
    pub method: String,
    pub params: Value,
}

/// A JSON-RPC error returned by the agent. Kept as a type (not just a string)
/// so callers can react to specific codes such as [`AUTH_REQUIRED`].
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)?;
        if let Some(d) = &self.data {
            write!(f, ": {d}")?;
        }
        Ok(())
    }
}

impl std::error::Error for RpcError {}

struct Inner {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>,
    incoming: mpsc::UnboundedSender<Incoming>,
    closed: watch::Sender<bool>,
    closed_rx: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

impl Connection {
    /// Start reading `reader`. Returns the connection and the ordered stream of
    /// everything the agent sends that is not a response.
    pub fn new<R, W>(reader: R, writer: W) -> (Self, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let (closed, closed_rx) = watch::channel(false);
        let inner = Arc::new(Inner {
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            next_id: AtomicI64::new(0),
            pending: Mutex::new(HashMap::new()),
            incoming: tx,
            closed,
            closed_rx,
        });
        tokio::spawn(Self::read_loop(inner.clone(), reader));
        (Self { inner }, rx)
    }

    async fn read_loop<R: AsyncRead + Unpin>(inner: Arc<Inner>, reader: R) {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(msg) => Self::dispatch(&inner, msg),
                        // Agents occasionally log to stdout; that must not end the session.
                        Err(e) => tracing::debug!("acp: non-json line ignored: {e}: {line}"),
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!("acp: read error: {e}");
                    break;
                }
            }
        }
        let _ = inner.closed.send(true);
        for (_, tx) in inner.pending.lock().drain() {
            let _ = tx.send(Err(anyhow!("agent exited")));
        }
        let _ = inner.incoming.send(Incoming { id: None, method: CLOSED.into(), params: Value::Null });
    }

    fn dispatch(inner: &Arc<Inner>, msg: Value) {
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        let id = msg.get("id").cloned().filter(|v| !v.is_null());
        match (method, id) {
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let Some(tx) = inner.pending.lock().remove(&id) else {
                    tracing::debug!("acp: response for unknown id {id}");
                    return;
                };
                let res = match msg.get("error") {
                    Some(err) => Err(anyhow::Error::new(RpcError {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err.get("message").and_then(Value::as_str).unwrap_or("error").to_string(),
                        data: err.get("data").cloned().filter(|d| !d.is_null()),
                    })),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(res);
            }
            (Some(method), id) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let _ = inner.incoming.send(Incoming { id, method, params });
            }
            (None, None) => tracing::debug!("acp: message without id or method ignored"),
        }
    }

    pub fn is_closed(&self) -> bool {
        *self.inner.closed_rx.borrow()
    }

    /// Queue a pseudo message behind everything received so far.
    pub fn inject(&self, method: &str, params: Value) {
        let _ = self.inner.incoming.send(Incoming { id: None, method: method.into(), params });
    }

    async fn write(&self, v: &Value) -> Result<()> {
        if self.is_closed() {
            bail!("agent is not running");
        }
        let mut line = serde_json::to_string(v)?;
        line.push('\n');
        let mut w = self.inner.writer.lock().await;
        w.write_all(line.as_bytes()).await?;
        w.flush().await?;
        Ok(())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write(&msg).await {
            self.inner.pending.lock().remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(res) => res,
            Err(_) => bail!("{method}: connection closed"),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    /// Answer an agent-initiated request.
    pub async fn reply(&self, id: Value, result: Value) -> Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await
    }

    pub async fn reply_error(&self, id: Value, code: i64, message: &str) -> Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).await
    }
}

/// The JSON-RPC error code behind `err`, if it came from the agent.
pub fn error_code(err: &anyhow::Error) -> Option<i64> {
    err.downcast_ref::<RpcError>().map(|e| e.code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn orders_injected_messages_after_earlier_notifications() {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, mut bw) = tokio::io::split(b);
        let (conn, mut rx) = Connection::new(ar, aw);

        let agent = tokio::spawn(async move {
            let mut lines = BufReader::new(br).lines();
            let req: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["jsonrpc"], "2.0");
            assert_eq!(req["method"], "session/prompt");
            let n = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}});
            bw.write_all(format!("{n}\nnot json\n").as_bytes()).await.unwrap();
            let resp = json!({"jsonrpc":"2.0","id":req["id"],"result":{"stopReason":"end_turn"}});
            bw.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
            let err = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required"}});
            let _ = lines.next_line().await.unwrap().unwrap();
            bw.write_all(format!("{err}\n").as_bytes()).await.unwrap();
        });

        let res = conn.request("session/prompt", json!({})).await.unwrap();
        assert_eq!(res["stopReason"], "end_turn");
        conn.inject("__turn_end", json!({}));
        assert_eq!(rx.recv().await.unwrap().method, "session/update");
        assert_eq!(rx.recv().await.unwrap().method, "__turn_end");

        let err = conn.request("session/new", json!({})).await.unwrap_err();
        assert_eq!(error_code(&err), Some(AUTH_REQUIRED));
        agent.await.unwrap();
    }

    #[tokio::test]
    async fn close_fails_pending_requests_and_signals() {
        let (a, b) = tokio::io::duplex(1024);
        let (ar, aw) = tokio::io::split(a);
        let (conn, mut rx) = Connection::new(ar, aw);
        let c2 = conn.clone();
        let pending = tokio::spawn(async move { c2.request("initialize", json!({})).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(b);
        assert!(pending.await.unwrap().is_err());
        assert_eq!(rx.recv().await.unwrap().method, CLOSED);
        assert!(conn.is_closed());
    }
}
