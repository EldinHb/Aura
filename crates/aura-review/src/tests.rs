use super::*;
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const DIFF: &str =
    "diff --git a/test.rs b/test.rs\n--- a/test.rs\n+++ b/test.rs\n@@ -1 +1 @@\n-before\n+after\n";
fn draft() -> PreReview {
    PreReview {
        id: "review-1".into(),
        pull: PullRequest {
            id: "o/r#1".into(),
            repo: "o/r".into(),
            number: 1,
            account: "github.com:alice".into(),
            head_sha: "a".repeat(40),
            base_sha: "b".repeat(40),
            state: "open".into(),
            ..Default::default()
        },
        config: ReviewConfig {
            provider: "codex".into(),
            prompt_mode: "default".into(),
            ..Default::default()
        },
        instructions: "Review".into(),
        status: "ready".into(),
        phase: "done".into(),
        error: None,
        created_at: now().to_rfc3339(),
        updated_at: now().to_rfc3339(),
        revision: 0,
        reviewed_sha: "a".repeat(40),
        merge_base: "b".repeat(40),
        context_mode: "worktree".into(),
        context_note: None,
        diff: DIFF.into(),
        log_tail: vec![],
        result: ReviewResult {
            summary: "A useful summary".into(),
            verdict: "comment".into(),
            risk: "low".into(),
            confidence: Some(0.8),
            comments: vec![ReviewComment {
                id: "c1".into(),
                path: "test.rs".into(),
                line: 1,
                side: "RIGHT".into(),
                body: "Fix this".into(),
                severity: "major".into(),
                rationale: Some("Private thought".into()),
                ..Default::default()
            }],
        },
        submitted_url: None,
        submission: None,
        agent: None,
    }
}
fn claude_agent() -> ReviewAgent {
    ReviewAgent {
        provider: "Claude Code".into(),
        model: Some("opus".into()),
        model_id: None,
        effort: Some("high".into()),
    }
}
struct MockGithub {
    account: Mutex<String>,
    head: Mutex<String>,
    posts: AtomicUsize,
    uncertain: AtomicBool,
    reject: AtomicBool,
    posted: Mutex<Vec<Value>>,
    merge_state: Mutex<String>,
    /// Merges and branch deletions, as `METHOD path`.
    writes: Mutex<Vec<String>>,
    /// PR numbers in o/r each search filter finds, by the start of its filter.
    searches: Mutex<Vec<(&'static str, Vec<u32>)>>,
    /// PRs whose read fails inside an otherwise fine batch.
    unreadable: Mutex<Vec<u32>>,
    /// GraphQL state of every PR, and who merged them.
    state: Mutex<(String, String)>,
    /// Batched GraphQL reads so far.
    reads: AtomicUsize,
}
impl Default for MockGithub {
    fn default() -> Self {
        Self {
            account: Mutex::new("alice".into()),
            head: Mutex::new("a".repeat(40)),
            posts: AtomicUsize::new(0),
            uncertain: AtomicBool::new(false),
            reject: AtomicBool::new(false),
            posted: Mutex::new(vec![]),
            merge_state: Mutex::new("CLEAN".into()),
            writes: Mutex::new(vec![]),
            searches: Mutex::new(vec![("author%3A%40me", vec![1])]),
            unreadable: Mutex::new(vec![]),
            state: Mutex::new(("OPEN".into(), String::new())),
            reads: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl Github for MockGithub {
    fn host(&self) -> &str {
        "github.com"
    }
    async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
        Ok(DIFF.into())
    }
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        if path == "user" {
            return Ok(json!({"login":*self.account.lock()}));
        }
        if path.starts_with("search/") {
            let filter = path.split("archived%3Afalse%20").nth(1).unwrap_or_default();
            let numbers = self.searches.lock().iter().find(|(f, _)| filter.starts_with(f)).map(|(_, n)| n.clone()).unwrap_or_default();
            let items: Vec<Value> = numbers.iter().map(|n| json!({"repository_url":"https://api.github.com/repos/o/r","number":n})).collect();
            return Ok(json!({"total_count":items.len(),"incomplete_results":false,"items":items}));
        }
        if path.contains("/compare/") {
            return Ok(json!({"merge_base_commit":{"sha":"b".repeat(40)}}));
        }
        if path == "graphql" {
            let reviews: Vec<Value> = self
                .posted
                .lock()
                .iter()
                .map(|_| json!({"state":"COMMENTED","submittedAt":"2026-10-05T10:00:00Z","commit":{"oid":"a".repeat(40)}}))
                .collect();
            self.reads.fetch_add(1, Ordering::SeqCst);
            let query = body.as_ref().unwrap()["query"].as_str().unwrap().to_string();
            if query.contains("timelineItems(first:100,after:$items") {
                let conn = |nodes: Value| json!({"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":nodes});
                return Ok(json!({"data":{"repository":{"pullRequest":{"commits":{"totalCount":2},
                    "timelineItems":conn(json!([
                        {"__typename":"IssueComment","id":"IC_1","body":"Nice","createdAt":"2026-10-05T09:00:00Z","url":"https://github.com/o/r/pull/1#issuecomment-1","author":{"login":"carol"}},
                        {"__typename":"PullRequestReview","id":"PRR_1","databaseId":7,"body":"","state":"APPROVED","createdAt":"2026-10-05T10:00:00Z","submittedAt":"2026-10-05T10:00:00Z","url":"u","author":{"login":"dave"}}])),
                    "reviewThreads":conn(json!([{"id":"T1","isResolved":false,"isOutdated":false,"path":"src/lib.rs","line":2,"originalLine":2,"resolvedBy":null,
                        "comments":{"totalCount":1,"nodes":[{"id":"C1","body":"Why?","createdAt":"2026-10-05T10:00:00Z","url":"u","diffHunk":"@@","author":{"login":"dave"},"pullRequestReview":{"databaseId":7}}]}}]))}}}}));
            }
            if query.contains("projectItems") {
                return Ok(json!({"data":{"repository":{"pullRequest":{"projectItems":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}));
            }
            // One batched query: r0 is o/r, holding prN:pullRequest(number:…) per PR.
            let mut repo = json!({"viewerPermission":"WRITE","mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"viewerDefaultMergeMethod":"SQUASH","deleteBranchOnMerge":false});
            let mut errors = vec![];
            for part in query.split(" pr").skip(1) {
                let (index, rest) = part.split_once(":pullRequest(number:").unwrap();
                let number: u32 = rest.split(')').next().unwrap().parse().unwrap();
                let key = format!("pr{index}");
                if self.unreadable.lock().contains(&number) {
                    repo[&key] = Value::Null;
                    errors.push(json!({"path":["r0",key],"message":"Something went wrong"}));
                    continue;
                }
                let (state, merged_by) = self.state.lock().clone();
                repo[&key] = json!({"number":number,"title":format!("PR {number}"),"state":state,"mergedBy":{"login":merged_by},"author":{"login":"bob"},"headRefOid":*self.head.lock(),"headRefName":"feature","baseRefOid":"b".repeat(40),"baseRefName":"main","viewerCanUpdate":true,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":*self.merge_state.lock(),"isCrossRepository":false,"commits":{"nodes":[]},"reviews":{"nodes":reviews}});
            }
            return Ok(json!({"data":{"r0":repo},"errors":errors}));
        }
        if (method == "PUT" && path == "repos/o/r/pulls/1/merge") || method == "DELETE" {
            self.writes.lock().push(format!("{method} {path}"));
            if method == "PUT" {
                assert_eq!(body.unwrap(), json!({"merge_method":"squash","sha":"a".repeat(40)}));
            }
            return Ok(json!({"merged":true}));
        }
        if method == "POST" && path.ends_with("/reviews") {
            self.posts.fetch_add(1, Ordering::SeqCst);
            if self.reject.load(Ordering::SeqCst) {
                return Err(aura_github::RejectedRequest("HTTP 422 invalid comment".into()).into());
            }
            let mut v = body.unwrap();
            v["html_url"] = json!("https://github.com/o/r/pull/1#review-1");
            self.posted.lock().push(v.clone());
            if self.uncertain.load(Ordering::SeqCst) {
                bail!("network timeout");
            }
            return Ok(v);
        }
        if path.contains("/reviews?") {
            return Ok(json!(self.posted.lock().clone()));
        }
        bail!("Unexpected request {method} {path}")
    }
}
struct MockRunner;
#[async_trait]
impl ReviewRunner for MockRunner {
    async fn run(
        &self,
        _: &PreReview,
        _: &std::path::Path,
        progress: Progress,
    ) -> Result<runner::RunOutput> {
        progress("Reading changed file".into());
        Ok(runner::RunOutput {
            result: draft().result,
            model_id: Some("claude-opus-5-5".into()),
        })
    }
}
struct MockWorkspace;
#[async_trait]
impl ReviewWorkspace for MockWorkspace {
    async fn prepare(&self, _: &PullRequest, cwd: &std::path::Path) -> Result<(String, String)> {
        tokio::fs::create_dir_all(cwd).await?;
        Ok((DIFF.into(), "b".repeat(40)))
    }
}
fn service(gh: Arc<MockGithub>, r: PreReview) -> Arc<ReviewService> {
    let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
    store
        .save_feature_record("reviews", &r.id, &serde_json::to_string(&r).unwrap())
        .unwrap();
    let manager = Manager::new(store.clone(), vec![], None);
    let mut svc = ReviewService::new(
        store,
        gh,
        Arc::new(MockRunner),
        manager,
        std::env::temp_dir().join(format!("aura-test-{}", new_id())),
    )
    .unwrap();
    Arc::get_mut(&mut svc).unwrap().workspace = Arc::new(MockWorkspace);
    svc.state.lock().account = Some(r.pull.account.clone());
    svc
}
#[test]
fn submission_has_exact_positions_and_no_private_or_deleted_data() {
    let mut r = draft();
    let mut deleted = r.result.comments[0].clone();
    deleted.id = "deleted".into();
    deleted.body = "secret deleted".into();
    deleted.deleted = true;
    r.result.comments.push(deleted);
    let mut orphan = r.result.comments[0].clone();
    orphan.path = "missing.rs".into();
    orphan.body = "Kept unanchored".into();
    r.result.comments.push(orphan);
    let preview = build_preview(&r, &"c".repeat(40)).unwrap();
    assert!(preview.stale);
    assert_eq!(preview.comments.len(), 1);
    let body = payload(&preview).to_string();
    assert!(!body.contains("Private thought"));
    assert!(!body.contains("secret deleted"));
    assert!(body.contains("Kept unanchored"));
    assert_eq!(payload(&preview)["commit_id"], "a".repeat(40));
}
#[tokio::test]
async fn requires_preview_and_rechecks_head() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    assert!(svc.submit("review-1", "absent").await.is_err());
    let p = svc.preview("review-1").await.unwrap();
    *gh.head.lock() = "c".repeat(40);
    assert!(svc.submit("review-1", &p.token).await.is_err());
    assert_eq!(gh.posts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn concurrent_submit_is_serialized_and_sent_once() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    let p = svc.preview("review-1").await.unwrap();
    let input = json!({"id":"review-1","token":p.token});
    let (a, b) = tokio::join!(
        svc.handle("reviews.submit", input.clone()),
        svc.handle("reviews.submit", input)
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(gh.posts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn submitting_updates_the_pull_list_without_waiting_for_the_poll() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    svc.refresh().await.unwrap();
    assert_eq!(svc.snapshot().mine[0].my_review, None);
    let mut events = svc.events.subscribe();
    let p = svc.preview("review-1").await.unwrap();
    svc.handle("reviews.submit", json!({"id":"review-1","token":p.token}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while svc.snapshot().mine[0].my_review.is_none() {
            events.recv().await.unwrap();
        }
    })
    .await
    .expect("the submitted review reaches the list");
    assert_eq!(
        svc.snapshot().mine[0].my_review.as_ref().unwrap().state,
        "COMMENTED"
    );
}
#[tokio::test]
async fn uncertain_success_is_reconciled_without_reposting() {
    let gh = Arc::new(MockGithub::default());
    gh.uncertain.store(true, Ordering::SeqCst);
    let svc = service(gh.clone(), draft());
    let p = svc.preview("review-1").await.unwrap();
    assert!(svc.submit("review-1", &p.token).await.is_err());
    assert_eq!(svc.get("review-1").unwrap().status, "uncertain");
    assert!(svc.submit("review-1", &p.token).await.is_err());
    assert_eq!(svc.reconcile("review-1").await.unwrap().status, "submitted");
    assert_eq!(gh.posts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn definite_rejection_preserves_editable_draft() {
    let gh = Arc::new(MockGithub::default());
    gh.reject.store(true, Ordering::SeqCst);
    let svc = service(gh, draft());
    let p = svc.preview("review-1").await.unwrap();
    assert!(svc.submit("review-1", &p.token).await.is_err());
    assert_eq!(svc.get("review-1").unwrap().status, "ready");
}
#[tokio::test]
async fn account_switch_cannot_post_old_draft() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    let p = svc.preview("review-1").await.unwrap();
    *gh.account.lock() = "someone-else".into();
    assert!(svc.submit("review-1", &p.token).await.is_err());
    assert_eq!(gh.posts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn save_revision_conflict_keeps_original() {
    let svc = service(Arc::new(MockGithub::default()), draft());
    let input = json!({"id":"review-1","revision":0,"result":draft().result});
    assert!(svc.handle("reviews.save", input.clone()).await.is_ok());
    assert!(svc.handle("reviews.save", input).await.is_err());
    assert_eq!(svc.get("review-1").unwrap().revision, 1);
}
#[tokio::test]
async fn inbox_retirement_preserves_history_and_hidden_preferences() {
    let svc = service(Arc::new(MockGithub::default()), draft());
    svc.handle(
        "pulls.hide",
        json!({"id":"o/r#1","account":"github.com:alice"}),
    )
    .await
    .unwrap();
    svc.refresh().await.unwrap();
    assert_eq!(svc.snapshot().reviews.len(), 1);
    assert_eq!(
        svc.store
            .feature_records("hidden:github.com:alice")
            .unwrap(),
        vec![("o/r#1".into(), "true".into())]
    );
}
#[tokio::test]
async fn refresh_lists_authored_pulls_separately_and_hides_them() {
    let svc = service(Arc::new(MockGithub::default()), draft());
    svc.refresh().await.unwrap();
    let inbox = svc.snapshot();
    assert!(inbox.pulls.is_empty());
    assert_eq!(inbox.mine.len(), 1);
    assert_eq!(inbox.mine[0].id, "o/r#1");
    assert_eq!(inbox.mine[0].review_decision, "REVIEW_REQUIRED");
    svc.handle(
        "pulls.hide",
        json!({"id":"o/r#1","account":"github.com:alice"}),
    )
    .await
    .unwrap();
    assert!(svc.snapshot().mine[0].hidden);
    svc.refresh().await.unwrap();
    assert!(svc.snapshot().mine[0].hidden);
}
#[tokio::test]
async fn refresh_lists_requested_reviewed_and_authored_pulls_in_one_read() {
    let gh = Arc::new(MockGithub::default());
    *gh.searches.lock() = vec![
        ("review-requested%3A%40me", vec![2, 3]),
        ("reviewed-by%3A%40me", vec![3, 4]),
        ("author%3A%40me", vec![1]),
    ];
    let svc = service(gh, draft());
    svc.refresh().await.unwrap();
    let inbox = svc.snapshot();
    let numbers = |pulls: &[PullRequest]| pulls.iter().map(|p| p.number).collect::<Vec<_>>();
    assert_eq!(numbers(&inbox.pulls), vec![2, 3]);
    assert_eq!(numbers(&inbox.reviewed), vec![4], "a PR asked again is listed as a request only");
    assert_eq!(numbers(&inbox.mine), vec![1]);
    svc.handle("pulls.hide", json!({"id":"o/r#4","account":"github.com:alice"})).await.unwrap();
    assert!(svc.snapshot().reviewed[0].hidden);
}
#[tokio::test]
async fn a_pull_request_that_fails_to_read_keeps_its_last_copy() {
    let gh = Arc::new(MockGithub::default());
    *gh.searches.lock() = vec![("review-requested%3A%40me", vec![2, 3]), ("author%3A%40me", vec![1])];
    let svc = service(gh.clone(), draft());
    svc.refresh().await.unwrap();
    *gh.unreadable.lock() = vec![3];
    *gh.head.lock() = "c".repeat(40);
    *gh.searches.lock() = vec![("review-requested%3A%40me", vec![2, 3, 5]), ("author%3A%40me", vec![1])];
    gh.unreadable.lock().push(5);
    svc.refresh().await.unwrap();
    let inbox = svc.snapshot();
    assert_eq!(inbox.pulls.iter().map(|p| (p.number, p.head_sha.clone())).collect::<Vec<_>>(), vec![(2, "c".repeat(40)), (3, "a".repeat(40))],
        "the others update, #3 keeps its last copy and the never-read #5 is left out");
    assert_eq!(inbox.mine.len(), 1);
    assert_eq!(inbox.error.as_deref(), Some("Unable to read o/r#3: Something went wrong\nUnable to read o/r#5: Something went wrong"));
    gh.unreadable.lock().clear();
    svc.refresh().await.unwrap();
    assert_eq!(svc.snapshot().pulls.len(), 3);
    assert_eq!(svc.snapshot().error, None);
}
#[tokio::test]
async fn mocked_runner_produces_frozen_diff_and_cleans_workspace() {
    let svc = service(Arc::new(MockGithub::default()), draft());
    svc.change("review-1", |r| {
        r.status = "running".into();
        Ok(())
    })
    .unwrap();
    svc.execute("review-1").await.unwrap();
    let r = svc.get("review-1").unwrap();
    assert_eq!(r.status, "ready");
    assert_eq!(r.diff, DIFF);
    assert_eq!(r.reviewed_sha, r.pull.head_sha);
    assert!(r.result.comments[0].valid);
    assert_eq!(std::fs::read_dir(&svc.root).unwrap().count(), 0);
    std::fs::remove_dir(&svc.root).unwrap();
}
#[tokio::test]
async fn a_finished_review_records_the_model_that_ran() {
    let mut r = draft();
    r.agent = Some(claude_agent());
    let svc = service(Arc::new(MockGithub::default()), r);
    svc.change("review-1", |r| {
        r.status = "running".into();
        Ok(())
    })
    .unwrap();
    svc.execute("review-1").await.unwrap();
    let agent = svc.get("review-1").unwrap().agent.unwrap();
    assert_eq!(agent.model_id.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(
        agent.signature(),
        "Claude Code · model opus (claude-opus-5-5) · effort high"
    );
    let _ = std::fs::remove_dir(&svc.root);
}
#[test]
fn posted_reviews_and_agent_comments_name_the_agent_model_and_effort() {
    let mut r = draft();
    r.agent = Some(ReviewAgent {
        model_id: Some("claude-opus-5-5".into()),
        ..claude_agent()
    });
    let mut mine = r.result.comments[0].clone();
    mine.id = "mine".into();
    mine.body = "My own note".into();
    mine.user_authored = true;
    r.result.comments.push(mine);
    let preview = build_preview(&r, &"a".repeat(40)).unwrap();
    let sig = "Claude Code · model opus (claude-opus-5-5) · effort high";
    assert!(
        preview.body.contains(&format!(
            "Drafted by an AI agent with Aura and reviewed by a person before posting · {sig}"
        )),
        "{}",
        preview.body
    );
    assert!(preview
        .body
        .ends_with(&format!("<!-- aura-review:{} -->", preview.token)));
    let agent = preview.comments.iter().find(|c| c.id == "c1").unwrap();
    assert_eq!(
        agent.body,
        format!("Fix this\n\n<sub>🤖 AI agent · {sig}</sub>")
    );
    let user = preview.comments.iter().find(|c| c.id == "mine").unwrap();
    assert_eq!(user.body, "My own note");
}
#[test]
fn drafts_from_before_agents_were_recorded_are_signed_from_their_config() {
    let preview = build_preview(&draft(), &"a".repeat(40)).unwrap();
    assert!(
        preview
            .body
            .contains("Codex · model default model · effort default"),
        "{}",
        preview.body
    );
}
#[tokio::test]
async fn restart_marks_interrupted_and_uncertain_jobs() {
    let mut r = draft();
    r.status = "running".into();
    assert_eq!(
        service(Arc::new(MockGithub::default()), r)
            .get("review-1")
            .unwrap()
            .status,
        "failed"
    );
    let mut r = draft();
    r.status = "submitting".into();
    assert_eq!(
        service(Arc::new(MockGithub::default()), r)
            .get("review-1")
            .unwrap()
            .status,
        "uncertain"
    );
}

struct BlockingRunner {
    started: Arc<tokio::sync::Notify>,
    finish: Arc<tokio::sync::Notify>,
}
#[async_trait]
impl ReviewRunner for BlockingRunner {
    async fn run(
        &self,
        _: &PreReview,
        _: &std::path::Path,
        _: Progress,
    ) -> Result<runner::RunOutput> {
        self.started.notify_one();
        self.finish.notified().await;
        Ok(runner::RunOutput {
            result: draft().result,
            model_id: None,
        })
    }
}
#[tokio::test]
async fn cancelled_review_cannot_become_ready_after_late_completion() {
    let mut svc = service(Arc::new(MockGithub::default()), draft());
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    Arc::get_mut(&mut svc).unwrap().runner = Arc::new(BlockingRunner {
        started: started.clone(),
        finish: finish.clone(),
    });
    svc.change("review-1", |r| {
        r.status = "running".into();
        Ok(())
    })
    .unwrap();
    let running = svc.clone();
    let task = tokio::spawn(async move { running.execute("review-1").await });
    started.notified().await;
    svc.handle("reviews.cancel", json!({"id":"review-1"}))
        .await
        .unwrap();
    finish.notify_one();
    assert!(task.await.unwrap().is_err());
    assert_eq!(svc.get("review-1").unwrap().status, "cancelled");
    assert_eq!(std::fs::read_dir(&svc.root).unwrap().count(), 0);
    std::fs::remove_dir(&svc.root).unwrap();
}
struct MissingWorkspace;
#[async_trait]
impl ReviewWorkspace for MissingWorkspace {
    async fn prepare(&self, _: &PullRequest, _: &std::path::Path) -> Result<(String, String)> {
        bail!("Clone permission denied")
    }
}
#[tokio::test]
async fn checkout_failure_uses_explicit_diff_only_context() {
    let mut svc = service(Arc::new(MockGithub::default()), draft());
    Arc::get_mut(&mut svc).unwrap().workspace = Arc::new(MissingWorkspace);
    svc.change("review-1", |r| {
        r.status = "running".into();
        Ok(())
    })
    .unwrap();
    svc.execute("review-1").await.unwrap();
    let r = svc.get("review-1").unwrap();
    assert_eq!(r.context_mode, "diff-only");
    assert!(r.context_note.unwrap().contains("Clone permission denied"));
    std::fs::remove_dir(&svc.root).unwrap();
}
#[tokio::test]
async fn missing_review_diff_does_not_fetch_new_head_under_old_findings() {
    let mut r = draft();
    r.diff.clear();
    let svc = service(Arc::new(MockGithub::default()), r);
    let returned = svc
        .handle("reviews.diff", json!({"id":"review-1"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(returned["diff"], "");
    let preview = svc.preview("review-1").await.unwrap();
    assert!(preview.comments.is_empty());
    assert!(preview.body.contains("Additional notes"));
}
#[tokio::test]
async fn pull_detail_holds_the_timeline_and_the_lists_older_apps_read() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh, draft());
    let detail = svc.handle("pulls.get", json!({"repo":"o/r","number":1,"account":"github.com:alice"})).await.unwrap().unwrap();
    assert_eq!(detail["timeline"]["commits"], 2);
    assert_eq!(detail["timeline"]["items"][1]["review_id"], 7);
    assert_eq!(detail["timeline"]["threads"][0]["review_id"], 7);
    assert_eq!(detail["comments"][0]["user"]["login"], "carol");
    assert_eq!(detail["reviews"][0]["state"], "APPROVED");
    assert_eq!(detail["threads"][0]["path"], "src/lib.rs");
    assert_eq!(detail["project_error"], Value::Null);
    let cached = svc.handle("pulls.cached", json!({"id":"o/r#1","account":"github.com:alice"})).await.unwrap().unwrap();
    assert_eq!(cached, detail);
}
#[tokio::test]
async fn merges_the_shown_head_and_deletes_the_branch() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    let merge = |method: &str, sha: String, delete: bool| {
        json!({"repo":"o/r","number":1,"account":"github.com:alice","method":method,"sha":sha,"delete_branch":delete})
    };
    let pr = svc.lookup(&json!({"repo":"o/r","number":1})).await.unwrap();
    assert_eq!(pr.merge_methods, ["squash", "rebase"]);
    assert_eq!(pr.default_merge_method, "squash");
    assert!(pr.can_merge && pr.can_delete_branch);
    assert_eq!(pr.merge_blocked_by, None);

    let err = svc.handle("pulls.merge", merge("merge", "a".repeat(40), true)).await.unwrap_err();
    assert!(err.to_string().contains("does not allow merge"), "{err}");
    let err = svc.handle("pulls.merge", merge("squash", "c".repeat(40), true)).await.unwrap_err();
    assert!(err.to_string().contains("New commits"), "{err}");
    *gh.merge_state.lock() = "BLOCKED".into();
    let err = svc.handle("pulls.merge", merge("squash", "a".repeat(40), true)).await.unwrap_err();
    assert_eq!(err.to_string(), "A review is required");
    assert!(gh.writes.lock().is_empty(), "nothing is sent while a merge is refused");

    *gh.merge_state.lock() = "CLEAN".into();
    let v = svc.handle("pulls.merge", merge("squash", "a".repeat(40), true)).await.unwrap().unwrap();
    assert_eq!(v["branch_deleted"], true);
    assert_eq!(*gh.writes.lock(), ["PUT repos/o/r/pulls/1/merge", "DELETE repos/o/r/git/refs/heads/feature"]);
}
#[tokio::test]
async fn keeps_the_branch_unless_asked() {
    let gh = Arc::new(MockGithub::default());
    let svc = service(gh.clone(), draft());
    let v = svc
        .handle("pulls.merge", json!({"repo":"o/r","number":1,"method":"squash","sha":"a".repeat(40),"delete_branch":false}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(v["branch_deleted"], false);
    assert_eq!(*gh.writes.lock(), ["PUT repos/o/r/pulls/1/merge"]);
}
#[tokio::test]
async fn refresh_puts_what_changed_in_the_inbox_once() {
    let gh = Arc::new(MockGithub::default());
    *gh.searches.lock() = vec![
        ("author%3A%40me", vec![1]),
        ("review-requested%3A%40me", vec![2]),
    ];
    let store: Arc<dyn Store> = Arc::new(MemoryStore::default());
    let start = || {
        let manager = Manager::new(store.clone(), vec![], None);
        ReviewService::new(
            store.clone(),
            gh.clone(),
            Arc::new(MockRunner),
            manager,
            std::env::temp_dir(),
        )
        .unwrap()
    };
    let svc = start();
    let mut rx = svc.events.subscribe();
    let activity = |rx: &mut broadcast::Receiver<Value>| {
        let mut out = vec![];
        while let Ok(v) = rx.try_recv() {
            if v["method"] == "pulls.activity" {
                out.extend(v["params"]["changes"].as_array().unwrap().iter().map(|c| {
                    (
                        c["pull_id"].as_str().unwrap().to_string(),
                        c["summary"].as_str().unwrap().to_string(),
                    )
                }));
            }
        }
        out.sort();
        out
    };
    svc.refresh().await.unwrap();
    assert!(
        activity(&mut rx).is_empty(),
        "the first refresh is a baseline"
    );
    assert_eq!(
        gh.reads.load(Ordering::SeqCst),
        1,
        "no read beyond the batched one"
    );

    *gh.head.lock() = "c".repeat(40);
    svc.refresh().await.unwrap();
    assert_eq!(
        activity(&mut rx),
        vec![
            ("o/r#1".into(), "1 new commit".into()),
            ("o/r#2".into(), "1 new commit".into())
        ]
    );
    let entries: Vec<PullChange> = serde_json::from_value(
        svc.handle("pulls.changes", json!({}))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(entries.len(), 2);
    let mut roles: Vec<_> = entries
        .iter()
        .map(|e| (e.number, e.role.as_str()))
        .collect();
    roles.sort();
    assert_eq!(roles, vec![(1, "authored"), (2, "requested")]);

    // A restarted daemon has nothing new to say.
    let svc = start();
    let mut rx = svc.events.subscribe();
    svc.refresh().await.unwrap();
    assert!(activity(&mut rx).is_empty());

    svc.handle("pulls.changes.read", json!({"ids": [entries[0].id]}))
        .await
        .unwrap();
    let after: Vec<PullChange> = serde_json::from_value(
        svc.handle("pulls.changes", json!({}))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(after.iter().filter(|e| e.read).count(), 1);

    // #1 is merged by someone else: it leaves the search and is read once more in the same query.
    *gh.searches.lock() = vec![("review-requested%3A%40me", vec![2])];
    *gh.state.lock() = ("MERGED".into(), "bob".into());
    let reads = gh.reads.load(Ordering::SeqCst);
    svc.refresh().await.unwrap();
    assert_eq!(gh.reads.load(Ordering::SeqCst), reads + 1);
    assert_eq!(
        activity(&mut rx),
        vec![
            ("o/r#1".into(), "merged by bob".into()),
            ("o/r#2".into(), "merged by bob".into())
        ]
    );
    svc.refresh().await.unwrap();
    assert!(activity(&mut rx).is_empty());
    svc.handle("pulls.changes.read", json!({})).await.unwrap();
    let after: Vec<PullChange> = serde_json::from_value(
        svc.handle("pulls.changes", json!({}))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(after.iter().all(|e| e.read));
}
