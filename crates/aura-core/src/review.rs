//! Pull request and pre-review wire contracts, independent of chat sessions.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PullRequest {
    pub id: String,
    pub account: String,
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub body: String,
    pub url: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub base_ref: String,
    pub head_ref: String,
    pub base_sha: String,
    pub head_sha: String,
    pub updated_at: String,
    pub created_at: String,
    pub additions: u32,
    pub deletions: u32,
    #[serde(default)]
    pub changed_files: u32,
    pub checks: String,
    pub review_decision: String,
    pub hidden: bool,
    pub can_edit: bool,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub milestone: Option<u32>,
    /// The milestone's title; empty without one, or from daemons up to 0.2.10.
    #[serde(default)]
    pub milestone_title: String,
    /// Your latest submitted review of this PR on GitHub.
    #[serde(default)]
    pub my_review: Option<SubmittedReview>,
    /// The latest submitted review of each other person or bot, comment-only ones included;
    /// the author's replies are left out.
    #[serde(default)]
    pub reviews: Vec<SubmittedReview>,
    /// Reviews requested and not given yet.
    #[serde(default)]
    pub requested: Vec<RequestedReviewer>,
    /// Open review threads whose latest comment is a person's other than yours.
    #[serde(default)]
    pub unanswered_threads: u32,
    /// When your review, or a team's, was last requested.
    #[serde(default)]
    pub review_requested_at: Option<String>,
    /// GitHub's `mergeStateStatus`: `CLEAN` when nothing blocks a merge.
    #[serde(default)]
    pub merge_state: String,
    /// Merge methods the repository allows: `merge`, `squash` and `rebase`.
    #[serde(default)]
    pub merge_methods: Vec<String>,
    /// The method GitHub preselects for you in this repository.
    #[serde(default)]
    pub default_merge_method: String,
    /// You have write access to the base repository.
    #[serde(default)]
    pub can_merge: bool,
    /// The head branch lives in the base repository, so a merge can delete it.
    #[serde(default)]
    pub can_delete_branch: bool,
    /// The repository deletes head branches itself once they are merged.
    #[serde(default)]
    pub auto_delete_branch: bool,
    /// [`PullRequest::merge_blocker`] when the PR was read; None when it could be merged.
    #[serde(default)]
    pub merge_blocked_by: Option<String>,
    /// Who did what lately, read with the PR to tell what changed between refreshes. Daemon-only.
    #[serde(skip)]
    #[ts(skip)]
    pub activity: PullActivity,
}
/// The latest activity on a pull request, as far as one read shows it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PullActivity {
    /// Commits on the PR.
    pub commits: u32,
    /// Logins of the head commit's author and committer, where GitHub knows them.
    pub pushed_by: Vec<String>,
    /// The latest conversation comments, oldest first.
    pub comments: Vec<Note>,
    /// The latest comments of each review thread.
    pub thread_comments: Vec<Note>,
    /// Each reviewer's latest review as submitted, whatever their verdict stands at.
    pub reviews: Vec<LatestReview>,
    /// Who merged it, or last closed or reopened it.
    pub state_actor: String,
}
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LatestReview {
    pub id: u64,
    pub reviewer: String,
    pub bot: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
    pub state: String,
}
/// A comment, by GitHub's database id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Note {
    pub id: u64,
    pub author: String,
    pub bot: bool,
}

