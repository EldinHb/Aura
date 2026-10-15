//! GitHub transport. Only the daemon invokes gh; credentials never reach the webview.
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use aura_core::{
    LatestReview, Note, PullActivity, PullRequest, RequestedReviewer, SubmittedReview,
};
use futures::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

/// Each reviewer's latest review and their latest approval or change request, as a
/// GraphQL selection on a pull request; read with [`reviews_by_others`].
macro_rules! reviews_query {
    () => {
        "latestReviews(first:100){nodes{databaseId state submittedAt author{__typename login} commit{oid}}} latestOpinionatedReviews(first:100){nodes{state author{login}}}"
    };
}
pub mod branch;
pub mod issues;
pub mod timeline;
pub use timeline::timeline;

#[async_trait]
pub trait Github: Send + Sync {
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value>;
    async fn request_for(
        &self,
        account: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if self.account().await? != account {
            return Err(RejectedRequest("GitHub account changed".into()).into());
        }
        self.request(method, path, body).await
    }
    async fn diff(&self, repo: &str, base: &str, head: &str) -> Result<String>;
    fn host(&self) -> &str;
    async fn account(&self) -> Result<String> {
        let user = self.request("GET", "user", None).await?;
        let login = user["login"]
            .as_str()
            .context("GitHub did not return an account")?;
        Ok(format!("{}:{login}", self.host()))
    }
}
#[derive(Debug)]
pub struct RejectedRequest(pub String);
impl std::fmt::Display for RejectedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RejectedRequest {}
pub struct GhCli {
    host: String,
}
impl Default for GhCli {
    fn default() -> Self {
        Self {
            host: "github.com".into(),
        }
    }
}
/// Concurrent gh calls across the daemon. GitHub's secondary rate limit punishes
/// bursts, and a refresh fans out over every listed PR.
const MAX_CONCURRENT: usize = 4;
/// How long GitHub is left alone after it reports a rate limit; its docs ask for at least a minute.
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);
/// Waits before retrying a read that failed with a GitHub server error.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];

/// Paces every gh call. Shared by all [`GhCli`]s, since they spend one account's limits.
struct Gate {
    slots: tokio::sync::Semaphore,
    paused_until: std::sync::Mutex<Option<std::time::Instant>>,
    pause: Duration,
    retry_delays: &'static [Duration],
}
static GATE: Gate = Gate::new(MAX_CONCURRENT, RATE_LIMIT_PAUSE, &RETRY_DELAYS);

impl Gate {
    const fn new(slots: usize, pause: Duration, retry_delays: &'static [Duration]) -> Self {
        Self {
            slots: tokio::sync::Semaphore::const_new(slots),
            paused_until: std::sync::Mutex::new(None),
            pause,
            retry_delays,
        }
    }

    /// Run `call`, retrying server errors when `retry` says the request is safe to
    /// repeat. After a rate limit every request is refused unsent until the pause ends.
    async fn run<F, Fut>(&self, retry: bool, mut call: F) -> Result<String>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        let mut attempt = 0;
        loop {
            if let Some(until) = *self.paused_until.lock().unwrap() {
                let left = until.saturating_duration_since(std::time::Instant::now());
                if !left.is_zero() {
                    let at = chrono::Local::now() + left;
                    return Err(RejectedRequest(format!(
                        "GitHub rate limit reached; Aura resumes GitHub requests at {}",
                        at.format("%H:%M:%S")
                    ))
                    .into());
                }
            }
            let result = {
                let _slot = self.slots.acquire().await?;
                call().await
            };
            let Err(e) = &result else { return result };
            let message = format!("{e:#}");
            if is_rate_limited(&message) {
                *self.paused_until.lock().unwrap() = Some(std::time::Instant::now() + self.pause);
                return result;
            }
            match self.retry_delays.get(attempt) {
                Some(delay) if retry && is_server_error(&message) => {
                    tracing::debug!("GitHub server error, retrying in {delay:?}: {message}");
                    tokio::time::sleep(*delay).await;
                    attempt += 1;
                }
                _ => return result,
            }
        }
    }
}

/// gh reports primary, secondary and GraphQL limits with these words.
fn is_rate_limited(message: &str) -> bool {
    message.to_ascii_lowercase().contains("rate limit")
}

fn is_server_error(message: &str) -> bool {
    ["HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"]
        .iter()
        .any(|status| message.contains(status))
}

/// gh fails a GraphQL query that reports any error, even when GitHub still answered the rest
/// of it. Such a partial answer is kept; callers read its `errors`.
fn has_data(stdout: &[u8]) -> bool {
    serde_json::from_slice::<Value>(stdout).is_ok_and(|v| v["data"].is_object())
}

/// Reads can be repeated. A write that failed with a server error may still have
/// been applied, so it is never retried.
fn is_read(method: &str, path: &str, body: Option<&Value>) -> bool {
    if path == "graphql" {
        return !body
            .and_then(|b| b["query"].as_str())
            .is_some_and(|q| q.trim_start().starts_with("mutation"));
    }
    method.eq_ignore_ascii_case("GET")
}

impl GhCli {
    async fn invoke(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        diff: bool,
        token: Option<&str>,
    ) -> Result<String> {
        let retry = is_read(method, path, body.as_ref());
        GATE.run(retry, || {
            self.invoke_once(method, path, body.clone(), diff, token)
        })
        .await
    }

