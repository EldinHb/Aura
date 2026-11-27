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
/// File events settle for this long, with no new event, before mods reload.
const QUIET: Duration = Duration::from_millis(400);
/// A burst of events never delays a reload longer than this.
const MAX_SETTLE: Duration = Duration::from_secs(5);
/// `mods.ui_log`: at most this many reports per mod per window.
const UI_LOG_LIMIT: u32 = 20;
const UI_LOG_WINDOW: Duration = Duration::from_secs(10);
/// Core setting with the approved CSS of themes (`themes.approve`).
pub const THEMES_STATE_KEY: &str = "themes.state.v1";
/// Core setting holding the theme the windows show (`themes.use`).
pub const THEME_KEY: &str = "ui.theme";

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
    /// The folder each approval was given for. An approval holds only for that
    /// folder, so another folder cannot take over an approved mod's id.
    #[serde(default)]
    approved_dirs: BTreeMap<String, String>,
}

/// Themes whose CSS the user approved: the exact CSS, per theme id and file.
#[derive(Default, Serialize, Deserialize)]
struct ThemesState {
    #[serde(default)]
    approved: BTreeMap<String, ApprovedCss>,
}

#[derive(Serialize, Deserialize, PartialEq)]
struct ApprovedCss {
    path: String,
    css: String,
}

/// A message as one log entry that cannot pass for another: control
/// characters (escape sequences, carriage returns, …) are shown as `\u{..}`,
/// tabs become spaces, and every line after the first is indented under a
/// bar, so no line of a message can look like a line of its own
/// ("12:00:00 info: …").
fn log_text(message: &str) -> String {
    let normal = message.replace("\r\n", "\n");
    let mut out = String::with_capacity(normal.len());
    for (i, line) in normal.split('\n').enumerate() {
        if i > 0 {
            out.push_str("\n    │ ");
        }
        for c in line.chars() {
            match c {
                '\t' => out.push(' '),
                // Controls, line and paragraph separators, and bidi overrides (which reorder what shows).
                c if c.is_control()
                    || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') =>
                {
                    out.push_str(&format!("\\u{{{:x}}}", c as u32))
                }
                c => out.push(c),
            }
        }
    }
    out
}

#[cfg(test)]
mod log_text_tests {
    #[test]
    fn a_message_cannot_forge_a_log_line() {
        let forged = super::log_text("boom\n12:00:00 info: mod approved by the user\r12:00:01 info: x\u{1b}[2K\u{202e}desrever\tend");
        assert!(
            !forged.lines().skip(1).any(|l| !l.starts_with("    │ ")),
            "{forged}"
        );
        assert!(
            !forged.contains('\r')
                && !forged.contains('\u{1b}')
                && !forged.contains('\u{202e}')
                && !forged.contains('\t'),
            "{forged}"
        );
        assert!(
            forged.contains("\\u{d}") && forged.contains("\\u{1b}") && forged.contains("\\u{202e}")
        );
        assert_eq!(super::log_text("plain"), "plain");
    }
}

