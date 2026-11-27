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
    let mut m =
        json!({"id": id, "name": id, "version": "1.0.0", "apiVersion": 1, "daemon": "daemon.js"});
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

/// A call from Aura's window (which may grant approvals).
async fn call(h: &ModHost, method: &str, params: Value) -> anyhow::Result<Value> {
    Ok(h.handle_as(method, &params, None, true)
        .await?
        .expect("handled"))
}

/// A call from the `aura` CLI or any client that is not the window.
async fn call_cli(h: &ModHost, method: &str, params: Value) -> anyhow::Result<Value> {
    Ok(h.handle(method, &params, None).await?.expect("handled"))
}

fn write_user_mod(root: &Path, dir: &str, id: &str, daemon: &str) {
    let d = root.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("daemon.js"), daemon).unwrap();
    std::fs::write(
        d.join("mod.json"),
        json!({"id": id, "name": id, "version": "1.0.0", "apiVersion": 1, "daemon": "daemon.js"})
            .to_string(),
    )
    .unwrap();
}

fn state_of(list: &Value, id: &str) -> Option<String> {
    list.as_array()?
        .iter()
        .find(|m| m["id"] == id && m["broken"].is_null())
        .map(|m| m["status"]["state"].as_str().unwrap_or("").to_string())
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
    assert_eq!(
        h.handle("something.else", &json!({}), None).await.unwrap(),
        None
    );
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
    assert_eq!(
        call(h, "mod.b.ping", json!({})).await.unwrap(),
        json!("pong")
    );

    call(h, "mods.disable", json!({"id": "a"})).await.unwrap();
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(status(&list, "a")["state"], "disabled");
    assert!(call(h, "mod.a.ping", json!({})).await.is_err());
    call(h, "mods.enable", json!({"id": "a"})).await.unwrap();
    assert_eq!(
        call(h, "mod.a.ping", json!({})).await.unwrap(),
        json!("pong")
    );
}

