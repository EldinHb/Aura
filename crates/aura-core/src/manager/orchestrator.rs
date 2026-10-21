//! Orchestration: one session (the orchestrator) starts and directs other
//! sessions (its workers) of any agent kind. Workers are ordinary sessions;
//! they only carry `orchestrator_id`. The orchestrator drives them through the
//! `aura mcp` tools, which call the methods here over the daemon RPC.
//!
//! Whenever a worker stops (its turn ends, it fails, or it waits on the user),
//! the orchestrator is sent a report once it is idle. Workers that `wait`
//! already returned are not reported again. Reports are messages from Aura
//! (see [`crate::prompts::aura_header`]), which the user's chat leaves out;
//! a turn one starts marks the orchestrator for the user only once its
//! workers are done.
//!
//! An orchestrator need not belong to a folder. One created without one runs
//! in a directory of its own under [`Manager::enable_orchestrator_dirs`] and
//! names the folder of every worker it starts.
use super::Manager;
use crate::event::*;
use crate::types::*;
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Longest last reply included in a report; longer ones keep their end, where
/// agents put their summary.
const REPLY_LIMIT: usize = 6000;

#[derive(Default)]
pub(super) struct State {
    /// `aura` binary and data directory the MCP server is started with.
    /// Without them orchestrators get no tools.
    cli: Option<(PathBuf, PathBuf)>,
    /// Where orchestrators without a folder get their directories.
    dirs: Option<PathBuf>,
    /// Orchestrator id -> workers with a report not yet delivered.
    queued: HashMap<SessionId, BTreeSet<SessionId>>,
    /// Orchestrators sent a report whose turn has not started yet.
    delivering: HashSet<SessionId>,
    /// Those of `delivering` sent a worker report, not another message from Aura.
    reporting: HashSet<SessionId>,
    /// Orchestrators whose current turn a worker report started.
    report_turns: HashSet<SessionId>,
    /// Workers sent a message whose turn has not started yet, so a `wait`
    /// right after dispatching does not mistake them for finished.
    dispatched: HashSet<SessionId>,
}

/// What an orchestrator asks for when it starts a worker.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkerSpec {
    /// `claude`, `codex`, or an ACP agent id (`gemini`, `acp:goose`, ...).
    pub agent: String,
    /// The worker's first message.
    pub prompt: String,
    pub title: Option<String>,
    /// The folder the worker works in. Defaults to the orchestrator's folder,
    /// which relative paths resolve against; an orchestrator without a folder
    /// must give an absolute path.
    pub cwd: Option<String>,
    /// Run the worker in a new git worktree on this branch.
    pub branch: Option<String>,
    /// Base ref for `branch`. Defaults to HEAD.
    pub base: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// A worker as the orchestrator sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerReport {
    pub id: SessionId,
    pub title: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub status: SessionStatus,
    pub cwd: String,
    pub branch: Option<String>,
    /// Approvals and questions waiting on the user.
    pub waiting_on_user: Vec<String>,
    pub last_error: Option<String>,
    /// The worker's last message to whoever wrote to it last.
    pub last_reply: Option<String>,
}

/// A folder or repository the user's sessions work in, for an orchestrator
/// choosing where a worker goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// Root of the main working tree, or the folder when it is not in a repository.
    pub path: String,
    pub repo: bool,
    /// Groups linked to it.
    pub groups: Vec<String>,
    /// Sessions that work in it, its worktrees included. Archived ones are not counted.
    pub sessions: usize,
    pub last_used: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaitResult {
    pub timed_out: bool,
    pub workers: Vec<WorkerReport>,
}

impl Manager {
    /// Give orchestrators their tools: `aura mcp`, run from `aura` against the
    /// daemon in `data_dir`.
    pub fn enable_orchestration(&self, aura: PathBuf, data_dir: PathBuf) {
        self.inner.orchestration.lock().cli = Some((aura, data_dir));
    }

    /// Keep the directories of orchestrators without a folder under `dir`.
    /// Without it they go to the system's temporary directory.
    pub fn enable_orchestrator_dirs(&self, dir: PathBuf) {
        self.inner.orchestration.lock().dirs = Some(dir);
    }

