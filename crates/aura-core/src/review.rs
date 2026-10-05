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
    /// Your latest submitted review of this PR on GitHub.
    #[serde(default)]
    pub my_review: Option<SubmittedReview>,
    /// When your review, or a team's, was last requested.
    #[serde(default)]
    pub review_requested_at: Option<String>,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubmittedReview {
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub submitted_at: String,
    pub commit_sha: String,
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
    pub reviews: Vec<PreReview>,
    pub last_synced: Option<String>,
    pub error: Option<String>,
    pub defaults: ReviewConfig,
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
}
