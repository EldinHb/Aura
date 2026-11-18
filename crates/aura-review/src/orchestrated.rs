//! Pre-reviews an orchestrator records and changes through its `aura` tools
//! (`orchestrator.reviews.*`), on the same drafts, checks and events as the user's
//! review editor. A recorded draft is ready for the user as soon as it is complete;
//! posting it to GitHub stays the user's.
//!
//! The orchestrator never changes what the user wrote or edited: findings the user
//! authored or edited are theirs.
use super::*;
use serde::Deserialize;

/// A finding as an orchestrator writes it; missing fields take the editor's defaults.
#[derive(Debug, Deserialize)]
struct Finding {
    path: String,
    line: u32,
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    body: String,
    #[serde(default)]
    rationale: Option<String>,
}
impl Finding {
    fn comment(self) -> Result<ReviewComment> {
        if self.body.trim().is_empty() {
            bail!("A finding at {}:{} has no text", self.path, self.line);
        }
        Ok(ReviewComment {
            path: self.path.trim().into(),
            line: self.line,
            start_line: self.start_line,
            side: side(self.side.as_deref())?,
            severity: severity(self.severity.as_deref())?,
            body: self.body,
            rationale: self.rationale.filter(|r| !r.trim().is_empty()),
            ..Default::default()
        })
    }
}
fn side(v: Option<&str>) -> Result<String> {
    match v.map(|s| s.trim().to_ascii_uppercase()).as_deref() {
        None | Some("") | Some("RIGHT") => Ok("RIGHT".into()),
        Some("LEFT") => Ok("LEFT".into()),
        Some(other) => bail!(
            "Unknown side `{other}`: use RIGHT (added or unchanged lines) or LEFT (deleted lines)"
        ),
    }
}
fn severity(v: Option<&str>) -> Result<String> {
    let s = v.unwrap_or("minor").trim().to_ascii_lowercase();
    if !matches!(s.as_str(), "blocker" | "major" | "minor" | "nit" | "praise") {
        bail!("Unknown severity `{s}`: use blocker, major, minor, nit or praise");
    }
    Ok(s)
}
/// `approve`, `comment` or `request_changes`, also as GitHub spells them.
fn verdict(v: &str) -> Result<String> {
    let v = v.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    Ok(match v.as_str() {
        "approve" | "approved" => "approve",
        "comment" | "commented" => "comment",
        "request_changes" | "changes_requested" => "request_changes",
        _ => bail!("Unknown verdict `{v}`: use approve, comment or request_changes"),
    }
    .into())
}
fn risk(v: &str) -> Result<String> {
    let v = v.trim().to_ascii_lowercase();
    if !matches!(v.as_str(), "low" | "medium" | "high") {
        bail!("Unknown risk `{v}`: use low, medium or high");
    }
    Ok(v)
}
fn opt_str<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p[key].as_str().filter(|s| !s.trim().is_empty())
}
fn findings(v: &Value) -> Result<Vec<ReviewComment>> {
    let list: Vec<Finding> =
        serde_json::from_value(v.clone()).context("`comments` must be a list of findings")?;
    list.into_iter().map(Finding::comment).collect()
}
/// The finding is the user's: they wrote or edited it.
fn users(c: &ReviewComment) -> bool {
    c.user_authored || c.edited
}
fn revision(p: &Value) -> Option<u32> {
    p["revision"].as_u64().map(|n| n as u32)
}

