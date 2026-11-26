use crate::{Config, ModHost, ModSource};
use aura_core::{Manager, Store};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

fn write_mod(root: &Path, id: &str, manifest: Value, daemon: &str) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({"id": id, "name": id, "version": "1.0.0", "apiVersion": 1, "daemon": "daemon.js"});
    for (k, v) in manifest.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("mod.json"), m.to_string()).unwrap();
    std::fs::write(dir.join("daemon.js"), daemon).unwrap();
}

struct Setup {
    host: ModHost,
    notes: broadcast::Receiver<Value>,
    manager: Manager,
    _tmp: tempfile::TempDir,
}

async fn setup(bundled: &[(&str, Value, &str)], user: &[(&str, Value, &str)]) -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let b = tmp.path().join("bundled");
    let u = tmp.path().join("user");
    for (id, m, src) in bundled {
        write_mod(&b, id, m.clone(), src);
    }
    for (id, m, src) in user {
        write_mod(&u, id, m.clone(), src);
    }
    let store: Arc<dyn Store> = Arc::new(aura_core::MemoryStore::default());
    let manager = Manager::new(store.clone(), vec![], None);
    let (tx, notes) = broadcast::channel(256);
    let host = ModHost::start(
        Config {
            dirs: vec![(ModSource::Bundled, b), (ModSource::User, u)],
            data_dir: tmp.path().join("data"),
        },
        manager.clone(),
        store,
        tx,
    )
    .await;
    Setup {
        host,
        notes,
        manager,
        _tmp: tmp,
    }
}

async fn call(h: &ModHost, method: &str, params: Value) -> anyhow::Result<Value> {
    Ok(h.handle(method, &params, None).await?.expect("handled"))
}

fn status(list: &Value, id: &str) -> Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap()["status"]
        .clone()
}

#[tokio::test]
async fn mods_call_each_other_within_their_permissions() {
    let s = setup(
        &[
            (
                "base",
                json!({}),
                r#"export default (aura) => {
                    aura.rpc.handle("hello", (p, caller) => ({hi: p.name, caller}));
                    aura.rpc.handle("fail", () => { const e = new Error("rejected!"); e.data = {kind: "rejected"}; throw e; });
                }"#,
            ),
            (
                "top",
                json!({"dependsOn": {"base": "^1"}, "permissions": {"mods": ["base"]}}),
                r#"export default (aura) => {
                    aura.rpc.handle("relay", () => aura.mods.call("base", "hello", {name: "top"}));
                    aura.rpc.handle("relayFail", async () => {
                      try { await aura.mods.call("base", "fail"); } catch (e) { return {msg: e.message, data: e.data}; }
                    });
                }"#,
            ),
            (
                "nosy",
                json!({}),
                r#"export default (aura) => { aura.rpc.handle("peek", () => aura.mods.call("base", "hello", {})); }"#,
            ),
        ],
        &[],
    )
    .await;
    let h = &s.host;
    assert_eq!(
        call(h, "mod.top.relay", json!({})).await.unwrap(),
        json!({"hi": "top", "caller": {"kind": "mod", "id": "top"}})
    );
    assert_eq!(
        call(h, "mod.top.relayFail", json!({})).await.unwrap(),
        json!({"msg": "rejected!", "data": {"kind": "rejected"}})
    );
    let err = call(h, "mod.nosy.peek", json!({})).await.unwrap_err();
    let err = err.downcast::<crate::ModError>().unwrap();
    assert_eq!(err.code, "permission_denied");
    let err = call(h, "mod.base.nope", json!({})).await.unwrap_err();
    assert_eq!(err.downcast::<crate::ModError>().unwrap().code, "not_found");
    assert_eq!(h.handle("something.else", &json!({}), None).await.unwrap(), None);
}

#[tokio::test]
async fn user_mods_wait_for_approval_and_bundled_ones_do_not() {
    let src = r#"export default (aura) => { aura.rpc.handle("ping", () => "pong"); }"#;
    let s = setup(
        &[("a", json!({}), src)],
        &[("b", json!({"permissions": {"process": ["git"]}}), src)],
    )
    .await;
    let h = &s.host;
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(status(&list, "a")["state"], "running");
    assert_eq!(status(&list, "b")["state"], "needs_approval");
    assert!(call(h, "mod.b.ping", json!({})).await.is_err());
    call(h, "mods.approve", json!({"id": "b"})).await.unwrap();
    assert_eq!(call(h, "mod.b.ping", json!({})).await.unwrap(), json!("pong"));

    call(h, "mods.disable", json!({"id": "a"})).await.unwrap();
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(status(&list, "a")["state"], "disabled");
    assert!(call(h, "mod.a.ping", json!({})).await.is_err());
    call(h, "mods.enable", json!({"id": "a"})).await.unwrap();
    assert_eq!(call(h, "mod.a.ping", json!({})).await.unwrap(), json!("pong"));
}

