//! Feature owners (see [`crate::features`]): an orchestrator that owns one
//! feature, staffs a team of specialists, puts the decisions that are the
//! user's to them and delivers a report. Everything it records goes into the
//! feature record, and every change to it is announced as
//! [`Event::FeatureUpdated`].
//!
//! The user's answers reach the owner as messages from Aura, queued like
//! worker reports until the owner is free to take them.
use super::orchestrator::{agent_label, Note, NoteAbout, WorkerSpec};
use super::Manager;
use crate::autonomy::{self, Autonomy, AutonomyLevel, Checkpoint};
use crate::event::*;
use crate::features::*;
use crate::specialists::{self, Specialist, SpecialistInput};
use crate::types::*;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// What a feature owner asks for when it hires a specialist: the specialist,
/// and the worker as for `start_session`, its agent optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HireSpec {
    /// The specialist's id (see `list_specialists`).
    pub specialist: String,
    #[serde(flatten)]
    pub worker: WorkerSpec,
}

/// A question a feature owner puts to the user.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AskSpec {
    pub question: String,
    pub context: String,
    pub options: Vec<DecisionOption>,
    /// The label of the option the owner recommends.
    pub recommended: Option<String>,
    pub kind: QuestionKind,
}

/// A feature owner's delivery report, as it hands it in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReportSpec {
    pub what: String,
    pub why: String,
    pub how_to_test: String,
    pub where_to_test: String,
    pub notes: String,
}

/// What became of a checkpoint the owner reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointOutcome {
    pub checkpoint: Checkpoint,
    /// The review question when the user wants to review this checkpoint.
    pub review: Option<UserQuestion>,
}

impl Manager {
    // ------------------------------------------------------------- autonomy

    /// The autonomy every feature owner follows unless its feature has its own.
    pub fn autonomy(&self) -> Result<Autonomy> {
        Ok(match self.inner.store.get_setting(autonomy::SETTING_KEY)? {
            Some(raw) => autonomy::parse_stored(&raw),
            None => Autonomy::default(),
        })
    }

    /// Save the autonomy for every feature owner. Idle owners that follow it
    /// restart with it on their next message.
    pub async fn set_autonomy(&self, a: Autonomy) -> Result<Autonomy> {
        let a = a.tidy();
        let before = self.autonomy().ok();
        self.inner
            .store
            .set_setting(autonomy::SETTING_KEY, &serde_json::to_string(&a)?)?;
        if before.as_ref() != Some(&a) {
            let own: HashSet<String> = self
                .features()?
                .into_iter()
                .filter(|f| f.autonomy.is_some())
                .map(|f| f.owner_id)
                .collect();
            self.restart_idle_agents(|s| s.feature_owner && !own.contains(&s.id))
                .await;
        }
        Ok(a)
    }

    /// The autonomy a feature's owner follows: the feature's own, or the setting.
    pub fn effective_autonomy(&self, f: &Feature) -> Autonomy {
        match &f.autonomy {
            Some(a) => a.clone(),
            None => self.autonomy().unwrap_or_else(|e| {
                tracing::warn!("autonomy setting: {e:#}");
                Autonomy::default()
            }),
        }
    }

    /// Give a feature its own autonomy, or (`None`) make it follow the
    /// setting again. Its idle owner restarts with it on its next message.
    pub async fn set_feature_autonomy(
        &self,
        owner: &str,
        autonomy: Option<Autonomy>,
    ) -> Result<Feature> {
        self.feature_owner_session(owner)?;
        let (f, _) = self.change_feature(owner, |f| {
            f.autonomy = autonomy.map(Autonomy::tidy);
            Ok(())
        })?;
        self.restart_idle_agents(|s| s.id == owner).await;
        Ok(f)
    }

    // -------------------------------------------------------------- records