    fn orchestrator_dirs(&self) -> PathBuf {
        self.inner
            .orchestration
            .lock()
            .dirs
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("aura-orchestrators"))
    }

    /// Whether `cwd` has the shape of a directory Aura made for an
    /// orchestrator: a plainly named, direct child of the base directory.
    /// Nothing else is ever created or removed as one.
    pub(super) fn is_orchestrator_dir(&self, cwd: &str) -> bool {
        let dir = Path::new(cwd);
        matches!(dir.components().next_back(), Some(Component::Normal(_)))
            && dir.parent() == Some(self.orchestrator_dirs().as_path())
    }

    /// Whether the existing directory `dir` lies in the base directory of
    /// orchestrators, with `..` and links resolved. Only orchestrators without
    /// a folder work there, each in the one Aura made for it.
    pub(super) fn in_orchestrator_dirs(&self, dir: &str) -> bool {
        let base = canonical(&self.orchestrator_dirs());
        std::fs::canonicalize(dir).is_ok_and(|d| d.starts_with(base))
    }

    /// Make the directory of a new orchestrator without a folder.
    pub(super) fn make_orchestrator_dir(&self, id: &str) -> Result<String> {
        let dir = self.orchestrator_dirs().join(id);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("create the orchestrator's directory {}", dir.display()))?;
        Ok(dir.to_string_lossy().into_owned())
    }

    /// Remove the directory of a deleted orchestrator without a folder, unless
    /// a session still works in it (a fork resumes in the same one).
    pub(super) fn remove_orchestrator_dir(&self, s: &Session) {
        if !s.folderless
            || !self.is_orchestrator_dir(&s.cwd)
            || self.list_sessions().iter().any(|o| o.cwd == s.cwd)
        {
            return;
        }
        if let Err(e) = std::fs::remove_dir_all(&s.cwd) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("remove orchestrator directory {}: {e}", s.cwd);
            }
        }
    }

    pub(super) fn mcp_servers_for(&self, s: &Session) -> Vec<McpServer> {
        if !s.orchestrator {
            return vec![];
        }
        let Some((aura, data_dir)) = self.inner.orchestration.lock().cli.clone() else {
            return vec![];
        };
        vec![McpServer {
            name: "aura".into(),
            command: aura.to_string_lossy().into_owned(),
            args: vec![
                "mcp".into(),
                "--data-dir".into(),
                data_dir.to_string_lossy().into_owned(),
                "--orchestrator".into(),
                s.id.clone(),
            ],
        }]
    }

    /// The part of the system prompt that explains the session's role.
    pub(super) fn orchestration_prompt(&self, s: &Session) -> Option<String> {
        if s.orchestrator {
            let tools = self.inner.orchestration.lock().cli.is_some();
            let mut p = crate::prompts::orchestrator_prompt(s, tools);
            // Unreadable settings leave the load balancer off rather than the
            // orchestrator without a prompt.
            match self.stored_load_balancer().map(|lb| lb.prompt()) {
                Ok(Some(lb)) => p = format!("{p}\n\n{lb}"),
                Ok(None) => {}
                Err(e) => tracing::warn!("load balancer: {e:#}"),
            }
            return Some(p);
        }
        let orchestrator = self.get_session(s.orchestrator_id.as_deref()?).ok()?;
        Some(crate::prompts::worker_prompt(&orchestrator.title))
    }

    /// Make a session an orchestrator or a regular session again. Takes effect
    /// the next time its agent starts.
    pub async fn set_orchestrator(&self, id: &str, on: bool) -> Result<Session> {
        let s = self.get_session(id)?;
        if !on && s.folderless {
            bail!("this orchestrator has no folder, so it cannot be a regular session");
        }
        if on && s.mode == SessionMode::Terminal {
            bail!("an orchestrator runs in the structured view, where its workers' reports reach it; switch the session to it first");
        }
        self.update_session(id, |s| {
            s.orchestrator = on;
            if on {
                s.orchestrator_id = None;
            }
        })?;
        if !on {
            self.forget_orchestrator(id);
        }
        self.restart_idle_agents(|s| s.id == id).await;
        self.get_session(id)
    }

    /// Forget a demoted orchestrator: detach its workers and drop the reports
    /// from and to it.
    fn forget_orchestrator(&self, id: &str) {
        let workers: Vec<String> = self
            .list_sessions()
            .into_iter()
            .filter(|s| s.orchestrator_id.as_deref() == Some(id))
            .map(|s| s.id)
            .collect();
        for w in workers {
            let _ = self.update_session(&w, |s| s.orchestrator_id = None);
        }
        self.drop_reports(id);
    }

    /// Drop the reports from and to a session that is deleted or no longer orchestrates.
    pub(super) fn drop_reports(&self, id: &str) {
        let mut st = self.inner.orchestration.lock();
        st.queued.remove(id);
        st.delivering.remove(id);
        st.reporting.remove(id);
        st.report_turns.remove(id);
        st.dispatched.remove(id);
        for q in st.queued.values_mut() {
            q.remove(id);
        }
    }

    fn orchestrator(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        if !s.orchestrator {
            bail!("session {} is not an orchestrator", short(id));
        }
        Ok(s)
    }

    /// The orchestrator's worker matching `key`: an id, a title or an id
    /// prefix. A title or prefix that several workers share matches none.
    pub fn worker(&self, orchestrator: &str, key: &str) -> Result<Session> {
        let key = key.trim();
        let workers: Vec<Session> = self.workers_of(orchestrator);
        if let Some(s) = workers.iter().find(|s| s.id == key) {
            return Ok(s.clone());
        }
        let titled: Vec<&Session> = workers.iter().filter(|s| s.title == key).collect();
        match titled.as_slice() {
            [one] => return Ok((*one).clone()),
            [] => {}
            several => bail!(
                "{} workers are titled `{key}`; use the id of the one you mean: {}",
                several.len(),
                several
                    .iter()
                    .map(|s| format!("`{}`", s.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
        let matches: Vec<&Session> = workers
            .iter()
            .filter(|s| !key.is_empty() && s.id.starts_with(key))
            .collect();
        match matches.as_slice() {
            [one] => Ok((*one).clone()),
            [] => bail!("no worker of this orchestrator matches `{key}`; list_sessions shows them"),
            _ => bail!("`{key}` matches several workers; use the full id"),
        }
    }

    /// The session and everything under it: its workers, theirs, and so on,
    /// each orchestrator before its workers. Deleting the session deletes them all.
    pub fn with_workers(&self, id: &str) -> Vec<Session> {
        let all = self.list_sessions();
        let mut out: Vec<Session> = all.iter().filter(|s| s.id == id).cloned().collect();
        let mut i = 0;
        while i < out.len() {
            let parent = out[i].id.clone();
            for s in &all {
                if s.orchestrator_id.as_deref() == Some(parent.as_str())
                    && !out.iter().any(|o| o.id == s.id)
                {
                    out.push(s.clone());
                }
            }
            i += 1;
        }
        out
    }

    fn workers_of(&self, orchestrator: &str) -> Vec<Session> {
        let mut v: Vec<Session> = self
            .list_sessions()
            .into_iter()
            .filter(|s| s.orchestrator_id.as_deref() == Some(orchestrator))
            .collect();
        v.sort_by_key(|s| s.created_at);
        v
    }

    /// Start a worker and give it its first task.
    pub async fn start_worker(&self, orchestrator: &str, spec: WorkerSpec) -> Result<Session> {
        let orch = self.orchestrator(orchestrator)?;
        if spec.prompt.trim().is_empty() {
            bail!("a worker needs a prompt");
        }
        let (provider, agent) = parse_agent(&spec.agent)?;
        let model = spec.model.filter(|m| !m.is_empty());
        let key = agent.as_deref().unwrap_or(provider.as_str());
        if let Some(entry) = self
            .stored_load_balancer()?
            .forbidden(key, model.as_deref())
        {
            bail!("the user's load balancer settings forbid `{entry}`; pick another agent or model from list_agents");
        }
        let cwd = match spec.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) if orch.folderless => {
                let dir = resolve_dir("", c);
                if !Path::new(&dir).is_absolute() {
                    bail!("`cwd` must be an absolute path: you have no folder of your own for `{c}` to be relative to");
                }
                dir
            }
            Some(c) => resolve_dir(&orch.cwd, c),
            None if orch.folderless => bail!(
                "`cwd` is required: you have no folder of your own, so name the absolute path of the folder or repository the worker works in (list_projects shows the ones Aura knows)"
            ),
            None => orch.cwd.clone(),
        };
        if self.in_orchestrator_dirs(&cwd) {
            bail!("`{cwd}` is where Aura keeps the directories of orchestrators; give the worker the folder or repository it works in");
        }
        // Permission and sandbox modes only mean something to the same agent.
        let same_agent = provider == orch.provider && agent == orch.agent;
        let session = self
            .create_session(CreateSessionOpts {
                provider,
                agent,
                cwd,
                title: spec.title.filter(|t| !t.trim().is_empty()),
                group: orch.group.clone(),
                model,
                effort: spec.effort.filter(|e| !e.is_empty()),
                permission_mode: orch.permission_mode.clone().filter(|_| same_agent),
                sandbox_mode: orch.sandbox_mode.clone().filter(|_| same_agent),
                worktree: spec
                    .branch
                    .filter(|b| !b.trim().is_empty())
                    .map(|branch| WorktreeOpts {
                        branch,
                        base: spec.base,
                        path: None,
                    }),
                orchestrator_id: Some(orch.id.clone()),
                ..Default::default()
            })
            .await?;
        // Deleted while the worker started: it goes too, rather than be left
        // pointing at an orchestrator that is gone.
        match self.get_session(orchestrator) {
            Err(_) => {
                let _ = self.delete(&session.id, false).await;
                bail!("the orchestrator was deleted while the worker started");
            }
            // Made a regular session meanwhile: like its other workers, this
            // one is on its own now, and its task is not sent.
            Ok(o) if !o.orchestrator => {
                let _ = self.update_session(&session.id, |s| s.orchestrator_id = None);
                bail!(
                    "this session stopped orchestrating while the worker started; {} (`{}`) is kept as a regular session and was not given the task",
                    session.title,
                    session.id
                );
            }
            Ok(_) => {}
        }
        self.dispatch(orchestrator, &session.id, spec.prompt)
            .await?;
        self.get_session(&session.id)
    }

    /// Send a message from the orchestrator to one of its workers.
    pub async fn message_worker(
        &self,
        orchestrator: &str,
        worker: &str,
        text: String,
    ) -> Result<Session> {
        self.orchestrator(orchestrator)?;
        let w = self.worker(orchestrator, worker)?;
        if text.trim().is_empty() {
            bail!("empty message");
        }
        self.dispatch(orchestrator, &w.id, text).await?;
        self.get_session(&w.id)
    }

    /// Send a worker a message from its orchestrator. The user message it
    /// makes records the orchestrator in `data.from_orchestrator`, which tells
    /// it apart from what the user typed to the worker.
    async fn dispatch(&self, orchestrator: &str, worker: &str, text: String) -> Result<()> {
        let w = self.get_session(worker)?;
        if w.mode == SessionMode::Structured {
            self.stage_data(
                worker,
                &text,
                "from_orchestrator",
                serde_json::Value::String(orchestrator.to_string()),
            );
        }
        // A busy worker stays `running`, which `wait` already treats as busy;
        // marking it would wait for a turn that may never start on its own.
        let busy = w.status == SessionStatus::Running;
        if !busy {
            self.inner
                .orchestration
                .lock()
                .dispatched
                .insert(worker.to_string());
        }
        let result = self
            .send(
                worker,
                Input {
                    text: text.clone(),
                    ..Default::default()
                },
            )
            .await;
        if result.is_err() {
            self.inner.orchestration.lock().dispatched.remove(worker);
            self.unstage(worker, &text);
        }
        result
    }

    pub async fn interrupt_worker(&self, orchestrator: &str, worker: &str) -> Result<()> {
        let w = self.worker(orchestrator, worker)?;
        self.inner.orchestration.lock().dispatched.remove(&w.id);
        self.interrupt(&w.id).await
    }

    pub async fn stop_worker(&self, orchestrator: &str, worker: &str) -> Result<()> {
        let w = self.worker(orchestrator, worker)?;
        self.inner.orchestration.lock().dispatched.remove(&w.id);
        self.stop(&w.id).await
    }

    /// Delete one of the orchestrator's workers as the user would: stopped,
    /// with its history and its own workers, its worktree kept. Returns what
    /// was deleted, the worker first.
    pub async fn delete_worker(&self, orchestrator: &str, worker: &str) -> Result<Vec<Session>> {
        self.orchestrator(orchestrator)?;
        let w = self.worker(orchestrator, worker)?;
        let deleted = self.with_workers(&w.id);
        self.delete(&w.id, false).await?;
        Ok(deleted)
    }

    /// The folders and repositories the user's sessions work in and their
    /// groups are linked to, most recently used first. Asks git about each
    /// folder, so call it off the async runtime.
    pub fn projects(&self) -> Result<Vec<Project>> {
        fn add(
            found: &mut BTreeMap<String, Project>,
            path: String,
            repo: bool,
            last_used: DateTime<Utc>,
        ) -> &mut Project {
            let p = found.entry(path.clone()).or_insert_with(|| Project {
                path,
                repo,
                groups: vec![],
                sessions: 0,
                last_used,
            });
            p.repo |= repo;
            p.last_used = p.last_used.max(last_used);
            p
        }
        let mut found: BTreeMap<String, Project> = BTreeMap::new();
        let mut roots: HashMap<String, Option<String>> = HashMap::new();
        for s in self.list_sessions() {
            if s.folderless || self.in_orchestrator_dirs(&s.cwd) {
                continue;
            }
            let root = match &s.worktree {
                Some(wt) => Some(wt.repo_root.clone()),
                None => roots
                    .entry(s.cwd.clone())
                    .or_insert_with(|| self.repo_root(&s.cwd))
                    .clone(),
            };
            let repo = root.is_some();
            let p = add(
                &mut found,
                root.unwrap_or_else(|| s.cwd.clone()),
                repo,
                s.last_activity,
            );
            if !s.archived {
                p.sessions += 1;
            }
            if let Some(g) = s.group.filter(|g| !g.trim().is_empty()) {
                if !p.groups.contains(&g) {
                    p.groups.push(g);
                }
            }
        }
        for g in self.list_groups()? {
            for r in g.repos {
                let p = add(&mut found, r.path, true, r.last_used);
                if !p.groups.contains(&g.name) {
                    p.groups.push(g.name.clone());
                }
            }
        }
        let mut v: Vec<Project> = found
            .into_values()
            .filter(|p| Path::new(&p.path).is_dir())
            .map(|mut p| {
                p.groups.sort();
                p
            })
            .collect();
        v.sort_by(|a, b| b.last_used.cmp(&a.last_used).then(a.path.cmp(&b.path)));
        Ok(v)
    }

    pub fn worker_reports(&self, orchestrator: &str) -> Result<Vec<WorkerReport>> {
        self.orchestrator(orchestrator)?;
        Ok(self
            .workers_of(orchestrator)
            .iter()
            .filter(|s| !s.archived)
            .map(|s| self.report(s))
            .collect())
    }

    /// The last `turns` exchanges of a worker as plain text.
    pub fn worker_transcript(
        &self,
        orchestrator: &str,
        worker: &str,
        turns: usize,
    ) -> Result<String> {
        let w = self.worker(orchestrator, worker)?;
        let items = self.items(&w.id)?;
        let starts: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.kind == ItemKind::UserMessage)
            .map(|(n, _)| n)
            .collect();
        let from = match starts.len().checked_sub(turns.max(1)) {
            Some(n) => starts[n],
            None => 0,
        };
        let mut out = format!(
            "{} ({}) · {} · {}\n",
            w.title,
            w.id,
            label(&w),
            status_name(w.status)
        );
        let marked = items
            .iter()
            .position(|i| i.kind == ItemKind::UserMessage && from_orchestrator(i));
        for (n, item) in items.iter().enumerate().skip(from) {
            let line = match item.kind {
                ItemKind::UserMessage if crate::prompts::is_aura_message(&item.text) => {
                    format!("\n## Message from Aura\n{}\n", item.text.trim())
                }
                ItemKind::UserMessage if from_orchestrator(item) => {
                    format!("\n## Your message to the worker\n{}\n", item.text.trim())
                }
                // Before Aura marked the orchestrator's messages, neither could be told apart.
                ItemKind::UserMessage if marked.is_some_and(|m| n > m) => {
                    format!("\n## Message from the user\n{}\n", item.text.trim())
                }
                ItemKind::UserMessage => {
                    format!("\n## Message to the worker\n{}\n", item.text.trim())
                }
                ItemKind::AgentMessage => format!("\n## Worker\n{}\n", item.text.trim()),
                ItemKind::Reasoning | ItemKind::System => continue,
                ItemKind::CommandExec => format!(
                    "- ran `{}`{}\n",
                    item.data
                        .get("command")
                        .and_then(|c| c.as_str())
                        .or(item.title.as_deref())
                        .unwrap_or("a command"),
                    match item.data.get("exit_code").and_then(|c| c.as_i64()) {
                        Some(0) | None => String::new(),
                        Some(code) => format!(" (exit {code})"),
                    }
                ),
                ItemKind::FileChange => {
                    let paths: Vec<&str> = item
                        .data
                        .get("changes")
                        .and_then(|c| c.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|c| c.get("path").and_then(|p| p.as_str()))
                                .collect()
                        })
                        .unwrap_or_default();
                    format!(
                        "- changed {}\n",
                        if paths.is_empty() {
                            "files".into()
                        } else {
                            paths.join(", ")
                        }
                    )
                }
                ItemKind::Error => format!(
                    "- error: {}\n",
                    item.data
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(&item.text)
                ),
                _ => format!(
                    "- {}\n",
                    item.title.as_deref().unwrap_or(kind_name(item.kind))
                ),
            };
            out.push_str(&line);
        }
        let report = self.report(&w);
        for p in &report.waiting_on_user {
            out.push_str(&format!("\nWaiting on the user: {p}\n"));
        }
        Ok(out)
    }

    /// Wait until the given workers (all of them when empty) have stopped
    /// working: `any` returns at the first one. Returned workers count as
    /// reported.
    pub async fn wait_workers(
        &self,
        orchestrator: &str,
        workers: &[String],
        any: bool,
        timeout: Duration,
    ) -> Result<WaitResult> {
        self.orchestrator(orchestrator)?;
        let targets: Vec<Session> = if workers.is_empty() {
            self.workers_of(orchestrator)
                .into_iter()
                .filter(|s| !s.archived)
                .collect()
        } else {
            workers
                .iter()
                .map(|w| self.worker(orchestrator, w))
                .collect::<Result<_>>()?
        };
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        let timed_out = loop {
            let settled: Vec<bool> = targets.iter().map(|s| self.settled(&s.id)).collect();
            let done = if any {
                settled.iter().any(|x| *x)
            } else {
                settled.iter().all(|x| *x)
            };
            if done || targets.is_empty() {
                break false;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break true;
            }
            // Re-check on every event, and now and then in case one was missed.
            let _ =
                tokio::time::timeout((deadline - now).min(Duration::from_secs(2)), rx.recv()).await;
        };
        let mut reports = vec![];
        let mut st_done = vec![];
        for s in &targets {
            let s = self.get_session(&s.id)?;
            if self.settled(&s.id) {
                st_done.push(s.id.clone());
            }
            reports.push(self.report(&s));
        }
        if let Some(q) = self.inner.orchestration.lock().queued.get_mut(orchestrator) {
            for id in &st_done {
                q.remove(id);
            }
        }
        Ok(WaitResult {
            timed_out,
            workers: reports,
        })
    }

    /// Not working: idle, finished, failed, or waiting on the user.
    fn settled(&self, id: &str) -> bool {
        if self.inner.orchestration.lock().dispatched.contains(id) {
            return false;
        }
        self.get_session(id)
            .map(|s| s.status != SessionStatus::Running)
            .unwrap_or(true)
    }

    fn report(&self, s: &Session) -> WorkerReport {
        let mut waiting = vec![];
        if let Some(rt) = self.inner.runtimes.lock().get(&s.id) {
            for a in rt.pending_approvals.values() {
                waiting.push(format!("approval: {}", a.title));
            }
            for r in rt.pending_inputs.values() {
                for q in &r.questions {
                    waiting.push(format!("question: {}", q.question));
                }
            }
        }
        let last_reply = self.last_reply(&s.id);
        WorkerReport {
            id: s.id.clone(),
            title: s.title.clone(),
            agent: label(s),
            model: s.model.clone(),
            effort: s.effort.clone(),
            status: s.status,
            cwd: s.cwd.clone(),
            branch: s.worktree.as_ref().map(|w| w.branch.clone()),
            waiting_on_user: waiting,
            last_error: s
                .last_error
                .clone()
                .filter(|_| s.status == SessionStatus::Error),
            last_reply,
        }
    }

    /// Completed items of a session, in order.
    fn items(&self, id: &str) -> Result<Vec<Item>> {
        Ok(self
            .inner
            .store
            .events(id, 0, usize::MAX)?
            .into_iter()
            .filter_map(|e| match e.event {
                Event::ItemCompleted { item, .. } if item.parent_id.is_none() => Some(item),
                _ => None,
            })
            .collect())
    }

    /// Whether `ev` starts or ends a turn that a worker report started.
    /// Called for every event before the session row is updated.
    pub(super) fn report_turn(&self, ev: &Event) -> bool {
        // Called for every event, streamed text included: leave early.
        if !matches!(
            ev,
            Event::TurnStarted { .. } | Event::TurnCompleted { .. } | Event::ProcessExited { .. }
        ) {
            return false;
        }
        let sid = ev.session_id();
        let mut st = self.inner.orchestration.lock();
        match ev {
            Event::TurnStarted { .. } => {
                if st.reporting.remove(sid) {
                    st.report_turns.insert(sid.to_string())
                } else {
                    st.report_turns.remove(sid);
                    false
                }
            }
            Event::TurnCompleted { .. } => st.report_turns.remove(sid),
            Event::ProcessExited { .. } => {
                st.report_turns.remove(sid);
                false
            }
            _ => false,
        }
    }

    /// Whether a turn a report started ends with nothing for the user yet:
    /// it finished well and the orchestrator still has workers working or
    /// reports to take. When the last of them stops, the turn it reports
    /// starts the one that marks the orchestrator done.
    pub(super) fn quiet_report_turn(&self, ev: &Event, pending: u32) -> bool {
        let Event::TurnCompleted { session_id, turn } = ev else {
            return false;
        };
        if turn.status != TurnStatus::Completed || pending > 0 {
            return false;
        }
        let queued = self
            .inner
            .orchestration
            .lock()
            .queued
            .get(session_id)
            .is_some_and(|q| !q.is_empty());
        queued
            || self
                .workers_of(session_id)
                .iter()
                .any(|w| !w.archived && !self.settled(&w.id))
    }

    /// Follow events that matter to orchestration. Called for every event
    /// after the session row is updated.
    pub(super) fn on_orchestration_event(&self, ev: &Event) {
        // Called for every event, streamed text included: leave early.
        if !matches!(
            ev,
            Event::TurnStarted { .. }
                | Event::TurnCompleted { .. }
                | Event::ProcessExited { .. }
                | Event::ApprovalRequested { .. }
                | Event::ApprovalResolved { .. }
                | Event::UserInputRequested { .. }
                | Event::UserInputResolved { .. }
        ) {
            return;
        }
        let sid = ev.session_id();
        let ended = matches!(
            ev,
            Event::TurnCompleted { .. } | Event::ProcessExited { .. }
        );
        if ended || matches!(ev, Event::TurnStarted { .. }) {
            let mut st = self.inner.orchestration.lock();
            st.delivering.remove(sid);
            st.reporting.remove(sid);
            if !matches!(ev, Event::TurnCompleted { .. }) {
                st.dispatched.remove(sid);
            }
        }
        let Ok(s) = self.get_session(sid) else { return };
        let stopped = match ev {
            Event::TurnCompleted { .. }
            | Event::ApprovalRequested { .. }
            | Event::UserInputRequested { .. } => true,
            Event::ProcessExited { message, .. } => message.is_some(),
            _ => false,
        };
        if stopped {
            if let Some(o) = s
                .orchestrator_id
                .clone()
                .filter(|o| self.get_session(o).is_ok_and(|o| o.orchestrator))
            {
                self.inner
                    .orchestration
                    .lock()
                    .queued
                    .entry(o.clone())
                    .or_default()
                    .insert(s.id.clone());
                self.flush_reports(&o);
            }
        }
        // Whatever made the orchestrator idle (a turn ending, an approval
        // resolved after it), it can take reports now. Not right after the
        // user interrupted it, though: that would set it going again at once.
        let interrupted = matches!(ev, Event::TurnCompleted { turn, .. } if turn.status == TurnStatus::Interrupted);
        if s.orchestrator && !interrupted {
            self.flush_reports(&s.id);
        }
    }

    /// Free to take a message from Aura: a structured session that is not
    /// working and not waiting on the user. Whether one is already being sent
    /// is checked when claiming the `delivering` gate.
    fn takes_aura_message(&self, s: &Session) -> bool {
        let busy = self
            .inner
            .runtimes
            .lock()
            .get(&s.id)
            .is_some_and(|r| r.current_turn.is_some());
        !s.archived
            && s.mode == SessionMode::Structured
            && matches!(s.status, SessionStatus::Idle | SessionStatus::Error)
            && !busy
    }

    /// Send a message from Aura (not the user) to a session if it is free to
    /// take it now. Returns false, sending nothing, when it is not. Shares the
    /// gate with worker reports, so the two never start two turns at once.
    pub async fn send_when_free(&self, id: &str, text: String) -> Result<bool> {
        let s = self.get_session(id)?;
        // Checked and claimed under one lock, so a worker report cannot slip in.
        if !self.takes_aura_message(&s)
            || !self
                .inner
                .orchestration
                .lock()
                .delivering
                .insert(id.to_string())
        {
            return Ok(false);
        }
        let result = self
            .send(
                id,
                Input {
                    text,
                    ..Default::default()
                },
            )
            .await;
        if result.is_err() {
            self.inner.orchestration.lock().delivering.remove(id);
        }
        result.map(|_| true)
    }

    /// The session's last reply since the last message it was sent.
    pub fn last_reply(&self, id: &str) -> Option<String> {
        let items = self.items(id).ok()?;
        let last_user = items
            .iter()
            .rposition(|i| i.kind == ItemKind::UserMessage)
            .map_or(0, |n| n + 1);
        items[last_user..]
            .iter()
            .rev()
            .find(|i| i.kind == ItemKind::AgentMessage && !i.text.trim().is_empty())
            .map(|i| tail(i.text.trim(), REPLY_LIMIT))
    }

    /// Send the orchestrator its queued reports, if it is free to take them.
    fn flush_reports(&self, orchestrator: &str) {
        let Ok(o) = self.get_session(orchestrator) else {
            return;
        };
        if o.archived {
            self.inner.orchestration.lock().queued.remove(orchestrator);
            return;
        }
        let busy = self
            .inner
            .runtimes
            .lock()
            .get(orchestrator)
            .is_some_and(|r| r.current_turn.is_some());
        if o.mode != SessionMode::Structured || o.status != SessionStatus::Idle || busy {
            return;
        }
        // Claim the gate in the same lock that checks it, so a message from
        // `send_when_free` cannot start a second turn at the same time.
        let workers = {
            let mut st = self.inner.orchestration.lock();
            if st.delivering.contains(orchestrator) {
                return;
            }
            match st.queued.remove(orchestrator) {
                Some(q) if !q.is_empty() => {
                    st.delivering.insert(orchestrator.to_string());
                    st.reporting.insert(orchestrator.to_string());
                    q
                }
                _ => return,
            }
        };
        let reports: Vec<WorkerReport> = workers
            .iter()
            .filter_map(|w| self.get_session(w).ok())
            .map(|s| self.report(&s))
            .collect();
        if reports.is_empty() {
            let mut st = self.inner.orchestration.lock();
            st.delivering.remove(orchestrator);
            st.reporting.remove(orchestrator);
            return;
        }
        let text = report_message(&reports);
        let me = self.clone();
        let id = orchestrator.to_string();
        tokio::spawn(async move {
            if let Err(e) = me
                .send(
                    &id,
                    Input {
                        text,
                        ..Default::default()
                    },
                )
                .await
            {
                {
                    let mut st = me.inner.orchestration.lock();
                    st.delivering.remove(&id);
                    st.reporting.remove(&id);
                }
                me.publish(Event::Notice {
                    session_id: id,
                    level: NoticeLevel::Warn,
                    message: format!("Could not deliver a worker report: {e:#}"),
                });
            }
        });
    }
}

