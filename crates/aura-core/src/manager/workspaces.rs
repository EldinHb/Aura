//! Workspaces: named containers the user works in (see [`Workspace`]).
//!
//! - Every session is in exactly one, and so is every scheduled task, whose
//!   runs go into the task's workspace.
//! - A worker is always in its orchestrator's workspace: it starts there,
//!   and moving the orchestrator moves everything under it, so an orchestra
//!   never spans two workspaces.
//! - A session created without one (through the API, a mod, an older app)
//!   goes into the workspace the user was last active in, which the app
//!   reports with `workspace.touch`.
//! - Aura keeps at least one. A store from before workspaces gets a
//!   "Default" one when the daemon loads it, holding every session and task.
//!
//! The registry is a feature-record namespace, like the groups.

use super::*;
use crate::schedule::ScheduledTask;

/// Feature-record namespace of the workspace registry, keyed by id.
const WORKSPACES: &str = "workspaces";
/// Setting holding the id of the workspace the user was last active in.
pub const LAST_ACTIVE_WORKSPACE_KEY: &str = "workspaces.last_active";
/// The name of the workspace Aura makes when there is none.
pub const DEFAULT_WORKSPACE_NAME: &str = "Default";
/// The longest workspace name, in characters.
pub const WORKSPACE_NAME_MAX: usize = 40;

