//! The mod host: finds mods, starts their daemon halves, and routes RPC,
//! notifications, core events and orchestrator tools to and from them.

use crate::manifest::{entry_path, Manifest, Permissions};
use crate::ops::ModOps;
use crate::runtime::{ModError, ModRuntime, OpResult};
use crate::storage::{Records, SETTINGS_NS, STATE_KEY};
use anyhow::{Context, Result};
use aura_core::{Manager, Store};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// The longest a `mod.<id>.<name>` call may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const LOG_LINES: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    /// Shipped with Aura. Trusted: approved without asking.
    Bundled,
    /// Installed by the user in `<data dir>/mods`.
    User,
    /// `$AURA_MODS_DIR`, reloaded when its files change.
    Dev,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", content = "error", rename_all = "snake_case")]
pub enum Status {
    Stopped,
    Disabled,
    /// Waiting for the user to approve its permissions.
    NeedsApproval,
    Starting,
    Running,
    Failed(String),
}

#[derive(Default, Serialize, Deserialize)]
struct SavedState {
    #[serde(default)]
    disabled: Vec<String>,
    /// The permissions the user approved, per mod.
    #[serde(default)]
    approved: BTreeMap<String, Permissions>,
}

pub(crate) struct Entry {
    manifest: Manifest,
    dir: PathBuf,
    source: ModSource,
    status: Status,
    runtime: Option<ModRuntime>,
    event_types: HashSet<String>,
    mod_subs: HashSet<(String, String)>,
    tools: Vec<Value>,
    logs: VecDeque<String>,
}

pub struct Config {
    /// Searched in order; a later folder's mod replaces an earlier one with the same id.
    pub dirs: Vec<(ModSource, PathBuf)>,
    pub data_dir: PathBuf,
}

pub(crate) struct Inner {
    pub(crate) manager: Manager,
    pub(crate) records: Records,
    pub(crate) http: crate::http::Http,
    notifications: broadcast::Sender<Value>,
    config: Config,
    tokio: tokio::runtime::Handle,
    mods: RwLock<BTreeMap<String, Entry>>,
    /// Folders that hold a mod.json that could not be loaded, with why.
    broken: RwLock<Vec<(PathBuf, String)>>,
    inbox: Mutex<BTreeMap<String, Vec<Value>>>,
    /// Agent runs a mod may cancel, by mod id and run id.
    pub(crate) runs: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    lifecycle: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct ModHost(Arc<Inner>);

impl ModHost {
    /// Find the mods and start every enabled one. Never fails as a whole: a mod
    /// that cannot start is marked failed and the rest go on.
    pub async fn start(
        config: Config,
        manager: Manager,
        store: Arc<dyn Store>,
        notifications: broadcast::Sender<Value>,
    ) -> ModHost {
        let inner = Arc::new(Inner {
            manager,
            records: Records::new(store),
            http: Default::default(),
            notifications,
            config,
            tokio: tokio::runtime::Handle::current(),
            mods: Default::default(),
            broken: Default::default(),
            inbox: Default::default(),
            runs: Default::default(),
            lifecycle: Default::default(),
        });
        let host = ModHost(inner);
        host.discover();
        host.forward_events();
        host.start_all().await;
        host.watch_dev_dirs();
        host
    }

    pub async fn shutdown(&self) {
        let _l = self.0.lifecycle.lock().await;
        let running: Vec<ModRuntime> = self
            .0
            .mods
            .write()
            .values_mut()
            .filter_map(|e| {
                e.status = Status::Stopped;
                e.runtime.take()
            })
            .collect();
        futures::future::join_all(running.iter().map(|r| r.stop())).await;
    }