/// Whether a worker's user message came from its orchestrator, not the user.
fn from_orchestrator(item: &Item) -> bool {
    item.data.get("from_orchestrator").is_some()
}

/// The message an orchestrator receives about workers that stopped.
pub fn report_message(reports: &[WorkerReport]) -> String {
    format!(
        "{}\n{}",
        crate::prompts::aura_header("Worker report"),
        describe_workers(reports)
    )
}

/// Workers as text for the orchestrator: status, what they wait on, last reply.
pub fn describe_workers(reports: &[WorkerReport]) -> String {
    let mut out = String::new();
    for r in reports {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "### {} (`{}`) · {} · {}\n",
            r.title,
            r.id,
            agent_line(&r.agent, r.model.as_deref(), r.effort.as_deref()),
            status_name(r.status)
        ));
        match &r.branch {
            Some(b) => out.push_str(&format!("In {} on branch `{b}`\n", r.cwd)),
            None => out.push_str(&format!("In {}\n", r.cwd)),
        }
        for w in &r.waiting_on_user {
            out.push_str(&format!("Waiting on the user: {w}\n"));
        }
        if let Some(e) = &r.last_error {
            out.push_str(&format!("Error: {e}\n"));
        }
        match &r.last_reply {
            Some(reply) => out.push_str(&format!("Last reply:\n{reply}\n")),
            None => out.push_str("No reply yet.\n"),
        }
    }
    out
}

