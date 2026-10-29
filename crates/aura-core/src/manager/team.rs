//! A feature owner's team at work together: written meetings and
//! one-on-ones. Both go over notes (messages from Aura queued until the one
//! they go to is free), and both are kept in the feature record.
//!
//! - A **meeting** (`hold_meeting`) sends every attendee the agenda at once.
//!   The turn an attendee answers it in is not reported to the owner; its
//!   final reply is the attendee's contribution. When every attendee answered
//!   or the meeting's time ran out, the owner gets one message with every
//!   contribution. One that fails, is stopped, archived or deleted closes the
//!   meeting at once, without those still to answer.
//! - A **one-on-one** is a question a worker puts to a teammate
//!   (`ask_teammate`), answered in the teammate's turn, or to the owner
//!   (`ask_owner`), answered with `reply_to_teammate`. The answer reaches the
//!   asker as a message from Aura. While it waits for one, a worker that ends
//!   its turn is not reported to the owner. When the one asked fails, is
//!   stopped, archived or deleted first, the question fails and the asker is
//!   told, so nobody waits for good.
//!
//! Against loops, nobody asks while answering a meeting or a question, a
//! worker has at most [`MAX_OPEN_ASKS`] questions open and one per teammate,
//! and asks the same teammate at most [`MAX_ASKS_PER_TEAMMATE`] times.
//!
//! A checkpoint review holds meetings like other work: none while a review
//! is open; after the user asked for changes, meetings with the team the
//! owner has, but no guests, as nobody new joins until the review is
//! approved. One-on-ones and `reply_to_teammate` are never held: they only
//! pass on what the team already knows.
//!
//! Notes go the way of every note: one counts as received once its agent
//! echoes it and then shows output or ends that turn well, and one its agent
//! could not take (a failed send or turn, a crash) is tried again after a
//! back-off. Only a turn on a received note answers it: one that fails before
//! is no answer, the note just goes again. A worker the user stopped gets
//! its notes once it works again, not before.
//!
//! After a daemon restart, an answer in a worker's transcript counts when the
//! turn it came from completed; otherwise the attendee or teammate is asked
//! again (that turn went with the daemon). A meeting past its deadline closes
//! after taking those answers; what was answered but not delivered is
//! delivered.
use super::orchestrator::{tail, Note, NoteAbout};
use super::{HireSpec, Manager};
use crate::event::*;
use crate::features::*;
use crate::types::*;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// Attendees a meeting may have, guests included.
pub const MAX_ATTENDEES: usize = 6;
/// Questions a worker may have open at once.
pub const MAX_OPEN_ASKS: usize = 2;
/// Questions a worker may put to the same teammate in one feature.
pub const MAX_ASKS_PER_TEAMMATE: usize = 8;
/// Minutes a meeting waits for answers unless the owner says otherwise.
pub const MEETING_MINUTES: u64 = 20;
/// Longest answer kept and passed on; longer ones keep their end.
const ANSWER_LIMIT: usize = 4000;

/// A meeting a feature owner holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MeetingSpec {
    pub topic: String,
    /// The question every attendee answers.
    pub agenda: String,
    pub context: String,
    /// Team members, by session id, title, specialist id or name.
    pub attendees: Vec<String>,
    /// Specialists to hire just for their input to this meeting.
    pub guests: Vec<String>,
    /// Where guests work; defaults to the owner's folder.
    pub cwd: Option<String>,
    /// How long to wait for answers, 1 to 120 minutes.
    pub timeout_minutes: Option<u64>,
}

impl Manager {
    // ----------------------------------------------------------------- team

    /// The feature owner whose team a worker is on, if it is on one.
    pub(super) fn team_owner(&self, worker: &Session) -> Option<Session> {
        self.get_session(worker.orchestrator_id.as_deref()?)
            .ok()
            .filter(|o| o.feature_owner)
    }

    /// The worker and the owner whose team it is on, for the team's tools.
    fn teammate_of(&self, worker: &str) -> Result<(Session, Session)> {
        let w = self.get_session(worker)?;
        match self.team_owner(&w) {
            Some(o) => Ok((w, o)),
            None => bail!("only workers on a feature owner's team have this tool"),
        }
    }