impl Manager {
    /// Every workspace, in the order the app lists them. Never empty: with
    /// none stored, the default one is made first.
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let list = self.stored_workspaces()?;
        if !list.is_empty() {
            return Ok(list);
        }
        let _guard = self.inner.workspaces.lock();
        self.ensure_workspaces_locked()
    }

    /// Make a workspace. The name is trimmed, and must be 1 to
    /// [`WORKSPACE_NAME_MAX`] characters and unique, ignoring case.
    pub fn create_workspace(&self, name: &str) -> Result<Workspace> {
        let workspace = {
            let _guard = self.inner.workspaces.lock();
            let list = self.ensure_workspaces_locked()?;
            let workspace = Workspace {
                id: crate::new_id(),
                name: valid_name(name, &list, None)?,
                created_at: crate::now(),
                position: list.iter().map(|w| w.position + 1).max().unwrap_or(0),
            };
            self.save_workspace(&workspace)?;
            self.workspaces_changed();
            workspace
        };
        Ok(workspace)
    }

    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<Workspace> {
        let workspace = {
            let _guard = self.inner.workspaces.lock();
            let list = self.ensure_workspaces_locked()?;
            let mut workspace = find(&list, id)?.clone();
            workspace.name = valid_name(name, &list, Some(id))?;
            self.save_workspace(&workspace)?;
            self.workspaces_changed();
            workspace
        };
        Ok(workspace)
    }

    /// Delete a workspace. What it holds, sessions and scheduled tasks, is
    /// moved to `move_to` first, which is required when it holds anything:
    /// deleting a workspace never deletes a session. The last workspace
    /// cannot be deleted. Returns the workspaces left.
    ///
    /// All or nothing, as far as the store allows: when something cannot be
    /// moved, what was moved is put back and the workspace stays.
    pub fn delete_workspace(&self, id: &str, move_to: Option<&str>) -> Result<Vec<Workspace>> {
        let _guard = self.inner.workspaces.lock();
        let list = self.ensure_workspaces_locked()?;
        let gone = find(&list, id)?.clone();
        if list.len() == 1 {
            bail!(
                "“{}” is the only workspace, and Aura needs at least one",
                gone.name
            );
        }
        let move_to = move_to.map(str::trim).filter(|t| !t.is_empty());
        if let Some(t) = move_to {
            if t == id {
                bail!(
                    "cannot move what “{}” holds into itself; name another workspace",
                    gone.name
                );
            }
            find(&list, t)?;
        }
        // Task records are changed under the scheduler's lock, so none it
        // saves meanwhile still names this workspace.
        let _tasks = self.inner.scheduled_tasks.lock();
        let sessions = self.sessions_in_locked(id);
        let tasks: Vec<ScheduledTask> = self
            .inner
            .store
            .scheduled_tasks()?
            .into_iter()
            .filter(|t| t.workspace == id)
            .collect();
        let target = match move_to {
            Some(t) => t.to_string(),
            None if sessions.is_empty() && tasks.is_empty() => String::new(),
            None => bail!(
                "“{}” holds {} and {}: name the workspace to move them to (`move_to`)",
                gone.name,
                plural(sessions.len(), "session"),
                plural(tasks.len(), "scheduled task"),
            ),
        };
        let moved = self
            .move_sessions_locked(&sessions, &target)
            .with_context(|| format!("move the sessions of “{}”", gone.name))?;
        let undo_sessions = || {
            let back: Vec<String> = moved.iter().map(|s| s.id.clone()).collect();
            if let Err(e) = self.move_sessions_locked(&back, id) {
                tracing::warn!("put the sessions back in workspace {id}: {e:#}");
            }
        };
        let mut moved_tasks: Vec<&ScheduledTask> = vec![];
        for task in &tasks {
            let saved = self.inner.store.save_scheduled_task(&ScheduledTask {
                workspace: target.clone(),
                ..task.clone()
            });
            if let Err(e) = saved {
                for t in moved_tasks {
                    match self.inner.store.save_scheduled_task(t) {
                        Ok(()) => self.scheduled_task_changed(&t.id),
                        Err(e) => {
                            tracing::warn!(
                                "put scheduled task {} back in workspace {id}: {e:#}",
                                t.id
                            )
                        }
                    }
                }
                undo_sessions();
                return Err(e.context(format!("move the scheduled tasks of “{}”", gone.name)));
            }
            self.scheduled_task_changed(&task.id);
            moved_tasks.push(task);
        }
        if let Err(e) = self.inner.store.delete_feature_record(WORKSPACES, id) {
            for t in moved_tasks {
                if self.inner.store.save_scheduled_task(t).is_ok() {
                    self.scheduled_task_changed(&t.id);
                }
            }
            undo_sessions();
            return Err(e);
        }
        let left: Vec<Workspace> = list.into_iter().filter(|w| w.id != id).collect();
        if self.stored_last_active().as_deref() == Some(id) {
            let next = if target.is_empty() {
                left[0].id.clone()
            } else {
                target
            };
            // The workspace is gone either way; a stale setting falls back.
            if let Err(e) = self
                .inner
                .store
                .set_setting(LAST_ACTIVE_WORKSPACE_KEY, &next)
            {
                tracing::warn!("remember the last active workspace: {e:#}");
            }
        }
        self.workspaces_changed();
        Ok(left)
    }

    /// The user is working in workspace `id`: sessions created without a
    /// workspace go there from now on.
    pub fn touch_workspace(&self, id: &str) -> Result<()> {
        let _guard = self.inner.workspaces.lock();
        let list = self.ensure_workspaces_locked()?;
        find(&list, id)?;
        self.inner.store.set_setting(LAST_ACTIVE_WORKSPACE_KEY, id)
    }

    /// Move a session to workspace `workspace`, with every worker under it.
    /// A worker cannot move on its own: it stays with its orchestrator.
    /// Returns the session and every session under it, the session first,
    /// all now in `workspace`.
    pub fn set_session_workspace(&self, id: &str, workspace: &str) -> Result<Vec<Session>> {
        let _guard = self.inner.workspaces.lock();
        let list = self.ensure_workspaces_locked()?;
        find(&list, workspace)?;
        let s = self.get_session(id)?;
        if let Some(o) = s.orchestrator_id.as_deref() {
            if let Ok(o) = self.get_session(o) {
                bail!(
                    "{} is a worker of {}, and workers stay with their orchestrator: move {} instead, which takes its workers along",
                    s.title,
                    o.title,
                    o.title
                );
            }
        }
        // Under the registry lock, which a new session holds while it takes
        // its orchestrator's workspace: a worker that starts meanwhile is
        // either in this tree or starts in the new workspace.
        let tree: Vec<String> = self.with_workers(id).into_iter().map(|s| s.id).collect();
        self.move_sessions_locked(&tree, workspace)
    }

    /// The workspace the user was last active in, if it still exists.
    pub fn last_active_workspace(&self) -> Option<String> {
        let id = self.stored_last_active()?;
        self.has_workspace(&id).then_some(id)
    }

    /// The last active workspace as stored, which may be gone since.
    fn stored_last_active(&self) -> Option<String> {
        match self.inner.store.get_setting(LAST_ACTIVE_WORKSPACE_KEY) {
            Ok(id) => id.filter(|id| !id.is_empty()),
            Err(e) => {
                tracing::warn!("read the last active workspace: {e:#}");
                None
            }
        }
    }

    /// Whether workspace `id` exists. Reads the store only, so it can be
    /// called under any lock.
    pub fn has_workspace(&self, id: &str) -> bool {
        !id.is_empty()
            && self
                .stored_workspaces()
                .is_ok_and(|list| list.iter().any(|w| w.id == id))
    }

    /// Where something without a workspace of its own goes: the workspace
    /// the user was last active in, else the first one.
    pub fn fallback_workspace(&self) -> Result<String> {
        let _guard = self.inner.workspaces.lock();
        self.fallback_workspace_locked()
    }

    /// Fail unless a session asking for `workspace` could be created there.
    pub(super) fn check_requested_workspace(&self, opts: &CreateSessionOpts) -> Result<()> {
        match opts.workspace.as_deref().map(str::trim) {
            // A worker goes where its orchestrator is, and a scheduled run
            // where its task is when it is placed, whatever they asked for.
            Some(ws)
                if !ws.is_empty()
                    && opts.orchestrator_id.is_none()
                    && opts.scheduled_task.is_none() =>
            {
                find(&self.list_workspaces()?, ws)?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// The workspace a new session goes into, decided with the registry
    /// lock held while it is stored: a worker's orchestrator's; for a
    /// scheduled run, its task's as the task is now; else the one it asked
    /// for, else (none, or one deleted while it was made) the fallback.
    ///
    /// The caller holds the registry lock and, for a scheduled run, the
    /// scheduled-task lock, both until the session is stored and in the
    /// list.
    pub(super) fn place_new_session_locked(&self, s: &Session) -> Result<String> {
        let list = self.ensure_workspaces_locked()?;
        let known = |id: &str| list.iter().any(|w| w.id == id);
        if let Some(o) = s.orchestrator_id.as_deref() {
            if let Ok(o) = self.get_session(o) {
                if known(&o.workspace) {
                    return Ok(o.workspace);
                }
            }
        }
        // The scheduler read the task before it started the run; its
        // workspace may have been deleted, and the task moved or changed,
        // since. The caller holds the task lock (see the doc above), so this
        // is the task as it is until the run is stored.
        if let Some(task) = s.scheduled_task_id.as_deref() {
            let now = self
                .inner
                .store
                .scheduled_tasks()?
                .into_iter()
                .find(|t| t.id == task)
                .map(|t| t.workspace);
            // A deleted task leaves what the run read; a workspace gone
            // anyway, the default one.
            return Ok(match now.as_deref().unwrap_or(&s.workspace) {
                ws if known(ws) => ws.to_string(),
                _ => list[0].id.clone(),
            });
        }
        if known(&s.workspace) {
            return Ok(s.workspace.clone());
        }
        self.fallback_workspace_locked()
    }

    /// Give everything stored before workspaces a workspace: make the
    /// default one when there is none, and put each session and scheduled
    /// task without a known workspace in it. A worker goes where the top of
    /// its orchestrator chain is, which also joins a tree a failed move left
    /// split. Changes nothing else; idempotent.
    pub(super) fn backfill_workspaces(&self) -> Result<()> {
        let _guard = self.inner.workspaces.lock();
        let list = self.ensure_workspaces_locked()?;
        let default = list[0].id.clone();
        let known = |id: &str| list.iter().any(|w| w.id == id);
        let sessions: HashMap<String, Session> = self
            .list_sessions()
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        // Where a session belongs: its leader's workspace (the top of its
        // orchestrator chain, itself when it has none), or the default one
        // when that is not known.
        let belongs = |s: &Session| -> String {
            let mut seen = HashSet::from([s.id.clone()]);
            let mut leader = s;
            while let Some(o) = leader
                .orchestrator_id
                .as_ref()
                .and_then(|o| sessions.get(o))
            {
                if !seen.insert(o.id.clone()) {
                    break;
                }
                leader = o;
            }
            if known(&leader.workspace) {
                leader.workspace.clone()
            } else {
                default.clone()
            }
        };
        let mut fixed = 0;
        for s in sessions.values() {
            let ws = belongs(s);
            if s.workspace == ws {
                continue;
            }
            // Not activity: the sidebar looks exactly as before.
            self.change_session_stored(&s.id, false, |s| {
                s.workspace = ws;
                true
            })?;
            fixed += 1;
        }
        if fixed > 0 {
            tracing::info!("put {fixed} session(s) in their leader's or the default workspace");
        }
        let _tasks = self.inner.scheduled_tasks.lock();
        for mut task in self.inner.store.scheduled_tasks()? {
            if !known(&task.workspace) {
                task.workspace = default.clone();
                self.inner.store.save_scheduled_task(&task)?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ internals

    /// The sessions in workspace `id`, each orchestrator before its workers.
    fn sessions_in_locked(&self, id: &str) -> Vec<String> {
        let sessions: HashMap<String, Session> = self
            .list_sessions()
            .into_iter()
            .filter(|s| s.workspace == id)
            .map(|s| (s.id.clone(), s))
            .collect();
        let depth = |s: &Session| {
            let mut seen = HashSet::from([s.id.as_str()]);
            let mut at = s;
            let mut depth = 0;
            while let Some(o) = at.orchestrator_id.as_deref().and_then(|o| sessions.get(o)) {
                if !seen.insert(o.id.as_str()) {
                    break;
                }
                at = o;
                depth += 1;
            }
            depth
        };
        let mut ids: Vec<(usize, &String)> = sessions.values().map(|s| (depth(s), &s.id)).collect();
        ids.sort();
        ids.into_iter().map(|(_, id)| id.clone()).collect()
    }

    /// Move sessions `ids`, listed each orchestrator before its workers, to
    /// workspace `to`. Each is stored before it changes, workers before
    /// their orchestrator, and when one cannot be moved those already moved
    /// are put back: a tree is never left split by a failure the store
    /// reports. One it cannot put back either joins its leader again when
    /// the daemon next starts. Returns the sessions, in the order given.
    fn move_sessions_locked(&self, ids: &[String], to: &str) -> Result<Vec<Session>> {
        let mut moved: Vec<(String, String)> = vec![];
        let mut out = vec![];
        for id in ids.iter().rev() {
            let mut from = None;
            // Not activity: the sessions keep their place in the list.
            let result = self.change_session_stored(id, false, |s| {
                if s.workspace == to {
                    return false;
                }
                from = Some(std::mem::replace(&mut s.workspace, to.to_string()));
                true
            });
            match result {
                Ok(s) => {
                    if let Some(from) = from {
                        moved.push((s.id.clone(), from));
                    }
                    out.push(s);
                }
                // Deleted meanwhile: nothing left to move.
                Err(_) if self.get_session(id).is_err() => {}
                Err(e) => {
                    for (id, from) in moved.iter().rev() {
                        let back = self.change_session_stored(id, false, |s| {
                            s.workspace = from.clone();
                            true
                        });
                        if let Err(e) = back {
                            tracing::warn!(
                                "put session {id} back in workspace {from}: {e:#}; it joins its leader's when the daemon next starts"
                            );
                        }
                    }
                    return Err(e);
                }
            }
        }
        out.reverse();
        Ok(out)
    }

    fn stored_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut list: Vec<Workspace> = self
            .inner
            .store
            .feature_records(WORKSPACES)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(w) => Some(w),
                Err(e) => {
                    tracing::warn!("skipping unreadable workspace {id}: {e}");
                    None
                }
            })
            .collect();
        list.sort_by(|a: &Workspace, b: &Workspace| {
            (a.position, a.created_at, &a.id).cmp(&(b.position, b.created_at, &b.id))
        });
        Ok(list)
    }

    /// The workspaces, the default one made first when there are none. The
    /// caller holds the registry lock.
    fn ensure_workspaces_locked(&self) -> Result<Vec<Workspace>> {
        let list = self.stored_workspaces()?;
        if !list.is_empty() {
            return Ok(list);
        }
        let default = Workspace {
            id: crate::new_id(),
            name: DEFAULT_WORKSPACE_NAME.into(),
            created_at: crate::now(),
            position: 0,
        };
        self.save_workspace(&default)?;
        let list = vec![default];
        self.broadcast(Event::WorkspacesChanged {
            workspaces: list.clone(),
        });
        Ok(list)
    }

    fn fallback_workspace_locked(&self) -> Result<String> {
        let list = self.ensure_workspaces_locked()?;
        if let Some(id) = self.last_active_workspace() {
            if list.iter().any(|w| w.id == id) {
                return Ok(id);
            }
        }
        Ok(list[0].id.clone())
    }

    fn save_workspace(&self, w: &Workspace) -> Result<()> {
        self.inner
            .store
            .save_feature_record(WORKSPACES, &w.id, &serde_json::to_string(w)?)
    }

    /// Tell the app the workspaces changed. Called with the registry lock
    /// held, so the announcements go out in the order of the changes and a
    /// late one never brings back a deleted workspace. A failure to read
    /// them is logged: the change itself was made.
    fn workspaces_changed(&self) {
        match self.stored_workspaces() {
            Ok(workspaces) => self.broadcast(Event::WorkspacesChanged { workspaces }),
            Err(e) => tracing::warn!("read the workspaces: {e:#}"),
        }
    }
}

fn find<'a>(list: &'a [Workspace], id: &str) -> Result<&'a Workspace> {
    list.iter()
        .find(|w| w.id == id)
        .ok_or_else(|| anyhow!("no workspace `{id}`; workspace.list shows them"))
}

/// `name` trimmed, when it can name a workspace among `list`; `except` is
/// the workspace being renamed, which may keep its own name.
fn valid_name(name: &str, list: &[Workspace], except: Option<&str>) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a workspace needs a name");
    }
    if name.chars().count() > WORKSPACE_NAME_MAX {
        bail!("a workspace name has at most {WORKSPACE_NAME_MAX} characters");
    }
    let lower = name.to_lowercase();
    if let Some(other) = list
        .iter()
        .find(|w| Some(w.id.as_str()) != except && w.name.to_lowercase() == lower)
    {
        bail!("a workspace named “{}” already exists", other.name);
    }
    Ok(name.to_string())
}

fn plural(n: usize, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else {
        format!("{n} {what}s")
    }
}
