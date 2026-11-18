//! The scheduler: keeps the scheduled tasks (see [`crate::schedule`]) and
//! starts a session for each when its time comes. It runs in the daemon, so
//! tasks fire without the app open. The app's `schedules.*` methods and an
//! orchestrator's `orchestrator.schedules.*` tools both end up in the same
//! functions here.

use crate::manager::{parse_agent, Manager};
use crate::schedule::*;
use crate::store::Store;
use crate::types::*;
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Duration, Local, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{broadcast, Notify};
use ts_rs::TS;

/// History entries kept per task.
pub const HISTORY_KEPT: usize = 200;
/// A run this late came due while Aura was not running or the computer slept.
const GRACE: Duration = Duration::minutes(2);
/// The scheduler looks at the clock at least this often, so a computer
/// waking from sleep runs what came due without waiting for a timer.
const MAX_SLEEP: std::time::Duration = std::time::Duration::from_secs(30);
/// Never sooner than this, so a task that cannot be saved does not spin the loop.
const MIN_SLEEP: std::time::Duration = std::time::Duration::from_millis(250);
/// A session this young that has not started its turn yet still counts as working.
const STARTING: Duration = Duration::seconds(60);

/// Fields of a task to create or change. On a change, a missing field stays
/// as it is and an empty text clears an optional one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export)]
pub struct ScheduledTaskInput {
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub prompt: Option<String>,
    #[ts(optional)]
    pub agent: Option<String>,
    #[ts(optional)]
    pub model: Option<String>,
    #[ts(optional)]
    pub effort: Option<String>,
    #[ts(optional)]
    pub permission_mode: Option<String>,
    #[ts(optional)]
    pub sandbox_mode: Option<String>,
    #[ts(optional)]
    pub cwd: Option<String>,
    #[ts(optional)]
    pub worktree: Option<bool>,
    #[ts(optional)]
    pub branch_prefix: Option<String>,
    #[ts(optional)]
    pub group: Option<String>,
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[ts(optional)]
    pub schedule: Option<Schedule>,
    #[ts(optional)]
    pub missed: Option<MissedRuns>,
    #[ts(optional)]
    pub allow_overlap: Option<bool>,
}

/// Who changes a task.
#[derive(Debug, Clone)]
pub enum Editor {
    /// The user, in the app or the CLI.
    User,
    /// An orchestrator, through its tools.
    Orchestrator(Box<Session>),
}

/// A run the scheduler decided on and is about to carry out.
struct Fire {
    task: ScheduledTask,
    trigger: RunTrigger,
    slot: Option<DateTime<Utc>>,
    /// Runs that went by while Aura was not running.
    missed: u64,
}

type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

pub struct ScheduleService {
    manager: Manager,
    store: Arc<dyn Store>,
    events: broadcast::Sender<Value>,
    clock: Clock,
    /// Read-modify-write of task records.
    lock: Mutex<()>,
    /// Tasks whose session is being started right now.
    starting: Mutex<HashSet<String>>,
    /// The session each task started last, and when, until it starts its turn.
    fresh: Mutex<HashMap<String, (String, DateTime<Utc>)>>,
    wake: Notify,
    stop: Notify,
}

impl ScheduleService {
    pub fn new(
        manager: Manager,
        store: Arc<dyn Store>,
        events: broadcast::Sender<Value>,
    ) -> Arc<Self> {
        Self::with_clock(manager, store, events, Arc::new(Utc::now))
    }

