//! One mod's daemon half: a QuickJS runtime on a thread of its own.
//!
//! The thread runs a small event loop. JavaScript reaches the host through two
//! native functions installed before the prelude (prelude.js):
//!
//! * `__aura_sync(op, json) -> json`: answered on the spot ([`Ops::sync_op`]).
//! * `__aura_async(id, op, json)`: the op runs as a future on the daemon's tokio
//!   runtime ([`Ops::async_op`]); its result comes back to this thread as a
//!   [`Msg::Complete`] and is handed to JavaScript as a `complete` dispatch.
//!
//! Everything else the host sends (RPC calls, core events, other mods'
//! notifications, settings changes) arrives the same way, as messages that the
//! loop turns into `__aura_dispatch(kind, json)` calls. After every message the
//! loop runs QuickJS's job queue (promise reactions) until it is empty.
//!
//! A runaway script is stopped by the interrupt handler after [`BUSY_LIMIT`];
//! memory is capped at [`MEMORY_LIMIT`].

use futures::future::BoxFuture;
use parking_lot::Mutex;
use rquickjs::{Context, Ctx, Function, Module, Promise, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
pub const BUSY_LIMIT: Duration = Duration::from_secs(5);
/// How long a stopping mod gets to finish its deactivate function.
const STOP_GRACE: Duration = Duration::from_secs(3);

const PRELUDE: &str = include_str!("prelude.js");

/// An error as mods see it: a stable `code`, a message for people, and
/// optional `data` that survives RPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct ModError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ModError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
        }
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new("permission_denied", message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn failed(e: impl std::fmt::Display) -> Self {
        Self::new("failed", format!("{e:#}"))
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
}

impl From<anyhow::Error> for ModError {
    fn from(e: anyhow::Error) -> Self {
        match e.downcast::<ModError>() {
            Ok(m) => m,
            Err(e) => ModError::failed(e),
        }
    }
}

pub type OpResult = Result<Value, ModError>;

/// What the host does for a mod's ops.
pub trait Ops: Send + Sync + 'static {
    fn sync_op(&self, op: &str, args: Value) -> OpResult;
    fn async_op(&self, op: &str, args: Value) -> BoxFuture<'static, OpResult>;
}

pub enum Msg {
    Call {
        name: String,
        params: Value,
        caller: Value,
        reply: oneshot::Sender<OpResult>,
    },
    Dispatch {
        kind: &'static str,
        payload: Value,
    },
    Complete {
        id: u64,
        result: OpResult,
    },
    Stop(oneshot::Sender<()>),
}

/// A running mod. Dropping it does not stop the thread; call [`ModRuntime::stop`].
#[derive(Clone)]
pub struct ModRuntime {
    tx: mpsc::Sender<Msg>,
}

impl ModRuntime {
    /// Start `source` (an ES module whose default export is `activate(aura)`).
    /// Resolves once `activate` has settled: Ok when it returned, Err with the
    /// exception otherwise (the thread has then ended).
    pub async fn start(
        id: &str,
        source: String,
        ops: Arc<dyn Ops>,
        tokio: tokio::runtime::Handle,
    ) -> Result<ModRuntime, ModError> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), ModError>>();
        let loop_tx = tx.clone();
        let name = id.to_string();
        std::thread::Builder::new()
            .name(format!("mod-{id}"))
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let started = run(&name, source, ops, tokio, loop_tx, rx, ready_tx);
                if let Err(e) = started {
                    tracing::warn!(mod_id = %name, "mod runtime ended: {e}");
                }
            })
            .map_err(|e| ModError::failed(format!("start the mod's thread: {e}")))?;
        match ready_rx.await {
            Ok(Ok(())) => Ok(ModRuntime { tx }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(ModError::failed("the mod stopped while starting")),
        }
    }

    pub fn send(&self, msg: Msg) -> bool {
        self.tx.send(msg).is_ok()
    }

    pub fn alive(&self) -> bool {
        // A dispatch nobody handles is harmless; a closed channel means the thread ended.
        self.tx
            .send(Msg::Dispatch {
                kind: "ping",
                payload: Value::Null,
            })
            .is_ok()
    }

    /// Call `aura.rpc.handle(name)` (or a tool, with name `__tool`).
    pub async fn call(&self, name: &str, params: Value, caller: Value) -> OpResult {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Msg::Call {
                name: name.to_string(),
                params,
                caller,
                reply,
            })
            .is_err()
        {
            return Err(ModError::unavailable("the mod is not running"));
        }
        rx.await
            .unwrap_or_else(|_| Err(ModError::unavailable("the mod stopped before answering")))
    }

    pub fn dispatch(&self, kind: &'static str, payload: Value) {
        let _ = self.tx.send(Msg::Dispatch { kind, payload });
    }

    /// Run the mod's deactivate function (bounded by a grace period) and end the thread.
    pub async fn stop(&self) {
        let (ack, rx) = oneshot::channel();
        if self.tx.send(Msg::Stop(ack)).is_ok() {
            let _ = tokio::time::timeout(STOP_GRACE + Duration::from_secs(1), rx).await;
        }
    }
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    ok: bool,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    error: Option<ModError>,
}

