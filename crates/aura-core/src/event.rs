use crate::types::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ItemDelta {
    /// Append to `item.text`.
    Text { text: String },
    /// Append to `item.data.output` (command output).
    Output { text: String },
    /// Merge into `item.data`.
    Data {
        #[ts(type = "Record<string, unknown>")]
        data: serde_json::Value,
    },
}

/// Normalized event stream. Every event carries `session_id` so clients can
/// route without inspecting the payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum Event {
    SessionCreated { session: Session },
    SessionUpdated { session: Session },
    SessionRemoved { session_id: SessionId },
    TurnStarted { session_id: SessionId, turn: Turn },
    TurnCompleted { session_id: SessionId, turn: Turn },
    ItemStarted { session_id: SessionId, item: Item },
    ItemDelta { session_id: SessionId, item_id: String, delta: ItemDelta },
    ItemCompleted { session_id: SessionId, item: Item },
    ApprovalRequested { session_id: SessionId, approval: Approval },
    ApprovalResolved { session_id: SessionId, approval_id: String, decision: ApprovalDecision },
    UserInputRequested { session_id: SessionId, request: UserInputRequest },
    UserInputResolved { session_id: SessionId, request_id: String, response: UserInputResponse },
    Notice { session_id: SessionId, level: NoticeLevel, message: String },
    /// Provider specific metadata (e.g. Claude `system/init`, Codex thread info).
    ProviderInfo {
        session_id: SessionId,
        #[ts(type = "Record<string, unknown>")]
        info: serde_json::Value,
    },
    /// Native session id became known or changed (e.g. after fork).
    NativeId { session_id: SessionId, native_id: String },
    /// Usage changed (tokens, cost, context).
    Usage { session_id: SessionId, usage: Usage },
    /// The structured driver or PTY process exited.
    ProcessExited { session_id: SessionId, exit_code: Option<i32>, message: Option<String> },
    /// Settings acknowledged by the provider.
    SettingChanged { session_id: SessionId, setting: Setting },
    /// The user dismissed the session's notices. Stored in the history like
    /// any other event, so a replay drops the notices that came before it.
    NoticesCleared { session_id: SessionId },
}

impl Event {
    pub fn session_id(&self) -> &str {
        match self {
            Event::SessionCreated { session } | Event::SessionUpdated { session } => &session.id,
            Event::SessionRemoved { session_id }
            | Event::TurnStarted { session_id, .. }
            | Event::TurnCompleted { session_id, .. }
            | Event::ItemStarted { session_id, .. }
            | Event::ItemDelta { session_id, .. }
            | Event::ItemCompleted { session_id, .. }
            | Event::ApprovalRequested { session_id, .. }
            | Event::ApprovalResolved { session_id, .. }
            | Event::UserInputRequested { session_id, .. }
            | Event::UserInputResolved { session_id, .. }
            | Event::Notice { session_id, .. }
            | Event::ProviderInfo { session_id, .. }
            | Event::NativeId { session_id, .. }
            | Event::Usage { session_id, .. }
            | Event::ProcessExited { session_id, .. }
            | Event::SettingChanged { session_id, .. }
            | Event::NoticesCleared { session_id } => session_id,
        }
    }

    /// Whether the event should be persisted into the replayable history.
    /// Session lifecycle events are derived from the session table instead.
    pub fn is_persistent(&self) -> bool {
        !matches!(
            self,
            Event::SessionCreated { .. }
                | Event::SessionUpdated { .. }
                | Event::SessionRemoved { .. }
                | Event::ItemDelta { .. }
        )
    }
}

/// Raw PTY output for terminal sessions. Not part of the event log; the
/// scrollback buffer is the replay mechanism.
#[derive(Debug, Clone)]
pub struct PtyChunk {
    pub session_id: SessionId,
    pub data: bytes::Bytes,
}