    /// With a clock of the caller's, for tests.
    pub fn with_clock(
        manager: Manager,
        store: Arc<dyn Store>,
        events: broadcast::Sender<Value>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            manager,
            store,
            events,
            clock,
            lock: Mutex::new(()),
            starting: Mutex::new(HashSet::new()),
            fresh: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            stop: Notify::new(),
        })
    }

    fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }

    /// Run the scheduler until [`Self::shutdown`].
    pub fn launch(self: &Arc<Self>) {
        // The time zone may have changed while Aura was not running: the next
        // run of each task follows the clock it has now.
        if let Err(e) = self.refresh_next_runs() {
            tracing::warn!("scheduled tasks: {e:#}");
        }
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let fires = match this.collect_due() {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::warn!("scheduled tasks: {e:#}");
                        vec![]
                    }
                };
                for fire in fires {
                    let s = this.clone();
                    tokio::spawn(async move {
                        s.carry_out(fire).await;
                    });
                }
                let sleep = this
                    .soonest()
                    .map(|t| (t - this.now()).to_std().unwrap_or_default())
                    .unwrap_or(MAX_SLEEP)
                    .clamp(MIN_SLEEP, MAX_SLEEP);
                tokio::select! {
                    _ = tokio::time::sleep(sleep) => {}
                    _ = this.wake.notified() => {}
                    _ = this.stop.notified() => break,
                }
            }
        });
    }

    pub fn shutdown(&self) {
        self.stop.notify_one();
    }

    /// Carry out everything due now and return what happened. The daemon's
    /// loop does this on its own; tests call it.
    pub async fn tick(self: &Arc<Self>) -> Result<Vec<ScheduledRun>> {
        let mut runs = vec![];
        for fire in self.collect_due()? {
            runs.push(self.carry_out(fire).await);
        }
        Ok(runs)
    }

    fn soonest(&self) -> Option<DateTime<Utc>> {
        self.store
            .scheduled_tasks()
            .ok()?
            .iter()
            .filter_map(|t| t.next_run)
            .min()
    }

    fn refresh_next_runs(&self) -> Result<()> {
        let _guard = self.lock.lock();
        for mut task in self.store.scheduled_tasks()? {
            let next = task.compute_next(&Local);
            if next != task.next_run {
                task.next_run = next;
                self.store.save_scheduled_task(&task)?;
            }
        }
        Ok(())
    }

    /// The tasks due now, each marked as handled up to now so it is not run twice.
    fn collect_due(&self) -> Result<Vec<Fire>> {
        let now = self.now();
        let _guard = self.lock.lock();
        let mut fires = vec![];
        for mut task in self.store.scheduled_tasks()? {
            let Some(next) = task.next_run.filter(|_| task.enabled) else {
                continue;
            };
            let Some(due) = due(&task.schedule, &Local, task.anchor, next, now) else {
                continue;
            };
            task.last_slot = Some(due.slot);
            task.next_run = task.compute_next(&Local);
            self.store.save_scheduled_task(&task)?;
            // Late by more than a moment, or with runs before it: Aura was
            // not running (or the computer slept) when they came due.
            let late = due.skipped > 0 || now - due.slot > GRACE;
            let missed = due.skipped + u64::from(late);
            fires.push(Fire {
                trigger: if late {
                    RunTrigger::CatchUp
                } else {
                    RunTrigger::Schedule
                },
                slot: Some(due.slot),
                missed: if late { missed } else { 0 },
                task,
            });
        }
        Ok(fires)
    }

    async fn carry_out(&self, fire: Fire) -> ScheduledRun {
        let Fire {
            task,
            trigger,
            slot,
            missed,
        } = fire;
        if trigger == RunTrigger::CatchUp && task.missed == MissedRuns::Skip {
            let message = format!(
                "{} went by while Aura was not running or the computer was asleep; skipped, as the task is set to skip missed runs.",
                runs_phrase(missed)
            );
            return self.record(
                &task,
                trigger,
                slot,
                RunResult::Skipped,
                None,
                Some(message),
            );
        }
        let note = (trigger == RunTrigger::CatchUp).then(|| {
            format!(
                "{} went by while Aura was not running or the computer was asleep; this one run makes up for them.",
                runs_phrase(missed)
            )
        });
        self.start(&task, trigger, slot, note).await
    }

    /// Start a session for `task`, unless its previous one is still working
    /// and the task does not allow overlapping runs.
    async fn start(
        &self,
        task: &ScheduledTask,
        trigger: RunTrigger,
        slot: Option<DateTime<Utc>>,
        note: Option<String>,
    ) -> ScheduledRun {
        if !task.allow_overlap {
            if let Some(busy) = self.working_session(task) {
                let message = format!(
                    "The previous run, “{}”, is still working, so no second session was started. Allow overlapping runs to start one anyway.",
                    busy.title
                );
                let mut run = self.record(
                    task,
                    trigger,
                    slot,
                    RunResult::Skipped,
                    Some(&busy),
                    Some(message),
                );
                // The link is to the session that is still working.
                run.session_title = Some(busy.title);
                return run;
            }
            if !self.starting.lock().insert(task.id.clone()) {
                return self.record(
                    task,
                    trigger,
                    slot,
                    RunResult::Skipped,
                    None,
                    Some("The previous run was still starting its session.".into()),
                );
            }
        }
        let started = self.manager.create_session(self.session_opts(task)).await;
        self.starting.lock().remove(&task.id);
        match started {
            Ok(session) => {
                self.fresh
                    .lock()
                    .insert(task.id.clone(), (session.id.clone(), self.now()));
                self.record(
                    task,
                    trigger,
                    slot,
                    RunResult::Started,
                    Some(&session),
                    note,
                )
            }
            Err(e) => {
                tracing::warn!("scheduled task {}: {e:#}", task.name);
                let message = match note {
                    Some(n) => format!("{e:#}\n{n}"),
                    None => format!("{e:#}"),
                };
                self.record(task, trigger, slot, RunResult::Failed, None, Some(message))
            }
        }
    }

    /// A session an earlier run of `task` started that is still at work.
    fn working_session(&self, task: &ScheduledTask) -> Option<Session> {
        let now = self.now();
        let fresh = self.fresh.lock().get(&task.id).cloned();
        let mut ids: Vec<String> = self
            .store
            .scheduled_runs(&task.id, 50)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.result == RunResult::Started)
            .filter_map(|r| r.session_id)
            .collect();
        if let Some((id, _)) = &fresh {
            ids.push(id.clone());
        }
        ids.into_iter().find_map(|id| {
            let s = self.manager.get_session(&id).ok()?;
            let working = matches!(
                s.status,
                SessionStatus::Running
                    | SessionStatus::WaitingApproval
                    | SessionStatus::WaitingInput
            );
            // Just started: the agent may not have begun its turn yet.
            let starting = fresh.as_ref().is_some_and(|(f, at)| {
                *f == id
                    && now - *at < STARTING
                    && s.status == SessionStatus::Idle
                    && s.attention.is_none()
            });
            (working || starting).then_some(s)
        })
    }

    fn session_opts(&self, task: &ScheduledTask) -> CreateSessionOpts {
        let local = self.now().with_timezone(&Local);
        let (provider, agent) = parse_agent(&task.agent).unwrap_or((ProviderKind::Claude, None));
        let worktree = task.worktree.then(|| WorktreeOpts {
            branch: format!("{}-{}", branch_prefix(task), local.format("%Y%m%d-%H%M%S")),
            base: None,
            path: None,
        });
        CreateSessionOpts {
            provider,
            agent,
            cwd: task.cwd.clone(),
            title: Some(format!(
                "{} · {}",
                task.name,
                local.format("%a %-d %b %H:%M")
            )),
            group: task.group.clone(),
            model: task.model.clone(),
            effort: task.effort.clone(),
            permission_mode: task.permission_mode.clone(),
            sandbox_mode: task.sandbox_mode.clone(),
            worktree,
            initial_prompt: Some(task.prompt.clone()),
            ..Default::default()
        }
    }

    fn record(
        &self,
        task: &ScheduledTask,
        trigger: RunTrigger,
        slot: Option<DateTime<Utc>>,
        result: RunResult,
        session: Option<&Session>,
        message: Option<String>,
    ) -> ScheduledRun {
        let run = ScheduledRun {
            id: crate::new_id(),
            task_id: task.id.clone(),
            at: self.now(),
            slot,
            trigger,
            result,
            session_id: session.map(|s| s.id.clone()),
            session_title: session.map(|s| s.title.clone()),
            message,
        };
        let saved = (|| -> Result<()> {
            let _guard = self.lock.lock();
            // The task may have been deleted while its session started.
            let Some(mut current) = self.find(&task.id)? else {
                return Ok(());
            };
            self.store.add_scheduled_run(&run, HISTORY_KEPT)?;
            current.last_run = Some(run.clone());
            self.store.save_scheduled_task(&current)
        })();
        if let Err(e) = saved {
            tracing::warn!("record a run of scheduled task {}: {e:#}", task.name);
        }
        self.changed(&task.id);
        run
    }

    fn changed(&self, id: &str) {
        let _ = self
            .events
            .send(json!({ "method": "schedules.changed", "params": { "id": id } }));
        self.wake.notify_one();
    }

    fn find(&self, id: &str) -> Result<Option<ScheduledTask>> {
        Ok(self
            .store
            .scheduled_tasks()?
            .into_iter()
            .find(|t| t.id == id))
    }

    pub fn list(&self) -> Result<Vec<ScheduledTask>> {
        self.store.scheduled_tasks()
    }

    pub fn get(&self, id: &str) -> Result<ScheduledTask> {
        self.find(id)?
            .ok_or_else(|| anyhow!("no scheduled task `{id}`; list_scheduled_tasks shows them"))
    }

    pub fn runs(&self, id: &str, limit: usize) -> Result<Vec<ScheduledRun>> {
        self.get(id)?;
        self.store.scheduled_runs(id, limit)
    }

    /// The next `count` run times of `schedule` if it were set now.
    pub fn preview(&self, schedule: &Schedule, count: usize) -> Result<Vec<DateTime<Utc>>> {
        schedule.validate()?;
        let now = self.now();
        Ok(schedule.upcoming(&Local, now, now, count.min(50)))
    }

    pub fn create(&self, input: ScheduledTaskInput, by: &Editor) -> Result<ScheduledTask> {
        let now = self.now();
        let required = |v: &Option<String>, what: &str| {
            v.as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("`{what}` is required"))
        };
        let mut task = ScheduledTask {
            id: crate::new_id(),
            name: required(&input.name, "name")?,
            prompt: required(&input.prompt, "prompt")?,
            agent: required(&input.agent, "agent")?,
            model: None,
            effort: None,
            permission_mode: None,
            sandbox_mode: None,
            cwd: required(&input.cwd, "cwd")?,
            worktree: false,
            branch_prefix: None,
            group: None,
            enabled: true,
            schedule: input
                .schedule
                .clone()
                .ok_or_else(|| anyhow!("`schedule` is required"))?,
            missed: MissedRuns::RunOnce,
            allow_overlap: false,
            created_at: now,
            updated_at: now,
            anchor: now,
            last_slot: None,
            next_run: None,
            last_run: None,
            created_by: match by {
                Editor::User => None,
                Editor::Orchestrator(o) => Some(ScheduleSource {
                    orchestrator: o.id.clone(),
                    orchestrator_title: o.title.clone(),
                }),
            },
        };
        apply(&mut task, &input, by, true)?;
        self.validate(&task)?;
        task.next_run = task.compute_next(&Local);
        {
            let _guard = self.lock.lock();
            self.store.save_scheduled_task(&task)?;
        }
        self.changed(&task.id);
        Ok(task)
    }

    pub fn update(
        &self,
        id: &str,
        input: ScheduledTaskInput,
        by: &Editor,
    ) -> Result<ScheduledTask> {
        let now = self.now();
        let task = {
            let _guard = self.lock.lock();
            let old = self.get(id)?;
            let mut task = old.clone();
            apply(&mut task, &input, by, false)?;
            self.validate(&task)?;
            if task.schedule != old.schedule {
                // "Every N" counts from now; nothing before now is owed.
                task.anchor = now;
                task.last_slot = None;
            }
            if task.enabled && !old.enabled {
                // Runs while it was disabled are not owed either.
                task.last_slot = Some(now);
            }
            task.updated_at = now;
            task.next_run = task.compute_next(&Local);
            self.store.save_scheduled_task(&task)?;
            task
        };
        self.changed(id);
        Ok(task)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool, by: &Editor) -> Result<ScheduledTask> {
        self.update(
            id,
            ScheduledTaskInput {
                enabled: Some(enabled),
                ..Default::default()
            },
            by,
        )
    }

    pub fn delete(&self, id: &str) -> Result<ScheduledTask> {
        let task = {
            let _guard = self.lock.lock();
            let task = self.get(id)?;
            self.store.delete_scheduled_task(id)?;
            task
        };
        self.fresh.lock().remove(id);
        self.changed(id);
        Ok(task)
    }

    /// Run the task now, outside its schedule, which stays as it is. Like a
    /// scheduled run it is skipped while the previous run is still working,
    /// unless the task allows overlapping runs.
    pub async fn run_now(&self, id: &str) -> Result<ScheduledRun> {
        let task = self.get(id)?;
        Ok(self.start(&task, RunTrigger::Manual, None, None).await)
    }

    fn validate(&self, task: &ScheduledTask) -> Result<()> {
        if task.name.chars().count() > 200 {
            bail!("the name is too long: at most 200 characters");
        }
        let (provider, agent) = parse_agent(&task.agent)?;
        self.manager.provider(provider).with_context(|| {
            format!(
                "`{}` is not an agent Aura can start here; list_agents shows the ones it can",
                task.agent
            )
        })?;
        if provider == ProviderKind::Acp && agent.as_deref().unwrap_or("").is_empty() {
            bail!("name the ACP agent");
        }
        if !Path::new(&task.cwd).is_absolute() {
            bail!("`cwd` must be an absolute path, not `{}`", task.cwd);
        }
        if !Path::new(&task.cwd).is_dir() {
            bail!("`{}` is not a folder", task.cwd);
        }
        if self.manager.in_orchestrator_dirs(&task.cwd) {
            bail!(
                "`{}` is where Aura keeps the directories of orchestrators; sessions cannot work there",
                task.cwd
            );
        }
        if let Some(p) = &task.branch_prefix {
            if p.chars().any(char::is_whitespace) || p.starts_with('-') || p.contains("..") {
                bail!("`{p}` cannot start a git branch name");
            }
        }
        task.schedule.validate()
    }

    /// The app's `schedules.*` methods and an orchestrator's
    /// `orchestrator.schedules.*`. `Ok(None)`: not one of ours.
    pub async fn handle(&self, method: &str, p: Value) -> Result<Option<Value>> {
        let (by, op) = if let Some(op) = method.strip_prefix("orchestrator.schedules.") {
            let o = p
                .get("orchestrator")
                .and_then(Value::as_str)
                .context("`orchestrator` is required")?;
            (
                Editor::Orchestrator(Box::new(self.manager.orchestrator(o)?)),
                op,
            )
        } else if let Some(op) = method.strip_prefix("schedules.") {
            (Editor::User, op)
        } else {
            return Ok(None);
        };
        let id = || {
            p.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .context("`id` is required")
        };
        let input = || -> Result<ScheduledTaskInput> {
            let mut fields = p.clone();
            if let Some(m) = fields.as_object_mut() {
                for key in ["id", "orchestrator"] {
                    m.remove(key);
                }
            }
            serde_json::from_value(fields).context("read the task's fields")
        };
        Ok(Some(match op {
            "list" => json!(self.list()?),
            "get" => {
                let id = id()?;
                let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
                json!({ "task": self.get(&id)?, "runs": self.runs(&id, limit)? })
            }
            "runs" => {
                let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
                json!(self.runs(&id()?, limit.min(HISTORY_KEPT))?)
            }
            "create" => json!(self.create(input()?, &by)?),
            "update" => json!(self.update(&id()?, input()?, &by)?),
            "set_enabled" => {
                let enabled = p
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .context("`enabled` is required")?;
                json!(self.set_enabled(&id()?, enabled, &by)?)
            }
            "delete" => json!(self.delete(&id()?)?),
            "run" => json!(self.run_now(&id()?).await?),
            "preview" => {
                let schedule: Schedule = serde_json::from_value(
                    p.get("schedule")
                        .cloned()
                        .context("`schedule` is required")?,
                )?;
                let count = p.get("count").and_then(Value::as_u64).unwrap_or(5) as usize;
                json!(self.preview(&schedule, count)?)
            }
            _ => bail!("unknown method {method}"),
        }))
    }
}