/// Projects as text for the orchestrator.
pub fn describe_projects(projects: &[Project]) -> String {
    let mut out = String::new();
    for p in projects {
        out.push_str(&format!(
            "- `{}`{}{}{}\n",
            p.path,
            if p.repo { " (git repository)" } else { "" },
            match p.sessions {
                0 => String::new(),
                1 => " · 1 session".into(),
                n => format!(" · {n} sessions"),
            },
            if p.groups.is_empty() {
                String::new()
            } else {
                format!(" · group {}", p.groups.join(", "))
            },
        ));
    }
    out
}

fn parse_agent(agent: &str) -> Result<(ProviderKind, Option<String>)> {
    let a = agent.trim();
    match a.to_lowercase().as_str() {
        "" => bail!("name the agent: `claude`, `codex`, or an ACP agent id from list_agents"),
        "claude" | "claude-code" | "claude code" => Ok((ProviderKind::Claude, None)),
        "codex" => Ok((ProviderKind::Codex, None)),
        "terminal" => bail!("workers must be agents, not terminals"),
        _ => {
            let id = a.strip_prefix("acp:").unwrap_or(a).trim();
            if id.is_empty() {
                return Err(anyhow!("missing ACP agent id after `acp:`"));
            }
            Ok((ProviderKind::Acp, Some(id.to_string())))
        }
    }
}

