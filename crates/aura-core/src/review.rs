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
    pub reviews: Vec<PreReview>,
    pub last_synced: Option<String>,
    pub error: Option<String>,
    pub defaults: ReviewConfig,
}
