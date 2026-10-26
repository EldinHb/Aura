//! Review follow-ups: new review activity on a session's pull requests goes to
//! that session's agent, and the user hears about it twice: when it arrives,
//! and when the agent's turn on it ends.
//!
//! Once a minute the daemon looks at the PRs each session follows: the ones it
//! is linked to (the links the user chose, else the ones the desktop app
//! detected in the conversation) and the ones opened from its branch
//! (`Session::pulls`; for a worktree the daemon looks its branch's PR up
//! itself). For each open PR the user authored it collects reviews,
//! inline review comments and conversation comments newer than the last look,
//! all PRs in one GraphQL query. A PR is read when a notification says it
//! changed, and otherwise every few minutes (see [`activity::due`]).
//! The first look only records where things stand: older activity is history.
//!
//! Activity by the user's own account is skipped: agents post as the user, so
//! their own replies would otherwise wake them again. Conversation comments by
//! bots are skipped too (CI and coverage reports); reviews by bots count.
use anyhow::Result;
use aura_core::*;
use aura_github::{
    activity::{self, Since},
    database_id, s, validate_repo, Github,
};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::broadcast;

const NAMESPACE: &str = "pr-follows";
/// Activity found but not yet handed over, per session. Kept across restarts,
/// since the PR's baseline has already moved past it.
const PENDING_NAMESPACE: &str = "pr-follow-pending";
/// A hand-over whose turn has not started by then is given up on.
const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// A worktree whose branch has no PR yet is looked up again after this long.
const BRANCH_LOOKUP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// The desktop app's per-session link settings (see `sessionLinkPreferences.ts`).
pub const LINKS_KEY: &str = "session.links.v1.";
pub const DETECTED_KEY: &str = "session.links.detected.v1.";
/// Longest review or comment body handed to an agent.
const BODY_LIMIT: usize = 4000;
/// Review states that mean a reviewer responded.
const RESPONSES: [&str; 3] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];

/// Where the daemon stands on one pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Followed {
    id: String,
    repo: String,
    number: u32,
    author: String,
    /// False once merged or closed. A closed PR is looked at now and then, in case it is
    /// reopened; a merged one is not looked at again.
    open: bool,
    #[serde(default)]
    merged: bool,
    /// Highest ids already looked at, per kind of activity.
    seen_review: u64,
    seen_comment: u64,
    seen_conversation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Activity {
    /// review | comment (inline, on the diff) | conversation
    pub kind: String,
    pub id: u64,
    pub author: String,
    /// The review state; empty for comments.
    pub state: String,
    pub body: String,
    pub url: String,
    pub path: Option<String>,
    pub line: Option<u64>,
}