/// Turn the pending exception into a ModError (message plus stack when there is one).
fn exception(ctx: &Ctx<'_>, e: rquickjs::Error) -> ModError {
    if !matches!(e, rquickjs::Error::Exception) {
        return ModError::failed(e);
    }
    let v = ctx.catch();
    if let Some(obj) = v.as_object() {
        let message: Option<String> = obj.get("message").ok();
        let stack: Option<String> = obj.get("stack").ok();
        let code: Option<String> = obj.get("code").ok();
        let mut text = message.unwrap_or_else(|| "uncaught exception".into());
        if let Some(stack) = stack.filter(|s| !s.is_empty()) {
            text = format!("{text}\n{stack}");
        }
        return ModError::new(code.as_deref().unwrap_or("failed"), text);
    }
    if let Some(s) = v.as_string().and_then(|s| s.to_string().ok()) {
        return ModError::failed(s);
    }
    if v.is_null() || v.is_undefined() {
        // An uncatchable interrupt leaves no value.
        return ModError::new("timeout", "the mod ran too long and was interrupted");
    }
    ModError::failed(format!("{v:?}"))
}

struct Busy(Arc<Mutex<Option<Instant>>>);
impl Busy {
    fn enter(&self) -> BusyGuard<'_> {
        *self.0.lock() = Some(Instant::now());
        BusyGuard(self)
    }
}
struct BusyGuard<'a>(&'a Busy);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *self.0 .0.lock() = None;
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    id: &str,
    source: String,
    ops: Arc<dyn Ops>,
    tokio: tokio::runtime::Handle,
    tx: mpsc::Sender<Msg>,
    rx: mpsc::Receiver<Msg>,
    ready: oneshot::Sender<Result<(), ModError>>,
) -> Result<(), ModError> {
    let mut ready = Some(ready);
    let fail = |ready: &mut Option<oneshot::Sender<Result<(), ModError>>>, e: ModError| {
        if let Some(r) = ready.take() {
            let _ = r.send(Err(e.clone()));
        }
        e
    };

    let rt = Runtime::new().map_err(|e| fail(&mut ready, ModError::failed(e)))?;
    rt.set_memory_limit(MEMORY_LIMIT);
    rt.set_max_stack_size(1024 * 1024);
    let busy = Busy(Arc::new(Mutex::new(None)));
    let since = busy.0.clone();
    rt.set_interrupt_handler(Some(Box::new(move || {
        since.lock().is_some_and(|t| t.elapsed() > BUSY_LIMIT)
    })));
    let context = Context::full(&rt).map_err(|e| fail(&mut ready, ModError::failed(e)))?;

    let replies: Rc<RefCell<HashMap<u64, oneshot::Sender<OpResult>>>> = Default::default();
    let mut next_call: u64 = 1;

    // Install the bridge, run the prelude, load the module and call activate.
    let activation = context.with(
        |ctx| -> Result<rquickjs::Persistent<Promise<'static>>, ModError> {
            let globals = ctx.globals();
            let sync_ops = ops.clone();
            let sync_replies = replies.clone();
            let sync = Function::new(ctx.clone(), move |op: String, args: String| -> String {
                let args: Value = serde_json::from_str(&args).unwrap_or(Value::Null);
                let result = if op == "reply" {
                    match serde_json::from_value::<Reply>(args) {
                        Ok(r) => {
                            if let Some(tx) = sync_replies.borrow_mut().remove(&r.id) {
                                let _ = tx.send(if r.ok {
                                    Ok(r.value)
                                } else {
                                    Err(r.error.unwrap_or_else(|| ModError::failed("failed")))
                                });
                            }
                            Ok(Value::Null)
                        }
                        Err(e) => Err(ModError::invalid(format!("bad reply: {e}"))),
                    }
                } else {
                    sync_ops.sync_op(&op, args)
                };
                match result {
                    Ok(value) => json!({"ok": true, "value": value}).to_string(),
                    Err(error) => json!({"ok": false, "error": error}).to_string(),
                }
            })
            .map_err(ModError::failed)?;
            globals.set("__aura_sync", sync).map_err(ModError::failed)?;

            let async_ops = ops.clone();
            let async_tx = tx.clone();
            let handle = tokio.clone();
            let asynchronous =
                Function::new(ctx.clone(), move |id: f64, op: String, args: String| {
                    let args: Value = serde_json::from_str(&args).unwrap_or(Value::Null);
                    let fut = async_ops.async_op(&op, args);
                    let tx = async_tx.clone();
                    handle.spawn(async move {
                        let result = fut.await;
                        let _ = tx.send(Msg::Complete {
                            id: id as u64,
                            result,
                        });
                    });
                })
                .map_err(ModError::failed)?;
            globals
                .set("__aura_async", asynchronous)
                .map_err(ModError::failed)?;

            {
                let _g = busy.enter();
                ctx.eval::<(), _>(PRELUDE).map_err(|e| exception(&ctx, e))?;
            }
            let _g = busy.enter();
            let module = Module::declare(ctx.clone(), format!("mod:{id}"), source)
                .map_err(|e| exception(&ctx, e))?;
            let (module, evaluated) = module.eval().map_err(|e| exception(&ctx, e))?;
            // Top-level await is not used by bundled mods; run what is queued.
            match evaluated.finish::<()>() {
                Ok(()) | Err(rquickjs::Error::WouldBlock) => {}
                Err(e) => return Err(exception(&ctx, e)),
            }
            let default: rquickjs::Value = module.get("default").map_err(|e| exception(&ctx, e))?;
            let activate: Function = globals
                .get("__aura_activate")
                .map_err(|e| exception(&ctx, e))?;
            let promise: Promise = activate.call((default,)).map_err(|e| exception(&ctx, e))?;
            Ok(rquickjs::Persistent::save(&ctx, promise))
        },
    );
    let activation = match activation {
        Ok(p) => Some(p),
        Err(e) => return Err(fail(&mut ready, e)),
    };
    let mut activation = activation;

    let dispatch = |kind: &str, payload: &Value| {
        context.with(|ctx| {
            let _g = busy.enter();
            let f: Result<Function, _> = ctx.globals().get("__aura_dispatch");
            if let Ok(f) = f {
                if let Err(e) = f.call::<_, ()>((kind, payload.to_string())) {
                    let err = exception(&ctx, e);
                    tracing::warn!(mod_id = %id, "{kind} failed: {}", err.message);
                }
            }
        })
    };
    let drain = || loop {
        let _g = busy.enter();
        match rt.execute_pending_job() {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                let msg = e.0.with(|ctx| exception(&ctx, rquickjs::Error::Exception));
                tracing::warn!(mod_id = %id, "uncaught error in a promise job: {}", msg.message);
            }
        }
    };

    let mut stopping: Option<(
        oneshot::Sender<()>,
        Instant,
        rquickjs::Persistent<Promise<'static>>,
    )> = None;
    loop {
        drain();

        if let Some(p) = &activation {
            let state = context.with(|ctx| {
                let promise = p.clone().restore(&ctx).ok()?;
                match promise.result::<()>() {
                    None => None,
                    Some(Ok(())) => Some(Ok(())),
                    Some(Err(e)) => Some(Err(exception(&ctx, e))),
                }
            });
            match state {
                None => {}
                Some(Ok(())) => {
                    activation = None;
                    if let Some(r) = ready.take() {
                        let _ = r.send(Ok(()));
                    }
                }
                Some(Err(e)) => return Err(fail(&mut ready, e)),
            }
        }

        if let Some((_, deadline, p)) = &stopping {
            let done = context.with(|ctx| {
                p.clone()
                    .restore(&ctx)
                    .map(|p| p.result::<()>().is_some())
                    .unwrap_or(true)
            });
            if done || Instant::now() >= *deadline {
                let (ack, _, _) = stopping.take().unwrap();
                let _ = ack.send(());
                break;
            }
        }

        let msg = if let Some((_, deadline, _)) = &stopping {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(m) => m,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => m,
                Err(_) => break,
            }
        };
        match msg {
            Msg::Call {
                name,
                params,
                caller,
                reply,
            } => {
                let cid = next_call;
                next_call += 1;
                replies.borrow_mut().insert(cid, reply);
                dispatch(
                    "call",
                    &json!({"id": cid, "name": name, "params": params, "caller": caller}),
                );
            }
            Msg::Dispatch { kind, payload } => {
                if kind != "ping" {
                    dispatch(kind, &payload);
                }
            }
            Msg::Complete { id, result } => {
                let payload = match result {
                    Ok(value) => json!({"id": id, "ok": true, "value": value}),
                    Err(error) => json!({"id": id, "ok": false, "error": error}),
                };
                dispatch("complete", &payload);
            }
            Msg::Stop(ack) => {
                if stopping.is_some() {
                    let _ = ack.send(());
                    continue;
                }
                let promise = context.with(|ctx| {
                    let _g = busy.enter();
                    let f: Function = ctx.globals().get("__aura_deactivate").ok()?;
                    let p: Promise = f.call(()).ok()?;
                    Some(rquickjs::Persistent::save(&ctx, p))
                });
                match promise {
                    Some(p) => stopping = Some((ack, Instant::now() + STOP_GRACE, p)),
                    None => {
                        let _ = ack.send(());
                        break;
                    }
                }
            }
        }
    }
    // Callers still waiting get an error when their senders drop with `replies`.
    replies.borrow_mut().clear();
    drop(activation);
    Ok(())
}

