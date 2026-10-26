//! Review watches: the daemon looks at the watched pull requests once a minute
//! and reports every approval, change request and comment-only review by the
//! watched reviewers. Plain GitHub reads, all watches in one GraphQL query, of
//! the PRs that are due (see [`activity::due`]); no agent is involved.
use anyhow::{bail, Context, Result};
use aura_core::*;
use aura_github::{
    activity::{self, Since},
    database_id, pages, s, validate_repo, Github,
};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::broadcast;

const NAMESPACE: &str = "pr-watches";
pub const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Review states that mean a reviewer responded. PENDING is an unsubmitted
/// draft and DISMISSED was withdrawn by someone else.
const RESPONSES: [&str; 3] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];

pub fn watch_id(repo: &str, number: u32) -> String {
    format!("{}#{number}", repo.to_lowercase())
}

pub struct WatchService {
    store: Arc<dyn Store>,
    gh: Arc<dyn Github>,
    watches: Mutex<Vec<PrWatch>>,
    /// Serializes polls so two passes cannot report the same review twice.
    poll_gate: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Value>,
    /// Watch id -> when its PR was last read, and last updated then.
    reads: Mutex<HashMap<String, activity::LastRead>>,
}

impl WatchService {
    pub fn new(
        store: Arc<dyn Store>,
        gh: Arc<dyn Github>,
        events: broadcast::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let watches = store
            .feature_records(NAMESPACE)?
            .into_iter()
            .map(|(_, raw)| serde_json::from_str(&raw))
            .collect::<Result<Vec<PrWatch>, _>>()?;
        Ok(Arc::new(Self {
            store,
            gh,
            watches: Mutex::new(watches),
            poll_gate: tokio::sync::Mutex::new(()),
            events,
            reads: Mutex::new(HashMap::new()),
        }))
    }

