//! Daemon-owned review jobs. All state transitions are serialized and persisted before publication.
pub mod diff;
pub mod runner;
pub mod watch;
use anyhow::{bail, Context, Result};
use aura_core::*;
use aura_github::{pages, pull, Github};
use parking_lot::Mutex;
use runner::{Progress, ReviewRunner};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{broadcast, Semaphore};

#[async_trait::async_trait]
pub trait ReviewWorkspace: Send + Sync {
    async fn prepare(&self, pull: &PullRequest, cwd: &std::path::Path) -> Result<(String, String)>;
}
struct GitWorkspace;
#[async_trait::async_trait]
impl ReviewWorkspace for GitWorkspace {
    async fn prepare(&self, pull: &PullRequest, cwd: &std::path::Path) -> Result<(String, String)> {
        aura_git::review::prepare(pull, cwd).await
    }
}

pub struct ReviewService {
    workspace: Arc<dyn ReviewWorkspace>,
    store: Arc<dyn Store>,
    gh: Arc<dyn Github>,
    runner: Arc<dyn ReviewRunner>,
    manager: Manager,
    state: Mutex<ReviewInbox>,
    gate: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    slots: Arc<Semaphore>,
    /// Bumped on every change made through Aura, so only the latest one schedules a resync.
    changes: AtomicU64,
    root: PathBuf,
    pub events: broadcast::Sender<Value>,
}
impl ReviewService {
    pub fn new(
        store: Arc<dyn Store>,
        gh: Arc<dyn Github>,
        runner: Arc<dyn ReviewRunner>,
        manager: Manager,
        root: PathBuf,
    ) -> Result<Arc<Self>> {
        let mut state = ReviewInbox {
            defaults: ReviewConfig {
                provider: "codex".into(),
                prompt_mode: "default".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        if let Some(raw) = store.get_setting("reviews.inbox")? {
            state = serde_json::from_str(&raw)?;
        }
        state.reviews = store
            .feature_records("reviews")?
            .into_iter()
            .map(|(_, s)| serde_json::from_str(&s))
            .collect::<Result<Vec<_>, _>>()?;
        for r in &mut state.reviews {
            if r.status == "running" {
                r.status = "failed".into();
                r.error = Some("Interrupted when the daemon stopped. Run again to retry.".into());
            }
            if r.status == "submitting" {
                r.status = "uncertain".into();
                r.error = Some("Submission interrupted; reconcile before retrying.".into());
            }
            store.save_feature_record("reviews", &r.id, &serde_json::to_string(r)?)?;
        }
        let (events, _) = broadcast::channel(128);
        Ok(Arc::new(Self {
            workspace: Arc::new(GitWorkspace),
            store,
            gh,
            runner,
            manager,
            state: Mutex::new(state),
            gate: tokio::sync::Mutex::new(()),
            jobs: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(2)),
            changes: AtomicU64::new(0),
            root,
            events,
        }))
    }
    pub fn launch(self: &Arc<Self>) {
        let queued: Vec<_> = self
            .state
            .lock()
            .reviews
            .iter()
            .filter(|r| r.status == "queued")
            .map(|r| r.id.clone())
            .collect();
        for id in queued {
            self.enqueue(id);
        }
        let svc = self.clone();
        tokio::spawn(async move {
            let mut delay = 60;
            loop {
                if svc.refresh().await.is_err() {
                    delay = (delay * 2).min(900);
                } else {
                    delay = 60;
                }
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
        });
    }
    pub fn shutdown(&self) {
        for (_, job) in self.jobs.lock().drain() {
            job.abort();
        }
    }
    fn emit(&self) {
        let _ = self
            .events
            .send(json!({"method":"reviews.changed","params":{}}));
    }
    fn persist_inbox(&self) -> Result<()> {
        let mut s = self.state.lock().clone();
        s.reviews.clear();
        self.store
            .set_setting("reviews.inbox", &serde_json::to_string(&s)?)
    }
    fn get(&self, id: &str) -> Result<PreReview> {
        self.state
            .lock()
            .reviews
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .context("Review not found")
    }
    fn change(&self, id: &str, f: impl FnOnce(&mut PreReview) -> Result<()>) -> Result<PreReview> {
        let mut state = self.state.lock();
        let r = state
            .reviews
            .iter_mut()
            .find(|r| r.id == id)
            .context("Review not found")?;
        let mut next = r.clone();
        f(&mut next)?;
        next.updated_at = now().to_rfc3339();
        self.store
            .save_feature_record("reviews", id, &serde_json::to_string(&next)?)?;
        *r = next.clone();
        drop(state);
        self.emit();
        Ok(next)
    }
    pub fn snapshot(&self) -> ReviewInbox {
        let mut s = self.state.lock().clone();
        let account = s.account.clone();
        s.reviews
            .retain(|r| Some(&r.pull.account) == account.as_ref());
        s.reviews.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        // Diffs are fetched with the selected review, not broadcast for every inbox refresh.
        for r in &mut s.reviews {
            r.diff.clear();
        }
        s
    }
    async fn ensure_account(&self, expected: &str) -> Result<()> {
        if self.gh.account().await? != expected {
            bail!("GitHub account changed. Refresh and switch back to the draft's account.");
        }
        Ok(())
    }
    async fn refresh(&self) -> Result<()> {
        let _guard = self.gate.lock().await;
        let result = async {
            let account = self.gh.account().await?;
            {
                let mut s = self.state.lock();
                if s.account.as_ref() != Some(&account) {
                    s.pulls.clear();
                    s.mine.clear();
                    s.last_synced = None;
                    s.account = Some(account.clone());
                }
            }
            let (pulls, mine) = tokio::join!(
                aura_github::inbox(&*self.gh, &account),
                aura_github::authored(&*self.gh, &account)
            );
            let (mut pulls, mut mine) = (pulls?, mine?);
            self.ensure_account(&account).await?;
            let hidden = self.store.feature_records(&format!("hidden:{account}"))?;
            for p in pulls.iter_mut().chain(&mut mine) {
                p.hidden = hidden.iter().any(|(id, v)| id == &p.id && v == "true");
            }
            {
                let mut s = self.state.lock();
                s.pulls = pulls;
                s.mine = mine;
                s.last_synced = Some(now().to_rfc3339());
                s.error = None;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(e) = &result {
            tracing::warn!("pull request refresh failed: {e:#}");
            self.state.lock().error = Some(format!("{e:#}"));
        }
        self.persist_inbox()?;
        self.emit();
        result
    }
    /// After Aura changes a PR on GitHub, show the change straight away instead of at the next
    /// poll: re-read that PR, resync both lists, and resync once more after GitHub's search
    /// index has caught up (it can keep listing a PR you just reviewed for a while).
    fn changed(self: &Arc<Self>, pr: &PullRequest) {
        let generation = self.changes.fetch_add(1, Ordering::SeqCst) + 1;
        let (svc, account, repo, number) =
            (self.clone(), pr.account.clone(), pr.repo.clone(), pr.number);
        tokio::spawn(async move {
            if let Err(e) = svc.update_pull(&account, &repo, number).await {
                tracing::debug!("re-reading {repo}#{number} failed: {e:#}");
            }
            let _ = svc.refresh().await;
            tokio::time::sleep(Duration::from_secs(20)).await;
            if svc.changes.load(Ordering::SeqCst) == generation {
                let _ = svc.refresh().await;
            }
        });
    }
    /// Replace one PR in the lists with its live state; one that is no longer open is dropped.
    async fn update_pull(&self, account: &str, repo: &str, number: u32) -> Result<()> {
        self.ensure_account(account).await?;
        let mut live = pull(&*self.gh, account, repo, number).await?;
        {
            let mut state = self.state.lock();
            let state = &mut *state;
            if state.account.as_deref() != Some(account) {
                return Ok(());
            }
            for list in [&mut state.pulls, &mut state.mine] {
                if let Some(i) = list.iter().position(|p| p.id == live.id) {
                    if live.state == "open" {
                        live.hidden = list[i].hidden;
                        list[i] = live.clone();
                    } else {
                        list.remove(i);
                    }
                }
            }
        }
        self.persist_inbox()?;
        self.emit();
        Ok(())
    }
    async fn lookup(&self, p: &Value) -> Result<PullRequest> {
        let repo = required(p, "repo")?;
        let number = p["number"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .context("Invalid PR number")? as u32;
        let account = self.gh.account().await?;
        if let Some(expected) = p["account"].as_str() {
            if expected != account {
                bail!("GitHub account changed; refresh first");
            }
        }
        let mut result = pull(&*self.gh, &account, repo, number).await?;
        result.hidden = self
            .store
            .feature_records(&format!("hidden:{account}"))?
            .iter()
            .any(|(id, v)| id == &result.id && v == "true");
        Ok(result)
    }
    pub async fn handle(self: &Arc<Self>, method: &str, p: Value) -> Result<Option<Value>> {
        if !method.starts_with("reviews.")
            && !method.starts_with("pulls.")
            && method != "github.status"
        {
            return Ok(None);
        }
        let v = match method {
            "github.status" | "pulls.list" | "reviews.list" => json!(self.snapshot()),
            "reviews.defaults" => {
                json!({"instructions":runner::DEFAULT_PROMPT,"config":self.state.lock().defaults})
            }
            "pulls.refresh" => {
                self.refresh().await?;
                json!(self.snapshot())
            }
            "pulls.hide" | "pulls.restore" => {
                let _g = self.gate.lock().await;
                let account = required(&p, "account")?;
                self.ensure_account(account).await?;
                let id = required(&p, "id")?;
                let hidden = method == "pulls.hide";
                self.store.save_feature_record(
                    &format!("hidden:{account}"),
                    id,
                    if hidden { "true" } else { "false" },
                )?;
                {
                    let mut state = self.state.lock();
                    let state = &mut *state;
                    for pull in state.pulls.iter_mut().chain(&mut state.mine) {
                        if pull.id == id && pull.account == account {
                            pull.hidden = hidden;
                        }
                    }
                }
                self.persist_inbox()?;
                self.emit();
                json!(self.snapshot())
            }
            "pulls.get" => {
                let pr = self.lookup(&p).await?;
                let base = format!("repos/{}", pr.repo);
                let comment_path = format!("{base}/issues/{}/comments", pr.number);
                let review_path = format!("{base}/pulls/{}/reviews", pr.number);
                let thread_path = format!("{base}/pulls/{}/comments", pr.number);
                let (comments, reviews, threads, projects) = tokio::join!(
                    pages(&*self.gh, &comment_path),
                    pages(&*self.gh, &review_path),
                    pages(&*self.gh, &thread_path),
                    aura_github::projects(&*self.gh, &pr)
                );
                let (projects, project_error) = match projects {
                    Ok(v) => (v, None),
                    Err(e) => (vec![], Some(e.to_string())),
                };
                let value = json!({"pull":pr,"comments":comments?,"reviews":reviews?,"threads":threads?,"projects":projects,"project_error":project_error});
                self.store.save_feature_record(
                    &format!("details:{}", pr.account),
                    &pr.id,
                    &value.to_string(),
                )?;
                value
            }
            "pulls.cached" => {
                let account = required(&p, "account")?;
                let id = required(&p, "id")?;
                let raw = self
                    .store
                    .feature_records(&format!("details:{account}"))?
                    .into_iter()
                    .find(|(k, _)| k == id)
                    .context("No cached PR detail")?
                    .1;
                serde_json::from_str(&raw)?
            }
            "pulls.diff" => {
                let pr = self.lookup(&p).await?;
                json!({"sha":pr.head_sha,"diff":self.gh.diff(&pr.repo,&pr.base_sha,&pr.head_sha).await?})
            }
            "pulls.options" => {
                let pr = self.lookup(&p).await?;
                json!({"labels":pages(&*self.gh,&format!("repos/{}/labels",pr.repo)).await?,"assignees":pages(&*self.gh,&format!("repos/{}/assignees",pr.repo)).await?,"milestones":pages(&*self.gh,&format!("repos/{}/milestones?state=open",pr.repo)).await?})
            }
            "pulls.update" => {
                let pr = self.lookup(&p).await?;
                if !pr.can_edit {
                    bail!("You cannot edit this pull request");
                }
                let mut body = serde_json::Map::new();
                for key in ["title", "body", "labels", "assignees", "milestone"] {
                    if let Some(value) = p["patch"].get(key) {
                        body.insert(key.into(), value.clone());
                    }
                }
                self.ensure_account(&pr.account).await?;
                let v = self
                    .gh
                    .request_for(
                        &pr.account,
                        "PATCH",
                        &format!("repos/{}/issues/{}", pr.repo, pr.number),
                        Some(Value::Object(body)),
                    )
                    .await?;
                self.changed(&pr);
                v
            }
            "pulls.addComment" => {
                let pr = self.lookup(&p).await?;
                let body = required(&p, "body")?;
                if body.trim().is_empty() {
                    bail!("Comment is empty");
                }
                self.ensure_account(&pr.account).await?;
                let v = self
                    .gh
                    .request_for(
                        &pr.account,
                        "POST",
                        &format!("repos/{}/issues/{}/comments", pr.repo, pr.number),
                        Some(json!({"body":body})),
                    )
                    .await?;
                self.changed(&pr);
                v
            }
            "pulls.setField" => {
                let pr = self.lookup(&p).await?;
                let projects = aura_github::projects(&*self.gh, &pr).await?;
                let item = projects
                    .iter()
                    .find(|x| {
                        x["id"] == p["item_id"]
                            && x["project"]["id"] == p["project_id"]
                            && x["project"]["viewerCanUpdate"] == true
                    })
                    .context("Project item is not editable")?;
                if !item["fieldValues"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|x| x["field"]["id"] == p["field_id"])
                {
                    bail!("Unknown project field");
                }
                let query = if p["value"].is_null() {
                    "mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}"
                } else {
                    "mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}"
                };
                let mut vars =
                    json!({"project":p["project_id"],"item":p["item_id"],"field":p["field_id"]});
                if !p["value"].is_null() {
                    vars["value"] = p["value"].clone();
                }
                let v = self
                    .gh
                    .request_for(
                        &pr.account,
                        "POST",
                        "graphql",
                        Some(json!({"query":query,"variables":vars})),
                    )
                    .await?;
                if v.get("errors").is_some() {
                    bail!("{}", v["errors"]);
                }
                self.changed(&pr);
                v
            }
            "reviews.start" => json!(self.start(&p).await?),
            "reviews.get" | "reviews.diff" => {
                let r = self.get(required(&p, "id")?)?;
                if self.state.lock().account.as_deref() != Some(&r.pull.account) {
                    bail!("Review belongs to another account");
                }
                json!(r)
            }
            "reviews.cancel" | "reviews.discard" => {
                let id = required(&p, "id")?;
                let r = self.get(id)?;
                self.ensure_account(&r.pull.account).await?;
                let updated = self.change(id, |r| {
                    if matches!(r.status.as_str(), "submitted" | "submitting" | "uncertain") {
                        bail!("This review cannot be discarded or cancelled");
                    }
                    r.status = if method == "reviews.discard" {
                        "discarded"
                    } else {
                        "cancelled"
                    }
                    .into();
                    r.phase = r.status.clone();
                    Ok(())
                })?;
                if let Some(job) = self.jobs.lock().remove(id) {
                    job.abort();
                }
                json!(updated)
            }
            "reviews.save" => {
                let id = required(&p, "id")?;
                let r = self.get(id)?;
                if self.state.lock().account.as_deref() != Some(&r.pull.account) {
                    bail!("Account changed");
                }
                let mut result: ReviewResult = serde_json::from_value(p["result"].clone())?;
                // Empty newly authored comments are allowed while drafting, but not in a submission.
                if !matches!(
                    result.verdict.as_str(),
                    "approve" | "comment" | "request_changes"
                ) || !matches!(result.risk.as_str(), "low" | "medium" | "high")
                {
                    bail!("Invalid verdict or risk");
                }
                let mut ids = std::collections::HashSet::new();
                for c in &mut result.comments {
                    if c.line == 0
                        || c.path.is_empty()
                        || !matches!(c.side.as_str(), "LEFT" | "RIGHT")
                        || !matches!(
                            c.severity.as_str(),
                            "blocker" | "major" | "minor" | "nit" | "praise"
                        )
                    {
                        bail!("Invalid finding location or severity");
                    }
                    if c.id.is_empty() {
                        c.id = new_id();
                    }
                    if !ids.insert(c.id.clone()) {
                        bail!("Duplicate finding ID");
                    }
                    if let Some(original) = r.result.comments.iter().find(|x| x.id == c.id) {
                        c.user_authored = original.user_authored;
                        c.rationale = original.rationale.clone();
                        c.edited = original.edited
                            || c.body != original.body
                            || c.line != original.line
                            || c.start_line != original.start_line
                            || c.path != original.path
                            || c.side != original.side
                            || c.severity != original.severity;
                    } else {
                        c.user_authored = true;
                        c.rationale = None;
                        c.edited = true;
                    }
                }
                diff::validate(&mut result.comments, &r.diff, false);
                json!(self.change(id, |r| {
                    if r.status != "ready" {
                        bail!("Review is not editable");
                    }
                    if p["revision"].as_u64() != Some(r.revision as u64) {
                        bail!("Review changed in another window. Reload before saving.");
                    }
                    r.result = result;
                    r.revision += 1;
                    r.submission = None;
                    Ok(())
                })?)
            }
            "reviews.preview" => {
                let _g = self.gate.lock().await;
                let preview = self.preview(required(&p, "id")?).await?;
                json!(preview)
            }
            "reviews.submit" => {
                let _g = self.gate.lock().await;
                let id = required(&p, "id")?;
                let result = self.submit(id, required(&p, "token")?).await;
                // Even a failed post may have reached GitHub; resyncing is harmless either way.
                if let Ok(r) = self.get(id) {
                    if r.status != "ready" {
                        self.changed(&r.pull);
                    }
                }
                json!(result?)
            }
            "reviews.reconcile" => {
                let _g = self.gate.lock().await;
                let r = self.reconcile(required(&p, "id")?).await?;
                self.changed(&r.pull);
                json!(r)
            }
            _ => bail!("Unknown review method"),
        };
        Ok(Some(v))
    }
    async fn start(self: &Arc<Self>, p: &Value) -> Result<PreReview> {
        let _guard = self.gate.lock().await;
        let pr = self.lookup(p).await?;
        if pr.state != "open" {
            bail!("This PR is no longer open");
        }
        if let Some(r) = self.state.lock().reviews.iter().find(|r| {
            r.pull.id == pr.id
                && r.pull.account == pr.account
                && matches!(r.status.as_str(), "queued" | "running")
        }) {
            return Ok(r.clone());
        }
        let config: ReviewConfig = serde_json::from_value(p["config"].clone())?;
        let kind = match config.provider.as_str() {
            "codex" => ProviderKind::Codex,
            "claude" => ProviderKind::Claude,
            _ => bail!("Select a supported provider"),
        };
        let provider = self.manager.provider(kind)?;
        provider.refresh().await;
        if provider.info().binary.is_none() {
            bail!("Selected provider is unavailable");
        }
        let models = match (&config.effort, kind) {
            (Some(_), _) => provider.list_models().await?,
            // Codex lists real model ids, so its default names the model that will run.
            (None, ProviderKind::Codex) => provider.list_models().await.unwrap_or_default(),
            (None, _) => vec![],
        };
        let model = models
            .iter()
            .find(|m| config.model.as_deref() == Some(&m.id))
            .or_else(|| models.iter().find(|m| m.is_default));
        if let Some(effort) = &config.effort {
            if !model.is_some_and(|m| m.efforts.contains(effort)) {
                bail!("Effort is not supported by the selected model");
            }
        }
        let agent = ReviewAgent {
            provider: provider.info().display_name,
            model: config.model.clone(),
            model_id: (kind == ProviderKind::Codex)
                .then(|| model.map(|m| m.id.clone()))
                .flatten(),
            effort: config.effort.clone(),
        };
        let instructions = runner::instructions(&config)?;
        let id = new_id();
        let ts = now().to_rfc3339();
        let review = PreReview {
            id: id.clone(),
            pull: pr,
            config: config.clone(),
            instructions,
            status: "queued".into(),
            phase: "preparing".into(),
            error: None,
            created_at: ts.clone(),
            updated_at: ts,
            revision: 0,
            reviewed_sha: String::new(),
            merge_base: String::new(),
            context_mode: String::new(),
            context_note: None,
            diff: String::new(),
            log_tail: vec![],
            result: ReviewResult {
                verdict: "comment".into(),
                risk: "medium".into(),
                ..Default::default()
            },
            submitted_url: None,
            submission: None,
            agent: Some(agent),
        };
        self.store
            .save_feature_record("reviews", &id, &serde_json::to_string(&review)?)?;
        {
            let mut s = self.state.lock();
            s.reviews.push(review.clone());
            s.defaults = config;
        }
        self.persist_inbox()?;
        self.enqueue(id);
        self.emit();
        Ok(review)
    }
    fn enqueue(self: &Arc<Self>, id: String) {
        let svc = self.clone();
        let key = id.clone();
        let task = tokio::spawn(async move {
            let outcome = async {
                let _permit = svc.slots.acquire().await?;
                if svc.get(&id)?.status != "queued" {
                    return Ok(());
                }
                svc.change(&id, |r| {
                    r.status = "running".into();
                    Ok(())
                })?;
                tokio::time::timeout(Duration::from_secs(900), svc.execute(&id))
                    .await
                    .context("Review timed out after 15 minutes")?
            }
            .await;
            if let Err(e) = outcome {
                let _ = svc.change(&id, |r| {
                    if matches!(r.status.as_str(), "running" | "queued") {
                        r.status = "failed".into();
                        r.phase = "failed".into();
                        r.error = Some(format!("{e:#}"));
                    }
                    Ok(())
                });
            }
            svc.jobs.lock().remove(&id);
        });
        self.jobs.lock().insert(key, task.abort_handle());
    }
    async fn execute(self: &Arc<Self>, id: &str) -> Result<()> {
        let r = self.get(id)?;
        self.ensure_account(&r.pull.account).await?;
        tokio::fs::create_dir_all(&self.root).await?;
        let workspace = tempfile::Builder::new()
            .prefix("review-")
            .tempdir_in(&self.root)?;
        let cwd = workspace.path().join("checkout");
        self.change(id, |r| {
            r.phase = "cloning".into();
            Ok(())
        })?;
        let prepared = self.workspace.prepare(&r.pull, &cwd).await;
        let (diff, merge_base, mode, note) = match prepared {
            Ok((diff, base)) => (diff, base, "worktree", None),
            Err(e) => {
                if cwd.exists() {
                    tokio::fs::remove_dir_all(&cwd).await?;
                }
                tokio::fs::create_dir_all(&cwd).await?;
                let comparison = self
                    .gh
                    .request(
                        "GET",
                        &format!(
                            "repos/{}/compare/{}...{}",
                            r.pull.repo, r.pull.base_sha, r.pull.head_sha
                        ),
                        None,
                    )
                    .await?;
                let base = comparison["merge_base_commit"]["sha"]
                    .as_str()
                    .context("GitHub did not return the comparison merge base")?
                    .to_string();
                (
                    self.gh
                        .diff(&r.pull.repo, &r.pull.base_sha, &r.pull.head_sha)
                        .await?,
                    base,
                    "diff-only",
                    Some(format!(
                        "Checkout unavailable: {e}. Reviewed from the diff alone."
                    )),
                )
            }
        };
        if diff::positions(&diff)
            .values()
            .all(|(a, b)| a.is_empty() && b.is_empty())
        {
            bail!("This PR has no textual diff to review");
        }
        let truncated = diff.chars().count() > 200_000;
        let missing_files = mode == "diff-only"
            && diff
                .lines()
                .filter(|line| line.starts_with("diff --git "))
                .count()
                < r.pull.changed_files as usize;
        let note = if missing_files {
            Some(format!(
                "{} GitHub returned fewer files than the PR contains; this review is incomplete.",
                note.unwrap_or_default()
            ))
        } else {
            note
        };
        let note = if truncated {
            Some(format!(
                "{} Inline diff is truncated; {}",
                note.unwrap_or_default(),
                if mode == "worktree" {
                    "full diff is available in .aura-pr.diff"
                } else {
                    "some changes were not reviewed"
                }
            ))
        } else {
            note
        };
        tokio::fs::write(cwd.join(".aura-pr.diff"), &diff).await?;
        let r = self.change(id, |r| {
            if r.status != "running" {
                bail!("Review was cancelled");
            }
            r.diff = diff;
            r.merge_base = merge_base;
            r.reviewed_sha = r.pull.head_sha.clone();
            r.context_mode = mode.into();
            r.context_note = note;
            r.phase = "running".into();
            Ok(())
        })?;
        let svc = self.clone();
        let progress_id = id.to_string();
        let progress: Progress = Arc::new(move |line| {
            let _ = svc.change(&progress_id, |r| {
                if r.status == "running" {
                    r.log_tail.push(line);
                    if r.log_tail.len() > 40 {
                        r.log_tail.remove(0);
                    }
                }
                Ok(())
            });
        });
        let runner::RunOutput {
            mut result,
            model_id,
        } = self.runner.run(&r, &cwd, progress).await?;
        self.change(id, |r| {
            if r.status != "running" {
                bail!("Review was cancelled");
            }
            r.phase = "validating".into();
            Ok(())
        })?;
        runner::validate_result(&result)?;
        for c in &mut result.comments {
            c.id = new_id();
        }
        diff::validate(&mut result.comments, &r.diff, true);
        if (truncated || missing_files) && mode == "diff-only" && result.verdict == "approve" {
            result.verdict = "comment".into();
            result.summary.push_str(
                "\n\nOnly part of the diff was reviewed; this is not an approval of the full PR.",
            );
        }
        self.change(id, |r| {
            if r.status != "running" {
                bail!("Review was cancelled");
            }
            r.result = result;
            if let (Some(agent), Some(id)) = (r.agent.as_mut(), model_id) {
                agent.model_id = Some(id);
            }
            r.status = "ready".into();
            r.phase = "done".into();
            Ok(())
        })?;
        Ok(())
    }
    async fn preview(&self, id: &str) -> Result<SubmissionPreview> {
        let r = self.get(id)?;
        if r.status != "ready" {
            bail!("Only ready drafts can be submitted");
        }
        self.ensure_account(&r.pull.account).await?;
        let live = pull(&*self.gh, &r.pull.account, &r.pull.repo, r.pull.number).await?;
        if live.state != "open" {
            bail!("This PR is no longer open");
        }
        let preview = build_preview(&r, &live.head_sha)?;
        self.change(id, |r| {
            if r.revision != preview.revision || r.status != "ready" {
                bail!("Draft changed; preview again");
            }
            r.submission = Some(preview.clone());
            Ok(())
        })?;
        Ok(preview)
    }
    async fn submit(&self, id: &str, token: &str) -> Result<PreReview> {
        let r = self.get(id)?;
        if r.status == "submitted" {
            return Ok(r);
        }
        if r.status != "ready" {
            bail!("Submission unavailable; reconcile uncertain submissions first");
        }
        let preview = r
            .submission
            .clone()
            .filter(|s| s.token == token && s.revision == r.revision)
            .context("Preview expired; preview the saved draft again")?;
        self.ensure_account(&r.pull.account).await?;
        let live = pull(&*self.gh, &r.pull.account, &r.pull.repo, r.pull.number).await?;
        if live.state != "open" || live.head_sha != preview.head_sha {
            bail!("PR changed since preview. Preview again before posting.");
        }
        self.change(id, |r| {
            if r.revision != preview.revision
                || r.status != "ready"
                || r.submission.as_ref().map(|s| s.token.as_str()) != Some(token)
            {
                bail!("Draft changed; preview again");
            }
            r.status = "submitting".into();
            Ok(())
        })?;
        let response = self
            .gh
            .request_for(
                &r.pull.account,
                "POST",
                &format!("repos/{}/pulls/{}/reviews", r.pull.repo, r.pull.number),
                Some(payload(&preview)),
            )
            .await;
        match response {
            Ok(v) => self.change(id, |r| {
                r.status = "submitted".into();
                r.submitted_url = v["html_url"].as_str().map(String::from);
                r.error = None;
                Ok(())
            }),
            Err(e) if e.downcast_ref::<aura_github::RejectedRequest>().is_some() => {
                self.change(id, |r| {
                    r.status = "ready".into();
                    r.submission = None;
                    r.error = Some(e.to_string());
                    Ok(())
                })?;
                Err(e)
            }
            Err(e) => {
                // Conservatively reconcile even transport errors: the server may have accepted the write.
                self.change(id, |r| {
                    r.status = "uncertain".into();
                    r.error = Some(format!(
                        "Submission may have reached GitHub: {e}. Reconcile before retrying."
                    ));
                    Ok(())
                })?;
                bail!(
                    "Submission outcome uncertain. Use Reconcile to check GitHub before retrying."
                )
            }
        }
    }
    async fn reconcile(&self, id: &str) -> Result<PreReview> {
        let r = self.get(id)?;
        if r.status != "uncertain" {
            bail!("No uncertain submission");
        }
        self.ensure_account(&r.pull.account).await?;
        let preview = r
            .submission
            .as_ref()
            .context("No submission receipt to reconcile")?;
        let rows = pages(
            &*self.gh,
            &format!("repos/{}/pulls/{}/reviews", r.pull.repo, r.pull.number),
        )
        .await?;
        let marker = format!("<!-- aura-review:{} -->", preview.token);
        if let Some(found) = rows
            .iter()
            .find(|v| v["body"].as_str().unwrap_or("").contains(&marker))
        {
            self.change(id, |r| {
                r.status = "submitted".into();
                r.submitted_url = found["html_url"].as_str().map(String::from);
                r.error = None;
                Ok(())
            })
        } else {
            // Do not infer failure from eventual-consistency absence and automatically duplicate a review.
            bail!("No matching review is visible yet. Check the PR and reconcile again; automatic retry is disabled to prevent duplicate reviews.")
        }
    }
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("Missing {key}"))
}
pub fn build_preview(r: &PreReview, head: &str) -> Result<SubmissionPreview> {
    let mut comments = r
        .result
        .comments
        .iter()
        .filter(|c| !c.deleted)
        .cloned()
        .collect::<Vec<_>>();
    if comments.iter().any(|c| c.body.trim().is_empty()) {
        bail!("Complete or delete empty comments before posting");
    }
    diff::validate(&mut comments, &r.diff, false);
    let mut body = r.result.summary.clone();
    let unanchored: Vec<_> = comments.iter().filter(|c| !c.valid).collect();
    if !unanchored.is_empty() {
        body.push_str("\n\n---\n\n**Additional notes** (these refer to lines outside the diff):\n");
        for c in unanchored {
            body.push_str(&format!("\n- **{}:{}** — {}", c.path, c.line, c.body));
        }
    }
    comments.retain(|c| c.valid);
    let agent = review_agent(r);
    for c in &mut comments {
        c.rationale = None;
        // Comments the user wrote themselves are theirs, not the agent's.
        if !c.user_authored {
            c.body.push_str(&format!(
                "\n\n<sub>🤖 AI agent · {}</sub>",
                agent.signature()
            ));
        }
    }
    if body.trim().is_empty() && comments.is_empty() {
        bail!("There is nothing to post");
    }
    body.push_str(&format!(
        "\n\n---\n<sub>🤖 Drafted by an AI agent with Aura and reviewed by a person before posting · {}</sub>",
        agent.signature()
    ));
    let token = new_id();
    body.push_str(&format!("\n\n<!-- aura-review:{token} -->"));
    Ok(SubmissionPreview {
        token,
        review_id: r.id.clone(),
        revision: r.revision,
        account: r.pull.account.clone(),
        head_sha: head.into(),
        reviewed_sha: r.reviewed_sha.clone(),
        event: match r.result.verdict.as_str() {
            "approve" => "APPROVE",
            "request_changes" => "REQUEST_CHANGES",
            _ => "COMMENT",
        }
        .into(),
        body,
        comments,
        stale: head != r.reviewed_sha,
    })
}
/// The agent behind a draft; older drafts did not record one, so it is
/// rebuilt from the configuration they ran with.
fn review_agent(r: &PreReview) -> ReviewAgent {
    r.agent.clone().unwrap_or_else(|| ReviewAgent {
        provider: match r.config.provider.as_str() {
            "claude" => "Claude Code".into(),
            "codex" => "Codex".into(),
            other => other.into(),
        },
        model: r.config.model.clone(),
        model_id: None,
        effort: r.config.effort.clone(),
    })
}
pub fn payload(p: &SubmissionPreview) -> Value {
    json!({"commit_id":p.reviewed_sha,"event":p.event,"body":p.body,"comments":p.comments.iter().map(|c|{
 let mut v=json!({"path":c.path,"line":c.line,"side":c.side,"body":c.body});if let Some(start)=c.start_line{v["start_line"]=json!(start);v["start_side"]=json!(c.side);}v
}).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests;