    fn discover(&self) {
        let mut found: BTreeMap<String, Entry> = BTreeMap::new();
        let mut broken = vec![];
        for (source, root) in &self.0.config.dirs {
            let Ok(read) = std::fs::read_dir(root) else {
                continue;
            };
            let mut dirs: Vec<PathBuf> = read
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.join("mod.json").is_file())
                .collect();
            dirs.sort();
            for dir in dirs {
                match Manifest::load(&dir) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        if let Some(old) = found.get(&id) {
                            tracing::info!(mod_id = %id, "{} replaces {}", dir.display(), old.dir.display());
                        }
                        found.insert(
                            id,
                            Entry {
                                manifest,
                                dir,
                                source: *source,
                                status: Status::Stopped,
                                runtime: None,
                                event_types: HashSet::new(),
                                mod_subs: HashSet::new(),
                                tools: vec![],
                                logs: VecDeque::new(),
                            },
                        );
                    }
                    Err(e) => {
                        tracing::warn!("mod in {} not loaded: {e:#}", dir.display());
                        broken.push((dir, format!("{e:#}")));
                    }
                }
            }
        }
        tracing::info!(count = found.len(), "mods found");
        *self.0.mods.write() = found;
        *self.0.broken.write() = broken;
    }

    fn saved(&self) -> SavedState {
        self.0
            .manager
            .get_setting(STATE_KEY)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, state: &SavedState) -> Result<()> {
        self.0
            .manager
            .set_setting(STATE_KEY, &serde_json::to_string(state)?)
    }

    fn approved(&self, saved: &SavedState, e: &Entry) -> bool {
        e.source == ModSource::Bundled
            || saved
                .approved
                .get(&e.manifest.id)
                .is_some_and(|a| e.manifest.permissions.within(a))
    }

    /// Start every enabled, approved mod, dependencies first.
    async fn start_all(&self) {
        let ids: Vec<String> = self.0.mods.read().keys().cloned().collect();
        for id in ids {
            if let Err(e) = self.start_mod(&id, &mut vec![]).await {
                tracing::warn!(mod_id = %id, "not started: {}", e.message);
            }
        }
        self.changed();
    }

    /// Start `id` (and what it depends on) unless it runs already or may not.
    fn start_mod<'a>(
        &'a self,
        id: &'a str,
        chain: &'a mut Vec<String>,
    ) -> futures::future::BoxFuture<'a, Result<(), ModError>> {
        Box::pin(async move {
            let saved = self.saved();
            let (manifest, dir, source) = {
                let mut mods = self.0.mods.write();
                let Some(e) = mods.get_mut(id) else {
                    return Err(ModError::new("not_found", format!("no mod {id}")));
                };
                if matches!(e.status, Status::Running | Status::Starting) {
                    return Ok(());
                }
                if saved.disabled.contains(&e.manifest.id) {
                    e.status = Status::Disabled;
                    return Ok(());
                }
                if !self.approved(&saved, e) {
                    e.status = Status::NeedsApproval;
                    return Ok(());
                }
                e.status = Status::Starting;
                (e.manifest.clone(), e.dir.clone(), e.source)
            };
            let fail = |this: &Self, err: ModError| {
                if let Some(e) = this.0.mods.write().get_mut(id) {
                    e.status = Status::Failed(err.message.clone());
                    e.logs.push_back(format!("error: {}", err.message));
                }
                err
            };

            // Dependencies run first; a cycle or a missing one fails this mod.
            if chain.contains(&id.to_string()) {
                return Err(fail(self, ModError::invalid(format!("dependency cycle: {} → {id}", chain.join(" → ")))));
            }
            chain.push(id.to_string());
            for (dep, req) in &manifest.depends_on {
                let version = self.0.mods.read().get(dep).map(|d| d.manifest.version.clone());
                let Some(version) = version else {
                    return Err(fail(self, ModError::unavailable(format!("needs mod {dep}, which is not installed"))));
                };
                let fits = semver::VersionReq::parse(req)
                    .ok()
                    .zip(semver::Version::parse(&version).ok())
                    .is_some_and(|(r, v)| r.matches(&v));
                if !fits {
                    return Err(fail(self, ModError::unavailable(format!("needs {dep} {req}, found {version}"))));
                }
                self.start_mod(dep, chain).await.ok();
                let running = matches!(self.0.mods.read().get(dep).map(|d| &d.status), Some(Status::Running));
                if !running {
                    return Err(fail(self, ModError::unavailable(format!("needs mod {dep}, which is not running"))));
                }
            }
            chain.pop();

            let runtime = match &manifest.daemon {
                None => None,
                Some(rel) => {
                    let path = entry_path(&dir, rel).map_err(|e| fail(self, ModError::invalid(e.to_string())))?;
                    let source_code = std::fs::read_to_string(&path)
                        .map_err(|e| fail(self, ModError::failed(format!("read {}: {e}", path.display()))))?;
                    let data_dir = self.0.config.data_dir.join("mod-data").join(id);
                    std::fs::create_dir_all(&data_dir)
                        .map_err(|e| fail(self, ModError::failed(format!("create {}: {e}", data_dir.display()))))?;
                    let ops = Arc::new(ModOps {
                        host: Arc::downgrade(&self.0),
                        id: id.to_string(),
                        version: manifest.version.clone(),
                        data_dir,
                        permissions: manifest.permissions.clone(),
                    });
                    let started = ModRuntime::start(id, source_code, ops, self.0.tokio.clone()).await;
                    Some(started.map_err(|e| fail(self, e))?)
                }
            };
            if let Some(e) = self.0.mods.write().get_mut(id) {
                e.status = Status::Running;
                e.runtime = runtime;
            }
            tracing::info!(mod_id = %id, version = %manifest.version, source = ?source, "mod started");
            Ok(())
        })
    }

    async fn stop_mod(&self, id: &str) {
        let runtime = {
            let mut mods = self.0.mods.write();
            let Some(e) = mods.get_mut(id) else { return };
            e.event_types.clear();
            e.mod_subs.clear();
            e.tools.clear();
            if matches!(e.status, Status::Running | Status::Starting) {
                e.status = Status::Stopped;
            }
            e.runtime.take()
        };
        if self.0.inbox.lock().remove(id).is_some() {
            self.0.broadcast("mods.inbox.changed", json!({"modId": id}));
        }
        if let Some(r) = runtime {
            r.stop().await;
            tracing::info!(mod_id = %id, "mod stopped");
        }
    }

    /// Re-read a mod's files and restart it.
    pub async fn reload(&self, id: &str) -> Result<(), ModError> {
        let _l = self.0.lifecycle.lock().await;
        self.stop_mod(id).await;
        let dir = self.0.mods.read().get(id).map(|e| e.dir.clone());
        if let Some(dir) = dir {
            match Manifest::load(&dir) {
                Ok(m) => {
                    if let Some(e) = self.0.mods.write().get_mut(id) {
                        e.manifest = m;
                        e.status = Status::Stopped;
                    }
                }
                Err(err) => {
                    if let Some(e) = self.0.mods.write().get_mut(id) {
                        e.status = Status::Failed(format!("{err:#}"));
                    }
                    self.changed();
                    return Err(ModError::invalid(format!("{err:#}")));
                }
            }
        }
        let r = self.start_mod(id, &mut vec![]).await;
        self.changed();
        r
    }

    fn changed(&self) {
        self.0.broadcast("mods.changed", json!({}));
    }

    /// Core events to the mods that listen for them; session data goes with its session.
    fn forward_events(&self) {
        let mut rx = self.0.manager.subscribe();
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                let ev = match rx.recv().await {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("mods missed {n} core events");
                        continue;
                    }
                    Err(_) => break,
                };
                let Some(inner) = weak.upgrade() else { break };
                let value = match serde_json::to_value(&ev) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let kind = value.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                if kind == "session_removed" {
                    inner.forget_session(ev.session_id());
                }
                let targets: Vec<ModRuntime> = inner
                    .mods
                    .read()
                    .values()
                    .filter(|e| {
                        e.manifest.permissions.reads_sessions()
                            && (e.event_types.contains(&kind) || e.event_types.contains("*"))
                    })
                    .filter_map(|e| e.runtime.clone())
                    .collect();
                for r in targets {
                    r.dispatch("event", value.clone());
                }
            }
        });
    }

    /// Reload a dev mod when its files change.
    fn watch_dev_dirs(&self) {
        use notify::{RecursiveMode, Watcher};
        let dev: Vec<PathBuf> = self
            .0
            .config
            .dirs
            .iter()
            .filter(|(s, _)| *s == ModSource::Dev)
            .map(|(_, p)| p.clone())
            .collect();
        if dev.is_empty() {
            return;
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("cannot watch dev mods: {e}");
                return;
            }
        };
        for d in &dev {
            if let Err(e) = watcher.watch(d, RecursiveMode::Recursive) {
                tracing::warn!("cannot watch {}: {e}", d.display());
            }
        }
        let host = self.clone();
        tokio::spawn(async move {
            let _keep = watcher;
            while let Some(first) = rx.recv().await {
                let mut paths = vec![first];
                // Builds write several files; settle first.
                tokio::time::sleep(Duration::from_millis(400)).await;
                while let Ok(p) = rx.try_recv() {
                    paths.push(p);
                }
                let ids: HashSet<String> = {
                    let mods = host.0.mods.read();
                    paths
                        .iter()
                        .filter_map(|p| mods.values().find(|e| p.starts_with(&e.dir)).map(|e| e.manifest.id.clone()))
                        .collect()
                };
                for id in ids {
                    tracing::info!(mod_id = %id, "files changed; reloading");
                    let _ = host.reload(&id).await;
                }
            }
        });
    }

    /// The `mods.*` and `mod.<id>.*` RPC methods. `session` is the calling
    /// session when the connection holds a session token.
    pub async fn handle(&self, method: &str, params: &Value, session: Option<&str>) -> Result<Option<Value>> {
        if let Some(rest) = method.strip_prefix("mod.") {
            let Some((id, name)) = rest.split_once('.') else {
                anyhow::bail!("mod methods are mod.<id>.<name>");
            };
            let caller = match session {
                Some(s) => json!({"kind": "session", "sessionId": s}),
                None => json!({"kind": "user"}),
            };
            return Ok(Some(self.0.call_mod(id, name, params.clone(), caller).await?));
        }
        let id = || -> Result<String> {
            params
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .context("id is required")
        };
        Ok(Some(match method {
            "mods.list" => self.list(),
            "mods.ui_source" => self.ui_source(&id()?)?,
            "mods.enable" | "mods.disable" => {
                let id = id()?;
                let enable = method == "mods.enable";
                let mut saved = self.saved();
                saved.disabled.retain(|d| d != &id);
                if !enable {
                    saved.disabled.push(id.clone());
                }
                self.save(&saved)?;
                {
                    let _l = self.0.lifecycle.lock().await;
                    if enable {
                        if let Some(e) = self.0.mods.write().get_mut(&id) {
                            e.status = Status::Stopped;
                        }
                        let _ = self.start_mod(&id, &mut vec![]).await;
                    } else {
                        self.stop_mod(&id).await;
                        if let Some(e) = self.0.mods.write().get_mut(&id) {
                            e.status = Status::Disabled;
                        }
                    }
                }
                self.changed();
                json!(true)
            }
            "mods.approve" => {
                let id = id()?;
                let perms = self
                    .0
                    .mods
                    .read()
                    .get(&id)
                    .map(|e| e.manifest.permissions.clone())
                    .context("no such mod")?;
                let mut saved = self.saved();
                saved.approved.insert(id.clone(), perms);
                self.save(&saved)?;
                {
                    let _l = self.0.lifecycle.lock().await;
                    if let Some(e) = self.0.mods.write().get_mut(&id) {
                        e.status = Status::Stopped;
                    }
                    let _ = self.start_mod(&id, &mut vec![]).await;
                }
                self.changed();
                json!(true)
            }
            "mods.reload" => {
                let id = id()?;
                self.reload(&id).await?;
                json!(true)
            }
            "mods.rescan" => {
                let _l = self.0.lifecycle.lock().await;
                let ids: Vec<String> = self.0.mods.read().keys().cloned().collect();
                for id in ids {
                    self.stop_mod(&id).await;
                }
                self.discover();
                drop(_l);
                self.start_all().await;
                json!(true)
            }
            "mods.logs" => {
                let id = id()?;
                json!(self.0.mods.read().get(&id).map(|e| e.logs.iter().cloned().collect::<Vec<_>>()).unwrap_or_default())
            }
            "mods.settings.get" => self.0.settings_of(&id()?),
            "mods.settings.set" => {
                let key = params.get("key").and_then(Value::as_str).context("key is required")?;
                self.0.set_setting(&id()?, key, params.get("value").cloned().unwrap_or(Value::Null))?;
                json!(true)
            }
            // What a mod's new-session field contributed, stored on the new session for that mod.
            "mods.session_data.set" => {
                let id = id()?;
                let sid = params.get("sessionId").and_then(Value::as_str).context("sessionId is required")?;
                let key = params.get("key").and_then(Value::as_str).context("key is required")?;
                if !self.0.mods.read().contains_key(&id) {
                    anyhow::bail!("no mod {id}");
                }
                self.0.manager.get_session(sid)?;
                let value = params.get("value").cloned().filter(|v| !v.is_null());
                self.0.records.set_field(&crate::storage::sessions_ns(&id), sid, key, value)?;
                json!(true)
            }
            "mods.inbox" => json!(self
                .0
                .inbox
                .lock()
                .iter()
                .map(|(m, items)| json!({"modId": m, "items": items}))
                .collect::<Vec<_>>()),
            "mods.tools.list" => json!(self.tools()),
            "mods.tools.call" => {
                let Some(session) = session else {
                    anyhow::bail!("mods.tools.call acts for an orchestrator session and needs its session token");
                };
                let name = params.get("name").and_then(Value::as_str).context("name is required")?;
                let args = params.get("args").cloned().unwrap_or_else(|| json!({}));
                self.call_tool(name, args, session).await?
            }
            _ => return Ok(None),
        }))
    }

    fn list(&self) -> Value {
        let saved = self.saved();
        let mods = self.0.mods.read();
        let mut out: Vec<Value> = mods
            .values()
            .map(|e| {
                let m = &e.manifest;
                json!({
                    "id": m.id,
                    "name": m.name,
                    "version": m.version,
                    "description": m.description,
                    "author": m.author,
                    "source": e.source,
                    "dir": e.dir.to_string_lossy(),
                    "status": e.status,
                    "enabled": !saved.disabled.contains(&m.id),
                    "approved": self.approved(&saved, e),
                    "hasUi": m.ui.is_some(),
                    "hasDaemon": m.daemon.is_some(),
                    "permissions": m.permissions,
                    "dependsOn": m.depends_on,
                    "settings": m.settings,
                    "settingValues": self.0.settings_of(&m.id),
                })
            })
            .collect();
        for (dir, error) in self.0.broken.read().iter() {
            out.push(json!({
                "id": dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "name": dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "dir": dir.to_string_lossy(),
                "status": {"state": "failed", "error": error},
                "broken": true,
            }));
        }
        json!(out)
    }

    fn ui_source(&self, id: &str) -> Result<Value> {
        let (manifest, dir, status) = {
            let mods = self.0.mods.read();
            let e = mods.get(id).context("no such mod")?;
            (e.manifest.clone(), e.dir.clone(), e.status.clone())
        };
        if status != Status::Running {
            anyhow::bail!("mod {id} is not running");
        }
        let read = |rel: &Option<String>| -> Result<Option<String>> {
            match rel {
                None => Ok(None),
                Some(r) => Ok(Some(std::fs::read_to_string(entry_path(&dir, r)?)?)),
            }
        };
        Ok(json!({
            "id": id,
            "version": manifest.version,
            "js": read(&manifest.ui)?,
            "css": read(&manifest.styles)?,
        }))
    }

    fn tool_prefix(id: &str) -> String {
        format!("{}_", id.replace('-', "_"))
    }

    fn tools(&self) -> Vec<Value> {
        let mods = self.0.mods.read();
        mods.values()
            .filter(|e| e.status == Status::Running && e.manifest.permissions.orchestrator_tools)
            .flat_map(|e| {
                let prefix = Self::tool_prefix(&e.manifest.id);
                e.tools.iter().map(move |t| {
                    let mut t = t.clone();
                    if let Some(name) = t.get("name").and_then(Value::as_str) {
                        t["name"] = json!(format!("{prefix}{name}"));
                    }
                    t
                })
            })
            .collect()
    }

    async fn call_tool(&self, full: &str, args: Value, session: &str) -> Result<Value> {
        let (runtime, name) = {
            let mods = self.0.mods.read();
            let found = mods.values().find_map(|e| {
                let prefix = Self::tool_prefix(&e.manifest.id);
                let name = full.strip_prefix(&prefix)?;
                let has = e.tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name));
                (has && e.manifest.permissions.orchestrator_tools)
                    .then(|| e.runtime.clone().map(|r| (r, name.to_string())))
                    .flatten()
            });
            found.with_context(|| format!("no tool {full}"))?
        };
        let r = tokio::time::timeout(
            CALL_TIMEOUT,
            runtime.call(
                "__tool",
                json!({"name": name, "args": args, "sessionId": session}),
                json!({"kind": "session", "sessionId": session}),
            ),
        )
        .await
        .map_err(|_| ModError::new("timeout", "the tool did not answer in time"))?;
        Ok(r?)
    }

    #[cfg(test)]
    pub(crate) fn inner(&self) -> &Arc<Inner> {
        &self.0
    }
}