/// How long a syntax check may take before it is given up (the file then
/// counts as not loadable). With files capped at 4 MB this is never reached
/// by a real file.
pub const SYNTAX_CHECK_LIMIT: Duration = Duration::from_secs(3);

/// [`check_module_syntax`] on a blocking thread, given up after `limit`: never
/// on the async runtime, so a slow parse cannot stall the daemon (its RPC, its
/// signals) and nothing waits on it longer than `limit`.
pub async fn check_module_syntax_within(
    name: &str,
    source: String,
    limit: Duration,
) -> Result<(), String> {
    let n = name.to_string();
    let deadline = Instant::now() + limit;
    let task =
        tokio::task::spawn_blocking(move || check_module_syntax_until(&n, &source, Some(deadline)));
    match tokio::time::timeout(limit, task).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(format!("{name}: the syntax check failed: {e}")),
        Err(_) => Err(format!(
            "{name}: checking it took longer than {} s; Aura did not load it",
            limit.as_secs_f32()
        )),
    }
}

/// Parse `source` as an ES module without running it (a UI half, which runs
/// in the window, never here). `Err` reads `<name>:<line>:<column>: <error>`
/// when QuickJS gives a place.
pub fn check_module_syntax(name: &str, source: &str) -> Result<(), String> {
    check_module_syntax_until(name, source, None)
}