impl ReviewService {
    pub(crate) async fn handle_orchestrator(
        self: &Arc<Self>,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        let orchestrator = self.manager.orchestrator(required(p, "orchestrator")?)?;
        Ok(match method {
            "orchestrator.reviews.list" => {
                if p["refresh"].as_bool() == Some(true) {
                    self.sync(true).await?;
                }
                json!(self.snapshot())
            }
            "orchestrator.reviews.get" => match opt_str(p, "review") {
                Some(id) => json!(self.own(id)?),
                None => {
                    let (repo, number) = pull_arg(p)?;
                    let inbox = self.snapshot();
                    let pull = inbox
                        .pulls
                        .iter()
                        .chain(&inbox.reviewed)
                        .chain(&inbox.mine)
                        .find(|x| x.repo.eq_ignore_ascii_case(&repo) && x.number == number)
                        .cloned();
                    let pull = match pull {
                        Some(pull) => pull,
                        None => self.lookup(&json!({"repo":repo,"number":number})).await?,
                    };
                    let reviews: Vec<PreReview> = inbox
                        .reviews
                        .into_iter()
                        .filter(|r| r.pull.id.eq_ignore_ascii_case(&pull.id))
                        .collect();
                    json!({"pull":pull,"reviews":reviews})
                }
            },
            "orchestrator.reviews.create" => json!(self.record(&orchestrator, p).await?),
            "orchestrator.reviews.update" => {
                let id = required(p, "review")?;
                let current = self.own(id)?;
                if p["ready"].as_bool() == Some(false) && current.status != "drafting" {
                    bail!(
                        "Only a new draft can be kept from the user; this one is {} already",
                        current.status
                    );
                }
                let mut r = None;
                let changes = ["summary", "verdict", "risk", "confidence", "comments"]
                    .iter()
                    .any(|k| !p[*k].is_null());
                if changes {
                    let summary = p["summary"].as_str().map(String::from);
                    let verdict = opt_str(p, "verdict").map(verdict).transpose()?;
                    let risk = opt_str(p, "risk").map(risk).transpose()?;
                    let comments = (!p["comments"].is_null())
                        .then(|| findings(&p["comments"]))
                        .transpose()?;
                    r = Some(self.save_draft(id, revision(p), Editor::Agent, |r| {
                        let mut result = r.result.clone();
                        if let Some(s) = summary {
                            result.summary = s;
                        }
                        if let Some(v) = verdict {
                            result.verdict = v;
                        }
                        if let Some(v) = risk {
                            result.risk = v;
                        }
                        match &p["confidence"] {
                            Value::Null => {}
                            v => {
                                result.confidence = Some(
                                    v.as_f64()
                                        .context("`confidence` must be a number from 0 to 1")?,
                                )
                            }
                        }
                        if let Some(new) = comments {
                            result.comments.retain(users);
                            result.comments.extend(new);
                        }
                        Ok(result)
                    })?);
                }
                match p["ready"].as_bool() {
                    Some(true) => json!(self.mark_ready(id)?),
                    Some(false) if r.is_none() => json!(current),
                    _ => match r {
                        Some(r) => json!(r),
                        None => bail!("Nothing to change: give summary, verdict, risk, confidence, comments or ready"),
                    },
                }
            }
            "orchestrator.reviews.add_comment" => {
                let id = required(p, "review")?;
                self.own(id)?;
                let mut c = Finding::deserialize(p)
                    .context("A finding needs `path`, `line` and `body`")?
                    .comment()?;
                c.id = new_id();
                let comment = c.id.clone();
                let r = self.save_draft(id, revision(p), Editor::Agent, |r| {
                    let mut result = r.result.clone();
                    result.comments.push(c);
                    Ok(result)
                })?;
                json!({"review":r,"comment":comment})
            }
            "orchestrator.reviews.edit_comment" | "orchestrator.reviews.delete_comment" => {
                let id = required(p, "review")?;
                let comment = required(p, "comment")?;
                self.own(id)?;
                let delete = method == "orchestrator.reviews.delete_comment";
                let r = self.save_draft(id, revision(p), Editor::Agent, |r| {
                    let mut result = r.result.clone();
                    let c = result
                        .comments
                        .iter_mut()
                        .find(|c| c.id == comment)
                        .with_context(|| format!("The review has no finding `{comment}`"))?;
                    if users(c) {
                        bail!("The user wrote or edited finding `{comment}`; leave it to them");
                    }
                    if delete {
                        c.deleted = p["restore"].as_bool() != Some(true);
                        return Ok(result);
                    }
                    if let Some(v) = opt_str(p, "path") {
                        c.path = v.trim().into();
                    }
                    if let Some(v) = p["line"].as_u64() {
                        c.line = v as u32;
                    }
                    match &p["start_line"] {
                        Value::Null if p.get("start_line").is_some() => c.start_line = None,
                        Value::Null => {}
                        v => {
                            c.start_line =
                                Some(v.as_u64().context("`start_line` must be a line number")?
                                    as u32)
                        }
                    }
                    if p.get("side").is_some() {
                        c.side = side(opt_str(p, "side"))?;
                    }
                    if p.get("severity").is_some() {
                        c.severity = severity(opt_str(p, "severity"))?;
                    }
                    if let Some(v) = p["body"].as_str() {
                        if v.trim().is_empty() {
                            bail!("`body` is empty: use delete_review_comment to remove a finding");
                        }
                        c.body = v.into();
                    }
                    if let Some(v) = p["rationale"].as_str() {
                        c.rationale = Some(v).filter(|r| !r.trim().is_empty()).map(String::from);
                    }
                    Ok(result)
                })?;
                json!(r)
            }
            "orchestrator.reviews.discard" => {
                let id = required(p, "review")?;
                self.own(id)?;
                json!(self.close(id, true).await?)
            }
            "orchestrator.reviews.start" => {
                let (repo, number) = pull_arg(p)?;
                let defaults = self.state.lock().defaults.clone();
                let config = ReviewConfig {
                    provider: opt_str(p, "agent").unwrap_or(&defaults.provider).into(),
                    model: opt_str(p, "model").map(String::from),
                    effort: opt_str(p, "effort").map(String::from),
                    prompt_mode: if opt_str(p, "instructions").is_some() {
                        "append"
                    } else {
                        "default"
                    }
                    .into(),
                    prompt: opt_str(p, "instructions").unwrap_or_default().into(),
                };
                json!(
                    self.start(&json!({"repo":repo,"number":number,"config":config}), false)
                        .await?
                )
            }
            "orchestrator.reviews.hide" => {
                let (repo, number) = pull_arg(p)?;
                let account = self.gh.account().await?;
                let id = format!("{repo}#{number}");
                // Hidden PRs are keyed by the id as GitHub spells it.
                let inbox = self.snapshot();
                let id = inbox
                    .pulls
                    .iter()
                    .chain(&inbox.reviewed)
                    .chain(&inbox.mine)
                    .find(|x| x.id.eq_ignore_ascii_case(&id))
                    .map_or(id, |x| x.id.clone());
                json!(
                    self.hide(&account, &id, p["hidden"].as_bool() != Some(false))
                        .await?
                )
            }
            _ => bail!("Unknown review method"),
        })
    }
    /// A pre-review of the account the inbox shows.
    fn own(&self, id: &str) -> Result<PreReview> {
        let r = self
            .get(id)
            .with_context(|| format!("No pre-review `{id}`; list_pull_requests shows them"))?;
        if self.state.lock().account.as_deref() != Some(&r.pull.account) {
            bail!("Pre-review `{id}` belongs to another GitHub account than the one Aura is signed in with");
        }
        Ok(r)
    }
    /// Record a review an agent did as a pre-review draft, against the PR's diff at the
    /// reviewed commit. It is ready for the user unless `ready` is false.
    async fn record(&self, orchestrator: &Session, p: &Value) -> Result<PreReview> {
        let (repo, number) = pull_arg(p)?;
        let worker = opt_str(p, "worker")
            .map(|w| self.manager.worker(&orchestrator.id, w))
            .transpose()?;
        let mut result = ReviewResult {
            summary: p["summary"].as_str().unwrap_or_default().into(),
            verdict: verdict(required(p, "verdict")?)?,
            risk: opt_str(p, "risk")
                .map(risk)
                .transpose()?
                .unwrap_or_else(|| "medium".into()),
            confidence: match &p["confidence"] {
                Value::Null => None,
                v => Some(
                    v.as_f64()
                        .context("`confidence` must be a number from 0 to 1")?,
                ),
            },
            comments: match &p["comments"] {
                Value::Null => vec![],
                v => findings(v)?,
            },
        };
        if result.summary.trim().is_empty() && result.comments.is_empty() {
            bail!("Give the review a `summary` or at least one finding");
        }
        check_result(&mut result)?;
        let (agent, config) = match &p["agent"] {
            Value::Null => self.attribution(worker.as_ref().unwrap_or(orchestrator)),
            v => {
                let agent: ReviewAgent = serde_json::from_value(v.clone()).context(
                    "`agent` needs `provider`, and may have `model`, `model_id` and `effort`",
                )?;
                if agent.provider.trim().is_empty() {
                    bail!("`agent.provider` is empty");
                }
                let config = ReviewConfig {
                    provider: agent.provider.to_lowercase(),
                    model: agent.model.clone(),
                    effort: agent.effort.clone(),
                    prompt_mode: "default".into(),
                    prompt: String::new(),
                };
                (agent, config)
            }
        };
        let _guard = self.gate.lock().await;
        let pull = self.lookup(&json!({"repo":repo,"number":number})).await?;
        if pull.state != "open" {
            bail!("{} is no longer open", pull.id);
        }
        let commit = opt_str(p, "commit").unwrap_or(&pull.head_sha).to_string();
        let (diff, merge_base) = self.compare(&pull, &commit).await?;
        if diff::positions(&diff)
            .values()
            .all(|(a, b)| a.is_empty() && b.is_empty())
        {
            bail!("{} has no textual diff to review", pull.id);
        }
        diff::validate(&mut result.comments, &diff, false);
        let ready = p["ready"].as_bool() != Some(false);
        let ts = now().to_rfc3339();
        let review = PreReview {
            id: new_id(),
            config,
            instructions: format!(
                "Recorded with Aura's review tools by the orchestrator {}{}.",
                orchestrator.title,
                worker
                    .as_ref()
                    .map(|w| format!(", from the review by its worker {}", w.title))
                    .unwrap_or_default()
            ),
            status: if ready { "ready" } else { "drafting" }.into(),
            phase: if ready { "done" } else { "drafting" }.into(),
            error: None,
            created_at: ts.clone(),
            updated_at: ts,
            revision: 0,
            reviewed_sha: commit,
            merge_base,
            context_mode: "recorded".into(),
            context_note: None,
            diff,
            log_tail: vec![],
            result,
            submitted_url: None,
            submission: None,
            agent: Some(agent),
            source: Some(ReviewSource {
                orchestrator: orchestrator.id.clone(),
                orchestrator_title: orchestrator.title.clone(),
                worker: worker.as_ref().map(|w| w.id.clone()),
                worker_title: worker.as_ref().map(|w| w.title.clone()),
            }),
            pull,
        };
        self.store
            .save_feature_record("reviews", &review.id, &serde_json::to_string(&review)?)?;
        self.state.lock().reviews.push(review.clone());
        self.emit();
        Ok(review)
    }
    /// The agent a session runs, as a review is signed with it, and as its configuration.
    fn attribution(&self, s: &Session) -> (ReviewAgent, ReviewConfig) {
        let provider = self.manager.provider(s.provider).ok().map(|p| p.info());
        let name = match (s.provider, s.agent.as_deref()) {
            (ProviderKind::Acp, Some(id)) => provider
                .as_ref()
                .and_then(|p| p.agents.iter().find(|a| a.id == id))
                .map_or_else(|| id.to_string(), |a| a.display_name.clone()),
            (ProviderKind::Claude, _) => "Claude Code".into(),
            (ProviderKind::Codex, _) => "Codex".into(),
            (kind, _) => provider.map_or_else(|| kind.as_str().into(), |p| p.display_name),
        };
        let model = s.model.clone().filter(|m| !m.is_empty());
        let effort = s.effort.clone().filter(|e| !e.is_empty());
        (
            ReviewAgent {
                provider: name,
                model: model.clone(),
                model_id: None,
                effort: effort.clone(),
            },
            ReviewConfig {
                provider: match (s.provider, &s.agent) {
                    (ProviderKind::Acp, Some(id)) => id.clone(),
                    (kind, _) => kind.as_str().into(),
                },
                model,
                effort,
                prompt_mode: "default".into(),
                prompt: String::new(),
            },
        )
    }
}