impl Inner {
    pub(crate) fn broadcast(&self, method: &str, params: Value) {
        let _ = self.notifications.send(json!({"method": method, "params": params}));
    }

    pub(crate) fn log(&self, id: &str, level: &str, message: &str) {
        if let Some(e) = self.mods.write().get_mut(id) {
            let line = format!(
                "{} {level}: {}",
                chrono::Local::now().format("%H:%M:%S"),
                message.chars().take(4000).collect::<String>()
            );
            e.logs.push_back(line);
            while e.logs.len() > LOG_LINES {
                e.logs.pop_front();
            }
        }
    }

    /// `aura.emit`: to the UIs, and to mods that listen to this one.
    pub(crate) fn emit(&self, id: &str, name: &str, payload: Value) {
        self.broadcast(&format!("mod.{id}.{name}"), payload.clone());
        let key = (id.to_string(), name.to_string());
        let targets: Vec<ModRuntime> = self
            .mods
            .read()
            .values()
            .filter(|e| e.mod_subs.contains(&key) && e.manifest.permissions.mods.iter().any(|m| m == id))
            .filter_map(|e| e.runtime.clone())
            .collect();
        for r in targets {
            r.dispatch("modEvent", json!({"modId": id, "name": name, "payload": payload}));
        }
    }