fn check_module_syntax_until(
    name: &str,
    source: &str,
    deadline: Option<Instant>,
) -> Result<(), String> {
    let rt = Runtime::new().map_err(|e| e.to_string())?;
    rt.set_memory_limit(MEMORY_LIMIT);
    if let Some(d) = deadline {
        // QuickJS calls this while it works; past the deadline it gives up.
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > d)));
    }
    let ctx = Context::full(&rt).map_err(|e| e.to_string())?;
    ctx.with(|ctx| match Module::declare(ctx.clone(), name, source) {
        Ok(_) => Ok(()),
        Err(_) if deadline.is_some_and(|d| Instant::now() > d) => Err(format!(
            "{name}: checking it took longer than {} s; Aura did not load it",
            SYNTAX_CHECK_LIMIT.as_secs_f32()
        )),
        Err(rquickjs::Error::Exception) => {
            let v = ctx.catch();
            let obj = v.as_object();
            let get = |key: &str| obj.and_then(|o| o.get::<_, String>(key).ok());
            let message = get("message").unwrap_or_else(|| "syntax error".into());
            let kind = get("name").unwrap_or_else(|| "SyntaxError".into());
            // "    at ui.js:3:10"
            let place = get("stack").and_then(|stack| {
                stack
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("at ").map(str::to_string))
                    .filter(|p| p.starts_with(name))
            });
            if let Some(module) = message.strip_prefix("could not load module ") {
                return Err(format!(
                    "{name}: imports {module}, but a UI half is one file and may not import anything; take React and Aura's parts from globalThis.__aura.modules"
                ));
            }
            Err(match place {
                Some(p) => format!("{p}: {kind}: {message}"),
                None => format!("{name}: {kind}: {message}"),
            })
        }
        Err(e) => Err(format!("{name}: {e}")),
    })
}
