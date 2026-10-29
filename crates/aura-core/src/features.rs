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
use std::collections::BTreeMap;
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
    /// The last number handed out per id prefix (`q` questions, `d`
    /// decisions, `s` suggestions), so an id is never handed out twice, also
    /// when a fork leaves out the questions still open.
    #[serde(default)]
    #[ts(type = "Record<string, number>")]
    pub counters: BTreeMap<String, u64>,
}

/// What a checkpoint review keeps the owner from doing.
#[derive(Debug, Clone, PartialEq)]
pub enum ReviewHold {
    /// The user has not answered this review (by question id) yet: the owner waits.
    Open(Checkpoint, String),
    /// The user asked for changes at this checkpoint, and no later review was approved.
    ChangesAsked(Checkpoint),
}

impl Feature {
    /// Raise the counters to the ids in use, so ids the record had before
    /// counters were kept are never handed out again, also once they are gone
    /// (a fork leaves out the questions still open). Call it on the whole
    /// record before taking anything out of it.
    pub fn seed_counters(&mut self) {
        for prefix in ["q", "d", "s"] {
            self.next_id_seed(prefix);
        }
    }

    /// Raise the counter of `prefix` to the highest id in use; returns it.
    fn next_id_seed(&mut self, prefix: &str) -> u64 {
        let used = match prefix {
            "q" => self
                .questions
                .iter()
                .map(|q| q.id.as_str())
                .collect::<Vec<_>>(),
            "d" => self.decisions.iter().map(|d| d.id.as_str()).collect(),
            "s" => self.suggestions.iter().map(|s| s.id.as_str()).collect(),
            _ => vec![],
        }
        .into_iter()
        .filter_map(|id| id.strip_prefix(prefix)?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
        let n = self.counters.entry(prefix.to_string()).or_default();
        *n = (*n).max(used);
        *n
    }

    /// A new id with `prefix`, higher than any that prefix had before.
    pub fn next_id(&mut self, prefix: &str) -> String {
        let n = self.next_id_seed(prefix) + 1;
        self.counters.insert(prefix.to_string(), n);
        format!("{prefix}{n}")
    }

    /// The latest record of a checkpoint: the one whose review counts.
    pub fn latest_checkpoint(&self, c: Checkpoint) -> Option<&CheckpointRecord> {
        self.checkpoints.iter().rev().find(|r| r.checkpoint == c)
    }

    /// What the checkpoint reviews hold back: a review still open (whatever
    /// the autonomy says now, the user was asked), or else the latest review
    /// of a checkpoint the user still stops at, which asked for changes.
    pub fn review_hold(&self, autonomy: &Autonomy) -> Option<ReviewHold> {
        if let Some(q) = self
            .questions
            .iter()
            .find(|q| q.kind == QuestionKind::Checkpoint && q.open())
        {
            let c = q.checkpoint.unwrap_or(Checkpoint::BeforeDelivery);
            return Some(ReviewHold::Open(c, q.id.clone()));
        }
        Checkpoint::ALL
            .into_iter()
            .find(|c| {
                autonomy.stops_at(*c)
                    && self
                        .latest_checkpoint(*c)
                        .is_some_and(|r| r.approved == Some(false))
            })
            .map(ReviewHold::ChangesAsked)
    }

    /// A checkpoint the user stops at whose latest review is not an approval.
    pub fn unapproved_checkpoint(&self, autonomy: &Autonomy) -> Option<Checkpoint> {
        Checkpoint::ALL.into_iter().find(|c| {
            autonomy.stops_at(*c)
                && self
                    .latest_checkpoint(*c)
                    .is_none_or(|r| r.approved != Some(true))
        })
    }

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
            counters: BTreeMap::new(),
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
    if q.kind == QuestionKind::Checkpoint && q.answer.is_some() {
        out.push_str(if approves(q) {
            "Verdict: approved.\n"
        } else {
            "Verdict: changes requested.\n"
        });
    }
    out.push_str(match q.kind {
        QuestionKind::Checkpoint => "\nThe user's answer is recorded in the feature's decision log. Go on past the checkpoint only when the verdict is approved; otherwise rework what they asked for with the team you have and call `checkpoint` again. Nobody new joins the team and nothing is delivered until they approve.",
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

/// Whether a checkpoint review answer approves it: the approve option (the
/// first), whatever note comes with it, or words of the user's own that are
/// exactly an approval (`approve`, `yes`, `lgtm`). Anything else the user
/// writes asks for changes.
pub fn approves(q: &UserQuestion) -> bool {
    let Some(a) = &q.answer else { return false };
    match a.option.as_deref() {
        Some(o) => q.options.first().is_some_and(|first| first.label == o),
        None => {
            let t = a
                .text
                .trim()
                .trim_end_matches(['.', '!'])
                .trim()
                .to_lowercase();
            ["approve", "approved", "yes", "ok", "okay", "lgtm"].contains(&t.as_str())
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
        q.answer = answer(None, "Yes");
        assert!(approves(&q));
        q.answer = answer(None, "Yes, go ahead");
        assert!(!approves(&q), "more than a yes is a request");
        q.answer = answer(None, "yesterday's version please");
        assert!(!approves(&q));
    }

    #[test]
    fn only_an_approve_option_or_an_exact_approval_approves() {
        let mut q = question(QuestionKind::Checkpoint);
        let answer = |option: Option<&str>, text: &str| {
            Some(QuestionAnswer {
                option: option.map(Into::into),
                text: text.into(),
                at: crate::now(),
                delivered: false,
            })
        };
        for changes in [
            "Go back and add regression tests",
            "ok but rename it",
            "Yes, after you fix the tests",
            "ship it once the reviewer is happy",
            "approve? no",
        ] {
            q.answer = answer(None, changes);
            assert!(!approves(&q), "{changes:?} asks for changes");
        }
        for yes in ["Approve", "approved.", " LGTM ", "yes!", "ok"] {
            q.answer = answer(None, yes);
            assert!(approves(&q), "{yes:?} approves");
        }
        q.answer = answer(Some("Approve"), "nice work");
        assert!(approves(&q));
        q.answer = answer(Some("Request changes"), "approve");
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
    fn ids_are_never_handed_out_twice() {
        let mut f = Feature::new("o", "", None);
        assert_eq!(f.next_id("q"), "q1");
        assert_eq!(f.next_id("q"), "q2");
        assert_eq!(f.next_id("d"), "d1");
        // A record from before the counters: ids go on after the highest in use.
        let mut old = Feature::new("o", "", None);
        let mut q = question(QuestionKind::Decision);
        q.id = "q7".into();
        old.questions.push(q);
        assert_eq!(old.next_id("q"), "q8");
        // Ids that are gone are not reused.
        old.questions.clear();
        assert_eq!(old.next_id("q"), "q9");
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
