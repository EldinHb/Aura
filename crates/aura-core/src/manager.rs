use crate::event::*;
use crate::prompts::SystemPrompts;
use crate::provider::*;
use crate::store::*;
use crate::types::*;
use anyhow::{anyhow, bail, Context, Result};
use aura_pty::{PtyHandle, PtySpec};
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

mod attachments;
mod features;
#[cfg(test)]
mod generation_tests;
mod idle;
pub use idle::{FINISHED_RUN_GRACE, IDLE_STOP_DEFAULT_HOURS, IDLE_STOP_KEY};
mod orchestrator;
mod specialists;
mod suggest;
mod team;
mod workspaces;
pub use features::{AskSpec, CheckpointOutcome, HireSpec, ReportSpec};
pub use orchestrator::{
    agent_line, describe_projects, describe_workers, parse_agent, report_message, Project,
    WaitResult, WorkerReport, WorkerSpec,
};
pub use suggest::SuggestionRun;
pub use team::MeetingSpec;
pub use workspaces::{DEFAULT_WORKSPACE_NAME, LAST_ACTIVE_WORKSPACE_KEY, WORKSPACE_NAME_MAX};

/// Git worktree creation is provided by `aura-git`; the manager only needs this.
pub trait WorktreeBackend: Send + Sync {
    fn create(&self, cwd: &str, opts: &WorktreeOpts) -> Result<WorktreeInfo>;
    fn remove(&self, info: &WorktreeInfo) -> Result<()>;
    /// Root of the main working tree of the repository containing `cwd`, also
    /// from inside a linked worktree. None when `cwd` is not in a repository.
    fn repo_root(&self, _cwd: &str) -> Option<String> {
        None
    }
}

/// Feature-record namespace of the group registry, keyed by group name.
const GROUPS: &str = "groups";

#[derive(Default)]
struct Runtime {
    driver: Option<Arc<dyn Driver>>,
    pty: Option<PtyHandle>,
    pending_approvals: HashMap<String, Approval>,
    pending_inputs: HashMap<String, UserInputRequest>,
    current_turn: Option<Turn>,
    /// Items still streaming; replayed to late attachers.
    live_items: BTreeMap<String, Item>,
    /// Set while a resumed driver replays its native history: those items are
    /// already in the store, so they are broadcast but not persisted again.
    replaying: bool,
    /// Images sent with messages whose user message item has not completed.
    staged: attachments::Staged,
    /// The user (or an orchestrator) asked the process to stop: its exit is
    /// not a failure, even when a provider had to kill it. Reset when a new
    /// process starts.
    stopping: bool,
    /// A message went to the agent whose turn has not started yet: the
    /// session reads idle meanwhile, but is not (see `idle`).
    awaiting_turn: Option<std::time::Instant>,
    /// The generation of the newest driver started for the session. Events
    /// of an older one (a process stopped while a new one started) are
    /// dropped: its exit must not clear the new driver or its state.
    generation: u64,
    /// The session is being deleted: an agent that finishes starting
    /// meanwhile is stopped rather than kept.
    deleting: bool,
}

/// An event on its way to the manager, with the driver it came from; none
/// for the events the manager publishes itself.
struct Sourced {
    driver: Option<u64>,
    event: Event,
}

/// See [`Manager::on_scheduled_task_changed`].
pub type ScheduledTaskListener = Arc<dyn Fn(&str) + Send + Sync>;

/// What deleting a session and the sessions under it did.
struct TreeDeletion {
    deleted: Vec<SessionId>,
    failed: Vec<(Session, anyhow::Error)>,
    /// Workers under a session that failed, kept with it.
    kept: Vec<Session>,
}

/// A session was created but its agent did not start. The session is kept,
/// in the error state; `session_id` says which. Reads as the cause.
#[derive(Debug)]
pub struct SessionStartFailed {
    pub session_id: SessionId,
    pub error: anyhow::Error,
}

impl std::fmt::Display for SessionStartFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.error)
    }
}

impl std::error::Error for SessionStartFailed {}

struct Inner {
    store: Arc<dyn Store>,
    providers: HashMap<ProviderKind, Arc<dyn Provider>>,
    worktrees: Option<Arc<dyn WorktreeBackend>>,
    sessions: Mutex<BTreeMap<SessionId, Session>>,
    runtimes: Mutex<HashMap<SessionId, Runtime>>,
    events: broadcast::Sender<Event>,
    pty_out: broadcast::Sender<PtyChunk>,
    sink: mpsc::UnboundedSender<Sourced>,
    /// The generation the next driver started gets.
    next_generation: AtomicU64,
    /// Held while an event is applied, from the check that its driver is
    /// still the session's to its last effect, and while a session moves to
    /// a new driver: an event of the old one is applied wholly before the
    /// move (whose reset then clears what it left) or dropped after it.
    applying: Mutex<()>,
    /// One per session: held while its agent is started, a message is handed
    /// to it, or it is stopped, so these never interleave (a stop that waits
    /// for the old process cannot meet a message starting a new one).
    gates: Mutex<HashMap<SessionId, Arc<tokio::sync::Mutex<()>>>>,
    /// Serialises read-modify-write updates of the group registry.
    groups: Mutex<()>,
    /// Serialises changes to the workspace registry, and the placing of
    /// sessions in workspaces (see `workspaces`). Taken before `sessions`.
    workspaces: Mutex<()>,
    /// Serialises read-modify-write updates of scheduled task records: the
    /// scheduler's, and a workspace's tasks moving when it is deleted.
    scheduled_tasks: Mutex<()>,
    /// Told the id of a scheduled task the manager changed (moved out of a
    /// deleted workspace), so the scheduler announces it; see
    /// [`Manager::on_scheduled_task_changed`].
    scheduled_task_changed: Mutex<Option<ScheduledTaskListener>>,
    /// Serialises read-modify-write updates of feature records.
    features: Mutex<()>,
    /// Serialises changes to the stored specialists.
    specialists: Mutex<()>,
    /// Serialises changes to the specialists suggested from repeated work.
    suggestions: Mutex<()>,
    /// Held while a suggestion pass runs: one at a time.
    suggesting: tokio::sync::Mutex<()>,
    /// The cheap model suggestion passes run on; none in tests unless set.
    suggestion_model: Mutex<Option<Arc<dyn crate::suggestions::SuggestionModel>>>,
    orchestration: Mutex<orchestrator::State>,
    /// Where sent images are kept; see `attachments`.
    attachments_dir: Mutex<Option<std::path::PathBuf>>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

impl Manager {
    pub fn new(
        store: Arc<dyn Store>,
        providers: Vec<Arc<dyn Provider>>,
        worktrees: Option<Arc<dyn WorktreeBackend>>,
    ) -> Self {
        let (events, _) = broadcast::channel(4096);
        let (pty_out, _) = broadcast::channel(4096);
        let (sink, sink_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            store,
            providers: providers.into_iter().map(|p| (p.kind(), p)).collect(),
            worktrees,
            sessions: Mutex::new(BTreeMap::new()),
            runtimes: Mutex::new(HashMap::new()),
            events,
            pty_out,
            sink,
            next_generation: AtomicU64::new(1),
            applying: Mutex::new(()),
            gates: Mutex::new(HashMap::new()),
            groups: Mutex::new(()),
            workspaces: Mutex::new(()),
            scheduled_tasks: Mutex::new(()),
            scheduled_task_changed: Mutex::new(None),
            features: Mutex::new(()),
            specialists: Mutex::new(()),
            suggestions: Mutex::new(()),
            suggesting: tokio::sync::Mutex::new(()),
            suggestion_model: Mutex::new(None),
            orchestration: Mutex::new(Default::default()),
            attachments_dir: Mutex::new(None),
        });
        let m = Self { inner };
        m.spawn_event_loop(sink_rx);
        m
    }

    // ---------------------------------------------------------------- queries

    /// Held while a scheduled task record is read, changed and saved; see
    /// [`crate::ScheduleService`].
    pub(crate) fn lock_scheduled_tasks(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.inner.scheduled_tasks.lock()
    }

    /// Call `f` with the id of each scheduled task the manager itself
    /// changes. The scheduler sets it, to announce those changes as it does
    /// its own. `f` must not block or take the manager's locks.
    pub fn on_scheduled_task_changed(&self, f: ScheduledTaskListener) {
        *self.inner.scheduled_task_changed.lock() = Some(f);
    }