/// `pull` as `owner/repo#123` or a GitHub PR URL, or `repo` and `number`.
fn pull_arg(p: &Value) -> Result<(String, u32)> {
    if let Some(pull) = opt_str(p, "pull") {
        let pull = pull.trim().trim_end_matches('/');
        let parsed = if let Some((repo, n)) = pull.rsplit_once('#') {
            Some((repo.to_string(), n))
        } else {
            pull.split_once("github.com/")
                .and_then(|(_, rest)| rest.split_once("/pull/"))
                .map(|(repo, n)| {
                    (
                        repo.to_string(),
                        n.split(['/', '?', '#']).next().unwrap_or(""),
                    )
                })
        };
        let (repo, number) = parsed
            .and_then(|(repo, n)| Some((repo, n.parse::<u32>().ok().filter(|n| *n > 0)?)))
            .filter(|(repo, _)| repo.split('/').count() == 2)
            .with_context(|| {
                format!("`pull` must be `owner/repo#number` or the PR's URL, not `{pull}`")
            })?;
        return Ok((repo, number));
    }
    let repo = required(p, "repo").context("Give `pull` as `owner/repo#number`")?;
    let number = p["number"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .context("Give `pull` as `owner/repo#number`")? as u32;
    Ok((repo.to_string(), number))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_pull_is_named_like_github_does() {
        for given in [
            json!({"pull":"wortell/vidara.portal#2730"}),
            json!({"pull":"https://github.com/wortell/vidara.portal/pull/2730/files"}),
            json!({"repo":"wortell/vidara.portal","number":2730}),
        ] {
            assert_eq!(
                pull_arg(&given).unwrap(),
                ("wortell/vidara.portal".to_string(), 2730)
            );
        }
        for wrong in [
            json!({"pull":"vidara.portal#2730"}),
            json!({"pull":"o/r#x"}),
            json!({}),
        ] {
            assert!(pull_arg(&wrong).is_err(), "{wrong}");
        }
    }
    #[test]
    fn verdicts_and_sides_read_as_github_and_the_editor_spell_them() {
        assert_eq!(verdict("APPROVE").unwrap(), "approve");
        assert_eq!(verdict("changes requested").unwrap(), "request_changes");
        assert!(verdict("lgtm").is_err());
        assert_eq!(side(None).unwrap(), "RIGHT");
        assert_eq!(side(Some("left")).unwrap(), "LEFT");
        assert_eq!(severity(Some("Nit")).unwrap(), "nit");
        assert!(severity(Some("style")).is_err());
    }
}
