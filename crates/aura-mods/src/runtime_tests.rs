use crate::runtime::{ModError, ModRuntime, OpResult, Ops};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Ops that log, answer `info`, sleep for real and echo `echo`.
#[derive(Default)]
struct Fake {
    logs: Mutex<Vec<String>>,
    emitted: Mutex<Vec<Value>>,
}

impl Ops for Fake {
    fn sync_op(&self, op: &str, args: Value) -> OpResult {
        match op {
            "info" => Ok(
                json!({"id":"t","version":"1.0.0","dataDir":"/tmp/t","platform":"linux","settings":{"x":1}}),
            ),
            "log" => {
                self.logs
                    .lock()
                    .push(args["message"].as_str().unwrap_or("").to_string());
                Ok(Value::Null)
            }
            "emit" => {
                self.emitted.lock().push(args);
                Ok(Value::Null)
            }
            "uuid" => Ok(json!("00000000-0000-4000-8000-000000000000")),
            "events.subscribe" | "mods.subscribe" | "tools.set" => Ok(Value::Null),
            other => Err(ModError::invalid(format!("unknown sync op {other}"))),
        }
    }
    fn async_op(&self, op: &str, args: Value) -> BoxFuture<'static, OpResult> {
        let op = op.to_string();
        Box::pin(async move {
            match op.as_str() {
                "sleep" => {
                    tokio::time::sleep(Duration::from_millis(args["ms"].as_u64().unwrap_or(0)))
                        .await;
                    Ok(Value::Null)
                }
                "kv.get" => Ok(json!({"echo": args})),
                "kv.set" => Err(ModError {
                    code: "permission_denied".into(),
                    message: "no".into(),
                    data: Some(json!({"why": "test"})),
                }),
                other => Err(ModError::invalid(format!("unknown async op {other}"))),
            }
        })
    }
}

async fn start(src: &str) -> (Arc<Fake>, Result<ModRuntime, ModError>) {
    let fake = Arc::new(Fake::default());
    let r = ModRuntime::start(
        "t",
        src.to_string(),
        fake.clone(),
        tokio::runtime::Handle::current(),
    )
    .await;
    (fake, r)
}

#[tokio::test]
async fn activates_and_answers_calls() {
    let (fake, rt) = start(
        r#"
        export default function activate(aura) {
          console.log("hello", aura.mod.id, aura.settings.get("x"));
          aura.rpc.handle("add", ({a, b}) => a + b);
          aura.rpc.handle("later", async () => { await new Promise(r => setTimeout(r, 20)); return "done"; });
          aura.rpc.handle("kv", async (p) => aura.storage.kv.get(p.key));
          aura.rpc.handle("caller", (_p, caller) => caller);
          aura.rpc.handle("boom", () => { const e = new Error("bad"); e.code = "invalid"; e.data = {n: 1}; throw e; });
          aura.rpc.handle("denied", async () => {
            try { await aura.storage.kv.set("k", 1); } catch (e) { return {code: e.code, data: e.data, msg: e.message}; }
          });
          aura.rpc.handle("web", () => [btoa("hi"), atob("aGk="), new URL("https://a.b/c?d=1#e").searchParams.get("d"),
                                         new TextDecoder().decode(new TextEncoder().encode("é")), crypto.randomUUID()]);
          aura.emit("ready", {ok: true});
        }
        "#,
    )
    .await;
    let rt = rt.expect("activates");
    assert_eq!(
        rt.call("add", json!({"a": 2, "b": 3}), json!({"kind":"user"}))
            .await
            .unwrap(),
        json!(5)
    );
    assert_eq!(
        rt.call("later", json!(null), json!({})).await.unwrap(),
        json!("done")
    );
    assert_eq!(
        rt.call("kv", json!({"key": "a"}), json!({})).await.unwrap(),
        json!({"echo": {"key": "a"}})
    );
    assert_eq!(
        rt.call("caller", json!(null), json!({"kind":"mod","id":"x"}))
            .await
            .unwrap(),
        json!({"kind":"mod","id":"x"})
    );
    let err = rt.call("boom", json!(null), json!({})).await.unwrap_err();
    assert_eq!(err.code, "invalid");
    assert_eq!(err.data, Some(json!({"n": 1})));
    assert!(err.message.starts_with("bad"));
    assert_eq!(
        rt.call("denied", json!(null), json!({})).await.unwrap(),
        json!({"code": "permission_denied", "data": {"why": "test"}, "msg": "no"})
    );
    assert_eq!(
        rt.call("web", json!(null), json!({})).await.unwrap(),
        json!([
            "aGk=",
            "hi",
            "1",
            "é",
            "00000000-0000-4000-8000-000000000000"
        ])
    );
    assert_eq!(
        rt.call("nope", json!(null), json!({}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert!(fake.logs.lock().iter().any(|l| l == "hello t 1"));
    assert_eq!(
        fake.emitted.lock()[0],
        json!({"name":"ready","payload":{"ok":true}})
    );
    rt.stop().await;
    assert_eq!(
        rt.call("add", json!({"a": 1, "b": 1}), json!({}))
            .await
            .unwrap_err()
            .code,
        "unavailable"
    );
}

#[tokio::test]
async fn a_failing_activate_is_reported() {
    let (_, rt) = start("export default function () { throw new Error('nope'); }").await;
    let err = rt.err().expect("fails");
    assert!(err.message.contains("nope"), "{}", err.message);

    let (_, rt) = start(
        "export default async function () { await Promise.resolve(); throw new Error('later'); }",
    )
    .await;
    assert!(rt.err().unwrap().message.contains("later"));

    let (_, rt) = start("this is not javascript").await;
    assert!(rt.is_err());

    let (_, rt) = start("export const x = 1;").await;
    assert!(rt.err().unwrap().message.contains("default-export"));
}

#[tokio::test]
async fn intervals_run_until_cleared_and_deactivate_runs() {
    let (fake, rt) = start(
        r#"
        export default function (aura) {
          let n = 0;
          const t = setInterval(() => { n++; if (n === 3) { clearInterval(t); aura.emit("three", n); } }, 5);
          return () => console.log("bye");
        }
        "#,
    )
    .await;
    let rt = rt.unwrap();
    for _ in 0..100 {
        if !fake.emitted.lock().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fake.emitted.lock()[0]["payload"], json!(3));
    rt.stop().await;
    assert!(fake.logs.lock().iter().any(|l| l == "bye"));
}

#[tokio::test]
async fn a_busy_loop_is_interrupted() {
    let (_, rt) = start(
        r#"
        export default function (aura) {
          aura.rpc.handle("spin", () => { for (;;) {} });
          aura.rpc.handle("ok", () => 1);
        }
        "#,
    )
    .await;
    let rt = rt.unwrap();
    let started = std::time::Instant::now();
    // The spinning call itself never replies: the uncatchable interrupt unwinds
    // past its reply (the host bounds every call with a timeout of its own).
    let spinning = rt.clone();
    tokio::spawn(async move { spinning.call("spin", json!(null), json!({})).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Queued behind the loop, this one is answered once the interrupt ends it.
    let ok = tokio::time::timeout(
        Duration::from_secs(20),
        rt.call("ok", json!(null), json!({})),
    )
    .await
    .expect("the interrupt ends the loop");
    assert_eq!(ok.unwrap(), json!(1));
    assert!(started.elapsed() >= crate::runtime::BUSY_LIMIT);
}
