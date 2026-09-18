//! Minimal JSON-RPC 2.0 client over newline-delimited JSON (no `jsonrpc` field,
//! matching `codex app-server`). Requests are correlated by integer id; server
//! notifications and server-initiated requests are routed by `params.threadId`.

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

/// Pseudo method delivered to every route when the connection closes.
pub const CLOSED: &str = "__closed";

/// A server -> client message: a notification (`id == None`) or a request.
#[derive(Debug, Clone)]
pub struct Incoming {
    pub id: Option<Value>,
    pub method: String,
    pub params: Value,
}

struct Inner {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>,
    routes: Mutex<HashMap<String, mpsc::UnboundedSender<Incoming>>>,
    /// Messages not tied to a thread (account, config warnings, ...).
    global: Mutex<Option<mpsc::UnboundedSender<Incoming>>>,
    closed: watch::Sender<bool>,
    closed_rx: watch::Receiver<bool>,
    child: Mutex<Option<tokio::process::Child>>,
}

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// Spawn `codex app-server` and talk to it over stdio.
    pub async fn spawn(binary: &str) -> Result<Self> {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().with_context(|| format!("spawn {binary} app-server"))?;
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = child.stdout.take().context("stdout")?;
        let client = Self::from_io(stdout, stdin);
        *client.inner.child.lock() = Some(child);
        Ok(client)
    }

    /// Build a client on arbitrary streams (tests use an in-memory duplex).
    pub fn from_io<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (closed, closed_rx) = watch::channel(false);
        let inner = Arc::new(Inner {
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            routes: Mutex::new(HashMap::new()),
            global: Mutex::new(None),
            closed,
            closed_rx,
            child: Mutex::new(None),
        });
        let client = Self { inner: inner.clone() };
        tokio::spawn(Self::read_loop(inner, reader));
        client
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
                    let msg: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::debug!("codex: non-json line ignored: {e}: {line}");
                            continue;
                        }
                    };
                    Self::dispatch(&inner, msg).await;
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!("codex app-server read error: {e}");
                    break;
                }
            }
        }
        tracing::info!("codex app-server connection closed");
        let _ = inner.closed.send(true);
        for (_, tx) in inner.pending.lock().drain() {
            let _ = tx.send(Err(anyhow!("codex app-server exited")));
        }
        let routes: Vec<_> = inner.routes.lock().drain().collect();
        for (_, tx) in routes {
            let _ = tx.send(Incoming { id: None, method: CLOSED.into(), params: Value::Null });
        }
        if let Some(tx) = inner.global.lock().as_ref() {
            let _ = tx.send(Incoming { id: None, method: CLOSED.into(), params: Value::Null });
        }
    }

    async fn dispatch(inner: &Arc<Inner>, msg: Value) {
        let method = msg.get("method").and_then(|m| m.as_str()).map(|s| s.to_string());
        let id = msg.get("id").cloned();
        match (method, id) {
            (None, Some(id)) => {
                // Response to one of our requests.
                let Some(id) = id.as_i64() else { return };
                let tx = inner.pending.lock().remove(&id);
                if let Some(tx) = tx {
                    let res = if let Some(err) = msg.get("error") {
                        Err(anyhow!("rpc error: {}", err))
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(res);
                } else {
                    tracing::debug!("codex: response for unknown id {id}");
                }
            }
            (Some(method), id) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let thread_id = thread_id_of(&params);
                let incoming = Incoming { id: id.clone(), method: method.clone(), params };
                let route = thread_id.as_ref().and_then(|t| inner.routes.lock().get(t).cloned());
                if let Some(tx) = route {
                    if tx.send(incoming.clone()).is_ok() {
                        return;
                    }
                }
                if let Some(tx) = inner.global.lock().clone() {
                    if id.is_none() {
                        let _ = tx.send(incoming);
                        return;
                    }
                }
                if let Some(id) = id {
                    // Never leave a server request hanging.
                    tracing::warn!("codex: unrouted server request {method}; answering with a cancel");
                    let result = fallback_reply(&method);
                    let client = Client { inner: inner.clone() };
                    let _ = client.reply(id, result).await;
                } else {
                    tracing::trace!("codex: unrouted notification {method}");
                }
            }
            (None, None) => tracing::debug!("codex: message without id or method ignored"),
        }
    }

    pub fn is_closed(&self) -> bool {
        *self.inner.closed_rx.borrow()
    }

    /// Resolves when the connection closes.
    pub async fn closed(&self) {
        let mut rx = self.inner.closed_rx.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    pub fn register(&self, thread_id: &str) -> mpsc::UnboundedReceiver<Incoming> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.routes.lock().insert(thread_id.to_string(), tx);
        rx
    }

    /// Re-key an existing route (used when the thread id is only known after the response).
    pub fn rekey(&self, from: &str, to: &str) {
        let mut routes = self.inner.routes.lock();
        if let Some(tx) = routes.remove(from) {
            routes.insert(to.to_string(), tx);
        }
    }

    pub fn unregister(&self, thread_id: &str) {
        self.inner.routes.lock().remove(thread_id);
    }

    pub fn set_global(&self) -> mpsc::UnboundedReceiver<Incoming> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.inner.global.lock() = Some(tx);
        rx
    }

    async fn write(&self, v: &Value) -> Result<()> {
        if self.is_closed() {
            bail!("codex app-server is not running");
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
        let msg = json!({ "id": id, "method": method, "params": params });
        if let Err(e) = self.write(&msg).await {
            self.inner.pending.lock().remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(res) => res.with_context(|| format!("{method} failed")),
            Err(_) => bail!("{method}: connection closed"),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(&json!({ "method": method, "params": params })).await
    }

    /// Answer a server-initiated request.
    pub async fn reply(&self, id: Value, result: Value) -> Result<()> {
        self.write(&json!({ "id": id, "result": result })).await
    }

    pub async fn shutdown(&self) {
        let child = self.inner.child.lock().take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
}

/// Thread a message belongs to: `params.threadId`, or `params.thread.id` for
/// thread lifecycle notifications such as `thread/started`.
pub fn thread_id_of(params: &Value) -> Option<String> {
    params
        .get("threadId")
        .and_then(|t| t.as_str())
        .or_else(|| params.get("thread").and_then(|t| t.get("id")).and_then(|t| t.as_str()))
        .map(|s| s.to_string())
}

/// Safe default answer for a server request nobody handles.
pub fn fallback_reply(method: &str) -> Value {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({ "decision": "cancel" }),
        "item/permissions/requestApproval" => json!({ "permissions": {} }),
        "item/tool/requestUserInput" => json!({ "answers": {} }),
        "mcpServer/elicitation/request" => json!({ "action": "cancel" }),
        _ => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn correlates_requests_and_routes_by_thread() {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, mut bw) = tokio::io::split(b);
        let client = Client::from_io(ar, aw);
        let mut rx = client.register("t1");

        // Fake server.
        let server = tokio::spawn(async move {
            let mut lines = BufReader::new(br).lines();
            let l = lines.next_line().await.unwrap().unwrap();
            let req: Value = serde_json::from_str(&l).unwrap();
            assert_eq!(req["method"], "initialize");
            let id = req["id"].clone();
            // Notification, then a server request, then the response (out of order on purpose).
            let n = json!({"method":"turn/started","params":{"threadId":"t1","turn":{"id":"turn1"}}});
            bw.write_all(format!("{n}\n").as_bytes()).await.unwrap();
            let sr = json!({"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t1","command":"ls"}});
            bw.write_all(format!("{sr}\n").as_bytes()).await.unwrap();
            let unrouted = json!({"id":8,"method":"item/tool/requestUserInput","params":{"threadId":"other","questions":[]}});
            bw.write_all(format!("{unrouted}\n").as_bytes()).await.unwrap();
            let resp = json!({"id":id,"result":{"ok":true}});
            bw.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
            // Expect the client's reply to request 7 and the fallback reply to 8 (any order).
            let mut got = vec![];
            for _ in 0..2 {
                let l = lines.next_line().await.unwrap().unwrap();
                got.push(serde_json::from_str::<Value>(&l).unwrap());
            }
            got
        });

        let res = client.request("initialize", json!({})).await.unwrap();
        assert_eq!(res["ok"], true);
        let n = rx.recv().await.unwrap();
        assert_eq!(n.method, "turn/started");
        assert!(n.id.is_none());
        let sr = rx.recv().await.unwrap();
        assert_eq!(sr.method, "item/commandExecution/requestApproval");
        assert_eq!(sr.id, Some(json!(7)));
        client.reply(json!(7), json!({"decision":"accept"})).await.unwrap();

        let got = server.await.unwrap();
        let by_id = |id: i64| got.iter().find(|m| m["id"] == json!(id)).cloned().unwrap();
        assert_eq!(by_id(7)["result"]["decision"], "accept");
        assert_eq!(by_id(8)["result"]["answers"], json!({}));
    }

    #[tokio::test]
    async fn close_fails_pending_and_notifies_routes() {
        let (a, b) = tokio::io::duplex(1024);
        let (ar, aw) = tokio::io::split(a);
        let client = Client::from_io(ar, aw);
        let mut rx = client.register("t1");
        let c2 = client.clone();
        let pending = tokio::spawn(async move { c2.request("thread/start", json!({})).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(b);
        assert!(pending.await.unwrap().is_err());
        let m = rx.recv().await.unwrap();
        assert_eq!(m.method, CLOSED);
        assert!(client.is_closed());
    }
}