    async fn invoke_once(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        diff: bool,
        token: Option<&str>,
    ) -> Result<String> {
        let bin = aura_core::which::find_binary("gh", "AURA_GH_BIN", &[])
            .context("Install GitHub CLI and run gh auth login to connect pull requests.")?;
        let mut cmd = Command::new(bin);
        if let Some(token) = token {
            cmd.env("GH_TOKEN", token).env_remove("GITHUB_TOKEN");
        }
        cmd.args(["api", "--hostname", &self.host, "--method", method, path]);
        if diff {
            cmd.args(["-H", "Accept: application/vnd.github.diff"]);
        }
        if body.is_some() {
            cmd.args(["--input", "-"]);
        }
        cmd.env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let (mut child, _process_group) =
            aura_core::process::spawn_job(&mut cmd).context("Start GitHub CLI")?;
        if let Some(body) = body {
            let mut stdin = child.stdin.take().context("GitHub input")?;
            stdin.write_all(&serde_json::to_vec(&body)?).await?;
        } else {
            drop(child.stdin.take());
        }
        let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
            .await
            .context("GitHub request timed out")??;
        let partial = path == "graphql" && has_data(&output.stdout);
        if !output.status.success() && !partial {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if [
                "HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404", "HTTP 405", "HTTP 422", "HTTP 429",
            ]
            .iter()
            .any(|status| message.contains(status))
            {
                return Err(RejectedRequest(message).into());
            }
            bail!("{message}");
        }
        Ok(String::from_utf8(output.stdout)?)
    }
}
#[async_trait]
impl Github for GhCli {
    fn host(&self) -> &str {
        &self.host
    }
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let raw = self.invoke(method, path, body, false, None).await?;
        if raw.trim().is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_str(&raw)?)
        }
    }
    async fn request_for(
        &self,
        account: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        // Resolve and validate a token for the reviewed identity, then pin it to
        // the actual mutation. Switching gh accounts between requests cannot
        // cause a review to be posted as a different person.
        let token = async {
            let (host, login) = account.split_once(':').context("Invalid GitHub account")?;
            if host != self.host {
                bail!("Wrong GitHub host");
            }
            let bin = aura_core::which::find_binary("gh", "AURA_GH_BIN", &[])
                .context("GitHub CLI unavailable")?;
            let mut cmd = Command::new(bin);
            cmd.args(["auth", "token", "--hostname", host, "--user", login])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let (child, _group) = aura_core::process::spawn_job(&mut cmd)?;
            let output =
                tokio::time::timeout(Duration::from_secs(15), child.wait_with_output()).await??;
            if !output.status.success() {
                bail!("Sign in to the review's GitHub account again");
            }
            let token = String::from_utf8(output.stdout)?.trim().to_string();
            let user: Value = serde_json::from_str(
                &self
                    .invoke("GET", "user", None, false, Some(&token))
                    .await?,
            )?;
            if user["login"].as_str() != Some(login) {
                bail!("GitHub credentials do not match the reviewed account");
            }
            Ok::<_, anyhow::Error>(token)
        }
        .await
        .map_err(|e| RejectedRequest(e.to_string()))?;
        let raw = self.invoke(method, path, body, false, Some(&token)).await?;
        Ok(if raw.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&raw)?
        })
    }
    async fn diff(&self, repo: &str, base: &str, head: &str) -> Result<String> {
        validate_repo(repo)?;
        validate_sha(base)?;
        validate_sha(head)?;
        self.invoke(
            "GET",
            &format!("repos/{repo}/compare/{base}...{head}"),
            None,
            true,
            None,
        )
        .await
    }
}
pub fn validate_repo(repo: &str) -> Result<()> {
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        bail!("Invalid repository");
    }
    Ok(())
}
pub fn validate_sha(sha: &str) -> Result<()> {
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("Invalid commit SHA");
    }
    Ok(())
}
pub async fn pages(gh: &dyn Github, path: &str) -> Result<Vec<Value>> {
    let mut all = vec![];
    for page in 1..=1000 {
        let sep = if path.contains('?') { '&' } else { '?' };
        let data = gh
            .request("GET", &format!("{path}{sep}per_page=100&page={page}"), None)
            .await?;
        let rows = data.as_array().context("Expected a GitHub list")?;
        all.extend(rows.iter().cloned());
        if rows.len() < 100 {
            return Ok(all);
        }
    }
    bail!("GitHub pagination limit exceeded; previous cache retained")
}
/// One pull request, read like [`pulls`] reads many.
pub async fn pull(gh: &dyn Github, account: &str, repo: &str, number: u32) -> Result<PullRequest> {
    pulls(gh, account, &[(repo.to_string(), number)])
        .await?
        .pop()
        .context("GitHub returned no pull request")?
}
/// PRs read per GraphQL query.
const BATCH: usize = 20;
/// Read the PRs `ids` (`owner/repo`, number) in order, a batch per GraphQL query. A PR GitHub
/// cannot return fails on its own, so the rest of its batch still reads; a query that fails as
/// a whole fails the read.
pub async fn pulls(
    gh: &dyn Github,
    account: &str,
    ids: &[(String, u32)],
) -> Result<Vec<Result<PullRequest>>> {
    for (repo, _) in ids {
        validate_repo(repo)?;
    }
    let login = account.split_once(':').map_or(account, |(_, login)| login);
    // Owned chunks: a closure over borrowed slices makes the future unusable from tokio::spawn.
    let batches: Vec<_> = stream::iter(ids.chunks(BATCH).map(<[_]>::to_vec))
        .map(|chunk| async move { batch(gh, account, login, &chunk).await })
        .buffered(3)
        .try_collect()
        .await?;
    Ok(batches.into_iter().flatten().collect())
}
/// One query for `ids`: an aliased `repository` per repo (`r0`, `r1`, …) holding an aliased
/// `pullRequest` per PR (`pr0`, `pr1`, … by position in `ids`).
async fn batch(
    gh: &dyn Github,
    account: &str,
    login: &str,
    ids: &[(String, u32)],
) -> Result<Vec<Result<PullRequest>>> {
    let mut repos: Vec<&str> = vec![];
    for (repo, _) in ids {
        if !repos.iter().any(|r| r.eq_ignore_ascii_case(repo)) {
            repos.push(repo);
        }
    }
    let repo_of = |repo: &str| {
        repos
            .iter()
            .position(|r| r.eq_ignore_ascii_case(repo))
            .unwrap()
    };
    let mut query = String::from("query($login:String!){");
    for (i, repo) in repos.iter().enumerate() {
        // validate_repo allows no quotes or braces, so the names are safe to inline.
        let (owner, name) = repo.split_once('/').context("Invalid repository")?;
        query += &format!("r{i}:repository(owner:\"{owner}\",name:\"{name}\"){{{REPO}");
        for (j, (_, number)) in ids.iter().enumerate().filter(|(_, (r, _))| repo_of(r) == i) {
            query += &format!(" pr{j}:pullRequest(number:{number}){{...pull}}");
        }
        query += "}";
    }
    query += "}";
    query += PULL;
    let q = gh
        .request(
            "POST",
            "graphql",
            Some(json!({"query": query, "variables": {"login": login}})),
        )
        .await?;
    if !q["data"].is_object() {
        bail!("Unable to read pull requests: {}", q["errors"]);
    }
    let errors = q["errors"].as_array().cloned().unwrap_or_default();
    Ok(ids
        .iter()
        .enumerate()
        .map(|(j, (repo, number))| {
            let (r, pr) = (format!("r{}", repo_of(repo)), format!("pr{j}"));
            // An error on the repository itself, or anywhere inside this PR, fails this PR.
            let error = errors.iter().find(|e| {
                let path = &e["path"];
                path[0] == r.as_str()
                    && path[1]
                        .as_str()
                        .is_none_or(|seg| seg == pr || !is_pull_alias(seg))
            });
            if let Some(e) = error {
                bail!(
                    "Unable to read {repo}#{number}: {}",
                    e["message"].as_str().unwrap_or("GitHub returned an error")
                );
            }
            let node = &q["data"][&r][&pr];
            if !node.is_object() {
                bail!("Unable to read {repo}#{number}: not found");
            }
            Ok(from_graphql(
                account,
                login,
                repo,
                *number,
                &q["data"][&r],
                node,
            ))
        })
        .collect())
}
fn is_pull_alias(seg: &str) -> bool {
    seg.strip_prefix("pr")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}