    pub fn launch(self: &Arc<Self>) {
        let svc = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(svc.gh.pace(POLL_INTERVAL)).await;
                svc.poll(false).await;
            }
        });
    }

    pub fn list(&self) -> Vec<PrWatch> {
        let mut list = self.watches.lock().clone();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        list
    }

    fn changed(&self) {
        let _ = self
            .events
            .send(json!({"method":"watches.changed","params":{}}));
    }

    fn save(&self, watch: PrWatch) -> Result<()> {
        self.store
            .save_feature_record(NAMESPACE, &watch.id, &serde_json::to_string(&watch)?)?;
        let mut watches = self.watches.lock();
        watches.retain(|w| w.id != watch.id);
        watches.push(watch);
        Ok(())
    }

    pub async fn handle(self: &Arc<Self>, method: &str, p: Value) -> Result<Option<Value>> {
        if !method.starts_with("watches.") {
            return Ok(None);
        }
        let v = match method {
            "watches.list" => json!(self.list()),
            "watches.candidates" => {
                let (repo, number) = target(&p)?;
                self.candidates(&repo, number).await?
            }
            "watches.start" => {
                let (repo, number) = target(&p)?;
                json!(
                    self.start(
                        &repo,
                        number,
                        logins(&p["reviewers"])?,
                        logins(&p["request"])?
                    )
                    .await?
                )
            }
            "watches.remove" => {
                let id = p["id"].as_str().context("Missing id")?;
                self.store.delete_feature_record(NAMESPACE, id)?;
                self.watches.lock().retain(|w| w.id != id);
                self.changed();
                json!(true)
            }
            "watches.check" => {
                self.poll(true).await;
                json!(self.list())
            }
            _ => bail!("Unknown watch method"),
        };
        Ok(Some(v))
    }

    /// Everything the watch dialog offers: who is requested, who already
    /// reviewed, and who could be requested.
    async fn candidates(&self, repo: &str, number: u32) -> Result<Value> {
        let base = format!("repos/{repo}/pulls/{number}");
        let pull = self.gh.request("GET", &base, None).await?;
        let author = s(&pull["user"], "login");
        let requested = self
            .gh
            .request("GET", &format!("{base}/requested_reviewers"), None)
            .await?;
        let (review_path, assignee_path) =
            (format!("{base}/reviews"), format!("repos/{repo}/assignees"));
        let (reviews, assignees) = tokio::join!(
            pages(&*self.gh, &review_path),
            pages(&*self.gh, &assignee_path)
        );
        let mut reviewed: Vec<Value> = vec![];
        for review in reviews?.iter().rev() {
            let login = s(&review["user"], "login");
            let state = s(review, "state");
            if login.is_empty()
                || login.eq_ignore_ascii_case(&author)
                || !RESPONSES.contains(&state.as_str())
            {
                continue;
            }
            if !reviewed.iter().any(|r| {
                r["login"]
                    .as_str()
                    .is_some_and(|l| l.eq_ignore_ascii_case(&login))
            }) {
                reviewed.push(json!({"login": login, "state": state}));
            }
        }
        let (candidates, candidate_error) = match assignees {
            Ok(rows) => (
                rows.iter()
                    .map(|u| s(u, "login"))
                    .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case(&author))
                    .collect::<Vec<_>>(),
                None,
            ),
            Err(e) => (vec![], Some(format!("{e:#}"))),
        };
        let names = |key: &str, field: &str| -> Vec<String> {
            requested[key]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| s(v, field))
                .filter(|v| !v.is_empty())
                .collect()
        };
        Ok(json!({
            "title": s(&pull, "title"),
            "url": s(&pull, "html_url"),
            "author": author,
            "state": pull_state(&pull),
            "requested": names("users", "login"),
            "teams": names("teams", "slug"),
            "reviewed": reviewed,
            "candidates": candidates,
            "candidate_error": candidate_error,
            "watch": self.watches.lock().iter().find(|w| w.id == watch_id(repo, number)),
        }))
    }

    async fn start(
        &self,
        repo: &str,
        number: u32,
        reviewers: Vec<String>,
        request: Vec<String>,
    ) -> Result<PrWatch> {
        let account = self.gh.account().await?;
        let base = format!("repos/{repo}/pulls/{number}");
        let pull = self.gh.request("GET", &base, None).await?;
        if pull_state(&pull) != "open" {
            bail!("This PR is no longer open");
        }
        let author = s(&pull["user"], "login");
        if request.iter().any(|login| login.ends_with("[bot]")) {
            bail!("Bots cannot be requested as reviewers here");
        }
        if request
            .iter()
            .any(|login| login.eq_ignore_ascii_case(&author))
        {
            bail!("The PR author cannot be requested as a reviewer");
        }
        // The watch begins now: reviews that already exist are history, not news. Read before
        // requesting, so a review that lands right after the request still counts.
        let seen = pages(&*self.gh, &format!("{base}/reviews"))
            .await?
            .iter()
            .filter_map(|r| r["id"].as_u64())
            .max()
            .unwrap_or(0);
        if !request.is_empty() {
            self.gh
                .request_for(
                    &account,
                    "POST",
                    &format!("{base}/requested_reviewers"),
                    Some(json!({"reviewers": request})),
                )
                .await
                .context("Request reviewers")?;
        }
        let mut watched: Vec<String> = vec![];
        for login in reviewers.into_iter().chain(request) {
            if !watched.iter().any(|w| w.eq_ignore_ascii_case(&login)) {
                watched.push(login);
            }
        }
        let ts = now().to_rfc3339();
        let watch = PrWatch {
            id: watch_id(repo, number),
            account,
            repo: repo.into(),
            number,
            url: s(&pull, "html_url"),
            title: s(&pull, "title"),
            author,
            reviewers: watched,
            status: "watching".into(),
            seen,
            reviews: vec![],
            created_at: ts.clone(),
            updated_at: ts.clone(),
            last_checked: Some(ts),
            error: None,
        };
        // A running poll may be about to write the watch this one replaces.
        let _gate = self.poll_gate.lock().await;
        self.save(watch.clone())?;
        drop(_gate);
        self.changed();
        Ok(watch)
    }

    /// One pass over the active watches that are due, or over all of them.
    pub async fn poll(&self, all: bool) {
        let _gate = self.poll_gate.lock().await;
        let active: Vec<PrWatch> = self
            .watches
            .lock()
            .iter()
            .filter(|w| w.status == "watching")
            .cloned()
            .collect();
        if active.is_empty() {
            return;
        }
        if let Some(reason) = self.gh.blocked().await {
            return tracing::debug!("review watches paused: {reason}");
        }
        let notified = if all { None } else { self.gh.notified().await };
        let at = Utc::now();
        let due: Vec<PrWatch> = active
            .into_iter()
            .filter(|w| {
                let read = self.reads.lock().get(&w.id).copied();
                all || activity::due(read, notified.as_ref(), &w.repo, w.number, at)
            })
            .collect();
        if due.is_empty() {
            return;
        }
        let prs: Vec<_> = due
            .iter()
            .map(|w| {
                let since = Since {
                    reviews: Some(w.seen),
                    ..Default::default()
                };
                (w.repo.clone(), w.number, since)
            })
            .collect();
        let reads: Vec<Result<activity::Read>> = match activity::read(&*self.gh, &prs).await {
            Ok(reads) => reads,
            Err(e) => {
                let message = format!("{e:#}");
                due.iter()
                    .map(|_| Err(anyhow::anyhow!("{message}")))
                    .collect()
            }
        };
        for (watch, read) in due.into_iter().zip(reads) {
            let checked = read.map(|read| {
                let updated = DateTime::parse_from_rfc3339(&s(&read.node, "updatedAt"))
                    .map_or(read.at, |t| t.with_timezone(&Utc));
                self.reads
                    .lock()
                    .insert(watch.id.clone(), (read.at, updated));
                check(&watch, &read.node)
            });
            let mut next = watch.clone();
            next.last_checked = Some(now().to_rfc3339());
            let fresh = match checked {
                Ok(Check {
                    title,
                    state,
                    seen,
                    fresh,
                }) => {
                    next.error = None;
                    if !title.is_empty() {
                        next.title = title;
                    }
                    next.seen = next.seen.max(seen);
                    next.reviews.extend(fresh.iter().cloned());
                    if complete(&next) {
                        next.status = "done".into();
                    } else if state != "open" {
                        next.status = "closed".into();
                    }
                    fresh
                }
                Err(e) => {
                    next.error = Some(format!("{e:#}"));
                    vec![]
                }
            };
            next.updated_at = now().to_rfc3339();
            // The user may have removed or replaced the watch during the request.
            if !self
                .watches
                .lock()
                .iter()
                .any(|w| w.id == watch.id && w.created_at == watch.created_at)
            {
                continue;
            }
            if let Err(e) = self.save(next.clone()) {
                tracing::warn!("saving review watch {} failed: {e:#}", watch.id);
                continue;
            }
            for review in fresh {
                let _ = self.events.send(
                    json!({"method":"watches.review","params":{"watch": next, "review": review}}),
                );
            }
        }
        self.changed();
    }
}