    /// The session, if it is a feature owner.
    pub fn feature_owner_session(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        if !s.feature_owner {
            bail!(
                "session {} is not a feature owner; only feature owners have this tool",
                &id[..id.len().min(8)]
            );
        }
        Ok(s)
    }

    /// The feature a feature owner owns.
    pub fn feature(&self, owner: &str) -> Result<Feature> {
        let stored = self
            .inner
            .store
            .feature_records(NAMESPACE)?
            .into_iter()
            .find(|(id, _)| id == owner);
        match stored {
            Some((_, json)) => {
                serde_json::from_str(&json).context("the feature record is unreadable")
            }
            // Made an owner some other way; its record starts on the first change.
            None => {
                self.feature_owner_session(owner)?;
                Ok(Feature::new(owner, "", None))
            }
        }
    }

    /// The features of every feature owner there is.
    pub fn features(&self) -> Result<Vec<Feature>> {
        let owners: HashSet<String> = self
            .list_sessions()
            .into_iter()
            .filter(|s| s.feature_owner)
            .map(|s| s.id)
            .collect();
        let mut out: Vec<Feature> = self
            .inner
            .store
            .feature_records(NAMESPACE)?
            .into_iter()
            .filter(|(id, _)| owners.contains(id))
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(f) => Some(f),
                Err(e) => {
                    tracing::warn!("skipping unreadable feature {id}: {e}");
                    None
                }
            })
            .collect();
        out.sort_by_key(|f: &Feature| f.created_at);
        Ok(out)
    }

    pub(super) fn save_feature(&self, f: &Feature) -> Result<()> {
        self.inner
            .store
            .save_feature_record(NAMESPACE, &f.owner_id, &serde_json::to_string(f)?)?;
        self.broadcast(Event::FeatureUpdated {
            session_id: f.owner_id.clone(),
            feature: f.clone(),
        });
        Ok(())
    }

    pub(super) fn delete_feature(&self, owner: &str) {
        if let Err(e) = self.inner.store.delete_feature_record(NAMESPACE, owner) {
            tracing::warn!("delete feature {owner}: {e:#}");
        }
    }

    /// Change a feature, then store and announce it. Changes are made one at a time.
    fn change_feature<T>(
        &self,
        owner: &str,
        f: impl FnOnce(&mut Feature) -> Result<T>,
    ) -> Result<(Feature, T)> {
        let _guard = self.inner.features.lock();
        let mut feature = self.feature(owner)?;
        let out = f(&mut feature)?;
        feature.updated_at = crate::now();
        self.save_feature(&feature)?;
        Ok((feature, out))
    }

    /// Record a worker an owner started on its team: hired as a specialist,
    /// or ad-hoc. Work has started once there is a team.
    pub(super) fn join_team(&self, owner: &str, worker: &Session, specialist: Option<&Specialist>) {
        let member = TeamMember {
            worker_id: worker.id.clone(),
            specialist_id: specialist.map(|s| s.id.clone()),
            name: specialist
                .map(|s| s.name.clone())
                .unwrap_or_else(|| worker.title.clone()),
            role: specialist.map(|s| s.role.clone()).unwrap_or_default(),
            instructions: specialist
                .map(|s| s.instructions.clone())
                .unwrap_or_default(),
            hired_at: crate::now(),
        };
        let result = self.change_feature(owner, |f| {
            f.team.retain(|m| m.worker_id != member.worker_id);
            f.team.push(member);
            if f.status == FeatureStatus::Planning {
                f.status = FeatureStatus::InProgress;
            }
            Ok(())
        });
        if let Err(e) = result {
            tracing::warn!("record team member of {owner}: {e:#}");
        }
    }

    /// The section of a hired worker's system prompt that makes it its
    /// specialist: as the specialist is now, or as it was when hired when it
    /// is gone.
    pub(super) fn specialist_prompt(&self, worker: &Session) -> Option<String> {
        let id = worker.specialist_id.as_deref()?;
        if let Ok(s) = self.specialist(id, Some(&self.project_root(&worker.cwd))) {
            return Some(specialists::worker_section(
                &s.name,
                &s.role,
                &s.instructions,
            ));
        }
        let owner = worker.orchestrator_id.as_deref()?;
        let feature = self.feature(owner).ok()?;
        let m = feature.member(&worker.id)?;
        (!m.instructions.trim().is_empty())
            .then(|| specialists::worker_section(&m.name, &m.role, &m.instructions))
    }

    // ----------------------------------------------------------------- team

    /// Start a worker as a specialist. The worker works on the specialist's
    /// preferred agent, model and effort unless the spec names others; a
    /// model or effort is only taken from the specialist for its own agent.
    pub async fn hire(&self, owner: &str, spec: HireSpec) -> Result<Session> {
        let o = self.feature_owner_session(owner)?;
        let cwd = self.worker_cwd(&o, spec.worker.cwd.as_deref())?;
        let me = self.clone();
        let id = spec.specialist.clone();
        let dir = cwd.clone();
        let specialist = tokio::task::spawn_blocking(move || {
            let project = me.project_root(&dir);
            me.specialist(&id, Some(&project))
        })
        .await
        .map_err(|e| anyhow!(e))??;
        let mut w = spec.worker;
        if w.agent.trim().is_empty() {
            w.agent = specialist.agent.clone().unwrap_or_else(|| agent_label(&o));
        }
        let bare = |a: &str| a.trim().trim_start_matches("acp:").to_ascii_lowercase();
        let its_agent = specialist
            .agent
            .as_deref()
            .is_none_or(|a| bare(a) == bare(&w.agent));
        if its_agent {
            if w.model.as_deref().is_none_or(|m| m.trim().is_empty()) {
                w.model = specialist.model.clone();
            }
            if w.effort.as_deref().is_none_or(|e| e.trim().is_empty()) {
                w.effort = specialist.effort.clone();
            }
        }
        if w.title.as_deref().is_none_or(|t| t.trim().is_empty()) {
            w.title = Some(specialist.name.clone());
        }
        w.cwd = Some(cwd);
        self.start_worker_as(owner, w, Some(&specialist)).await
    }

    // ------------------------------------------------------------ the user

    /// Put a decision to the user. It shows as a card in the owner's chat;
    /// the answer reaches the owner as a message from Aura.
    pub fn ask_user(&self, owner: &str, ask: AskSpec) -> Result<UserQuestion> {
        self.feature_owner_session(owner)?;
        let question = ask.question.trim().to_string();
        if question.is_empty() {
            bail!("`question` is required");
        }
        if ask.kind == QuestionKind::Checkpoint {
            bail!("use the `checkpoint` tool for checkpoints");
        }
        let autonomy = self.effective_autonomy(&self.feature(owner)?);
        if autonomy.level == AutonomyLevel::Autonomous && ask.kind != QuestionKind::Irreversible {
            bail!("the user set this feature to autonomous: decide this yourself and record it with `record_decision`. `ask_user` is only for an irreversible or outward-facing action, with `kind: \"irreversible\"`");
        }
        let mut options: Vec<DecisionOption> = vec![];
        for o in ask.options {
            let label = o.label.trim().to_string();
            if label.is_empty() || options.iter().any(|x| x.label.eq_ignore_ascii_case(&label)) {
                continue;
            }
            options.push(DecisionOption {
                label,
                description: o
                    .description
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty()),
            });
        }
        if options.is_empty() && ask.kind == QuestionKind::Irreversible {
            options = vec![
                DecisionOption {
                    label: "Yes, go ahead".into(),
                    description: None,
                },
                DecisionOption {
                    label: "No".into(),
                    description: None,
                },
            ];
        }
        let recommended = match ask
            .recommended
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
        {
            None => None,
            Some(r) => Some(
                options
                    .iter()
                    .find(|o| o.label.eq_ignore_ascii_case(r))
                    .map(|o| o.label.clone())
                    .ok_or_else(|| {
                        anyhow!("`recommended` must be the label of one of the options")
                    })?,
            ),
        };
        let (_, q) = self.change_feature(owner, |f| {
            let q = UserQuestion {
                id: f.next_id("q"),
                question,
                context: ask.context.trim().to_string(),
                options,
                recommended,
                kind: ask.kind,
                checkpoint: None,
                asked_at: crate::now(),
                answer: None,
                withdrawn: false,
            };
            f.questions.push(q.clone());
            f.settle_status();
            Ok(q)
        })?;
        self.post_card(owner, FeatureCardKind::Decision, &q.id, &q.question);
        Ok(q)
    }

    /// The user's answer to a question: an option, words of their own, or
    /// both. It is logged as the user's decision and sent to the owner.
    pub fn answer_question(
        &self,
        owner: &str,
        question: &str,
        option: Option<String>,
        text: String,
    ) -> Result<Feature> {
        self.feature_owner_session(owner)?;
        let text = text.trim().to_string();
        let option = option
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty());
        if option.is_none() && text.is_empty() {
            bail!("pick an option or write an answer");
        }
        let (f, q) = self.change_feature(owner, |f| {
            let q = f
                .questions
                .iter_mut()
                .find(|q| q.id == question)
                .ok_or_else(|| anyhow!("no question `{question}` in this feature"))?;
            if q.answer.is_some() {
                bail!("this question is answered already");
            }
            if q.withdrawn {
                bail!("this question was withdrawn when the feature was delivered");
            }
            let option = match option {
                None => None,
                Some(o) => Some(
                    q.options
                        .iter()
                        .find(|x| x.label.eq_ignore_ascii_case(&o))
                        .map(|x| x.label.clone())
                        .ok_or_else(|| anyhow!("`{o}` is not one of the options"))?,
                ),
            };
            q.answer = Some(QuestionAnswer {
                option: option.clone(),
                text: text.clone(),
                at: crate::now(),
                delivered: false,
            });
            let q = q.clone();
            let decision_id = f.next_id("d");
            f.decisions.push(Decision {
                id: decision_id,
                decision: format!(
                    "{} → {}",
                    q.question,
                    option.clone().unwrap_or_else(|| text.clone())
                ),
                rationale: if option.is_some() {
                    text.clone()
                } else {
                    String::new()
                },
                decided_by: DecidedBy::User,
                question_id: Some(q.id.clone()),
                at: crate::now(),
            });
            if q.kind == QuestionKind::Checkpoint {
                let approved = approves(&q);
                if let Some(c) = f
                    .checkpoints
                    .iter_mut()
                    .rev()
                    .find(|c| c.question_id.as_deref() == Some(q.id.as_str()))
                {
                    c.approved = Some(approved);
                }
            }
            f.settle_status();
            Ok(q)
        })?;
        self.queue_note(
            owner,
            Note {
                text: answer_message(&q),
                about: Some(NoteAbout::Answer(q.id.clone())),
            },
        );
        Ok(f)
    }

    /// Log a decision the owner made.
    pub fn record_decision(
        &self,
        owner: &str,
        decision: &str,
        rationale: &str,
    ) -> Result<Decision> {
        self.feature_owner_session(owner)?;
        let decision = decision.trim();
        if decision.is_empty() {
            bail!("`decision` is required");
        }
        let rationale = rationale.trim();
        if rationale.is_empty() {
            bail!("`rationale` is required: say in a line why");
        }
        let (_, d) = self.change_feature(owner, |f| {
            let d = Decision {
                id: f.next_id("d"),
                decision: decision.to_string(),
                rationale: rationale.to_string(),
                decided_by: DecidedBy::Owner,
                question_id: None,
                at: crate::now(),
            };
            f.decisions.push(d.clone());
            if f.status == FeatureStatus::Planning {
                f.status = FeatureStatus::InProgress;
            }
            Ok(d)
        })?;
        Ok(d)
    }

    /// The owner reached a checkpoint. When the user's autonomy setting
    /// stops there, the user is asked to review it.
    pub fn checkpoint(
        &self,
        owner: &str,
        checkpoint: Checkpoint,
        summary: &str,
    ) -> Result<CheckpointOutcome> {
        self.feature_owner_session(owner)?;
        let summary = summary.trim().to_string();
        if summary.is_empty() {
            bail!("`summary` is required: what there is to review, and where");
        }
        let autonomy = self.effective_autonomy(&self.feature(owner)?);
        let review = autonomy.stops_at(checkpoint);
        let (_, q) = self.change_feature(owner, |f| {
            let q = review.then(|| UserQuestion {
                id: f.next_id("q"),
                question: format!("Checkpoint {}: approve to go on?", checkpoint.label()),
                context: summary.clone(),
                options: review_options(checkpoint),
                recommended: None,
                kind: QuestionKind::Checkpoint,
                checkpoint: Some(checkpoint),
                asked_at: crate::now(),
                answer: None,
                withdrawn: false,
            });
            f.checkpoints.push(CheckpointRecord {
                checkpoint,
                summary,
                at: crate::now(),
                question_id: q.as_ref().map(|q| q.id.clone()),
                approved: None,
            });
            if let Some(q) = &q {
                f.questions.push(q.clone());
            }
            if f.status == FeatureStatus::Planning {
                f.status = FeatureStatus::InProgress;
            }
            f.settle_status();
            Ok(q)
        })?;
        if let Some(q) = &q {
            self.post_card(owner, FeatureCardKind::Decision, &q.id, &q.question);
        }
        Ok(CheckpointOutcome {
            checkpoint,
            review: q,
        })
    }

    /// Deliver the feature: the report goes into the record and shows as a
    /// card. Refused while a checkpoint review is open or asked for changes,
    /// and until the latest review of every checkpoint the user stops at
    /// approved it; checked in the same update that delivers. Other
    /// questions still open are withdrawn; a checkpoint review never is.
    pub fn deliver_report(&self, owner: &str, report: ReportSpec) -> Result<Feature> {
        self.feature_owner_session(owner)?;
        for (name, v) in [
            ("what", &report.what),
            ("why", &report.why),
            ("how_to_test", &report.how_to_test),
            ("where_to_test", &report.where_to_test),
        ] {
            if v.trim().is_empty() {
                bail!("`{name}` is required");
            }
        }
        let (f, _) = self.change_feature(owner, |f| {
            let autonomy = self.effective_autonomy(f);
            if let Some(hold) = f.review_hold(&autonomy) {
                bail!("{}", hold_message(&hold));
            }
            if let Some(c) = f.unapproved_checkpoint(&autonomy) {
                bail!("the user wants to review the checkpoint {}: call `checkpoint` with `{}` and a summary, end your turn, and deliver once they approve", c.label(), c.as_str());
            }
            f.report = Some(DeliveryReport {
                what: report.what.trim().to_string(),
                why: report.why.trim().to_string(),
                how_to_test: report.how_to_test.trim().to_string(),
                where_to_test: report.where_to_test.trim().to_string(),
                notes: report.notes.trim().to_string(),
                delivered_at: crate::now(),
            });
            for q in f
                .questions
                .iter_mut()
                .filter(|q| q.open() && q.kind != QuestionKind::Checkpoint)
            {
                q.withdrawn = true;
            }
            f.status = FeatureStatus::Delivered;
            Ok(())
        })?;
        self.post_card(owner, FeatureCardKind::Report, "report", "Delivery report");
        Ok(f)
    }

    /// Whether a feature owner may take someone new on: hire, or start an
    /// ad-hoc worker. Not while a checkpoint review is open or asked for changes.
    pub(super) fn may_staff(&self, owner: &str) -> Result<()> {
        let f = self.feature(owner)?;
        match f.review_hold(&self.effective_autonomy(&f)) {
            Some(hold) => bail!("{}", hold_message(&hold)),
            None => Ok(()),
        }
    }

    /// Whether a feature owner may send its workers work. Not while a
    /// checkpoint review is open; after a request for changes it may, so the
    /// team can rework.
    pub(super) fn may_message(&self, owner: &str) -> Result<()> {
        let f = self.feature(owner)?;
        match f.review_hold(&self.effective_autonomy(&f)) {
            Some(hold @ ReviewHold::Open(..)) => bail!("{}", hold_message(&hold)),
            _ => Ok(()),
        }
    }

    // ---------------------------------------------------------- suggestions

    /// Suggest a new specialist to the user, who accepts, edits or dismisses it.
    pub fn propose_specialist(
        &self,
        owner: &str,
        specialist: SpecialistInput,
        reason: &str,
    ) -> Result<SpecialistSuggestion> {
        self.feature_owner_session(owner)?;
        let specialist = specialists::validate(specialist)?;
        let (_, s) = self.change_feature(owner, |f| {
            if f.suggestions
                .iter()
                .any(|s| s.specialist.id == specialist.id && s.status != SuggestionStatus::Accepted)
            {
                bail!("you proposed `{}` already", specialist.id);
            }
            let s = SpecialistSuggestion {
                id: f.next_id("s"),
                specialist,
                reason: reason.trim().to_string(),
                status: SuggestionStatus::Pending,
                accepted_id: None,
                created_at: crate::now(),
                resolved_at: None,
                delivered: false,
            };
            f.suggestions.push(s.clone());
            Ok(s)
        })?;
        self.post_card(
            owner,
            FeatureCardKind::Suggestion,
            &s.id,
            &s.specialist.name,
        );
        Ok(s)
    }

    /// The user accepts a suggestion, as proposed or as they edited it
    /// (`specialist`, which also says the scope), or dismisses it. The owner
    /// hears which. The suggestion is claimed and the specialist saved in the
    /// one locked update of the feature, so of two resolutions at once only
    /// one succeeds; a specialist with its id is never overwritten.
    pub fn resolve_suggestion(
        &self,
        owner: &str,
        id: &str,
        accept: bool,
        specialist: Option<SpecialistInput>,
    ) -> Result<Feature> {
        self.feature_owner_session(owner)?;
        let mut created: Option<Specialist> = None;
        let result = self.change_feature(owner, |f| {
            let s = f
                .suggestions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| anyhow!("no suggestion `{id}` in this feature"))?;
            match s.status {
                SuggestionStatus::Pending => {}
                SuggestionStatus::Accepted => bail!("this suggestion was accepted already"),
                SuggestionStatus::Dismissed => bail!("this suggestion was dismissed already"),
            }
            if accept {
                let input = specialists::validate(specialist.unwrap_or_else(|| s.specialist.clone()))?;
                if self.specialist_taken(&input)? {
                    bail!(
                        "a specialist `{}` exists already{}; edit the suggestion to give it another id, or dismiss it",
                        input.id,
                        match &input.project {
                            Some(p) => format!(" in {p}"),
                            None => String::new(),
                        }
                    );
                }
                let saved = self.save_specialist(input)?;
                s.accepted_id = Some(saved.id.clone());
                created = Some(saved);
            }
            s.status = if accept {
                SuggestionStatus::Accepted
            } else {
                SuggestionStatus::Dismissed
            };
            s.resolved_at = Some(crate::now());
            Ok(s.clone())
        });
        let (f, s) = match result {
            Ok(r) => r,
            Err(e) => {
                // Saved, but the suggestion could not be marked: take it back.
                if let Some(c) = created {
                    let _ = self.delete_specialist(&c.id, c.scope, c.project.as_deref());
                }
                return Err(e);
            }
        };
        self.queue_note(
            owner,
            Note {
                text: suggestion_message(&s),
                about: Some(NoteAbout::Suggestion(s.id.clone())),
            },
        );
        Ok(f)
    }

    /// Mark what a note brought the owner as delivered.
    pub(super) fn note_delivered(&self, owner: &str, about: &NoteAbout) {
        let result = self.change_feature(owner, |f| {
            match about {
                NoteAbout::Answer(id) => {
                    if let Some(a) = f
                        .questions
                        .iter_mut()
                        .find(|q| &q.id == id)
                        .and_then(|q| q.answer.as_mut())
                    {
                        a.delivered = true;
                    }
                }
                NoteAbout::Suggestion(id) => {
                    if let Some(s) = f.suggestions.iter_mut().find(|s| &s.id == id) {
                        s.delivered = true;
                    }
                }
            }
            Ok(())
        });
        if let Err(e) = result {
            tracing::warn!("mark a message to {owner} delivered: {e:#}");
        }
    }

    /// Queue again what owners were not sent before the daemon stopped: the
    /// user's answers and what became of their suggestions.
    pub(super) fn requeue_undelivered(&self) {
        let features = match self.features() {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("features: {e:#}");
                return;
            }
        };
        for f in features {
            let mut notes = vec![];
            for q in &f.questions {
                if q.answer.as_ref().is_some_and(|a| !a.delivered) {
                    notes.push(Note {
                        text: answer_message(q),
                        about: Some(NoteAbout::Answer(q.id.clone())),
                    });
                }
            }
            for s in &f.suggestions {
                if s.status != SuggestionStatus::Pending && !s.delivered {
                    notes.push(Note {
                        text: suggestion_message(s),
                        about: Some(NoteAbout::Suggestion(s.id.clone())),
                    });
                }
            }
            if notes.is_empty() {
                continue;
            }
            // The agent may have had one before its mark was stored: its
            // transcript says so, and it is not sent twice.
            let received: Vec<String> = self
                .items(&f.owner_id)
                .unwrap_or_default()
                .into_iter()
                .filter(|i| i.kind == ItemKind::UserMessage)
                .map(|i| i.text.trim().to_string())
                .collect();
            for note in notes {
                match note.about.as_ref() {
                    Some(about) if received.iter().any(|t| *t == note.text.trim()) => {
                        self.note_delivered(&f.owner_id, about)
                    }
                    _ => self.queue_note(&f.owner_id, note),
                }
            }
        }
    }

    // ---------------------------------------------------------------- cards

    /// Put a card in the owner's chat: a `system` item pointing into the
    /// feature record, in the turn that made it.
    fn post_card(&self, owner: &str, kind: FeatureCardKind, id: &str, text: &str) {
        let turn = self
            .inner
            .runtimes
            .lock()
            .get(owner)
            .and_then(|r| r.current_turn.as_ref().map(|t| t.id.clone()));
        let title = match kind {
            FeatureCardKind::Decision => "Decision for the user",
            FeatureCardKind::Report => "Delivery report",
            FeatureCardKind::Suggestion => "Specialist suggestion",
        };
        let item = Item::new(owner, turn, ItemKind::System)
            .with_title(title)
            .with_text(text)
            .with_data(card_data(kind, id, text))
            .completed();
        self.publish(Event::ItemCompleted {
            session_id: owner.to_string(),
            item,
        });
    }
}

/// What the owner is told when a checkpoint review holds it back.
fn hold_message(hold: &ReviewHold) -> String {
    match hold {
        ReviewHold::Open(c, q) => format!("wait for the user's review: the checkpoint {} (question `{q}`) is open. End your turn; Aura sends you their answer. Until then nobody is hired, started or sent work, and nothing is delivered", c.label()),
        ReviewHold::ChangesAsked(c) => format!("the user asked for changes at the checkpoint {}: rework it with the team you have (send_message still works), then call `checkpoint` again. Nobody new joins the team and nothing is delivered until they approve", c.label()),
    }
}