/// Apply `input` to `task`. An orchestrator cannot choose permission or
/// sandbox modes: its tasks run with its own when they run its own agent,
/// and when it changes what a task does, the task's modes become those.
fn apply(
    task: &mut ScheduledTask,
    input: &ScheduledTaskInput,
    by: &Editor,
    creating: bool,
) -> Result<()> {
    let text = |v: &Option<String>| v.as_ref().map(|s| s.trim().to_string());
    let optional = |v: &Option<String>, field: &mut Option<String>| {
        if let Some(s) = text(v) {
            *field = (!s.is_empty()).then_some(s);
        }
    };
    let required = |v: &Option<String>, what: &str, field: &mut String| -> Result<()> {
        if let Some(s) = text(v) {
            if s.is_empty() {
                bail!("`{what}` cannot be empty");
            }
            *field = s;
        }
        Ok(())
    };
    let before = task.clone();
    required(&input.name, "name", &mut task.name)?;
    if let Some(p) = &input.prompt {
        if p.trim().is_empty() {
            bail!("`prompt` cannot be empty");
        }
        task.prompt = p.clone();
    }
    required(&input.agent, "agent", &mut task.agent)?;
    if let Some(cwd) = text(&input.cwd) {
        task.cwd = expand_home(&cwd);
    }
    optional(&input.model, &mut task.model);
    optional(&input.effort, &mut task.effort);
    optional(&input.branch_prefix, &mut task.branch_prefix);
    optional(&input.group, &mut task.group);
    if let Some(v) = input.worktree {
        task.worktree = v;
    }
    if let Some(v) = input.enabled {
        task.enabled = v;
    }
    if let Some(s) = &input.schedule {
        task.schedule = s.clone();
    }
    if let Some(m) = input.missed {
        task.missed = m;
    }
    if let Some(v) = input.allow_overlap {
        task.allow_overlap = v;
    }
    match by {
        Editor::User => {
            optional(&input.permission_mode, &mut task.permission_mode);
            optional(&input.sandbox_mode, &mut task.sandbox_mode);
        }
        Editor::Orchestrator(o) => {
            if input.permission_mode.is_some() || input.sandbox_mode.is_some() {
                bail!("permission and sandbox modes of scheduled tasks are the user's to choose, in Aura");
            }
            let what_it_does = |t: &ScheduledTask| {
                (
                    t.prompt.clone(),
                    t.agent.clone(),
                    t.cwd.clone(),
                    t.model.clone(),
                    t.effort.clone(),
                    t.worktree,
                    t.branch_prefix.clone(),
                )
            };
            if creating || what_it_does(task) != what_it_does(&before) {
                let (provider, agent) = parse_agent(&task.agent)?;
                let same = provider == o.provider && agent == o.agent;
                task.permission_mode = o.permission_mode.clone().filter(|_| same);
                task.sandbox_mode = o.sandbox_mode.clone().filter(|_| same);
            }
        }
    }
    Ok(())
}

fn expand_home(dir: &str) -> String {
    match dir
        .strip_prefix("~/")
        .or(if dir == "~" { Some("") } else { None })
    {
        Some(rest) => std::env::var_os("HOME")
            .map(|h| Path::new(&h).join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.to_string()),
        None => dir.to_string(),
    }
}

/// The start of a run's branch name.
pub fn branch_prefix(task: &ScheduledTask) -> String {
    task.branch_prefix
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| {
            let slug = crate::specialists::slug(&task.name);
            format!("scheduled/{}", if slug.is_empty() { "task" } else { &slug })
        })
}

fn runs_phrase(n: u64) -> String {
    match n {
        0 | 1 => "A run".into(),
        n if n >= 100_000 => "More than 100000 runs".into(),
        n => format!("{n} runs"),
    }
}
