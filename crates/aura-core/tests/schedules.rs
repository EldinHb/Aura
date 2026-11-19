//! The scheduler with a fake agent and a clock the tests move.

use aura_core::*;
use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast;

/// Prompts the fake agent got, by session.
type Prompts = Arc<Mutex<Vec<(String, String)>>>;

struct Agent {
    sink: EventSink,
    session: String,
    prompts: Prompts,
}

#[async_trait::async_trait]
impl Driver for Agent {
    async fn send(&self, input: Input) -> anyhow::Result<()> {
        self.prompts
            .lock()
            .push((self.session.clone(), input.text.clone()));
        let turn = Turn {
            id: new_id(),
            session_id: self.session.clone(),
            status: TurnStatus::Running,
            started_at: now(),
            ended_at: None,
            usage: None,
            error: None,
        };
        let _ = self.sink.send(Event::TurnStarted {
            session_id: self.session.clone(),
            turn: turn.clone(),
        });
        // A prompt with "quick" finishes at once; others keep working.
        if input.text.contains("quick") {
            let _ = self.sink.send(Event::TurnCompleted {
                session_id: self.session.clone(),
                turn: Turn {
                    status: TurnStatus::Completed,
                    ended_at: Some(now()),
                    ..turn
                },
            });
        }
        Ok(())
    }
    async fn interrupt(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn respond_approval(&self, _: &str, _: ApprovalDecision) -> anyhow::Result<()> {
        Ok(())
    }
    async fn respond_input(&self, _: UserInputResponse) -> anyhow::Result<()> {
        Ok(())
    }
    async fn set(&self, _: Setting) -> anyhow::Result<()> {
        Ok(())
    }
    async fn stop(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

struct Fake {
    prompts: Prompts,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Claude
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Claude,
            display_name: "Fake".into(),
            available: true,
            version: None,
            binary: None,
            capabilities: CapabilitySet {
                structured: true,
                ..Default::default()
            },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(
        &self,
        session: &Session,
        _fork: bool,
        sink: EventSink,
    ) -> anyhow::Result<Box<dyn Driver>> {
        Ok(Box::new(Agent {
            sink,
            session: session.id.clone(),
            prompts: self.prompts.clone(),
        }))
    }
    fn terminal_command(&self, _: &Session) -> Vec<String> {
        vec![]
    }
}

/// Worktrees in a folder of the test's, without git.
struct Trees(std::path::PathBuf);

impl WorktreeBackend for Trees {
    fn create(&self, cwd: &str, opts: &WorktreeOpts) -> anyhow::Result<WorktreeInfo> {
        let path = self.0.join(opts.branch.replace('/', "-"));
        std::fs::create_dir_all(&path)?;
        Ok(WorktreeInfo {
            repo_root: cwd.into(),
            path: path.to_string_lossy().into_owned(),
            branch: opts.branch.clone(),
        })
    }
    fn remove(&self, _: &WorktreeInfo) -> anyhow::Result<()> {
        Ok(())
    }
}

struct World {
    m: Manager,
    store: Arc<MemoryStore>,
    svc: Arc<ScheduleService>,
    clock: Arc<Mutex<DateTime<Utc>>>,
    prompts: Prompts,
    events: broadcast::Receiver<Value>,
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        Self::on(Arc::new(MemoryStore::default()))
    }

    /// A daemon on `store`, as after a restart.
    fn on(store: Arc<MemoryStore>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let prompts: Prompts = Default::default();
        let m = Manager::new(
            store.clone(),
            vec![Arc::new(Fake {
                prompts: prompts.clone(),
            })],
            Some(Arc::new(Trees(dir.path().join("trees")))),
        );
        m.restore().unwrap();
        let clock = Arc::new(Mutex::new(
            "2026-11-18T08:00:30Z".parse::<DateTime<Utc>>().unwrap(),
        ));
        let (tx, events) = broadcast::channel(64);
        let c = clock.clone();
        let svc =
            ScheduleService::with_clock(m.clone(), store.clone(), tx, Arc::new(move || *c.lock()));
        Self {
            m,
            store,
            svc,
            clock,
            prompts,
            events,
            dir,
        }
    }

    fn cwd(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }

    fn now(&self) -> DateTime<Utc> {
        *self.clock.lock()
    }

    fn advance(&self, d: Duration) {
        *self.clock.lock() += d;
    }

    /// Move the clock to the task's next run.
    fn to_next_run(&self, id: &str) {
        let next = self.svc.get(id).unwrap().next_run.unwrap();
        *self.clock.lock() = next;
    }

    fn input(&self, prompt: &str, schedule: Schedule) -> ScheduledTaskInput {
        ScheduledTaskInput {
            name: Some("Nightly check".into()),
            prompt: Some(prompt.into()),
            agent: Some("claude".into()),
            cwd: Some(self.cwd()),
            schedule: Some(schedule),
            ..Default::default()
        }
    }

    fn task(&self, prompt: &str, schedule: Schedule) -> ScheduledTask {
        self.svc
            .create(self.input(prompt, schedule), &Editor::User)
            .unwrap()
    }

    fn changes(&mut self) -> Vec<Value> {
        let mut out = vec![];
        while let Ok(v) = self.events.try_recv() {
            out.push(v);
        }
        out
    }
}

fn every_hour() -> Schedule {
    Schedule::Hours { every: 1 }
}

async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

#[tokio::test]
async fn a_task_starts_a_normal_session_with_its_prompt_when_its_time_comes() {
    let mut w = World::new();
    let t = w
        .svc
        .create(
            ScheduledTaskInput {
                model: Some("opus".into()),
                effort: Some("high".into()),
                group: Some("Chores".into()),
                permission_mode: Some("acceptEdits".into()),
                ..w.input("quick: check the build", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    // The hour counts from the minute it was set.
    assert_eq!(
        t.next_run.unwrap(),
        "2026-11-18T09:00:00Z".parse::<DateTime<Utc>>().unwrap()
    );
    assert_eq!(
        w.changes(),
        [json!({ "method": "schedules.changed", "params": { "id": t.id } })]
    );

    // Not yet.
    w.advance(Duration::minutes(30));
    assert!(w.svc.tick().await.unwrap().is_empty());

    w.to_next_run(&t.id);
    let runs = w.svc.tick().await.unwrap();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run.result, RunResult::Started);
    assert_eq!(run.trigger, RunTrigger::Schedule);
    assert_eq!(run.slot, t.next_run);
    let s = w.m.get_session(run.session_id.as_deref().unwrap()).unwrap();
    assert!(s.title.starts_with("Nightly check · "), "{}", s.title);
    assert_eq!(run.session_title.as_deref(), Some(s.title.as_str()));
    assert_eq!(s.cwd, w.cwd());
    assert_eq!(s.group.as_deref(), Some("Chores"));
    assert_eq!(s.model.as_deref(), Some("opus"));
    assert_eq!(s.effort.as_deref(), Some("high"));
    assert_eq!(s.permission_mode.as_deref(), Some("acceptEdits"));
    assert!(
        !s.orchestrator && s.orchestrator_id.is_none(),
        "a normal session"
    );
    assert_eq!(s.scheduled_task_id.as_deref(), Some(t.id.as_str()));
    assert_eq!(s.scheduled_task_name.as_deref(), Some("Nightly check"));
    assert_eq!(
        w.prompts.lock().clone(),
        [(s.id.clone(), "quick: check the build".to_string())]
    );

    let t = w.svc.get(&t.id).unwrap();
    assert_eq!(t.last_run.as_ref(), Some(run));
    assert_eq!(
        t.next_run.unwrap(),
        "2026-11-18T10:00:00Z".parse::<DateTime<Utc>>().unwrap()
    );
    assert_eq!(w.svc.runs(&t.id, 10).unwrap(), std::slice::from_ref(run));
    assert!(!w.changes().is_empty(), "the run is announced");
    // Nothing more is due at the same moment.
    assert!(w.svc.tick().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_run_is_skipped_while_the_previous_one_still_works_unless_overlap_is_allowed() {
    let w = World::new();
    let t = w.task("a long job", Schedule::Minutes { every: 10 });
    w.to_next_run(&t.id);
    let first = w.svc.tick().await.unwrap().remove(0);
    assert_eq!(first.result, RunResult::Started);
    settle().await;
    let busy = first.session_id.clone().unwrap();
    assert_eq!(
        w.m.get_session(&busy).unwrap().status,
        SessionStatus::Running
    );

    w.to_next_run(&t.id);
    let second = w.svc.tick().await.unwrap().remove(0);
    assert_eq!(second.result, RunResult::Skipped);
    assert!(
        second.message.as_deref().unwrap().contains("still working"),
        "{second:?}"
    );
    assert_eq!(
        second.session_id.as_deref(),
        Some(busy.as_str()),
        "links the busy one"
    );
    assert_eq!(w.m.list_sessions().len(), 1);
    // Run now holds to the same rule.
    let manual = w.svc.run_now(&t.id).await.unwrap();
    assert_eq!(manual.result, RunResult::Skipped);
    assert_eq!(manual.trigger, RunTrigger::Manual);

    w.svc
        .update(
            &t.id,
            ScheduledTaskInput {
                allow_overlap: Some(true),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    w.to_next_run(&t.id);
    let third = w.svc.tick().await.unwrap().remove(0);
    assert_eq!(third.result, RunResult::Started);
    assert_ne!(third.session_id.as_deref(), Some(busy.as_str()));
    assert_eq!(w.m.list_sessions().len(), 2);
    let results: Vec<RunResult> = w
        .svc
        .runs(&t.id, 10)
        .unwrap()
        .iter()
        .map(|r| r.result)
        .collect();
    assert_eq!(
        results,
        [
            RunResult::Started,
            RunResult::Skipped,
            RunResult::Skipped,
            RunResult::Started
        ]
    );
}

#[tokio::test]
async fn a_finished_previous_run_does_not_hold_up_the_next() {
    let w = World::new();
    let t = w.task("quick look", Schedule::Minutes { every: 5 });
    w.to_next_run(&t.id);
    let first = w.svc.tick().await.unwrap().remove(0);
    settle().await;
    assert_eq!(
        w.m.get_session(first.session_id.as_deref().unwrap())
            .unwrap()
            .status,
        SessionStatus::Idle
    );
    w.to_next_run(&t.id);
    assert_eq!(
        w.svc.tick().await.unwrap().remove(0).result,
        RunResult::Started
    );
    // A deleted session does not hold it up either.
    let ids: Vec<String> = w.m.list_sessions().into_iter().map(|s| s.id).collect();
    for id in ids {
        w.m.delete(&id, false).await.unwrap();
    }
    assert_eq!(
        w.svc.run_now(&t.id).await.unwrap().result,
        RunResult::Started
    );
}

#[tokio::test]
async fn runs_missed_while_aura_was_down_run_once_without_piling_up() {
    let store = Arc::new(MemoryStore::default());
    // The first daemon's folder stays; the daemon itself is gone.
    let before = World::on(store.clone());
    let t = before.task("quick: summarise", every_hour());
    let (id, started) = (t.id.clone(), before.now());
    before.svc.shutdown();
    // Aura comes back five and a half hours later.
    let w = World::on(store);
    *w.clock.lock() = started + Duration::minutes(5 * 60 + 30);
    let t = w.svc.get(&id).unwrap();
    assert!(t.next_run.unwrap() < w.now(), "kept across the restart");
    let runs = w.svc.tick().await.unwrap();
    assert_eq!(runs.len(), 1, "once, not five times");
    let run = &runs[0];
    assert_eq!(run.result, RunResult::Started);
    assert_eq!(run.trigger, RunTrigger::CatchUp);
    assert_eq!(
        run.slot.unwrap(),
        "2026-11-18T13:00:00Z".parse::<DateTime<Utc>>().unwrap(),
        "for the latest time that came due"
    );
    assert!(
        run.message
            .as_deref()
            .unwrap()
            .starts_with("5 runs went by"),
        "{run:?}"
    );
    assert_eq!(w.prompts.lock().len(), 1);
    assert_eq!(
        w.svc.get(&id).unwrap().next_run.unwrap(),
        "2026-11-18T14:00:00Z".parse::<DateTime<Utc>>().unwrap()
    );
    assert!(w.svc.tick().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_task_set_to_skip_missed_runs_records_the_skip_and_waits_for_its_next_time() {
    let w = World::new();
    let t = w
        .svc
        .create(
            ScheduledTaskInput {
                missed: Some(MissedRuns::Skip),
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    // The computer slept from before 09:00 to 11:20.
    w.advance(Duration::minutes(200));
    let run = w.svc.tick().await.unwrap().remove(0);
    assert_eq!(run.result, RunResult::Skipped);
    assert_eq!(run.trigger, RunTrigger::CatchUp);
    assert!(
        run.message
            .as_deref()
            .unwrap()
            .starts_with("3 runs went by"),
        "{run:?}"
    );
    assert!(w.m.list_sessions().is_empty());
    assert_eq!(
        w.svc.get(&t.id).unwrap().next_run.unwrap(),
        "2026-11-18T12:00:00Z".parse::<DateTime<Utc>>().unwrap()
    );
    // On time again: it runs.
    w.to_next_run(&t.id);
    assert_eq!(
        w.svc.tick().await.unwrap().remove(0).result,
        RunResult::Started
    );
}

#[tokio::test]
async fn a_disabled_task_does_not_run_and_owes_nothing_when_enabled_again() {
    let w = World::new();
    let t = w.task("quick", every_hour());
    let off = w.svc.set_enabled(&t.id, false, &Editor::User).unwrap();
    assert_eq!(off.next_run, None);
    w.advance(Duration::hours(5));
    assert!(w.svc.tick().await.unwrap().is_empty());
    let on = w.svc.set_enabled(&t.id, true, &Editor::User).unwrap();
    assert!(on.next_run.unwrap() > w.now());
    assert!(
        w.svc.tick().await.unwrap().is_empty(),
        "no catch-up for the time it was off"
    );
    // Run now works on a disabled task too.
    w.svc.set_enabled(&t.id, false, &Editor::User).unwrap();
    assert_eq!(
        w.svc.run_now(&t.id).await.unwrap().result,
        RunResult::Started
    );
}

#[tokio::test]
async fn run_now_leaves_the_schedule_alone_and_a_failed_start_is_recorded() {
    let w = World::new();
    let t = w.task(
        "quick",
        Schedule::Days {
            every: 1,
            at: "23:00".parse().unwrap(),
        },
    );
    let run = w.svc.run_now(&t.id).await.unwrap();
    assert_eq!(run.result, RunResult::Started);
    assert_eq!(run.trigger, RunTrigger::Manual);
    assert_eq!(run.slot, None);
    assert_eq!(w.svc.get(&t.id).unwrap().next_run, t.next_run);

    // The folder went away: the run fails, with the reason.
    let gone = w.dir.path().join("gone");
    std::fs::create_dir(&gone).unwrap();
    let t2 = w
        .svc
        .create(
            ScheduledTaskInput {
                cwd: Some(gone.to_string_lossy().into_owned()),
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    std::fs::remove_dir(&gone).unwrap();
    let failed = w.svc.run_now(&t2.id).await.unwrap();
    assert_eq!(failed.result, RunResult::Failed);
    assert!(
        failed
            .message
            .as_deref()
            .unwrap()
            .contains("does not exist"),
        "{failed:?}"
    );
    assert_eq!(failed.session_id, None);
    assert_eq!(w.svc.get(&t2.id).unwrap().last_run, Some(failed));
}

#[tokio::test]
async fn each_run_can_work_in_a_worktree_of_its_own() {
    let w = World::new();
    let t = w
        .svc
        .create(
            ScheduledTaskInput {
                worktree: Some(true),
                allow_overlap: Some(true),
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    let a = w.svc.run_now(&t.id).await.unwrap();
    w.advance(Duration::seconds(1));
    let b = w.svc.run_now(&t.id).await.unwrap();
    let branch = |r: &ScheduledRun| {
        w.m.get_session(r.session_id.as_deref().unwrap())
            .unwrap()
            .worktree
            .unwrap()
            .branch
    };
    assert!(
        branch(&a).starts_with("scheduled/nightly-check-"),
        "{}",
        branch(&a)
    );
    assert_ne!(branch(&a), branch(&b));
    w.svc
        .update(
            &t.id,
            ScheduledTaskInput {
                branch_prefix: Some("chore/nightly".into()),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    w.advance(Duration::seconds(1));
    let c = w.svc.run_now(&t.id).await.unwrap();
    assert!(branch(&c).starts_with("chore/nightly-"), "{}", branch(&c));
}

#[tokio::test]
async fn tasks_that_cannot_run_are_refused() {
    let w = World::new();
    let ok = || w.input("p", every_hour());
    let refused = |input: ScheduledTaskInput, why: &str| {
        let e = w.svc.create(input, &Editor::User).unwrap_err().to_string();
        assert!(e.contains(why), "{e} does not say {why}");
    };
    refused(
        ScheduledTaskInput {
            name: Some(" ".into()),
            ..ok()
        },
        "`name` is required",
    );
    refused(
        ScheduledTaskInput {
            prompt: None,
            ..ok()
        },
        "`prompt` is required",
    );
    refused(
        ScheduledTaskInput {
            agent: Some("codex".into()),
            ..ok()
        },
        "not an agent Aura can start here",
    );
    refused(
        ScheduledTaskInput {
            agent: Some("terminal".into()),
            ..ok()
        },
        "not terminals",
    );
    refused(
        ScheduledTaskInput {
            cwd: Some("relative/dir".into()),
            ..ok()
        },
        "absolute path",
    );
    refused(
        ScheduledTaskInput {
            cwd: Some("/no/such/folder".into()),
            ..ok()
        },
        "is not a folder",
    );
    refused(
        ScheduledTaskInput {
            schedule: Some(Schedule::Minutes { every: 0 }),
            ..ok()
        },
        "out of range",
    );
    refused(
        ScheduledTaskInput {
            branch_prefix: Some("has space".into()),
            ..ok()
        },
        "git branch",
    );
    assert!(w.svc.list().unwrap().is_empty());
    // A change that cannot run leaves the task as it was.
    let t = w.task("p", every_hour());
    assert!(w
        .svc
        .update(
            &t.id,
            ScheduledTaskInput {
                prompt: Some("".into()),
                ..Default::default()
            },
            &Editor::User
        )
        .is_err());
    assert_eq!(w.svc.get(&t.id).unwrap(), t);
}

#[tokio::test]
async fn changing_the_schedule_starts_counting_again_and_other_changes_keep_the_next_run() {
    let w = World::new();
    let t = w.task("p", every_hour());
    w.advance(Duration::minutes(20));
    let renamed = w
        .svc
        .update(
            &t.id,
            ScheduledTaskInput {
                name: Some("Renamed".into()),
                model: Some("".into()),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    assert_eq!(renamed.next_run, t.next_run);
    assert_eq!(renamed.name, "Renamed");
    let resched = w
        .svc
        .update(
            &t.id,
            ScheduledTaskInput {
                schedule: Some(Schedule::Minutes { every: 15 }),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    assert_eq!(
        resched.next_run.unwrap(),
        w.now().with_second0() + Duration::minutes(15)
    );
    // Deleting takes the history with it.
    w.svc.run_now(&t.id).await.unwrap();
    w.svc.delete(&t.id).unwrap();
    assert!(w.svc.get(&t.id).is_err());
    assert!(w.store.scheduled_runs(&t.id, 10).unwrap().is_empty());
}

trait Second0 {
    fn with_second0(self) -> Self;
}
impl Second0 for DateTime<Utc> {
    fn with_second0(self) -> Self {
        DateTime::from_timestamp(self.timestamp() / 60 * 60, 0).unwrap()
    }
}

/// An orchestrator session in the store, restored so no agent runs.
fn orchestrator(w: &World, permission: Option<&str>) -> Session {
    let mut s = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: w.cwd(),
        title: Some("Lead".into()),
        orchestrator: true,
        permission_mode: permission.map(str::to_string),
        ..Default::default()
    });
    s.status = SessionStatus::Idle;
    w.store.upsert_session(&s).unwrap();
    w.m.restore().unwrap();
    w.m.get_session(&s.id).unwrap()
}

#[tokio::test]
async fn the_apps_methods_and_an_orchestrators_tools_share_one_path() {
    let mut w = World::new();
    let lead = orchestrator(&w, Some("acceptEdits"));
    let o = json!(lead.id);
    let schedule = json!({ "unit": "days", "every": 1, "at": "09:00" });
    let created: ScheduledTask = serde_json::from_value(
        w.svc
            .handle(
                "orchestrator.schedules.create",
                json!({ "orchestrator": o, "name": "Triage", "prompt": "quick triage", "agent": "claude", "cwd": w.cwd(), "schedule": schedule }),
            )
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        created.created_by,
        Some(ScheduleSource {
            orchestrator: lead.id.clone(),
            orchestrator_title: "Lead".into()
        })
    );
    assert_eq!(
        created.permission_mode.as_deref(),
        Some("acceptEdits"),
        "its own mode, as its workers get"
    );
    // The app sees it, and the change was announced.
    let listed = w
        .svc
        .handle("schedules.list", json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(listed[0]["id"], json!(created.id));
    assert!(!w.changes().is_empty());

    // Permission modes are the user's to choose.
    let e = w
        .svc
        .handle(
            "orchestrator.schedules.update",
            json!({ "orchestrator": o, "id": created.id, "permission_mode": "bypassPermissions" }),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("the user's to choose"), "{e}");
    w.svc
        .handle(
            "schedules.update",
            json!({ "id": created.id, "permission_mode": "bypassPermissions" }),
        )
        .await
        .unwrap();
    // Turning it off and on keeps the user's choice; changing what it does does not.
    let off = w
        .svc
        .handle(
            "orchestrator.schedules.set_enabled",
            json!({ "orchestrator": o, "id": created.id, "enabled": false }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(off["enabled"], json!(false));
    assert_eq!(off["permission_mode"], json!("bypassPermissions"));
    let changed = w
        .svc
        .handle(
            "orchestrator.schedules.update",
            json!({ "orchestrator": o, "id": created.id, "prompt": "quick: something else" }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(changed["permission_mode"], json!("acceptEdits"));

    let run = w
        .svc
        .handle(
            "orchestrator.schedules.run",
            json!({ "orchestrator": o, "id": created.id }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run["result"], json!("started"));
    let runs = w
        .svc
        .handle(
            "orchestrator.schedules.runs",
            json!({ "orchestrator": o, "id": created.id }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runs.as_array().unwrap().len(), 1);
    let got = w
        .svc
        .handle("schedules.get", json!({ "id": created.id }))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got["runs"][0]["id"], run["id"]);
    let preview = w
        .svc
        .handle(
            "schedules.preview",
            json!({ "schedule": schedule, "count": 3 }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(preview.as_array().unwrap().len(), 3);

    // Only an orchestrator has these tools.
    let plain = Session::new(&CreateSessionOpts {
        provider: ProviderKind::Claude,
        cwd: w.cwd(),
        ..Default::default()
    });
    w.store.upsert_session(&plain).unwrap();
    w.m.restore().unwrap();
    let e = w
        .svc
        .handle(
            "orchestrator.schedules.list",
            json!({ "orchestrator": plain.id }),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("not an orchestrator"), "{e}");

    w.svc
        .handle(
            "orchestrator.schedules.delete",
            json!({ "orchestrator": o, "id": created.id }),
        )
        .await
        .unwrap();
    assert!(w.svc.list().unwrap().is_empty());
    assert_eq!(w.svc.handle("reviews.list", json!({})).await.unwrap(), None);
}

#[tokio::test]
async fn the_daemons_loop_fires_on_its_own() {
    let store = Arc::new(MemoryStore::default());
    let dir = tempfile::tempdir().unwrap();
    let prompts: Prompts = Default::default();
    let m = Manager::new(
        store.clone(),
        vec![Arc::new(Fake {
            prompts: prompts.clone(),
        })],
        None,
    );
    let (tx, _rx) = broadcast::channel(16);
    let svc = ScheduleService::new(m.clone(), store.clone(), tx);
    let mut t = svc
        .create(
            ScheduledTaskInput {
                name: Some("t".into()),
                prompt: Some("quick".into()),
                agent: Some("claude".into()),
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                schedule: Some(every_hour()),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    // Set an hour and a minute ago: its first run came due a minute ago.
    t.anchor = Utc::now() - Duration::minutes(61);
    store.save_scheduled_task(&t).unwrap();
    svc.launch();
    for _ in 0..200 {
        if !prompts.lock().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    svc.shutdown();
    assert!(!prompts.lock().is_empty(), "the loop never fired");
}

#[tokio::test]
async fn a_task_runs_as_an_orchestrator_or_a_feature_owner_like_one_started_by_hand() {
    let w = World::new();
    w.m.enable_orchestrator_dirs(w.dir.path().join("orchestrators"));
    // A session needs a folder; an orchestrator does not, but then no worktree.
    let e = w
        .svc
        .create(
            ScheduledTaskInput {
                cwd: None,
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap_err();
    assert!(e.to_string().contains("`cwd` is required"), "{e}");
    let e = w
        .svc
        .create(
            ScheduledTaskInput {
                cwd: None,
                run_as: Some(RunAs::Orchestrator),
                worktree: Some(true),
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap_err();
    assert!(e.to_string().contains("cannot have a worktree"), "{e}");

    let lead = w
        .svc
        .create(
            ScheduledTaskInput {
                cwd: None,
                run_as: Some(RunAs::Orchestrator),
                // Only a feature owner keeps these.
                feature_goal: Some("ignored".into()),
                ..w.input("quick: plan the week", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    assert_eq!(lead.run_as, RunAs::Orchestrator);
    assert_eq!(
        (lead.cwd.as_str(), lead.feature_goal.as_deref()),
        ("", None)
    );
    let run = w.svc.run_now(&lead.id).await.unwrap();
    assert_eq!(run.result, RunResult::Started, "{run:?}");
    let o = w.m.get_session(run.session_id.as_deref().unwrap()).unwrap();
    assert!(o.orchestrator && !o.feature_owner && o.folderless);
    assert!(
        o.cwd
            .starts_with(&*w.dir.path().join("orchestrators").to_string_lossy()),
        "its own directory, as by hand: {}",
        o.cwd
    );
    assert_eq!(o.scheduled_task_id.as_deref(), Some(lead.id.as_str()));
    settle().await;

    // Its workers are its own, as usual.
    let worker =
        w.m.start_worker(
            &o.id,
            WorkerSpec {
                agent: "claude".into(),
                prompt: "a long job".into(),
                cwd: Some(w.cwd()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(worker.orchestrator_id.as_deref(), Some(o.id.as_str()));
    assert_eq!(
        worker.scheduled_task_id, None,
        "started by the orchestrator, not the task"
    );
    settle().await;
    assert_eq!(w.m.get_session(&o.id).unwrap().status, SessionStatus::Idle);
    assert_eq!(
        w.m.get_session(&worker.id).unwrap().status,
        SessionStatus::Running
    );
    // The orchestrator is idle, but its run goes on while a worker works.
    w.to_next_run(&lead.id);
    let next = w.svc.tick().await.unwrap().remove(0);
    assert_eq!(next.result, RunResult::Skipped, "{next:?}");
    assert_eq!(next.session_id.as_deref(), Some(o.id.as_str()));
    // Once the worker is gone, the next run starts.
    w.m.delete(&worker.id, false).await.unwrap();
    assert_eq!(
        w.svc.run_now(&lead.id).await.unwrap().result,
        RunResult::Started
    );

    let autonomy = Autonomy {
        level: AutonomyLevel::Checkpoints,
        checkpoints: vec![Checkpoint::BeforeDelivery],
    };
    let owner = w
        .svc
        .create(
            ScheduledTaskInput {
                run_as: Some(RunAs::FeatureOwner),
                feature_goal: Some("A weekly changelog for the users".into()),
                autonomy: Some(Some(autonomy.clone())),
                ..w.input("quick: write this week's changelog", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    assert_eq!(owner.cwd, w.cwd(), "a feature owner may keep a folder");
    let run = w.svc.run_now(&owner.id).await.unwrap();
    let f = w.m.get_session(run.session_id.as_deref().unwrap()).unwrap();
    assert!(f.orchestrator && f.feature_owner && !f.folderless);
    assert_eq!(f.cwd, w.cwd());
    let feature = w.m.feature(&f.id).unwrap();
    assert_eq!(feature.goal, "A weekly changelog for the users");
    assert_eq!(feature.autonomy, Some(autonomy));
    assert!(w
        .prompts
        .lock()
        .iter()
        .any(|(id, p)| *id == f.id && p == "quick: write this week's changelog"));

    // Back to a session: the feature fields go, and a folder is needed again.
    let e = w
        .svc
        .update(
            &lead.id,
            ScheduledTaskInput {
                run_as: Some(RunAs::Session),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap_err();
    assert!(e.to_string().contains("`cwd` is required"), "{e}");
    let plain = w
        .svc
        .update(
            &owner.id,
            ScheduledTaskInput {
                run_as: Some(RunAs::Session),
                ..Default::default()
            },
            &Editor::User,
        )
        .unwrap();
    assert_eq!((plain.feature_goal, plain.autonomy), (None, None));
    // Null clears a feature owner's own autonomy; missing keeps it.
    let t: ScheduledTaskInput = serde_json::from_value(json!({ "autonomy": null })).unwrap();
    assert_eq!(t.autonomy, Some(None));
    let t: ScheduledTaskInput = serde_json::from_value(json!({})).unwrap();
    assert_eq!(t.autonomy, None);
}

#[tokio::test]
async fn an_orchestrator_schedules_only_what_it_could_start_itself() {
    let w = World::new();
    let lead = orchestrator(&w, None);
    let o = json!(lead.id);
    let schedule = json!({ "unit": "hours", "every": 1 });
    for (extra, want) in [
        (
            json!({ "run_as": "orchestrator" }),
            "only the user can schedule an orchestrator or a feature owner",
        ),
        (
            json!({ "run_as": "feature_owner", "feature_goal": "x" }),
            "only the user can schedule an orchestrator or a feature owner",
        ),
        (
            json!({ "feature_goal": "x" }),
            "`feature_goal` and `autonomy` are for a feature owner",
        ),
        (
            json!({ "autonomy": null }),
            "`feature_goal` and `autonomy` are for a feature owner",
        ),
    ] {
        let mut p = json!({ "orchestrator": o, "name": "T", "prompt": "quick", "agent": "claude", "cwd": w.cwd(), "schedule": schedule });
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let e = w
            .svc
            .handle("orchestrator.schedules.create", p)
            .await
            .unwrap_err();
        assert!(e.to_string().contains(want), "{e}");
    }
    assert!(w.svc.list().unwrap().is_empty());
    // A session it may schedule, saying so or not.
    let ok = w
        .svc
        .handle(
            "orchestrator.schedules.create",
            json!({ "orchestrator": o, "name": "T", "prompt": "quick", "agent": "claude", "cwd": w.cwd(), "schedule": schedule, "run_as": "session" }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ok["run_as"], json!("session"));
    // It cannot turn one into an orchestrator either.
    let e = w
        .svc
        .handle(
            "orchestrator.schedules.update",
            json!({ "orchestrator": o, "id": ok["id"], "run_as": "orchestrator", "cwd": "" }),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("only the user can schedule"), "{e}");

    // The user's orchestrator task: it may manage it, not change what it does.
    let users = w
        .svc
        .create(
            ScheduledTaskInput {
                run_as: Some(RunAs::FeatureOwner),
                feature_goal: Some("goal".into()),
                ..w.input("quick", every_hour())
            },
            &Editor::User,
        )
        .unwrap();
    for change in [
        json!({ "prompt": "something else" }),
        json!({ "agent": "claude", "model": "opus" }),
        json!({ "run_as": "session" }),
        json!({ "feature_goal": "another goal" }),
    ] {
        let mut p = json!({ "orchestrator": o, "id": users.id });
        p.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let e = w
            .svc
            .handle("orchestrator.schedules.update", p)
            .await
            .unwrap_err();
        assert!(
            e.to_string().contains("not change what it does")
                || e.to_string().contains("only the user"),
            "{change}: {e}"
        );
    }
    let renamed = w
        .svc
        .handle(
            "orchestrator.schedules.update",
            json!({ "orchestrator": o, "id": users.id, "name": "Renamed", "schedule": { "unit": "hours", "every": 2 } }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed["name"], json!("Renamed"));
    assert_eq!(renamed["run_as"], json!("feature_owner"));
    assert_eq!(renamed["feature_goal"], json!("goal"));
}
