//! Agent processes that are no longer needed are stopped, the way
//! [`Manager::stop`] does: the session and its history stay, and the next
//! message resumes it.
//!
//! - A run of a scheduled task is done once it and every worker under it are
//!   quiet: no turn, nothing waiting on the user, no message from Aura on its
//!   way. Its agents are stopped [`FINISHED_RUN_GRACE`] after the last of them
//!   went quiet. Without this every run kept a live agent process, so a task
//!   added one process (pipes and memory) per run for as long as aurad ran.
//! - Any other session whose agents have all been quiet for the idle timeout
//!   (the [`IDLE_STOP_KEY`] setting, in hours; 0 never) is stopped the same way.
//!
//! What waits on the user is never stopped, and an orchestrator is never
//! stopped while a worker under it works, since the worker's report wakes it.

use super::*;
use chrono::{DateTime, Duration, Utc};

/// How long a finished scheduled run keeps its agents, so a worker report or
/// a reply of the user right after the run ends does not restart them.
pub const FINISHED_RUN_GRACE: Duration = Duration::seconds(60);
/// Setting: hours after which the agents of any quiet session are stopped; 0 never.
pub const IDLE_STOP_KEY: &str = "agents.idle_stop_hours";
/// [`IDLE_STOP_KEY`] when it is not set.
pub const IDLE_STOP_DEFAULT_HOURS: u32 = 6;
/// How long a message may take to start the agent's turn before the session
/// counts as quiet anyway.
const AWAITING_TURN_LIMIT: std::time::Duration = std::time::Duration::from_secs(600);
/// How often the daemon looks.
pub const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

impl Manager {
    /// Hours after which the agents of a quiet session are stopped; 0 never.
    pub fn idle_stop_hours(&self) -> u32 {
        match self.inner.store.get_setting(IDLE_STOP_KEY) {
            Ok(Some(v)) => v.trim().parse().unwrap_or(IDLE_STOP_DEFAULT_HOURS),
            _ => IDLE_STOP_DEFAULT_HOURS,
        }
    }

    /// Look at once, then every [`SWEEP_EVERY`], for agents to stop, until
    /// the daemon stops. Restored sessions start no agent, so after a restart
    /// the finished runs of before hold no process; the first look catches
    /// any agent started meanwhile.
    pub fn launch_idle_sweep(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if me.is_shutting_down() {
                    break;
                }
                let stopped = me.stop_idle_agents(Utc::now()).await;
                if !stopped.is_empty() {
                    tracing::info!("stopped {} idle agent process(es)", stopped.len());
                }
                tokio::time::sleep(SWEEP_EVERY).await;
            }
        });
    }

    /// Stop the agents no longer needed at `now` (see the module); returns
    /// the sessions whose agent was stopped.
    pub async fn stop_idle_agents(&self, now: DateTime<Utc>) -> Vec<SessionId> {
        let all = self.list_sessions();
        let by_id: HashMap<&str, &Session> = all.iter().map(|s| (s.id.as_str(), s)).collect();
        let live: HashSet<String> = self
            .inner
            .runtimes
            .lock()
            .iter()
            .filter(|(_, rt)| rt.driver.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        if live.is_empty() {
            return vec![];
        }
        let hours = self.idle_stop_hours();
        let mut done: HashSet<String> = HashSet::new();
        let mut stopped = vec![];
        for id in &live {
            let Some(s) = by_id.get(id.as_str()) else {
                continue;
            };
            let (root, scheduled) = unit_of(s, &by_id);
            if !done.insert(root.id.clone()) {
                continue;
            }
            let wait = if scheduled {
                FINISHED_RUN_GRACE
            } else if hours == 0 {
                continue;
            } else {
                Duration::hours(i64::from(hours))
            };
            let tree = tree_of(root, &all);
            if !tree.iter().all(|m| self.quiet(m)) {
                continue;
            }
            let last = tree.iter().map(|m| m.last_activity).max().unwrap_or(now);
            if now - last < wait {
                continue;
            }
            for m in tree.iter().filter(|m| live.contains(&m.id)) {
                // Checked again: a message may have come in meanwhile.
                if !self.get_session(&m.id).is_ok_and(|s| self.quiet(&s)) {
                    break;
                }
                if self.stop(&m.id).await.is_ok() {
                    stopped.push(m.id.clone());
                }
            }
        }
        stopped
    }

    /// Nothing going on in the session and nothing on its way to it.
    fn quiet(&self, s: &Session) -> bool {
        if s.mode == SessionMode::Terminal {
            // A TUI or shell the user may be in: never stopped by Aura.
            return self.pty(&s.id).is_none();
        }
        if !matches!(
            s.status,
            SessionStatus::Idle | SessionStatus::Error | SessionStatus::Exited
        ) {
            return false;
        }
        let rt_quiet = self.inner.runtimes.lock().get(&s.id).is_none_or(|rt| {
            rt.current_turn.is_none()
                // A turn that never starts (a command the agent answers
                // without one) does not keep it alive for good.
                && rt
                    .awaiting_turn
                    .is_none_or(|at| at.elapsed() > AWAITING_TURN_LIMIT)
                && rt.pending_approvals.is_empty()
                && rt.pending_inputs.is_empty()
        });
        rt_quiet && !self.has_undelivered(&s.id)
    }
}

/// The unit a session is stopped with: the scheduled run it is part of (its
/// own, or its orchestrator's), else its topmost orchestrator, else itself.
/// True when it is a scheduled run.
fn unit_of<'a>(s: &'a Session, by_id: &HashMap<&str, &'a Session>) -> (&'a Session, bool) {
    let mut top = s;
    let mut seen = HashSet::new();
    let mut cur = Some(s);
    while let Some(c) = cur.filter(|c| seen.insert(c.id.clone())) {
        if c.scheduled_task_id.is_some() {
            return (c, true);
        }
        top = c;
        cur = c
            .orchestrator_id
            .as_deref()
            .and_then(|o| by_id.get(o).copied());
    }
    (top, false)
}

/// `root` and every session under it.
fn tree_of<'a>(root: &'a Session, all: &'a [Session]) -> Vec<&'a Session> {
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        let id = out[i].id.clone();
        for w in all
            .iter()
            .filter(|w| w.orchestrator_id.as_deref() == Some(&id))
        {
            if !out.iter().any(|o| o.id == w.id) {
                out.push(w);
            }
        }
        i += 1;
    }
    out
}