    pub(crate) fn scheduled_task_changed(&self, id: &str) {
        let f = self.inner.scheduled_task_changed.lock().clone();
        if let Some(f) = f {
            f(id);
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    pub fn subscribe_pty(&self) -> broadcast::Receiver<PtyChunk> {
        self.inner.pty_out.subscribe()
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        self.inner.sessions.lock().values().cloned().collect()
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        self.inner
            .sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown session {id}"))
    }

    /// Provider info, with stale CLI detection refreshed first. The daemon
    /// outlives the app, so a CLI upgraded while it ran would otherwise keep
    /// being reported at the version seen at startup.
    pub async fn providers(&self) -> Vec<ProviderInfo> {
        let providers: Vec<_> = self.inner.providers.values().cloned().collect();
        for p in &providers {
            p.refresh().await;
        }
        let mut v: Vec<_> = providers.iter().map(|p| p.info()).collect();
        v.sort_by_key(|p| p.kind.as_str());
        v
    }

    pub fn provider(&self, kind: ProviderKind) -> Result<Arc<dyn Provider>> {
        self.inner
            .providers
            .get(&kind)
            .cloned()
            .ok_or_else(|| anyhow!("provider {kind:?} not registered"))
    }

    pub async fn list_native(&self, kind: ProviderKind) -> Result<Vec<NativeSession>> {
        self.provider(kind)?.list_native().await
    }

    pub async fn list_models(&self, kind: ProviderKind) -> Result<Vec<ModelInfo>> {
        self.provider(kind)?.list_models().await
    }

    pub async fn list_commands(&self, kind: ProviderKind, cwd: &str) -> Result<Vec<SlashCommand>> {
        self.provider(kind)?.list_commands(cwd).await
    }

    /// Persisted history plus a snapshot of anything still in flight.
    pub fn history(&self, id: &str, after_seq: u64, limit: usize) -> Result<Vec<StoredEvent>> {
        let mut evs = self.inner.store.events(id, after_seq, limit)?;
        let rt = self.inner.runtimes.lock();
        if let Some(rt) = rt.get(id) {
            let now = crate::now();
            let mut seq = evs.last().map(|e| e.seq).unwrap_or(after_seq);
            let mut push = |event: Event| {
                seq += 1;
                evs.push(StoredEvent {
                    seq,
                    ts: now,
                    event,
                });
            };
            if let Some(t) = &rt.current_turn {
                push(Event::TurnStarted {
                    session_id: id.into(),
                    turn: t.clone(),
                });
            }
            for item in rt.live_items.values() {
                push(Event::ItemStarted {
                    session_id: id.into(),
                    item: item.clone(),
                });
            }
            for a in rt.pending_approvals.values() {
                push(Event::ApprovalRequested {
                    session_id: id.into(),
                    approval: a.clone(),
                });
            }
            for r in rt.pending_inputs.values() {
                push(Event::UserInputRequested {
                    session_id: id.into(),
                    request: r.clone(),
                });
            }
        }
        Ok(evs)
    }

    pub fn pending(&self) -> (Vec<Approval>, Vec<UserInputRequest>) {
        let rt = self.inner.runtimes.lock();
        let mut a: Vec<Approval> = rt
            .values()
            .flat_map(|r| r.pending_approvals.values().cloned())
            .collect();
        let mut u: Vec<UserInputRequest> = rt
            .values()
            .flat_map(|r| r.pending_inputs.values().cloned())
            .collect();
        a.sort_by_key(|x| x.created_at);
        u.sort_by_key(|x| x.created_at);
        (a, u)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        self.inner.store.search(query, limit)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.inner.store.get_setting(key)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.inner.store.set_setting(key, value)
    }

    // ---------------------------------------------------------- system prompts

    fn stored_prompts(&self) -> Result<crate::prompts::Stored> {
        Ok(
            match self.inner.store.get_setting(crate::prompts::SETTING_KEY)? {
                Some(raw) => {
                    serde_json::from_str(&raw).context("stored system prompts are unreadable")?
                }
                None => Default::default(),
            },
        )
    }

    pub fn system_prompts(&self) -> Result<SystemPrompts> {
        Ok(self.stored_prompts()?.view())
    }

    /// Set the global prompt; `None` goes back to Aura's default.
    pub async fn set_global_prompt(&self, prompt: Option<String>) -> Result<SystemPrompts> {
        let mut stored = self.stored_prompts()?;
        stored.global = prompt;
        self.inner.store.set_setting(
            crate::prompts::SETTING_KEY,
            &serde_json::to_string(&stored)?,
        )?;
        self.restart_idle_agents(|_| true).await;
        Ok(stored.view())
    }

    /// Set one agent's prompt (`claude`, `codex`, `acp:<id>`); empty or `None` removes it.
    pub async fn set_agent_prompt(
        &self,
        agent: &str,
        prompt: Option<String>,
    ) -> Result<SystemPrompts> {
        if agent.is_empty() {
            bail!("missing agent");
        }
        let mut stored = self.stored_prompts()?;
        match prompt.filter(|p| !p.trim().is_empty()) {
            Some(p) => stored.agents.insert(agent.to_string(), p),
            None => stored.agents.remove(agent),
        };
        self.inner.store.set_setting(
            crate::prompts::SETTING_KEY,
            &serde_json::to_string(&stored)?,
        )?;
        self.restart_idle_agents(|s| crate::prompts::agent_key(s) == agent)
            .await;
        Ok(stored.view())
    }

    /// Set a session's own prompt.
    pub async fn set_session_prompt(&self, id: &str, prompt: Option<String>) -> Result<Session> {
        self.update_session(id, |s| {
            s.system_prompt = prompt.filter(|p| !p.trim().is_empty())
        })?;
        self.restart_idle_agents(|s| s.id == id).await;
        self.get_session(id)
    }

    // ----------------------------------------------------------- load balancer

    pub(crate) fn stored_load_balancer(&self) -> Result<crate::load_balancer::Stored> {
        Ok(
            match self
                .inner
                .store
                .get_setting(crate::load_balancer::SETTING_KEY)?
            {
                Some(raw) => serde_json::from_str(&raw)
                    .context("stored load balancer settings are unreadable")?,
                None => Default::default(),
            },
        )
    }

    pub fn load_balancer(&self) -> Result<crate::LoadBalancer> {
        Ok(self.stored_load_balancer()?.view())
    }

    /// Save the load balancer. When that changes what orchestrators are told,
    /// idle ones restart with it on their next message.
    pub async fn set_load_balancer(
        &self,
        update: crate::LoadBalancerUpdate,
    ) -> Result<crate::LoadBalancer> {
        let before = self.stored_load_balancer().ok().and_then(|lb| lb.prompt());
        let stored = crate::load_balancer::Stored::from(update);
        self.inner.store.set_setting(
            crate::load_balancer::SETTING_KEY,
            &serde_json::to_string(&stored)?,
        )?;
        if stored.prompt() != before {
            self.restart_idle_agents(|s| s.orchestrator).await;
        }
        Ok(stored.view())
    }

    /// A changed prompt reaches an agent only when it starts. Stop the idle
    /// ones it applies to; each resumes with the new prompt on its next
    /// message. Agents in a turn keep their prompt until they next start.
    async fn restart_idle_agents(&self, applies: impl Fn(&Session) -> bool) {
        let idle: Vec<String> = self
            .list_sessions()
            .into_iter()
            .filter(|s| {
                s.mode == SessionMode::Structured && s.status == SessionStatus::Idle && applies(s)
            })
            .filter(|s| self.driver(&s.id).is_some())
            .map(|s| s.id)
            .collect();
        for id in idle {
            let _gate = self.gate(&id).await;
            // Checked again: a message may have started a turn meanwhile.
            let still_idle = self
                .get_session(&id)
                .is_ok_and(|s| s.status == SessionStatus::Idle)
                && self
                    .inner
                    .runtimes
                    .lock()
                    .get(&id)
                    .is_none_or(|rt| rt.current_turn.is_none() && rt.awaiting_turn.is_none());
            if still_idle {
                let _ = self.stop_gated(&id).await;
            }
        }
    }

    /// The system prompt a session's agent starts with.
    pub fn instructions_for(&self, s: &Session) -> Result<String> {
        let stored = self.stored_prompts()?;
        let global = stored
            .global
            .as_deref()
            .unwrap_or(crate::prompts::DEFAULT_GLOBAL_PROMPT);
        let key = crate::prompts::agent_key(s);
        let info = self.provider(s.provider).map(|p| p.info()).ok();
        let name = match (s.provider, &info) {
            (ProviderKind::Acp, Some(i)) => i
                .agents
                .iter()
                .find(|a| Some(&a.id) == s.agent.as_ref())
                .map(|a| a.display_name.clone())
                .unwrap_or_else(|| s.agent.clone().unwrap_or_default()),
            (_, Some(i)) => i.display_name.clone(),
            (_, None) => s.provider.as_str().to_string(),
        };
        let composed = crate::prompts::compose(
            global,
            stored.agents.get(&key).map(String::as_str),
            s,
            &name,
        );
        Ok(match self.orchestration_prompt(s) {
            Some(extra) => format!("{composed}\n\n{extra}"),
            None => composed,
        })
    }

    /// The session as handed to its provider: with the system prompt and MCP
    /// servers to start with.
    fn with_instructions(&self, s: &Session) -> Result<Session> {
        let mut s = s.clone();
        s.instructions = Some(self.instructions_for(&s)?);
        s.mcp_servers = self.mcp_servers_for(&s);
        Ok(s)
    }

    // -------------------------------------------------------------- lifecycle

    /// Load sessions from the store. Structured sessions become idle and are
    /// resumed lazily on the next message; terminal sessions are marked exited
    /// with their scrollback kept.
    pub fn restore(&self) -> Result<usize> {
        let stored = self.inner.store.list_sessions()?;
        let n = stored.len();
        let mut sessions = self.inner.sessions.lock();
        for mut s in stored {
            match s.mode {
                SessionMode::Terminal => {
                    if s.status != SessionStatus::Exited {
                        s.status = SessionStatus::Exited;
                        s.exit_code = None;
                    }
                }
                SessionMode::Structured => {
                    if s.status != SessionStatus::Error {
                        s.status = SessionStatus::Idle;
                    }
                }
            }
            s.pending_count = 0;
            // Its directory is Aura's; make it again if it went missing.
            if s.folderless && self.is_orchestrator_dir(&s.cwd) {
                if let Err(e) = std::fs::create_dir_all(&s.cwd) {
                    tracing::warn!("orchestrator directory {}: {e}", s.cwd);
                }
            }
            // What it waited on went with the old daemon; it has stopped.
            if s.attention == Some(Attention::Waiting) {
                s.attention = Some(Attention::Done);
            }
            let _ = self.inner.store.upsert_session(&s);
            self.inner.runtimes.lock().entry(s.id.clone()).or_default();
            sessions.insert(s.id.clone(), s);
        }
        drop(sessions);
        // Sessions grouped before the registry existed: register their groups once.
        let known: std::collections::HashSet<String> =
            self.list_groups()?.into_iter().map(|g| g.name).collect();
        for s in self.list_sessions() {
            if s.group.as_ref().is_some_and(|g| !known.contains(g)) {
                self.remember_group(&s);
            }
        }
        // Sessions and scheduled tasks from before workspaces go in the default one.
        self.backfill_workspaces()
            .context("put sessions and scheduled tasks in a workspace")?;
        // The user's answers that went with the old daemon before their owner took them.
        self.requeue_undelivered();
        Ok(n)
    }

    /// Stop every process and flush scrollback. Sessions stay resumable.
    pub async fn shutdown(&self) {
        self.begin_shutdown();
        let ids: Vec<String> = self.inner.sessions.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    /// Create a session. An orchestrator with an empty `cwd` belongs to no
    /// folder: Aura makes it a directory of its own.
    pub async fn create_session(&self, opts: CreateSessionOpts) -> Result<Session> {
        self.create(opts, None).await
    }

    /// `own_dir`: the directory of the orchestrator without a folder that a
    /// fork resumes in. Only Aura names one; callers cannot.
    async fn create(
        &self,
        mut opts: CreateSessionOpts,
        own_dir: Option<String>,
    ) -> Result<Session> {
        // A feature owner is an orchestrator with more to do.
        opts.orchestrator |= opts.feature_owner;
        let folderless = own_dir.is_some() || (opts.orchestrator && opts.cwd.trim().is_empty());
        if folderless && opts.worktree.is_some() {
            bail!("an orchestrator without a folder cannot have a worktree");
        }
        if opts.cwd.is_empty() && !folderless {
            opts.cwd = std::env::current_dir()?.to_string_lossy().to_string();
        }
        if !folderless {
            if !std::path::Path::new(&opts.cwd).is_dir() {
                bail!("cwd does not exist: {}", opts.cwd);
            }
            if self.in_orchestrator_dirs(&opts.cwd) {
                bail!(
                    "{} is where Aura keeps the directories of orchestrators; sessions cannot work there",
                    opts.cwd
                );
            }
        }
        if let Some(o) = &opts.orchestrator_id {
            if !self.get_session(o).is_ok_and(|o| o.orchestrator) {
                bail!("session {o} is not an orchestrator");
            }
        }
        self.check_requested_workspace(&opts)?;
        let provider = self.provider(opts.provider)?;
        if opts.provider == ProviderKind::Acp && opts.agent.as_deref().unwrap_or("").is_empty() {
            bail!("ACP sessions need an agent (e.g. `gemini`)");
        }
        let mut session = Session::new(&opts);
        if session.orchestrator && session.mode == SessionMode::Terminal {
            bail!(
                "an orchestrator runs in the structured view, where its workers' reports reach it"
            );
        }
        if folderless {
            session.folderless = true;
            session.cwd = match own_dir {
                Some(dir) => {
                    std::fs::create_dir_all(&dir)?;
                    dir
                }
                None => self.make_orchestrator_dir(&session.id)?,
            };
            if opts.title.is_none() {
                let role = if opts.feature_owner {
                    "feature owner"
                } else {
                    "orchestrator"
                };
                session.title = format!("{} · {role}", opts.label());
            }
        }
        if let Some(wt) = &opts.worktree {
            let backend = self
                .inner
                .worktrees
                .clone()
                .ok_or_else(|| anyhow!("git worktrees not available"))?;
            let info = backend
                .create(&opts.cwd, wt)
                .with_context(|| "create worktree")?;
            session.cwd = info.path.clone();
            session.worktree = Some(info);
            if opts.title.is_none() {
                session.title = format!("{} · {}", opts.label(), wt.branch);
            }
        }
        if session.mode == SessionMode::Terminal && session.command.is_none() {
            let argv = match opts.provider {
                ProviderKind::Terminal => aura_pty::default_shell(),
                _ => provider.terminal_command(&self.with_instructions(&session)?),
            };
            if argv.is_empty() {
                bail!("{} sessions have no terminal mode", opts.label());
            }
            session.command = Some(argv);
        }
        // Held from before anyone can see the session until its first agent
        // is in place: a message meanwhile waits for it, and goes to it,
        // rather than start a second agent beside it.
        let gate = self.gate(&session.id).await;
        // Placed and stored under the workspace lock, so it never lands in a
        // workspace deleted meanwhile, and a worker never misses its
        // orchestrator's move to another workspace.
        let stored = {
            let _workspaces = self.inner.workspaces.lock();
            // A scheduled run goes where its task is. The task lock is held
            // until the run is stored and in the list, so the task cannot
            // move to another workspace in between (lock order: workspaces,
            // scheduled tasks, sessions).
            let _tasks = session
                .scheduled_task_id
                .is_some()
                .then(|| self.inner.scheduled_tasks.lock());
            self.place_new_session_locked(&session)
                .and_then(|ws| {
                    session.workspace = ws;
                    self.inner.store.upsert_session(&session)
                })
                .map(|()| {
                    self.inner
                        .sessions
                        .lock()
                        .insert(session.id.clone(), session.clone());
                })
        };
        if let Err(e) = stored {
            drop(gate);
            self.inner.gates.lock().remove(&session.id);
            return Err(e);
        }
        // Its prompt carries the goal, so the record is there before it starts.
        if session.feature_owner {
            let feature = crate::features::Feature::new(
                &session.id,
                opts.feature_goal.as_deref().unwrap_or_default(),
                opts.autonomy.clone(),
            );
            if let Err(e) = self.save_feature(&feature) {
                tracing::warn!("save the feature of {}: {e:#}", session.id);
            }
        }
        self.inner
            .runtimes
            .lock()
            .insert(session.id.clone(), Runtime::default());
        self.broadcast(Event::SessionCreated {
            session: session.clone(),
        });
        self.remember_group(&session);

        match session.mode {
            SessionMode::Terminal => {
                drop(gate);
                self.spawn_pty(&session.id).await?;
            }
            SessionMode::Structured => {
                // A delete meanwhile waits for the gate; the agent sees the
                // session is being deleted when it is kept, and stops.
                let started = self.ensure_driver(&session.id, opts.fork).await;
                drop(gate);
                if let Err(e) = started {
                    self.set_error(&session.id, &e.to_string());
                    // The session stays, with the error: say which, so a caller
                    // (the scheduler) can point to it.
                    return Err(SessionStartFailed {
                        session_id: session.id.clone(),
                        error: e,
                    }
                    .into());
                }
                if let Some(p) = opts.initial_prompt.filter(|p| !p.trim().is_empty()) {
                    self.send(
                        &session.id,
                        Input {
                            text: p,
                            ..Default::default()
                        },
                    )
                    .await?;
                }
            }
        }
        self.get_session(&session.id)
    }

    /// Fork a structured session into a new native session.
    pub async fn fork(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        let native = s
            .native_id
            .clone()
            .ok_or_else(|| anyhow!("session has no native id yet"))?;
        if !self.provider(s.provider)?.capabilities().fork {
            bail!("provider does not support fork");
        }
        // The native session is found from the directory it ran in, so a fork
        // of an orchestrator without a folder resumes in that one.
        let own_dir = s.folderless.then(|| s.cwd.clone());
        // A fork of a feature owner owns a copy of the feature, without the
        // team, whose workers stay with the original.
        let feature = if s.feature_owner {
            self.feature(id).ok()
        } else {
            None
        };
        let forked = self
            .create(
                CreateSessionOpts {
                    provider: s.provider,
                    agent: s.agent.clone(),
                    cwd: s.cwd.clone(),
                    title: Some(format!("{} (fork)", s.title)),
                    group: s.group.clone(),
                    // A fork stays in its source's workspace.
                    workspace: Some(s.workspace.clone()),
                    mode: Some(SessionMode::Structured),
                    command: None,
                    model: s.model.clone(),
                    effort: s.effort.clone(),
                    permission_mode: s.permission_mode.clone(),
                    sandbox_mode: s.sandbox_mode.clone(),
                    worktree: None,
                    initial_prompt: None,
                    resume_native_id: Some(native),
                    fork: true,
                    system_prompt: s.system_prompt.clone(),
                    // A fork of an orchestrator still expects its tools; a fork of a
                    // worker was not started by the orchestrator, so it reports to no one.
                    orchestrator: s.orchestrator,
                    orchestrator_id: None,
                    feature_owner: s.feature_owner,
                    feature_goal: feature.as_ref().map(|f| f.goal.clone()),
                    autonomy: feature.as_ref().and_then(|f| f.autonomy.clone()),
                    specialist: None,
                    // The user forked it; no task started the fork.
                    scheduled_task: None,
                },
                own_dir,
            )
            .await?;
        if let Some(mut f) = feature {
            // Before the open questions are left out, so their ids stay taken.
            f.seed_counters();
            // What is under way stays with the original's team; what is done
            // is history the fork has already had.
            let meetings = f
                .meetings
                .into_iter()
                .filter(|m| !m.open())
                .map(|m| crate::features::Meeting {
                    delivered: true,
                    ..m
                })
                .collect();
            let one_on_ones = f
                .one_on_ones
                .into_iter()
                .filter(|a| a.status != crate::features::OneOnOneStatus::Open)
                .map(|a| crate::features::OneOnOne {
                    delivered: true,
                    ..a
                })
                .collect();
            let copy = crate::features::Feature {
                owner_id: forked.id.clone(),
                team: vec![],
                meetings,
                one_on_ones,
                questions: f.questions.into_iter().filter(|q| !q.open()).collect(),
                status: match f.status {
                    crate::features::FeatureStatus::WaitingOnUser => {
                        crate::features::FeatureStatus::InProgress
                    }
                    other => other,
                },
                updated_at: crate::now(),
                ..f
            };
            self.save_feature(&copy)?;
        }
        Ok(forked)
    }

    pub async fn send(&self, id: &str, input: Input) -> Result<()> {
        let s = self.get_session(id)?;
        match s.mode {
            SessionMode::Terminal => {
                if !input.images.is_empty() {
                    bail!("a terminal session cannot take images");
                }
                let mut data = input.text.into_bytes();
                data.push(b'\r');
                self.pty_input(id, &data)
            }
            SessionMode::Structured => {
                let driver = {
                    // Until the message is on its way, the agent is not
                    // stopped under it: once `awaiting_turn` is set the
                    // session no longer counts as quiet.
                    let _gate = self.gate(id).await;
                    let driver = self.ensure_driver(id, false).await?;
                    if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
                        rt.awaiting_turn = Some(std::time::Instant::now());
                    }
                    driver
                };
                self.stage_attachments(id, &input);
                let staged = (!input.images.is_empty()).then(|| input.text.clone());
                let sent = driver.send(input).await;
                if let (Err(_), Some(text)) = (&sent, staged) {
                    self.unstage(id, &text);
                }
                if sent.is_err() {
                    if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
                        rt.awaiting_turn = None;
                    }
                }
                sent
            }
        }
    }

    pub async fn interrupt(&self, id: &str) -> Result<()> {
        let s = self.get_session(id)?;
        match s.mode {
            SessionMode::Terminal => self.pty_input(id, b"\x03"),
            SessionMode::Structured => match self.driver(id) {
                Some(d) => d.interrupt().await,
                None => Ok(()),
            },
        }
    }

    pub async fn respond_approval(
        &self,
        id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<()> {
        let driver = self
            .driver(id)
            .ok_or_else(|| anyhow!("session is not running"))?;
        let exists = self
            .inner
            .runtimes
            .lock()
            .get(id)
            .map(|r| r.pending_approvals.contains_key(approval_id))
            .unwrap_or(false);
        if !exists {
            bail!("unknown approval {approval_id}");
        }
        driver
            .respond_approval(approval_id, decision.clone())
            .await?;
        self.publish(Event::ApprovalResolved {
            session_id: id.into(),
            approval_id: approval_id.into(),
            decision,
        });
        Ok(())
    }

    pub async fn respond_input(&self, id: &str, response: UserInputResponse) -> Result<()> {
        let driver = self
            .driver(id)
            .ok_or_else(|| anyhow!("session is not running"))?;
        let request = self
            .inner
            .runtimes
            .lock()
            .get(id)
            .and_then(|r| r.pending_inputs.get(&response.request_id).cloned())
            .ok_or_else(|| anyhow!("unknown input request {}", response.request_id))?;
        driver.respond_input(response.clone()).await?;
        self.publish(Event::UserInputResolved {
            session_id: id.into(),
            request_id: response.request_id.clone(),
            response: redact_secrets(&request, response),
        });
        Ok(())
    }

    pub async fn set(&self, id: &str, setting: Setting) -> Result<()> {
        let _ = self.get_session(id)?;
        if let Some(d) = self.driver(id) {
            d.set(setting.clone()).await?;
        }
        // Applied locally too so the next (re)start uses it.
        self.publish(Event::SettingChanged {
            session_id: id.into(),
            setting,
        });
        Ok(())
    }

    pub async fn action(
        &self,
        id: &str,
        name: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let driver = {
            let _gate = self.gate(id).await;
            self.ensure_driver(id, false).await?
        };
        driver.action(name, params).await
    }

    /// Dismiss the notices of one session, or of every session when `id` is None.
    pub fn clear_notices(&self, id: Option<&str>) -> Result<()> {
        let ids: Vec<String> = match id {
            Some(id) => vec![self.get_session(id)?.id],
            None => self.inner.sessions.lock().keys().cloned().collect(),
        };
        for session_id in ids {
            self.publish(Event::NoticesCleared { session_id });
        }
        Ok(())
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Session> {
        self.update_session(id, |s| s.title = title.to_string())
    }

    pub fn set_group(&self, id: &str, group: Option<String>) -> Result<Session> {
        let session = self.update_session(id, |s| s.group = group.clone())?;
        self.remember_group(&session);
        Ok(session)
    }

    // ----------------------------------------------------------------- groups

    /// Every remembered group, by name.
    pub fn list_groups(&self) -> Result<Vec<Group>> {
        let mut groups: Vec<Group> = self
            .inner
            .store
            .feature_records(GROUPS)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(g) => Some(g),
                Err(e) => {
                    tracing::warn!("skipping unreadable group {id}: {e}");
                    None
                }
            })
            .collect();
        groups.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(groups)
    }

    /// The group to suggest for a new session in `cwd`: of the groups linked to
    /// its repository, the one a session there joined last.
    pub fn group_for_dir(&self, cwd: &str) -> Result<Option<String>> {
        let Some(repo) = self.repo_root(cwd) else {
            return Ok(None);
        };
        Ok(self
            .list_groups()?
            .into_iter()
            .filter_map(|g| {
                g.repos
                    .iter()
                    .find(|r| r.path == repo)
                    .map(|r| (r.last_used, g.name.clone()))
            })
            .max()
            .map(|(_, name)| name))
    }

    /// Forget a group and take every session out of it.
    pub fn delete_group(&self, name: &str) -> Result<()> {
        {
            let _guard = self.inner.groups.lock();
            self.inner.store.delete_feature_record(GROUPS, name)?;
        }
        let members: Vec<String> = self
            .inner
            .sessions
            .lock()
            .values()
            .filter(|s| s.group.as_deref() == Some(name))
            .map(|s| s.id.clone())
            .collect();
        for id in members {
            self.update_session(&id, |s| s.group = None)?;
        }
        Ok(())
    }

    fn repo_root(&self, cwd: &str) -> Option<String> {
        self.inner.worktrees.as_ref()?.repo_root(cwd)
    }

    /// Register the session's group, linked to the session's repository. A
    /// failure is logged: it must not fail the change that triggered it.
    fn remember_group(&self, session: &Session) {
        let Some(name) = session.group.clone().filter(|g| !g.trim().is_empty()) else {
            return;
        };
        let repo = self.repo_root(&session.cwd);
        let _guard = self.inner.groups.lock();
        let result = (|| -> Result<()> {
            let mut group = match self
                .inner
                .store
                .feature_records(GROUPS)?
                .into_iter()
                .find(|(id, _)| *id == name)
            {
                Some((_, json)) => serde_json::from_str(&json)?,
                None => Group {
                    name: name.clone(),
                    repos: vec![],
                },
            };
            if let Some(path) = repo {
                group.repos.retain(|r| r.path != path);
                group.repos.push(GroupRepo {
                    path,
                    last_used: session.last_activity,
                });
                group.repos.sort_by(|a, b| a.path.cmp(&b.path));
            }
            self.inner
                .store
                .save_feature_record(GROUPS, &name, &serde_json::to_string(&group)?)
        })();
        if let Err(e) = result {
            tracing::warn!("remember group {name}: {e}");
        }
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<Session> {
        self.update_session(id, |s| s.pinned = pinned)
    }

    /// The user opened the session: forget what it wanted them to see.
    /// Not activity either, and a session without attention is left alone.
    pub fn mark_seen(&self, id: &str) -> Result<Session> {
        self.change_session(id, false, |s| s.attention.take().is_some())
    }

    pub async fn set_archived(&self, id: &str, archived: bool) -> Result<Session> {
        if archived {
            self.stop(id).await?;
        }
        let s = self.update_session(id, |s| s.archived = archived)?;
        if archived {
            self.unavailable(&s, "was archived", true);
        }
        Ok(s)
    }

    /// Stop a session because the user (or its orchestrator) asked to: as
    /// [`Manager::stop`], and what waits for it to answer, on a feature
    /// owner's team, gets no answer. Aura's own stops (a prompt changed, the
    /// daemon stopping) leave that waiting.
    pub async fn stop_by_request(&self, id: &str) -> Result<()> {
        // A feature owner the user stopped is sent nothing until the user
        // messages it: paused before the stop, so nothing slips in meanwhile.
        if self.get_session(id)?.feature_owner {
            self.pause_owner(id, true);
        }
        self.stop(id).await?;
        let s = self.get_session(id)?;
        // A team member's notes (an answer it asked for, say) wait until it
        // works again, rather than start it again on their own.
        if !s.orchestrator && self.team_owner(&s).is_some() {
            self.hold_all_notes(id);
        }
        self.unavailable(&s, "was stopped", true);
        Ok(())
    }

    /// Mark `id` as started by scheduled task `task_id` (named `task_name`),
    /// for sessions from before sessions recorded it. Not activity.
    pub fn link_scheduled_task(&self, id: &str, task_id: &str, task_name: &str) -> Result<Session> {
        self.change_session(id, false, |s| {
            if s.scheduled_task_id.is_some() {
                return false;
            }
            s.scheduled_task_id = Some(task_id.to_string());
            s.scheduled_task_name = Some(task_name.to_string());
            true
        })
    }

    /// Stop the process(es) behind a session but keep it (resumable).
    pub async fn stop(&self, id: &str) -> Result<()> {
        let _ = self.get_session(id)?;
        let _gate = self.gate(id).await;
        self.stop_gated(id).await
    }

    /// The gate of a session, taken: see `Inner::gates`.
    async fn gate(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = self
            .inner
            .gates
            .lock()
            .entry(id.to_string())
            .or_default()
            .clone();
        gate.lock_owned().await
    }

    /// [`Manager::stop`], with the session's gate already held.
    async fn stop_gated(&self, id: &str) -> Result<()> {
        let _ = self.get_session(id)?;
        // A stopped orchestrator is not started again by a note it has waiting.
        self.hold_notes(id);
        let (driver, pty) = {
            let mut rt = self.inner.runtimes.lock();
            let rt = rt.entry(id.to_string()).or_default();
            if rt.driver.is_some() || rt.pty.is_some() {
                rt.stopping = true;
            }
            (rt.driver.take(), rt.pty.take())
        };
        if let Some(d) = driver {
            let _ = d.stop().await;
        }
        if let Some(p) = pty {
            let _ = self.inner.store.save_scrollback(id, &p.scrollback());
            if !p.has_exited() {
                let _ = p.kill();
            }
        }
        let _ = self.update_session(id, |s| {
            s.status = match s.mode {
                SessionMode::Terminal => SessionStatus::Exited,
                SessionMode::Structured => SessionStatus::Idle,
            };
            s.pending_count = 0;
            // The user stopped it: it no longer waits on them.
            if s.attention == Some(Attention::Waiting) {
                s.attention = None;
            }
        });
        if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
            rt.pending_approvals.clear();
            rt.pending_inputs.clear();
            rt.current_turn = None;
            rt.live_items.clear();
        }
        Ok(())
    }

    /// Re-run the command of an exited terminal session.
    pub async fn restart(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        if s.mode != SessionMode::Terminal {
            bail!("only terminal sessions can be restarted");
        }
        self.stop(id).await?;
        self.spawn_pty(id).await?;
        self.get_session(id)
    }

    /// Stop and permanently remove a session and its history. An orchestrator
    /// takes its workers with it, and a worker that orchestrates takes its own.
    /// `remove_worktree` applies to this session only: the workers keep their
    /// worktrees, and what is uncommitted in them.
    ///
    /// A session already gone (deleted at the same time) is skipped, and one
    /// that cannot be deleted does not stop the rest: it is detached from its
    /// deleted orchestrator and reported in the error at the end. Its own
    /// workers stay with it.
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> Result<()> {
        self.get_session(id)?;
        let TreeDeletion { failed, kept, .. } = self.delete_tree(id, remove_worktree).await;
        if failed.is_empty() {
            return Ok(());
        }
        let mut msg = format!(
            "could not delete {}",
            failed
                .iter()
                .map(|(s, e)| format!("{} ({}): {e:#}", s.title, s.id))
                .collect::<Vec<_>>()
                .join("; ")
        );
        if !kept.is_empty() {
            msg.push_str(&format!(
                ". The workers under {0} are kept with {0}: {1}",
                if failed.len() == 1 { "it" } else { "them" },
                kept.iter()
                    .map(|s| format!("{} ({})", s.title, s.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        bail!(msg)
    }

    /// Delete each of `ids` as [`Manager::delete`] does, workers and all, and
    /// say per session what happened. One that cannot be deleted does not
    /// stop the rest; one already deleted with an earlier one's workers is
    /// skipped, not counted as failed. `remove_worktree` applies to the
    /// sessions named, not to the workers that go with them.
    pub async fn delete_many(&self, ids: &[String], remove_worktree: bool) -> BulkDeleteResult {
        let mut deleted: Vec<SessionId> = vec![];
        let mut failed: Vec<BulkDeleteFailure> = vec![];
        let mut done: HashSet<&str> = HashSet::new();
        for id in ids {
            if !done.insert(id) || deleted.contains(id) {
                continue;
            }
            if self.get_session(id).is_err() {
                failed.push(BulkDeleteFailure {
                    id: id.clone(),
                    error: format!("unknown session {id}"),
                });
                continue;
            }
            let tree = self.delete_tree(id, remove_worktree).await;
            deleted.extend(tree.deleted);
            for (s, e) in tree.failed {
                failed.retain(|f| f.id != s.id);
                failed.push(BulkDeleteFailure {
                    id: s.id,
                    error: format!("{e:#}"),
                });
            }
        }
        // One that failed under an earlier session and was named again later
        // may have gone the second time.
        failed.retain(|f| !deleted.contains(&f.id));
        BulkDeleteResult { deleted, failed }
    }

    /// Delete `id` and every session under it; see [`Manager::delete`].
    async fn delete_tree(&self, id: &str, remove_worktree: bool) -> TreeDeletion {
        let mut deleted: Vec<SessionId> = vec![];
        let mut failed: Vec<(Session, anyhow::Error)> = vec![];
        // Workers under a session that failed, left attached to it.
        let mut kept: Vec<Session> = vec![];
        // Each orchestrator goes before its workers, so a worker stopped on the
        // way has no one left to report to.
        let mut queue: VecDeque<Session> = self.with_workers(id).into();
        loop {
            while let Some(s) = queue.pop_front() {
                if deleted.contains(&s.id) || failed.iter().any(|(f, _)| f.id == s.id) {
                    continue;
                }
                // Its orchestrator comes first, so this knows whether it stayed.
                let under = |o: &str| {
                    failed.iter().any(|(f, _)| f.id == o) || kept.iter().any(|k| k.id == o)
                };
                if s.orchestrator_id.as_deref().is_some_and(under) {
                    kept.push(s);
                    continue;
                }
                match self.remove_session(&s, remove_worktree && s.id == id).await {
                    Ok(true) => deleted.push(s.id),
                    Ok(false) => {}
                    Err(e) => failed.push((s, e)),
                }
            }
            // Workers that started while their orchestrator was being deleted.
            let late: Vec<Session> = self
                .list_sessions()
                .into_iter()
                .filter(|s| {
                    s.orchestrator_id
                        .as_ref()
                        .is_some_and(|o| deleted.contains(o))
                        && !failed.iter().any(|(f, _)| f.id == s.id)
                })
                .collect();
            if late.is_empty() {
                break;
            }
            for s in late {
                queue.extend(self.with_workers(&s.id));
            }
        }
        for (s, _) in &failed {
            if s.orchestrator_id
                .as_ref()
                .is_some_and(|o| deleted.contains(o))
            {
                let _ = self.update_session(&s.id, |s| s.orchestrator_id = None);
            }
        }
        TreeDeletion {
            deleted,
            failed,
            kept,
        }
    }

    /// Delete one session. False when it was already gone.
    async fn remove_session(&self, s: &Session, remove_worktree: bool) -> Result<bool> {
        if self.get_session(&s.id).is_err() {
            return Ok(false);
        }
        // An agent still starting (under the gate the stop waits for) stops
        // itself instead of staying with a session about to go.
        self.set_deleting(&s.id, true);
        if let Err(e) = self.stop(&s.id).await {
            self.set_deleting(&s.id, false);
            return if self.get_session(&s.id).is_err() {
                Ok(false)
            } else {
                Err(e)
            };
        }
        // Under the sessions lock, which a change holds while storing the
        // session, so none can store it again. One the store keeps stays.
        {
            let mut sessions = self.inner.sessions.lock();
            let Some(gone) = sessions.remove(&s.id) else {
                return Ok(false);
            };
            if let Err(e) = self.inner.store.delete_session(&s.id) {
                sessions.insert(s.id.clone(), gone);
                drop(sessions);
                self.set_deleting(&s.id, false);
                return Err(e);
            }
        }
        self.inner.runtimes.lock().remove(&s.id);
        self.inner.gates.lock().remove(&s.id);
        self.delete_attachments(&s.id);
        self.drop_reports(&s.id);
        // Its meetings and one-on-ones go on without it.
        self.left_team(s);
        // Kept while it lived, also by an owner that stopped owning it.
        self.delete_feature(&s.id);
        if remove_worktree {
            if let (Some(wt), Some(backend)) = (&s.worktree, &self.inner.worktrees) {
                if let Err(e) = backend.remove(wt) {
                    tracing::warn!("remove worktree failed: {e}");
                }
            }
        }
        self.remove_orchestrator_dir(s);
        self.broadcast(Event::SessionRemoved {
            session_id: s.id.clone(),
        });
        Ok(true)
    }

    fn set_deleting(&self, id: &str, deleting: bool) {
        if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
            rt.deleting = deleting;
        }
    }

    /// Switch between the structured view and the provider's own TUI. The
    /// session can only run in one mode at a time.
    pub async fn switch_mode(&self, id: &str, mode: SessionMode) -> Result<Session> {
        let s = self.get_session(id)?;
        if s.mode == mode {
            return Ok(s);
        }
        let provider = self.provider(s.provider)?;
        match mode {
            SessionMode::Terminal if s.orchestrator => {
                bail!("an orchestrator stays in the structured view, where its workers' reports reach it")
            }
            SessionMode::Terminal => {
                let argv = provider.terminal_command(&self.with_instructions(&s)?);
                if argv.is_empty() {
                    bail!("provider has no terminal command");
                }
                self.stop(id).await?;
                self.update_session(id, |x| {
                    x.mode = SessionMode::Terminal;
                    x.command = Some(argv.clone());
                })?;
                self.spawn_pty(id).await?;
            }
            SessionMode::Structured => {
                if !provider.capabilities().structured {
                    bail!("provider has no structured mode");
                }
                let _gate = self.gate(id).await;
                self.stop_gated(id).await?;
                self.update_session(id, |x| {
                    x.mode = SessionMode::Structured;
                    x.status = SessionStatus::Idle;
                })?;
                if let Err(e) = self.ensure_driver(id, false).await {
                    self.set_error(id, &e.to_string());
                    return Err(e);
                }
            }
        }
        self.get_session(id)
    }

    // ------------------------------------------------------------------- pty

    pub fn pty_input(&self, id: &str, data: &[u8]) -> Result<()> {
        let pty = self
            .pty(id)
            .ok_or_else(|| anyhow!("session has no terminal"))?;
        pty.write(data)
    }

    pub fn pty_resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(p) = self.pty(id) {
            p.resize(cols, rows)?;
        }
        Ok(())
    }

    /// Current screen history: live buffer if running, else the saved copy.
    pub fn pty_scrollback(&self, id: &str) -> Result<Vec<u8>> {
        if let Some(p) = self.pty(id) {
            return Ok(p.scrollback());
        }
        Ok(self.inner.store.load_scrollback(id)?.unwrap_or_default())
    }

    async fn spawn_pty(&self, id: &str) -> Result<()> {
        let s = self.get_session(id)?;
        let argv = s.command.clone().unwrap_or_else(aura_pty::default_shell);
        let mut spec = PtySpec::new(argv, s.cwd.clone());
        spec.env.push(("AURA_SESSION_ID".into(), id.to_string()));
        let handle = PtyHandle::spawn(spec)?;
        if let Some(saved) = self.inner.store.load_scrollback(id)? {
            handle.seed_scrollback(&saved);
        }
        self.inner
            .runtimes
            .lock()
            .entry(id.to_string())
            .and_modify(|rt| rt.stopping = false)
            .or_default()
            .pty = Some(handle.clone());
        self.update_session(id, |x| {
            x.status = SessionStatus::Running;
            x.exit_code = None;
            x.last_error = None;
        })?;
        let me = self.clone();
        let sid = id.to_string();
        tokio::spawn(async move {
            let mut rx = handle.subscribe();
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
            let mut dirty = false;
            loop {
                tokio::select! {
                    chunk = rx.recv() => match chunk {
                        Ok(data) => {
                            dirty = true;
                            let _ = me.inner.pty_out.send(PtyChunk { session_id: sid.clone(), data });
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = tick.tick() => {
                        if dirty {
                            dirty = false;
                            let _ = me.inner.store.save_scrollback(&sid, &handle.scrollback());
                        }
                    }
                    code = handle.wait() => {
                        // drain remaining output briefly
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        while let Ok(data) = rx.try_recv() {
                            let _ = me.inner.pty_out.send(PtyChunk { session_id: sid.clone(), data });
                        }
                        let _ = me.inner.store.save_scrollback(&sid, &handle.scrollback());
                        let still_ours = me.inner.runtimes.lock().get(&sid)
                            .and_then(|r| r.pty.as_ref().map(|p| p.same(&handle)))
                            .unwrap_or(false);
                        if still_ours {
                            if let Some(rt) = me.inner.runtimes.lock().get_mut(&sid) { rt.pty = None; }
                            me.publish(Event::ProcessExited { session_id: sid.clone(), exit_code: code, message: None });
                        }
                        break;
                    }
                }
            }
        });
        Ok(())
    }

    // ---------------------------------------------------------------- drivers

    fn driver(&self, id: &str) -> Option<Arc<dyn Driver>> {
        self.inner
            .runtimes
            .lock()
            .get(id)
            .and_then(|r| r.driver.clone())
    }

    fn pty(&self, id: &str) -> Option<PtyHandle> {
        self.inner
            .runtimes
            .lock()
            .get(id)
            .and_then(|r| r.pty.clone())
    }

    /// The session's driver, started when it has none. The caller holds the
    /// session's gate, unless it just created the session.
    async fn ensure_driver(&self, id: &str, fork: bool) -> Result<Arc<dyn Driver>> {
        if let Some(d) = self.driver(id) {
            return Ok(d);
        }
        let s = self.get_session(id)?;
        if s.mode != SessionMode::Structured {
            bail!("session is in terminal mode");
        }
        let provider = self.provider(s.provider)?;
        if !provider.capabilities().structured {
            bail!("provider {:?} has no structured mode", s.provider);
        }
        let resuming =
            s.native_id.is_some() && !fork && !self.inner.store.events(id, 0, 1)?.is_empty();
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        {
            let _applying = self.inner.applying.lock();
            {
                let mut rts = self.inner.runtimes.lock();
                let rt = rts.entry(id.to_string()).or_default();
                rt.replaying = resuming;
                rt.stopping = false;
                // From here on, what an older driver still sends is stale.
                rt.generation = generation;
                // What an older one's events left after it was stopped
                // (an approval it asked for on its way out, say) is not
                // the new one's.
                rt.pending_approvals.clear();
                rt.pending_inputs.clear();
                rt.current_turn = None;
                rt.live_items.clear();
                rt.awaiting_turn = None;
            }
            let _ = self.change_session(id, false, |x| {
                let waiting = matches!(
                    x.status,
                    SessionStatus::Running
                        | SessionStatus::WaitingApproval
                        | SessionStatus::WaitingInput
                );
                if waiting {
                    x.status = SessionStatus::Idle;
                }
                if x.attention == Some(Attention::Waiting) {
                    x.attention = None;
                }
                let changed = waiting || x.pending_count != 0;
                x.pending_count = 0;
                changed
            });
        }
        let s = self.with_instructions(&s)?;
        let tx = self.inner.sink.clone();
        let sink = EventSink::new(move |event| {
            tx.send(Sourced {
                driver: Some(generation),
                event,
            })
            .is_ok()
        });
        let driver: Arc<dyn Driver> = Arc::from(provider.start(&s, fork, sink).await?);
        // Deleted while its agent started (with its orchestrator, say): the
        // agent would run on with no session to stop it.
        let kept = {
            let sessions = self.inner.sessions.lock();
            let mut rts = self.inner.runtimes.lock();
            if !sessions.contains_key(id) {
                rts.remove(id);
                Err("the session was deleted while its agent started")
            } else {
                let rt = rts.entry(id.to_string()).or_default();
                if rt.deleting {
                    Err("the session was deleted while its agent started")
                } else if rt.generation != generation {
                    // Never under the gate; would leave the session with a
                    // driver whose events all count as stale.
                    Err("another agent was started for the session meanwhile")
                } else {
                    rt.driver = Some(driver.clone());
                    Ok(())
                }
            }
        };
        if let Err(why) = kept {
            let _ = driver.stop().await;
            bail!("{why}");
        }
        let _ = self.update_session(id, |x| {
            if x.status == SessionStatus::Exited || x.status == SessionStatus::Error {
                x.status = SessionStatus::Idle;
            }
            x.last_error = None;
        });
        Ok(driver)
    }

    // ------------------------------------------------------------- internals

    fn broadcast(&self, event: Event) {
        let _ = self.inner.events.send(event);
    }

    /// Route an event through the same path drivers use (persist + state + broadcast).
    fn publish(&self, event: Event) {
        let _ = self.inner.sink.send(Sourced {
            driver: None,
            event,
        });
    }

    fn set_error(&self, id: &str, msg: &str) {
        let _ = self.update_session(id, |s| {
            s.status = SessionStatus::Error;
            s.last_error = Some(msg.to_string());
            s.attention = Some(Attention::Failed);
        });
    }

    /// Change a session as activity (it moves up and its age resets).
    fn update_session(&self, id: &str, f: impl FnOnce(&mut Session)) -> Result<Session> {
        self.change_session(id, true, |s| {
            f(s);
            true
        })
    }

    /// Change a session, then store and announce it. `f` returns whether it
    /// changed anything; if not, nothing is stored or announced. The sessions
    /// lock is held until the change is stored and broadcast, so two changes
    /// at once (an RPC and the event loop) are stored and announced in the
    /// order they were made, and neither overwrites the other with a stale copy.
    ///
    /// The live session changes even when the store fails, and the change is
    /// announced; the error is returned. What the agent and the daemon
    /// learned (a native id, a status, usage) must reach the live session
    /// whatever the disk does, and the next change that is stored carries it.
    fn change_session(
        &self,
        id: &str,
        activity: bool,
        f: impl FnOnce(&mut Session) -> bool,
    ) -> Result<Session> {
        self.apply_change(id, activity, false, f)
    }

    /// [`Manager::change_session`] for a change that is the user's decision
    /// rather than a fact (a session moving to another workspace): stored
    /// first, and not made at all when the store fails, so a retry sees
    /// what is stored.
    fn change_session_stored(
        &self,
        id: &str,
        activity: bool,
        f: impl FnOnce(&mut Session) -> bool,
    ) -> Result<Session> {
        self.apply_change(id, activity, true, f)
    }

    fn apply_change(
        &self,
        id: &str,
        activity: bool,
        stored_first: bool,
        f: impl FnOnce(&mut Session) -> bool,
    ) -> Result<Session> {
        let mut sessions = self.inner.sessions.lock();
        let s = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("unknown session {id}"))?;
        let mut updated = s.clone();
        if !f(&mut updated) {
            // Nothing to store; what `f` touched anyway is kept.
            *s = updated.clone();
            return Ok(updated);
        }
        if activity {
            updated.last_activity = crate::now();
        }
        let stored = self.inner.store.upsert_session(&updated);
        match &stored {
            Err(_) if stored_first => return stored.map(|()| updated),
            Err(e) => {
                tracing::warn!("store session {id}: {e:#}; it is stored with its next change")
            }
            Ok(()) => {}
        }
        *s = updated.clone();
        self.broadcast(Event::SessionUpdated {
            session: updated.clone(),
        });
        stored.map(|()| updated)
    }

    fn spawn_event_loop(&self, mut rx: mpsc::UnboundedReceiver<Sourced>) {
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(Sourced { driver, event }) = rx.recv().await {
                me.handle_event(event, driver);
            }
        });
    }

    /// Whether an event of driver generation `driver` comes from a driver the
    /// session has replaced since.
    fn stale(&self, id: &str, driver: Option<u64>) -> bool {
        let Some(g) = driver else {
            return false;
        };
        self.inner
            .runtimes
            .lock()
            .get(id)
            .is_some_and(|rt| rt.generation != g)
    }

    fn handle_event(&self, mut ev: Event, driver: Option<u64>) {
        let sid = ev.session_id().to_string();
        // Checked and applied under one lock, which a move to a new driver
        // takes too: no effect of a replaced driver's event lands after it.
        let _applying = self.inner.applying.lock();
        if self.stale(&sid, driver) {
            tracing::debug!("dropped an event of a replaced driver of session {sid}");
            return;
        }
        self.attach_staged(&mut ev);
        // Bookkeeping only: it must not touch the session row, which would
        // bump `last_activity` and reorder the sidebar.
        if matches!(ev, Event::NoticesCleared { .. }) {
            if let Err(e) = self.inner.store.append_event(&sid, &ev) {
                tracing::warn!("persist event failed: {e}");
            }
            self.broadcast(ev);
            return;
        }
        // An exit the user asked for is clean, even when the process had to be
        // killed, and wants no attention.
        let mut requested = false;
        if let Event::ProcessExited { message, .. } = &mut ev {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(sid.clone()).or_default();
            requested = std::mem::take(&mut rt.stopping);
            if requested {
                *message = None;
            }
        }
        let replaying = {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(sid.clone()).or_default();
            if matches!(ev, Event::TurnStarted { .. } | Event::ProcessExited { .. }) {
                rt.replaying = false;
                false
            } else {
                rt.replaying
            }
        };
        let skip_persist = replaying
            && matches!(
                ev,
                Event::ItemStarted { .. }
                    | Event::ItemCompleted { .. }
                    | Event::TurnCompleted { .. }
            );
        if ev.is_persistent() && !skip_persist {
            if let Err(e) = self.inner.store.append_event(&sid, &ev) {
                tracing::warn!("persist event failed: {e}");
            }
        }
        // Update in-memory runtime state.
        {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(sid.clone()).or_default();
            match &ev {
                Event::TurnStarted { turn, .. } => {
                    rt.current_turn = Some(turn.clone());
                    rt.awaiting_turn = None;
                }
                Event::TurnCompleted { .. } => {
                    rt.current_turn = None;
                    rt.live_items.clear();
                }
                Event::ItemStarted { item, .. } => {
                    rt.live_items.insert(item.id.clone(), item.clone());
                }
                Event::ItemDelta { item_id, delta, .. } => {
                    if let Some(item) = rt.live_items.get_mut(item_id) {
                        apply_delta(item, delta);
                    }
                }
                Event::ItemCompleted { item, .. } => {
                    rt.live_items.remove(&item.id);
                }
                Event::ApprovalRequested { approval, .. } => {
                    rt.pending_approvals
                        .insert(approval.id.clone(), approval.clone());
                }
                Event::ApprovalResolved { approval_id, .. } => {
                    rt.pending_approvals.remove(approval_id);
                }
                Event::UserInputRequested { request, .. } => {
                    rt.pending_inputs
                        .insert(request.id.clone(), request.clone());
                }
                Event::UserInputResolved { request_id, .. } => {
                    rt.pending_inputs.remove(request_id);
                }
                Event::ProcessExited { .. } => {
                    rt.driver = None;
                    rt.awaiting_turn = None;
                    rt.pending_approvals.clear();
                    rt.pending_inputs.clear();
                    rt.current_turn = None;
                    rt.live_items.clear();
                }
                _ => {}
            }
        }
        let pending = self
            .inner
            .runtimes
            .lock()
            .get(&sid)
            .map(|r| (r.pending_approvals.len() + r.pending_inputs.len()) as u32)
            .unwrap_or(0);
        let running = self
            .inner
            .runtimes
            .lock()
            .get(&sid)
            .map(|r| r.current_turn.is_some())
            .unwrap_or(false);

        // A turn a worker report started is the orchestrator's own business:
        // what finished before it is still news, and it is only news itself
        // once the orchestrator's workers are done.
        let report_turn = self.report_turn(&ev);
        // So is a turn in which a worker answers a meeting or a teammate.
        let answer_turn = self.answer_turn(&ev);
        let quiet = (report_turn && self.quiet_report_turn(&ev, pending)) || answer_turn.is_some();

        // Update the session row.
        let _ = self.update_session(&sid, |s| {
            s.pending_count = pending;
            // A resumed session replays turns the user has already seen.
            if !replaying && !requested && !quiet {
                if let Some(a) = attention_for(&ev, s.mode, pending) {
                    s.attention = Some(merge_attention(s.attention, a));
                }
            }
            // It is running again: what finished before is no longer news.
            if matches!(ev, Event::TurnStarted { .. })
                && !report_turn
                && answer_turn.is_none()
                && s.attention == Some(Attention::Done)
            {
                s.attention = None;
            }
            // Answered, from the inbox say: a turn that goes on asks again when it
            // ends, one that already ended (it can before the answer is recorded) is done.
            if pending == 0 && s.attention == Some(Attention::Waiting) {
                s.attention = (!running).then_some(Attention::Done);
            }
            match &ev {
                Event::TurnStarted { .. } => s.status = SessionStatus::Running,
                Event::TurnCompleted { turn, .. } => {
                    s.status = if pending > 0 {
                        SessionStatus::WaitingApproval
                    } else {
                        SessionStatus::Idle
                    };
                    // A turn's usage is what that turn spent; the session's
                    // totals arrive as `Event::Usage`.
                    if turn.status == TurnStatus::Failed {
                        s.last_error = turn.error.clone();
                    }
                }
                Event::ApprovalRequested { .. } => s.status = SessionStatus::WaitingApproval,
                Event::UserInputRequested { .. } => s.status = SessionStatus::WaitingInput,
                Event::ApprovalResolved { .. } | Event::UserInputResolved { .. } => {
                    if pending > 0 {
                        // keep waiting state for the remaining ones
                    } else if running {
                        s.status = SessionStatus::Running;
                    } else {
                        s.status = SessionStatus::Idle;
                    }
                }
                Event::NativeId { native_id, .. } => s.native_id = Some(native_id.clone()),
                Event::Usage { usage, .. } => s.usage = usage.clone(),
                Event::SettingChanged { setting, .. } => match setting {
                    Setting::Model(m) => s.model = Some(m.clone()),
                    Setting::Effort(e) => s.effort = Some(e.clone()),
                    Setting::PermissionMode(p) => s.permission_mode = Some(p.clone()),
                    Setting::SandboxMode(p) => s.sandbox_mode = Some(p.clone()),
                },
                Event::ProcessExited {
                    exit_code, message, ..
                } => {
                    s.exit_code = *exit_code;
                    match s.mode {
                        SessionMode::Terminal => s.status = SessionStatus::Exited,
                        SessionMode::Structured => {
                            if let Some(m) = message {
                                s.status = SessionStatus::Error;
                                s.last_error = Some(m.clone());
                            } else {
                                s.status = SessionStatus::Idle;
                            }
                        }
                    }
                }
                Event::Notice {
                    level: NoticeLevel::Error,
                    message,
                    ..
                } => {
                    s.last_error = Some(message.clone());
                }
                _ => {}
            }
        });
        self.on_orchestration_event(&ev, answer_turn);
        self.broadcast(ev);
    }
}

/// What an event asks of the user, if it stops the agent: the same stops an
/// orchestrator hears about, plus a terminal command exiting.
fn attention_for(ev: &Event, mode: SessionMode, pending: u32) -> Option<Attention> {
    match ev {
        Event::ApprovalRequested { .. } | Event::UserInputRequested { .. } => {
            Some(Attention::Waiting)
        }
        Event::TurnCompleted { turn, .. } => Some(match turn.status {
            TurnStatus::Failed => Attention::Failed,
            _ if pending > 0 => Attention::Waiting,
            _ => Attention::Done,
        }),
        Event::ProcessExited {
            message: Some(_), ..
        } => Some(Attention::Failed),
        Event::ProcessExited { exit_code, .. } if mode == SessionMode::Terminal => {
            Some(match exit_code {
                Some(code) if *code != 0 => Attention::Failed,
                _ => Attention::Done,
            })
        }
        _ => None,
    }
}

/// The marker after `new` happens to a session marked `old` that the user has
/// not seen: a failure stays until seen, unless the agent then waits on them.
fn merge_attention(old: Option<Attention>, new: Attention) -> Attention {
    match (old, new) {
        (Some(Attention::Failed), Attention::Done) => Attention::Failed,
        _ => new,
    }
}

pub fn apply_delta(item: &mut Item, delta: &ItemDelta) {
    match delta {
        ItemDelta::Text { text } => item.text.push_str(text),
        ItemDelta::Output { text } => {
            let out = item
                .data
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
                + text;
            if let Some(obj) = item.data.as_object_mut() {
                obj.insert("output".into(), serde_json::Value::String(out));
            } else {
                item.data = serde_json::json!({ "output": out });
            }
        }
        ItemDelta::Data { data } => {
            if let (Some(dst), Some(src)) = (item.data.as_object_mut(), data.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            } else {
                item.data = data.clone();
            }
        }
    }
}

/// The resolved event is stored and broadcast; answers to secret questions
/// reach the agent but not the log.
fn redact_secrets(
    request: &UserInputRequest,
    mut response: UserInputResponse,
) -> UserInputResponse {
    for q in request.questions.iter().filter(|q| q.secret) {
        if let Some(a) = response.answers.get_mut(&q.id) {
            *a = vec!["(hidden)".into()];
        }
    }
    response
}