fn resolve_dir(base: &str, dir: &str) -> String {
    let dir = match dir.strip_prefix("~/") {
        Some(rest) => dirs_home().join(rest),
        None => PathBuf::from(dir),
    };
    if dir.is_absolute() {
        dir
    } else {
        PathBuf::from(base).join(dir)
    }
    .to_string_lossy()
    .into_owned()
}

/// `p` with links and `..` resolved, also when only its parent exists yet.
fn canonical(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|c| c.join(name))
            .unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// An agent with the model and effort it runs, `default` for those not set:
/// `codex · gpt-5 · low`.
pub fn agent_line(agent: &str, model: Option<&str>, effort: Option<&str>) -> String {
    format!(
        "{agent} · {} · {}",
        model.filter(|m| !m.is_empty()).unwrap_or("default"),
        effort.filter(|e| !e.is_empty()).unwrap_or("default")
    )
}

fn label(s: &Session) -> String {
    match (s.provider, &s.agent) {
        (ProviderKind::Acp, Some(a)) => a.clone(),
        (p, _) => p.as_str().to_string(),
    }
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

fn status_name(s: SessionStatus) -> &'static str {
    match s {
        SessionStatus::Idle => "idle",
        SessionStatus::Running => "working",
        SessionStatus::WaitingApproval => "waiting for the user's approval",
        SessionStatus::WaitingInput => "waiting for the user's answer",
        SessionStatus::Error => "failed",
        SessionStatus::Exited => "exited",
    }
}

