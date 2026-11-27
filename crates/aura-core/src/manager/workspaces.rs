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
            workspace
        };
        self.workspaces_changed();
        Ok(workspace)
    }

    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<Workspace> {
        let workspace = {
            let _guard = self.inner.workspaces.lock();
            let list = self.ensure_workspaces_locked()?;
            let mut workspace = find(&list, id)?.clone();
            workspace.name = valid_name(name, &list, Some(id))?;
            self.save_workspace(&workspace)?;
            workspace
        };
        self.workspaces_changed();
        Ok(workspace)
    }

    /// Delete a workspace. What it holds, sessions and scheduled tasks, is
    /// moved to `move_to` first, which is required when it holds anything:
    /// deleting a workspace never deletes a session. The last workspace
    /// cannot be deleted. Returns the workspaces left.
    pub fn delete_workspace(&self, id: &str, move_to: Option<&str>) -> Result<Vec<Workspace>> {
        let left = {
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
            let sessions: Vec<String> = self
                .inner
                .sessions
                .lock()
                .values()
                .filter(|s| s.workspace == id)
                .map(|s| s.id.clone())
                .collect();
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
            for mut task in tasks {
                task.workspace = target.clone();
                self.inner.store.save_scheduled_task(&task)?;
            }
            for s in sessions {
                // Not activity: the session keeps its place in the list.
                let moved = self.change_session(&s, false, |s| {
                    if s.workspace != id {
                        return false;
                    }
                    s.workspace = target.clone();
                    true
                });
                // Deleted meanwhile is fine; anything else keeps the workspace.
                if let Err(e) = moved {
                    if self.get_session(&s).is_ok() {
                        return Err(e);
                    }
                }
            }
            self.inner.store.delete_feature_record(WORKSPACES, id)?;
            let left: Vec<Workspace> = list.into_iter().filter(|w| w.id != id).collect();
            if self.stored_last_active().as_deref() == Some(id) {
                let next = if target.is_empty() {
                    left[0].id.clone()
                } else {
                    target
                };
                self.inner
                    .store
                    .set_setting(LAST_ACTIVE_WORKSPACE_KEY, &next)?;
            }
            left
        };
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
        let mut moved = vec![];
        for s in self.with_workers(id) {
            // Not activity: the sessions keep their place in the list.
            match self.change_session(&s.id, false, |s| {
                if s.workspace == workspace {
                    return false;
                }
                s.workspace = workspace.to_string();
                true
            }) {
                Ok(s) => moved.push(s),
                // Deleted meanwhile: nothing left to move.
                Err(_) if self.get_session(&s.id).is_err() => {}
                Err(e) => return Err(e),
            }
        }
        Ok(moved)
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

    /// `id` when it exists, else the first workspace (the default one,
    /// unless the user deleted it): where a scheduled task whose workspace
    /// is gone starts its runs.
    pub fn workspace_or_default(&self, id: &str) -> Result<String> {
        let _guard = self.inner.workspaces.lock();
        let list = self.ensure_workspaces_locked()?;
        Ok(match list.iter().find(|w| w.id == id) {
            Some(w) => w.id.clone(),
            None => list[0].id.clone(),
        })
    }

    /// Fail unless a session asking for `workspace` could be created there.
    pub(super) fn check_requested_workspace(&self, opts: &CreateSessionOpts) -> Result<()> {
        match opts.workspace.as_deref().map(str::trim) {
            // A worker goes where its orchestrator is, whatever it asked for.
            Some(ws) if !ws.is_empty() && opts.orchestrator_id.is_none() => {
                find(&self.list_workspaces()?, ws)?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// The workspace a new session goes into, decided with the registry
    /// lock held while it is stored: a worker's orchestrator's, else the one
    /// it asked for, else (none, or one deleted while it was made) the
    /// fallback.
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
        if known(&s.workspace) {
            return Ok(s.workspace.clone());
        }
        self.fallback_workspace_locked()
    }

    /// Give everything stored before workspaces a workspace: make the
    /// default one when there is none, and put each session and scheduled
    /// task without a known workspace in it. A worker goes where its
    /// orchestrator is. Changes nothing else; idempotent.
    pub(super) fn backfill_workspaces(&self) -> Result<()> {
        let created = {
            let _guard = self.inner.workspaces.lock();
            let had = !self.stored_workspaces()?.is_empty();
            let list = self.ensure_workspaces_locked()?;
            let default = list[0].id.clone();
            let known = |id: &str| list.iter().any(|w| w.id == id);
            let sessions: HashMap<String, Session> = self
                .list_sessions()
                .into_iter()
                .map(|s| (s.id.clone(), s))
                .collect();
            // Where a session belongs: its own workspace if known, else its
            // orchestrator's, up the tree, else the default one.
            let belongs = |s: &Session| -> String {
                let mut seen = HashSet::new();
                let mut at = s;
                loop {
                    if known(&at.workspace) {
                        return at.workspace.clone();
                    }
                    match at.orchestrator_id.as_ref().and_then(|o| sessions.get(o)) {
                        Some(o) if seen.insert(o.id.clone()) => at = o,
                        _ => return default.clone(),
                    }
                }
            };
            let mut fixed = 0;
            for s in sessions.values().filter(|s| !known(&s.workspace)) {
                let ws = belongs(s);
                // Not activity: the sidebar looks exactly as before.
                self.change_session(&s.id, false, |s| {
                    s.workspace = ws;
                    true
                })?;
                fixed += 1;
            }
            if fixed > 0 {
                tracing::info!("put {fixed} session(s) without a workspace in one");
            }
            let _tasks = self.inner.scheduled_tasks.lock();
            for mut task in self.inner.store.scheduled_tasks()? {
                if !known(&task.workspace) {
                    task.workspace = default.clone();
                    self.inner.store.save_scheduled_task(&task)?;
                }
            }
            !had
        };
        if created {
            self.workspaces_changed();
        }
        Ok(())
    }

    // ------------------------------------------------------------ internals

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

    /// Tell the app the workspaces changed. A failure to read them is
    /// logged: the change itself was made.
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