struct Check {
    title: String,
    state: String,
    seen: u64,
    fresh: Vec<WatchedReview>,
}

/// The reviews in `pull` (read by [`activity::read`]) newer than the watch has seen.
fn check(watch: &PrWatch, pull: &Value) -> Check {
    let me = watch
        .account
        .split_once(':')
        .map(|(_, login)| login)
        .unwrap_or_default();
    let mut seen = watch.seen;
    let mut fresh = vec![];
    for n in pull["reviews"]["nodes"].as_array().into_iter().flatten() {
        let Some(id) = database_id(n) else {
            continue;
        };
        seen = seen.max(id);
        if id <= watch.seen {
            continue;
        }
        let reviewer = s(&n["author"], "login");
        let state = s(n, "state");
        let bot = n["author"]["__typename"] == "Bot" || reviewer.ends_with("[bot]");
        if !RESPONSES.contains(&state.as_str()) || !watches_reviewer(watch, &reviewer, bot, me) {
            continue;
        }
        fresh.push(WatchedReview {
            id,
            reviewer,
            state,
            body: s(n, "body"),
            url: s(n, "url"),
            submitted_at: s(n, "submittedAt"),
        });
    }
    fresh.sort_by_key(|r| r.id);
    Check {
        title: s(pull, "title"),
        state: match s(pull, "state").as_str() {
            "MERGED" => "merged".into(),
            state => state.to_lowercase(),
        },
        seen,
        fresh,
    }
}