    /// The member of an owner's team matching `key`: a session id, a title,
    /// an id prefix, a specialist id or a member's name. One the key does not
    /// single out matches none.
    pub fn team_member(&self, owner: &str, key: &str) -> Result<Session> {
        let key = key.trim();
        if key.is_empty() {
            bail!("name the team member: its session id, title or specialist");
        }
        let workers = self.workers_of(owner);
        let feature = self.feature(owner)?;
        let pick = |found: Vec<&Session>, what: &str| -> Result<Option<Session>> {
            match found.as_slice() {
                [] => Ok(None),
                [one] => Ok(Some((*one).clone())),
                several => bail!(
                    "{} team members match `{key}` by {what}; use the id of the one you mean: {}",
                    several.len(),
                    several
                        .iter()
                        .map(|s| format!("`{}`", s.id))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            }
        };
        if let Some(s) = workers.iter().find(|s| s.id == key) {
            return Ok(s.clone());
        }
        if let Some(s) = pick(workers.iter().filter(|s| s.title == key).collect(), "title")? {
            return Ok(s);
        }
        let by_member = |m: &TeamMember| {
            m.specialist_id.as_deref() == Some(key) || m.name.eq_ignore_ascii_case(key)
        };
        let members: Vec<&Session> = workers
            .iter()
            .filter(|s| feature.member(&s.id).is_some_and(by_member))
            .collect();
        if let Some(s) = pick(members, "specialist")? {
            return Ok(s);
        }
        if key.len() >= 4 {
            if let Some(s) = pick(
                workers.iter().filter(|s| s.id.starts_with(key)).collect(),
                "id",
            )? {
                return Ok(s);
            }
        }
        if key == owner || self.get_session(key).is_ok() {
            bail!("`{key}` is not on this team");
        }
        bail!("nobody on the team matches `{key}`")
    }

    /// The team as a worker on it sees it, for `list_team`.
    pub fn team_for(&self, worker: &str) -> Result<String> {
        let (w, o) = self.teammate_of(worker)?;
        let feature = self.feature(&o.id)?;
        let mut out = format!(
            "The feature owner is {} (`{}`); ask it with `ask_owner`.\nYour team (ask one with `ask_teammate`):\n",
            o.title, o.id
        );
        for s in self.workers_of(&o.id).iter().filter(|s| !s.archived) {
            let m = feature.member(&s.id);
            out.push_str(&format!(
                "- {} (`{}`){}{} · {}{}\n",
                s.title,
                s.id,
                m.and_then(|m| m.specialist_id.as_ref())
                    .map(|id| format!(" · specialist `{id}`"))
                    .unwrap_or_default(),
                m.map(|m| m.role.trim())
                    .filter(|r| !r.is_empty())
                    .map(|r| format!(" · {r}"))
                    .unwrap_or_default(),
                match s.status {
                    SessionStatus::Running => "working",
                    SessionStatus::Idle => "idle",
                    SessionStatus::Error => "failed",
                    SessionStatus::Exited => "exited",
                    _ => "waiting on the user",
                },
                if s.id == w.id { " · you" } else { "" }
            ));
        }
        Ok(out)
    }

    // ------------------------------------------------------------- meetings

    /// Hold a written meeting: every attendee gets the agenda at once, and
    /// the owner gets every answer in one message. Guests are hired for it.
    pub async fn hold_meeting(&self, owner: &str, spec: MeetingSpec) -> Result<Meeting> {
        let o = self.feature_owner_session(owner)?;
        let topic = spec.topic.trim().to_string();
        let agenda = spec.agenda.trim().to_string();
        if topic.is_empty() {
            bail!("`topic` is required");
        }
        if agenda.is_empty() {
            bail!("`agenda` is required: the question every attendee answers");
        }
        let mut members: Vec<Session> = vec![];
        for key in spec.attendees.iter().filter(|k| !k.trim().is_empty()) {
            let s = self.team_member(owner, key)?;
            if s.archived {
                bail!("{} (`{}`) is archived; leave it out", s.title, s.id);
            }
            if s.mode != SessionMode::Structured {
                bail!(
                    "{} (`{}`) runs in the terminal view, where Aura cannot send it the agenda",
                    s.title,
                    s.id
                );
            }
            if !members.iter().any(|m| m.id == s.id) {
                members.push(s);
            }
        }
        let guests: Vec<String> = spec
            .guests
            .iter()
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect();
        // Checkpoint reviews hold meetings like work: none while a review is
        // open; with the team the owner has once changes are asked for; no
        // guests until the review is approved, as nobody new joins.
        self.may_message(owner)?;
        if !guests.is_empty() {
            self.may_staff(owner)?;
        }
        let count = members.len() + guests.len();
        if count == 0 {
            bail!("a meeting needs attendees: team members in `attendees`, or specialists to hire for it in `guests`");
        }
        if count > MAX_ATTENDEES {
            bail!("{count} attendees is too many: at most {MAX_ATTENDEES}, and fewer is better; every attendee costs a turn");
        }
        // Guests' specialists are checked before anything is recorded.
        let cwd = self.worker_cwd(&o, spec.cwd.as_deref())?;
        for g in &guests {
            let me = self.clone();
            let (id, dir) = (g.clone(), cwd.clone());
            tokio::task::spawn_blocking(move || me.specialist(&id, Some(&me.project_root(&dir))))
                .await
                .map_err(|e| anyhow::anyhow!(e))??;
        }
        let minutes = spec
            .timeout_minutes
            .unwrap_or(MEETING_MINUTES)
            .clamp(1, 120);
        let feature = self.feature(owner)?;
        let attendee = |s: &Session| MeetingAttendee {
            worker_id: s.id.clone(),
            name: s.title.clone(),
            role: feature
                .member(&s.id)
                .map(|m| m.role.clone())
                .unwrap_or_default(),
            guest: false,
            status: AttendeeStatus::Invited,
            answer: None,
            missing: None,
            answered_at: None,
        };
        let attendees: Vec<MeetingAttendee> = members.iter().map(attendee).collect();
        let now = crate::now();
        let (_, meeting) = self.change_feature(owner, |f| {
            let m = Meeting {
                id: f.next_id("m"),
                topic,
                agenda,
                context: spec.context.trim().to_string(),
                attendees,
                status: MeetingStatus::Collecting,
                decision_ids: vec![],
                started_at: now,
                deadline: now + chrono::Duration::minutes(minutes as i64),
                ended_at: None,
                delivered: false,
            };
            f.meetings.push(m.clone());
            if f.status == FeatureStatus::Planning {
                f.status = FeatureStatus::InProgress;
            }
            Ok(m)
        })?;
        // Guests start without a brief: the agenda is their first message.
        for g in guests {
            let hired = self
                .hire_as(
                    owner,
                    HireSpec {
                        specialist: g.clone(),
                        worker: super::WorkerSpec {
                            cwd: Some(cwd.clone()),
                            ..Default::default()
                        },
                    },
                    Some(&meeting.id),
                )
                .await;
            let a = match &hired {
                Ok(s) => MeetingAttendee {
                    guest: true,
                    role: self
                        .feature(owner)?
                        .member(&s.id)
                        .map(|m| m.role.clone())
                        .unwrap_or_default(),
                    ..attendee(s)
                },
                Err(e) => MeetingAttendee {
                    worker_id: String::new(),
                    name: g.clone(),
                    role: String::new(),
                    guest: true,
                    status: AttendeeStatus::Missing,
                    answer: None,
                    missing: Some(format!("could not be hired: {e:#}")),
                    answered_at: None,
                },
            };
            self.change_feature(owner, |f| {
                if let Some(m) = f.meetings.iter_mut().find(|m| m.id == meeting.id) {
                    m.attendees.push(a);
                }
                Ok(())
            })?;
        }
        let meeting = self
            .feature(owner)?
            .meeting(&meeting.id)
            .cloned()
            .unwrap_or(meeting);
        self.post_card(
            owner,
            FeatureCardKind::Meeting,
            &meeting.id,
            &format!("Meeting: {}", meeting.topic),
        );
        for a in meeting.attendees.iter().filter(|a| a.status.pending()) {
            self.send_agenda(&o, &meeting, a);
        }
        self.arm_deadline(owner, &meeting);
        // Every guest may have failed to start.
        self.settle_meeting(owner, &meeting.id);
        Ok(self
            .feature(owner)?
            .meeting(&meeting.id)
            .cloned()
            .unwrap_or(meeting))
    }

    fn send_agenda(&self, owner: &Session, m: &Meeting, a: &MeetingAttendee) {
        self.queue_note(
            &a.worker_id,
            Note {
                text: agenda_message(m, &owner.title, a),
                about: Some(NoteAbout::Agenda {
                    owner: owner.id.clone(),
                    meeting: m.id.clone(),
                    worker: a.worker_id.clone(),
                }),
            },
        );
    }

    /// Close the meeting when its deadline passes, with what came in by then.
    fn arm_deadline(&self, owner: &str, m: &Meeting) {
        let me = self.clone();
        let (owner, id) = (owner.to_string(), m.id.clone());
        let wait = (m.deadline - crate::now()).to_std().unwrap_or_default();
        let minutes = (m.deadline - m.started_at).num_minutes().max(1);
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            me.close_meeting(&owner, &id, &no_answer_within(minutes));
        });
    }

    /// Close a meeting still collecting: who has not answered is missing,
    /// and their agenda, if not sent yet, is dropped.
    pub(super) fn close_meeting(&self, owner: &str, id: &str, why: &str) {
        let closed = self.change_feature(owner, |f| {
            let Some(m) = f.meetings.iter_mut().find(|m| m.id == id) else {
                return Ok(None);
            };
            for a in m.attendees.iter_mut().filter(|a| a.status.pending()) {
                a.status = AttendeeStatus::Missing;
                a.missing = Some(why.to_string());
            }
            Ok(m.settle().then(|| m.clone()))
        });
        match closed {
            Ok((_, Some(m))) => self.meeting_closed(owner, &m),
            Ok(_) => {}
            // The owner went, with its feature.
            Err(e) => tracing::debug!("close meeting {id} of {owner}: {e:#}"),
        }
    }

    /// Close the meeting if nobody is expected to answer any more.
    fn settle_meeting(&self, owner: &str, id: &str) {
        let closed = self.change_feature(owner, |f| {
            Ok(f.meetings
                .iter_mut()
                .find(|m| m.id == id)
                .and_then(|m| m.settle().then(|| m.clone())))
        });
        if let Ok((_, Some(m))) = closed {
            self.meeting_closed(owner, &m);
        }
    }

    /// A meeting closed: the owner gets every answer in one message.
    fn meeting_closed(&self, owner: &str, m: &Meeting) {
        self.drop_notes(|about| {
            matches!(about, NoteAbout::Agenda { owner: o, meeting, .. } if o == owner && meeting == &m.id)
        });
        if self.feature_owner_session(owner).is_err() {
            return;
        }
        self.queue_unless_received(
            owner,
            Note {
                text: meeting_message(m),
                about: Some(NoteAbout::Meeting(m.id.clone())),
            },
        );
    }

    // ---------------------------------------------------------- one-on-ones

    /// A worker asks a teammate. The teammate answers in its next turn and
    /// the answer comes back to the worker as a message from Aura.
    pub fn ask_teammate(&self, worker: &str, to: &str, question: &str) -> Result<OneOnOne> {
        let (w, o) = self.teammate_of(worker)?;
        let question = self.askable(&w, question)?;
        if to.trim() == o.id {
            bail!("that is the feature owner; ask it with `ask_owner`");
        }
        let t = self.team_member(&o.id, to)?;
        if t.id == w.id {
            bail!("you cannot ask yourself");
        }
        if t.archived {
            bail!("{} is archived; ask someone else", t.title);
        }
        if t.mode != SessionMode::Structured {
            bail!(
                "{} runs in the terminal view, where Aura cannot send it a question",
                t.title
            );
        }
        let (_, ask) = self.change_feature(&o.id, |f| {
            Self::ask_limits(f, &w.id, Some(&t))?;
            let a = self.new_ask(f, &w, &t.id, &t.title, false, question);
            f.one_on_ones.push(a.clone());
            Ok(a)
        })?;
        let role = self.role_of(&o.id, &w.id);
        self.queue_note(
            &t.id,
            Note {
                text: teammate_question_message(&ask, &role),
                about: Some(NoteAbout::Ask {
                    owner: o.id.clone(),
                    id: ask.id.clone(),
                }),
            },
        );
        Ok(ask)
    }

    /// A worker asks the feature owner, which answers with `reply_to_teammate`.
    pub fn ask_owner(&self, worker: &str, question: &str) -> Result<OneOnOne> {
        let (w, o) = self.teammate_of(worker)?;
        let question = self.askable(&w, question)?;
        let (_, ask) = self.change_feature(&o.id, |f| {
            Self::ask_limits(f, &w.id, None)?;
            let a = self.new_ask(f, &w, &o.id, &o.title, true, question);
            f.one_on_ones.push(a.clone());
            Ok(a)
        })?;
        let role = self.role_of(&o.id, &w.id);
        self.queue_note(
            &o.id,
            Note {
                text: owner_question_message(&ask, &role),
                about: Some(NoteAbout::Ask {
                    owner: o.id.clone(),
                    id: ask.id.clone(),
                }),
            },
        );
        Ok(ask)
    }

    /// The owner answers a teammate's question.
    pub fn reply_to_teammate(&self, owner: &str, id: &str, answer: &str) -> Result<OneOnOne> {
        self.feature_owner_session(owner)?;
        let answer = answer.trim();
        if answer.is_empty() {
            bail!("`answer` is required");
        }
        let (_, ask) = self.change_feature(owner, |f| {
            let a = f
                .one_on_ones
                .iter_mut()
                .find(|a| a.id == id.trim())
                .ok_or_else(|| anyhow::anyhow!("no question `{id}` from a teammate"))?;
            if !a.to_owner {
                bail!("question `{id}` was put to {}, not to you", a.to_name);
            }
            if a.status != OneOnOneStatus::Open {
                bail!("question `{id}` is closed already");
            }
            a.status = OneOnOneStatus::Answered;
            a.answer = Some(answer.to_string());
            a.answered_at = Some(crate::now());
            Ok(a.clone())
        })?;
        self.send_reply(owner, &ask);
        Ok(ask)
    }

    /// The question, refused when the worker cannot ask now.
    fn askable(&self, w: &Session, question: &str) -> Result<String> {
        let question = question.trim();
        if question.is_empty() {
            bail!("`question` is required");
        }
        if self.is_answering(&w.id) {
            bail!("you are answering a meeting or a teammate's question: answer with what you know and say what is still open; nobody asks others while answering");
        }
        Ok(question.to_string())
    }

    /// Refuse a question past the limits: too many open, one already open to
    /// the same teammate (or the owner), or too many to the same teammate.
    fn ask_limits(f: &Feature, from: &str, to: Option<&Session>) -> Result<()> {
        let to_them = |a: &OneOnOne| match to {
            Some(t) => a.to_id == t.id && !a.to_owner,
            None => a.to_owner,
        };
        let mine = || f.one_on_ones.iter().filter(|a| a.from_id == from);
        let open = || mine().filter(|a| a.status == OneOnOneStatus::Open);
        if let Some(a) = open().find(|a| to_them(a)) {
            bail!(
                "you asked {} already (question `{}`); wait for that answer",
                a.to_name,
                a.id
            );
        }
        if open().count() >= MAX_OPEN_ASKS {
            bail!("you have {MAX_OPEN_ASKS} questions open; wait for their answers before you ask more");
        }
        if let Some(t) = to {
            if mine().filter(|a| to_them(a)).count() >= MAX_ASKS_PER_TEAMMATE {
                bail!("you asked {} {MAX_ASKS_PER_TEAMMATE} times in this feature; take it to the feature owner with `ask_owner`", t.title);
            }
        }
        Ok(())
    }

    fn new_ask(
        &self,
        f: &mut Feature,
        from: &Session,
        to_id: &str,
        to_name: &str,
        to_owner: bool,
        question: String,
    ) -> OneOnOne {
        OneOnOne {
            id: f.next_id("a"),
            from_id: from.id.clone(),
            from_name: from.title.clone(),
            to_id: to_id.to_string(),
            to_name: to_name.to_string(),
            to_owner,
            question,
            answer: None,
            error: None,
            status: OneOnOneStatus::Open,
            asked_at: crate::now(),
            answered_at: None,
            sent: false,
            delivered: false,
        }
    }

    fn role_of(&self, owner: &str, worker: &str) -> String {
        self.feature(owner)
            .ok()
            .and_then(|f| f.member(worker).map(|m| m.role.clone()))
            .unwrap_or_default()
    }

    /// Bring the asker the answer, or tell it none will come.
    fn send_reply(&self, owner: &str, a: &OneOnOne) {
        if let Some(note) = self.reply_note(owner, a) {
            self.queue_note(&a.from_id, note);
        }
    }

    /// After a restart: the answer the asker was not sent.
    fn send_reply_again(&self, owner: &str, a: &OneOnOne) {
        if let Some(note) = self.reply_note(owner, a) {
            self.queue_unless_received(&a.from_id, note);
        }
    }

    /// The note with the answer, while the asker is still on the team.
    fn reply_note(&self, owner: &str, a: &OneOnOne) -> Option<Note> {
        self.get_session(&a.from_id)
            .is_ok_and(|s| s.orchestrator_id.as_deref() == Some(owner))
            .then(|| Note {
                text: reply_message(a),
                about: Some(NoteAbout::Reply {
                    owner: owner.to_string(),
                    id: a.id.clone(),
                }),
            })
    }

    /// Whether a worker on a team waits on an answer to a question it asked.
    pub(super) fn waits_on_answer(&self, worker: &Session) -> bool {
        let Some(o) = self.team_owner(worker) else {
            return false;
        };
        self.feature(&o.id).is_ok_and(|f| {
            f.one_on_ones
                .iter()
                .any(|a| a.from_id == worker.id && a.status == OneOnOneStatus::Open)
        })
    }

    // ------------------------------------------------------------- answers

    /// A worker's turn that answered a note ended: its last reply is the
    /// answer, unless the turn failed or the agent stopped first.
    pub(super) fn answer_ended(&self, worker: &str, about: NoteAbout, ev: &Event) {
        // Its agent did not take the note in (it failed, crashed or was
        // stopped first): the note is back in the queue and goes again, after
        // a back-off, or, for a crash or a stop the user asked for, fails
        // there (see `unavailable`). Nothing was answered yet.
        if self.queued_again(worker, &about) {
            return;
        }
        let outcome: std::result::Result<String, String> = match ev {
            Event::TurnCompleted { turn, .. } => match turn.status {
                TurnStatus::Completed => self
                    .last_reply(worker)
                    .map(|r| tail(&r, ANSWER_LIMIT))
                    .ok_or_else(|| "it ended its turn without an answer".to_string()),
                TurnStatus::Interrupted => Err("it was interrupted before it answered".into()),
                _ => Err(format!(
                    "its turn failed{}",
                    turn.error
                        .as_deref()
                        .map(|e| format!(": {e}"))
                        .unwrap_or_default()
                )),
            },
            Event::ProcessExited {
                message: Some(m), ..
            } => Err(format!("its agent stopped: {m}")),
            // Asked again when the daemon is back.
            _ if self.shutting_down() => return,
            _ => Err("it was stopped before it answered".into()),
        };
        self.take_answer(about, outcome);
    }

    /// Record what a worker answered a note with, or why it did not.
    fn take_answer(&self, about: NoteAbout, outcome: std::result::Result<String, String>) {
        match about {
            NoteAbout::Agenda {
                owner,
                meeting,
                worker,
            } => {
                let result = self.change_feature(&owner, |f| {
                    let Some(m) = f.meetings.iter_mut().find(|m| m.id == meeting) else {
                        return Ok(None);
                    };
                    let collecting = m.status == MeetingStatus::Collecting;
                    if let Err(why) = &outcome {
                        return Ok(attendee_missing(m, &worker, why).then(|| m.clone()));
                    }
                    if let (Some(a), Ok(answer)) = (
                        m.attendees.iter_mut().find(|a| a.worker_id == worker),
                        &outcome,
                    ) {
                        if collecting && a.status.pending() {
                            a.status = AttendeeStatus::Answered;
                            a.answer = Some(answer.clone());
                            a.answered_at = Some(crate::now());
                        } else if a.status == AttendeeStatus::Missing {
                            // Too late for the owner; kept for the user.
                            a.status = AttendeeStatus::Late;
                            a.answer = Some(answer.clone());
                            a.answered_at = Some(crate::now());
                        }
                    }
                    Ok(m.settle().then(|| m.clone()))
                });
                if let Ok((_, Some(m))) = result {
                    self.meeting_closed(&owner, &m);
                }
            }
            NoteAbout::Ask { owner, id } => {
                let result = self.change_feature(&owner, |f| {
                    let Some(a) = f
                        .one_on_ones
                        .iter_mut()
                        .find(|a| a.id == id && a.status == OneOnOneStatus::Open)
                    else {
                        return Ok(None);
                    };
                    match &outcome {
                        Ok(answer) => {
                            a.status = OneOnOneStatus::Answered;
                            a.answer = Some(answer.clone());
                        }
                        Err(why) => {
                            a.status = OneOnOneStatus::Failed;
                            a.error = Some(why.clone());
                        }
                    }
                    a.answered_at = Some(crate::now());
                    Ok(Some(a.clone()))
                });
                if let Ok((_, Some(a))) = result {
                    self.send_reply(&owner, &a);
                }
            }
            _ => {}
        }
    }

    /// A team member was deleted: it misses its meetings, the questions put
    /// to it get no answer, and its own questions are dropped.
    pub(super) fn left_team(&self, s: &Session) {
        let Some(owner) = s.orchestrator_id.clone() else {
            return;
        };
        let gone = format!("{} was deleted", s.title);
        let result = self.change_feature(&owner, |f| {
            let mut closed = vec![];
            for m in f
                .meetings
                .iter_mut()
                .filter(|m| m.status == MeetingStatus::Collecting)
            {
                if attendee_missing(m, &s.id, &gone) {
                    closed.push(m.clone());
                }
            }
            let mut failed = vec![];
            for a in f
                .one_on_ones
                .iter_mut()
                .filter(|a| a.status == OneOnOneStatus::Open)
            {
                if a.to_id == s.id && !a.to_owner {
                    a.status = OneOnOneStatus::Failed;
                    a.error = Some(gone.clone());
                    a.answered_at = Some(crate::now());
                    failed.push(a.clone());
                } else if a.from_id == s.id {
                    a.status = OneOnOneStatus::Failed;
                    a.error = Some(gone.clone());
                    a.delivered = true;
                }
            }
            Ok((closed, failed))
        });
        // The owner may be going too, with its feature.
        let Ok((f, (closed, failed))) = result else {
            return;
        };
        let asked: Vec<String> = f
            .one_on_ones
            .iter()
            .filter(|a| a.from_id == s.id)
            .map(|a| a.id.clone())
            .collect();
        self.drop_notes(|about| {
            matches!(about, NoteAbout::Ask { owner: o, id } if o == &owner && asked.contains(id))
        });
        for m in closed {
            self.meeting_closed(&owner, &m);
        }
        for a in failed {
            self.send_reply(&owner, &a);
        }
    }

    /// A session stopped answering for now: the user (or its orchestrator)
    /// stopped or archived it, or its agent failed. What waits for it to
    /// answer gets no answer, so nobody waits for good: its meetings close
    /// without it, and the questions put to it (to the owner, when it is
    /// the owner) fail, which the askers are told.
    pub(super) fn unavailable(&self, s: &Session, why: &str) {
        let owner = if s.feature_owner {
            s.id.clone()
        } else {
            match self.team_owner(s) {
                Some(o) => o.id,
                None => return,
            }
        };
        let is_owner = owner == s.id;
        let asked = |a: &OneOnOne| {
            a.status == OneOnOneStatus::Open
                && if is_owner {
                    a.to_owner
                } else {
                    !a.to_owner && a.to_id == s.id
                }
        };
        let attends = |m: &Meeting| {
            !is_owner
                && m.status == MeetingStatus::Collecting
                && m.attendee(&s.id).is_some_and(|a| a.status.pending())
        };
        // Nothing waits on it: the record is left alone.
        let Ok(f) = self.feature(&owner) else { return };
        if !f.one_on_ones.iter().any(asked) && !f.meetings.iter().any(attends) {
            return;
        }
        let reason = format!("{} {why}", s.title);
        let result = self.change_feature(&owner, |f| {
            let mut closed = vec![];
            for m in f.meetings.iter_mut().filter(|m| attends(m)) {
                if attendee_missing(m, &s.id, &reason) {
                    closed.push(m.clone());
                }
            }
            let mut failed = vec![];
            for a in f.one_on_ones.iter_mut().filter(|a| asked(a)) {
                a.status = OneOnOneStatus::Failed;
                a.error = Some(reason.clone());
                a.answered_at = Some(crate::now());
                failed.push(a.clone());
            }
            Ok((closed, failed))
        });
        let Ok((_, (closed, failed))) = result else {
            return;
        };
        let ids: Vec<String> = failed.iter().map(|a| a.id.clone()).collect();
        self.drop_notes(|about| match about {
            NoteAbout::Ask { owner: o, id } => o == &owner && ids.contains(id),
            NoteAbout::Agenda { worker, .. } => worker == &s.id,
            _ => false,
        });
        for m in closed {
            self.meeting_closed(&owner, &m);
        }
        for a in failed {
            self.send_reply(&owner, &a);
        }
    }

    /// After a restart: take the answers given before the daemon went from
    /// the transcripts, ask again who had not answered a meeting or a
    /// question, close meetings past their deadline, and deliver what was not
    /// delivered.
    pub(super) fn resume_team(&self, f: &Feature) {
        let owner = &f.owner_id;
        let Ok(o) = self.get_session(owner) else {
            return;
        };
        let on_team = |id: &str| {
            self.get_session(id)
                .is_ok_and(|s| s.orchestrator_id.as_deref() == Some(owner.as_str()))
        };
        for m in &f.meetings {
            match m.status {
                MeetingStatus::Collecting => self.resume_meeting(&o, m, &on_team),
                _ if !m.delivered => self.meeting_closed(owner, m),
                _ => {}
            }
        }
        for a in &f.one_on_ones {
            match a.status {
                OneOnOneStatus::Open if a.to_owner && a.sent => {}
                OneOnOneStatus::Open if a.to_owner || on_team(&a.to_id) => {
                    let role = self.role_of(owner, &a.from_id);
                    let about = Some(NoteAbout::Ask {
                        owner: owner.clone(),
                        id: a.id.clone(),
                    });
                    if a.to_owner {
                        self.queue_unless_received(
                            &a.to_id,
                            Note {
                                text: owner_question_message(a, &role),
                                about,
                            },
                        );
                    } else {
                        self.ask_again(
                            &a.to_id,
                            Note {
                                text: teammate_question_message(a, &role),
                                about,
                            },
                        );
                    }
                }
                OneOnOneStatus::Open => {}
                _ if !a.delivered => self.send_reply_again(owner, a),
                _ => {}
            }
        }
    }

    /// After a restart, a meeting still collecting: an attendee gone from
    /// the team is missing; answers given before the daemon went are taken
    /// from the transcripts; then, past its deadline, it closes without who
    /// is still missing, or else those are asked again.
    fn resume_meeting(&self, o: &Session, m: &Meeting, on_team: &dyn Fn(&str) -> bool) {
        let owner = &o.id;
        let gone: Vec<String> = m
            .attendees
            .iter()
            .filter(|a| a.status.pending() && !on_team(&a.worker_id))
            .map(|a| a.worker_id.clone())
            .collect();
        let closed = self.change_feature(owner, |f| {
            let Some(m) = f.meetings.iter_mut().find(|x| x.id == m.id) else {
                return Ok(None);
            };
            for a in m.attendees.iter_mut().filter(|a| a.status.pending()) {
                a.status = AttendeeStatus::Invited;
            }
            for g in &gone {
                if attendee_missing(m, g, "it is no longer on the team") {
                    return Ok(Some(m.clone()));
                }
            }
            Ok(None)
        });
        if let Ok((_, Some(m))) = closed {
            self.meeting_closed(owner, &m);
            return;
        }
        let Some(m) = self
            .feature(owner)
            .ok()
            .and_then(|f| f.meeting(&m.id).cloned())
        else {
            return;
        };
        let note = |a: &MeetingAttendee| Note {
            text: agenda_message(&m, &o.title, a),
            about: Some(NoteAbout::Agenda {
                owner: owner.clone(),
                meeting: m.id.clone(),
                worker: a.worker_id.clone(),
            }),
        };
        let mut ask = vec![];
        for a in m.attendees.iter().filter(|a| a.status.pending()) {
            if !self.recover_answer(&a.worker_id, &note(a)) {
                ask.push(a);
            }
        }
        if m.deadline <= crate::now() {
            let minutes = (m.deadline - m.started_at).num_minutes().max(1);
            self.close_meeting(owner, &m.id, &no_answer_within(minutes));
            return;
        }
        let still = self
            .feature(owner)
            .ok()
            .and_then(|f| f.meeting(&m.id).cloned());
        if still
            .as_ref()
            .is_some_and(|x| x.status == MeetingStatus::Collecting)
        {
            for a in ask {
                self.queue_note(&a.worker_id, note(a));
            }
            self.arm_deadline(owner, &m);
        }
    }

    /// After a restart, a note a worker answers: one it answered before the
    /// daemon went is taken from its transcript; otherwise it is sent
    /// (again: the turn it was answering in went with the daemon).
    fn ask_again(&self, worker: &str, note: Note) {
        if !self.recover_answer(worker, &note) {
            self.queue_note(worker, note);
        }
    }

    /// Take a worker's answer to a note from its transcript: the last reply
    /// of the turn the note started, if that turn completed. A turn cut off
    /// (by the daemon going, say) answered nothing, however far it got.
    fn recover_answer(&self, worker: &str, note: &Note) -> bool {
        let Some(about) = note.about.clone() else {
            return false;
        };
        let events = self
            .inner
            .store
            .events(worker, 0, usize::MAX)
            .unwrap_or_default();
        let items: Vec<&Item> = events
            .iter()
            .filter_map(|e| match &e.event {
                Event::ItemCompleted { item, .. } if item.parent_id.is_none() => Some(item),
                _ => None,
            })
            .collect();
        let Some(turn) = items
            .iter()
            .rev()
            .find(|i| i.kind == ItemKind::UserMessage && i.text.trim() == note.text.trim())
            .and_then(|i| i.turn_id.clone())
        else {
            return false;
        };
        let completed = events.iter().any(|e| {
            matches!(&e.event, Event::TurnCompleted { turn: t, .. }
                if t.id == turn && t.status == TurnStatus::Completed)
        });
        let answer = items
            .iter()
            .rev()
            .find(|i| {
                i.kind == ItemKind::AgentMessage
                    && i.turn_id.as_deref() == Some(turn.as_str())
                    && !i.text.trim().is_empty()
            })
            .map(|i| tail(i.text.trim(), ANSWER_LIMIT));
        match answer.filter(|_| completed) {
            Some(answer) => {
                self.note_delivered(worker, &about);
                self.take_answer(about, Ok(answer));
                true
            }
            None => false,
        }
    }
}

/// An attendee will not answer (it failed, was stopped, archived or
/// deleted): the meeting closes now, and attendees still to answer are
/// missing too. True when this closed it.
fn attendee_missing(m: &mut Meeting, worker: &str, why: &str) -> bool {
    let Some(a) = m
        .attendees
        .iter_mut()
        .find(|a| a.worker_id == worker && a.status.pending())
    else {
        return false;
    };
    a.status = AttendeeStatus::Missing;
    a.missing = Some(why.to_string());
    let others = format!("the meeting closed when {} could not answer", a.name);
    for a in m.attendees.iter_mut().filter(|a| a.status.pending()) {
        a.status = AttendeeStatus::Missing;
        a.missing = Some(others.clone());
    }
    m.settle()
}

/// Why an attendee is missing when the meeting's time ran out.
fn no_answer_within(minutes: i64) -> String {
    match minutes {
        1 => "no answer within a minute".into(),
        n => format!("no answer within {n} minutes"),
    }
}