#[tokio::test]
async fn a_missing_dependency_or_failing_mod_does_not_stop_the_rest() {
    let s = setup(
        &[
            (
                "lonely",
                json!({"dependsOn": {"ghost": "^1"}}),
                "export default () => {}",
            ),
            (
                "broken",
                json!({}),
                "export default () => { throw new Error('kaput'); }",
            ),
            (
                "fine",
                json!({}),
                r#"export default (aura) => { aura.rpc.handle("ok", () => 1); }"#,
            ),
        ],
        &[],
    )
    .await;
    let h = &s.host;
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(status(&list, "lonely")["state"], "failed");
    assert!(status(&list, "lonely")["error"]
        .as_str()
        .unwrap()
        .contains("ghost"));
    assert!(status(&list, "broken")["error"]
        .as_str()
        .unwrap()
        .contains("kaput"));
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
    call(
        h,
        "mods.settings.set",
        json!({"id": "store", "key": "color", "value": "blue"}),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        call(h, "mod.store.seen", json!({})).await.unwrap(),
        json!(["color", "blue"])
    );
    assert_eq!(
        call(h, "mods.settings.get", json!({"id": "store"}))
            .await
            .unwrap()["color"],
        "blue"
    );
    assert_eq!(
        call(h, "mod.store.noSession", json!({})).await.unwrap(),
        json!("not_found")
    );
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
    call(&s.host, "mod.talker.say", json!({"x": 1}))
        .await
        .unwrap();
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
        .handle(
            "mods.tools.call",
            &json!({"name": "pull_requests_reviews_list", "args": {"a": 1}}),
            Some("s-1"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r, json!({"args": {"a": 1}, "session": "s-1"}));
    assert!(h
        .handle(
            "mods.tools.call",
            &json!({"name": "pull_requests_reviews_list"}),
            None
        )
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
    let src = call(&h, "mods.ui_source", json!({"id": "view"}))
        .await
        .unwrap();
    assert_eq!(src["js"], "export default () => {}");
    assert_eq!(src["css"], ".x{}");
    assert_eq!(src["version"], "1.2.3");
    let _ = h.inner();
}

#[tokio::test]
async fn files_stay_inside_the_mods_data_folder() {
    let s = setup(
        &[(
            "files",
            json!({}),
            r#"export default (aura) => {
                aura.rpc.handle("roundtrip", async () => {
                  await aura.fs.writeText("a/b.txt", "hi");
                  const text = await aura.fs.readText("a/b.txt");
                  await aura.fs.rename("a", "c");
                  const listed = await aura.fs.list("c");
                  const gone = await aura.fs.exists("a/b.txt");
                  await aura.fs.remove("c");
                  return {text, listed, gone, after: await aura.fs.exists("c")};
                });
                aura.rpc.handle("escape", async (p) => {
                  try { await aura.fs.readText(p.path); return "read"; } catch (e) { return e.code; }
                });
                aura.rpc.handle("cancelNothing", () => aura.agents.cancel("x").catch((e) => e.code));
            }"#,
        )],
        &[],
    )
    .await;
    let h = &s.host;
    assert_eq!(
        call(h, "mod.files.roundtrip", json!({})).await.unwrap(),
        json!({"text": "hi", "listed": [{"name": "b.txt", "dir": false}], "gone": false, "after": false})
    );
    assert_eq!(
        call(h, "mod.files.escape", json!({"path": "../../secret"}))
            .await
            .unwrap(),
        json!("permission_denied")
    );
    let outside = if cfg!(windows) {
        r"C:\Windows\win.ini"
    } else {
        "/etc/passwd"
    };
    assert_eq!(
        call(h, "mod.files.escape", json!({"path": outside}))
            .await
            .unwrap(),
        json!("permission_denied")
    );
    // Cancelling needs the agents permission.
    assert_eq!(
        call(h, "mod.files.cancelNothing", json!({})).await.unwrap(),
        json!("permission_denied")
    );
}

/// Wait up to `secs` for a notification `method`.
async fn wait_note(notes: &mut broadcast::Receiver<Value>, method: &str, secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < deadline {
        while let Ok(n) = notes.try_recv() {
            if n["method"] == method {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// Poll `f` until it is true or `secs` pass.
async fn eventually<F: std::future::Future<Output = bool>>(
    secs: u64,
    mut f: impl FnMut() -> F,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < deadline {
        if f().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn themes_are_listed_validated_and_watched() {
    let mut s = setup(&[], &[("themed", json!({}), "export default () => {}")]).await;
    let h = &s.host;
    let user_dir = s._tmp.path().join("user").join("themed");
    // A mod's own themes count only while it runs.
    std::fs::create_dir_all(user_dir.join("themes")).unwrap();
    std::fs::write(
        user_dir.join("themes/night.json"),
        r#"{"name":"Night","base":"dark"}"#,
    )
    .unwrap();

    let dirs = call(h, "mods.dirs", json!({})).await.unwrap();
    assert_eq!(
        dirs["user"],
        s._tmp.path().join("user").to_string_lossy().as_ref()
    );
    assert_eq!(dirs["dev"], Value::Null);

    let themes = h.themes_dir();
    assert!(themes.is_dir(), "the themes folder is created");
    std::fs::write(
        themes.join("ocean.json"),
        r##"{"name":"Ocean","base":"light","tokens":{"--md-primary":"#0066cc","--nope":"1"}}"##,
    )
    .unwrap();
    std::fs::write(themes.join("bad.json"), r#"{"name":"Bad","base":"blue"}"#).unwrap();

    let list = call(h, "themes.list", json!({})).await.unwrap();
    assert_eq!(list["dir"], themes.to_string_lossy().as_ref());
    let ids: Vec<&str> = list["themes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["bad", "ocean"],
        "the mod is not approved, so its theme is not listed"
    );
    let ocean = call(h, "themes.get", json!({"id": "ocean"})).await.unwrap();
    assert_eq!(ocean["base"], "light");
    assert_eq!(ocean["tokens"]["--md-primary"], "#0066cc");
    assert!(ocean["warnings"][0].as_str().unwrap().contains("--nope"));
    let bad = call(h, "themes.get", json!({"id": "bad"})).await.unwrap();
    assert!(bad["error"].as_str().unwrap().contains("base"));
    assert!(call(h, "themes.get", json!({"id": "nope"})).await.is_err());

    call(h, "mods.approve", json!({"id": "themed"}))
        .await
        .unwrap();
    let night = call(h, "themes.get", json!({"id": "themed:night"}))
        .await
        .unwrap();
    assert_eq!(night["source"], "mod:themed");

    // Editing a theme announces it.
    while s.notes.try_recv().is_ok() {}
    std::fs::write(
        themes.join("ocean.json"),
        r##"{"name":"Ocean 2","base":"light"}"##,
    )
    .unwrap();
    assert!(
        wait_note(&mut s.notes, "themes.changed", 10).await,
        "themes.changed after an edit"
    );
    let ocean = call(h, "themes.get", json!({"id": "ocean"})).await.unwrap();
    assert_eq!(ocean["name"], "Ocean 2");
}

#[tokio::test]
async fn user_mods_are_picked_up_and_reloaded_when_their_files_change() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let dir = s._tmp.path().join("user").join("fresh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("daemon.js"),
        r#"export default (aura) => { aura.rpc.handle("v", () => 1); }"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("mod.json"),
        json!({"id":"fresh","name":"Fresh","version":"0.1.0","apiVersion":1,"daemon":"daemon.js"})
            .to_string(),
    )
    .unwrap();
    let found = eventually(10, || async {
        call(h, "mods.list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "fresh")
    })
    .await;
    assert!(found, "a new mod folder is found without a rescan");
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(
        status(&list, "fresh")["state"],
        "needs_approval",
        "a new user mod still waits for approval"
    );
    call(h, "mods.approve", json!({"id": "fresh"}))
        .await
        .unwrap();
    assert_eq!(call(h, "mod.fresh.v", json!({})).await.unwrap(), json!(1));

    std::fs::write(
        dir.join("daemon.js"),
        r#"export default (aura) => { aura.rpc.handle("v", () => 2); }"#,
    )
    .unwrap();
    let reloaded = eventually(10, || async {
        call(h, "mod.fresh.v", json!({})).await.ok() == Some(json!(2))
    })
    .await;
    assert!(reloaded, "an edited daemon.js reloads");
    let logs = call(h, "mods.logs", json!({"id": "fresh"})).await.unwrap();
    assert!(logs
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l.as_str().unwrap().contains("restarting the daemon half")));

    // A UI half's report lands in the same log.
    call(
        h,
        "mods.ui_log",
        json!({"id": "fresh", "level": "error", "message": "ui.js: boom"}),
    )
    .await
    .unwrap();
    let logs = call(h, "mods.logs", json!({"id": "fresh"})).await.unwrap();
    assert!(logs
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l.as_str().unwrap().contains("ui error: ui.js: boom")));

    std::fs::remove_dir_all(&dir).unwrap();
    let gone = eventually(10, || async {
        !call(h, "mods.list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "fresh")
    })
    .await;
    assert!(gone, "a removed mod folder is dropped");
}

#[tokio::test]
async fn only_the_half_whose_file_changed_reloads() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let dir = s._tmp.path().join("user").join("halves");
    std::fs::create_dir_all(&dir).unwrap();
    // In-memory state: lost when the daemon half restarts, kept otherwise.
    let daemon = |v: u32| {
        format!("let n = 0; export default (aura) => {{ aura.rpc.handle(\"bump\", () => ++n + {v} * 1000); }}")
    };
    std::fs::write(dir.join("daemon.js"), daemon(0)).unwrap();
    std::fs::write(dir.join("ui.js"), "export default () => {}").unwrap();
    let manifest = |v: &str| {
        json!({"id":"halves","name":"Halves","version":v,"apiVersion":1,"daemon":"daemon.js","ui":"ui.js"}).to_string()
    };
    std::fs::write(dir.join("mod.json"), manifest("0.1.0")).unwrap();
    // Found at once (or already by the watcher), without waiting for it.
    call(h, "mods.discover", json!({})).await.unwrap();
    assert!(call(h, "mods.list", json!({}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["id"] == "halves"));
    call(h, "mods.approve", json!({"id": "halves"}))
        .await
        .unwrap();
    let rev = || async {
        call(h, "mods.ui_source", json!({"id": "halves"}))
            .await
            .unwrap()["rev"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(
        call(h, "mod.halves.bump", json!({})).await.unwrap(),
        json!(1)
    );
    assert_eq!(
        call(h, "mod.halves.bump", json!({})).await.unwrap(),
        json!(2)
    );
    let rev0 = rev().await;

    // ui.js: the UI half's revision moves on; the daemon keeps counting.
    std::fs::write(dir.join("ui.js"), "export default () => { /* v2 */ }").unwrap();
    assert!(
        eventually(10, || async { rev().await > rev0 }).await,
        "the UI half reloads"
    );
    assert_eq!(
        call(h, "mod.halves.bump", json!({})).await.unwrap(),
        json!(3),
        "the daemon half kept its state"
    );

    // Files neither half loads change nothing.
    let rev1 = rev().await;
    std::fs::write(dir.join("notes.md"), "x").unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(rev().await, rev1);
    assert_eq!(
        call(h, "mod.halves.bump", json!({})).await.unwrap(),
        json!(4)
    );

    // daemon.js: the daemon restarts (state gone), the UI half stays.
    std::fs::write(dir.join("daemon.js"), daemon(1)).unwrap();
    assert!(
        eventually(10, || async {
            call(h, "mod.halves.bump", json!({})).await.ok() == Some(json!(1001))
        })
        .await
    );
    assert_eq!(rev().await, rev1, "the UI half was not reloaded");

    // mod.json: both.
    std::fs::write(dir.join("mod.json"), manifest("0.1.1")).unwrap();
    assert!(
        eventually(10, || async { rev().await > rev1 }).await,
        "the UI half reloads with mod.json"
    );
    assert_eq!(
        call(h, "mod.halves.bump", json!({})).await.unwrap(),
        json!(1001),
        "and the daemon half restarted"
    );
}

#[tokio::test]
async fn a_ui_half_that_does_not_parse_is_reported_with_its_place() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let dir = s._tmp.path().join("user").join("jsx");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("ui.js"),
        "export default function activate(ctx) {\n  return <div/>;\n}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("mod.json"),
        json!({"id":"jsx","name":"JSX","version":"1.0.0","apiVersion":1,"ui":"ui.js"}).to_string(),
    )
    .unwrap();
    call(h, "mods.discover", json!({})).await.unwrap();
    call(h, "mods.approve", json!({"id": "jsx"})).await.unwrap();
    // Checked in the background, off the runtime.
    let found = eventually(10, || async {
        let list = call(h, "mods.list", json!({})).await.unwrap();
        list.as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "jsx" && m["uiError"].is_string())
    })
    .await;
    assert!(found);
    let list = call(h, "mods.list", json!({})).await.unwrap();
    let m = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "jsx")
        .unwrap()
        .clone();
    assert!(
        m["uiError"]
            .as_str()
            .unwrap()
            .starts_with("ui.js:2:10: SyntaxError"),
        "{m}"
    );
    let logs = call(h, "mods.logs", json!({"id": "jsx"})).await.unwrap();
    assert!(
        logs.as_array()
            .unwrap()
            .iter()
            .any(|l| l.as_str().unwrap().contains("ui error: ui.js:2:10")),
        "{logs}"
    );
    // Fixed on save: the error goes away.
    std::fs::write(
        dir.join("ui.js"),
        "const h = 1;\nexport default function activate(ctx) {}\n",
    )
    .unwrap();
    let fixed = eventually(10, || async {
        let list = call(h, "mods.list", json!({})).await.unwrap();
        list.as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "jsx" && m["uiError"].is_null())
    })
    .await;
    assert!(fixed);
}

#[tokio::test]
async fn the_chosen_theme_is_kept_and_unusable_ones_are_refused() {
    let mut s = setup(&[], &[]).await;
    let h = &s.host;
    let themes = h.themes_dir();
    std::fs::write(themes.join("ok.json"), r#"{"name":"Ok","base":"dark"}"#).unwrap();
    std::fs::write(themes.join("bad.json"), r#"{"name":"Bad","base":"blue"}"#).unwrap();
    assert_eq!(
        call(h, "themes.current", json!({})).await.unwrap(),
        json!({"id": null})
    );
    while s.notes.try_recv().is_ok() {}
    call(h, "themes.use", json!({"id": "ok"})).await.unwrap();
    assert!(wait_note(&mut s.notes, "themes.use", 2).await);
    assert_eq!(
        call(h, "themes.current", json!({})).await.unwrap(),
        json!({"id": "ok"})
    );
    // Kept by the core settings, so a restarted daemon (and a new window) has it.
    assert_eq!(
        s.manager
            .get_setting(crate::host::THEME_KEY)
            .unwrap()
            .as_deref(),
        Some("ok")
    );

    let err = call(h, "themes.use", json!({"id": "bad"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("cannot be used") && err.contains("aura themes check bad"),
        "{err}"
    );
    assert!(call(h, "themes.use", json!({"id": "nope"})).await.is_err());
    assert_eq!(
        call(h, "themes.current", json!({})).await.unwrap(),
        json!({"id": "ok"}),
        "a refused theme changes nothing"
    );
    // Settings may still pick it (and shows why it falls back).
    call(h, "themes.use", json!({"id": "bad", "allowInvalid": true}))
        .await
        .unwrap();
    call(h, "themes.use", json!({"id": "light"})).await.unwrap();
    assert_eq!(
        call(h, "themes.current", json!({})).await.unwrap(),
        json!({"id": "light"})
    );
}

// ---- Review findings ----

#[tokio::test]
async fn only_the_window_grants_approval() {
    let mut s = setup(
        &[],
        &[(
            "b",
            json!({"permissions": {"process": ["git"]}}),
            "export default () => {}",
        )],
    )
    .await;
    let h = &s.host;
    let err = call_cli(h, "mods.approve", json!({"id": "b"}))
        .await
        .unwrap_err();
    let err = err.downcast::<crate::ModError>().unwrap();
    assert_eq!(err.code, "needs_window");
    assert_eq!(
        state_of(&call(h, "mods.list", json!({})).await.unwrap(), "b").as_deref(),
        Some("needs_approval")
    );
    // The CLI may ask the window to show the prompt.
    while s.notes.try_recv().is_ok() {}
    call_cli(h, "mods.request_approval", json!({"id": "b"}))
        .await
        .unwrap();
    let mut asked = false;
    while let Ok(n) = s.notes.try_recv() {
        asked |=
            n["method"] == "approval.request" && n["params"] == json!({"kind": "mod", "id": "b"});
    }
    assert!(asked);
    // A session token never grants, even from the window.
    assert!(h
        .handle_as("mods.approve", &json!({"id": "b"}), Some("s1"), true)
        .await
        .is_err());
    call(h, "mods.approve", json!({"id": "b"})).await.unwrap();
    assert_eq!(
        state_of(&call(h, "mods.list", json!({})).await.unwrap(), "b").as_deref(),
        Some("running")
    );
    assert!(
        call_cli(h, "mods.request_approval", json!({"id": "b"}))
            .await
            .is_err(),
        "nothing to approve now"
    );
}

#[tokio::test]
async fn a_changed_id_does_not_inherit_another_mods_approval() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let root = s._tmp.path().join("user");
    write_user_mod(
        &root,
        "a",
        "a",
        "export default (aura) => { aura.rpc.handle('who', () => 'a'); }",
    );
    write_user_mod(
        &root,
        "b",
        "b",
        "export default (aura) => { aura.rpc.handle('who', () => 'b'); }",
    );
    call(h, "mods.discover", json!({})).await.unwrap();
    call(h, "mods.approve", json!({"id": "a"})).await.unwrap();
    call(h, "mods.approve", json!({"id": "b"})).await.unwrap();

    // a's mod.json now claims b's id: refused on reload, and b keeps its folder.
    std::fs::write(
        root.join("a/mod.json"),
        json!({"id":"b","name":"b","version":"1.0.0","apiVersion":1,"daemon":"daemon.js"})
            .to_string(),
    )
    .unwrap();
    let err = call(h, "mods.reload", json!({"id": "a"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("cannot change in place"), "{err}");
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert_eq!(state_of(&list, "a"), None, "a is gone");
    assert_eq!(
        call(h, "mod.b.who", json!({})).await.unwrap(),
        json!("b"),
        "b still runs b's code"
    );
    let broken = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["broken"] == true)
        .unwrap();
    assert!(
        broken["status"]["error"]
            .as_str()
            .unwrap()
            .contains("already used"),
        "{broken}"
    );

    // A fresh id is a new mod: it waits for approval.
    std::fs::write(
        root.join("a/mod.json"),
        json!({"id":"c","name":"c","version":"1.0.0","apiVersion":1,"daemon":"daemon.js"})
            .to_string(),
    )
    .unwrap();
    call(h, "mods.discover", json!({})).await.unwrap();
    assert_eq!(
        state_of(&call(h, "mods.list", json!({})).await.unwrap(), "c").as_deref(),
        Some("needs_approval")
    );
}

#[tokio::test]
async fn an_approval_belongs_to_its_folder() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let root = s._tmp.path().join("user");
    write_user_mod(&root, "one", "moved", "export default () => {}");
    call(h, "mods.discover", json!({})).await.unwrap();
    call(h, "mods.approve", json!({"id": "moved"}))
        .await
        .unwrap();
    // Renamed folder: found at its new place, and asked again.
    std::fs::rename(root.join("one"), root.join("two")).unwrap();
    call(h, "mods.discover", json!({})).await.unwrap();
    let list = call(h, "mods.list", json!({})).await.unwrap();
    let m = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "moved")
        .unwrap();
    assert!(m["dir"].as_str().unwrap().ends_with("two"), "{m}");
    assert_eq!(m["status"]["state"], "needs_approval");
    // Another folder taking over a removed mod's id does not inherit its approval either.
    std::fs::remove_dir_all(root.join("two")).unwrap();
    call(h, "mods.discover", json!({})).await.unwrap();
    write_user_mod(&root, "three", "moved", "export default () => {}");
    call(h, "mods.discover", json!({})).await.unwrap();
    assert_eq!(
        state_of(&call(h, "mods.list", json!({})).await.unwrap(), "moved").as_deref(),
        Some("needs_approval")
    );
}

#[tokio::test]
async fn a_user_mod_replacing_a_bundled_one_is_reconciled_live() {
    let s = setup(
        &[(
            "x",
            json!({}),
            "export default (aura) => { aura.rpc.handle('who', () => 'bundled'); }",
        )],
        &[],
    )
    .await;
    let h = &s.host;
    assert_eq!(
        call(h, "mod.x.who", json!({})).await.unwrap(),
        json!("bundled")
    );
    write_user_mod(
        &s._tmp.path().join("user"),
        "x",
        "x",
        "export default (aura) => { aura.rpc.handle('who', () => 'user'); }",
    );
    call(h, "mods.discover", json!({})).await.unwrap();
    let list = call(h, "mods.list", json!({})).await.unwrap();
    let m = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "x")
        .unwrap();
    assert_eq!(m["source"], "user");
    assert_eq!(
        m["status"]["state"], "needs_approval",
        "the user's copy goes through approval"
    );
    assert!(
        call(h, "mod.x.who", json!({})).await.is_err(),
        "the bundled one was stopped"
    );
    call(h, "mods.approve", json!({"id": "x"})).await.unwrap();
    assert_eq!(
        call(h, "mod.x.who", json!({})).await.unwrap(),
        json!("user")
    );
}

#[tokio::test]
async fn edits_settle_and_broken_files_keep_the_running_version() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let root = s._tmp.path().join("user");
    let v = |n: u32| format!("export default (aura) => {{ aura.rpc.handle('v', () => {n}); }}");
    write_user_mod(&root, "w", "w", &v(1));
    call(h, "mods.discover", json!({})).await.unwrap();
    call(h, "mods.approve", json!({"id": "w"})).await.unwrap();
    let file = root.join("w/daemon.js");

    // A two-step save, 200 ms apart: only the finished file loads.
    std::fs::write(
        &file,
        "export default (aura) => { aura.rpc.handle('v', () =>",
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    std::fs::write(&file, v(2)).unwrap();
    assert!(
        eventually(10, || async {
            call(h, "mod.w.v", json!({})).await.ok() == Some(json!(2))
        })
        .await
    );
    let logs = call(h, "mods.logs", json!({"id": "w"})).await.unwrap();
    assert!(
        !logs.to_string().contains("not reloaded"),
        "the half-written file was never tried: {logs}"
    );

    // A broken file: the running version stays, and says why.
    std::fs::write(&file, "export default (aura) => {").unwrap();
    let reported = eventually(10, || async {
        let list = call(h, "mods.list", json!({})).await.unwrap();
        list.as_array().unwrap().iter().any(|m| {
            m["id"] == "w"
                && m["reloadError"]
                    .as_str()
                    .is_some_and(|e| e.contains("keeps running"))
        })
    })
    .await;
    assert!(reported);
    assert_eq!(
        call(h, "mod.w.v", json!({})).await.unwrap(),
        json!(2),
        "still the previous version"
    );

    // An atomic save (write elsewhere, rename over).
    std::fs::write(root.join("w/daemon.js.tmp"), v(3)).unwrap();
    std::fs::rename(root.join("w/daemon.js.tmp"), &file).unwrap();
    assert!(
        eventually(10, || async {
            call(h, "mod.w.v", json!({})).await.ok() == Some(json!(3))
        })
        .await
    );
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["id"] == "w" && m["reloadError"].is_null()));

    // A mod.json that does not parse: the running version stays too.
    let manifest = std::fs::read_to_string(root.join("w/mod.json")).unwrap();
    std::fs::write(root.join("w/mod.json"), "{ not json").unwrap();
    let reported = eventually(10, || async {
        let list = call(h, "mods.list", json!({})).await.unwrap();
        list.as_array().unwrap().iter().any(|m| {
            m["id"] == "w"
                && m["reloadError"]
                    .as_str()
                    .is_some_and(|e| e.contains("mod.json not loaded"))
        })
    })
    .await;
    assert!(reported);
    assert_eq!(call(h, "mod.w.v", json!({})).await.unwrap(), json!(3));
    std::fs::write(root.join("w/mod.json"), &manifest).unwrap();
    assert!(
        eventually(10, || async {
            let list = call(h, "mods.list", json!({})).await.unwrap();
            list.as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == "w" && m["reloadError"].is_null())
        })
        .await
    );

    // Deleted right after an edit: it goes, without a hang or a panic.
    std::fs::write(&file, v(4)).unwrap();
    std::fs::remove_dir_all(root.join("w")).unwrap();
    assert!(
        eventually(10, || async {
            state_of(&call(h, "mods.list", json!({})).await.unwrap(), "w").is_none()
        })
        .await
    );
    assert!(call(h, "mod.w.v", json!({})).await.is_err());
}

#[tokio::test]
async fn following_the_log_keeps_repeats_and_reports_rollover() {
    let s = setup(
        &[(
            "talk",
            json!({}),
            "export default (aura) => { aura.rpc.handle('say', ({n, text}) => { for (let i = 0; i < n; i++) console.log(text); }); }",
        )],
        &[],
    )
    .await;
    let h = &s.host;
    let page = |after: u64| async move {
        call(h, "mods.logs", json!({"id": "talk", "after": after}))
            .await
            .unwrap()
    };
    let start = page(0).await["last"].as_u64().unwrap_or(0);
    call(h, "mod.talk.say", json!({"n": 3, "text": "same"}))
        .await
        .unwrap();
    let p = page(start).await;
    let lines = p["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 3, "three identical lines, three entries: {p}");
    let seqs: Vec<u64> = lines.iter().map(|l| l["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    let last = p["last"].as_u64().unwrap();
    assert!(page(last).await["lines"].as_array().unwrap().is_empty());
    // More than the ring holds: `first` moves past where the follower was.
    call(h, "mod.talk.say", json!({"n": 400, "text": "flood"}))
        .await
        .unwrap();
    let p = page(last).await;
    assert!(p["first"].as_u64().unwrap() > last + 1, "{}", p["first"]);
    assert_eq!(p["lines"].as_array().unwrap().len(), 300);
}

#[tokio::test]
async fn ui_reports_are_rate_limited() {
    let s = setup(&[("r", json!({}), "export default () => {}")], &[]).await;
    let h = &s.host;
    let mut accepted = 0;
    for i in 0..50 {
        if call(
            h,
            "mods.ui_log",
            json!({"id": "r", "message": format!("boom {i}")}),
        )
        .await
        .unwrap()
            == json!(true)
        {
            accepted += 1;
        }
    }
    assert_eq!(accepted, 20);
    let logs = call(h, "mods.logs", json!({"id": "r"})).await.unwrap();
    assert_eq!(
        logs.as_array()
            .unwrap()
            .iter()
            .filter(|l| l.as_str().unwrap().contains("boom"))
            .count(),
        20
    );
    assert!(
        call(h, "mods.ui_log", json!({"id": "nope", "message": "x"}))
            .await
            .is_err(),
        "only installed mods"
    );
}

#[tokio::test]
async fn theme_css_waits_for_approval_of_that_exact_css() {
    let mut s = setup(&[], &[]).await;
    let h = &s.host;
    let dir = h.themes_dir();
    std::fs::write(
        dir.join("t.json"),
        r##"{"name":"T","base":"dark","tokens":{"--fg":"#eee"}}"##,
    )
    .unwrap();
    std::fs::write(
        dir.join("plain.json"),
        r##"{"name":"P","base":"dark","tokens":{"--fg":"#eee"}}"##,
    )
    .unwrap();
    std::fs::write(dir.join("t.css"), ".x { color: red }").unwrap();
    let get =
        |id: &'static str| async move { call(h, "themes.get", json!({"id": id})).await.unwrap() };
    let plain = get("plain").await;
    assert!(
        plain["approval"].is_null(),
        "tokens only: nothing to approve"
    );
    let t = get("t").await;
    assert_eq!(t["approval"], "needs_approval");
    assert!(t["css"].is_null(), "unapproved CSS is not handed out");
    assert_eq!(t["tokens"]["--fg"], "#eee", "its tokens apply meanwhile");

    assert_eq!(
        call_cli(h, "themes.approve", json!({"id": "t"}))
            .await
            .unwrap_err()
            .downcast::<crate::ModError>()
            .unwrap()
            .code,
        "needs_window"
    );
    while s.notes.try_recv().is_ok() {}
    call_cli(h, "themes.request_approval", json!({"id": "t"}))
        .await
        .unwrap();
    assert!(wait_note(&mut s.notes, "approval.request", 2).await);
    call(h, "themes.approve", json!({"id": "t"})).await.unwrap();
    let t = get("t").await;
    assert_eq!(t["approval"], "approved");
    assert_eq!(t["css"], ".x { color: red }");

    // Tokens may change freely; the CSS may not.
    std::fs::write(
        dir.join("t.json"),
        r##"{"name":"T","base":"dark","tokens":{"--fg":"#ddd"}}"##,
    )
    .unwrap();
    assert_eq!(get("t").await["approval"], "approved");
    std::fs::write(dir.join("t.css"), ".x { display: none }").unwrap();
    let t = get("t").await;
    assert_eq!(t["approval"], "needs_approval");
    assert!(t["css"].is_null());
}

#[tokio::test]
async fn approvals_from_before_folders_are_tied_or_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let u = tmp.path().join("user");
    write_user_mod(&u, "kept", "kept", "export default () => {}");
    let store: Arc<dyn Store> = Arc::new(aura_core::MemoryStore::default());
    let manager = Manager::new(store.clone(), vec![], None);
    // An approval saved by an older Aura: no folder.
    manager
        .set_setting(
            crate::storage::STATE_KEY,
            &json!({"disabled": [], "approved": {"kept": {}, "gone": {}}}).to_string(),
        )
        .unwrap();
    let (tx, _rx) = broadcast::channel(64);
    let h = ModHost::start(
        Config {
            dirs: vec![(ModSource::User, u.clone())],
            data_dir: tmp.path().join("data"),
        },
        manager.clone(),
        store,
        tx,
    )
    .await;
    assert_eq!(
        state_of(&call(&h, "mods.list", json!({})).await.unwrap(), "kept").as_deref(),
        Some("running"),
        "kept its approval"
    );
    let saved: Value = serde_json::from_str(
        &manager
            .get_setting(crate::storage::STATE_KEY)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(saved["approved_dirs"]["kept"]
        .as_str()
        .unwrap()
        .ends_with("kept"));
    assert!(
        saved["approved"].get("gone").is_none(),
        "an approval for no installed mod is dropped"
    );
    // A folder appearing later with that id must be approved anew.
    write_user_mod(&u, "late", "gone", "export default () => {}");
    call(&h, "mods.discover", json!({})).await.unwrap();
    assert_eq!(
        state_of(&call(&h, "mods.list", json!({})).await.unwrap(), "gone").as_deref(),
        Some("needs_approval")
    );
}

// ---- Security re-review ----

#[tokio::test]
async fn oversized_mod_files_are_refused_unread_and_the_daemon_stays_responsive() {
    let s = setup(&[], &[]).await;
    let h = &s.host;
    let root = s._tmp.path().join("user");
    // The re-review's case was a 58 MB ui.js; anything over the 4 MB cap is refused.
    let dir = root.join("huge");
    std::fs::create_dir_all(&dir).unwrap();
    let big = "let a = 1;\n".repeat(crate::manifest::MAX_SCRIPT_BYTES / 10 + 10_000);
    std::fs::write(dir.join("ui.js"), &big).unwrap();
    std::fs::write(
        dir.join("mod.json"),
        json!({"id":"huge","name":"Huge","version":"1.0.0","apiVersion":1,"ui":"ui.js"})
            .to_string(),
    )
    .unwrap();
    let started = std::time::Instant::now();
    call(h, "mods.discover", json!({})).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    let list = call(h, "mods.list", json!({})).await.unwrap();
    let broken = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["broken"] == true)
        .unwrap();
    assert!(
        broken["status"]["error"]
            .as_str()
            .unwrap()
            .contains("the limit is 4096 KB"),
        "{broken}"
    );
    // A huge mod.json too.
    let dir = root.join("bigmanifest");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("mod.json"),
        " ".repeat(crate::manifest::MAX_MANIFEST_BYTES + 1),
    )
    .unwrap();
    call(h, "mods.discover", json!({})).await.unwrap();
    let list = call(h, "mods.list", json!({})).await.unwrap();
    assert!(list.to_string().contains("mod.json is"), "{list}");
}

#[tokio::test]
async fn a_slow_syntax_check_is_given_up_and_never_blocks_the_runtime() {
    // A big (allowed) file, a deadline of nothing: the check gives up and says so,
    // while the runtime goes on answering.
    let text = "let a = 1;\n".repeat(300_000);
    let ticker = tokio::spawn(async {
        let mut n = 0;
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_millis(1)).await;
            n += 1;
        }
        n
    });
    let r =
        crate::runtime::check_module_syntax_within("ui.js", text, Duration::from_millis(1)).await;
    assert!(r.unwrap_err().contains("took longer"), "given up");
    assert_eq!(ticker.await.unwrap(), 5);
    assert_eq!(
        crate::runtime::check_module_syntax_within(
            "ui.js",
            "export default 1;".into(),
            Duration::from_secs(3)
        )
        .await,
        Ok(())
    );
}

#[tokio::test]
async fn ui_reports_cannot_forge_log_lines() {
    let s = setup(&[("r", json!({}), "export default () => {}")], &[]).await;
    let h = &s.host;
    // The re-review's case: a newline and a line that looks like Aura's own.
    call(
        h,
        "mods.ui_log",
        json!({"id": "r", "message": "boom\n12:00:00 info: mod approved by the user\u{1b}[2K"}),
    )
    .await
    .unwrap();
    let logs = call(h, "mods.logs", json!({"id": "r"})).await.unwrap();
    let entry = logs
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .find(|l| l.contains("boom"))
        .unwrap()
        .to_string();
    let mut lines = entry.lines();
    assert!(lines.next().unwrap().contains("ui error: boom"));
    assert_eq!(
        lines.next().unwrap(),
        "    │ 12:00:00 info: mod approved by the user\\u{1b}[2K"
    );
    assert!(!entry.contains('\u{1b}'));
}