#[tokio::test]
async fn a_missing_dependency_or_failing_mod_does_not_stop_the_rest() {
    let s = setup(
        &[
            ("lonely", json!({"dependsOn": {"ghost": "^1"}}), "export default () => {}"),
            ("broken", json!({}), "export default () => { throw new Error('kaput'); }"),
            ("fine", json!({}), r#"export default (aura) => { aura.rpc.handle("ok", () => 1); }"#),
        ],
        &[],
    )
    .await;
    let h = &s.host;
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(status(&list, "lonely")["state"], "failed");
    assert!(status(&list, "lonely")["error"].as_str().unwrap().contains("ghost"));
    assert!(status(&list, "broken")["error"].as_str().unwrap().contains("kaput"));
    assert_eq!(call(h, "mod.fine.ok", json!({})).await.unwrap(), json!(1));
}

#[tokio::test]
async fn storage_settings_and_session_data() {
    let s = setup(
        &[(
            "store",
            json!({"settings": [{"key": "color", "type": "string", "label": "Color", "default": "red"}], "permissions": {"sessions": "write"}}),
            r#"export default (aura) => {
                aura.rpc.handle("put", async () => {
                  await aura.storage.kv.set("a", {n: 1});
                  const c = aura.storage.collection("things");
                  await c.put("x", [1, 2]);
                  return {a: await aura.storage.kv.get("a"), keys: await aura.storage.kv.keys(),
                          all: await c.all(), missing: await aura.storage.kv.get("zzz"), color: aura.settings.get("color")};
                });
                let seen = null;
                aura.settings.onChange((k, v) => { seen = [k, v]; });
                aura.rpc.handle("seen", () => seen);
                aura.rpc.handle("noSession", async () => {
                  try { await aura.sessions.data("nope").set("k", 1); } catch (e) { return e.code; }
                });
            }"#,
        )],
        &[],
    )
    .await;
    let h = &s.host;
    assert_eq!(
        call(h, "mod.store.put", json!({})).await.unwrap(),
        // `missing` is undefined, so it is not in the JSON at all.
        json!({"a": {"n": 1}, "keys": ["a"], "all": [["x", [1, 2]]], "color": "red"})
    );
    call(h, "mods.settings.set", json!({"id": "store", "key": "color", "value": "blue"})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(call(h, "mod.store.seen", json!({})).await.unwrap(), json!(["color", "blue"]));
    assert_eq!(call(h, "mods.settings.get", json!({"id": "store"})).await.unwrap()["color"], "blue");
    assert_eq!(call(h, "mod.store.noSession", json!({})).await.unwrap(), json!("not_found"));
    let _ = &s.manager;
}

#[tokio::test]
async fn emits_reach_the_ui_and_listening_mods() {
    let mut s = setup(
        &[
            ("talker", json!({}), r#"export default (aura) => { aura.rpc.handle("say", (p) => { aura.emit("said", p); }); }"#),
            (
                "listener",
                json!({"permissions": {"mods": ["talker"]}}),
                r#"export default (aura) => {
                    let got = [];
                    aura.mods.on("talker", "said", (p) => got.push(p));
                    aura.rpc.handle("got", () => got);
                }"#,
            ),
        ],
        &[],
    )
    .await;
    call(&s.host, "mod.talker.say", json!({"x": 1})).await.unwrap();
    let mut seen = false;
    for _ in 0..20 {
        while let Ok(n) = s.notes.try_recv() {
            if n["method"] == "mod.talker.said" {
                assert_eq!(n["params"], json!({"x": 1}));
                seen = true;
            }
        }
        if seen {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen, "the UI got the notification");
    let mut got = json!([]);
    for _ in 0..20 {
        got = call(&s.host, "mod.listener.got", json!({})).await.unwrap();
        if got != json!([]) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(got, json!([{"x": 1}]));
}

#[tokio::test]
async fn orchestrator_tools_are_listed_and_called_per_session() {
    let s = setup(
        &[
            (
                "pull-requests",
                json!({"permissions": {"orchestratorTools": true}}),
                r#"export default (aura) => {
                    aura.orchestrator.tool({name: "reviews_list", description: "List", inputSchema: {type: "object"}},
                      (args, ctx) => ({args, session: ctx.sessionId}));
                }"#,
            ),
            (
                "sneaky",
                json!({}),
                r#"export default (aura) => {
                    try { aura.orchestrator.tool({name: "x", description: ""}, () => 1); } catch (e) { aura.emit("denied", e.code); }
                }"#,
            ),
        ],
        &[],
    )
    .await;
    let h = &s.host;
    let tools = call(h, "mods.tools.list", json!({})).await.unwrap();
    assert_eq!(tools.as_array().unwrap().len(), 1);
    assert_eq!(tools[0]["name"], "pull_requests_reviews_list");
    let r = h
        .handle("mods.tools.call", &json!({"name": "pull_requests_reviews_list", "args": {"a": 1}}), Some("s-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r, json!({"args": {"a": 1}, "session": "s-1"}));
    assert!(h
        .handle("mods.tools.call", &json!({"name": "pull_requests_reviews_list"}), None)
        .await
        .is_err());
}

#[tokio::test]
async fn ui_source_is_served_for_running_mods() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("b").join("view");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("mod.json"),
        json!({"id":"view","name":"View","version":"1.2.3","apiVersion":1,"ui":"ui.js","styles":"ui.css"}).to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("ui.js"), "export default () => {}").unwrap();
    std::fs::write(dir.join("ui.css"), ".x{}").unwrap();
    let store: Arc<dyn Store> = Arc::new(aura_core::MemoryStore::default());
    let manager = Manager::new(store.clone(), vec![], None);
    let (tx, _rx) = broadcast::channel(16);
    let h = ModHost::start(
        Config {
            dirs: vec![(ModSource::Bundled, tmp.path().join("b"))],
            data_dir: tmp.path().join("d"),
        },
        manager,
        store,
        tx,
    )
    .await;
    let src = call(&h, "mods.ui_source", json!({"id": "view"})).await.unwrap();
    assert_eq!(src["js"], "export default () => {}");
    assert_eq!(src["css"], ".x{}");
    assert_eq!(src["version"], "1.2.3");
    let _ = h.inner();
}
