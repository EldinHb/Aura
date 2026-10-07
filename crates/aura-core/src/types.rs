use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

pub type SessionId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderKind {
    Claude,
    Codex,
    /// Any agent speaking the Agent Client Protocol. Which one is in `Session::agent`.
    Acp,
    #[default]
    Terminal,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Claude => "claude",
            ProviderKind::Codex => "codex",
            ProviderKind::Acp => "acp",
            ProviderKind::Terminal => "terminal",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "acp" => Some(Self::Acp),
            "terminal" => Some(Self::Terminal),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionStatus {
    Idle,
    Running,
    WaitingApproval,
    WaitingInput,
    Error,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionMode {
    Structured,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub total_cost_usd: Option<f64>,
    pub context_window: Option<u64>,
    pub context_used: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WorktreeInfo {
    pub repo_root: String,
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Session {
    pub id: SessionId,
    pub provider: ProviderKind,
    /// For `ProviderKind::Acp`: the id of the ACP agent (see [`AgentInfo`]).
    #[serde(default)]
    pub agent: Option<String>,
    /// The provider's own identifier (Claude session id, Codex thread id). None until known.
    pub native_id: Option<String>,
    pub cwd: String,
    pub worktree: Option<WorktreeInfo>,
    pub title: String,
    pub group: Option<String>,
    pub status: SessionStatus,
    pub mode: SessionMode,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox_mode: Option<String>,
    /// Command for terminal sessions (argv). For structured sessions this is the
    /// command used when switching to terminal mode.
    pub command: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub usage: Usage,
    /// Last error message when status == Error.
    pub last_error: Option<String>,
    /// Number of approvals / inputs currently waiting for the user.
    pub pending_count: u32,
    /// Exit code for exited terminal sessions.
    pub exit_code: Option<i32>,
    /// The user's system prompt for this session, added after the global and
    /// per-agent prompts. Takes effect the next time the agent starts.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// The complete system prompt Aura hands the agent when it starts: global,
    /// per-agent and per-session prompts with their placeholders filled in.
    /// Set by the manager just before `Provider::start`; never stored or sent.
    #[serde(skip)]
    #[ts(skip)]
    pub instructions: Option<String>,
}

/// A session group the user created. Kept after its last session is deleted,
/// until the user deletes it in settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Group {
    pub name: String,
    /// Repositories that sessions in this group ran in.
    pub repos: Vec<GroupRepo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupRepo {
    /// Root of the main working tree; sessions in a linked worktree count as its repository.
    pub path: String,
    /// When a session in this repository last joined the group. With several
    /// groups linked to one repository, the most recent one is suggested.
    pub last_used: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Turn {
    pub id: String,
    pub session_id: SessionId,
    pub status: TurnStatus,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub usage: Option<Usage>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ItemKind {
    UserMessage,
    AgentMessage,
    Reasoning,
    ToolCall,
    CommandExec,
    FileChange,
    Plan,
    Subagent,
    WebSearch,
    McpCall,
    Error,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
}

/// A unit of work inside a turn. `text` accumulates streamed text (message,
/// reasoning). Kind specific structured data lives in `data`:
///
/// - `command_exec`: `{ command, cwd?, output, exit_code?, duration_ms? }`
/// - `file_change`: `{ changes: [{ path, kind, diff? }] }`
/// - `tool_call`: `{ tool_name, input, result?, is_error? }`
/// - `plan`: `{ steps: [{ step, status }] }` or `{ text }`
/// - `subagent`: `{ description, agent_type? }`
/// - `web_search`: `{ query, results? }`
/// - `mcp_call`: `{ server, tool, input, result?, is_error? }`
/// - `error` / `system`: `{ message, level? }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Item {
    pub id: String,
    pub session_id: SessionId,
    pub turn_id: Option<String>,
    pub kind: ItemKind,
    pub status: ItemStatus,
    pub title: Option<String>,
    pub text: String,
    #[ts(type = "Record<string, unknown>")]
    pub data: serde_json::Value,
    /// For items produced by a subagent: the id of the parent `subagent` item.
    pub parent_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

impl Item {
    pub fn new(session_id: &str, turn_id: Option<String>, kind: ItemKind) -> Self {
        Self {
            id: crate::new_id(),
            session_id: session_id.to_string(),
            turn_id,
            kind,
            status: ItemStatus::InProgress,
            title: None,
            text: String::new(),
            data: serde_json::json!({}),
            parent_id: None,
            started_at: crate::now(),
            ended_at: None,
        }
    }
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }
    pub fn with_title(mut self, t: impl Into<String>) -> Self {
        self.title = Some(t.into());
        self
    }
    pub fn with_text(mut self, t: impl Into<String>) -> Self {
        self.text = t.into();
        self
    }
    pub fn with_data(mut self, d: serde_json::Value) -> Self {
        self.data = d;
        self
    }
    pub fn completed(mut self) -> Self {
        self.status = ItemStatus::Completed;
        self.ended_at = Some(crate::now());
        self
    }
    pub fn failed(mut self) -> Self {
        self.status = ItemStatus::Failed;
        self.ended_at = Some(crate::now());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permission,
    Tool,
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApprovalOption {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    EditInput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApprovalDecision {
    pub option: ApprovalOption,
    /// For `EditInput`: the modified tool input / command.
    #[ts(type = "Record<string, unknown> | null")]
    pub updated_input: Option<serde_json::Value>,
    /// Optional message to the agent (e.g. why declined).
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Approval {
    pub id: String,
    pub session_id: SessionId,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: ApprovalKind,
    pub title: String,
    pub description: Option<String>,
    /// Kind specific payload: `{ command, cwd }`, `{ changes: [...] }`, `{ tool_name, input }`.
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Value,
    pub options: Vec<ApprovalOption>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Question {
    pub id: String,
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_free_text: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserInputRequest {
    pub id: String,
    pub session_id: SessionId,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub questions: Vec<Question>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserInputResponse {
    pub request_id: String,
    /// question id -> selected labels / free text
    pub answers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub struct CapabilitySet {
    pub structured: bool,
    pub models: bool,
    pub effort: bool,
    pub permission_modes: Vec<String>,
    pub sandbox_modes: Vec<String>,
    pub fork: bool,
    pub steer: bool,
    pub interrupt: bool,
    pub review: bool,
    pub compact: bool,
    pub mcp_status: bool,
    pub skills_list: bool,
    pub slash_commands: bool,
    pub images: bool,
    pub diff_stream: bool,
    pub plan_stream: bool,
    pub native_sessions: bool,
    pub rename: bool,
    pub terminal_mode: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderInfo {
    pub kind: ProviderKind,
    pub display_name: String,
    pub available: bool,
    pub version: Option<String>,
    pub binary: Option<String>,
    pub capabilities: CapabilitySet,
    /// Agents reachable through this provider. Only the ACP provider has any.
    #[serde(default)]
    pub agents: Vec<AgentInfo>,
}

/// An agent launched through the Agent Client Protocol.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInfo {
    /// Stable id stored in `Session::agent` (e.g. `gemini`).
    pub id: String,
    pub display_name: String,
    /// argv that starts the agent in ACP mode.
    pub command: Vec<String>,
    /// Whether the agent's binary was found.
    pub available: bool,
    /// Resolved path of `command[0]` when found.
    pub binary: Option<String>,
    /// `builtin` for agents Aura knows about, `custom` for ones from `acp-agents.json`.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NativeSession {
    pub provider: ProviderKind,
    pub native_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImageInput {
    /// Absolute path to an image on disk, or None when `data` is set.
    pub path: Option<String>,
    /// base64 data (no data: prefix) when pasted.
    pub data: Option<String>,
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(default)]
#[ts(export)]
pub struct Input {
    pub text: String,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    /// Append to the running turn instead of queueing a new one (Codex steer).
    #[serde(default)]
    pub steer: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export)]
pub enum Setting {
    Model(String),
    Effort(String),
    PermissionMode(String),
    SandboxMode(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WorktreeOpts {
    /// Branch to create (or reuse) for the worktree.
    pub branch: String,
    /// Base ref to branch from. Defaults to HEAD.
    pub base: Option<String>,
    /// Directory in which to create the worktree. Defaults to `<repo>/.aura-worktrees/<branch>`.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(default)]
#[ts(export)]
pub struct CreateSessionOpts {
    pub provider: ProviderKind,
    /// ACP agent id, required when `provider` is `Acp`.
    pub agent: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    pub group: Option<String>,
    /// Structured (default for AI providers) or Terminal.
    pub mode: Option<SessionMode>,
    /// argv for terminal sessions. Defaults to the user's shell.
    pub command: Option<Vec<String>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox_mode: Option<String>,
    pub worktree: Option<WorktreeOpts>,
    /// Sent as the first message once the session is up.
    pub initial_prompt: Option<String>,
    /// Resume this native session instead of starting a new one.
    pub resume_native_id: Option<String>,
    /// When resuming, fork into a new native session.
    pub fork: bool,
    /// This session's own system prompt (see [`Session::system_prompt`]).
    pub system_prompt: Option<String>,
}

impl Session {
    pub fn new(opts: &CreateSessionOpts) -> Self {
        let now = crate::now();
        let mode = opts.mode.unwrap_or(match opts.provider {
            ProviderKind::Terminal => SessionMode::Terminal,
            _ => SessionMode::Structured,
        });
        let title = opts.title.clone().unwrap_or_else(|| {
            let base = std::path::Path::new(&opts.cwd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| opts.cwd.clone());
            format!("{} · {}", opts.label(), base)
        });
        Self {
            id: crate::new_id(),
            provider: opts.provider,
            agent: opts.agent.clone(),
            // When forking this is the source session; the provider replaces it with the new id.
            native_id: opts.resume_native_id.clone(),
            cwd: opts.cwd.clone(),
            worktree: None,
            title,
            group: opts.group.clone(),
            status: SessionStatus::Idle,
            mode,
            model: opts.model.clone(),
            effort: opts.effort.clone(),
            permission_mode: opts.permission_mode.clone(),
            sandbox_mode: opts.sandbox_mode.clone(),
            command: opts.command.clone(),
            created_at: now,
            last_activity: now,
            archived: false,
            pinned: false,
            usage: Usage::default(),
            last_error: None,
            pending_count: 0,
            exit_code: None,
            system_prompt: opts.system_prompt.clone().filter(|p| !p.trim().is_empty()),
            instructions: None,
        }
    }
}

impl CreateSessionOpts {
    /// Short name used in default titles: the ACP agent id, else the provider.
    pub fn label(&self) -> &str {
        match (&self.provider, &self.agent) {
            (ProviderKind::Acp, Some(agent)) => agent,
            (p, _) => p.as_str(),
        }
    }
}