/// A folder's identity for approvals.
fn identity(dir: &Path) -> String {
    std::fs::canonicalize(dir)
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// What a mod's files were when it was (re)loaded, to tell what changed.
#[derive(Clone, Default, PartialEq, Debug)]
struct Stamp {
    manifest: u64,
    daemon: u64,
    ui: u64,
}

/// A file's content hash, reading at most a script's cap (plus one byte): a
/// larger file is told apart by its size and time only, never read whole.
fn file_hash(path: Option<PathBuf>) -> u64 {
    use std::hash::{Hash, Hasher};
    use std::io::Read;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let Some(path) = path else {
        0u8.hash(&mut h);
        return h.finish();
    };
    match std::fs::File::open(&path) {
        Err(_) => 1u8.hash(&mut h),
        Ok(f) => {
            let meta = f.metadata().ok();
            let mut bytes = Vec::new();
            let _ = f
                .take(crate::manifest::MAX_SCRIPT_BYTES as u64 + 1)
                .read_to_end(&mut bytes);
            if bytes.len() > crate::manifest::MAX_SCRIPT_BYTES {
                (
                    meta.as_ref().map(|m| m.len()),
                    meta.and_then(|m| m.modified().ok()),
                )
                    .hash(&mut h);
            } else {
                bytes.hash(&mut h);
            }
        }
    }
    h.finish()
}

impl Stamp {
    fn of(dir: &Path, m: &Manifest) -> Stamp {
        let at = |rel: &Option<String>| rel.as_deref().and_then(|r| entry_path(dir, r).ok());
        Stamp {
            manifest: file_hash(Some(dir.join("mod.json"))),
            daemon: file_hash(at(&m.daemon)),
            ui: file_hash(at(&m.ui)) ^ file_hash(at(&m.styles)).rotate_left(1),
        }
    }
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
    /// The last lines of the mod's log, each with a sequence number that only grows.
    logs: VecDeque<(u64, String)>,
    /// Why the UI half's file does not parse, if it does not.
    ui_error: Option<String>,
    /// Why the files on disk were not loaded (the previous version keeps running).
    reload_error: Option<String>,
    /// Bumped whenever the UI half must load again.
    ui_rev: u64,
    stamp: Stamp,
}

impl Entry {
    fn new(manifest: Manifest, dir: PathBuf, source: ModSource) -> Entry {
        let stamp = Stamp::of(&dir, &manifest);
        Entry {
            manifest,
            dir,
            source,
            status: Status::Stopped,
            runtime: None,
            event_types: HashSet::new(),
            mod_subs: HashSet::new(),
            tools: vec![],
            logs: VecDeque::new(),
            ui_error: None,
            reload_error: None,
            ui_rev: 0,
            stamp,
        }
    }
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
    /// Sequence numbers of log lines, across all mods.
    log_seq: std::sync::atomic::AtomicU64,
    /// `mods.ui_log` rate limit per mod: window start, reports in it, dropped in it.
    ui_reports: Mutex<std::collections::HashMap<String, (std::time::Instant, u32, u32)>>,
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
            log_seq: Default::default(),
            ui_reports: Default::default(),
        });
        let host = ModHost(inner);
        host.discover();
        host.migrate_approvals();
        host.forward_events();
        host.start_all().await;
        host.watch_dirs();
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

    /// Every mod in the configured folders by id, and the folders whose
    /// mod.json does not load (or whose id another folder holds). A later
    /// source (user over bundled, dev over user) replaces an earlier one's
    /// mod with the same id; within one source the folder that holds the id
    /// now keeps it, so a second folder cannot take it over.
    fn scan(&self) -> (BTreeMap<String, Entry>, Vec<(PathBuf, String)>) {
        let incumbents: BTreeMap<String, PathBuf> = self
            .0
            .mods
            .read()
            .iter()
            .map(|(id, e)| (id.clone(), e.dir.clone()))
            .collect();
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
            // This source's folders by id, the incumbent first.
            let mut here: BTreeMap<String, Entry> = BTreeMap::new();
            for dir in dirs {
                match Manifest::load(&dir) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        let entry = Entry::new(manifest, dir.clone(), *source);
                        match here.get(&id) {
                            None => {
                                here.insert(id, entry);
                            }
                            Some(other) => {
                                let keep_new = incumbents.get(&id) == Some(&dir)
                                    && incumbents.get(&id) != Some(&other.dir);
                                let (winner, loser) = if keep_new {
                                    (entry, other.dir.clone())
                                } else {
                                    (here.remove(&id).unwrap(), dir.clone())
                                };
                                let msg = format!(
                                    "its id {id:?} is already used by {}",
                                    winner.dir.display()
                                );
                                tracing::warn!("mod in {} not loaded: {msg}", loser.display());
                                broken.push((loser, msg));
                                here.insert(id, winner);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("mod in {} not loaded: {e:#}", dir.display());
                        broken.push((dir, format!("{e:#}")));
                    }
                }
            }
            for (id, e) in here {
                if let Some(old) = found.get(&id) {
                    tracing::info!(mod_id = %id, "{} replaces {}", e.dir.display(), old.dir.display());
                }
                found.insert(id, e);
            }
        }
        broken.sort();
        (found, broken)
    }

    fn discover(&self) {
        let (found, broken) = self.scan();
        tracing::info!(count = found.len(), "mods found");
        *self.0.mods.write() = found;
        *self.0.broken.write() = broken;
    }

    /// Approvals from before they were tied to a folder: tie each to the folder
    /// that holds its mod now, and drop those whose mod is not installed.
    fn migrate_approvals(&self) {
        let mut saved = self.saved();
        let legacy: Vec<String> = saved
            .approved
            .keys()
            .filter(|id| !saved.approved_dirs.contains_key(*id))
            .cloned()
            .collect();
        if legacy.is_empty() {
            return;
        }
        for id in legacy {
            match self.0.mods.read().get(&id) {
                Some(e) => {
                    saved.approved_dirs.insert(id, identity(&e.dir));
                }
                None => {
                    saved.approved.remove(&id);
                }
            }
        }
        let _ = self.save(&saved);
    }

    /// Bring the running mods in line with the folders: new, removed, moved
    /// and renamed folders, a user mod replacing a bundled one, and changed
    /// files. A changed half reloads alone (ui.js/ui.css: the UI half;
    /// daemon.js: the daemon half; mod.json: both). New files are checked
    /// first: if they do not load, the running version stays and the reason
    /// is logged. Returns whether anything changed.
    pub async fn reconcile(&self) -> bool {
        // Read and syntax-check changed daemon files first, without the
        // lifecycle lock and off the async runtime: a slow file then holds
        // up nothing else (enable, approve, other reloads).
        let (mut found, broken) = self.scan();
        let mut checked: BTreeMap<String, Option<String>> = BTreeMap::new();
        let stamps: BTreeMap<String, Stamp> = self
            .0
            .mods
            .read()
            .iter()
            .map(|(id, e)| (id.clone(), e.stamp.clone()))
            .collect();
        for (id, c) in &found {
            if stamps.get(id) == Some(&c.stamp) {
                continue;
            }
            if let Some(rel) = &c.manifest.daemon {
                let problem = match entry_path(&c.dir, rel).and_then(|p| {
                    crate::manifest::read_mod_file(&p, crate::manifest::MAX_SCRIPT_BYTES)
                }) {
                    Ok(t) => crate::runtime::check_module_syntax_within(
                        rel,
                        t,
                        crate::runtime::SYNTAX_CHECK_LIMIT,
                    )
                    .await
                    .err(),
                    Err(e) => Some(format!("{rel}: {e:#}")),
                };
                checked.insert(id.clone(), problem);
            }
        }
        let _l = self.0.lifecycle.lock().await;
        let mut changed = false;
        let broken_dirs: HashSet<PathBuf> = broken.iter().map(|(d, _)| d.clone()).collect();
        let current: Vec<(String, PathBuf, ModSource, Stamp, bool)> = self
            .0
            .mods
            .read()
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    e.dir.clone(),
                    e.source,
                    e.stamp.clone(),
                    matches!(e.status, Status::Running),
                )
            })
            .collect();
        for (id, dir, source, stamp, running) in current {
            let same_place = found
                .get(&id)
                .is_some_and(|c| c.dir == dir && c.source == source);
            if !same_place {
                // A new mod.json that does not load: keep what runs, say why.
                // (An id clash is not that: a valid mod.json with a new id is a new mod.)
                if dir.join("mod.json").is_file()
                    && broken_dirs.contains(&dir)
                    && !found.values().any(|c| c.dir == dir)
                    && Manifest::load(&dir).is_err()
                {
                    let why = broken
                        .iter()
                        .find(|(d, _)| *d == dir)
                        .map(|(_, w)| w.clone())
                        .unwrap_or_default();
                    self.set_reload_error(
                        &id,
                        Some(format!(
                            "mod.json not loaded, the previous version keeps running: {why}"
                        )),
                    );
                    found.remove(&id);
                    changed = true;
                    continue;
                }
                // Gone, moved, renamed, its id changed, or replaced by another source's folder.
                self.stop_mod(&id).await;
                self.0.mods.write().remove(&id);
                tracing::info!(mod_id = %id, dir = %dir.display(), "mod removed or replaced");
                changed = true;
                continue;
            }
            let c = found.remove(&id).expect("same place");
            if c.stamp == stamp {
                // The files are back to what runs: nothing to report any more.
                let pending = self
                    .0
                    .mods
                    .read()
                    .get(&id)
                    .is_some_and(|e| e.reload_error.is_some());
                if pending {
                    self.0.log(
                        &id,
                        "info",
                        "the files on disk match the running version again",
                    );
                    self.set_reload_error(&id, None);
                    changed = true;
                }
                continue;
            }
            changed = true;
            self.set_reload_error(&id, None);
            if c.stamp.manifest != stamp.manifest || c.stamp.daemon != stamp.daemon || !running {
                // The daemon file was checked above, before anything stops.
                if c.manifest.daemon.is_some() {
                    if let Some(Some(p)) = checked.get(&id).cloned() {
                        if running {
                            self.set_reload_error(
                                &id,
                                Some(format!(
                                    "not reloaded, the previous version keeps running: {p}"
                                )),
                            );
                            continue;
                        }
                    }
                }
                let what = if c.stamp.manifest != stamp.manifest {
                    "mod.json changed; reloading both halves"
                } else if c.stamp.daemon != stamp.daemon {
                    "daemon files changed; restarting the daemon half (the UI half stays)"
                } else {
                    "files changed; starting again"
                };
                self.0.log(&id, "info", what);
                let both = c.stamp.manifest != stamp.manifest || c.stamp.ui != stamp.ui;
                self.stop_mod(&id).await;
                if let Some(e) = self.0.mods.write().get_mut(&id) {
                    e.manifest = c.manifest.clone();
                    e.stamp = c.stamp.clone();
                    e.status = Status::Stopped;
                    if both {
                        e.ui_rev += 1;
                    }
                }
                if let Err(e) = self.start_mod(&id, &mut vec![]).await {
                    tracing::warn!(mod_id = %id, "not started: {}", e.message);
                }
            } else {
                // Only the UI half's files.
                if let Some(e) = self.0.mods.write().get_mut(&id) {
                    e.stamp = c.stamp.clone();
                }
                self.reload_ui(&id);
            }
        }
        // New folders, and the new place of moved or replaced ones: the normal
        // approval check applies, so a new folder never inherits an approval.
        let added: Vec<String> = found.keys().cloned().collect();
        {
            let mut mods = self.0.mods.write();
            for (id, e) in found {
                tracing::info!(mod_id = %id, dir = %e.dir.display(), "mod found");
                mods.insert(id, e);
            }
        }
        for id in &added {
            changed = true;
            if let Err(e) = self.start_mod(id, &mut vec![]).await {
                tracing::warn!(mod_id = %id, "not started: {}", e.message);
            }
        }
        // Broken folders that are not a running mod's pending files.
        let held: HashSet<PathBuf> = self.0.mods.read().values().map(|e| e.dir.clone()).collect();
        let broken: Vec<(PathBuf, String)> = broken
            .into_iter()
            .filter(|(d, _)| !held.contains(d))
            .collect();
        if *self.0.broken.read() != broken {
            *self.0.broken.write() = broken;
            changed = true;
        }
        drop(_l);
        if changed {
            self.changed();
        }
        changed
    }

    fn set_reload_error(&self, id: &str, error: Option<String>) {
        if let Some(e) = &error {
            self.0.log(id, "error", e);
        }
        if let Some(e) = self.0.mods.write().get_mut(id) {
            e.reload_error = error;
        }
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

    /// Bundled mods are trusted. Any other mod needs an approval given for
    /// this id, in this folder, that covers its permissions.
    fn approved(&self, saved: &SavedState, e: &Entry) -> bool {
        e.source == ModSource::Bundled
            || (saved
                .approved
                .get(&e.manifest.id)
                .is_some_and(|a| e.manifest.permissions.within(a))
                && saved
                    .approved_dirs
                    .get(&e.manifest.id)
                    .is_some_and(|d| *d == identity(&e.dir)))
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
                }
                this.0.log(id, "error", &err.message);
                err
            };

            // Dependencies run first; a cycle or a missing one fails this mod.
            if chain.contains(&id.to_string()) {
                return Err(fail(
                    self,
                    ModError::invalid(format!("dependency cycle: {} → {id}", chain.join(" → "))),
                ));
            }
            chain.push(id.to_string());
            for (dep, req) in &manifest.depends_on {
                let version = self
                    .0
                    .mods
                    .read()
                    .get(dep)
                    .map(|d| d.manifest.version.clone());
                let Some(version) = version else {
                    return Err(fail(
                        self,
                        ModError::unavailable(format!("needs mod {dep}, which is not installed")),
                    ));
                };
                let fits = semver::VersionReq::parse(req)
                    .ok()
                    .zip(semver::Version::parse(&version).ok())
                    .is_some_and(|(r, v)| r.matches(&v));
                if !fits {
                    return Err(fail(
                        self,
                        ModError::unavailable(format!("needs {dep} {req}, found {version}")),
                    ));
                }
                self.start_mod(dep, chain).await.ok();
                let running = matches!(
                    self.0.mods.read().get(dep).map(|d| &d.status),
                    Some(Status::Running)
                );
                if !running {
                    return Err(fail(
                        self,
                        ModError::unavailable(format!("needs mod {dep}, which is not running")),
                    ));
                }
            }
            chain.pop();

            let runtime = match &manifest.daemon {
                None => None,
                Some(rel) => {
                    let path = entry_path(&dir, rel)
                        .map_err(|e| fail(self, ModError::invalid(e.to_string())))?;
                    let source_code =
                        crate::manifest::read_mod_file(&path, crate::manifest::MAX_SCRIPT_BYTES)
                            .map_err(|e| fail(self, ModError::failed(format!("{e:#}"))))?;
                    let data_dir = self.0.config.data_dir.join("mod-data").join(id);
                    std::fs::create_dir_all(&data_dir).map_err(|e| {
                        fail(
                            self,
                            ModError::failed(format!("create {}: {e}", data_dir.display())),
                        )
                    })?;
                    let ops = Arc::new(ModOps {
                        host: Arc::downgrade(&self.0),
                        id: id.to_string(),
                        version: manifest.version.clone(),
                        data_dir,
                        permissions: manifest.permissions.clone(),
                    });
                    let started =
                        ModRuntime::start(id, source_code, ops, self.0.tokio.clone()).await;
                    Some(started.map_err(|e| fail(self, e))?)
                }
            };
            if let Some(e) = self.0.mods.write().get_mut(id) {
                e.status = Status::Running;
                e.runtime = runtime;
            }
            self.check_ui(id);
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

    /// Re-read a mod's files and restart both halves.
    pub async fn reload(&self, id: &str) -> Result<(), ModError> {
        self.restart(id, true).await
    }

    /// Re-read the manifest and restart the daemon half; with `ui`, the UI
    /// half loads again too even when its files did not change.
    async fn restart(&self, id: &str, ui: bool) -> Result<(), ModError> {
        if ui {
            if let Some(e) = self.0.mods.write().get_mut(id) {
                e.ui_rev += 1;
            }
        }
        let _l = self.0.lifecycle.lock().await;
        self.stop_mod(id).await;
        let dir = self.0.mods.read().get(id).map(|e| e.dir.clone());
        if let Some(dir) = dir {
            match Manifest::load(&dir) {
                // An id is the mod's identity (its approval, storage and RPC
                // namespace): a new one is a new mod, found by `reconcile`.
                Ok(m) if m.id != id => {
                    let msg = format!(
                        "mod.json now says id {:?}; an id cannot change in place. Aura treats the folder as a new mod, which needs approval",
                        m.id
                    );
                    if let Some(e) = self.0.mods.write().get_mut(id) {
                        e.status = Status::Failed(msg.clone());
                    }
                    self.0.log(id, "error", &msg);
                    drop(_l);
                    self.reconcile().await;
                    return Err(ModError::invalid(msg));
                }
                Ok(m) => {
                    if let Some(e) = self.0.mods.write().get_mut(id) {
                        e.stamp = Stamp::of(&dir, &m);
                        e.manifest = m;
                        e.status = Status::Stopped;
                        e.reload_error = None;
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

    /// Syntax-check a running mod's UI half in the background (capped read,
    /// a blocking thread, a deadline, no lock held), then remember the result,
    /// log a problem, and tell the windows when it changed.
    fn check_ui(&self, id: &str) {
        let (dir, ui) = match self.0.mods.read().get(id) {
            Some(e) => (e.dir.clone(), e.manifest.ui.clone()),
            None => return,
        };
        let Some(rel) = ui else { return };
        let host = self.clone();
        let id = id.to_string();
        self.0.tokio.spawn(async move {
            let error = match entry_path(&dir, &rel)
                .and_then(|p| crate::manifest::read_mod_file(&p, crate::manifest::MAX_SCRIPT_BYTES))
            {
                Ok(text) => crate::runtime::check_module_syntax_within(
                    &rel,
                    text,
                    crate::runtime::SYNTAX_CHECK_LIMIT,
                )
                .await
                .err(),
                Err(e) => Some(format!("{rel}: {e:#}")),
            };
            if let Some(e) = &error {
                host.0.log(&id, "ui error", e);
            }
            let changed = match host.0.mods.write().get_mut(&id) {
                Some(e) if e.ui_error != error => {
                    e.ui_error = error;
                    true
                }
                _ => false,
            };
            if changed {
                host.changed();
            }
        });
    }

    /// The UI half's files changed: check them and let the windows load them again.
    /// The daemon half keeps running, with its state.
    fn reload_ui(&self, id: &str) {
        self.0.log(
            id,
            "info",
            "UI files changed; reloading the UI half (the daemon half keeps running)",
        );
        if let Some(e) = self.0.mods.write().get_mut(id) {
            e.ui_rev += 1;
        }
        self.check_ui(id);
        self.changed();
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
                let kind = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
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

    /// The folder of the user's themes: `<data dir>/themes`.
    pub fn themes_dir(&self) -> PathBuf {
        self.0.config.data_dir.join("themes")
    }

    /// Watch the user and dev mod folders and the themes folder. A changed
    /// mod reloads, a new or removed mod folder is picked up, and a changed
    /// theme (the user's, or one in a mod's `themes/`) is announced with
    /// `themes.changed`. Bursts of events settle for 400 ms first.
    fn watch_dirs(&self) {
        use notify::{RecursiveMode, Watcher};
        let themes = self.themes_dir();
        let _ = std::fs::create_dir_all(&themes);
        let mut roots: Vec<PathBuf> = vec![themes.clone()];
        for (source, dir) in &self.0.config.dirs {
            if *source == ModSource::Bundled {
                continue;
            }
            if *source == ModSource::User {
                let _ = std::fs::create_dir_all(dir);
            }
            roots.push(dir.clone());
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("cannot watch mods and themes: {e}");
                return;
            }
        };
        for d in &roots {
            if let Err(e) = watcher.watch(d, RecursiveMode::Recursive) {
                tracing::warn!("cannot watch {}: {e}", d.display());
            }
        }
        // Canonical forms too: macOS reports /private/tmp for /tmp.
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let themes_canon = canon(&themes);
        let mod_roots: Vec<PathBuf> = roots[1..]
            .iter()
            .flat_map(|r| [r.clone(), canon(r)])
            .collect();
        let host = self.clone();
        tokio::spawn(async move {
            let _keep = watcher;
            while let Some(first) = rx.recv().await {
                let mut paths = vec![first];
                // A trailing debounce: wait for QUIET with no new event, so a
                // multi-step save (or a build) is seen once, finished.
                let start = tokio::time::Instant::now();
                loop {
                    let left = MAX_SETTLE.saturating_sub(start.elapsed());
                    match tokio::time::timeout(QUIET.min(left), rx.recv()).await {
                        Ok(Some(p)) if !left.is_zero() => paths.push(p),
                        _ => break,
                    }
                }
                let mut themes_changed = false;
                let mut mods_touched = false;
                {
                    let mods = host.0.mods.read();
                    for p in &paths {
                        if p.starts_with(&themes) || p.starts_with(&themes_canon) {
                            themes_changed = true;
                            continue;
                        }
                        if !mod_roots.iter().any(|r| p.starts_with(r)) {
                            continue;
                        }
                        let in_themes = mods.values().any(|e| {
                            p.starts_with(e.dir.join("themes"))
                                || p.starts_with(canon(&e.dir).join("themes"))
                        });
                        if in_themes {
                            themes_changed = true;
                        } else {
                            mods_touched = true;
                        }
                    }
                }
                if mods_touched && host.reconcile().await {
                    themes_changed = true;
                }
                if themes_changed {
                    host.0.broadcast("themes.changed", json!({}));
                }
            }
        });
    }

    /// Every theme: the user's (`<data dir>/themes`), then those of running mods.
    pub fn themes(&self) -> Vec<aura_core::themes::Theme> {
        let mut out = aura_core::themes::list_dir(&self.themes_dir(), None, "user");
        let mods: Vec<(String, PathBuf)> = self
            .0
            .mods
            .read()
            .values()
            .filter(|e| e.status == Status::Running)
            .map(|e| (e.manifest.id.clone(), e.dir.join("themes")))
            .collect();
        for (id, dir) in mods {
            out.extend(aura_core::themes::list_dir(
                &dir,
                Some(&id),
                &format!("mod:{id}"),
            ));
        }
        // A theme's CSS can restyle any screen, so it waits for the user's
        // approval, given for this exact CSS. Tokens alone need none.
        let state = self.themes_state();
        for t in &mut out {
            if let Some(css) = t.css.take() {
                let ok = state
                    .approved
                    .get(&t.id)
                    .is_some_and(|a| a.path == t.path && a.css == css);
                if ok {
                    t.css = Some(css);
                    t.approval = Some("approved".into());
                } else {
                    t.css_bytes = Some(css.len());
                    t.approval = Some("needs_approval".into());
                }
            }
        }
        out
    }

    fn themes_state(&self) -> ThemesState {
        self.0
            .manager
            .get_setting(THEMES_STATE_KEY)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// The theme `id` as on disk, with its CSS (approved or not).
    fn theme_with_css(&self, id: &str) -> Option<aura_core::themes::Theme> {
        let (dir, prefix, stem) = match id.split_once(':') {
            Some((m, name)) => (
                self.0.mods.read().get(m)?.dir.join("themes"),
                Some(m.to_string()),
                name.to_string(),
            ),
            None => (self.themes_dir(), None, id.to_string()),
        };
        aura_core::themes::list_dir(
            &dir,
            prefix.as_deref(),
            &prefix
                .as_ref()
                .map(|m| format!("mod:{m}"))
                .unwrap_or_else(|| "user".into()),
        )
        .into_iter()
        .find(|t| t.id == id && stem.len() <= id.len())
    }

    /// The `mods.*` and `mod.<id>.*` RPC methods. `session` is the calling
    /// session when the connection holds a session token.
    pub async fn handle(
        &self,
        method: &str,
        params: &Value,
        session: Option<&str>,
    ) -> Result<Option<Value>> {
        self.handle_as(method, params, session, false).await
    }

    /// Like [`handle`](Self::handle). `window` says the call comes from Aura's
    /// own window (its WebSocket's Origin is the app's). Granting an approval
    /// needs it: an agent running `aura mods approve` can only ask the window
    /// to show the prompt.
    pub async fn handle_as(
        &self,
        method: &str,
        params: &Value,
        session: Option<&str>,
        window: bool,
    ) -> Result<Option<Value>> {
        let needs_window = |what: &str| -> Result<()> {
            if window && session.is_none() {
                Ok(())
            } else {
                Err(crate::runtime::ModError::new(
                    "needs_window",
                    format!(
                        "{what} is granted only by a click in the Aura app: approve it in the Aura app. \
                         `aura mods approve` / `aura themes approve` make the app show the prompt. \
                         (If the app says it cannot approve, its background service was not started by the app; the prompt offers to restart it.)"
                    ),
                )
                .into())
            }
        };
        if let Some(rest) = method.strip_prefix("mod.") {
            let Some((id, name)) = rest.split_once('.') else {
                anyhow::bail!("mod methods are mod.<id>.<name>");
            };
            let caller = match session {
                Some(s) => json!({"kind": "session", "sessionId": s}),
                None => json!({"kind": "user"}),
            };
            return Ok(Some(
                self.0.call_mod(id, name, params.clone(), caller).await?,
            ));
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
                needs_window("A mod's approval")?;
                let id = id()?;
                let (perms, dir) = self
                    .0
                    .mods
                    .read()
                    .get(&id)
                    .map(|e| (e.manifest.permissions.clone(), identity(&e.dir)))
                    .context("no such mod")?;
                let mut saved = self.saved();
                saved.approved.insert(id.clone(), perms);
                saved.approved_dirs.insert(id.clone(), dir);
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
            // Ask the open windows to show the approval prompt for a mod or a
            // theme's CSS. Anyone may ask; only the window's click grants.
            "mods.request_approval" | "themes.request_approval" => {
                let id = id()?;
                let kind = if method.starts_with("mods.") {
                    "mod"
                } else {
                    "theme"
                };
                if kind == "mod" {
                    let state = self
                        .0
                        .mods
                        .read()
                        .get(&id)
                        .map(|e| e.status.clone())
                        .context("no such mod; `aura mods list` shows them")?;
                    if state != Status::NeedsApproval {
                        anyhow::bail!(
                            "mod {id} does not need approval (it is {})",
                            serde_json::to_value(&state)?["state"]
                                .as_str()
                                .unwrap_or("?")
                        );
                    }
                } else {
                    let t = self
                        .themes()
                        .into_iter()
                        .find(|t| t.id == id)
                        .context("no such theme; `aura themes list` shows them")?;
                    if t.approval.as_deref() != Some("needs_approval") {
                        anyhow::bail!("theme {id} has no CSS waiting for approval");
                    }
                }
                self.0
                    .broadcast("approval.request", json!({"kind": kind, "id": id}));
                json!(true)
            }
            "themes.approve" => {
                needs_window("A theme's approval")?;
                let id = id()?;
                let t = self.theme_with_css(&id).context("no such theme")?;
                let css = t.css.clone().context("this theme has no CSS to approve")?;
                let mut state = self.themes_state();
                state.approved.insert(
                    id.clone(),
                    ApprovedCss {
                        path: t.path.clone(),
                        css,
                    },
                );
                self.0
                    .manager
                    .set_setting(THEMES_STATE_KEY, &serde_json::to_string(&state)?)?;
                self.0.broadcast("themes.changed", json!({}));
                json!(true)
            }
            // Look for added, removed, moved and changed mods; the others keep running.
            "mods.rescan" => json!(self.reconcile().await),
            // Where the user's (and the dev) mods live, for Settings › Mods.
            "mods.dirs" => {
                let dir = |source: ModSource| {
                    self.0
                        .config
                        .dirs
                        .iter()
                        .find(|(s, _)| *s == source)
                        .map(|(_, p)| p.to_string_lossy().to_string())
                };
                json!({"user": dir(ModSource::User), "dev": dir(ModSource::Dev)})
            }
            "themes.list" => json!({
                "dir": self.themes_dir().to_string_lossy(),
                "themes": self.themes(),
            }),
            "themes.get" => {
                let id = id()?;
                let theme = self.themes().into_iter().find(|t| t.id == id);
                json!(theme.with_context(|| format!(
                    "no theme {id}; `aura themes list` shows the themes"
                ))?)
            }
            // `aura themes use <id>`: the open windows switch to it.
            // The theme every window shows, kept by the daemon so it survives
            // restarts and reaches windows opened later. `aura themes use` refuses
            // a theme that cannot be used; Settings may pick one anyway (it then
            // shows the base and the reason), with `allowInvalid`.
            "themes.use" => {
                let id = id()?;
                let allow_invalid = params
                    .get("allowInvalid")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let builtin = aura_core::themes::RESERVED_IDS.contains(&id.as_str());
                if !builtin {
                    let theme = self.themes().into_iter().find(|t| t.id == id);
                    match theme {
                        None => anyhow::bail!("no theme {id}; `aura themes list` shows the themes"),
                        Some(t) if !allow_invalid => {
                            if let Some(e) = t.error {
                                anyhow::bail!("theme {id} cannot be used: {e}. Fix it, then check it with `aura themes check {id}`");
                            }
                        }
                        Some(_) => {}
                    }
                }
                self.0.manager.set_setting(THEME_KEY, &id)?;
                self.0.broadcast("themes.use", json!({"id": id}));
                json!(true)
            }
            "themes.current" => json!({"id": self.0.manager.get_setting(THEME_KEY).ok().flatten()}),
            // `aura mods new`: find the new folder now instead of when the watcher fires.
            "mods.discover" => json!(self.reconcile().await),
            // Something a mod's UI half reports (a load error, a component that threw),
            // so it shows in `aura mods logs <id>` next to the daemon half's lines.
            "mods.ui_log" => {
                let id = id()?;
                let level = params
                    .get("level")
                    .and_then(Value::as_str)
                    .filter(|l| matches!(*l, "info" | "warn" | "error"))
                    .unwrap_or("error");
                let message = params.get("message").and_then(Value::as_str).unwrap_or("");
                if !self.0.mods.read().contains_key(&id) {
                    anyhow::bail!("no mod {id}");
                }
                // A UI half that throws in a loop must not flood the log.
                let (allowed, dropped) = {
                    let mut reports = self.0.ui_reports.lock();
                    let now = std::time::Instant::now();
                    let slot = reports.entry(id.clone()).or_insert((now, 0, 0));
                    let mut dropped = 0;
                    if now.duration_since(slot.0) >= UI_LOG_WINDOW {
                        dropped = slot.2;
                        *slot = (now, 0, 0);
                    }
                    slot.1 += 1;
                    let allowed = slot.1 <= UI_LOG_LIMIT;
                    if !allowed {
                        slot.2 += 1;
                    }
                    (allowed, dropped)
                };
                if dropped > 0 {
                    self.0.log(&id, "ui warn", &format!("{dropped} more UI reports were dropped (at most {UI_LOG_LIMIT} per {} s)", UI_LOG_WINDOW.as_secs()));
                }
                if allowed {
                    self.0.log(&id, &format!("ui {level}"), message);
                }
                json!(allowed)
            }
            // Plain: the lines. With `after` (a sequence number, 0 for all):
            // {lines: [{seq, text}], first, last}, to follow the log without
            // losing repeated lines; `first` > after + 1 means lines rolled off.
            "mods.logs" => {
                let id = id()?;
                let mods = self.0.mods.read();
                let logs = mods.get(&id).map(|e| e.logs.clone()).unwrap_or_default();
                match params.get("after").and_then(Value::as_u64) {
                    None => json!(logs.iter().map(|(_, l)| l.clone()).collect::<Vec<_>>()),
                    Some(after) => json!({
                        "lines": logs.iter().filter(|(n, _)| *n > after).map(|(n, l)| json!({"seq": n, "text": l})).collect::<Vec<_>>(),
                        "first": logs.front().map(|(n, _)| *n),
                        "last": logs.back().map(|(n, _)| *n),
                    }),
                }
            }
            "mods.settings.get" => self.0.settings_of(&id()?),
            "mods.settings.set" => {
                let key = params
                    .get("key")
                    .and_then(Value::as_str)
                    .context("key is required")?;
                self.0.set_setting(
                    &id()?,
                    key,
                    params.get("value").cloned().unwrap_or(Value::Null),
                )?;
                json!(true)
            }
            // What a mod's new-session field contributed, stored on the new session for that mod.
            "mods.session_data.set" => {
                let id = id()?;
                let sid = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .context("sessionId is required")?;
                let key = params
                    .get("key")
                    .and_then(Value::as_str)
                    .context("key is required")?;
                if !self.0.mods.read().contains_key(&id) {
                    anyhow::bail!("no mod {id}");
                }
                self.0.manager.get_session(sid)?;
                let value = params.get("value").cloned().filter(|v| !v.is_null());
                self.0
                    .records
                    .set_field(&crate::storage::sessions_ns(&id), sid, key, value)?;
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
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .context("name is required")?;
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
                    "uiError": e.ui_error,
                    "reloadError": e.reload_error,
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
        let (manifest, dir, status, rev) = {
            let mods = self.0.mods.read();
            let e = mods.get(id).context("no such mod")?;
            (
                e.manifest.clone(),
                e.dir.clone(),
                e.status.clone(),
                e.ui_rev,
            )
        };
        if status != Status::Running {
            anyhow::bail!("mod {id} is not running");
        }
        let read = |rel: &Option<String>, cap: usize| -> Result<Option<String>> {
            match rel {
                None => Ok(None),
                Some(r) => Ok(Some(crate::manifest::read_mod_file(
                    &entry_path(&dir, r)?,
                    cap,
                )?)),
            }
        };
        Ok(json!({
            "id": id,
            "version": manifest.version,
            "rev": rev,
            "js": read(&manifest.ui, crate::manifest::MAX_SCRIPT_BYTES)?,
            "css": read(&manifest.styles, crate::manifest::MAX_STYLES_BYTES)?,
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
                let has = e
                    .tools
                    .iter()
                    .any(|t| t.get("name").and_then(Value::as_str) == Some(name));
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
        let _ = self
            .notifications
            .send(json!({"method": method, "params": params}));
    }

    pub(crate) fn log(&self, id: &str, level: &str, message: &str) {
        if let Some(e) = self.mods.write().get_mut(id) {
            let line = format!(
                "{} {level}: {}",
                chrono::Local::now().format("%H:%M:%S"),
                log_text(&message.chars().take(4000).collect::<String>())
            );
            let seq = self
                .log_seq
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                + 1;
            e.logs.push_back((seq, line));
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
            .filter(|e| {
                e.mod_subs.contains(&key) && e.manifest.permissions.mods.iter().any(|m| m == id)
            })
            .filter_map(|e| e.runtime.clone())
            .collect();
        for r in targets {
            r.dispatch(
                "modEvent",
                json!({"modId": id, "name": name, "payload": payload}),
            );
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
        self.records
            .set_field(SETTINGS_NS, id, key, value.clone())?;
        let all = self.settings_of(id);
        let effective = all.get(key).cloned().unwrap_or(Value::Null);
        self.dispatch_to(
            id,
            "settings",
            json!({"key": key, "value": effective, "all": all}),
        );
        self.broadcast(
            "mods.settings.changed",
            json!({"modId": id, "key": key, "value": effective}),
        );
        Ok(())
    }

    pub(crate) async fn call_mod(
        &self,
        id: &str,
        name: &str,
        params: Value,
        caller: Value,
    ) -> OpResult {
        let runtime = {
            let mods = self.mods.read();
            let e = mods
                .get(id)
                .ok_or_else(|| ModError::new("not_found", format!("no mod {id}")))?;
            match (&e.status, &e.runtime) {
                (Status::Running, Some(r)) => r.clone(),
                (Status::Running, None) => {
                    return Err(ModError::new(
                        "not_found",
                        format!("mod {id} has no daemon half"),
                    ))
                }
                (status, _) => {
                    let why = match status {
                        Status::NeedsApproval => format!(
                            "is waiting for the user's approval (Settings › Mods, or `aura mods approve {id}`)"
                        ),
                        Status::Disabled => format!("is disabled (`aura mods enable {id}`)"),
                        Status::Failed(e) => format!("failed to start: {e} (`aura mods logs {id}`)"),
                        Status::Starting => "is still starting".to_string(),
                        _ => "is not running".to_string(),
                    };
                    return Err(ModError::unavailable(format!("mod {id} {why}")));
                }
            }
        };
        tokio::time::timeout(CALL_TIMEOUT, runtime.call(name, params, caller))
            .await
            .map_err(|_| {
                ModError::new("timeout", format!("mod.{id}.{name} did not answer in time"))
            })?
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