impl PullRequest {
    /// Why this PR cannot be merged from Aura yet, or None when GitHub reports it
    /// ready and no check is failing or still running.
    pub fn merge_blocker(&self) -> Option<&'static str> {
        if self.state != "open" {
            return Some("This pull request is not open");
        }
        if !self.can_merge {
            return Some("You do not have permission to merge this pull request");
        }
        if self.draft || self.merge_state == "DRAFT" {
            return Some("Draft pull requests cannot be merged");
        }
        if self.merge_methods.is_empty() {
            return Some("The repository allows no merge method");
        }
        match self.checks.as_str() {
            "FAILURE" | "ERROR" => return Some("Checks have failed"),
            "PENDING" | "EXPECTED" => return Some("Checks are still running"),
            _ => {}
        }
        match self.merge_state.as_str() {
            "CLEAN" | "HAS_HOOKS" => None,
            "DIRTY" => Some("The branch has merge conflicts"),
            "BEHIND" => Some("The branch is out of date with the base branch"),
            "UNSTABLE" => Some("Some checks are not passing"),
            "BLOCKED" => Some(match self.review_decision.as_str() {
                "CHANGES_REQUESTED" => "Changes were requested",
                "REVIEW_REQUIRED" => "A review is required",
                _ => "Blocked by the base branch's rules",
            }),
            _ => Some("GitHub is still checking whether this can be merged"),
        }
    }
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubmittedReview {
    /// Login of whoever submitted it.
    #[serde(default)]
    pub reviewer: String,
    /// Submitted by an app such as Copilot; such reviews do not count as reviewed.
    #[serde(default)]
    pub bot: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub submitted_at: String,
    pub commit_sha: String,
}
/// A pull request's conversation as GitHub's Conversation tab shows it: the timeline,
/// and the review threads the UI nests under the review that started each one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct PullTimeline {
    /// In GitHub's order. Replies submitted as their own review are left out, as on GitHub.
    pub items: Vec<TimelineItem>,
    pub threads: Vec<ReviewThread>,
    /// Commits on the PR, counted by GitHub.
    pub commits: u32,
}
/// One timeline entry. Each `kind` fills the fields it needs; a newer daemon may send
/// kinds an older app does not know, which it skips.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct TimelineItem {
    /// `comment`, `review`, `commit`, `force_pushed`, `review_requested`,
    /// `review_request_removed`, `labeled`, `unlabeled`, `assigned`, `unassigned`,
    /// `ready_for_review`, `converted_to_draft`, `merged`, `closed`, `reopened`,
    /// `head_ref_deleted`, `head_ref_restored`, `renamed`, `milestoned`, `demilestoned`,
    /// `referenced` or `review_dismissed`.
    pub kind: String,
    pub id: String,
    /// When it happened: submitted, created or committed.
    pub at: String,
    /// Login of who did it; a commit author's name when the commit has no GitHub user.
    pub actor: String,
    /// Markdown of a comment or review; the message of a dismissal.
    pub body: String,
    pub url: String,
    /// A review's state: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
    pub state: String,
    /// GitHub's database id of a review, which its threads refer to.
    pub review_id: Option<u64>,
    /// What the event is about: a label, assignee, reviewer, milestone, new title, commit
    /// headline, branch, or the `owner/repo#n title` of a referencing issue.
    pub subject: String,
    /// The title before a rename.
    pub previous: String,
    /// A label's colour, hex without `#`.
    pub color: String,
    /// The commit: pushed, merged, or the head after a force-push.
    pub sha: String,
    /// The head before a force-push.
    pub before: String,
}
/// A review thread on a line of the diff.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// The line in the current diff; None once the thread is outdated.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub resolved: bool,
    pub outdated: bool,
    pub resolved_by: String,
    /// The hunk the first comment was made on, ending at its line.
    pub diff_hunk: String,
    /// The review the first comment was submitted with.
    pub review_id: Option<u64>,
    pub comments: Vec<ThreadComment>,
    /// Replies beyond those read; open the thread on GitHub to see them.
    pub more: u32,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct ThreadComment {
    pub id: String,
    pub author: String,
    pub at: String,
    pub body: String,
    pub url: String,
}
/// A person, team or bot asked to review a pull request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestedReviewer {
    /// A login, or `org/team` for a team.
    pub name: String,
    /// user | team | bot
    pub kind: String,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewConfig {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt_mode: String,
    pub prompt: String,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewComment {
    #[serde(default)]
    pub id: String,
    pub path: String,
    pub line: u32,
    pub start_line: Option<u32>,
    pub side: String,
    pub body: String,
    pub severity: String,
    pub rationale: Option<String>,
    #[serde(default)]
    pub valid: bool,
    #[serde(default)]
    pub position_note: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub edited: bool,
    #[serde(default)]
    pub user_authored: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewResult {
    pub summary: String,
    pub verdict: String,
    pub risk: String,
    pub confidence: Option<f64>,
    pub comments: Vec<ReviewComment>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreReview {
    pub id: String,
    pub pull: PullRequest,
    pub config: ReviewConfig,
    pub instructions: String,
    pub status: String,
    pub phase: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u32,
    pub reviewed_sha: String,
    pub merge_base: String,
    pub context_mode: String,
    pub context_note: Option<String>,
    pub diff: String,
    pub log_tail: Vec<String>,
    pub result: ReviewResult,
    pub submitted_url: Option<String>,
    pub submission: Option<SubmissionPreview>,
    /// The agent that wrote the draft. Missing on drafts from before Aura recorded it.
    #[serde(default)]
    pub agent: Option<ReviewAgent>,
}
/// Who wrote a pre-review; signed onto what Aura posts to GitHub.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewAgent {
    /// `Claude Code`, `Codex`.
    pub provider: String,
    /// The model as chosen: an alias such as `opus`, or a model id. None for the default.
    pub model: Option<String>,
    /// The exact model that ran, when the agent or provider reports it.
    pub model_id: Option<String>,
    /// None when the model's default effort was used.
    pub effort: Option<String>,
}
impl ReviewAgent {
    /// `opus (claude-opus-5-5)`, `gpt-5.5-codex`, or `default model`.
    pub fn model_label(&self) -> String {
        let chosen = self
            .model
            .as_deref()
            .filter(|m| !m.is_empty() && *m != "default");
        match (chosen, self.model_id.as_deref()) {
            (Some(m), Some(id)) if m != id => format!("{m} ({id})"),
            (_, Some(id)) => id.to_string(),
            (Some(m), None) => m.to_string(),
            (None, None) => "default model".into(),
        }
    }
    /// `Claude Code · model opus (claude-opus-5-5) · effort high`
    pub fn signature(&self) -> String {
        format!(
            "{} · model {} · effort {}",
            self.provider,
            self.model_label(),
            self.effort.as_deref().unwrap_or("default")
        )
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubmissionPreview {
    pub token: String,
    pub review_id: String,
    pub revision: u32,
    pub account: String,
    pub head_sha: String,
    pub reviewed_sha: String,
    pub event: String,
    pub body: String,
    pub comments: Vec<ReviewComment>,
    pub stale: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewInbox {
    pub account: Option<String>,
    pub pulls: Vec<PullRequest>,
    /// Open PRs the user authored.
    #[serde(default)]
    pub mine: Vec<PullRequest>,
    /// Open PRs of others the user reviewed and is not asked to review again.
    #[serde(default)]
    pub reviewed: Vec<PullRequest>,
    pub reviews: Vec<PreReview>,
    pub last_synced: Option<String>,
    pub error: Option<String>,
    /// Why Aura is not asking GitHub anything for now: an expired login or a rate limit.
    #[serde(default)]
    pub blocked: Option<String>,
    pub defaults: ReviewConfig,
}
/// What changed on a pull request the user follows, as one inbox entry. Changes found in one
/// refresh, and later ones while the entry is unread, gather in the same entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PullChange {
    pub id: String,
    #[serde(default)]
    pub account: String,
    /// [`PullRequest::id`]: `owner/repo#number`.
    #[serde(default)]
    pub pull_id: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    /// Why the user follows it: `authored`, `requested`, `reviewed` or `linked` (to a session).
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub events: Vec<PullEvent>,
    /// The events' texts in a line, e.g. `2 new commits · alice approved · checks failed`.
    #[serde(default)]
    pub summary: String,
    /// When the latest event was found.
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub read: bool,
}
/// One kind of change on a pull request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PullEvent {
    /// `commits`, `review`, `comment`, `review_requested`, `checks`, `state` or `mergeable`.
    #[serde(default)]
    pub kind: String,
    /// Who did it; empty when unknown.
    #[serde(default)]
    pub actor: String,
    /// The actor is an app, such as Copilot.
    #[serde(default)]
    pub bot: bool,
    /// By kind: the review state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`); the check
    /// rollup (`FAILURE`, `SUCCESS`); `merged`, `closed` or `reopened`; `conflicts` or `clean`.
    #[serde(default)]
    pub detail: String,
    /// New commits or comments; 1 for the other kinds.
    #[serde(default)]
    pub count: u32,
    /// GitHub's id of a review, so one announced elsewhere is not announced again; else 0.
    #[serde(default)]
    pub review_id: u64,
    /// The event in words, e.g. `alice approved`.
    #[serde(default)]
    pub text: String,
}
/// A daemon-side poll of one pull request's reviews. Keyed by lowercase `owner/repo#number`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PrWatch {
    pub id: String,
    pub account: String,
    pub repo: String,
    pub number: u32,
    pub url: String,
    pub title: String,
    pub author: String,
    /// Logins to wait for. Empty waits for the first review by anyone except the author.
    pub reviewers: Vec<String>,
    /// watching | done | closed
    pub status: String,
    /// Highest GitHub review id already looked at; older reviews never notify.
    pub seen: u64,
    pub reviews: Vec<WatchedReview>,
    pub created_at: String,
    pub updated_at: String,
    pub last_checked: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WatchedReview {
    pub id: u64,
    pub reviewer: String,
    /// APPROVED | CHANGES_REQUESTED | COMMENTED
    pub state: String,
    pub body: String,
    pub url: String,
    pub submitted_at: String,
}

/// An open issue offered when linking one to a new session.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RepoIssue {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub assignees: Vec<String>,
    /// Title of the project iteration the issue is in today, e.g. "Sprint 12".
    pub sprint: Option<String>,
    pub updated_at: String,
}

/// The pull request opened from a session's branch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BranchPull {
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    /// open | merged | closed
    pub state: String,
    pub draft: bool,
    /// Check rollup of the head commit (SUCCESS, FAILURE, PENDING, …); empty without checks.
    pub checks: String,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED; empty when no review is required.
    pub review_decision: String,
    pub head_sha: String,
    /// As [`PullRequest::reviews`].
    #[serde(default)]
    pub reviews: Vec<SubmittedReview>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> PullRequest {
        PullRequest {
            state: "open".into(),
            can_merge: true,
            merge_state: "CLEAN".into(),
            merge_methods: vec!["squash".into()],
            checks: "SUCCESS".into(),
            ..Default::default()
        }
    }

    #[test]
    fn merges_only_when_github_reports_ready_and_checks_pass() {
        assert_eq!(ready().merge_blocker(), None);
        assert_eq!(
            PullRequest {
                checks: String::new(),
                ..ready()
            }
            .merge_blocker(),
            None,
            "a PR without checks has none failing"
        );
        for (pr, why) in [
            (
                PullRequest {
                    checks: "PENDING".into(),
                    ..ready()
                },
                "Checks are still running",
            ),
            (
                PullRequest {
                    checks: "FAILURE".into(),
                    ..ready()
                },
                "Checks have failed",
            ),
            (
                PullRequest {
                    merge_state: "DIRTY".into(),
                    ..ready()
                },
                "The branch has merge conflicts",
            ),
            (
                PullRequest {
                    merge_state: "BLOCKED".into(),
                    review_decision: "REVIEW_REQUIRED".into(),
                    ..ready()
                },
                "A review is required",
            ),
            (
                PullRequest {
                    merge_state: "UNKNOWN".into(),
                    ..ready()
                },
                "GitHub is still checking whether this can be merged",
            ),
            (
                PullRequest {
                    draft: true,
                    ..ready()
                },
                "Draft pull requests cannot be merged",
            ),
            (
                PullRequest {
                    can_merge: false,
                    ..ready()
                },
                "You do not have permission to merge this pull request",
            ),
            (
                PullRequest {
                    merge_methods: vec![],
                    ..ready()
                },
                "The repository allows no merge method",
            ),
            (
                PullRequest {
                    state: "merged".into(),
                    ..ready()
                },
                "This pull request is not open",
            ),
        ] {
            assert_eq!(pr.merge_blocker(), Some(why));
        }
    }

    /// `value` as an older daemon wrote it: without the fields named in `added`.
    fn without(mut value: serde_json::Value, added: &[&str]) -> serde_json::Value {
        for key in added {
            value
                .as_object_mut()
                .unwrap()
                .remove(*key)
                .expect("field exists today");
        }
        value
    }

    /// 0.2.8 shapes, as an earlier daemon persisted them (`reviews.inbox`, the pull of a pre-review)
    /// and as an older client sends them, still read.
    #[test]
    fn reads_what_0_2_8_wrote() {
        let review = SubmittedReview {
            state: "APPROVED".into(),
            submitted_at: "2026-10-01T10:00:00Z".into(),
            commit_sha: "abc".into(),
            ..Default::default()
        };
        let mut pull = without(
            serde_json::to_value(PullRequest::default()).unwrap(),
            &["reviews", "requested", "unanswered_threads"],
        );
        pull["my_review"] = without(serde_json::to_value(&review).unwrap(), &["reviewer", "bot"]);
        let read: PullRequest = serde_json::from_value(pull.clone()).unwrap();
        assert_eq!(
            read,
            PullRequest {
                my_review: Some(review),
                ..Default::default()
            }
        );

        let mut inbox = without(
            serde_json::to_value(ReviewInbox::default()).unwrap(),
            &["reviewed"],
        );
        inbox["pulls"] = serde_json::json!([pull.clone()]);
        inbox["mine"] = serde_json::json!([pull]);
        let read: ReviewInbox = serde_json::from_value(inbox).unwrap();
        assert_eq!(
            (read.pulls.len(), read.mine.len(), read.reviewed.len()),
            (1, 1, 0)
        );

        let branch = without(
            serde_json::to_value(BranchPull::default()).unwrap(),
            &["reviews"],
        );
        assert_eq!(
            serde_json::from_value::<BranchPull>(branch).unwrap(),
            BranchPull::default()
        );
    }
}
