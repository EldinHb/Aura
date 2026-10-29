//! Features: what a feature owner session owns. One record per feature
//! owner, kept in the store's `features` namespace under the owner's session
//! id, so it outlives the daemon: the goal, the status, the team, every
//! decision with its rationale, the questions put to the user, the
//! checkpoints passed, the specialists proposed, the team's meetings and
//! one-on-ones, and the delivery report.
//!
//! The record is the source of truth for the cards the app shows in the
//! owner's chat. Each card is a `system` item in the owner's transcript with
//! `data.feature_card = { kind, id }` pointing into the record (see
//! [`card_data`]), so it sits where it happened and shows the record's
//! current state, answered or not.
use crate::autonomy::{Autonomy, Checkpoint};
use crate::meetings::MeetingMode;
use crate::specialists::SpecialistInput;
use crate::suggestions::SuggestionEvidence;
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
    /// Hired as a guest of this meeting, for its input only.
    #[serde(default)]
    pub meeting: Option<String>,
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
    /// The meeting it came out of.
    #[serde(default)]
    pub meeting_id: Option<String>,
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
    /// For a suggestion Aura found in repeated ad-hoc work rather than one
    /// the owner proposed: the briefs it found the role in.
    #[serde(default)]
    pub evidence: Vec<SuggestionEvidence>,
    /// For a suggestion Aura found: the feature owner whose chat shows it,
    /// when it was found for one.
    #[serde(default)]
    pub owner_id: Option<SessionId>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MeetingStatus {
    /// Waiting for the attendees' answers.
    #[default]
    Collecting,
    /// Every attendee answered.
    Complete,
    /// Closed with answers missing: an attendee failed, went, or the time ran out.
    Incomplete,
    /// A live meeting's round is over: the chair reads it and continues or closes it.
    WaitingOnChair,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AttendeeStatus {
    /// The agenda waits for the attendee to be free.
    #[default]
    Invited,
    /// The attendee was sent the agenda and is answering.
    Asked,
    Answered,
    /// No answer: the attendee failed, was stopped or deleted, or the time ran out.
    Missing,
    /// Answered after the meeting closed; kept, not sent to the owner.
    Late,
}

impl AttendeeStatus {
    /// Still expected to answer.
    pub fn pending(self) -> bool {
        matches!(self, AttendeeStatus::Invited | AttendeeStatus::Asked)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeetingAttendee {
    pub worker_id: SessionId,
    /// The team member's name.
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// Hired just for this meeting.
    #[serde(default)]
    pub guest: bool,
    #[serde(default)]
    pub status: AttendeeStatus,
    /// What the attendee wrote: its final reply of the turn that answered.
    #[serde(default)]
    pub answer: Option<String>,
    /// Why there is no answer.
    #[serde(default)]
    pub missing: Option<String>,
    #[serde(default)]
    pub answered_at: Option<DateTime<Utc>>,
}

/// One entry in a live meeting's thread: an attendee's turn, or the steer
/// with which the chair opens a round after the first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeetingTurn {
    /// The round, from 1.
    pub round: u32,
    /// The attendee, or the owner for the chair's steer.
    pub worker_id: SessionId,
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// The chair's steer, not an attendee's turn.
    #[serde(default)]
    pub chair: bool,
    /// Invited until it is this attendee's turn and it is free; asked once sent.
    #[serde(default)]
    pub status: AttendeeStatus,
    #[serde(default)]
    pub text: Option<String>,
    /// Why there is no turn.
    #[serde(default)]
    pub missing: Option<String>,
    #[serde(default)]
    pub at: Option<DateTime<Utc>>,
}

/// A meeting the owner held with `hold_meeting`. Written: every attendee is
/// sent the agenda and answers in writing, and the owner gets all answers in
/// one message from Aura. Live: a thread in rounds the owner chairs, in
/// which the attendees speak in turn (see [`crate::meetings`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Meeting {
    pub id: String,
    pub topic: String,
    /// The question the attendees answer.
    pub agenda: String,
    #[serde(default)]
    pub context: String,
    pub attendees: Vec<MeetingAttendee>,
    #[serde(default)]
    pub status: MeetingStatus,
    /// The decisions the owner recorded from it: its outcome.
    #[serde(default)]
    pub decision_ids: Vec<String>,
    pub started_at: DateTime<Utc>,
    /// Answers not in by then are missing.
    pub deadline: DateTime<Utc>,
    #[serde(default)]
    pub ended_at: Option<DateTime<Utc>>,
    /// The owner was sent the answers: for a live meeting, those of its
    /// latest round.
    #[serde(default)]
    pub delivered: bool,
    #[serde(default)]
    pub mode: MeetingMode,
    /// For a live meeting: the round under way or last held, from 1.
    #[serde(default)]
    pub round: u32,
    /// For a live meeting: the most rounds it may have.
    #[serde(default)]
    pub max_rounds: u32,
    /// For a live meeting: about how many words each turn keeps to.
    #[serde(default)]
    pub turn_words: u32,
    /// For a live meeting: the thread, in order.
    #[serde(default)]
    pub turns: Vec<MeetingTurn>,
    /// What the chair closed the meeting with.
    #[serde(default)]
    pub outcome: Option<String>,
    /// For a live meeting: the minutes each round waits for its turns.
    #[serde(default)]
    pub timeout_minutes: u32,
    /// For a live meeting: attendees gone for good (deleted, archived or
    /// stopped by the user), who get no more turns.
    #[serde(default)]
    pub left: Vec<SessionId>,
}

impl Meeting {
    pub fn attendee(&self, worker_id: &str) -> Option<&MeetingAttendee> {
        self.attendees.iter().find(|a| a.worker_id == worker_id)
    }

    pub fn live(&self) -> bool {
        self.mode == MeetingMode::Live
    }

    /// The minutes the meeting, or each round of a live one, waits for answers.
    pub fn minutes(&self) -> i64 {
        if self.timeout_minutes > 0 {
            return self.timeout_minutes as i64;
        }
        (self.deadline - self.started_at).num_minutes().max(1)
    }

    /// Not closed yet: collecting answers, or a live meeting waiting on its chair.
    pub fn open(&self) -> bool {
        matches!(
            self.status,
            MeetingStatus::Collecting | MeetingStatus::WaitingOnChair
        )
    }

    /// For a live meeting: the index in `turns` of the turn whose speaker is
    /// to speak now.
    pub fn current_turn(&self) -> Option<usize> {
        if !self.live() || self.status != MeetingStatus::Collecting {
            return None;
        }
        self.turns
            .iter()
            .position(|t| t.round == self.round && !t.chair && t.status.pending())
    }

    /// The turns of a round, the chair's steer first.
    pub fn round_turns(&self, round: u32) -> impl Iterator<Item = &MeetingTurn> {
        self.turns.iter().filter(move |t| t.round == round)
    }

    /// End a live meeting's round once nobody in it is expected to speak:
    /// the chair takes it from there. True when this ended it.
    pub fn settle_round(&mut self) -> bool {
        if !self.live() || self.status != MeetingStatus::Collecting || self.current_turn().is_some()
        {
            return false;
        }
        self.status = MeetingStatus::WaitingOnChair;
        self.delivered = false;
        true
    }

    /// Mirror a live meeting's turn on its attendee, so the attendee shows
    /// how it took part last.
    pub fn sync_attendee(&mut self, turn: usize) {
        let Some(t) = self.turns.get(turn).cloned() else {
            return;
        };
        if let Some(a) = self
            .attendees
            .iter_mut()
            .find(|a| a.worker_id == t.worker_id)
        {
            a.status = t.status;
            if t.text.is_some() {
                a.answer = t.text;
                a.answered_at = t.at;
            }
            a.missing = t.missing;
        }
    }

    /// Close the meeting once nobody is expected to answer any more. True
    /// when this closed it. Live meetings are closed by their chair.
    pub fn settle(&mut self) -> bool {
        if self.live()
            || self.status != MeetingStatus::Collecting
            || self.attendees.iter().any(|a| a.status.pending())
        {
            return false;
        }
        self.status = if self
            .attendees
            .iter()
            .all(|a| a.status == AttendeeStatus::Answered)
        {
            MeetingStatus::Complete
        } else {
            MeetingStatus::Incomplete
        };
        self.ended_at = Some(crate::now());
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OneOnOneStatus {
    /// Waiting for the answer.
    #[default]
    Open,
    Answered,
    /// No answer will come: the one asked failed, was stopped or deleted.
    Failed,
}

/// A question one team member put to another, or to the owner, with
/// `ask_teammate` or `ask_owner`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OneOnOne {
    pub id: String,
    /// The worker that asked.
    pub from_id: SessionId,
    pub from_name: String,
    /// The teammate asked, or the owner's id when the owner was asked.
    pub to_id: SessionId,
    pub to_name: String,
    /// The owner was asked, not a teammate.
    #[serde(default)]
    pub to_owner: bool,
    pub question: String,
    #[serde(default)]
    pub answer: Option<String>,
    /// Why no answer will come.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub status: OneOnOneStatus,
    pub asked_at: DateTime<Utc>,
    #[serde(default)]
    pub answered_at: Option<DateTime<Utc>>,
    /// The one asked was sent the question.
    #[serde(default)]
    pub sent: bool,
    /// The asker was sent the answer, or told none will come.
    #[serde(default)]
    pub delivered: bool,
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
    /// This feature's own meeting mode; none follows the setting for all feature owners.
    #[serde(default)]
    pub meeting_mode: Option<MeetingMode>,
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
    pub meetings: Vec<Meeting>,
    #[serde(default)]
    pub one_on_ones: Vec<OneOnOne>,
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
        for prefix in ["q", "d", "s", "m", "a"] {
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
            "m" => self.meetings.iter().map(|m| m.id.as_str()).collect(),
            "a" => self.one_on_ones.iter().map(|a| a.id.as_str()).collect(),
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
            meeting_mode: None,
            team: vec![],
            decisions: vec![],
            questions: vec![],
            checkpoints: vec![],
            suggestions: vec![],
            meetings: vec![],
            one_on_ones: vec![],
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

    pub fn meeting(&self, id: &str) -> Option<&Meeting> {
        self.meetings.iter().find(|m| m.id == id)
    }

    pub fn one_on_one(&self, id: &str) -> Option<&OneOnOne> {
        self.one_on_ones.iter().find(|a| a.id == id)
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
    /// A meeting the owner held (`Meeting`): a one-line pointer to the Team tab.
    Meeting,
    /// A specialist Aura found in the team's repeated ad-hoc work
    /// (`SpecialistSuggestion`, kept with the user's other suggestions, not in the feature).
    RoleSuggestion,
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

/// A team member as messages name it: `Tester (QA engineer)`.
fn who(name: &str, role: &str) -> String {
    if role.trim().is_empty() {
        name.to_string()
    } else {
        format!("{name} ({})", role.trim())
    }
}

/// The message from Aura that brings an attendee a meeting's agenda.
pub fn agenda_message(m: &Meeting, owner: &str, attendee: &MeetingAttendee) -> String {
    let others: Vec<String> = m
        .attendees
        .iter()
        .filter(|a| a.worker_id != attendee.worker_id)
        .map(|a| who(&a.name, &a.role))
        .collect();
    let mut out = format!(
        "{}{owner}, the feature owner, holds a written meeting (`{}`) and asks for your input as {}.\nTopic: {}\n",
        crate::prompts::aura_header("Meeting"),
        m.id,
        who(&attendee.name, &attendee.role),
        m.topic.trim(),
    );
    if !others.is_empty() {
        out.push_str(&format!("Also asked: {}\n", others.join(", ")));
    }
    out.push_str(&format!("\nQuestion:\n{}\n", m.agenda.trim()));
    if !m.context.trim().is_empty() {
        out.push_str(&format!("\nContext:\n{}\n", m.context.trim()));
    }
    out.push_str("\nAnswer in your final message of this turn, briefly: your view from your role, the risks you see and what you recommend. Do not start on the work itself and do not ask anyone; the owner decides and briefs the team. Aura gives your answer to the owner only.");
    out
}

/// The one message from Aura that brings the owner every answer to its meeting.
pub fn meeting_message(m: &Meeting) -> String {
    let title = match m.status {
        MeetingStatus::Complete => "Meeting notes",
        _ => "Meeting notes, incomplete",
    };
    let mut out = format!(
        "{}Meeting `{}`: {}\nQuestion: {}\n",
        crate::prompts::aura_header(title),
        m.id,
        m.topic.trim(),
        m.agenda.trim()
    );
    for a in &m.attendees {
        out.push_str(&format!(
            "\n### {} (`{}`){}\n",
            who(&a.name, &a.role),
            a.worker_id,
            if a.guest { " · guest" } else { "" }
        ));
        match (a.status, &a.answer) {
            (AttendeeStatus::Answered, Some(answer)) => {
                out.push_str(&format!("{}\n", answer.trim()))
            }
            _ => out.push_str(&format!(
                "No answer: {}.\n",
                a.missing.as_deref().unwrap_or("none came")
            )),
        }
    }
    out.push_str(&format!(
        "\nDecide now. Record what you decided with `record_decision` and `meeting: \"{}\"`, so the user sees the outcome; ask the user only when the decision is truly theirs. Then brief the team.",
        m.id
    ));
    out
}

/// A live meeting's thread up to (not including) the turn at `upto`, as
/// attendees and the chair read it.
fn thread(m: &Meeting, upto: usize) -> String {
    let mut out = String::new();
    let mut round = 0;
    for t in &m.turns[..upto.min(m.turns.len())] {
        if t.round != round {
            round = t.round;
            out.push_str(&format!("\n#### Round {round}\n"));
        }
        let speaker = if t.chair {
            format!("{} (chair)", t.name)
        } else {
            who(&t.name, &t.role)
        };
        match (&t.text, t.status) {
            (Some(text), AttendeeStatus::Answered) => {
                out.push_str(&format!("**{speaker}:** {}\n", text.trim()))
            }
            _ if t.status.pending() => {}
            _ => out.push_str(&format!(
                "**{speaker}:** (no turn: {})\n",
                t.missing.as_deref().unwrap_or("none came")
            )),
        }
    }
    out
}

/// The message from Aura that gives an attendee of a live meeting its turn:
/// the thread so far, and what to say.
pub fn live_turn_message(m: &Meeting, owner: &str, turn: usize) -> String {
    let t = &m.turns[turn];
    let order: Vec<String> = m
        .round_turns(t.round)
        .filter(|x| !x.chair)
        .map(|x| {
            let me = if x.worker_id == t.worker_id {
                ", you"
            } else {
                ""
            };
            format!("{}{me}", who(&x.name, &x.role))
        })
        .collect();
    let mut out = format!(
        "{}{owner}, the feature owner, chairs a live meeting (`{}`), round {} of at most {}. It is your turn to speak, as {}.\nTopic: {}\nSpeaking in this order: {}\n\nQuestion:\n{}\n",
        crate::prompts::aura_header("Live meeting"),
        m.id,
        t.round,
        m.max_rounds,
        who(&t.name, &t.role),
        m.topic.trim(),
        order.join(", "),
        m.agenda.trim(),
    );
    if !m.context.trim().is_empty() {
        out.push_str(&format!("\nContext:\n{}\n", m.context.trim()));
    }
    let so_far = thread(m, turn);
    if so_far.trim().is_empty() {
        out.push_str("\nYou speak first.\n");
    } else {
        out.push_str(&format!("\nThe thread so far:\n{so_far}"));
    }
    out.push_str(&format!(
        "\nSpeak in your final message of this turn, in at most {} words: react to what was said, add what your role sees that is new, and say what you recommend. Do not repeat others, do not start on the work itself and do not ask anyone. Aura adds your turn to the thread.",
        m.turn_words
    ));
    out
}

/// The message from Aura that brings the chair of a live meeting the round
/// that just ended.
pub fn live_round_message(m: &Meeting) -> String {
    let start = m
        .turns
        .iter()
        .position(|t| t.round == m.round)
        .unwrap_or(m.turns.len());
    let end = m
        .turns
        .iter()
        .rposition(|t| t.round == m.round)
        .map_or(start, |i| i + 1);
    let round: String = {
        let mut copy = m.clone();
        copy.turns = m.turns[start..end].to_vec();
        thread(&copy, copy.turns.len())
    };
    let mut out = format!(
        "{}Live meeting `{}`: {}\nRound {} of at most {} is over.\n{}",
        crate::prompts::aura_header("Live meeting notes"),
        m.id,
        m.topic.trim(),
        m.round,
        m.max_rounds,
        round
    );
    if m.round < m.max_rounds {
        out.push_str(&format!(
            "\nContinue with `continue_meeting` (`meeting: \"{}\"`) and a short steer for round {} only if the attendees must still react to each other; otherwise close it with `close_meeting` and the outcome. Record what you decided with `record_decision` and `meeting: \"{}\"`.",
            m.id,
            m.round + 1,
            m.id
        ));
    } else {
        out.push_str(&format!(
            "\nThat was the last round. Close the meeting with `close_meeting` (`meeting: \"{}\"`) and the outcome, and record what you decided with `record_decision` and `meeting: \"{}\"`.",
            m.id, m.id
        ));
    }
    out
}

/// The message from Aura that brings a teammate another's question.
pub fn teammate_question_message(a: &OneOnOne, from_role: &str) -> String {
    format!(
        "{}{}, on your team, asks you (question `{}`):\n\n{}\n\nAnswer in your final message of this turn, briefly. Aura passes it on to them. Do not start on other work in this turn and do not ask anyone yourself.",
        crate::prompts::aura_header("Question from a teammate"),
        who(&a.from_name, from_role),
        a.id,
        a.question.trim()
    )
}

/// The message from Aura that brings the owner a teammate's question.
pub fn owner_question_message(a: &OneOnOne, from_role: &str) -> String {
    format!(
        "{}{} (`{}`) asks you (question `{}`):\n\n{}\n\nAnswer with `reply_to_teammate` and `question: \"{}\"`; Aura passes it on. Keep it short. The worker waits for your answer before it goes on.",
        crate::prompts::aura_header("Question from a teammate"),
        who(&a.from_name, from_role),
        a.from_id,
        a.id,
        a.question.trim(),
        a.id
    )
}

/// The message from Aura that brings the asker the answer to its question,
/// or tells it none will come.
pub fn reply_message(a: &OneOnOne) -> String {
    let (title, by) = if a.to_owner {
        (
            "Answer from the feature owner",
            "The feature owner".to_string(),
        )
    } else {
        ("Answer from a teammate", a.to_name.clone())
    };
    match (&a.status, &a.answer) {
        (OneOnOneStatus::Answered, Some(answer)) => format!(
            "{}{by} answered your question (`{}`):\n> {}\n\n{}\n\nGo on with your task.",
            crate::prompts::aura_header(title),
            a.id,
            a.question.trim().replace('\n', "\n> "),
            answer.trim()
        ),
        _ => format!(
            "{}{by} cannot answer your question (`{}`): {}. Go on with what you know and say in your report what is still open.",
            crate::prompts::aura_header("No answer to your question"),
            a.id,
            a.error.as_deref().unwrap_or("no answer came")
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
pub fn describe(f: &Feature, autonomy: &Autonomy, meetings: MeetingMode) -> String {
    let own = |yes: bool| if yes { " (this feature's own)" } else { "" };
    let mut out = format!(
        "Feature status: {} · autonomy: {}{} · meetings: {}{}\n",
        f.status.label(),
        autonomy.describe(),
        own(f.autonomy.is_some()),
        meetings.as_str(),
        own(f.meeting_mode.is_some()),
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
    let chairing: Vec<&Meeting> = f
        .meetings
        .iter()
        .filter(|m| m.status == MeetingStatus::WaitingOnChair)
        .collect();
    if !chairing.is_empty() {
        out.push_str("Live meetings waiting on you (`continue_meeting` or `close_meeting`):\n");
        for m in chairing {
            out.push_str(&format!(
                "- (`{}`) {}: round {} of at most {} is over\n",
                m.id, m.topic, m.round, m.max_rounds
            ));
        }
    }
    let meetings: Vec<&Meeting> = f
        .meetings
        .iter()
        .filter(|m| m.status == MeetingStatus::Collecting)
        .collect();
    if !meetings.is_empty() {
        out.push_str("Meetings collecting answers:\n");
        for m in meetings {
            if m.live() {
                let spoke = m
                    .round_turns(m.round)
                    .filter(|t| !t.chair && !t.status.pending())
                    .count();
                let speakers = m.round_turns(m.round).filter(|t| !t.chair).count();
                out.push_str(&format!(
                    "- (`{}`) {}: live, round {}, {spoke} of {speakers} spoke\n",
                    m.id, m.topic, m.round
                ));
                continue;
            }
            let answered = m
                .attendees
                .iter()
                .filter(|a| a.status == AttendeeStatus::Answered)
                .count();
            out.push_str(&format!(
                "- (`{}`) {}: {answered} of {} answered\n",
                m.id,
                m.topic,
                m.attendees.len()
            ));
        }
    }
    let (to_owner, between): (Vec<&OneOnOne>, Vec<&OneOnOne>) = f
        .one_on_ones
        .iter()
        .filter(|a| a.status == OneOnOneStatus::Open)
        .partition(|a| a.to_owner);
    if !to_owner.is_empty() {
        out.push_str("Teammates waiting on your answer (`reply_to_teammate`):\n");
        for a in to_owner {
            out.push_str(&format!("- (`{}`) {}: {}\n", a.id, a.from_name, a.question));
        }
    }
    if !between.is_empty() {
        out.push_str("Teammates waiting on each other:\n");
        for a in between {
            out.push_str(&format!(
                "- (`{}`) {} waits on {}: {}\n",
                a.id, a.from_name, a.to_name, a.question
            ));
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

    fn attendee(id: &str, status: AttendeeStatus) -> MeetingAttendee {
        MeetingAttendee {
            worker_id: id.into(),
            name: format!("{id} name"),
            role: "Designs".into(),
            guest: false,
            status,
            answer: None,
            missing: None,
            answered_at: None,
        }
    }

    #[test]
    fn a_meeting_closes_once_nobody_is_expected_to_answer() {
        let now = crate::now();
        let mut m = Meeting {
            id: "m1".into(),
            topic: "Toggle".into(),
            agenda: "Where?".into(),
            context: String::new(),
            attendees: vec![
                attendee("a", AttendeeStatus::Answered),
                attendee("b", AttendeeStatus::Asked),
            ],
            status: MeetingStatus::Collecting,
            decision_ids: vec![],
            started_at: now,
            deadline: now,
            ended_at: None,
            delivered: false,
            mode: MeetingMode::Written,
            round: 0,
            max_rounds: 0,
            turn_words: 0,
            turns: vec![],
            outcome: None,
            timeout_minutes: 0,
            left: vec![],
        };
        assert!(!m.settle());
        m.attendees[1].status = AttendeeStatus::Missing;
        m.attendees[1].missing = Some("it failed".into());
        m.attendees[0].answer = Some("Top right.".into());
        assert!(m.settle());
        assert!(!m.settle(), "only once");
        assert_eq!(m.status, MeetingStatus::Incomplete);
        let notes = meeting_message(&m);
        assert!(
            notes.starts_with("[Aura] Meeting notes, incomplete. "),
            "{notes}"
        );
        assert!(
            notes.contains("### a name (Designs) (`a`)\nTop right.\n")
                && notes.contains("### b name (Designs) (`b`)\nNo answer: it failed.\n"),
            "{notes}"
        );
        let agenda = agenda_message(&m, "Owner", &m.attendees[0]);
        assert!(agenda.starts_with("[Aura] Meeting. "), "{agenda}");
        assert!(
            agenda.contains("Also asked: b name (Designs)\n"),
            "{agenda}"
        );
    }

    #[test]
    fn an_asker_hears_the_answer_or_that_none_comes() {
        let mut a = OneOnOne {
            id: "a1".into(),
            from_id: "w1".into(),
            from_name: "Builder".into(),
            to_id: "w2".into(),
            to_name: "Designer".into(),
            to_owner: false,
            question: "Which icon?\nFor the toggle.".into(),
            answer: Some("The moon.".into()),
            error: None,
            status: OneOnOneStatus::Answered,
            asked_at: crate::now(),
            answered_at: None,
            sent: true,
            delivered: false,
        };
        let r = reply_message(&a);
        assert!(r.starts_with("[Aura] Answer from a teammate. "), "{r}");
        assert!(
            r.contains("> Which icon?\n> For the toggle.\n\nThe moon."),
            "{r}"
        );
        a.status = OneOnOneStatus::Failed;
        a.error = Some("Designer was deleted".into());
        let r = reply_message(&a);
        assert!(r.starts_with("[Aura] No answer to your question. "), "{r}");
        assert!(
            r.contains("Designer cannot answer your question (`a1`): Designer was deleted."),
            "{r}"
        );
        a.to_owner = true;
        a.status = OneOnOneStatus::Answered;
        assert!(reply_message(&a).starts_with("[Aura] Answer from the feature owner. "));
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
        assert!(f.meetings.is_empty() && f.one_on_ones.is_empty());
    }
}
