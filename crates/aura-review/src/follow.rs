//! Review follow-ups: new review activity on a session's pull requests goes to
//! that session's agent, and the user hears about it twice: when it arrives,
//! and when the agent's turn on it ends.
//!
//! Once a minute the daemon reads the PRs each session follows: the ones it
//! is linked to (the links the user chose, else the ones the desktop app
//! detected in the conversation) and the ones opened from its branch
//! (`Session::pulls`; for a worktree the daemon looks its branch's PR up
//! itself). For each open PR the user authored it collects reviews,
//! inline review comments and conversation comments newer than the last look.
//! The first look only records where things stand: older activity is history.
//!
//! Activity by the user's own account is skipped: agents post as the user, so
//! their own replies would otherwise wake them again. Conversation comments by
//! bots are skipped too (CI and coverage reports); reviews by bots count.
use anyhow::Result;
use aura_core::*;
use aura_github::{pages, s, validate_repo, Github};
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
    /// False once merged or closed; it is not looked at again.
    open: bool,
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
        }))
    }

    pub fn launch(self: &Arc<Self>) {
        let svc = self.clone();
        tokio::spawn(async move {
            loop {
                svc.poll().await;
                tokio::time::sleep(crate::watch::POLL_INTERVAL).await;
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
        for (id, (repo, number, linking)) in linked {
            let known = self.follows.lock().get(&id).cloned();
            if known
                .as_ref()
                .is_some_and(|f| !f.open || !f.author.eq_ignore_ascii_case(&me))
            {
                continue;
            }
            let activity = match self.check(&repo, number, known, &me).await {
                Ok(Some(activity)) => activity,
                Ok(None) => continue,
                Err(e) => {
                    tracing::warn!("review follow-up for {id} failed: {e:#}");
                    continue;
                }
            };
            let target =
                target(&linking).filter(|_| activity.items.iter().any(Activity::actionable));
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

    /// New activity on one PR since the last look, recording the look.
    async fn check(
        &self,
        repo: &str,
        number: u32,
        known: Option<Followed>,
        me: &str,
    ) -> Result<Option<PrActivity>> {
        let base = format!("repos/{repo}/pulls/{number}");
        let pull = self.gh.request("GET", &base, None).await?;
        let author = s(&pull["user"], "login");
        let open = s(&pull, "state") == "open" && pull["merged_at"].is_null();
        let mut next = known.clone().unwrap_or(Followed {
            id: pr_id(repo, number),
            repo: repo.into(),
            number,
            author: author.clone(),
            open,
            seen_review: 0,
            seen_comment: 0,
            seen_conversation: 0,
        });
        next.author = author;
        next.open = open;
        let mut items = vec![];
        if open && next.author.eq_ignore_ascii_case(me) {
            let review_path = format!("{base}/reviews");
            let comment_path = format!("{base}/comments");
            let conversation_path = format!("repos/{repo}/issues/{number}/comments");
            let (reviews, comments, conversation) = tokio::join!(
                pages(&*self.gh, &review_path),
                pages(&*self.gh, &comment_path),
                pages(&*self.gh, &conversation_path)
            );
            let (reviews, comments, conversation) = (reviews?, comments?, conversation?);
            // The first look only records where things stand.
            let looked = known.is_some();
            let by_me = |row: &Value| s(&row["user"], "login").eq_ignore_ascii_case(me);
            for row in &reviews {
                let id = row["id"].as_u64().unwrap_or(0);
                let state = s(row, "state");
                // A comment-only review without words holds inline comments,
                // which come separately.
                if looked
                    && id > next.seen_review
                    && !by_me(row)
                    && RESPONSES.contains(&state.as_str())
                    && !(state == "COMMENTED" && s(row, "body").trim().is_empty())
                {
                    items.push(activity("review", row, state));
                }
                next.seen_review = next.seen_review.max(id);
            }
            for row in &comments {
                let id = row["id"].as_u64().unwrap_or(0);
                if looked && id > next.seen_comment && !by_me(row) {
                    let mut item = activity("comment", row, String::new());
                    item.path = row["path"].as_str().map(str::to_string);
                    item.line = row["line"]
                        .as_u64()
                        .or_else(|| row["original_line"].as_u64());
                    items.push(item);
                }
                next.seen_comment = next.seen_comment.max(id);
            }
            for row in &conversation {
                let id = row["id"].as_u64().unwrap_or(0);
                let bot =
                    row["user"]["type"] == "Bot" || s(&row["user"], "login").ends_with("[bot]");
                if looked && id > next.seen_conversation && !by_me(row) && !bot {
                    items.push(activity("conversation", row, String::new()));
                }
                next.seen_conversation = next.seen_conversation.max(id);
            }
        }
        self.store
            .save_feature_record(NAMESPACE, &next.id, &serde_json::to_string(&next)?)?;
        self.follows.lock().insert(next.id.clone(), next);
        if items.is_empty() {
            return Ok(None);
        }
        items.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.id.cmp(&b.id)));
        Ok(Some(PrActivity {
            repo: repo.into(),
            number,
            title: s(&pull, "title"),
            url: s(&pull, "html_url"),
            items,
        }))
    }
}

fn activity(kind: &str, row: &Value, state: String) -> Activity {
    Activity {
        kind: kind.into(),
        id: row["id"].as_u64().unwrap_or(0),
        author: s(&row["user"], "login"),
        state,
        body: s(row, "body"),
        url: s(row, "html_url"),
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

    #[derive(Default)]
    struct Fake {
        reviews: Mutex<Vec<Value>>,
        comments: Mutex<Vec<Value>>,
        conversation: Mutex<Vec<Value>>,
        author: Mutex<String>,
        /// The branches whose PR was asked for.
        heads: Mutex<Vec<String>>,
    }
    fn row(id: u64, login: &str, body: &str) -> Value {
        json!({"id": id, "user": {"login": login, "type": if login.ends_with("[bot]") { "Bot" } else { "User" }}, "body": body, "html_url": format!("https://github.com/o/r/pull/1#x-{id}")})
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
                    let head = body.unwrap_or_default()["variables"]["head"]
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
                ("GET", "repos/o/r/pulls/1") => Ok(
                    json!({"title": "PR", "html_url": "https://github.com/o/r/pull/1", "state": "open", "merged_at": null, "user": {"login": if author.is_empty() { "me" } else { &author }}}),
                ),
                ("GET", p) if p.starts_with("repos/o/r/pulls/1/reviews?") => {
                    Ok(json!(self.reviews.lock().clone()))
                }
                ("GET", p) if p.starts_with("repos/o/r/pulls/1/comments?") => {
                    Ok(json!(self.comments.lock().clone()))
                }
                ("GET", p) if p.starts_with("repos/o/r/issues/1/comments?") => {
                    Ok(json!(self.conversation.lock().clone()))
                }
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
    }

    fn review(id: u64, login: &str, state: &str, body: &str) -> Value {
        let mut r = row(id, login, body);
        r["state"] = json!(state);
        r
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
            svc.check("o/r", 1, None, "me").await.unwrap().is_none(),
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

        let got = svc.check("o/r", 1, known, "me").await.unwrap().unwrap();
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
            svc.check("o/r", 1, known, "me").await.unwrap().is_none(),
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
        svc.check("o/r", 1, None, "me").await.unwrap();
        let known = svc.follows.lock().get("o/r#1").cloned().unwrap();
        assert_eq!(known.author, "alice");
        gh.conversation.lock().push(row(1, "bob", "Hi"));
        assert!(svc
            .check("o/r", 1, Some(known), "me")
            .await
            .unwrap()
            .is_none());
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