fn kind_name(k: ItemKind) -> &'static str {
    match k {
        ItemKind::ToolCall => "tool call",
        ItemKind::Plan => "plan",
        ItemKind::Subagent => "subagent",
        ItemKind::WebSearch => "web search",
        ItemKind::McpCall => "MCP call",
        _ => "step",
    }
}

/// The last `limit` bytes of `s`, cut at a character boundary.
fn tail(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut start = s.len() - limit;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_parse_to_providers() {
        assert_eq!(parse_agent("Claude").unwrap(), (ProviderKind::Claude, None));
        assert_eq!(parse_agent("codex").unwrap(), (ProviderKind::Codex, None));
        assert_eq!(
            parse_agent("gemini").unwrap(),
            (ProviderKind::Acp, Some("gemini".into()))
        );
        assert_eq!(
            parse_agent("acp:goose").unwrap(),
            (ProviderKind::Acp, Some("goose".into()))
        );
        assert!(parse_agent("").is_err());
        assert!(parse_agent("terminal").is_err());
        assert!(parse_agent("acp:").is_err());
    }

    #[test]
    fn relative_directories_resolve_against_the_orchestrator() {
        assert_eq!(resolve_dir("/repo", "sub"), "/repo/sub");
        assert_eq!(resolve_dir("/repo", "/abs"), "/abs");
    }

    #[test]
    fn long_replies_keep_their_end() {
        let s = format!("{}END", "x".repeat(10));
        assert_eq!(tail(&s, 5), "…xxEND");
        assert_eq!(tail("short", 10), "short");
        assert_eq!(tail("ééé", 3), "…é");
    }
}