    pub(crate) fn dispatch_to(&self, id: &str, kind: &'static str, payload: Value) {
        let r = self.mods.read().get(id).and_then(|e| e.runtime.clone());
        if let Some(r) = r {
            r.dispatch(kind, payload);
        }
    }

    pub(crate) fn set_event_types(&self, id: &str, types: HashSet<String>) {
        if let Some(e) = self.mods.write().get_mut(id) {
            e.event_types = types;
        }
    }

    pub(crate) fn set_mod_subs(&self, id: &str, subs: HashSet<(String, String)>) {
        if let Some(e) = self.mods.write().get_mut(id) {
            e.mod_subs = subs;
        }
    }

    pub(crate) fn set_tools(&self, id: &str, tools: Vec<Value>) {
        if let Some(e) = self.mods.write().get_mut(id) {
            e.tools = tools;
        }
        self.broadcast("mods.tools.changed", json!({"modId": id}));
    }

    pub(crate) fn set_inbox(&self, id: &str, items: Vec<Value>) {
        self.inbox.lock().insert(id.to_string(), items);
        self.broadcast("mods.inbox.changed", json!({"modId": id}));
    }

    pub(crate) fn settings_of(&self, id: &str) -> Value {
        let stored = match self.records.get(SETTINGS_NS, id).ok().flatten() {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        match self.mods.read().get(id) {
            Some(e) => e.manifest.settings_with(&stored),
            None => Value::Object(stored),
        }
    }

    pub(crate) fn set_setting(&self, id: &str, key: &str, value: Value) -> Result<(), ModError> {
        let value = (!value.is_null()).then_some(value);
        self.records.set_field(SETTINGS_NS, id, key, value.clone())?;
        let all = self.settings_of(id);
        let effective = all.get(key).cloned().unwrap_or(Value::Null);
        self.dispatch_to(id, "settings", json!({"key": key, "value": effective, "all": all}));
        self.broadcast("mods.settings.changed", json!({"modId": id, "key": key, "value": effective}));
        Ok(())
    }

    pub(crate) async fn call_mod(&self, id: &str, name: &str, params: Value, caller: Value) -> OpResult {
        let runtime = {
            let mods = self.mods.read();
            let e = mods
                .get(id)
                .ok_or_else(|| ModError::new("not_found", format!("no mod {id}")))?;
            match (&e.status, &e.runtime) {
                (Status::Running, Some(r)) => r.clone(),
                (Status::Running, None) => {
                    return Err(ModError::new("not_found", format!("mod {id} has no daemon half")))
                }
                (status, _) => {
                    return Err(ModError::unavailable(format!("mod {id} is not running ({status:?})")))
                }
            }
        };
        tokio::time::timeout(CALL_TIMEOUT, runtime.call(name, params, caller))
            .await
            .map_err(|_| ModError::new("timeout", format!("mod.{id}.{name} did not answer in time")))?
    }

    fn forget_session(&self, sid: &str) {
        let ids: Vec<String> = self.mods.read().keys().cloned().collect();
        for id in ids {
            let _ = self.records.delete(&crate::storage::sessions_ns(&id), sid);
        }
    }
}

/// Where Aura's own mods are, next to the executable: `<exe dir>/mods`, or
/// macOS's `Contents/Resources/mods`, or Tauri's `resources/mods`.
pub fn bundled_dir_near(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    [
        dir.join("mods"),
        dir.join("resources").join("mods"),
        dir.join("../Resources/mods"),
        dir.join("../lib/aura/mods"),
        dir.join("../lib/Aura/mods"),
    ]
    .into_iter()
    .find(|p| p.is_dir())
}
