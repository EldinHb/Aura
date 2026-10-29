//! Features: what a feature owner session owns. One record per feature
//! owner, kept in the store's `features` namespace under the owner's session
//! id, so it outlives the daemon: the goal, the status, the team, every
//! decision with its rationale, the questions put to the user, the
//! checkpoints passed, the specialists proposed and the delivery report.
//!
//! The record is the source of truth for the cards the app shows in the
//! owner's chat. Each card is a `system` item in the owner's transcript with
//! `data.feature_card = { kind, id }` pointing into the record (see
//! [`card_data`]), so it sits where it happened and shows the record's
//! current state, answered or not.
use crate::autonomy::{Autonomy, Checkpoint};
use crate::specialists::SpecialistInput;
use crate::types::SessionId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Feature-record namespace of features, by owner session id.
pub const NAMESPACE: &str = "features";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeatureStatus {
    /// Created; nobody is working on it yet.
    #[default]
    Planning,
    InProgress,
    /// A question to the user is open.
    WaitingOnUser,
    /// The owner delivered its report.
    Delivered,
}

impl FeatureStatus {
    pub fn label(&self) -> &'static str {
        match self {
            FeatureStatus::Planning => "planning",
            FeatureStatus::InProgress => "in progress",
            FeatureStatus::WaitingOnUser => "waiting on the user",
            FeatureStatus::Delivered => "delivered",
        }
    }
}