fn from_graphql(
    account: &str,
    login: &str,
    repo: &str,
    number: u32,
    r: &Value,
    d: &Value,
) -> PullRequest {
    let names = |conn: &Value, field: &str| {
        conn["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n[field].as_str().map(String::from))
            .collect()
    };
    let mut p = PullRequest {
        id: format!("{repo}#{number}"),
        account: account.into(),
        repo: repo.into(),
        number,
        title: s(d, "title"),
        body: s(d, "body"),
        url: s(d, "url"),
        author: s(&d["author"], "login"),
        state: s(d, "state").to_lowercase(),
        draft: d["isDraft"].as_bool().unwrap_or(false),
        base_ref: s(d, "baseRefName"),
        head_ref: s(d, "headRefName"),
        base_sha: s(d, "baseRefOid"),
        head_sha: s(d, "headRefOid"),
        created_at: s(d, "createdAt"),
        updated_at: s(d, "updatedAt"),
        additions: d["additions"].as_u64().unwrap_or(0) as u32,
        deletions: d["deletions"].as_u64().unwrap_or(0) as u32,
        changed_files: d["changedFiles"].as_u64().unwrap_or(0) as u32,
        assignees: names(&d["assignees"], "login"),
        labels: names(&d["labels"], "name"),
        milestone: d["milestone"]["number"].as_u64().map(|n| n as u32),
        milestone_title: s(&d["milestone"], "title"),
        can_edit: d["viewerCanUpdate"].as_bool().unwrap_or(false),
        review_decision: s(d, "reviewDecision"),
        checks: s(
            &d["commits"]["nodes"][0]["commit"]["statusCheckRollup"],
            "state",
        ),
        ..Default::default()
    };
    let review = &d["reviews"]["nodes"][0];
    p.my_review = review["submittedAt"]
        .as_str()
        .map(|submitted_at| SubmittedReview {
            reviewer: login.into(),
            state: s(review, "state"),
            submitted_at: submitted_at.into(),
            commit_sha: s(&review["commit"], "oid"),
            bot: false,
        });
    p.reviews = reviews_by_others(d, &[&p.author, login]);
    p.requested = requested_reviewers(&d["reviewRequests"]["nodes"]);
    p.unanswered_threads = unanswered_threads(&d["reviewThreads"]["nodes"], login);
    p.review_requested_at = requested_at(&d["timelineItems"]["nodes"], login);
    p.merge_state = s(d, "mergeStateStatus");
    p.merge_methods = [
        ("merge", "mergeCommitAllowed"),
        ("squash", "squashMergeAllowed"),
        ("rebase", "rebaseMergeAllowed"),
    ]
    .into_iter()
    .filter(|(_, allowed)| r[*allowed] == true)
    .map(|(method, _)| method.to_string())
    .collect();
    p.default_merge_method = s(r, "viewerDefaultMergeMethod").to_lowercase();
    p.can_merge = matches!(
        r["viewerPermission"].as_str(),
        Some("WRITE" | "MAINTAIN" | "ADMIN")
    );
    p.can_delete_branch = p.can_merge && d["isCrossRepository"] == false;
    p.auto_delete_branch = r["deleteBranchOnMerge"] == true;
    p.merge_blocked_by = p.merge_blocker().map(String::from);
    p.activity = activity(d);
    p
}
/// Who did what lately on the PR in `d`, to tell what changed since the previous read.
fn activity(d: &Value) -> PullActivity {
    let nodes = |v: &Value| v["nodes"].as_array().cloned().unwrap_or_default();
    let note = |n: &Value| {
        let author = s(&n["author"], "login");
        Some(Note {
            id: n["databaseId"].as_u64()?,
            bot: n["author"]["__typename"] == "Bot" || author.ends_with("[bot]"),
            author,
        })
    };
    let head = &d["commits"]["nodes"][0]["commit"];
    let state_actor = match s(d, "state").as_str() {
        "MERGED" => s(&d["mergedBy"], "login"),
        _ => s(&d["stateEvents"]["nodes"][0]["actor"], "login"),
    };
    PullActivity {
        commits: d["commits"]["totalCount"].as_u64().unwrap_or(0) as u32,
        pushed_by: [&head["author"], &head["committer"]]
            .into_iter()
            .map(|who| s(&who["user"], "login"))
            .filter(|login| !login.is_empty())
            .collect(),
        comments: nodes(&d["comments"]).iter().filter_map(note).collect(),
        thread_comments: nodes(&d["reviewThreads"])
            .iter()
            .flat_map(|t| nodes(&t["comments"]))
            .filter_map(|n| note(&n))
            .collect(),
        reviews: nodes(&d["latestReviews"])
            .iter()
            .filter_map(|n| {
                let note = note(n)?;
                Some(LatestReview {
                    id: note.id,
                    reviewer: note.author,
                    bot: note.bot,
                    state: s(n, "state"),
                })
            })
            .collect(),
        state_actor,
    }
}
/// Merge `p` with `method` as `account`. GitHub refuses when the head moved past
/// `p.head_sha`, so only the commits that were shown are merged.
pub async fn merge(gh: &dyn Github, account: &str, p: &PullRequest, method: &str) -> Result<Value> {
    validate_repo(&p.repo)?;
    validate_sha(&p.head_sha)?;
    gh.request_for(
        account,
        "PUT",
        &format!("repos/{}/pulls/{}/merge", p.repo, p.number),
        Some(json!({"merge_method": method, "sha": p.head_sha})),
    )
    .await
}

/// Delete the head branch of a merged `p`. A branch that is already gone, for
/// example because the repository deletes merged branches itself, counts as deleted.
pub async fn delete_branch(gh: &dyn Github, account: &str, p: &PullRequest) -> Result<()> {
    validate_repo(&p.repo)?;
    let path = format!("repos/{}/git/refs/heads/{}", p.repo, ref_path(&p.head_ref)?);
    match gh.request_for(account, "DELETE", &path, None).await {
        Ok(_) => Ok(()),
        Err(e) if format!("{e:#}").contains("Reference does not exist") => Ok(()),
        Err(e) => Err(e),
    }
}

/// A branch name as a REST path: each segment percent-encoded, `/` kept.
fn ref_path(branch: &str) -> Result<String> {
    if branch.is_empty()
        || branch
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        bail!("Invalid branch name");
    }
    Ok(branch
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect())
}
/// What a merge may do, read once per repository in a batch.
const REPO: &str = "viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod deleteBranchOnMerge";
/// A PR with your latest review, who reviewed and was asked to, open review threads, and who
/// last pushed, commented, merged or closed it.
const PULL: &str = concat!(
    "fragment pull on PullRequest{number title body url author{login} state isDraft baseRefName headRefName baseRefOid headRefOid createdAt updatedAt additions deletions changedFiles assignees(first:20){nodes{login}} labels(first:50){nodes{name}} milestone{number title} ",
    "viewerCanUpdate reviewDecision mergeStateStatus isCrossRepository mergedBy{login} commits(last:1){totalCount nodes{commit{statusCheckRollup{state} author{user{login}} committer{user{login}}}}} reviews(last:1,author:$login,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{state submittedAt commit{oid}}} ",
    "timelineItems(last:50,itemTypes:[REVIEW_REQUESTED_EVENT]){nodes{... on ReviewRequestedEvent{createdAt requestedReviewer{__typename ... on User{login}}}}} ",
    "reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}}} ",
    "reviewThreads(first:100){nodes{isResolved comments(last:3){nodes{databaseId author{__typename login}}}}} ",
    "comments(last:20){nodes{databaseId author{__typename login}}} ",
    "stateEvents:timelineItems(last:1,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){nodes{... on ClosedEvent{actor{login}} ... on ReopenedEvent{actor{login}}}} ",
    reviews_query!(),
    "}"
);
/// Who has reviewed the PR in `pull` (GraphQL, queried with `reviews_query!()`), skipping `skip`
/// (the author, whose replies to threads are comment-only reviews too). A reviewer's verdict
/// is their latest approval or change request, else a comment.
pub fn reviews_by_others(pull: &Value, skip: &[&str]) -> Vec<SubmittedReview> {
    const RESPONSES: [&str; 3] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];
    let opinion = |login: &str| {
        pull["latestOpinionatedReviews"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|n| {
                n["author"]["login"]
                    .as_str()
                    .is_some_and(|l| l.eq_ignore_ascii_case(login))
            })
            .map(|n| s(n, "state"))
            .filter(|state| RESPONSES.contains(&state.as_str()))
    };
    pull["latestReviews"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| RESPONSES.contains(&n["state"].as_str().unwrap_or_default()))
        .filter_map(|n| {
            let reviewer = s(&n["author"], "login");
            if reviewer.is_empty() || skip.iter().any(|l| l.eq_ignore_ascii_case(&reviewer)) {
                return None;
            }
            Some(SubmittedReview {
                state: opinion(&reviewer).unwrap_or_else(|| s(n, "state")),
                submitted_at: s(n, "submittedAt"),
                commit_sha: s(&n["commit"], "oid"),
                bot: n["author"]["__typename"] == "Bot" || reviewer.ends_with("[bot]"),
                reviewer,
            })
        })
        .collect()
}
/// Pending review requests: users, teams as `org/team`, and bots.
fn requested_reviewers(nodes: &Value) -> Vec<RequestedReviewer> {
    nodes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let who = &n["requestedReviewer"];
            let (name, kind) = match who["__typename"].as_str()? {
                "Team" => (s(who, "combinedSlug"), "team"),
                "Bot" => (s(who, "login"), "bot"),
                _ => (s(who, "login"), "user"),
            };
            (!name.is_empty()).then(|| RequestedReviewer {
                name,
                kind: kind.into(),
            })
        })
        .collect()
}
/// Open review threads whose latest comment is a person's other than `login`; a bot's
/// remark does not wait on you.
fn unanswered_threads(threads: &Value, login: &str) -> u32 {
    threads
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["isResolved"] == false)
        .filter(|t| {
            let author = &t["comments"]["nodes"]
                .as_array()
                .and_then(|c| c.last())
                .unwrap_or(&Value::Null)["author"];
            author["__typename"] != "Bot"
                && author["login"]
                    .as_str()
                    .is_some_and(|l| !l.is_empty() && !l.eq_ignore_ascii_case(login))
        })
        .count() as u32
}
/// The latest request addressed to `login` or to a team. Team membership is not
/// resolved, so a request to any team counts.
fn requested_at(events: &Value, login: &str) -> Option<String> {
    events
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| {
            let who = &e["requestedReviewer"];
            who["__typename"] == "Team"
                || who["login"]
                    .as_str()
                    .is_some_and(|l| l.eq_ignore_ascii_case(login))
        })
        .filter_map(|e| e["createdAt"].as_str())
        .max()
        .map(String::from)
}
pub fn s(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

/// Open PRs that request the user's review, as (`owner/repo`, number) for [`pulls`].
pub async fn requested(gh: &dyn Github) -> Result<Vec<(String, u32)>> {
    search(gh, "review-requested%3A%40me", "inbox").await
}

/// Open PRs of others the user reviewed.
pub async fn reviewed(gh: &dyn Github) -> Result<Vec<(String, u32)>> {
    search(
        gh,
        "reviewed-by%3A%40me%20-author%3A%40me",
        "list of reviewed pull requests",
    )
    .await
}

/// Open PRs the user authored.
pub async fn authored(gh: &dyn Github) -> Result<Vec<(String, u32)>> {
    search(gh, "author%3A%40me", "list of your pull requests").await
}

async fn search(gh: &dyn Github, filter: &str, what: &str) -> Result<Vec<(String, u32)>> {
    let mut ids = vec![];
    for page in 1..=10 {
        let response=gh.request("GET",&format!("search/issues?q=is%3Apr%20is%3Aopen%20archived%3Afalse%20{filter}&per_page=100&page={page}"),None).await?;
        if response["incomplete_results"] == true
            || response["total_count"].as_u64().unwrap_or(0) > 1000
        {
            bail!("GitHub returned an incomplete {what}; cached {what} retained");
        }
        let rows = response["items"]
            .as_array()
            .context("Invalid search response")?;
        for row in rows {
            let url = s(row, "repository_url");
            let repo = url
                .split("/repos/")
                .nth(1)
                .context("Invalid repository URL")?
                .to_string();
            let number = row["number"].as_u64().context("Missing PR number")? as u32;
            ids.push((repo, number));
        }
        if rows.len() < 100 {
            break;
        }
    }
    Ok(ids)
}

/// Project associations and fields are cursor-paginated separately from REST conversation lists.
pub async fn projects(gh: &dyn Github, p: &PullRequest) -> Result<Vec<Value>> {
    let (owner, name) = p.repo.split_once('/').context("Invalid repository")?;
    let mut cursor = Value::Null;
    let mut result = vec![];
    loop {
        let data=gh.request("POST","graphql",Some(json!({"query": PROJECTS, "variables":{"owner":owner,"name":name,"number":p.number,"cursor":cursor}}))).await?;
        if data.get("errors").is_some() {
            bail!("Project fields unavailable: {}", data["errors"]);
        }
        let conn = &data["data"]["repository"]["pullRequest"]["projectItems"];
        for item in conn["nodes"].as_array().into_iter().flatten() {
            let mut item = item.clone();
            let mut fields = item["fieldValues"]["nodes"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut page = item["fieldValues"]["pageInfo"].clone();
            while page["hasNextPage"] == true {
                let r=gh.request("POST","graphql",Some(json!({"query":FIELD_PAGE,"variables":{"id":item["id"],"cursor":page["endCursor"]}}))).await?;
                if r.get("errors").is_some() {
                    bail!("Project field pagination failed: {}", r["errors"]);
                }
                let c = &r["data"]["node"]["fieldValues"];
                fields.extend(c["nodes"].as_array().cloned().unwrap_or_default());
                page = c["pageInfo"].clone();
            }
            let mut definition_cursor = Value::Null;
            loop {
                let definitions = gh.request("POST", "graphql", Some(json!({"query": PROJECT_FIELDS, "variables": {"id": item["project"]["id"], "cursor": definition_cursor}}))).await?;
                if definitions.get("errors").is_some() {
                    bail!("Project fields unavailable: {}", definitions["errors"]);
                }
                let connection = &definitions["data"]["node"]["fields"];
                for field in connection["nodes"].as_array().into_iter().flatten() {
                    if field.get("id").is_some()
                        && !fields
                            .iter()
                            .any(|value| value["field"]["id"] == field["id"])
                    {
                        fields.push(json!({"field":field}));
                    }
                }
                if connection["pageInfo"]["hasNextPage"] != true {
                    break;
                }
                definition_cursor = connection["pageInfo"]["endCursor"].clone();
            }
            item["fieldValues"] = json!(fields);
            result.push(item);
        }
        if conn["pageInfo"]["hasNextPage"] != true {
            break;
        }
        cursor = conn["pageInfo"]["endCursor"].clone();
    }
    Ok(result)
}
const PROJECTS: &str = r#"query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){projectItems(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id project{id title viewerCanUpdate} fieldValues(first:100){pageInfo{hasNextPage endCursor} nodes{...F}}}}}}}
fragment F on ProjectV2ItemFieldValue { ... on ProjectV2ItemFieldTextValue {text field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name dataType options{id name}}}} ... on ProjectV2ItemFieldIterationValue{title iterationId field{... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}"#;
const FIELD_PAGE: &str = r#"query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2Item{fieldValues(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name dataType options{id name}}}} ... on ProjectV2ItemFieldIterationValue{title iterationId field{... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}}}}}"#;

const PROJECT_FIELDS: &str = r#"query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{fields(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}} ... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}}}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Paginated {
        count: AtomicUsize,
        fail_second: bool,
    }
    #[async_trait]
    impl Github for Paginated {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, _: &str, _: &str, _: Option<Value>) -> Result<Value> {
            let page = self.count.fetch_add(1, Ordering::SeqCst);
            if page == 1 && self.fail_second {
                bail!("rate limited");
            }
            Ok(json!(if page == 0 {
                vec![json!({"id":1}); 100]
            } else {
                vec![json!({"id":2})]
            }))
        }
    }
    #[tokio::test]
    async fn reads_all_pages() {
        let gh = Paginated {
            count: AtomicUsize::new(0),
            fail_second: false,
        };
        assert_eq!(
            pages(&gh, "repos/o/r/issues/1/comments")
                .await
                .unwrap()
                .len(),
            101
        );
        assert_eq!(gh.count.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn partial_pages_are_not_reported_as_complete() {
        let gh = Paginated {
            count: AtomicUsize::new(0),
            fail_second: true,
        };
        assert!(pages(&gh, "repos/o/r/issues/1/comments").await.is_err());
    }
    #[test]
    fn review_requests_count_when_addressed_to_you_or_a_team() {
        let events = json!([
            {"createdAt":"2026-10-01T09:00:00Z","requestedReviewer":{"__typename":"User","login":"Alice"}},
            {"createdAt":"2026-10-03T09:00:00Z","requestedReviewer":{"__typename":"User","login":"bob"}},
            {"createdAt":"2026-10-02T09:00:00Z","requestedReviewer":{"__typename":"Team"}},
        ]);
        assert_eq!(
            requested_at(&events, "alice").as_deref(),
            Some("2026-10-02T09:00:00Z")
        );
        assert_eq!(requested_at(&json!([events[1]]), "alice"), None);
        assert_eq!(requested_at(&Value::Null, "alice"), None);
    }
    fn counting<'a>(
        calls: &'a AtomicUsize,
        failures: usize,
        message: &'static str,
    ) -> impl FnMut() -> std::future::Ready<Result<String>> + 'a {
        move || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(if n < failures {
                Err(anyhow::anyhow!(message))
            } else {
                Ok("ok".into())
            })
        }
    }
    const NO_WAIT: [Duration; 2] = [Duration::ZERO, Duration::ZERO];
    #[tokio::test]
    async fn retries_reads_that_hit_a_server_error() {
        let gate = Gate::new(4, Duration::from_secs(60), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        let r = gate.run(true, counting(&calls, 2, "gh: HTTP 504")).await;
        assert_eq!(r.unwrap(), "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(true, counting(&calls, 9, "gh: HTTP 502"))
            .await
            .is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "gives up after the last delay"
        );
    }
    #[tokio::test]
    async fn never_retries_writes_or_client_errors() {
        let gate = Gate::new(4, Duration::from_secs(60), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(false, counting(&calls, 1, "gh: HTTP 504"))
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(true, counting(&calls, 1, "gh: Not Found (HTTP 404)"))
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn pauses_every_request_after_a_rate_limit() {
        let gate = Gate::new(4, Duration::from_millis(50), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        let msg = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";
        assert!(gate.run(true, counting(&calls, 1, msg)).await.is_err());
        let refused = gate.run(true, counting(&calls, 0, "")).await.unwrap_err();
        assert!(
            refused.downcast_ref::<RejectedRequest>().is_some(),
            "refused unsent: {refused}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "nothing reaches GitHub while paused"
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(gate.run(true, counting(&calls, 0, "")).await.unwrap(), "ok");
    }
    #[test]
    fn only_reads_count_as_repeatable() {
        assert!(is_read("GET", "repos/o/r/pulls/1", None));
        assert!(!is_read(
            "POST",
            "repos/o/r/pulls/1/reviews",
            Some(&json!({}))
        ));
        assert!(is_read("POST", "graphql", Some(&json!({"query": PULL}))));
        assert!(!is_read(
            "POST",
            "graphql",
            Some(&json!({"query": " mutation($id:ID!){x}"}))
        ));
    }
    #[test]
    fn branch_paths_keep_slashes_and_encode_the_rest() {
        assert_eq!(ref_path("feat/login").unwrap(), "feat/login");
        assert_eq!(ref_path("fix/#12 a%b").unwrap(), "fix/%2312%20a%25b");
        for bad in ["", "a//b", "../main", "a/./b", "/a"] {
            assert!(ref_path(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn rejects_unsafe_repository_paths() {
        for repo in [
            "../repo",
            "owner/../repo",
            "owner/repo?token=x",
            "-owner/repo/extra",
        ] {
            assert!(validate_repo(repo).is_err());
        }
        assert!(validate_repo("owner/repo.name").is_ok());
    }

    #[test]
    fn comment_only_reviews_count_and_an_approval_outranks_a_later_comment() {
        let review = |login: &str, kind: &str, state: &str| json!({"state": state, "submittedAt": "2026-10-05T10:00:00Z", "author": {"__typename": kind, "login": login}, "commit": {"oid": "c1"}});
        let pull = json!({
            "latestReviews": {"nodes": [
                review("alice", "User", "COMMENTED"),
                review("bob", "User", "COMMENTED"),
                review("me", "User", "COMMENTED"),
                review("copilot-pull-request-reviewer", "Bot", "COMMENTED"),
                review("carol", "User", "PENDING"),
                review("dave", "User", "DISMISSED"),
            ]},
            "latestOpinionatedReviews": {"nodes": [{"state": "APPROVED", "author": {"login": "Bob"}}]},
        });
        let reviews = reviews_by_others(&pull, &["Me"]);
        assert_eq!(
            reviews.iter().map(|r| (r.reviewer.as_str(), r.state.as_str(), r.commit_sha.as_str(), r.bot)).collect::<Vec<_>>(),
            vec![("alice", "COMMENTED", "c1", false), ("bob", "APPROVED", "c1", false), ("copilot-pull-request-reviewer", "COMMENTED", "c1", true)],
            "the author's own replies, drafts and dismissed reviews are skipped; bots are kept and marked"
        );
        assert!(reviews_by_others(&json!({}), &[]).is_empty());
    }

    /// Answers batched PR queries from `repos` (`owner/repo` -> PR numbers that exist).
    struct Batched {
        queries: std::sync::Mutex<Vec<String>>,
        repos: Vec<(&'static str, Vec<u32>)>,
        fail: bool,
    }
    #[async_trait]
    impl Github for Batched {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, _: &str, path: &str, body: Option<Value>) -> Result<Value> {
            assert_eq!(path, "graphql");
            let body = body.unwrap();
            assert_eq!(body["variables"], json!({"login": "me"}));
            let query = body["query"].as_str().unwrap().to_string();
            self.queries.lock().unwrap().push(query.clone());
            if self.fail {
                return Ok(json!({"errors": [{"message": "Something went wrong"}]}));
            }
            let (mut data, mut errors) = (json!({}), vec![]);
            // r0:repository(owner:"o",name:"r"){… pr0:pullRequest(number:1){...pull} …}
            for part in query.split("repository(owner:\"").skip(1) {
                let alias = query[..query.find(&format!("repository(owner:\"{part}")).unwrap()]
                    .rsplit(['{', '}'])
                    .next()
                    .unwrap()
                    .trim_end_matches(':')
                    .to_string();
                let (owner, rest) = part.split_once("\",name:\"").unwrap();
                let name = rest.split('"').next().unwrap();
                let Some((_, numbers)) = self
                    .repos
                    .iter()
                    .find(|(r, _)| *r == format!("{owner}/{name}"))
                else {
                    data[&alias] = Value::Null;
                    errors.push(
                        json!({"path": [alias], "message": "Could not resolve to a Repository"}),
                    );
                    continue;
                };
                data[&alias] = json!({"viewerPermission": "WRITE", "squashMergeAllowed": true});
                for pr in rest.split(" pr").skip(1) {
                    let (index, rest) = pr.split_once(":pullRequest(number:").unwrap();
                    let number: u32 = rest.split(')').next().unwrap().parse().unwrap();
                    let key = format!("pr{index}");
                    if numbers.contains(&number) {
                        data[&alias][&key] = json!({"number": number, "title": format!("PR {number}"), "state": "OPEN", "author": {"login": "bob"}, "headRefOid": "h",
                        "reviewThreads": {"nodes": [
                            {"isResolved": false, "comments": {"nodes": [{"author": {"__typename": "User", "login": "alice"}}]}},
                            {"isResolved": false, "comments": {"nodes": [{"author": {"__typename": "User", "login": "me"}}]}},
                            {"isResolved": false, "comments": {"nodes": [{"author": {"__typename": "Bot", "login": "copilot"}}]}},
                            {"isResolved": true, "comments": {"nodes": [{"author": {"__typename": "User", "login": "alice"}}]}},
                        ]},
                        "reviewRequests": {"nodes": [
                            {"requestedReviewer": {"__typename": "User", "login": "carol"}},
                            {"requestedReviewer": {"__typename": "Team", "combinedSlug": "o/core"}},
                            {"requestedReviewer": {"__typename": "Bot", "login": "copilot"}},
                        ]}});
                    } else {
                        data[&alias][&key] = Value::Null;
                        errors.push(json!({"path": [alias, key], "message": format!("Could not resolve to a PullRequest with the number of {number}.")}));
                    }
                }
            }
            Ok(json!({"data": data, "errors": errors}))
        }
    }

    #[tokio::test]
    async fn reads_pull_requests_in_batches_of_one_query() {
        let ids: Vec<(String, u32)> = (1..=25)
            .map(|n| (if n % 2 == 0 { "o/r" } else { "o/other" }.to_string(), n))
            .collect();
        let gh = Batched {
            queries: Default::default(),
            repos: vec![("o/r", (1..=25).collect()), ("o/other", (1..=25).collect())],
            fail: false,
        };
        let pulls = pulls(&gh, "github.com:me", &ids).await.unwrap();
        assert_eq!(
            gh.queries.lock().unwrap().len(),
            2,
            "25 PRs take two queries of at most {BATCH}"
        );
        let pulls: Vec<_> = pulls.into_iter().map(Result::unwrap).collect();
        assert_eq!(
            pulls
                .iter()
                .map(|p| (p.repo.as_str(), p.number))
                .collect::<Vec<_>>(),
            ids.iter()
                .map(|(r, n)| (r.as_str(), *n))
                .collect::<Vec<_>>()
        );
        let p = &pulls[1];
        assert_eq!(
            (
                p.id.as_str(),
                p.title.as_str(),
                p.state.as_str(),
                p.author.as_str(),
                p.can_merge
            ),
            ("o/r#2", "PR 2", "open", "bob", true)
        );
        assert_eq!(
            p.unanswered_threads, 1,
            "your own last word, a bot's remark and resolved threads wait on no one"
        );
        assert_eq!(
            p.requested
                .iter()
                .map(|r| (r.name.as_str(), r.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("carol", "user"), ("o/core", "team"), ("copilot", "bot")]
        );
        let first = &gh.queries.lock().unwrap()[0];
        assert_eq!(
            first.matches("repository(").count(),
            2,
            "one repository block per repo"
        );
        assert!(first.contains("pr19:pullRequest(number:20)") && !first.contains("pr20:"));
    }

    #[tokio::test]
    async fn one_unreadable_pull_request_does_not_fail_its_batch() {
        let gh = Batched {
            queries: Default::default(),
            repos: vec![("o/r", vec![1, 3])],
            fail: false,
        };
        let ids = [
            ("o/r".to_string(), 1),
            ("o/r".to_string(), 2),
            ("o/gone".to_string(), 7),
            ("o/r".to_string(), 3),
        ];
        let pulls = pulls(&gh, "github.com:me", &ids).await.unwrap();
        assert_eq!(pulls[0].as_ref().unwrap().number, 1);
        assert_eq!(
            pulls[1].as_ref().unwrap_err().to_string(),
            "Unable to read o/r#2: Could not resolve to a PullRequest with the number of 2."
        );
        assert_eq!(
            pulls[2].as_ref().unwrap_err().to_string(),
            "Unable to read o/gone#7: Could not resolve to a Repository"
        );
        assert_eq!(pulls[3].as_ref().unwrap().number, 3);
        assert_eq!(
            pull(&gh, "github.com:me", "o/r", 3).await.unwrap().number,
            3
        );
        assert!(pull(&gh, "github.com:me", "o/r", 2).await.is_err());
    }

    #[tokio::test]
    async fn a_query_github_rejects_as_a_whole_fails_the_read() {
        let gh = Batched {
            queries: Default::default(),
            repos: vec![],
            fail: true,
        };
        assert!(pulls(&gh, "github.com:me", &[("o/r".into(), 1)])
            .await
            .unwrap_err()
            .to_string()
            .contains("Something went wrong"));
        assert!(
            pulls(&gh, "github.com:me", &[("o/../r".into(), 1)])
                .await
                .is_err(),
            "unsafe names never reach the query"
        );
    }

    #[test]
    fn reads_the_milestone_title() {
        let with = from_graphql(
            "a",
            "me",
            "o/r",
            1,
            &json!({}),
            &json!({"milestone": {"number": 4, "title": "Q4"}}),
        );
        assert_eq!(
            (with.milestone, with.milestone_title.as_str()),
            (Some(4), "Q4")
        );
        let without = from_graphql("a", "me", "o/r", 1, &json!({}), &json!({"milestone": null}));
        assert_eq!(
            (without.milestone, without.milestone_title.as_str()),
            (None, "")
        );
    }

    #[test]
    fn reads_who_pushed_commented_and_closed() {
        let user = |login: &str| json!({"__typename": if login.ends_with("[bot]") { "Bot" } else { "User" }, "login": login});
        let d = json!({
            "state": "CLOSED",
            "mergedBy": null,
            "stateEvents": {"nodes": [{"actor": {"login": "alice"}}]},
            "commits": {"totalCount": 4, "nodes": [{"commit": {"author": {"user": {"login": "bob"}}, "committer": {"user": null}}}]},
            "comments": {"nodes": [{"databaseId": 7, "author": user("carol")}, {"databaseId": 8, "author": user("ci[bot]")}, {"author": user("x")}]},
            "reviewThreads": {"nodes": [
                {"isResolved": false, "comments": {"nodes": [{"databaseId": 20, "author": user("alice")}, {"databaseId": 21, "author": user("me")}]}},
                {"isResolved": false, "comments": {"nodes": [{"databaseId": 30, "author": user("me")}, {"databaseId": 31, "author": user("dave")}]}},
            ]},
            "latestReviews": {"nodes": [{"databaseId": 99, "state": "COMMENTED", "author": user("alice")}]},
        });
        let a = activity(&d);
        assert_eq!(
            (a.commits, a.pushed_by.clone(), a.state_actor.as_str()),
            (4, vec!["bob".to_string()], "alice")
        );
        assert_eq!(
            a.comments,
            vec![
                Note {
                    id: 7,
                    author: "carol".into(),
                    bot: false
                },
                Note {
                    id: 8,
                    author: "ci[bot]".into(),
                    bot: true
                }
            ]
        );
        assert_eq!(
            a.thread_comments.iter().map(|n| n.id).collect::<Vec<_>>(),
            vec![20, 21, 30, 31]
        );
        assert_eq!(
            a.reviews,
            vec![LatestReview {
                id: 99,
                reviewer: "alice".into(),
                bot: false,
                state: "COMMENTED".into()
            }]
        );
        assert_eq!(
            unanswered_threads(&d["reviewThreads"]["nodes"], "me"),
            1,
            "a thread's latest comment decides"
        );
        let merged = json!({"state": "MERGED", "mergedBy": {"login": "me"}, "stateEvents": {"nodes": [{"actor": {"login": "alice"}}]}});
        assert_eq!(activity(&merged).state_actor, "me");
    }

    #[test]
    fn keeps_partial_graphql_answers_from_gh() {
        assert!(has_data(
            br#"{"data":{"r0":null},"errors":[{"message":"x"}]}"#
        ));
        assert!(!has_data(
            br#"{"data":null,"errors":[{"type":"RATE_LIMITED"}]}"#
        ));
        assert!(!has_data(b"gh: not json"));
    }
}