impl Activity {
    /// An approval without words asks nothing of the agent.
    fn actionable(&self) -> bool {
        !(self.kind == "review" && self.state == "APPROVED" && self.body.trim().is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrActivity {
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    pub items: Vec<Activity>,
}

impl PrActivity {
    fn id(&self) -> String {
        pr_id(&self.repo, self.number)
    }
}

/// A session handed activity, until its turn on it ends.
struct Handling {
    started: bool,
    since: std::time::Instant,
    prs: Vec<PrActivity>,
}

/// Take what was handed over out of a session's queue, item by item: more may
/// have been added to the same PR while sending.
fn remove_items(queue: &mut Vec<PrActivity>, sent: &[PrActivity]) {
    for pr in queue.iter_mut() {
        if let Some(done) = sent.iter().find(|s| s.id() == pr.id()) {
            pr.items
                .retain(|i| !done.items.iter().any(|d| d.kind == i.kind && d.id == i.id));
        }
    }
    queue.retain(|pr| !pr.items.is_empty());
}

pub struct FollowService {
    store: Arc<dyn Store>,
    gh: Arc<dyn Github>,
    manager: Manager,
    follows: Mutex<HashMap<String, Followed>>,
    /// Session id -> activity waiting until the session is free.
    pending: Mutex<HashMap<SessionId, Vec<PrActivity>>>,
    handling: Mutex<HashMap<SessionId, Handling>>,
    poll_gate: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Value>,
    /// Session id -> when its worktree branch was last looked up without a PR found.
    branch_lookups: Mutex<HashMap<SessionId, std::time::Instant>>,
    /// PR id -> when it was last read, and last updated then.
    reads: Mutex<HashMap<String, activity::LastRead>>,
}

fn pr_id(repo: &str, number: u32) -> String {
    format!("{}#{number}", repo.to_lowercase())
}

impl FollowService {
    pub fn new(
        store: Arc<dyn Store>,
        gh: Arc<dyn Github>,
        manager: Manager,
        events: broadcast::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let follows = store
            .feature_records(NAMESPACE)?
            .into_iter()
            .map(|(id, raw)| Ok((id, serde_json::from_str(&raw)?)))
            .collect::<Result<HashMap<String, Followed>>>()?;
        let pending = store
            .feature_records(PENDING_NAMESPACE)?
            .into_iter()
            .map(|(id, raw)| Ok((id, serde_json::from_str(&raw)?)))
            .collect::<Result<HashMap<SessionId, Vec<PrActivity>>>>()?;
        Ok(Arc::new(Self {
            store,
            gh,
            manager,
            follows: Mutex::new(follows),
            pending: Mutex::new(pending),
            handling: Mutex::new(HashMap::new()),
            poll_gate: tokio::sync::Mutex::new(()),
            events,
            branch_lookups: Mutex::new(HashMap::new()),
            reads: Mutex::new(HashMap::new()),
        }))
    }

    pub fn launch(self: &Arc<Self>) {
        let svc = self.clone();
        tokio::spawn(async move {
            loop {
                svc.poll().await;
                tokio::time::sleep(svc.gh.pace(crate::watch::POLL_INTERVAL)).await;
            }
        });
        self.listen();
    }

    /// Follow session events (see [`Self::on_event`]).
    fn listen(self: &Arc<Self>) {
        let svc = self.clone();
        let mut rx = self.manager.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => svc.on_event(&ev).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Follow the turns of sessions handed activity, and hand over what
    /// waits once a session is free.
    pub async fn on_event(&self, ev: &Event) {
        let sid = ev.session_id();
        match ev {
            Event::TurnStarted { .. } => {
                if let Some(h) = self.handling.lock().get_mut(sid) {
                    h.started = true;
                }
            }
            Event::TurnCompleted { turn, .. } => {
                let done = {
                    let mut handling = self.handling.lock();
                    match handling.get(sid) {
                        Some(h) if h.started => handling.remove(sid),
                        _ => None,
                    }
                };
                if let Some(h) = done {
                    let status = match turn.status {
                        TurnStatus::Completed => "completed",
                        TurnStatus::Interrupted => "interrupted",
                        _ => "failed",
                    };
                    let reply = match turn.status {
                        TurnStatus::Completed => self.manager.last_reply(sid),
                        _ => turn.error.clone().or_else(|| self.manager.last_reply(sid)),
                    };
                    self.handled(sid, &h.prs, status, reply);
                }
                // Right after the user interrupted it, the session would only
                // be set going again; the next poll hands the rest over.
                if turn.status != TurnStatus::Interrupted {
                    self.flush(sid).await;
                }
            }
            Event::ProcessExited { message, .. } => {
                if let Some(h) = self.handling.lock().remove(sid) {
                    let status = if message.is_some() {
                        "failed"
                    } else {
                        "stopped"
                    };
                    self.handled(sid, &h.prs, status, message.clone());
                }
            }
            Event::ApprovalResolved { .. } | Event::UserInputResolved { .. } => {
                self.flush(sid).await;
            }
            _ => {}
        }
    }

    fn handled(&self, sid: &str, prs: &[PrActivity], status: &str, reply: Option<String>) {
        let title = self
            .manager
            .get_session(sid)
            .map(|s| s.title)
            .unwrap_or_default();
        let _ = self.events.send(json!({"method": "follows.handled", "params": {
            "session": {"id": sid, "title": title},
            "prs": prs.iter().map(|p| json!({"repo": p.repo, "number": p.number, "title": p.title, "url": p.url})).collect::<Vec<_>>(),
            "status": status,
            "reply": reply,
        }}));
    }

    /// Change a session's queue and save it.
    fn edit_pending(&self, sid: &str, edit: impl FnOnce(&mut Vec<PrActivity>)) {
        let mut pending = self.pending.lock();
        let queue = pending.entry(sid.to_string()).or_default();
        edit(queue);
        let saved = if queue.is_empty() {
            pending.remove(sid);
            self.store.delete_feature_record(PENDING_NAMESPACE, sid)
        } else {
            serde_json::to_string(queue)
                .map_err(Into::into)
                .and_then(|raw| self.store.save_feature_record(PENDING_NAMESPACE, sid, &raw))
        };
        if let Err(e) = saved {
            tracing::warn!("saving review follow-ups for {sid} failed: {e:#}");
        }
    }

    /// Hand a session the activity waiting for it, if it is free to take it.
    async fn flush(&self, sid: &str) {
        let batch = match self.pending.lock().get(sid) {
            Some(batch) if !batch.is_empty() => batch.clone(),
            _ => return,
        };
        let Ok(session) = self.manager.get_session(sid) else {
            self.edit_pending(sid, |q| q.clear());
            return;
        };
        {
            // One hand-over per session at a time; claimed before sending so
            // the turn's start is not missed.
            let mut handling = self.handling.lock();
            if handling.contains_key(sid) {
                return;
            }
            handling.insert(
                sid.to_string(),
                Handling {
                    started: false,
                    since: std::time::Instant::now(),
                    prs: batch.clone(),
                },
            );
        }
        let text = hand_over_message(&batch, session.orchestrator);
        match self.manager.send_when_free(sid, text).await {
            Ok(true) => {
                self.edit_pending(sid, |q| remove_items(q, &batch));
                let _ = self.events.send(json!({"method": "follows.started", "params": {
                    "session": {"id": sid, "title": session.title},
                    "prs": batch.iter().map(|p| json!({"repo": p.repo, "number": p.number, "title": p.title, "url": p.url})).collect::<Vec<_>>(),
                }}));
            }
            Ok(false) => {
                self.handling.lock().remove(sid);
            }
            Err(e) => {
                self.handling.lock().remove(sid);
                self.edit_pending(sid, |q| remove_items(q, &batch));
                self.handled(
                    sid,
                    &batch,
                    "failed",
                    Some(format!("Could not send it the review activity: {e:#}")),
                );
            }
        }
    }

    /// One pass: find new activity on every linked PR and hand it over.
    pub async fn poll(&self) {
        let _gate = self.poll_gate.lock().await;
        if let Some(reason) = self.gh.blocked().await {
            return tracing::debug!("review follow-ups paused: {reason}");
        }
        let me = match self.gh.account().await {
            Ok(account) => account
                .split_once(':')
                .map(|(_, login)| login.to_string())
                .unwrap_or(account),
            Err(e) => {
                tracing::debug!("review follow-ups skipped: {e:#}");
                return;
            }
        };
        let mut sessions: Vec<Session> = self
            .manager
            .list_sessions()
            .into_iter()
            .filter(|s| {
                !s.archived
                    && s.mode == SessionMode::Structured
                    && s.provider != ProviderKind::Terminal
            })
            .collect();
        // Drop what waits for sessions that are gone or archived.
        let gone: Vec<SessionId> = {
            let live: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
            self.pending
                .lock()
                .keys()
                .filter(|id| !live.contains(id.as_str()))
                .cloned()
                .collect()
        };
        for sid in gone {
            self.edit_pending(&sid, |q| q.clear());
        }
        // A hand-over whose turn never started would block the session for good.
        self.handling
            .lock()
            .retain(|_, h| h.started || h.since.elapsed() < START_TIMEOUT);
        for s in &mut sessions {
            self.find_branch_pull(s).await;
        }
        let mut linked: BTreeMap<String, (String, u32, Vec<Session>)> = BTreeMap::new();
        for s in &sessions {
            for (repo, number) in followed_prs(&*self.store, s) {
                linked
                    .entry(pr_id(&repo, number))
                    .or_insert_with(|| (repo, number, vec![]))
                    .2
                    .push(s.clone());
            }
        }
        let notified = self.gh.notified().await;
        let now = Utc::now();
        let mut due = vec![];
        for (id, (repo, number, linking)) in linked {
            let known = self.follows.lock().get(&id).cloned();
            if known
                .as_ref()
                .is_some_and(|f| f.merged || !f.author.eq_ignore_ascii_case(&me))
            {
                continue;
            }
            let read = self.reads.lock().get(&id).copied();
            let read_now = if known.as_ref().is_some_and(|f| !f.open) {
                activity::due_closed(read.map(|r| r.0), notified.as_ref(), &repo, number, now)
            } else {
                activity::due(read, notified.as_ref(), &repo, number, now)
            };
            if read_now {
                due.push((id, repo, number, known, linking));
            }
        }
        if !due.is_empty() {
            let prs: Vec<_> = due
                .iter()
                .map(|(_, repo, number, known, _)| (repo.clone(), *number, known.clone()))
                .collect();
            match self.check(&prs, &me).await {
                Ok(checked) => {
                    for ((id, _, _, _, linking), result) in due.into_iter().zip(checked) {
                        match result {
                            Ok(Some(activity)) => self.found(&id, &linking, activity),
                            Ok(None) => {}
                            Err(e) => {
                                tracing::warn!("review follow-up for {id} failed: {e:#}");
                                // A PR GitHub cannot return (one deleted, an issue's link) is
                                // tried again with the quiet ones.
                                self.reads
                                    .lock()
                                    .insert(id, (now, DateTime::<Utc>::MIN_UTC));
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!("review follow-ups failed: {e:#}"),
            }
        }
        let waiting: Vec<SessionId> = self.pending.lock().keys().cloned().collect();
        for sid in waiting {
            self.flush(&sid).await;
        }
    }

    /// Record the PR of a worktree session's branch when it has none yet
    /// (see [`Session::pulls`]); the app does the same for the sessions it
    /// shows, and this covers workers no window looked at. A branch without a
    /// PR is asked about again after [`BRANCH_LOOKUP_INTERVAL`].
    async fn find_branch_pull(&self, s: &mut Session) {
        let Some(worktree) = &s.worktree else { return };
        if !s.pulls.is_empty() || !follows_reviews(&*self.store, &s.id) {
            return;
        }
        if self
            .branch_lookups
            .lock()
            .get(&s.id)
            .is_some_and(|at| at.elapsed() < BRANCH_LOOKUP_INTERVAL)
        {
            return;
        }
        self.branch_lookups
            .lock()
            .insert(s.id.clone(), std::time::Instant::now());
        let cwd = s.cwd.clone();
        // As the app: the folder's GitHub repository, and its upstream's for a fork.
        let repos = tokio::task::spawn_blocking(move || -> Result<Option<(String, String)>> {
            let Some(repo) = aura_git::ops::github_repo(&cwd)? else {
                return Ok(None);
            };
            let head = aura_git::ops::branch_status(&cwd)?
                .and_then(|b| b.upstream_repo)
                .unwrap_or_else(|| repo.clone());
            Ok(Some((repo, head)))
        })
        .await;
        let (repo, head) = match repos {
            Ok(Ok(Some(repos))) => repos,
            Ok(Ok(None)) => return,
            Ok(Err(e)) => return tracing::debug!("branch of session {}: {e:#}", s.id),
            Err(e) => return tracing::debug!("branch of session {}: {e}", s.id),
        };
        match aura_github::branch::branch_pull(&*self.gh, &repo, &head, &worktree.branch).await {
            Ok(Some(pull)) => match self.manager.record_pull(&s.id, &pull.url) {
                Ok(updated) => {
                    self.branch_lookups.lock().remove(&s.id);
                    *s = updated;
                }
                Err(e) => tracing::warn!("record {} on session {}: {e:#}", pull.url, s.id),
            },
            Ok(None) => {}
            Err(e) => tracing::debug!("PR of {} in {repo}: {e:#}", worktree.branch),
        }
    }

    /// Tell the user about new activity, and queue it for the session that takes it.
    fn found(&self, id: &str, linking: &[Session], activity: PrActivity) {
        let target = target(linking).filter(|_| activity.items.iter().any(Activity::actionable));
        let _ = self.events.send(json!({"method": "follows.activity", "params": {
            "pr": {"repo": activity.repo, "number": activity.number, "title": activity.title, "url": activity.url},
            "items": activity.items,
            "session": target.map(|s| json!({"id": s.id, "title": s.title})),
        }}));
        if let Some(s) = target {
            self.edit_pending(&s.id, |queue| {
                match queue.iter_mut().find(|p| p.id() == id) {
                    Some(p) => p.items.extend(activity.items),
                    None => queue.push(activity),
                }
            });
        }
    }

    /// New activity on `prs` (`owner/repo`, number, where the daemon stood) since the last
    /// look, read in one go, recording the look.
    async fn check(
        &self,
        prs: &[(String, u32, Option<Followed>)],
        me: &str,
    ) -> Result<Vec<Result<Option<PrActivity>>>> {
        let since: Vec<_> = prs
            .iter()
            .map(|(repo, number, known)| {
                let since = known.as_ref().map_or_else(Since::default, |f| Since {
                    reviews: Some(f.seen_review),
                    comments: Some(f.seen_comment),
                    conversation: Some(f.seen_conversation),
                });
                (repo.clone(), *number, since)
            })
            .collect();
        let reads = activity::read(&*self.gh, &since).await?;
        Ok(prs
            .iter()
            .zip(reads)
            .map(|((repo, number, known), read)| {
                self.record(repo, *number, known.clone(), me, &read?)
            })
            .collect())
    }

    /// The activity in `read` newer than the last look at the PR, recording this look.
    fn record(
        &self,
        repo: &str,
        number: u32,
        known: Option<Followed>,
        me: &str,
        read: &activity::Read,
    ) -> Result<Option<PrActivity>> {
        let pull = &read.node;
        let author = s(&pull["author"], "login");
        let open = s(pull, "state") == "OPEN";
        let mut next = known.clone().unwrap_or(Followed {
            id: pr_id(repo, number),
            repo: repo.into(),
            number,
            author: author.clone(),
            open,
            merged: false,
            seen_review: 0,
            seen_comment: 0,
            seen_conversation: 0,
        });
        next.author = author;
        next.open = open;
        next.merged = s(pull, "state") == "MERGED";
        let mut items = vec![];
        if open && next.author.eq_ignore_ascii_case(me) {
            // The first look only records where things stand.
            let looked = known.is_some();
            // Threads list comments by thread, not by id: each is held against where the
            // last look stood, and the new watermarks are taken after.
            let seen = (next.seen_review, next.seen_comment, next.seen_conversation);
            let by_me = |n: &Value| s(&n["author"], "login").eq_ignore_ascii_case(me);
            for n in &nodes(&pull["reviews"]) {
                let id = database_id(n).unwrap_or(0);
                let state = s(n, "state");
                // A comment-only review without words holds inline comments,
                // which come separately.
                if looked
                    && id > seen.0
                    && !by_me(n)
                    && RESPONSES.contains(&state.as_str())
                    && !(state == "COMMENTED" && s(n, "body").trim().is_empty())
                {
                    items.push(activity("review", n, state));
                }
                next.seen_review = next.seen_review.max(id);
            }
            for n in &nodes(&pull["reviewThreads"])
                .iter()
                .flat_map(|t| nodes(&t["comments"]))
                .collect::<Vec<_>>()
            {
                let id = database_id(n).unwrap_or(0);
                if looked && id > seen.1 && !by_me(n) {
                    let mut item = activity("comment", n, String::new());
                    item.path = n["path"].as_str().map(str::to_string);
                    item.line = n["line"].as_u64().or_else(|| n["originalLine"].as_u64());
                    items.push(item);
                }
                next.seen_comment = next.seen_comment.max(id);
            }
            for n in &nodes(&pull["comments"]) {
                let id = database_id(n).unwrap_or(0);
                let bot = n["author"]["__typename"] == "Bot"
                    || s(&n["author"], "login").ends_with("[bot]");
                if looked && id > seen.2 && !by_me(n) && !bot {
                    items.push(activity("conversation", n, String::new()));
                }
                next.seen_conversation = next.seen_conversation.max(id);
            }
        }
        self.store
            .save_feature_record(NAMESPACE, &next.id, &serde_json::to_string(&next)?)?;
        let updated = DateTime::parse_from_rfc3339(&s(pull, "updatedAt"))
            .map_or(read.at, |t| t.with_timezone(&Utc));
        self.reads
            .lock()
            .insert(next.id.clone(), (read.at, updated));
        self.follows.lock().insert(next.id.clone(), next);
        if items.is_empty() {
            return Ok(None);
        }
        items.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.id.cmp(&b.id)));
        Ok(Some(PrActivity {
            repo: repo.into(),
            number,
            title: s(pull, "title"),
            url: s(pull, "url"),
            items,
        }))
    }
}

fn nodes(conn: &Value) -> Vec<Value> {
    conn["nodes"].as_array().cloned().unwrap_or_default()
}

fn activity(kind: &str, n: &Value, state: String) -> Activity {
    Activity {
        kind: kind.into(),
        id: database_id(n).unwrap_or(0),
        author: s(&n["author"], "login"),
        state,
        body: s(n, "body"),
        url: s(n, "url"),
        path: None,
        line: None,
    }
}

/// The session that takes a PR's activity, so it goes to one session only:
/// of the sessions that follow it (linked to it or on its branch alike, all
/// unarchived), skip workers whose orchestrator follows it too (the
/// orchestrator decides), then take the one active last.
fn target(linking: &[Session]) -> Option<&Session> {
    let ids: HashSet<&str> = linking.iter().map(|s| s.id.as_str()).collect();
    linking
        .iter()
        .filter(|s| {
            !s.orchestrator_id
                .as_deref()
                .is_some_and(|o| ids.contains(o))
        })
        .max_by_key(|s| s.last_activity)
}

fn setting(store: &dyn Store, key: String) -> Value {
    store
        .get_setting(&key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

/// Whether review activity may go to the session: the user can turn it off
/// per session in the app's links dialog.
pub fn follows_reviews(store: &dyn Store, session: &str) -> bool {
    setting(store, format!("{LINKS_KEY}{session}"))["reviews"] != false
}

/// The PRs whose activity may go to a session, unless the user turned
/// follow-ups off for it: the ones it is linked to, and the ones opened from
/// its branch, which is usually where the session wrote the code.
pub fn followed_prs(store: &dyn Store, session: &Session) -> Vec<(String, u32)> {
    if !follows_reviews(store, &session.id) {
        return vec![];
    }
    let mut out = linked_prs(store, &session.id);
    for (repo, number) in session.pulls.iter().filter_map(|url| parse_pr_url(url)) {
        if !out
            .iter()
            .any(|(r, n)| r.eq_ignore_ascii_case(&repo) && *n == number)
        {
            out.push((repo, number));
        }
    }
    out
}

/// The PRs a session is linked to, unless the user turned follow-ups off for
/// it: the links the user chose, else the ones detected in the conversation.
pub fn linked_prs(store: &dyn Store, session: &str) -> Vec<(String, u32)> {
    if setting(store, format!("{LINKS_KEY}{session}"))["reviews"] == false {
        return vec![];
    }
    session_prs(store, session)
}

/// The PRs a session is linked to: the links the user chose, else the ones
/// detected in the conversation.
pub fn session_prs(store: &dyn Store, session: &str) -> Vec<(String, u32)> {
    let read = |key: String| setting(store, key);
    let prefs = read(format!("{LINKS_KEY}{session}"));
    let urls: Vec<Value> = if let Some(list) = prefs["prs"].as_array() {
        list.clone()
    } else if prefs.get("pr").is_some() {
        // The older one-PR form; null meant none.
        vec![prefs["pr"].clone()]
    } else {
        read(format!("{DETECTED_KEY}{session}"))
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let mut out: Vec<(String, u32)> = vec![];
    for url in urls.iter().filter_map(Value::as_str) {
        if let Some((repo, number)) = parse_pr_url(url) {
            if !out
                .iter()
                .any(|(r, n)| r.eq_ignore_ascii_case(&repo) && *n == number)
            {
                out.push((repo, number));
            }
        }
    }
    out
}

fn parse_pr_url(url: &str) -> Option<(String, u32)> {
    let path = url.trim().strip_prefix("https://github.com/")?;
    let mut parts = path.split('/');
    let (owner, name, kind, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if kind != "pull" {
        return None;
    }
    let repo = format!("{owner}/{name}");
    validate_repo(&repo).ok()?;
    let number: u32 = number.parse().ok().filter(|n| *n > 0)?;
    Some((repo, number))
}

/// The cut-off end of a long body is marked so the agent knows to look.
fn clip(body: &str) -> String {
    let body = body.trim();
    if body.len() <= BODY_LIMIT {
        return body.to_string();
    }
    let mut end = BODY_LIMIT;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (cut; read the rest on GitHub)", &body[..end])
}

/// The message a session gets about new review activity on its PRs.
pub fn hand_over_message(prs: &[PrActivity], orchestrator: bool) -> String {
    let mut out = prompts::aura_header("New review activity on your pull request");
    for pr in prs {
        out.push_str(&format!(
            "\n## {}#{} {}\n{}\n",
            pr.repo, pr.number, pr.title, pr.url
        ));
        for item in &pr.items {
            let what = match (item.kind.as_str(), item.state.as_str()) {
                ("review", "APPROVED") => "approved".to_string(),
                ("review", "CHANGES_REQUESTED") => "requested changes".to_string(),
                ("review", _) => "reviewed".to_string(),
                ("comment", _) => match (&item.path, item.line) {
                    (Some(path), Some(line)) => format!("commented on `{path}` line {line}"),
                    (Some(path), None) => format!("commented on `{path}`"),
                    _ => "commented on the diff".to_string(),
                },
                _ => "commented".to_string(),
            };
            out.push_str(&format!("\n### {} {what}\n{}\n", item.author, item.url));
            let body = clip(&item.body);
            if !body.is_empty() {
                out.push_str(&format!("{body}\n"));
            }
        }
    }
    out.push_str(
        "\nGo through each point. Where a change is needed, make it, commit it and push it to the PR's branch. \
         Where you disagree, or a point needs the user's decision, leave the code alone and say why. \
         Do not post on GitHub unless the user asked you to. \
         End with a short summary for the user: what you changed, and what is left for them.",
    );
    if orchestrator {
        out.push_str(" If one of your workers owns this PR, you can hand the work to it.");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;
    use async_trait::async_trait;

    /// Answers GitHub as of its lists, for `o/r#1`: reviews, inline comments (one thread) and
    /// conversation comments, as GraphQL nodes.
    #[derive(Default)]
    struct Fake {
        reviews: Mutex<Vec<Value>>,
        comments: Mutex<Vec<Value>>,
        conversation: Mutex<Vec<Value>>,
        author: Mutex<String>,
        /// The branches whose PR was asked for.
        heads: Mutex<Vec<String>>,
        /// Batched activity reads so far.
        reads: Mutex<usize>,
        blocked: Mutex<Option<String>>,
        /// Inline comments in further threads.
        threads: Mutex<Vec<Vec<Value>>>,
        /// OPEN when empty.
        state: Mutex<String>,
    }
    fn row(id: u64, login: &str, body: &str) -> Value {
        json!({"fullDatabaseId": id.to_string(), "author": {"login": login, "__typename": if login.ends_with("[bot]") { "Bot" } else { "User" }}, "body": body, "url": format!("https://github.com/o/r/pull/1#x-{id}")})
    }
    fn conn(nodes: Vec<Value>) -> Value {
        json!({"pageInfo": {"hasPreviousPage": false, "hasNextPage": false}, "nodes": nodes})
    }
    #[async_trait]
    impl Github for Fake {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
            let author = self.author.lock().clone();
            match (method, path) {
                ("POST", "graphql") => {
                    let body = body.unwrap_or_default();
                    if body["query"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("pr0:pullRequest(number:1)")
                    {
                        *self.reads.lock() += 1;
                        let state = self.state.lock().clone();
                        let mut threads = vec![
                            json!({"id": "T1", "comments": conn(self.comments.lock().clone())}),
                        ];
                        for (i, comments) in self.threads.lock().iter().enumerate() {
                            threads.push(json!({"id": format!("T{}", i + 2), "comments": conn(comments.clone())}));
                        }
                        let pull = json!({"id": "PR_1", "number": 1, "title": "PR", "url": "https://github.com/o/r/pull/1",
                            "state": if state.is_empty() { "OPEN" } else { &state },
                            "author": {"login": if author.is_empty() { "me" } else { &author }},
                            "reviews": conn(self.reviews.lock().clone()),
                            "comments": conn(self.conversation.lock().clone()),
                            "reviewThreads": conn(threads)});
                        return Ok(json!({"data": {"r0": {"pr0": pull}}}));
                    }
                    let head = body["variables"]["head"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    self.heads.lock().push(head.clone());
                    let nodes = if head == "feature" {
                        vec![
                            json!({"number": 1, "title": "PR", "url": "https://github.com/o/r/pull/1", "state": "OPEN",
                            "isDraft": false, "reviewDecision": "", "headRefOid": "abc", "author": {"login": "me"},
                            "headRepository": {"nameWithOwner": "o/r"}, "commits": {"nodes": []}}),
                        ]
                    } else {
                        vec![]
                    };
                    Ok(json!({"data": {"repository": {"pullRequests": {"nodes": nodes}}}}))
                }
                ("GET", "user") => Ok(json!({"login": "me"})),
                _ => bail!("Unexpected request {method} {path}"),
            }
        }
        async fn request_for(
            &self,
            _: &str,
            method: &str,
            path: &str,
            body: Option<Value>,
        ) -> Result<Value> {
            self.request(method, path, body).await
        }
        async fn blocked(&self) -> Option<String> {
            self.blocked.lock().clone()
        }
    }

    fn review(id: u64, login: &str, state: &str, body: &str) -> Value {
        let mut r = row(id, login, body);
        r["state"] = json!(state);
        r
    }

    /// Check `o/r#1` once.
    async fn check(svc: &FollowService, known: Option<Followed>) -> Option<PrActivity> {
        svc.check(&[("o/r".into(), 1, known)], "me")
            .await
            .unwrap()
            .remove(0)
            .unwrap()
    }

    fn session(id: &str, orchestrator_id: Option<&str>, minutes: u64) -> Session {
        let mut s = Session::new(&CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/tmp".into(),
            ..Default::default()
        });
        s.id = id.into();
        s.orchestrator_id = orchestrator_id.map(str::to_string);
        s.last_activity += std::time::Duration::from_secs(minutes * 60);
        s
    }

    #[test]
    fn orchestrators_take_over_from_their_workers_and_the_latest_session_wins() {
        let lead = session("lead", None, 1);
        let worker = session("worker", Some("lead"), 5);
        assert_eq!(target(&[worker.clone(), lead.clone()]).unwrap().id, "lead");
        let other = session("other", None, 9);
        assert_eq!(target(&[worker.clone(), other]).unwrap().id, "other");
        assert_eq!(target(&[worker]).unwrap().id, "worker");
    }

    #[test]
    fn a_session_follows_its_links_and_its_branch_pulls_unless_turned_off() {
        let store = MemoryStore::default();
        let mut s = session("a", None, 0);
        s.pulls = vec![
            "https://github.com/O/R/pull/3".into(),
            "https://github.com/o/r/pull/8".into(),
        ];
        store
            .set_setting(
                &format!("{LINKS_KEY}a"),
                r#"{"prs":["https://github.com/o/r/pull/3"]}"#,
            )
            .unwrap();
        assert_eq!(
            followed_prs(&store, &s),
            vec![("o/r".to_string(), 3), ("o/r".to_string(), 8)]
        );
        store
            .set_setting(&format!("{LINKS_KEY}a"), r#"{"prs":[],"reviews":false}"#)
            .unwrap();
        assert!(followed_prs(&store, &s).is_empty(), "follow-ups turned off");
        assert!(!follows_reviews(&store, "a"));
        assert!(follows_reviews(&store, "b"));
    }

    #[test]
    fn a_session_on_the_branch_and_a_linked_one_get_the_same_rule() {
        // The worker wrote the code on the PR's branch; its orchestrator links the PR.
        let lead = session("lead", None, 1);
        let mut worker = session("worker", Some("lead"), 5);
        worker.pulls = vec!["https://github.com/o/r/pull/1".into()];
        assert_eq!(target(&[worker.clone(), lead]).unwrap().id, "lead");
        let linked = session("linked", None, 2);
        assert_eq!(target(&[worker, linked]).unwrap().id, "worker");
    }

    #[test]
    fn links_come_from_the_chosen_list_else_the_detected_ones() {
        let store = MemoryStore::default();
        store
            .set_setting(
                &format!("{DETECTED_KEY}a"),
                r#"["https://github.com/o/r/issues/2","https://github.com/o/r/pull/3"]"#,
            )
            .unwrap();
        assert_eq!(linked_prs(&store, "a"), vec![("o/r".to_string(), 3)]);
        store.set_setting(&format!("{LINKS_KEY}a"), r#"{"prs":["https://github.com/o/r/pull/4","https://github.com/O/R/pull/4","https://github.com/x/y/pull/5"]}"#).unwrap();
        assert_eq!(
            linked_prs(&store, "a"),
            vec![("o/r".to_string(), 4), ("x/y".to_string(), 5)]
        );
        store
            .set_setting(&format!("{LINKS_KEY}a"), r#"{"pr":null}"#)
            .unwrap();
        assert!(linked_prs(&store, "a").is_empty(), "the older form's None");
        store
            .set_setting(
                &format!("{LINKS_KEY}a"),
                r#"{"pr":"https://github.com/o/r/pull/6"}"#,
            )
            .unwrap();
        assert_eq!(linked_prs(&store, "a"), vec![("o/r".to_string(), 6)]);
        store
            .set_setting(
                &format!("{LINKS_KEY}a"),
                r#"{"prs":["https://github.com/o/r/pull/4"],"reviews":false}"#,
            )
            .unwrap();
        assert!(linked_prs(&store, "a").is_empty(), "follow-ups turned off");
        assert_eq!(parse_pr_url("https://github.com/../x/pull/1"), None);
    }

    #[tokio::test]
    async fn new_activity_is_collected_after_the_first_look() {
        let gh = Arc::new(Fake::default());
        gh.reviews
            .lock()
            .push(review(1, "alice", "CHANGES_REQUESTED", "old"));
        let (events, _rx) = broadcast::channel(16);
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![], None);
        let svc = FollowService::new(store, gh.clone(), manager, events).unwrap();
        assert!(
            check(&svc, None).await.is_none(),
            "the first look is history"
        );
        let known = svc.follows.lock().get("o/r#1").cloned();

        gh.reviews.lock().extend([
            review(2, "alice", "CHANGES_REQUESTED", "Rename this"),
            review(3, "alice", "COMMENTED", ""),
            review(4, "me", "COMMENTED", "Done"),
            review(5, "bob", "APPROVED", ""),
        ]);
        let mut inline = row(10, "alice", "Typo");
        inline["path"] = json!("src/a.rs");
        inline["line"] = json!(7);
        gh.comments.lock().extend([inline, row(11, "me", "Fixed")]);
        gh.conversation.lock().extend([
            row(20, "carol", "Any news?"),
            row(21, "ci[bot]", "Coverage 80%"),
        ]);

        let got = check(&svc, known).await.unwrap();
        let summary: Vec<(&str, &str, &str)> = got
            .items
            .iter()
            .map(|i| (i.kind.as_str(), i.author.as_str(), i.state.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("comment", "alice", ""),
                ("conversation", "carol", ""),
                ("review", "alice", "CHANGES_REQUESTED"),
                ("review", "bob", "APPROVED"),
            ]
        );
        assert!(!got.items[3].actionable() && got.items[0].actionable());
        let text = hand_over_message(&[got], false);
        assert!(
            text.contains("alice commented on `src/a.rs` line 7") && text.contains("Rename this"),
            "{text}"
        );

        let known = svc.follows.lock().get("o/r#1").cloned();
        assert!(
            check(&svc, known).await.is_none(),
            "nothing is reported twice"
        );
    }

    #[tokio::test]
    async fn prs_by_someone_else_are_not_followed() {
        let gh = Arc::new(Fake::default());
        *gh.author.lock() = "alice".into();
        let (events, _rx) = broadcast::channel(16);
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![], None);
        let svc = FollowService::new(store, gh.clone(), manager, events).unwrap();
        check(&svc, None).await;
        let known = svc.follows.lock().get("o/r#1").cloned().unwrap();
        assert_eq!(known.author, "alice");
        gh.conversation.lock().push(row(1, "bob", "Hi"));
        assert!(check(&svc, Some(known)).await.is_none());
    }

    /// An agent that answers every message with "Fixed it".
    struct Agent(Arc<Mutex<Vec<String>>>);
    struct AgentDriver {
        sink: EventSink,
        id: String,
        sent: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait]
    impl Driver for AgentDriver {
        async fn send(&self, input: Input) -> Result<()> {
            self.sent.lock().push(input.text.clone());
            let turn = Turn {
                id: new_id(),
                session_id: self.id.clone(),
                status: TurnStatus::Running,
                started_at: now(),
                ended_at: None,
                usage: None,
                error: None,
            };
            let _ = self.sink.send(Event::TurnStarted {
                session_id: self.id.clone(),
                turn: turn.clone(),
            });
            for (kind, text) in [
                (ItemKind::UserMessage, input.text.as_str()),
                (ItemKind::AgentMessage, "Fixed it"),
            ] {
                let item = Item::new(&self.id, Some(turn.id.clone()), kind)
                    .with_text(text.to_string())
                    .completed();
                let _ = self.sink.send(Event::ItemCompleted {
                    session_id: self.id.clone(),
                    item,
                });
            }
            let _ = self.sink.send(Event::TurnCompleted {
                session_id: self.id.clone(),
                turn: Turn {
                    status: TurnStatus::Completed,
                    ended_at: Some(now()),
                    ..turn
                },
            });
            Ok(())
        }
        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }
        async fn respond_approval(&self, _: &str, _: ApprovalDecision) -> Result<()> {
            Ok(())
        }
        async fn respond_input(&self, _: UserInputResponse) -> Result<()> {
            Ok(())
        }
        async fn set(&self, _: Setting) -> Result<()> {
            Ok(())
        }
        async fn stop(&self) -> Result<()> {
            Ok(())
        }
    }
    #[async_trait]
    impl Provider for Agent {
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
        async fn list_native(&self) -> Result<Vec<NativeSession>> {
            Ok(vec![])
        }
        async fn start(
            &self,
            session: &Session,
            _: bool,
            sink: EventSink,
        ) -> Result<Box<dyn Driver>> {
            Ok(Box::new(AgentDriver {
                sink,
                id: session.id.clone(),
                sent: self.0.clone(),
            }))
        }
        fn terminal_command(&self, _: &Session) -> Vec<String> {
            vec![]
        }
    }

    #[tokio::test]
    async fn activity_goes_to_the_linked_session_and_the_user_hears_how_it_went() {
        let gh = Arc::new(Fake::default());
        let sent = Arc::new(Mutex::new(vec![]));
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![Arc::new(Agent(sent.clone()))], None);
        let dir = tempfile::tempdir().unwrap();
        let s = manager
            .create_session(CreateSessionOpts {
                provider: ProviderKind::Claude,
                cwd: dir.path().to_string_lossy().to_string(),
                title: Some("Feature".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        store
            .set_setting(
                &format!("{LINKS_KEY}{}", s.id),
                r#"{"prs":["https://github.com/o/r/pull/1"]}"#,
            )
            .unwrap();
        let (events, mut rx) = broadcast::channel(64);
        let svc = FollowService::new(store, gh.clone(), manager, events).unwrap();
        svc.listen();
        svc.poll().await;
        assert!(sent.lock().is_empty(), "the first look hands nothing over");

        gh.reviews
            .lock()
            .push(review(2, "alice", "CHANGES_REQUESTED", "Rename this"));
        svc.poll().await;
        let mut seen = vec![];
        let handled = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let v = rx.recv().await.unwrap();
                seen.push(v["method"].as_str().unwrap_or_default().to_string());
                if v["method"] == "follows.handled" {
                    break v;
                }
            }
        })
        .await
        .expect("the session's turn ends and the user is told");
        assert_eq!(
            seen,
            vec!["follows.activity", "follows.started", "follows.handled"]
        );
        assert_eq!(handled["params"]["session"]["title"], "Feature");
        assert_eq!(handled["params"]["status"], "completed");
        assert_eq!(handled["params"]["reply"], "Fixed it");
        assert_eq!(handled["params"]["prs"][0]["number"], 1);
        let sent = sent.lock().clone();
        assert_eq!(sent.len(), 1);
        assert!(
            sent[0].starts_with("[Aura] New review activity") && sent[0].contains("Rename this"),
            "{}",
            sent[0]
        );
    }

    #[tokio::test]
    async fn activity_reaches_the_session_on_the_branch_and_skips_archived_and_muted_ones() {
        let gh = Arc::new(Fake::default());
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(
            store.clone(),
            vec![Arc::new(Agent(Default::default()))],
            None,
        );
        // A worktree whose remote is o/r, on the PR's branch; another whose branch has no PR.
        let repo = |name: &str| {
            let dir = tempfile::tempdir().unwrap();
            let git = |args: &[&str]| {
                assert!(std::process::Command::new("git")
                    .args(args)
                    .current_dir(dir.path())
                    .output()
                    .unwrap()
                    .status
                    .success());
            };
            git(&["init", "-q", "-b", name]);
            git(&["remote", "add", "origin", "https://github.com/o/r.git"]);
            dir
        };
        let (feature, other) = (repo("feature"), repo("other"));
        let stored = |id: &str,
                      minutes: u64,
                      dir: Option<(&tempfile::TempDir, &str)>,
                      pulls: &[&str],
                      archived: bool| {
            let mut s = session(id, None, minutes);
            if let Some((dir, branch)) = dir {
                s.cwd = dir.path().to_string_lossy().to_string();
                s.worktree = Some(WorktreeInfo {
                    repo_root: s.cwd.clone(),
                    path: s.cwd.clone(),
                    branch: branch.into(),
                });
            }
            s.pulls = pulls.iter().map(|p| p.to_string()).collect();
            s.archived = archived;
            store.upsert_session(&s).unwrap();
        };
        let url = "https://github.com/o/r/pull/1";
        stored("coder", 1, Some((&feature, "feature")), &[], false);
        stored("idle-worktree", 1, Some((&other, "other")), &[], false);
        stored("old", 30, None, &[url], true);
        stored("muted", 20, None, &[url], false);
        store
            .set_setting(&format!("{LINKS_KEY}muted"), r#"{"reviews":false}"#)
            .unwrap();
        manager.restore().unwrap();
        let (events, mut rx) = broadcast::channel(64);
        let svc = FollowService::new(store, gh.clone(), manager.clone(), events).unwrap();

        svc.poll().await;
        assert_eq!(
            manager.get_session("coder").unwrap().pulls,
            vec![url],
            "the worktree's PR is recorded"
        );
        gh.reviews
            .lock()
            .push(review(2, "alice", "CHANGES_REQUESTED", "Rename this"));
        svc.poll().await;
        let activity = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let v = rx.recv().await.unwrap();
                if v["method"] == "follows.activity" {
                    break v;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(activity["params"]["session"]["id"], "coder");
        // The PR was found once; the branch without one waits before it is asked again.
        assert_eq!(gh.heads.lock().clone(), vec!["feature", "other"]);
    }

    /// What this service found with GitHub's REST lists, before it read GraphQL.
    fn rest_items(
        reviews: &[Value],
        comments: &[Value],
        conversation: &[Value],
        seen: (u64, u64, u64),
        me: &str,
    ) -> Vec<Activity> {
        let by_me = |row: &Value| s(&row["user"], "login").eq_ignore_ascii_case(me);
        let item = |kind: &str, row: &Value, state: String| Activity {
            kind: kind.into(),
            id: row["id"].as_u64().unwrap_or(0),
            author: s(&row["user"], "login"),
            state,
            body: s(row, "body"),
            url: s(row, "html_url"),
            path: None,
            line: None,
        };
        let mut items = vec![];
        for row in reviews {
            let id = row["id"].as_u64().unwrap_or(0);
            let state = s(row, "state");
            if id > seen.0
                && !by_me(row)
                && RESPONSES.contains(&state.as_str())
                && !(state == "COMMENTED" && s(row, "body").trim().is_empty())
            {
                items.push(item("review", row, state));
            }
        }
        for row in comments {
            if row["id"].as_u64().unwrap_or(0) > seen.1 && !by_me(row) {
                let mut i = item("comment", row, String::new());
                i.path = row["path"].as_str().map(str::to_string);
                i.line = row["line"]
                    .as_u64()
                    .or_else(|| row["original_line"].as_u64());
                items.push(i);
            }
        }
        for row in conversation {
            let bot = row["user"]["type"] == "Bot" || s(&row["user"], "login").ends_with("[bot]");
            if row["id"].as_u64().unwrap_or(0) > seen.2 && !by_me(row) && !bot {
                items.push(item("conversation", row, String::new()));
            }
        }
        items.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.id.cmp(&b.id)));
        items
    }

    #[tokio::test]
    async fn graphql_finds_what_the_rest_lists_found() {
        // kind, id, author (None: a deleted account), bot, state, body, path, line, original line
        type Entry = (
            &'static str,
            u64,
            Option<&'static str>,
            bool,
            &'static str,
            &'static str,
            Option<&'static str>,
            Option<u64>,
            Option<u64>,
        );
        let big = 6_310_081_535;
        let fixture: Vec<Entry> = vec![
            (
                "review",
                100,
                Some("alice"),
                false,
                "CHANGES_REQUESTED",
                "old",
                None,
                None,
                None,
            ),
            (
                "comment",
                200,
                Some("alice"),
                false,
                "",
                "old",
                Some("a.rs"),
                Some(1),
                Some(1),
            ),
            (
                "conversation",
                300,
                Some("carol"),
                false,
                "",
                "old",
                None,
                None,
                None,
            ),
            // After the first look:
            (
                "review",
                101,
                Some("alice"),
                false,
                "CHANGES_REQUESTED",
                "Rename",
                None,
                None,
                None,
            ),
            (
                "review",
                102,
                Some("alice"),
                false,
                "COMMENTED",
                " ",
                None,
                None,
                None,
            ),
            (
                "review",
                103,
                Some("copilot"),
                true,
                "COMMENTED",
                "Bot says",
                None,
                None,
                None,
            ),
            (
                "review",
                104,
                Some("me"),
                false,
                "COMMENTED",
                "Mine",
                None,
                None,
                None,
            ),
            (
                "review",
                105,
                Some("bob"),
                false,
                "DISMISSED",
                "x",
                None,
                None,
                None,
            ),
            (
                "review",
                106,
                Some("bob"),
                false,
                "APPROVED",
                "",
                None,
                None,
                None,
            ),
            (
                "review",
                big,
                None,
                false,
                "COMMENTED",
                "Ghost",
                None,
                None,
                None,
            ),
            (
                "comment",
                201,
                Some("alice"),
                false,
                "",
                "Typo",
                Some("a.rs"),
                Some(7),
                Some(5),
            ),
            (
                "comment",
                202,
                Some("dave"),
                false,
                "",
                "Outdated",
                Some("b.rs"),
                None,
                Some(12),
            ),
            (
                "comment",
                203,
                Some("me"),
                false,
                "",
                "Fixed",
                Some("a.rs"),
                Some(7),
                Some(5),
            ),
            (
                "comment",
                big + 1,
                Some("ci[bot]"),
                true,
                "",
                "Lint",
                None,
                None,
                None,
            ),
            (
                "conversation",
                301,
                Some("carol"),
                false,
                "",
                "Any news?",
                None,
                None,
                None,
            ),
            (
                "conversation",
                302,
                Some("cov"),
                true,
                "",
                "Coverage",
                None,
                None,
                None,
            ),
            (
                "conversation",
                303,
                Some("ci[bot]"),
                false,
                "",
                "Build",
                None,
                None,
                None,
            ),
            (
                "conversation",
                big + 2,
                Some("Me"),
                false,
                "",
                "Done",
                None,
                None,
                None,
            ),
        ];
        let rest = |e: &Entry| {
            let user =
                e.2.map(|login| json!({"login": login, "type": if e.3 { "Bot" } else { "User" }}));
            json!({"id": e.1, "user": user, "state": e.4, "body": e.5, "html_url": format!("https://github.com/o/r/pull/1#x-{}", e.1),
                "path": e.6, "line": e.7, "original_line": e.8})
        };
        let graphql = |e: &Entry| {
            let author = e.2.map(
                |login| json!({"login": login, "__typename": if e.3 { "Bot" } else { "User" }}),
            );
            json!({"fullDatabaseId": e.1.to_string(), "author": author, "state": e.4, "body": e.5, "url": format!("https://github.com/o/r/pull/1#x-{}", e.1),
                "path": e.6, "line": e.7, "originalLine": e.8})
        };
        let of = |entries: &[Entry], kind: &str, to: &dyn Fn(&Entry) -> Value| -> Vec<Value> {
            entries.iter().filter(|e| e.0 == kind).map(to).collect()
        };

        let gh = Arc::new(Fake::default());
        let (events, _rx) = broadcast::channel(16);
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let svc = FollowService::new(
            store.clone(),
            gh.clone(),
            Manager::new(store, vec![], None),
            events,
        )
        .unwrap();
        let fill = |entries: &[Entry]| {
            *gh.reviews.lock() = of(entries, "review", &graphql);
            *gh.comments.lock() = of(entries, "comment", &graphql);
            *gh.conversation.lock() = of(entries, "conversation", &graphql);
        };
        fill(&fixture[..3]);
        assert!(check(&svc, None).await.is_none());
        let known = svc.follows.lock().get("o/r#1").cloned().unwrap();
        assert_eq!(
            (
                known.seen_review,
                known.seen_comment,
                known.seen_conversation
            ),
            (100, 200, 300),
            "the same ids REST gave, so stored follow-ups carry on"
        );

        fill(&fixture);
        let got = check(&svc, Some(known.clone())).await.unwrap();
        let expected = rest_items(
            &of(&fixture, "review", &rest),
            &of(&fixture, "comment", &rest),
            &of(&fixture, "conversation", &rest),
            (
                known.seen_review,
                known.seen_comment,
                known.seen_conversation,
            ),
            "me",
        );
        assert_eq!(got.items, expected);
        assert_eq!(
            got.items
                .iter()
                .map(|i| (i.kind.as_str(), i.id))
                .collect::<Vec<_>>(),
            vec![
                ("comment", 201),
                ("comment", 202),
                ("comment", big + 1),
                ("conversation", 301),
                ("review", 101),
                ("review", 103),
                ("review", 106),
                ("review", big)
            ],
        );
        let seen = svc.follows.lock().get("o/r#1").cloned().unwrap();
        assert_eq!(
            (seen.seen_review, seen.seen_comment, seen.seen_conversation),
            (big, big + 1, big + 2)
        );
        assert_eq!(
            (got.title.as_str(), got.url.as_str()),
            ("PR", "https://github.com/o/r/pull/1")
        );
    }

    #[tokio::test]
    async fn an_expired_login_stops_the_reads_until_it_works_again() {
        let gh = Arc::new(Fake::default());
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![], None);
        let mut s = session("a", None, 0);
        s.pulls = vec!["https://github.com/o/r/pull/1".into()];
        store.upsert_session(&s).unwrap();
        manager.restore().unwrap();
        let (events, _rx) = broadcast::channel(16);
        let svc = FollowService::new(store, gh.clone(), manager, events).unwrap();
        *gh.blocked.lock() = Some(aura_github::LOGIN_EXPIRED.into());
        svc.poll().await;
        svc.poll().await;
        assert_eq!(*gh.reads.lock(), 0, "nothing is asked of GitHub");
        *gh.blocked.lock() = None;
        svc.poll().await;
        assert_eq!(*gh.reads.lock(), 1, "polling resumes by itself");
    }

    fn service_for(gh: Arc<Fake>) -> Arc<FollowService> {
        let (events, _rx) = broadcast::channel(64);
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![], None);
        FollowService::new(store, gh, manager, events).unwrap()
    }

    #[tokio::test]
    async fn replies_in_different_threads_are_each_new() {
        let gh = Arc::new(Fake::default());
        let svc = service_for(gh.clone());
        let comment = |id, body| {
            let mut c = row(id, "alice", body);
            c["path"] = json!("a.rs");
            c
        };
        *gh.comments.lock() = vec![comment(10, "A")];
        *gh.threads.lock() = vec![vec![comment(20, "B")]];
        check(&svc, None).await;
        let known = svc.follows.lock().get("o/r#1").cloned();
        // A reply in the first thread is newer than one in the second, which comes later.
        gh.comments.lock().push(comment(40, "A again"));
        gh.threads.lock()[0].push(comment(30, "B again"));
        let got = check(&svc, known).await.unwrap();
        assert_eq!(
            got.items.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![30, 40]
        );
        assert_eq!(svc.follows.lock()["o/r#1"].seen_comment, 40);
    }

    #[tokio::test]
    async fn a_read_with_a_gap_records_nothing() {
        let gh = Arc::new(Fake::default());
        let svc = service_for(gh.clone());
        *gh.conversation.lock() = vec![row(5, "carol", "Hi")];
        check(&svc, None).await;
        let known = svc.follows.lock().get("o/r#1").cloned();
        // GitHub left a comment out of the list, and a later one in.
        gh.conversation
            .lock()
            .extend([Value::Null, row(7, "carol", "Later")]);
        let checked = svc
            .check(&[("o/r".into(), 1, known.clone())], "me")
            .await
            .unwrap()
            .remove(0);
        assert!(checked.is_err());
        assert_eq!(
            svc.follows.lock()["o/r#1"].seen_conversation,
            5,
            "the next read still finds the missing one"
        );
        gh.conversation.lock().retain(|c| !c.is_null());
        gh.conversation.lock().insert(1, row(6, "carol", "Missing"));
        let got = check(&svc, known).await.unwrap();
        assert_eq!(
            got.items.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![6, 7]
        );
    }

    #[tokio::test]
    async fn a_closed_pr_is_looked_at_now_and_then_and_a_merged_one_no_more() {
        let gh = Arc::new(Fake::default());
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let manager = Manager::new(store.clone(), vec![], None);
        let mut s = session("a", None, 0);
        s.pulls = vec!["https://github.com/o/r/pull/1".into()];
        store.upsert_session(&s).unwrap();
        manager.restore().unwrap();
        let (events, mut rx) = broadcast::channel(64);
        let svc = FollowService::new(store, gh.clone(), manager, events).unwrap();
        let reads = || *gh.reads.lock();
        let age = || {
            for read in svc.reads.lock().values_mut() {
                read.0 -= chrono::Duration::minutes(31);
            }
        };
        svc.poll().await;
        *gh.state.lock() = "CLOSED".into();
        age();
        svc.poll().await;
        assert_eq!(reads(), 2);
        assert!(!svc.follows.lock()["o/r#1"].open);
        svc.poll().await;
        assert_eq!(reads(), 2, "a closed PR is not read every pass");

        *gh.state.lock() = "OPEN".into();
        gh.reviews.lock().push(review(
            9,
            "alice",
            "CHANGES_REQUESTED",
            "Reopened; fix this",
        ));
        age();
        svc.poll().await;
        assert_eq!(reads(), 3);
        let found =
            std::iter::from_fn(|| rx.try_recv().ok()).any(|v| v["method"] == "follows.activity");
        assert!(found, "activity after a reopen is found");

        *gh.state.lock() = "MERGED".into();
        age();
        svc.poll().await;
        assert!(svc.follows.lock()["o/r#1"].merged);
        age();
        svc.poll().await;
        assert_eq!(reads(), 4, "a merged PR is not read again");
    }

    fn pr(items: Vec<Activity>) -> PrActivity {
        PrActivity {
            repo: "o/r".into(),
            number: 1,
            title: "PR".into(),
            url: String::new(),
            items,
        }
    }

    #[test]
    fn items_added_while_sending_stay_queued() {
        let item = |id| activity("comment", &row(id, "alice", "x"), String::new());
        let sent = vec![pr(vec![item(1)])];
        let mut queue = vec![pr(vec![item(1), item(2)])];
        remove_items(&mut queue, &sent);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].items, vec![item(2)]);
        remove_items(&mut queue, &[pr(vec![item(2)])]);
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn queued_activity_survives_a_restart() {
        let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
        let start = || {
            let (events, _rx) = broadcast::channel(16);
            let manager = Manager::new(store.clone(), vec![], None);
            FollowService::new(store.clone(), Arc::new(Fake::default()), manager, events).unwrap()
        };
        let item = activity("conversation", &row(5, "bob", "Hi"), String::new());
        start().edit_pending("s", |q| q.push(pr(vec![item.clone()])));
        assert_eq!(start().pending.lock()["s"][0].items, vec![item]);
        let svc = start();
        svc.edit_pending("s", |q| q.clear());
        assert!(start().pending.lock().is_empty());
    }
}