/// A worker on the feature's team.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TeamMember {
    pub worker_id: SessionId,
    /// The specialist it was hired as; none for an ad-hoc worker.
    #[serde(default)]
    pub specialist_id: Option<String>,
    /// The specialist's name, or the worker's title for an ad-hoc worker.
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// The specialist's instructions as they were when it was hired, used
    /// when the specialist is deleted later.
    #[serde(default)]
    pub instructions: String,
    pub hired_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DecidedBy {
    Owner,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Decision {
    pub id: String,
    pub decision: String,
    pub rationale: String,
    pub decided_by: DecidedBy,
    /// The question it answered, for the user's decisions.
    #[serde(default)]
    pub question_id: Option<String>,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DecisionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum QuestionKind {
    /// A decision that is the user's.
    #[default]
    Decision,
    /// Permission for an irreversible or outward-facing action.
    Irreversible,
    /// A checkpoint the user wants to review.
    Checkpoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QuestionAnswer {
    /// The option the user picked, if any.
    #[serde(default)]
    pub option: Option<String>,
    /// What the user wrote, besides or instead of an option.
    #[serde(default)]
    pub text: String,
    pub at: DateTime<Utc>,
    /// The owner was sent the answer.
    #[serde(default)]
    pub delivered: bool,
}

/// A question the owner put to the user with `ask_user` or `checkpoint`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserQuestion {
    pub id: String,
    pub question: String,
    /// What the user needs to know to decide.
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub options: Vec<DecisionOption>,
    /// The label of the option the owner recommends.
    #[serde(default)]
    pub recommended: Option<String>,
    #[serde(default)]
    pub kind: QuestionKind,
    /// For a checkpoint review: which one.
    #[serde(default)]
    pub checkpoint: Option<Checkpoint>,
    pub asked_at: DateTime<Utc>,
    #[serde(default)]
    pub answer: Option<QuestionAnswer>,
    /// No longer open without an answer: the feature was delivered.
    #[serde(default)]
    pub withdrawn: bool,
}

impl UserQuestion {
    pub fn open(&self) -> bool {
        self.answer.is_none() && !self.withdrawn
    }
}

/// A checkpoint the owner reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CheckpointRecord {
    pub checkpoint: Checkpoint,
    pub summary: String,
    pub at: DateTime<Utc>,
    /// The review question, when the user's autonomy setting stops here.
    #[serde(default)]
    pub question_id: Option<String>,
    /// The user's verdict on the review: approved, or changes asked for.
    /// None while the review is open, and when no review was needed.
    #[serde(default)]
    pub approved: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SuggestionStatus {
    #[default]
    Pending,
    Accepted,
    Dismissed,
}

/// A specialist the owner proposed with `propose_specialist`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpecialistSuggestion {
    pub id: String,
    pub specialist: SpecialistInput,
    /// Why the team needs it.
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub status: SuggestionStatus,
    /// The id of the specialist created when the user accepted it.
    #[serde(default)]
    pub accepted_id: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub resolved_at: Option<DateTime<Utc>>,
    /// The owner was told what became of it.
    #[serde(default)]
    pub delivered: bool,
}

/// What the user gets when the feature is done.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeliveryReport {
    /// What was done.
    pub what: String,
    /// Why it was done this way: the decisions that shaped it.
    pub why: String,
    /// Steps for the user to try it.
    pub how_to_test: String,
    /// Where to test: branch, worktree, URL, screen.
    pub where_to_test: String,
    /// Anything else: known limits, follow-ups the user may want.
    #[serde(default)]
    pub notes: String,
    pub delivered_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Feature {
    /// The feature owner's session id, which is also the record's id.
    pub owner_id: SessionId,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub status: FeatureStatus,
    /// This feature's own autonomy; none follows the setting for all feature owners.
    #[serde(default)]
    pub autonomy: Option<Autonomy>,
    #[serde(default)]
    pub team: Vec<TeamMember>,
    #[serde(default)]
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub questions: Vec<UserQuestion>,
    #[serde(default)]
    pub checkpoints: Vec<CheckpointRecord>,
    #[serde(default)]
    pub suggestions: Vec<SpecialistSuggestion>,
    #[serde(default)]
    pub report: Option<DeliveryReport>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Feature {
    pub fn new(owner_id: &str, goal: &str, autonomy: Option<Autonomy>) -> Self {
        let now = crate::now();
        Feature {
            owner_id: owner_id.to_string(),
            goal: goal.trim().to_string(),
            status: FeatureStatus::Planning,
            autonomy: autonomy.map(Autonomy::tidy),
            team: vec![],
            decisions: vec![],
            questions: vec![],
            checkpoints: vec![],
            suggestions: vec![],
            report: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn question(&self, id: &str) -> Option<&UserQuestion> {
        self.questions.iter().find(|q| q.id == id)
    }

    /// The status that follows from the open questions, once work has started.
    pub fn settle_status(&mut self) {
        if self.questions.iter().any(UserQuestion::open) {
            self.status = FeatureStatus::WaitingOnUser;
        } else if self.status == FeatureStatus::WaitingOnUser {
            self.status = if self.report.is_some() {
                FeatureStatus::Delivered
            } else {
                FeatureStatus::InProgress
            };
        }
    }

    /// The team member hired as this worker.
    pub fn member(&self, worker_id: &str) -> Option<&TeamMember> {
        self.team.iter().find(|m| m.worker_id == worker_id)
    }
}

/// What a card in the owner's chat shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeatureCardKind {
    /// A question to the user (`UserQuestion`), checkpoint reviews included.
    Decision,
    /// The delivery report.
    Report,
    /// A proposed specialist (`SpecialistSuggestion`).
    Suggestion,
}

/// `data` of the `system` item that puts a card in the owner's chat.
pub fn card_data(kind: FeatureCardKind, id: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "feature_card": { "kind": kind, "id": id },
        "message": message,
    })
}

/// The message from Aura that brings the owner the user's answer.
pub fn answer_message(q: &UserQuestion) -> String {
    let title = match q.kind {
        QuestionKind::Checkpoint => "Checkpoint review from the user",
        _ => "Decision from the user",
    };
    let mut out = format!(
        "{}Question (`{}`): {}\n",
        crate::prompts::aura_header(title),
        q.id,
        q.question.trim()
    );
    if let Some(a) = &q.answer {
        if let Some(o) = &a.option {
            out.push_str(&format!("Answer: {o}\n"));
        }
        if !a.text.trim().is_empty() {
            out.push_str(&format!(
                "{}{}\n",
                if a.option.is_some() {
                    "Note: "
                } else {
                    "Answer: "
                },
                a.text.trim()
            ));
        }
    }
    out.push_str(match q.kind {
        QuestionKind::Checkpoint => "\nThe user's answer is recorded in the feature's decision log. Go on when they approved; otherwise rework what they asked for and call `checkpoint` again.",
        QuestionKind::Irreversible => "\nThe answer is recorded in the feature's decision log. Act on it: go ahead only if the user said yes.",
        QuestionKind::Decision => "\nThe answer is recorded in the feature's decision log. Continue with it.",
    });
    out
}

/// The message from Aura that tells the owner what became of its suggestion.
pub fn suggestion_message(s: &SpecialistSuggestion) -> String {
    match s.status {
        SuggestionStatus::Accepted => format!(
            "{}The user accepted your suggestion \"{}\". It is specialist `{}` now; `hire` it when you need it.",
            crate::prompts::aura_header("Specialist suggestion accepted"),
            s.specialist.name,
            s.accepted_id.as_deref().unwrap_or(&s.specialist.id)
        ),
        _ => format!(
            "{}The user dismissed your suggestion \"{}\". Do not propose it again for this feature.",
            crate::prompts::aura_header("Specialist suggestion dismissed"),
            s.specialist.name
        ),
    }
}

/// Whether a checkpoint review answer approves it: the first option
/// (`Approve`), or an answer that starts with a yes.
pub fn approves(q: &UserQuestion) -> bool {
    let Some(a) = &q.answer else { return false };
    let first = q.options.first().map(|o| o.label.as_str());
    match a.option.as_deref() {
        Some(o) => Some(o) == first,
        None => {
            let t = a.text.trim().to_lowercase();
            let word = t.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
            [
                "approve", "approved", "yes", "ok", "okay", "lgtm", "go", "ship",
            ]
            .contains(&word)
        }
    }
}

/// The options of a checkpoint review: approve first.
pub fn review_options(c: Checkpoint) -> Vec<DecisionOption> {
    vec![
        DecisionOption {
            label: "Approve".into(),
            description: Some(format!("Go on past the checkpoint {}.", c.label())),
        },
        DecisionOption {
            label: "Request changes".into(),
            description: Some("Say what to change; the owner reworks it and asks again.".into()),
        },
    ]
}

/// The feature as text for its owner, for `feature_status`-style answers.
pub fn describe(f: &Feature, autonomy: &Autonomy) -> String {
    let mut out = format!(
        "Feature status: {} · autonomy: {}{}\n",
        f.status.label(),
        autonomy.describe(),
        if f.autonomy.is_some() {
            " (this feature's own)"
        } else {
            ""
        }
    );
    if !f.team.is_empty() {
        out.push_str("Team:\n");
        for m in &f.team {
            out.push_str(&format!(
                "- {} (`{}`){}\n",
                m.name,
                m.worker_id,
                m.specialist_id
                    .as_ref()
                    .map(|s| format!(", specialist `{s}`"))
                    .unwrap_or_else(|| ", ad-hoc".into())
            ));
        }
    }
    let open: Vec<&UserQuestion> = f.questions.iter().filter(|q| q.open()).collect();
    if !open.is_empty() {
        out.push_str("Waiting on the user for:\n");
        for q in open {
            out.push_str(&format!("- (`{}`) {}\n", q.id, q.question));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(kind: QuestionKind) -> UserQuestion {
        UserQuestion {
            id: "q1".into(),
            question: "Which layout?".into(),
            context: String::new(),
            options: review_options(Checkpoint::AfterDesign),
            recommended: Some("Approve".into()),
            kind,
            checkpoint: None,
            asked_at: crate::now(),
            answer: None,
            withdrawn: false,
        }
    }

    #[test]
    fn answers_reach_the_owner_as_messages_from_aura() {
        let mut q = question(QuestionKind::Decision);
        q.answer = Some(QuestionAnswer {
            option: Some("Approve".into()),
            text: "but keep it small".into(),
            at: crate::now(),
            delivered: false,
        });
        let m = answer_message(&q);
        assert!(crate::prompts::is_aura_message(&m), "{m}");
        assert!(m.starts_with("[Aura] Decision from the user. "), "{m}");
        assert!(
            m.contains(
                "Question (`q1`): Which layout?\nAnswer: Approve\nNote: but keep it small\n"
            ),
            "{m}"
        );
        q.kind = QuestionKind::Checkpoint;
        assert!(answer_message(&q).starts_with("[Aura] Checkpoint review from the user. "));
    }

    #[test]
    fn a_review_is_approved_by_the_first_option_or_a_plain_yes() {
        let mut q = question(QuestionKind::Checkpoint);
        assert!(!approves(&q));
        let answer = |option: Option<&str>, text: &str| {
            Some(QuestionAnswer {
                option: option.map(Into::into),
                text: text.into(),
                at: crate::now(),
                delivered: false,
            })
        };
        q.answer = answer(Some("Approve"), "");
        assert!(approves(&q));
        q.answer = answer(Some("Request changes"), "yes but");
        assert!(!approves(&q));
        q.answer = answer(None, "Yes, go ahead");
        assert!(approves(&q));
        q.answer = answer(None, "yesterday's version please");
        assert!(!approves(&q));
    }

    #[test]
    fn the_status_follows_the_open_questions() {
        let mut f = Feature::new("o", "Goal", None);
        f.questions.push(question(QuestionKind::Decision));
        f.settle_status();
        assert_eq!(f.status, FeatureStatus::WaitingOnUser);
        f.questions[0].withdrawn = true;
        f.settle_status();
        assert_eq!(f.status, FeatureStatus::InProgress);
    }

    #[test]
    fn records_saved_by_older_versions_still_load() {
        let f: Feature = serde_json::from_str(
            r#"{"owner_id":"o","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(f.status, FeatureStatus::Planning);
        assert!(f.team.is_empty() && f.report.is_none());
    }
}