fn watches_reviewer(watch: &PrWatch, reviewer: &str, bot: bool, me: &str) -> bool {
    if reviewer.is_empty() || reviewer.eq_ignore_ascii_case(&watch.author) {
        return false;
    }
    // Automatic reviews (Copilot and the like) would end an open-ended watch
    // before a person looked. A bot counts only when chosen by name.
    if watch.reviewers.is_empty() {
        return !bot && !reviewer.eq_ignore_ascii_case(me);
    }
    watch
        .reviewers
        .iter()
        .any(|r| r.eq_ignore_ascii_case(reviewer))
}

/// Done once every watched reviewer has responded, or anyone has when no
/// reviewer was named.
fn complete(watch: &PrWatch) -> bool {
    if watch.reviewers.is_empty() {
        return !watch.reviews.is_empty();
    }
    watch.reviewers.iter().all(|login| {
        watch
            .reviews
            .iter()
            .any(|r| r.reviewer.eq_ignore_ascii_case(login))
    })
}

fn pull_state(pull: &Value) -> String {
    if pull["merged"] == true || pull["merged_at"].is_string() {
        "merged".into()
    } else {
        s(pull, "state")
    }
}

fn target(p: &Value) -> Result<(String, u32)> {
    let repo = p["repo"].as_str().context("Missing repo")?;
    validate_repo(repo)?;
    let number = p["number"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .context("Invalid PR number")? as u32;
    Ok((repo.into(), number))
}

fn logins(v: &Value) -> Result<Vec<String>> {
    let mut out = vec![];
    for login in v.as_array().into_iter().flatten() {
        let login = login.as_str().context("Invalid reviewer")?;
        // GitHub logins: alphanumerics and hyphens, at most 39 characters; apps add "[bot]".
        let name = login.strip_suffix("[bot]").unwrap_or(login);
        if name.is_empty()
            || name.len() > 39
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            bail!("Invalid reviewer {login:?}");
        }
        out.push(login.to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    #[derive(Default)]
    struct Fake {
        reviews: Mutex<Vec<Value>>,
        state: Mutex<String>,
        requested: Mutex<Vec<Value>>,
        /// Batched review reads so far.
        reads: Mutex<usize>,
        blocked: Mutex<Option<String>>,
    }
    fn review(id: u64, login: &str, state: &str) -> Value {
        json!({"id": id, "user": {"login": login}, "state": state, "body": "", "html_url": format!("https://github.com/o/r/pull/1#pullrequestreview-{id}"), "submitted_at": "2026-09-29T10:00:00Z"})
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
            match (method, path) {
                ("POST", "graphql") => {
                    let state = self.state.lock().to_uppercase();
                    let reviews: Vec<Value> = self.reviews.lock().iter().map(|r| {
                        let login = s(&r["user"], "login");
                        json!({"fullDatabaseId": r["id"].to_string(), "state": r["state"], "body": r["body"], "url": r["html_url"], "submittedAt": r["submitted_at"],
                            "author": {"__typename": if login.ends_with("[bot]") { "Bot" } else { "User" }, "login": login}})
                    }).collect();
                    let conn = |nodes: Vec<Value>| json!({"pageInfo": {"hasPreviousPage": false, "hasNextPage": false}, "nodes": nodes});
                    *self.reads.lock() += 1;
                    Ok(
                        json!({"data": {"r0": {"pr0": {"id": "PR_1", "title": "PR", "url": "https://github.com/o/r/pull/1",
                        "state": if state.is_empty() { "OPEN" } else { &state }, "author": {"login": "me"},
                        "reviews": conn(reviews), "comments": conn(vec![]), "reviewThreads": conn(vec![])}}}}),
                    )
                }
                ("GET", "user") => Ok(json!({"login": "me"})),
                ("GET", "repos/o/r/pulls/1") => {
                    let state = self.state.lock().clone();
                    Ok(
                        json!({"title": "PR", "html_url": "https://github.com/o/r/pull/1", "state": if state.is_empty() { "open" } else { &state }, "merged": state == "merged", "user": {"login": "me"}}),
                    )
                }
                ("GET", "repos/o/r/pulls/1/requested_reviewers") => {
                    Ok(json!({"users": [{"login": "alice"}], "teams": [{"slug": "core"}]}))
                }
                ("GET", p) if p.starts_with("repos/o/r/pulls/1/reviews?") => {
                    Ok(json!(self.reviews.lock().clone()))
                }
                ("GET", p) if p.starts_with("repos/o/r/assignees?") => {
                    Ok(json!([{"login": "me"}, {"login": "alice"}, {"login": "bob"}]))
                }
                ("POST", "repos/o/r/pulls/1/requested_reviewers") => {
                    self.requested.lock().push(body.unwrap());
                    Ok(json!({}))
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
        async fn blocked(&self) -> Option<String> {
            self.blocked.lock().clone()
        }
    }
    fn service(gh: Arc<Fake>) -> (Arc<WatchService>, broadcast::Receiver<Value>) {
        let (events, rx) = broadcast::channel(64);
        (
            WatchService::new(Arc::new(MemoryStore::default()), gh, events).unwrap(),
            rx,
        )
    }
    fn reported(rx: &mut broadcast::Receiver<Value>) -> Vec<(String, String)> {
        let mut out = vec![];
        while let Ok(v) = rx.try_recv() {
            if v["method"] == "watches.review" {
                out.push((
                    s(&v["params"]["review"], "reviewer"),
                    s(&v["params"]["review"], "state"),
                ));
            }
        }
        out
    }

    #[tokio::test]
    async fn reports_comment_only_reviews_and_ignores_history() {
        let gh = Arc::new(Fake::default());
        gh.reviews.lock().push(review(5, "alice", "APPROVED"));
        let (svc, mut rx) = service(gh.clone());
        let watch = svc
            .start("o/r", 1, vec!["alice".into()], vec![])
            .await
            .unwrap();
        assert_eq!(watch.seen, 5);
        svc.poll(false).await;
        assert!(
            reported(&mut rx).is_empty(),
            "an approval from before the watch is not news"
        );

        gh.reviews.lock().push(review(6, "bob", "COMMENTED"));
        gh.reviews.lock().push(review(7, "me", "COMMENTED"));
        gh.reviews.lock().push(review(8, "alice", "PENDING"));
        svc.poll(false).await;
        assert!(
            reported(&mut rx).is_empty(),
            "unwatched reviewers, the author's replies and drafts are skipped"
        );

        gh.reviews.lock().push(review(9, "Alice", "COMMENTED"));
        svc.poll(false).await;
        assert_eq!(
            reported(&mut rx),
            vec![("Alice".into(), "COMMENTED".into())]
        );
        let watch = &svc.list()[0];
        assert_eq!(watch.status, "done");
        assert_eq!(watch.seen, 9);

        svc.poll(false).await;
        assert!(
            reported(&mut rx).is_empty(),
            "finished watches are not polled again"
        );
    }

    #[tokio::test]
    async fn waits_for_every_reviewer_and_requests_new_ones() {
        let gh = Arc::new(Fake::default());
        let (svc, mut rx) = service(gh.clone());
        let watch = svc
            .start(
                "o/r",
                1,
                vec!["alice".into()],
                vec!["bob".into(), "alice".into()],
            )
            .await
            .unwrap();
        assert_eq!(watch_id("O/R", 1), "o/r#1");
        assert_eq!(watch.reviewers, vec!["alice", "bob"]);
        assert_eq!(
            gh.requested.lock().as_slice(),
            &[json!({"reviewers": ["bob", "alice"]})]
        );

        gh.reviews
            .lock()
            .push(review(1, "alice", "CHANGES_REQUESTED"));
        svc.poll(false).await;
        assert_eq!(svc.list()[0].status, "watching");
        gh.reviews.lock().push(review(2, "bob", "APPROVED"));
        svc.poll(false).await;
        assert_eq!(svc.list()[0].status, "done");
        assert_eq!(
            reported(&mut rx),
            vec![
                ("alice".into(), "CHANGES_REQUESTED".into()),
                ("bob".into(), "APPROVED".into())
            ]
        );
    }

    #[tokio::test]
    async fn anyone_mode_excludes_author_and_merged_prs_close_the_watch() {
        let gh = Arc::new(Fake::default());
        let (svc, mut rx) = service(gh.clone());
        svc.start("o/r", 1, vec![], vec![]).await.unwrap();
        gh.reviews
            .lock()
            .push(review(1, "copilot-pull-request-reviewer[bot]", "COMMENTED"));
        svc.poll(false).await;
        assert_eq!(
            svc.list()[0].status,
            "watching",
            "an automatic bot review does not end an open-ended watch"
        );
        *gh.state.lock() = "merged".into();
        svc.poll(false).await;
        assert_eq!(svc.list()[0].status, "closed");
        assert!(reported(&mut rx).is_empty());
        assert!(
            svc.start("o/r", 1, vec![], vec![]).await.is_err(),
            "a merged PR cannot be watched"
        );
    }

    #[tokio::test]
    async fn candidates_list_requested_reviewed_and_requestable_people() {
        let gh = Arc::new(Fake::default());
        gh.reviews.lock().push(review(1, "bob", "COMMENTED"));
        gh.reviews.lock().push(review(2, "me", "COMMENTED"));
        let (svc, _rx) = service(gh);
        let v = svc.candidates("o/r", 1).await.unwrap();
        assert_eq!(v["requested"], json!(["alice"]));
        assert_eq!(v["teams"], json!(["core"]));
        assert_eq!(
            v["reviewed"],
            json!([{"login": "bob", "state": "COMMENTED"}])
        );
        assert_eq!(v["candidates"], json!(["alice", "bob"]));
    }

    #[tokio::test]
    async fn an_expired_login_stops_the_reads_until_it_works_again() {
        let gh = Arc::new(Fake::default());
        let (svc, mut rx) = service(gh.clone());
        svc.start("o/r", 1, vec!["alice".into()], vec![])
            .await
            .unwrap();
        gh.reviews.lock().push(review(1, "alice", "APPROVED"));
        *gh.blocked.lock() = Some(aura_github::LOGIN_EXPIRED.into());
        svc.poll(false).await;
        svc.poll(true).await;
        assert_eq!(*gh.reads.lock(), 0, "nothing is asked of GitHub");
        assert!(reported(&mut rx).is_empty());
        *gh.blocked.lock() = None;
        svc.poll(false).await;
        assert_eq!(reported(&mut rx), vec![("alice".into(), "APPROVED".into())]);
    }

    #[tokio::test]
    async fn a_quiet_pr_is_not_read_every_pass() {
        let gh = Arc::new(Fake::default());
        let (svc, _rx) = service(gh.clone());
        svc.start("o/r", 1, vec!["alice".into()], vec![])
            .await
            .unwrap();
        svc.poll(false).await;
        assert_eq!(*gh.reads.lock(), 1);
        // Last updated long ago, and no notifications to say otherwise.
        let long_ago = Utc::now() - chrono::Duration::hours(3);
        svc.reads.lock().get_mut("o/r#1").unwrap().1 = long_ago;
        svc.poll(false).await;
        assert_eq!(*gh.reads.lock(), 1, "read again after a few minutes");
        svc.poll(true).await;
        assert_eq!(*gh.reads.lock(), 2, "a check the user asked for reads it");
    }

    #[test]
    fn rejects_unsafe_logins() {
        assert!(logins(&json!(["ok-name", "copilot-pull-request-reviewer[bot]"])).is_ok());
        for bad in ["", "../x", "a b", "x?y=1"] {
            assert!(logins(&json!([bad])).is_err());
        }
    }
}
